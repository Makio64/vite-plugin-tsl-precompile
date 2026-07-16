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
 *   200 { "ok": true, "changed": boolean, ... }
 *   400 { "error": "..." }  // malformed payload
 *   409 { "error": "..." }  // same name, conflicting source identity
 *   500 { "error": "..." }  // disk write failure
 *
 * Semantically identical recaptures are true no-ops: artifact and manifest
 * bytes (including `capturedAt`) stay stable, and user modules are not HMR-
 * invalidated again.
 *
 * @module DevCaptureServer
 */

import { writeFile, mkdir, readFile, readdir, unlink, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { computeArtifactContentHash } from './hash.js';
import { ARTIFACT_CONTENT_HASH_VERSION, stripPrivateArtifactFieldsInPlace } from '@tsl-precompile/contract/artifact-content';
import { collectArtifactVariantCandidates, mergeArtifactVariantFamily } from '@tsl-precompile/contract/artifact-variants';
import { isAuxiliaryMaterialShape } from '@tsl-precompile/contract/auxiliary-shapes';
import { validateArtifact } from '@tsl-precompile/contract/kinds';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';

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

			stripPrivateArtifactFieldsInPlace( payload && payload.artifact );
			canonicalizeCaptureHashes( payload );
			validatePayload( payload );

			const written = await enqueueCaptureWrite( () => isAuxPayload( payload )
				? writeAuxArtifact( artifactsDir, manifestPath, payload )
				: writeArtifact( artifactsDir, manifestPath, payload ) );

			// Trigger HMR for user captures — aux captures don't have a
			// per-name virtual module today (they're keyed by shape+configHash).
			if ( ! isAuxPayload( payload ) && written.changed !== false ) {

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

function isAuxPayload( payload ) {

	return !! ( payload && isAuxiliaryMaterialShape( payload.materialShape ) );

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
		const validation = validateArtifact( payload.artifact, { label: `captured artifact ${ JSON.stringify( payload.name ) }` } );
		if ( ! validation.ok ) {

			throw einval( `payload.artifact failed validation: ${ validation.errors.map( ( error ) => error.message ).join( '; ' ) }` );

		}

	}

}

function canonicalizeCaptureHashes( payload ) {

	if ( ! payload || typeof payload !== 'object' ) return;
	if ( typeof payload.hash === 'string' ) payload.hash = payload.hash.replace( /^sha256:/i, '' ).toLowerCase();
	if ( typeof payload.configHash === 'string' ) payload.configHash = payload.configHash.toLowerCase();
	if ( typeof payload.sourceRevision === 'string' ) payload.sourceRevision = payload.sourceRevision.toLowerCase();

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

	const manifest = await readManifest( manifestPath );
	const existing = manifest[ payload.name ];
	const storedCapture = existing && typeof existing === 'object'
		? await readStoredCapture( artifactsDir, existing )
		: null;
	let sourceOwners = existing && typeof existing === 'object'
		? await storedSourceOwners( artifactsDir, existing )
		: [];
	const aggregate = aggregateSignedMaterialFamily( payload, existing, storedCapture, sourceOwners );
	const acceptedPayload = aggregate ? {
		...payload,
		artifact: aggregate.artifact,
		hash: aggregate.hash,
	} : payload;
	const filename = `${ acceptedPayload.name }.${ shortHash( acceptedPayload.hash ) }.json`;
	const filepath = containedArtifactPath( artifactsDir, filename );
	const sourceIdentity = captureSourceIdentity( acceptedPayload );
	const incomingOwner = acceptedPayload.sourceIdentity ? {
		identity: acceptedPayload.sourceIdentity,
		revision: acceptedPayload.sourceRevision,
	} : null;

	if ( existing && typeof existing === 'object' ) {

		const existingSourceIdentity = await storedSourceIdentity( artifactsDir, existing );
		const hashesConflict = existing.hash !== acceptedPayload.hash;
		const isShapeToCallsiteMigration = existingSourceIdentity && sourceIdentity && existingSourceIdentity.kind !== 'callsite' && sourceIdentity.kind === 'callsite';
		const sourcesConflict = hashesConflict && existingSourceIdentity && sourceIdentity && existingSourceIdentity.kind !== 'legacy' && ! isShapeToCallsiteMigration && existingSourceIdentity.value !== sourceIdentity.value;
		const sourceCannotProveSame = hashesConflict && existingSourceIdentity && existingSourceIdentity.kind !== 'legacy' && ( ! existingSourceIdentity.value || ! sourceIdentity || ! sourceIdentity.value );
		const sharedOwnersDiverged = hashesConflict && incomingOwner && sourceOwners.some( ( owner ) => owner.identity !== incomingOwner.identity );
		if ( sourcesConflict || sourceCannotProveSame || sharedOwnersDiverged ) {

			throw econflict( `[tsl-precompile] artifact name ${ JSON.stringify( payload.name ) } is already captured with a different hash/source identity. Use a unique .precompile() name or remove the stale capture before replacing it.` );

		}

	}
	if ( incomingOwner ) {

		if ( existing && existing.hash !== acceptedPayload.hash ) {

			sourceOwners = [ incomingOwner ];

		} else {

			const byIdentity = new Map( sourceOwners.map( ( owner ) => [ owner.identity, owner ] ) );
			byIdentity.set( incomingOwner.identity, incomingOwner );
			sourceOwners = [ ...byIdentity.values() ].sort( ( a, b ) => a.identity.localeCompare( b.identity ) );

		}

	}

	const storedArtifact = {
		__hash: acceptedPayload.hash,
		__name: acceptedPayload.name,
		...( sourceOwners.length > 0 ? { __sourceOwners: sourceOwners } : {} ),
		artifact: acceptedPayload.artifact,
	};
	const manifestEntry = {
		file: filename,
		hash: acceptedPayload.hash,
		...( sourceIdentity ? { sourceIdentity: sourceIdentity.value, sourceIdentityKind: sourceIdentity.kind } : {} ),
		...( sourceOwners.length > 0 ? { sourceOwners } : {} ),
	};
	if ( await captureJsonFileMatches( filepath, storedArtifact, { contentShape: `material:${ acceptedPayload.name }` } ) && captureManifestEntryMatches( existing, manifestEntry ) ) {

		await pruneStaleCaptures( artifactsDir, acceptedPayload.name, filename );
		return {
			name: acceptedPayload.name,
			hash: acceptedPayload.hash,
			file: filename,
			artifact: storedCapture && storedCapture.artifact || acceptedPayload.artifact,
			changed: false,
		};

	}

	await mkdir( dirname( filepath ), { recursive: true } );

	const body = JSON.stringify( storedArtifact, null, 2 );

	await atomicWriteFile( filepath, body );

	manifest[ acceptedPayload.name ] = {
		...manifestEntry,
		capturedAt: new Date().toISOString(),
	};
	await atomicWriteFile( manifestPath, JSON.stringify( manifest, null, 2 ) );

	await pruneStaleCaptures( artifactsDir, acceptedPayload.name, filename );

	return {
		name: acceptedPayload.name,
		hash: acceptedPayload.hash,
		file: filename,
		artifact: acceptedPayload.artifact,
		changed: true,
	};

}

const SIGNED_FAMILY_COMPATIBILITY_FIELDS = Object.freeze( [
	'sourceGraphHash',
	'sourceHashVersion',
	'sourceThreeVersion',
	'sourceValidationMode',
] );

/**
 * Extend a durable signed family only when both captures prove the same
 * call-site owner, source revision, source graph, and exact toolchain. This
 * runs inside the manifest write queue, so every concurrent material instance
 * sees the family accepted by the request immediately before it.
 */
function aggregateSignedMaterialFamily( payload, existing, storedCapture, sourceOwners ) {

	if ( ! existing || typeof existing !== 'object' || ! storedCapture || typeof storedCapture !== 'object' ) return null;
	if ( typeof payload.sourceIdentity !== 'string' || typeof payload.sourceRevision !== 'string' ) return null;
	if ( sourceOwners.length !== 1 || sourceOwners[ 0 ].identity !== payload.sourceIdentity || sourceOwners[ 0 ].revision !== payload.sourceRevision ) return null;

	const storedArtifact = storedCapture.artifact;
	const incomingArtifact = payload.artifact;
	if ( ! isCurrentFullySignedArtifact( storedArtifact ) || ! isCurrentFullySignedArtifact( incomingArtifact ) ) return null;
	if ( ! SIGNED_FAMILY_COMPATIBILITY_FIELDS.every( ( field ) =>
		typeof storedArtifact[ field ] === 'string' && storedArtifact[ field ].length > 0 && storedArtifact[ field ] === incomingArtifact[ field ]
	) ) {

		throw econflict( `[tsl-precompile] artifact name ${ JSON.stringify( payload.name ) } cannot aggregate captures from one source revision with incompatible graph or toolchain metadata.` );

	}

	const storedHash = computeArtifactContentHash( storedArtifact, {
		shape: `material:${ payload.name }`,
		threeVersion: storedArtifact.sourceThreeVersion,
		pluginVersion: storedArtifact.sourceHashVersion,
	} );
	if ( existing.hash !== storedHash || storedCapture.__hash !== storedHash ) {

		throw econflict( `[tsl-precompile] artifact name ${ JSON.stringify( payload.name ) } cannot aggregate because its stored content hash is stale or invalid.` );

	}

	const mergedArtifact = structuredClone( storedArtifact );
	try {

		mergeArtifactVariantFamily( mergedArtifact, [ storedArtifact, incomingArtifact ] );

	} catch ( error ) {

		throw econflict( `[tsl-precompile] artifact name ${ JSON.stringify( payload.name ) } has an incompatible signed variant family: ${ error.message || String( error ) }` );

	}

	const validation = validateArtifact( mergedArtifact, { label: `captured artifact ${ JSON.stringify( payload.name ) }` } );
	if ( ! validation.ok ) {

		throw econflict( `[tsl-precompile] artifact name ${ JSON.stringify( payload.name ) } has an incompatible signed variant family: ${ validation.errors.map( ( error ) => error.message ).join( '; ' ) }` );

	}
	const mergedHash = computeArtifactContentHash( mergedArtifact, {
		shape: `material:${ payload.name }`,
		threeVersion: mergedArtifact.sourceThreeVersion,
		pluginVersion: mergedArtifact.sourceHashVersion,
	} );

	// A subset replay or capture-session UUID/cache-key churn must preserve the
	// exact durable family rather than replacing it with an equivalent clone.
	if ( mergedHash === storedHash ) return { artifact: storedArtifact, hash: storedHash };
	return { artifact: mergedArtifact, hash: mergedHash };

}

function isCurrentFullySignedArtifact( artifact ) {

	if ( ! artifact || artifact.artifactContentHashVersion !== ARTIFACT_CONTENT_HASH_VERSION ) return false;
	const candidates = collectArtifactVariantCandidates( artifact );
	return candidates.length > 0 && candidates.every( ( candidate ) =>
		Array.isArray( candidate.renderContextSelectors ) && candidate.renderContextSelectors.length > 0 &&
		candidate.renderContextSelectors.every( ( selector ) => typeof selector === 'string' && selector.length > 0 )
	);

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

	const storedArtifact = {
		__materialShape: shape,
		__configHash: configHash,
		__hash: payload.hash || configHash,
		__name: payload.name || `aux-${ shape }`,
		artifact: payload.artifact,
	};

	const manifest = await readManifest( manifestPath );
	if ( ! manifest.__aux || typeof manifest.__aux !== 'object' || Array.isArray( manifest.__aux ) ) manifest.__aux = {};
	const key = `${ shape }:${ configHash }`;
	const manifestEntry = { file: filename, shape, configHash, hash: payload.hash || null };
	if ( await captureJsonFileMatches( filepath, storedArtifact ) && captureManifestEntryMatches( manifest.__aux[ key ], manifestEntry ) ) {

		return { materialShape: shape, configHash, file: filename, changed: false };

	}

	await mkdir( dirname( filepath ), { recursive: true } );
	await atomicWriteFile( filepath, JSON.stringify( storedArtifact, null, 2 ) );

	manifest.__aux[ key ] = { ...manifestEntry, capturedAt: new Date().toISOString() };

	await atomicWriteFile( manifestPath, JSON.stringify( manifest, null, 2 ) );

	return { materialShape: shape, configHash, file: filename, changed: true };

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

async function captureJsonFileMatches( filepath, value, opts = {} ) {

	if ( ! existsSync( filepath ) ) return false;
	try {

		const stored = JSON.parse( await readFile( filepath, 'utf8' ) );
		if ( stableJsonStringify( stored, 'stored capture' ) === stableJsonStringify( value, 'incoming capture' ) ) return true;
		if ( typeof opts.contentShape !== 'string' || opts.contentShape.length === 0 ) return false;

		// Fully signed artifact families can be semantically identical while
		// Three's private cache keys and capture-session UUIDs differ. The current
		// content hash proves payload equivalence; compare the wrapper separately
		// so source-owner additions still update the stored envelope.
		const storedArtifact = stored && stored.artifact;
		const incomingArtifact = value && value.artifact;
		if ( ! storedArtifact || ! incomingArtifact ) return false;
		if ( storedArtifact.artifactContentHashVersion !== ARTIFACT_CONTENT_HASH_VERSION ||
			incomingArtifact.artifactContentHashVersion !== ARTIFACT_CONTENT_HASH_VERSION ) return false;
		const storedEnvelope = { ...stored };
		const incomingEnvelope = { ...value };
		delete storedEnvelope.artifact;
		delete incomingEnvelope.artifact;
		if ( stableJsonStringify( storedEnvelope, 'stored capture envelope' ) !== stableJsonStringify( incomingEnvelope, 'incoming capture envelope' ) ) return false;

		const threeVersion = storedArtifact.sourceThreeVersion;
		const toolchainVersion = storedArtifact.sourceHashVersion;
		if ( typeof threeVersion !== 'string' || typeof toolchainVersion !== 'string' ) return false;
		if ( incomingArtifact.sourceThreeVersion !== threeVersion || incomingArtifact.sourceHashVersion !== toolchainVersion ) return false;
		return computeArtifactContentHash( storedArtifact, {
			shape: opts.contentShape,
			threeVersion,
			pluginVersion: toolchainVersion,
		} ) === value.__hash;

	} catch ( _ ) {

		return false;

	}

}

function captureManifestEntryMatches( existing, expected ) {

	if ( ! existing || typeof existing !== 'object' || Array.isArray( existing ) ) return false;
	const semantic = { ...existing };
	delete semantic.capturedAt;
	return stableJsonStringify( semantic, 'stored manifest entry' ) === stableJsonStringify( expected, 'incoming manifest entry' );

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
	return digestIdentity( stableJsonStringify( identity, 'capture source identity' ) );

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

async function readStoredCapture( artifactsDir, entry ) {

	if ( ! entry || typeof entry.file !== 'string' || entry.file.length === 0 ) return null;
	try {

		const filepath = containedArtifactPath( artifactsDir, entry.file );
		const stored = JSON.parse( await readFile( filepath, 'utf8' ) );
		return stored && typeof stored === 'object' && ! Array.isArray( stored ) ? stored : null;

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
