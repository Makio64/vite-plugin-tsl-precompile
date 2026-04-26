/**
 * Dev-capture-server aux payload support.
 *
 * Simulates a Vite ViteDevServer surface (middlewares + moduleGraph + ws)
 * with just enough shape for attachDevCapture, then POSTs:
 *
 *   1. A user-material payload — must write <name>.<shortHash>.json + manifest entry keyed by name.
 *   2. An aux payload (materialShape: 'background') — must write aux-background-<shortHash>.json + manifest.__aux entry keyed by shape:configHash.
 *   3. A malformed aux payload — must reject with 400.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { attachDevCapture } from '../../src/dev-capture-server.js';

function makeFakeViteServer() {

	const handlers = [];
	return {
		middlewares: {
			use: ( path, fn ) => handlers.push( { path, fn } ),
		},
		moduleGraph: { getModuleById: () => null, invalidateModule: () => {} },
		ws: { send: () => {} },
		_handlers: handlers,
	};

}

async function postJSON( port, path, body ) {

	const res = await fetch( `http://127.0.0.1:${ port }${ path }`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify( body ),
	} );
	const text = await res.text();
	let json = null;
	try { json = JSON.parse( text ); } catch ( _ ) { /* ignore */ }
	return { status: res.status, text, json };

}

/**
 * Wire the Vite fake handlers into a real node:http server so the runtime
 * sees a legitimate req/res pair. attachDevCapture registers its handler
 * via `server.middlewares.use(path, fn)`; we translate those registrations
 * into an http request router.
 */
function spinUpServer( viteServer ) {

	return new Promise( ( resolve, reject ) => {

		const http = createServer( ( req, res ) => {

			for ( const h of viteServer._handlers ) {

				if ( req.url === h.path || req.url.startsWith( h.path + '?' ) ) {

					h.fn( req, res );
					return;

				}

			}
			res.statusCode = 404;
			res.end( 'no handler' );

		} );
		http.listen( 0, '127.0.0.1', () => resolve( { http, port: http.address().port } ) );
		http.once( 'error', reject );

	} );

}

test( 'dev-capture: user-material payload writes <name>.<hash>.json + manifest', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );

	const { http, port } = await spinUpServer( vite );

	try {

		const r = await postJSON( port, '/__tsl-precompile/capture', {
			name: 'ocean-water',
			hash: 'abcdef1234567890aaaa',
			artifact: { uniformPlan: [], vertexShader: 'v', fragmentShader: 'f' },
		} );
		assert.equal( r.status, 200 );
		assert.equal( r.json.ok, true );
		assert.equal( r.json.name, 'ocean-water' );

		const files = readdirSync( artifactsDir );
		assert.ok( files.includes( 'manifest.json' ) );
		const artifactFile = files.find( ( f ) => f.startsWith( 'ocean-water.' ) );
		assert.ok( artifactFile, `expected ocean-water.* artifact, got ${ files.join( ',' ) }` );

		const manifest = JSON.parse( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ) );
		assert.ok( manifest[ 'ocean-water' ], 'manifest should key user capture by name' );
		assert.equal( manifest[ 'ocean-water' ].hash, 'abcdef1234567890aaaa' );
		assert.equal( manifest.__aux, undefined );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: aux background payload writes aux-<shape>-<hash>.json + manifest.__aux', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );

	const { http, port } = await spinUpServer( vite );

	try {

		const configHash = '0011aabbccdd2233eeff4455aaaabbbb'.padEnd( 64, '0' );
		const r = await postJSON( port, '/__tsl-precompile/capture', {
			materialShape: 'background',
			configHash,
			hash: 'artifacthashxxxx',
			artifact: { uniformPlan: [], vertexShader: 'v', fragmentShader: 'f', materialShape: 'background' },
			name: 'aux-background-test',
		} );
		assert.equal( r.status, 200 );
		assert.equal( r.json.ok, true );
		assert.equal( r.json.materialShape, 'background' );
		assert.equal( r.json.configHash, configHash );

		const files = readdirSync( artifactsDir );
		const auxFile = files.find( ( f ) => f.startsWith( 'aux-background-' ) );
		assert.ok( auxFile, `expected aux-background-* file, got ${ files.join( ',' ) }` );

		const manifest = JSON.parse( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ) );
		assert.ok( manifest.__aux, 'manifest.__aux should exist for aux capture' );
		const entry = manifest.__aux[ `background:${ configHash }` ];
		assert.ok( entry, 'aux manifest should be keyed by shape:configHash' );
		assert.equal( entry.shape, 'background' );
		assert.equal( entry.configHash, configHash );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: aux payload missing configHash → 400', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );

	const { http, port } = await spinUpServer( vite );

	try {

		const r = await postJSON( port, '/__tsl-precompile/capture', {
			materialShape: 'post-process',
			// configHash missing
			artifact: { uniformPlan: [] },
		} );
		assert.equal( r.status, 400 );
		assert.match( r.json.error, /configHash/ );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: two aux captures with different configHashes co-exist in manifest', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );

	const { http, port } = await spinUpServer( vite );

	try {

		const hashA = 'aaaa'.repeat( 16 );
		const hashB = 'bbbb'.repeat( 16 );
		await postJSON( port, '/__tsl-precompile/capture', {
			materialShape: 'background', configHash: hashA,
			artifact: { uniformPlan: [] },
		} );
		await postJSON( port, '/__tsl-precompile/capture', {
			materialShape: 'background', configHash: hashB,
			artifact: { uniformPlan: [] },
		} );

		const manifest = JSON.parse( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ) );
		assert.ok( manifest.__aux[ `background:${ hashA }` ] );
		assert.ok( manifest.__aux[ `background:${ hashB }` ] );
		assert.notEqual( manifest.__aux[ `background:${ hashA }` ].file, manifest.__aux[ `background:${ hashB }` ].file );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );
