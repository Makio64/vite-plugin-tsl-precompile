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
 *   500 { "error": "..." }  // disk write failure
 *
 * @module DevCaptureServer
 */

import { writeFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

const CAPTURE_PATH = '/__tsl-precompile/capture';

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

			const written = isAuxPayload( payload )
				? await writeAuxArtifact( artifactsDir, manifestPath, payload )
				: await writeArtifact( artifactsDir, manifestPath, payload );

			// Trigger HMR for user captures — aux captures don't have a
			// per-name virtual module today (they're keyed by shape+configHash).
			if ( ! isAuxPayload( payload ) ) {

				const moduleId = `virtual:tsl-precompile/${ payload.name }`;
				const mod = server.moduleGraph.getModuleById( '\0' + moduleId );
				if ( mod ) {

					server.moduleGraph.invalidateModule( mod );
					server.ws.send( { type: 'update', updates: [ { type: 'js-update', path: moduleId, acceptedPath: moduleId, timestamp: Date.now() } ] } );

				}

			}

			res.statusCode = 200;
			res.setHeader( 'content-type', 'application/json' );
			res.end( JSON.stringify( { ok: true, ...written } ) );

		} catch ( err ) {

			const status = err.code === 'EINVAL' ? 400 : 500;
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
] );

function isAuxPayload( payload ) {

	return !! ( payload && typeof payload.materialShape === 'string' && AUX_SHAPES.has( payload.materialShape ) );

}

function validatePayload( payload ) {

	if ( ! payload || typeof payload !== 'object' ) throw einval( 'payload must be an object' );
	if ( ! payload.artifact || typeof payload.artifact !== 'object' ) throw einval( 'payload.artifact must be an object' );

	if ( isAuxPayload( payload ) ) {

		if ( typeof payload.configHash !== 'string' || payload.configHash.length === 0 ) {

			throw einval( 'aux payload.configHash must be a non-empty string' );

		}
		return;

	}

	if ( typeof payload.name !== 'string' || payload.name.length === 0 ) throw einval( 'payload.name must be a non-empty string' );
	if ( typeof payload.hash !== 'string' || payload.hash.length === 0 ) throw einval( 'payload.hash must be a non-empty string' );

}

function einval( message ) {

	const err = new Error( message );
	err.code = 'EINVAL';
	return err;

}

async function writeArtifact( artifactsDir, manifestPath, payload ) {

	const filename = `${ payload.name }.${ shortHash( payload.hash ) }.json`;
	const filepath = join( artifactsDir, filename );

	await mkdir( dirname( filepath ), { recursive: true } );

	const body = JSON.stringify( {
		__hash: payload.hash,
		__name: payload.name,
		artifact: payload.artifact,
	}, null, 2 );

	await writeFile( filepath, body, 'utf8' );

	const manifest = await readManifest( manifestPath );
	manifest[ payload.name ] = { file: filename, hash: payload.hash, capturedAt: new Date().toISOString() };
	await writeFile( manifestPath, JSON.stringify( manifest, null, 2 ), 'utf8' );

	await pruneStaleCaptures( artifactsDir, payload.name, filename );

	return { name: payload.name, hash: payload.hash, file: filename };

}

// Remove prior `<name>.<hash>.json` files so the folder holds one artifact
// per captured name. The material hash isn't bitwise-stable across sessions
// today (uniforms like `time` bake into `leafRepr`), so without this the
// folder grows by one file per reload.
async function pruneStaleCaptures( artifactsDir, name, keepFilename ) {

	try {

		const prefix = name + '.';
		const entries = await readdir( artifactsDir );
		await Promise.all( entries.map( async ( file ) => {

			if ( file === keepFilename ) return;
			if ( ! file.startsWith( prefix ) || ! file.endsWith( '.json' ) ) return;
			try { await unlink( join( artifactsDir, file ) ); } catch ( _ ) { /* best-effort */ }

		} ) );

	} catch ( _ ) { /* dir missing or unreadable; write path already created it */ }

}

async function writeAuxArtifact( artifactsDir, manifestPath, payload ) {

	const shape = payload.materialShape;
	const configHash = payload.configHash;
	const filename = `aux-${ shape }-${ shortHash( configHash ) }.json`;
	const filepath = join( artifactsDir, filename );

	await mkdir( dirname( filepath ), { recursive: true } );

	const body = JSON.stringify( {
		__materialShape: shape,
		__configHash: configHash,
		__hash: payload.hash || configHash,
		__name: payload.name || `aux-${ shape }`,
		artifact: payload.artifact,
	}, null, 2 );

	await writeFile( filepath, body, 'utf8' );

	const manifest = await readManifest( manifestPath );
	if ( ! manifest.__aux || typeof manifest.__aux !== 'object' ) manifest.__aux = {};
	const key = `${ shape }:${ configHash }`;
	manifest.__aux[ key ] = { file: filename, shape, configHash, hash: payload.hash || null, capturedAt: new Date().toISOString() };

	await writeFile( manifestPath, JSON.stringify( manifest, null, 2 ), 'utf8' );

	return { materialShape: shape, configHash, file: filename };

}

async function readManifest( manifestPath ) {

	if ( ! existsSync( manifestPath ) ) return {};
	try {

		return JSON.parse( await readFile( manifestPath, 'utf8' ) );

	} catch ( _ ) {

		return {};

	}

}

function shortHash( hash ) {

	// First 12 hex chars — collision odds are negligible in any one project.
	return hash.slice( 0, 12 );

}
