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
 * Auxiliary-pass payload:
 *   {
 *     "materialShape": "background" | "post-process" | "pmrem" | "lights",
 *     "configHash": "abcd...",   // 64-char hex from hashNodeGraphSync / hashPlainConfigSync
 *     "hash": "...",             // artifact content-hash, optional
 *     "threeVersion": "0.185.1", // exact resolved Three package version
 *     "pluginVersion": "0.1.0", // artifact compatibility version, not npm SemVer
 *     "artifact": { ... }
 *   }
 *   → file: artifacts/aux-<shape>-<shortConfigHash>.json
 *   → manifest entry: __aux["<shape>:<configHash>"] = { file, hash, capturedAt }
 *
 * Renderer-owned internal-pass family payload:
 *   {
 *     "auxiliaryFamily": "pmrem" | "shadow-vsm",
 *     "members": [ <signed auxiliary-pass payload>, ... ]
 *   }
 *   → files: artifacts/aux-<shape>-<configHash>-<contentHash>.json
 *   → one atomic manifest commit after every member file is durable
 *
 * Response:
 *   200 { "ok": true, "changed": boolean, ... }
 *   400 { "error": "..." }  // malformed payload
 *   403 { "error": "..." }  // missing/invalid/cross-origin request
 *   413 { "error": "..." }  // request body exceeds the capture limit
 *   415 { "error": "..." }  // request is not application/json
 *   409 { "error": "..." }  // same name, conflicting source identity
 *   500 { "error": "..." }  // disk write failure
 *
 * The endpoint is a same-origin browser-to-dev-server boundary, not a general
 * artifact ingestion API. It requires Origin/Host agreement and JSON, and caps
 * request bodies at 32 MiB. Legacy unsigned user-material payloads remain
 * accepted for migration compatibility only after those boundary checks.
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
import { computeArtifactContentHash, computePlainConfigHash } from './hash.js';
import { assertArtifactContentIntegrity } from './artifact-content-integrity.js';
import { ARTIFACT_CONTENT_HASH_VERSION, stripPrivateArtifactFieldsInPlace } from '@tsl-precompile/contract/artifact-content';
import { collectArtifactVariantCandidates, mergeArtifactVariantFamily } from '@tsl-precompile/contract/artifact-variants';
import { isAuxiliaryMaterialShape } from '@tsl-precompile/contract/auxiliary-shapes';
import {
	INTERNAL_PASS_FAMILIES,
	INTERNAL_PASS_STAGE_DEFINITIONS,
	INTERNAL_PASS_FAMILY_REQUIREMENTS,
	INTERNAL_PASS_SHAPES,
	assertInternalPassFamily,
} from '@tsl-precompile/contract/internal-pass';
import { validateArtifact } from '@tsl-precompile/contract/kinds';
import { SLIM_THREE_PACKAGE_VERSION } from '@tsl-precompile/contract/slim-three-policy';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { normalizeMarkerSourceProvenance } from './_shared/source-provenance.js';

const CAPTURE_PATH = '/__tsl-precompile/capture';
const RESERVED_ARTIFACT_NAMES = new Set( [
	'__aux', '__wgsl', '__proto__', 'constructor', 'manifest', 'prototype',
] );
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const CAPTURE_HASH = /^(?:sha256:)?[a-f0-9]{64}$/i;
const CONFIG_HASH = /^[a-f0-9]{64}$/i;
const EXACT_PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
export const DEV_CAPTURE_MAX_BODY_BYTES = 32 * 1024 * 1024;
let atomicWriteCounter = 0;

