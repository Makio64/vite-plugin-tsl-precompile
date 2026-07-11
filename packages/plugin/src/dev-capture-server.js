/**
 * Dev capture endpoint.
 *
 * Mounted on the Vite dev server at `/__tsl-precompile/capture`. Receives
 * POSTed artifact JSON from the runtime marker's `captureMaterialInDev`
 * AND from the auxiliary-pass marker's `precompileAuxiliary`, writes each
 * to disk, updates `manifest.json`, and triggers an HMR reload so the
 * module graph picks up the new artifact.
 *
 * User-material payload (existing):
 *   {
 *     "name": "ocean-water",
 *     "hash": "sha256:abcd...",
 *     "sourceIdentity": "src/materials/ocean.js:42", // optional call-site identity
 *     "artifact": { ... }
 *   }
 *   → file: artifacts/<name>.<shortHash>.json
 *   → manifest entry: { [name]: { file, hash, capturedAt } }
 *
 * Auxiliary-pass payload (new):
 *   {
 *     "materialShape": "background" | "post-process" | "pmrem" | "lights",
 *     "configHash": "abcd...",   // 64-char hex from hashNodeGraphSync / hashPlainConfigSync
 *     "hash": "...",             // artifact content-hash, optional
 *     "artifact": { ... }
 *   }
 *   → file: artifacts/aux-<shape>-<shortConfigHash>.json
 *   → manifest entry: __aux["<shape>:<configHash>"] = { file, hash, capturedAt }
 *
 * Response:
 *   200 { "ok": true, ... }
 *   400 { "error": "..." }  // malformed payload
 *   409 { "error": "..." }  // same name, conflicting source identity
 *   500 { "error": "..." }  // disk write failure
 *
 * @module DevCaptureServer
 */

