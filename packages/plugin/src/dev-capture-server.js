/**
 * Dev capture endpoint.
 *
 * Mounted on the Vite dev server at `/__tsl-precompile/capture`. Receives
 * POSTed artifact JSON from the runtime marker's `captureMaterialInDev`,
 * writes it to `<artifactsDir>/<name>.<hash>.json`, updates `manifest.json`,
 * and triggers an HMR reload so the module graph picks up the new artifact.
 *
 * Protocol (POST body, JSON):
 *   {
 *     "name": "ocean-water",
 *     "hash": "sha256:abcd...",
 *     "artifact": { ... }   // exact compileTSL output
 *   }
 *
 * Response:
 *   200 { "ok": true, "path": "artifacts/ocean-water.abcd.json" }
 *   400 { "error": "..." }  // malformed payload
 *   500 { "error": "..." }  // disk write failure
 *
 * @module DevCaptureServer
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
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

			await writeArtifact( artifactsDir, manifestPath, payload );

			// Trigger HMR — the virtual module for this artifact re-resolves.
			const moduleId = `virtual:tsl-precompile/${ payload.name }`;
			const mod = server.moduleGraph.getModuleById( '\0' + moduleId );
			if ( mod ) {

				server.moduleGraph.invalidateModule( mod );
				server.ws.send( { type: 'update', updates: [ { type: 'js-update', path: moduleId, acceptedPath: moduleId, timestamp: Date.now() } ] } );

			}

			res.statusCode = 200;
			res.setHeader( 'content-type', 'application/json' );
			res.end( JSON.stringify( { ok: true, name: payload.name, hash: payload.hash } ) );

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

function validatePayload( payload ) {

	if ( ! payload || typeof payload !== 'object' ) throw einval( 'payload must be an object' );
	if ( typeof payload.name !== 'string' || payload.name.length === 0 ) throw einval( 'payload.name must be a non-empty string' );
	if ( typeof payload.hash !== 'string' || payload.hash.length === 0 ) throw einval( 'payload.hash must be a non-empty string' );
	if ( ! payload.artifact || typeof payload.artifact !== 'object' ) throw einval( 'payload.artifact must be an object' );

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

	let manifest = {};
	if ( existsSync( manifestPath ) ) {

		try {

			manifest = JSON.parse( await readFile( manifestPath, 'utf8' ) );

		} catch ( _ ) {

			manifest = {};

		}

	}

	manifest[ payload.name ] = { file: filename, hash: payload.hash, capturedAt: new Date().toISOString() };

	await writeFile( manifestPath, JSON.stringify( manifest, null, 2 ), 'utf8' );

}

function shortHash( hash ) {

	// First 12 hex chars — collision odds are negligible in any one project.
	return hash.slice( 0, 12 );

}