/**
 * Register middleware on a Vite dev server.
 *
 * @param {import('vite').ViteDevServer} server
 * @param {Object} opts
 * @param {string} opts.artifactsDir - Absolute path where artifacts land.
 * @param {(identity: string, revision: string) => Object} [opts.resolveSourceOwner]
 *     Resolve transform-owned dependency provenance for a posted marker. The
 *     runtime sends only identity/revision; this callback keeps dependency
 *     paths private to the build tool while making the durable owner auditable.
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

			assertTrustedCaptureRequest( req );
			const body = await readBody( req, DEV_CAPTURE_MAX_BODY_BYTES );
			let payload;
			try {

				payload = JSON.parse( body );

			} catch ( error ) {

				throw einval( `request body must be valid JSON: ${ error.message || String( error ) }` );

			}

			if ( isAuxiliaryFamilyPayload( payload ) ) {

				for ( const member of payload.members || [] ) {

					stripPrivateArtifactFieldsInPlace( member && member.artifact );
					canonicalizeCaptureHashes( member );

				}

			} else {

				stripPrivateArtifactFieldsInPlace( payload && payload.artifact );
				canonicalizeCaptureHashes( payload );

			}
			validatePayload( payload );
			let resolvedSourceOwner = null;
			if (
				! isAuxPayload( payload )
				&& typeof payload.sourceIdentity === 'string'
				&& typeof opts.resolveSourceOwner === 'function'
			) {

				resolvedSourceOwner = sanitizeSourceOwner(
					opts.resolveSourceOwner( payload.sourceIdentity, payload.sourceRevision ),
					'resolved marker source owner',
				);
				if (
					! resolvedSourceOwner
					|| resolvedSourceOwner.identity !== payload.sourceIdentity
					|| resolvedSourceOwner.revision !== payload.sourceRevision
				) {

					throw einval( 'resolved marker source owner must exactly match payload.sourceIdentity/sourceRevision' );

				}

			}

			const written = await enqueueCaptureWrite( () => isAuxiliaryFamilyPayload( payload )
				? writeAuxiliaryFamilyCapture( artifactsDir, manifestPath, payload )
				: isAuxPayload( payload )
					? writeAuxArtifact( artifactsDir, manifestPath, payload )
					: writeArtifact( artifactsDir, manifestPath, payload, resolvedSourceOwner ) );

			// Trigger HMR for user captures — aux captures don't have a
			// per-name virtual module today (they're keyed by shape+configHash).
			if ( ! isAuxPayload( payload ) && ! isAuxiliaryFamilyPayload( payload ) && written.changed !== false ) {

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

			if ( res.destroyed ) return;
			const status = Number.isInteger( err.statusCode )
				? err.statusCode
				: err.code === 'EINVAL'
					? 400
					: err.code === 'ECONFLICT'
						? 409
						: 500;
			res.statusCode = status;
			res.setHeader( 'content-type', 'application/json' );
			res.end( JSON.stringify( { error: err.message || String( err ) } ) );

		}

	} );

}

function assertTrustedCaptureRequest( req ) {

	const host = singleRequestHeader( req, 'host' );
	if ( ! host ) throw requestError( 400, 'capture request requires a valid Host header' );

	const requestProtocol = req.socket?.encrypted === true ? 'https:' : 'http:';
	let requestUrl;
	try {

		requestUrl = new URL( `${ requestProtocol }//${ host }` );

	} catch ( _ ) {

		throw requestError( 400, 'capture request requires a valid Host header' );

	}
	if (
		requestUrl.host !== host.toLowerCase()
		|| requestUrl.username
		|| requestUrl.password
		|| requestUrl.pathname !== '/'
		|| requestUrl.search
		|| requestUrl.hash
	) {

		throw requestError( 400, 'capture request requires a valid Host header' );

	}

	const origin = singleRequestHeader( req, 'origin' );
	if ( ! origin ) throw requestError( 403, 'capture request requires a same-origin Origin header' );
	let originUrl;
	try {

		originUrl = new URL( origin );

	} catch ( _ ) {

		throw requestError( 403, 'capture request Origin header is invalid' );

	}
	if (
		origin !== originUrl.origin
		|| originUrl.protocol !== requestProtocol
		|| originUrl.host !== requestUrl.host
		|| originUrl.username
		|| originUrl.password
	) {

		throw requestError( 403, 'capture request Origin does not match the dev server' );

	}

	const rawFetchSite = req.headers?.[ 'sec-fetch-site' ];
	const fetchSite = singleRequestHeader( req, 'sec-fetch-site', { required: false } );
	if ( rawFetchSite !== undefined && ( fetchSite === null || fetchSite.toLowerCase() !== 'same-origin' ) ) {

		throw requestError( 403, 'capture request must use same-origin fetch metadata' );

	}

	const contentType = singleRequestHeader( req, 'content-type', { required: false } );
	const mediaType = contentType === null ? '' : contentType.split( ';', 1 )[ 0 ].trim().toLowerCase();
	if ( mediaType !== 'application/json' ) {

		throw requestError( 415, 'capture request Content-Type must be application/json' );

	}

}

function singleRequestHeader( req, name, { required = true } = {} ) {

	const value = req.headers?.[ name ];
	if ( value === undefined ) return required ? '' : null;
	if ( Array.isArray( value ) || typeof value !== 'string' ) return required ? '' : null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : required ? '' : null;

}

function readBody( req, maxBytes ) {

	return new Promise( ( resolve, reject ) => {

		const chunks = [];
		let receivedBytes = 0;
		let settled = false;

		function finish( error, value ) {

			if ( settled ) return;
			settled = true;
			if ( error ) reject( error );
			else resolve( value );

		}

		req.on( 'aborted', () => finish( requestError( 400, 'capture request body was aborted before completion' ) ) );
		req.on( 'error', ( error ) => finish( requestError(
			400,
			`capture request body could not be read: ${ error.message || String( error ) }`,
		) ) );

		const rawDeclaredLength = req.headers?.[ 'content-length' ];
		if ( rawDeclaredLength !== undefined ) {

			const declaredLength = singleRequestHeader( req, 'content-length', { required: false } );
			if (
				declaredLength === null
				|| ! /^\d+$/.test( declaredLength )
				|| ! Number.isSafeInteger( Number( declaredLength ) )
			) {

				req.resume();
				finish( requestError( 400, 'capture request Content-Length must be a non-negative safe integer' ) );
				return;

			}
			if ( Number( declaredLength ) > maxBytes ) {

				req.resume();
				finish( requestError( 413, `capture request body exceeds the ${ maxBytes } byte limit` ) );
				return;

			}

		}

		req.on( 'data', ( chunk ) => {

			if ( settled ) return;
			receivedBytes += chunk.length;
			if ( receivedBytes > maxBytes ) {

				chunks.length = 0;
				req.resume();
				finish( requestError( 413, `capture request body exceeds the ${ maxBytes } byte limit` ) );
				return;

			}
			chunks.push( chunk );

		} );
		req.on( 'end', () => finish( null, Buffer.concat( chunks, receivedBytes ).toString( 'utf8' ) ) );

	} );

}

function requestError( statusCode, message ) {

	const err = new Error( message );
	err.statusCode = statusCode;
	return err;

}

function isAuxPayload( payload ) {

	return !! ( payload && isAuxiliaryMaterialShape( payload.materialShape ) );

}

function isAuxiliaryFamilyPayload( payload ) {

	return !! ( payload && typeof payload.auxiliaryFamily === 'string' );

}

function validatePayload( payload, { auxiliaryFamilyMember = false } = {} ) {

	if ( ! payload || typeof payload !== 'object' || Array.isArray( payload ) ) throw einval( 'payload must be an object' );
	if ( isAuxiliaryFamilyPayload( payload ) ) {

		validateAuxiliaryFamilyPayload( payload );
		return;

	}
	if ( ! payload.artifact || typeof payload.artifact !== 'object' || Array.isArray( payload.artifact ) ) {

		throw einval( 'payload.artifact must be an object' );

	}
	if ( payload.materialShape !== undefined && ! isAuxPayload( payload ) ) {

		throw einval( `payload.materialShape is not a supported auxiliary shape: ${ JSON.stringify( payload.materialShape ) }` );

	}

	if ( isAuxPayload( payload ) ) {

		if ( ! auxiliaryFamilyMember && INTERNAL_PASS_SHAPES.includes( payload.materialShape ) ) {

			throw einval(
				`aux payload.materialShape ${ JSON.stringify( payload.materialShape ) } is a renderer-owned internal-pass stage and must be submitted in a valid auxiliaryFamily envelope`,
			);

		}
		if ( typeof payload.configHash !== 'string' || ! CONFIG_HASH.test( payload.configHash ) ) {

			throw einval( 'aux payload.configHash must be a 64-character hexadecimal hash' );

		}
		if ( typeof payload.threeVersion !== 'string' || ! EXACT_PACKAGE_VERSION.test( payload.threeVersion ) ) {

			throw einval( 'aux payload.threeVersion must be an exact Three package version such as "0.185.1"' );

		}
		if ( payload.threeVersion !== SLIM_THREE_PACKAGE_VERSION ) {

			throw einval( `aux payload.threeVersion must match the current exact baseline ${ SLIM_THREE_PACKAGE_VERSION }` );

		}
		if ( payload.pluginVersion !== ARTIFACT_TOOLCHAIN_VERSION ) {

			throw einval( `aux payload.pluginVersion must match the current toolchain ${ ARTIFACT_TOOLCHAIN_VERSION }` );

		}
		if ( typeof payload.hash !== 'string' || ! CAPTURE_HASH.test( payload.hash ) ) {

			throw einval( 'aux payload.hash must be a 64-character hexadecimal SHA-256 content hash' );

		}
		if ( payload.artifact.sourceThreeVersion !== payload.threeVersion ) {

			throw einval( 'aux payload.threeVersion must match payload.artifact.sourceThreeVersion' );

		}
		if ( payload.artifact.sourceHashVersion !== payload.pluginVersion ) {

			throw einval( 'aux payload.pluginVersion must match payload.artifact.sourceHashVersion' );

		}
		try {

			assertArtifactContentIntegrity( payload.artifact, payload.hash, {
				label: `aux payload ${ JSON.stringify( `${ payload.materialShape }:${ payload.configHash }` ) }`,
				shape: payload.materialShape,
				threeVersion: payload.threeVersion,
				pluginVersion: payload.pluginVersion,
				required: true,
			} );

		} catch ( error ) {

			throw einval( error.message || String( error ) );

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
		if ( threeVersion !== SLIM_THREE_PACKAGE_VERSION ) {

			throw einval( `signed payload sourceThreeVersion must match the current exact baseline ${ SLIM_THREE_PACKAGE_VERSION }` );

		}
		if ( toolchainVersion !== ARTIFACT_TOOLCHAIN_VERSION ) {

			throw einval( `signed payload sourceHashVersion must match the current toolchain ${ ARTIFACT_TOOLCHAIN_VERSION }` );

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

export function validateAuxiliaryFamilyPayload( payload ) {

	const family = payload.auxiliaryFamily;
	if ( ! INTERNAL_PASS_FAMILIES.includes( family ) ) throw einval(
		`auxiliary family payload.auxiliaryFamily must be one of ${ INTERNAL_PASS_FAMILIES.join( ', ' ) }`,
	);
	if ( ! Array.isArray( payload.members ) || payload.members.length === 0 ) throw einval(
		'auxiliary family payload.members must be a non-empty array',
	);
	const definition = INTERNAL_PASS_STAGE_DEFINITIONS[ family ];
	const familyShapes = new Set( Object.values( definition || {} ).map( ( stage ) => stage.shape ) );
	const requiredSupport = new Set( INTERNAL_PASS_FAMILY_REQUIREMENTS[ family ]?.requiredAuxiliaryShapes || [] );
	const allowedShapes = new Set( [ ...familyShapes, ...requiredSupport ] );
	const seenShapes = new Set();
	const familyArtifacts = [];
	let threeVersion = null;
	let pluginVersion = null;
	let familyConfigHash = null;
	for ( const member of payload.members ) {

		validatePayload( member, { auxiliaryFamilyMember: true } );
		if ( ! isAuxPayload( member ) ) throw einval( 'auxiliary family payload members must all be auxiliary captures' );
		if ( ! allowedShapes.has( member.materialShape ) ) throw einval(
			`auxiliary family ${ JSON.stringify( family ) } cannot contain shape ${ JSON.stringify( member.materialShape ) }`,
		);
		if ( seenShapes.has( member.materialShape ) ) throw einval(
			`auxiliary family payload contains duplicate shape ${ JSON.stringify( member.materialShape ) }`,
		);
		seenShapes.add( member.materialShape );
		if ( familyShapes.has( member.materialShape ) ) {

			familyArtifacts.push( member.artifact );
			if ( familyConfigHash === null ) familyConfigHash = member.configHash;
			else if ( familyConfigHash !== member.configHash ) throw einval(
				`auxiliary family ${ JSON.stringify( family ) } internal-pass members must share one configHash`,
			);

		}
		if ( requiredSupport.has( member.materialShape ) ) requiredSupport.delete( member.materialShape );
		if ( threeVersion === null ) {

			threeVersion = member.threeVersion;
			pluginVersion = member.pluginVersion;

		} else if ( threeVersion !== member.threeVersion || pluginVersion !== member.pluginVersion ) throw einval(
			'auxiliary family payload members must share exact Three/toolchain provenance',
		);

	}
	if ( requiredSupport.size > 0 ) throw einval(
		`auxiliary family ${ JSON.stringify( family ) } is missing required support: ${ [ ...requiredSupport ].join( ', ' ) }`,
	);
	try {

		assertInternalPassFamily( familyArtifacts, { family } );

	} catch ( error ) {

		throw einval( error.message || String( error ) );

	}
	for ( const artifact of familyArtifacts ) {

		const descriptor = artifact?.internalPass;
		const expectedConfigHash = computePlainConfigHash( descriptor.config, {
			shape: family,
			threeVersion,
			pluginVersion,
		} );
		if ( familyConfigHash !== expectedConfigHash ) throw einval(
			`auxiliary family ${ JSON.stringify( family ) } configHash does not match its canonical internal-pass config`,
		);

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

async function writeArtifact( artifactsDir, manifestPath, payload, resolvedSourceOwner = null ) {

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
	const incomingOwner = resolvedSourceOwner || ( acceptedPayload.sourceIdentity ? {
		identity: acceptedPayload.sourceIdentity,
		revision: acceptedPayload.sourceRevision,
	} : null );

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

const AUXILIARY_SIGNED_FAMILY_COMPATIBILITY_FIELDS = Object.freeze( [
	'internalPass',
	'sourceGraphHash',
	'sourceValidationMode',
] );

function aggregateSignedAuxiliaryFamily( payload, existing, storedCapture ) {

	if ( ! existing || typeof existing !== 'object' || ! storedCapture || typeof storedCapture !== 'object' ) return null;
	const storedArtifact = storedCapture.artifact;
	const incomingArtifact = payload.artifact;
	if (
		! isCurrentBackendAwareSignedArtifact( storedArtifact ) ||
		! isCurrentBackendAwareSignedArtifact( incomingArtifact )
	) return null;

	const key = `${ payload.materialShape }:${ payload.configHash }`;
	const envelopeCompatible =
		existing.shape === payload.materialShape &&
		existing.configHash === payload.configHash &&
		existing.threeVersion === payload.threeVersion &&
		existing.pluginVersion === payload.pluginVersion &&
		storedCapture.__materialShape === payload.materialShape &&
		storedCapture.__configHash === payload.configHash &&
		storedCapture.threeVersion === payload.threeVersion &&
		storedCapture.pluginVersion === payload.pluginVersion &&
		storedArtifact.sourceThreeVersion === payload.threeVersion &&
		storedArtifact.sourceHashVersion === payload.pluginVersion &&
		incomingArtifact.sourceThreeVersion === payload.threeVersion &&
		incomingArtifact.sourceHashVersion === payload.pluginVersion;
	const rootMetadataCompatible = AUXILIARY_SIGNED_FAMILY_COMPATIBILITY_FIELDS.every( ( field ) =>
		stableJsonStringify( storedArtifact[ field ], `stored auxiliary ${ field }` ) ===
		stableJsonStringify( incomingArtifact[ field ], `incoming auxiliary ${ field }` )
	);
	if ( ! envelopeCompatible || ! rootMetadataCompatible ) throw econflict(
		`[tsl-precompile] auxiliary artifact ${ JSON.stringify( key ) } cannot aggregate backend variants with incompatible shape, config, graph, or toolchain metadata.`,
	);

	const hashOptions = {
		shape: payload.materialShape,
		threeVersion: payload.threeVersion,
		pluginVersion: payload.pluginVersion,
	};
	const storedHash = computeArtifactContentHash( storedArtifact, hashOptions );
	const incomingHash = computeArtifactContentHash( incomingArtifact, hashOptions );
	if (
		existing.hash !== storedHash ||
		storedCapture.__hash !== storedHash ||
		payload.hash !== incomingHash
	) throw econflict(
		`[tsl-precompile] auxiliary artifact ${ JSON.stringify( key ) } cannot aggregate because its stored or incoming content hash is stale or invalid.`,
	);

	const mergedArtifact = structuredClone( storedArtifact );
	try {

		mergeArtifactVariantFamily( mergedArtifact, [ storedArtifact, incomingArtifact ] );

	} catch ( error ) {

		throw econflict( `[tsl-precompile] auxiliary artifact ${ JSON.stringify( key ) } has an incompatible signed backend-variant family: ${ error.message || String( error ) }` );

	}
	const validation = validateArtifact( mergedArtifact, { label: `captured auxiliary artifact ${ JSON.stringify( key ) }` } );
	if ( ! validation.ok ) throw econflict(
		`[tsl-precompile] auxiliary artifact ${ JSON.stringify( key ) } has an incompatible signed backend-variant family: ${ validation.errors.map( ( error ) => error.message ).join( '; ' ) }`,
	);
	const mergedHash = computeArtifactContentHash( mergedArtifact, hashOptions );

	// Replaying either backend's subset must retain the exact aggregate bytes,
	// manifest timestamp, and content-addressed family filename.
	if ( mergedHash === storedHash ) return { artifact: storedArtifact, hash: storedHash };
	return { artifact: mergedArtifact, hash: mergedHash };

}

function isCurrentBackendAwareSignedArtifact( artifact ) {

	if ( ! isCurrentFullySignedArtifact( artifact ) ) return false;
	return collectArtifactVariantCandidates( artifact ).every( ( candidate ) =>
		( candidate.shaderLanguage === 'wgsl' || candidate.shaderLanguage === 'glsl' ) &&
		typeof candidate.variantKey === 'string' && candidate.variantKey.length > 0
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

/**
 * Persist one renderer-owned pass family behind a single authoritative
 * manifest commit. Content-addressed member filenames keep the prior manifest
 * readable until every replacement file is durable; only then does one atomic
 * manifest rename publish the generation.
 */