import { writeFile, mkdir, readFile, readdir, unlink, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { computeArtifactContentHash } from './hash.js';
import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';

const CAPTURE_PATH = '/__tsl-precompile/capture';
const RESERVED_ARTIFACT_NAMES = new Set( [
	'__aux', '__wgsl', '__proto__', 'constructor', 'manifest', 'prototype',
] );
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const CAPTURE_HASH = /^(?:sha256:)?[a-f0-9]{64}$/i;
const CONFIG_HASH = /^[a-f0-9]{64}$/i;
let atomicWriteCounter = 0;

/**
 * Register middleware on a Vite dev server.
 *
 * @param {import('vite').ViteDevServer} server
 * @param {Object} opts
 * @param {string} opts.artifactsDir - Absolute path where artifacts land.
 * @returns {void}
 */
export function attachDevCapture( server, opts ) {

	const artifactsDir = resolve( opts.artifactsDir );
	const manifestPath = join( artifactsDir, 'manifest.json' );
	let captureWriteQueue = Promise.resolve();

	// Every capture mutates the same manifest. Keep user and auxiliary writes
	// in one queue so simultaneous startup POSTs cannot read the same old
	// manifest and then overwrite each other's entries.
	function enqueueCaptureWrite( work ) {

		const next = captureWriteQueue.then( work, work );
		captureWriteQueue = next.catch( () => {} );
		return next;

	}

	// Captures arrive as a burst at app startup (one POST per material).
	// Module invalidation stays immediate, but the websocket pushes are
	// batched so the client processes one HMR update per burst instead of
	// one per artifact.
	const HMR_BATCH_WINDOW_MS = 50;
	const pendingHmrUpdates = new Map();
	let hmrFlushTimer = null;

	function queueHmrUpdate( moduleId ) {

		pendingHmrUpdates.set( moduleId, { type: 'js-update', path: moduleId, acceptedPath: moduleId, timestamp: Date.now() } );
		if ( hmrFlushTimer ) return;
		hmrFlushTimer = setTimeout( () => {

			hmrFlushTimer = null;
			const updates = [ ...pendingHmrUpdates.values() ];
			pendingHmrUpdates.clear();
			if ( updates.length > 0 ) server.ws.send( { type: 'update', updates } );

		}, HMR_BATCH_WINDOW_MS );

	}

	server.middlewares.use( CAPTURE_PATH, async ( req, res ) => {

		if ( req.method !== 'POST' ) {

			res.statusCode = 405;
			res.end( JSON.stringify( { error: 'POST only' } ) );
			return;

		}

		try {

			const body = await readBody( req );
			const payload = JSON.parse( body );

			validatePayload( payload );

			const written = await enqueueCaptureWrite( () => isAuxPayload( payload )
				? writeAuxArtifact( artifactsDir, manifestPath, payload )
				: writeArtifact( artifactsDir, manifestPath, payload ) );

			// Trigger HMR for user captures — aux captures don't have a
			// per-name virtual module today (they're keyed by shape+configHash).
			if ( ! isAuxPayload( payload ) ) {

				const moduleId = `virtual:tsl-precompile/${ payload.name }`;
				const mod = server.moduleGraph.getModuleById( '\0' + moduleId );
				if ( mod ) {

					server.moduleGraph.invalidateModule( mod );
					queueHmrUpdate( moduleId );

				}

			}

			res.statusCode = 200;
			res.setHeader( 'content-type', 'application/json' );
			res.end( JSON.stringify( { ok: true, ...written } ) );

		} catch ( err ) {

			const status = err.code === 'EINVAL' ? 400 : err.code === 'ECONFLICT' ? 409 : 500;
			res.statusCode = status;
			res.setHeader( 'content-type', 'application/json' );
			res.end( JSON.stringify( { error: err.message || String( err ) } ) );

		}

	} );

}

function readBody( req ) {

	return new Promise( ( resolve, reject ) => {

		const chunks = [];
		req.on( 'data', ( c ) => chunks.push( c ) );
		req.on( 'end', () => resolve( Buffer.concat( chunks ).toString( 'utf8' ) ) );
		req.on( 'error', reject );

	} );

}

const AUX_SHAPES = new Set( [
	'background', 'post-process', 'pmrem', 'lights', 'shadow-depth', 'render-pipeline', 'output-transform',
	// PMREMGenerator's 4 internal materials, each captured separately so the
	// slim runtime can `loadAux('pmrem-<sub>', hash)` per material on demand.
	'pmrem-cubemap', 'pmrem-equirect', 'pmrem-blur', 'pmrem-ggx',
	// Other shapes seen in the runtime that POST artifacts.
	'mrt', 'backdrop', 'render-output', 'cube-render-target',
	'bloom-high-pass', 'bloom-composite', 'bloom-blur-0', 'bloom-blur-1', 'bloom-blur-2', 'bloom-blur-3', 'bloom-blur-4',
] );

function isAuxPayload( payload ) {

	return !! ( payload && typeof payload.materialShape === 'string' && AUX_SHAPES.has( payload.materialShape ) );

}

function validatePayload( payload ) {

	if ( ! payload || typeof payload !== 'object' ) throw einval( 'payload must be an object' );
	if ( ! payload.artifact || typeof payload.artifact !== 'object' ) throw einval( 'payload.artifact must be an object' );

	if ( isAuxPayload( payload ) ) {

		if ( typeof payload.configHash !== 'string' || ! CONFIG_HASH.test( payload.configHash ) ) {

			throw einval( 'aux payload.configHash must be a 64-character hexadecimal hash' );

		}
		if ( payload.hash !== undefined && payload.hash !== null && ( typeof payload.hash !== 'string' || ! CAPTURE_HASH.test( payload.hash ) ) ) {

			throw einval( 'aux payload.hash must be a 64-character hexadecimal SHA-256 hash when provided' );

		}
		if ( payload.name !== undefined ) assertCanonicalArtifactName( payload.name, 'aux payload.name' );
		return;

	}

	assertCanonicalArtifactName( payload.name, 'payload.name' );
	if ( typeof payload.hash !== 'string' || ! CAPTURE_HASH.test( payload.hash ) ) {

		throw einval( 'payload.hash must be a 64-character hexadecimal SHA-256 hash' );

	}
	if ( payload.sourceIdentity !== undefined && ( typeof payload.sourceIdentity !== 'string' || payload.sourceIdentity.length === 0 || payload.sourceIdentity.length > 512 ) ) {

		throw einval( 'payload.sourceIdentity must be a non-empty string of at most 512 characters when provided' );

	}
	if ( payload.sourceRevision !== undefined && ( typeof payload.sourceRevision !== 'string' || ! CONFIG_HASH.test( payload.sourceRevision ) ) ) {

		throw einval( 'payload.sourceRevision must be a 64-character hexadecimal SHA-256 hash when provided' );

	}
	if ( payload.sourceRevision !== undefined && payload.sourceIdentity === undefined ) {

		throw einval( 'payload.sourceRevision requires payload.sourceIdentity' );

	}
	if ( payload.artifact.artifactContentHashVersion !== undefined ) {

		if ( payload.artifact.artifactContentHashVersion !== ARTIFACT_CONTENT_HASH_VERSION ) {

			throw einval( `payload.artifact.artifactContentHashVersion must be ${ ARTIFACT_CONTENT_HASH_VERSION }` );

		}
		const threeVersion = payload.artifact.sourceThreeVersion;
		const toolchainVersion = payload.artifact.sourceHashVersion;
		if ( typeof threeVersion !== 'string' || typeof toolchainVersion !== 'string' ) {

			throw einval( 'content-addressed payloads require sourceThreeVersion and sourceHashVersion' );

		}
		const computed = computeArtifactContentHash( payload.artifact, {
			shape: `material:${ payload.name }`,
			threeVersion,
			pluginVersion: toolchainVersion,
		} );
		if ( payload.hash !== computed && payload.hash !== `sha256:${ computed }` ) {

			throw einval( 'payload.hash does not match payload.artifact runtime content' );

		}

	}

}

function assertCanonicalArtifactName( name, field ) {

	if ( typeof name !== 'string' || name.length === 0 ) throw einval( `${ field } must be a non-empty string` );
	if ( name.length > 128 ) throw einval( `${ field } must be at most 128 characters` );

	const lower = name.toLowerCase();
	if ( RESERVED_ARTIFACT_NAMES.has( lower ) || name.startsWith( '__' ) || WINDOWS_DEVICE_NAME.test( name ) ) {

		throw einval( `${ field } uses reserved artifact name ${ JSON.stringify( name ) }` );

	}
	if ( ! /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test( name ) || name.includes( '..' ) ) {

		throw einval( `${ field } must be a canonical artifact name using only letters, digits, dot, underscore, and hyphen (no paths or dot segments)` );

	}

}

function einval( message ) {

	const err = new Error( message );
	err.code = 'EINVAL';
	return err;

}

function econflict( message ) {

	const err = new Error( message );
	err.code = 'ECONFLICT';
	return err;

}

async function writeArtifact( artifactsDir, manifestPath, payload ) {

	const filename = `${ payload.name }.${ shortHash( payload.hash ) }.json`;
	const filepath = containedArtifactPath( artifactsDir, filename );
	const manifest = await readManifest( manifestPath );
	const sourceIdentity = captureSourceIdentity( payload );
	const incomingOwner = payload.sourceIdentity ? {
		identity: payload.sourceIdentity,
		revision: payload.sourceRevision,
	} : null;
	const existing = manifest[ payload.name ];
	let sourceOwners = [];

	if ( existing && typeof existing === 'object' ) {

		sourceOwners = await storedSourceOwners( artifactsDir, existing );
		const existingSourceIdentity = await storedSourceIdentity( artifactsDir, existing );
		const hashesConflict = existing.hash !== payload.hash;
		const isShapeToCallsiteMigration = existingSourceIdentity && sourceIdentity && existingSourceIdentity.kind !== 'callsite' && sourceIdentity.kind === 'callsite';
		const sourcesConflict = hashesConflict && existingSourceIdentity && sourceIdentity && existingSourceIdentity.kind !== 'legacy' && ! isShapeToCallsiteMigration && existingSourceIdentity.value !== sourceIdentity.value;
		const sourceCannotProveSame = hashesConflict && existingSourceIdentity && existingSourceIdentity.kind !== 'legacy' && ( ! existingSourceIdentity.value || ! sourceIdentity || ! sourceIdentity.value );
		const sharedOwnersDiverged = hashesConflict && incomingOwner && sourceOwners.some( ( owner ) => owner.identity !== incomingOwner.identity );
		if ( sourcesConflict || sourceCannotProveSame || sharedOwnersDiverged ) {

			throw econflict( `[tsl-precompile] artifact name ${ JSON.stringify( payload.name ) } is already captured with a different hash/source identity. Use a unique .precompile() name or remove the stale capture before replacing it.` );

		}

	}
	if ( incomingOwner ) {

		if ( existing && existing.hash !== payload.hash ) {

			sourceOwners = [ incomingOwner ];

		} else {

			const byIdentity = new Map( sourceOwners.map( ( owner ) => [ owner.identity, owner ] ) );
			byIdentity.set( incomingOwner.identity, incomingOwner );
			sourceOwners = [ ...byIdentity.values() ].sort( ( a, b ) => a.identity.localeCompare( b.identity ) );

		}

	}

	await mkdir( dirname( filepath ), { recursive: true } );

	const body = JSON.stringify( {
		__hash: payload.hash,
		__name: payload.name,
		...( sourceOwners.length > 0 ? { __sourceOwners: sourceOwners } : {} ),
		artifact: payload.artifact,
	}, null, 2 );

	await atomicWriteFile( filepath, body );

	manifest[ payload.name ] = {
		file: filename,
		hash: payload.hash,
		...( sourceIdentity ? { sourceIdentity: sourceIdentity.value, sourceIdentityKind: sourceIdentity.kind } : {} ),
		...( sourceOwners.length > 0 ? { sourceOwners } : {} ),
		capturedAt: new Date().toISOString(),
	};
	await atomicWriteFile( manifestPath, JSON.stringify( manifest, null, 2 ) );

	await pruneStaleCaptures( artifactsDir, payload.name, filename );

	return { name: payload.name, hash: payload.hash, file: filename };

}

// Remove prior `<name>.<hash>.json` files so the folder holds one artifact
// per captured name. Hashes are stable across unchanged sessions, but source,
// render-context, or exact toolchain changes intentionally produce a new file.
async function pruneStaleCaptures( artifactsDir, name, keepFilename ) {

	try {

		const prefix = name + '.';
		const entries = await readdir( artifactsDir );
		await Promise.all( entries.map( async ( file ) => {

			if ( file === keepFilename ) return;
			if ( ! file.startsWith( prefix ) || ! file.endsWith( '.json' ) ) return;
			try { await unlink( containedArtifactPath( artifactsDir, file ) ); } catch ( _ ) { /* best-effort */ }

		} ) );

	} catch ( _ ) { /* dir missing or unreadable; write path already created it */ }

}

async function writeAuxArtifact( artifactsDir, manifestPath, payload ) {

	const shape = payload.materialShape;
	const configHash = payload.configHash;
	const filename = `aux-${ shape }-${ shortHash( configHash ) }.json`;
	const filepath = containedArtifactPath( artifactsDir, filename );

	await mkdir( dirname( filepath ), { recursive: true } );

	const body = JSON.stringify( {
		__materialShape: shape,
		__configHash: configHash,
		__hash: payload.hash || configHash,
		__name: payload.name || `aux-${ shape }`,
		artifact: payload.artifact,
	}, null, 2 );

	await atomicWriteFile( filepath, body );

	const manifest = await readManifest( manifestPath );
	if ( ! manifest.__aux || typeof manifest.__aux !== 'object' || Array.isArray( manifest.__aux ) ) manifest.__aux = {};
	const key = `${ shape }:${ configHash }`;
	manifest.__aux[ key ] = { file: filename, shape, configHash, hash: payload.hash || null, capturedAt: new Date().toISOString() };

	await atomicWriteFile( manifestPath, JSON.stringify( manifest, null, 2 ) );

	return { materialShape: shape, configHash, file: filename };

}

async function readManifest( manifestPath ) {

	if ( ! existsSync( manifestPath ) ) return {};
	try {

		const manifest = JSON.parse( await readFile( manifestPath, 'utf8' ) );
		if ( ! manifest || typeof manifest !== 'object' || Array.isArray( manifest ) ) {

			throw new Error( 'manifest root must be an object' );

		}
		return manifest;

	} catch ( err ) {

		throw new Error( `[tsl-precompile] could not read capture manifest ${ manifestPath }: ${ err.message || String( err ) }` );

	}

}

function shortHash( hash ) {

	// First 12 digest chars — the optional `sha256:` label is metadata, not
	// part of the filesystem component.
	return hash.replace( /^sha256:/i, '' ).slice( 0, 12 ).toLowerCase();

}

function containedArtifactPath( artifactsDir, filename ) {

	const filepath = resolve( artifactsDir, filename );
	const rel = relative( artifactsDir, filepath );
	if ( rel.length === 0 || rel === '..' || rel.startsWith( `..${ sep }` ) || isAbsolute( rel ) ) {

		throw einval( `capture path escapes artifactsDir: ${ JSON.stringify( filename ) }` );

	}
	return filepath;

}

async function atomicWriteFile( filepath, body ) {

	await mkdir( dirname( filepath ), { recursive: true } );
	const tempPath = `${ filepath }.tmp-${ process.pid }-${ ++ atomicWriteCounter }`;
	try {

		await writeFile( tempPath, body, { encoding: 'utf8', flag: 'wx' } );
		await rename( tempPath, filepath );

	} finally {

		try { await unlink( tempPath ); } catch ( _ ) { /* renamed or never created */ }

	}

}

function captureSourceIdentity( payload ) {

	if ( typeof payload.sourceIdentity === 'string' ) return { value: digestIdentity( `explicit:${ payload.sourceIdentity }` ), kind: 'callsite' };
	const value = sourceIdentityFromArtifact( payload.artifact );
	return value ? { value, kind: 'shape' } : null;

}

function sourceIdentityFromArtifact( artifact ) {

	const source = artifact && artifact.sourceMaterial;
	if ( ! source || typeof source !== 'object' ) return null;

	// Retain only source identity, not shader-shape inputs. Node properties,
	// shadow flags, instancing counts, and similar fields are expected to change
	// during ordinary development and must be allowed to refresh the same named
	// artifact.
	const identity = {
		type: source.type || null,
		name: source.name || '',
	};
	return digestIdentity( stableStringify( identity ) );

}

async function storedSourceIdentity( artifactsDir, entry ) {

	if ( typeof entry.sourceIdentity === 'string' && entry.sourceIdentity.length > 0 ) {

		return { value: entry.sourceIdentity, kind: entry.sourceIdentityKind === 'callsite' || entry.sourceIdentityKind === 'shape' ? entry.sourceIdentityKind : 'legacy' };

	}
	if ( typeof entry.file !== 'string' || entry.file.length === 0 ) return null;
	try {

		const filepath = containedArtifactPath( artifactsDir, entry.file );
		const stored = JSON.parse( await readFile( filepath, 'utf8' ) );
		const value = sourceIdentityFromArtifact( stored.artifact || stored );
		return value ? { value, kind: 'legacy' } : null;

	} catch ( _ ) {

		return null;

	}

}

async function storedSourceOwners( artifactsDir, entry ) {

	if ( Array.isArray( entry.sourceOwners ) ) return sanitizeSourceOwners( entry.sourceOwners );
	if ( typeof entry.file !== 'string' || entry.file.length === 0 ) return [];
	try {

		const filepath = containedArtifactPath( artifactsDir, entry.file );
		const stored = JSON.parse( await readFile( filepath, 'utf8' ) );
		return sanitizeSourceOwners( stored.__sourceOwners );

	} catch ( _ ) {

		return [];

	}

}

function sanitizeSourceOwners( owners ) {

	if ( ! Array.isArray( owners ) ) return [];
	return owners.filter( ( owner ) => owner &&
		typeof owner.identity === 'string' && owner.identity.length > 0 && owner.identity.length <= 512 &&
		typeof owner.revision === 'string' && CONFIG_HASH.test( owner.revision ) )
		.map( ( owner ) => ( { identity: owner.identity, revision: owner.revision } ) );

}

function digestIdentity( value ) {

	return createHash( 'sha256' ).update( value ).digest( 'hex' );

}

function stableStringify( value ) {

	if ( value === null || typeof value !== 'object' ) return JSON.stringify( value );
	if ( Array.isArray( value ) ) return `[${ value.map( stableStringify ).join( ',' ) }]`;
	return `{${ Object.keys( value ).sort().map( ( key ) => `${ JSON.stringify( key ) }:${ stableStringify( value[ key ] ) }` ).join( ',' ) }}`;

}