export async function writeAuxiliaryFamilyCapture( artifactsDir, manifestPath, payload ) {

	const manifest = await readManifest( manifestPath );
	if ( ! manifest.__aux || typeof manifest.__aux !== 'object' || Array.isArray( manifest.__aux ) ) manifest.__aux = {};
	const capturedAt = new Date().toISOString();
	const acceptedMembers = await Promise.all( payload.members.map( async ( member ) => {

		const key = `${ member.materialShape }:${ member.configHash }`;
		const existing = manifest.__aux[ key ];
		const storedCapture = existing && typeof existing === 'object'
			? await readStoredCapture( artifactsDir, existing )
			: null;
		const aggregate = aggregateSignedAuxiliaryFamily( member, existing, storedCapture );
		return aggregate ? {
			...member,
			artifact: aggregate.artifact,
			hash: aggregate.hash,
		} : member;

	} ) );
	const records = acceptedMembers.map( ( member ) => {

		const shape = member.materialShape;
		const configHash = member.configHash;
		// Family members sit behind one manifest commit, so their filenames must
		// never alias another generation. Keep the full validated digests here:
		// a truncated collision could otherwise overwrite bytes still referenced
		// by the old manifest before the replacement manifest is durable.
		const filename = `aux-${ shape }-${ filesystemHash( configHash ) }-${ filesystemHash( member.hash ) }.json`;
		const storedArtifact = createStoredAuxArtifact( member );
		const manifestEntry = createAuxManifestEntry( member, filename );
		const key = `${ shape }:${ configHash }`;
		return {
			member,
			key,
			filename,
			filepath: containedArtifactPath( artifactsDir, filename ),
			storedArtifact,
			manifestEntry,
			previousFilename: manifest.__aux[ key ]?.file || null,
		};

	} );
	const incomingKeys = new Set( records.map( ( record ) => record.key ) );
	const familyShapes = new Set( Object.values(
		INTERNAL_PASS_STAGE_DEFINITIONS[ payload.auxiliaryFamily ] || {},
	).map( ( stage ) => stage.shape ) );
	const familyConfigHash = records.find( ( record ) => familyShapes.has( record.member.materialShape ) )
		?.member.configHash || null;
	const staleFamilyEntries = familyConfigHash === null ? [] : Object.entries( manifest.__aux )
		.filter( ( [ key, entry ] ) =>
			! incomingKeys.has( key )
			&& familyShapes.has( entry?.shape )
			&& entry?.configHash === familyConfigHash
		)
		.map( ( [ key, entry ] ) => ( { key, filename: entry.file } ) );
	const allCurrent = staleFamilyEntries.length === 0 && ( await Promise.all( records.map( async ( record ) =>
		await captureJsonFileMatches( record.filepath, record.storedArtifact ) &&
		captureManifestEntryMatches( manifest.__aux[ record.key ], record.manifestEntry )
	) ) ).every( Boolean );
	if ( allCurrent ) return {

		auxiliaryFamily: payload.auxiliaryFamily,
		changed: false,
		members: records.map( familyWriteResult ),

	};

	await mkdir( artifactsDir, { recursive: true } );
	const newlyCreated = [];
	let manifestCommitted = false;
	try {

		for ( const record of records ) {

			if ( await captureJsonFileMatches( record.filepath, record.storedArtifact ) ) continue;
			if ( ! existsSync( record.filepath ) ) newlyCreated.push( record.filepath );
			await atomicWriteFile( record.filepath, JSON.stringify( record.storedArtifact, null, 2 ) );

		}
		for ( const record of records ) manifest.__aux[ record.key ] = {
			...record.manifestEntry,
			capturedAt,
		};
		for ( const stale of staleFamilyEntries ) delete manifest.__aux[ stale.key ];
		await atomicWriteFile( manifestPath, JSON.stringify( manifest, null, 2 ) );
		manifestCommitted = true;

	} finally {

		if ( ! manifestCommitted ) await Promise.all( newlyCreated.map( async ( filepath ) => {

			try { await unlink( filepath ); } catch ( _ ) { /* preserve original failure */ }

		} ) );

	}

	// The new manifest is authoritative. Old content-addressed generations are
	// now safe to prune; failures are harmless and verifier-visible as orphans.
	await Promise.all( [
		...records.map( ( record ) => record.previousFilename === record.filename ? null : record.previousFilename ),
		...staleFamilyEntries.map( ( entry ) => entry.filename ),
	].filter( Boolean ).map( async ( filename ) => {

		try { await unlink( containedArtifactPath( artifactsDir, filename ) ); } catch ( _ ) { /* best effort */ }

	} ) );
	return {
		auxiliaryFamily: payload.auxiliaryFamily,
		changed: true,
		members: records.map( familyWriteResult ),
	};

}

async function writeAuxArtifact( artifactsDir, manifestPath, payload ) {

	const manifest = await readManifest( manifestPath );
	if ( ! manifest.__aux || typeof manifest.__aux !== 'object' || Array.isArray( manifest.__aux ) ) manifest.__aux = {};
	const key = `${ payload.materialShape }:${ payload.configHash }`;
	const existing = manifest.__aux[ key ];
	const storedCapture = existing && typeof existing === 'object'
		? await readStoredCapture( artifactsDir, existing )
		: null;
	const aggregate = aggregateSignedAuxiliaryFamily( payload, existing, storedCapture );
	const acceptedPayload = aggregate ? {
		...payload,
		artifact: aggregate.artifact,
		hash: aggregate.hash,
	} : payload;
	const shape = acceptedPayload.materialShape;
	const configHash = acceptedPayload.configHash;
	const filename = `aux-${ shape }-${ shortHash( configHash ) }.json`;
	const filepath = containedArtifactPath( artifactsDir, filename );
	const storedArtifact = createStoredAuxArtifact( acceptedPayload );

	const manifestEntry = createAuxManifestEntry( acceptedPayload, filename );
	if ( await captureJsonFileMatches( filepath, storedArtifact ) && captureManifestEntryMatches( manifest.__aux[ key ], manifestEntry ) ) {

		return { materialShape: shape, configHash, file: filename, changed: false };

	}

	await mkdir( dirname( filepath ), { recursive: true } );
	await atomicWriteFile( filepath, JSON.stringify( storedArtifact, null, 2 ) );

	manifest.__aux[ key ] = { ...manifestEntry, capturedAt: new Date().toISOString() };

	await atomicWriteFile( manifestPath, JSON.stringify( manifest, null, 2 ) );

	return { materialShape: shape, configHash, file: filename, changed: true };

}

function createStoredAuxArtifact( payload ) {

	return {
		__materialShape: payload.materialShape,
		__configHash: payload.configHash,
		__hash: payload.hash || payload.configHash,
		__name: payload.name || `aux-${ payload.materialShape }`,
		threeVersion: payload.threeVersion,
		pluginVersion: payload.pluginVersion,
		artifact: payload.artifact,
	};

}

function createAuxManifestEntry( payload, filename ) {

	return {
		file: filename,
		shape: payload.materialShape,
		configHash: payload.configHash,
		hash: payload.hash || null,
		threeVersion: payload.threeVersion,
		pluginVersion: payload.pluginVersion,
	};

}

function familyWriteResult( record ) {

	return {
		materialShape: record.member.materialShape,
		configHash: record.member.configHash,
		file: record.filename,
	};

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

function filesystemHash( hash ) {

	// Payload validation has already constrained family digests to SHA-256
	// hexadecimal strings. Preserve every digest bit in the durable pathname so
	// an uncommitted generation can never overwrite the committed generation.
	return hash.replace( /^sha256:/i, '' ).toLowerCase();

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
	return owners
		.map( ( owner ) => sanitizeSourceOwner( owner ) )
		.filter( Boolean );

}

function sanitizeSourceOwner( owner, label = 'stored marker source owner' ) {

	if (
		! owner
		|| typeof owner.identity !== 'string'
		|| owner.identity.length === 0
		|| owner.identity.length > 512
		|| typeof owner.revision !== 'string'
		|| ! CONFIG_HASH.test( owner.revision )
	) return null;

	const sanitized = {
		identity: owner.identity,
		revision: owner.revision.toLowerCase(),
	};
	if ( owner.provenance !== undefined ) {

		try {

			sanitized.provenance = normalizeMarkerSourceProvenance( owner.provenance, `${ label }.provenance` );

		} catch ( error ) {

			if ( label === 'resolved marker source owner' ) throw einval( error.message || String( error ) );
			return null;

		}

	}
	return sanitized;

}

function digestIdentity( value ) {

	return createHash( 'sha256' ).update( value ).digest( 'hex' );

}
