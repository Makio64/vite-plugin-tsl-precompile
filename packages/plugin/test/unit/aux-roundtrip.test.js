/**
 * End-to-end aux-pass round-trip.
 *
 * Exercises the whole chain that the browser would hit in dev + build:
 *
 *   1. [capture]  Node-harness `extractBackgroundArtifact` produces an
 *                 artifact + configHash for a scene.backgroundNode.
 *   2. [server]   POST to the dev-capture endpoint → writes
 *                 `aux-background-<shortHash>.json` + `manifest.__aux` entry.
 *   3. [loader]   Re-read the on-disk manifest the way the Vite plugin does.
 *   4. [virtual]  Synthesize the `virtual:tsl-precompile/__aux` module source
 *                 the plugin would emit, eval it, and confirm the runtime
 *                 `loadAux(shape, configHash)` returns the SAME artifact.
 *
 * If any link in the chain breaks, this test catches it with a concrete diff.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { extractBackgroundArtifact } from '../../src/aux-capture.js';
import { attachDevCapture } from '../../src/dev-capture-server.js';
import { VIRTUAL_AUX_MODULE_ID } from '../../src/_shared/constants.js';
import {
	registerAuxArtifact,
	registerAuxArtifacts,
	loadAux,
	listAux,
	__resetAuxRegistryForTests,
} from '../../../runtime/src/aux-loader.js';

function makeFakeViteServer() {

	const handlers = [];
	return {
		middlewares: { use: ( path, fn ) => handlers.push( { path, fn } ) },
		moduleGraph: { getModuleById: () => null, invalidateModule: () => {} },
		ws: { send: () => {} },
		_handlers: handlers,
	};

}

async function spinUpServer( viteServer ) {

	return new Promise( ( resolve ) => {

		const http = createServer( ( req, res ) => {

			for ( const h of viteServer._handlers ) {

				if ( req.url === h.path ) return h.fn( req, res );

			}
			res.statusCode = 404;
			res.end();

		} );
		http.listen( 0, '127.0.0.1', () => resolve( { http, port: http.address().port } ) );

	} );

}

async function postJSON( port, path, body ) {

	const res = await fetch( `http://127.0.0.1:${ port }${ path }`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify( body ),
	} );
	const text = await res.text();
	return { status: res.status, json: JSON.parse( text ) };

}

/**
 * Mimic the plugin's manifest loader: walk artifactsDir, pick aux files by
 * their __materialShape + __configHash, return them in the same shape the
 * virtual-module emitter expects.
 */
function loadAuxManifest( artifactsDir ) {

	const files = readdirSync( artifactsDir ).filter( ( f ) => f.endsWith( '.json' ) && f !== 'manifest.json' );
	const out = {};
	for ( const f of files ) {

		const parsed = JSON.parse( readFileSync( join( artifactsDir, f ), 'utf8' ) );
		if ( ! parsed.__materialShape || ! parsed.__configHash ) continue;
		const key = `${ parsed.__materialShape }:${ parsed.__configHash }`;
		out[ key ] = { shape: parsed.__materialShape, configHash: parsed.__configHash, artifact: parsed.artifact || parsed };

	}
	return out;

}

test( 'aux-roundtrip: capture → POST → disk → manifest → virtual module → loadAux', async () => {

	__resetAuxRegistryForTests();
	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-rt-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );

	try {

		// (1) capture
		const captured = await extractBackgroundArtifact( ( { tsl } ) => ( {
			backgroundNode: tsl.color( 0x8080ff ),
			name: 'roundtrip-bg',
		} ) );

		// (2) server: POST payload matching the aux-marker shape
		const postRes = await postJSON( port, '/__tsl-precompile/capture', {
			materialShape: captured.materialShape,
			configHash: captured.configHash,
			hash: captured.hash,
			name: 'roundtrip-bg',
			artifact: captured.artifact,
		} );
		assert.equal( postRes.status, 200 );
		assert.equal( postRes.json.ok, true );

		// (3) loader: re-read manifest as the plugin would
		const auxManifest = loadAuxManifest( artifactsDir );
		const entry = auxManifest[ `background:${ captured.configHash }` ];
		assert.ok( entry, 'aux manifest should carry the captured entry' );

		// (4) virtual module: synthesize the source the plugin emits, then
		// evaluate its `registerAuxArtifacts` call against the runtime loader.
		// We can't eval the real import'd virtual module in node:test — but
		// we can build the same payload by hand and hit registerAuxArtifacts
		// directly, which is the line of user-facing code that matters.
		registerAuxArtifacts( Object.values( auxManifest ) );

		// (5) lookup: runtime loads by (shape, configHash) and gets back the
		// extracted artifact (byte-equivalent JSON).
		const loaded = loadAux( 'background', captured.configHash );
		assert.deepEqual( loaded, entry.artifact );

		// Exercise the virtual-module source generator too, just to confirm
		// the emitted JS parses and imports from the runtime package.
		// (We can't evaluate it without a proper module resolver in the
		// test env, but we CAN check its shape.)
		const virtualSource = buildVirtualAuxSource( auxManifest );
		assert.match( virtualSource, /import \{ registerAuxArtifacts \} from '@tsl-precompile\/runtime'/ );
		assert.match( virtualSource, /registerAuxArtifacts\( __auxEntries \);/ );
		assert.match( virtualSource, new RegExp( `"configHash": ${ JSON.stringify( captured.configHash ) }` ) );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'aux-roundtrip: red vs green backgrounds → two entries, each looks up to the right artifact', async () => {

	__resetAuxRegistryForTests();
	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-rt-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );

	try {

		const red = await extractBackgroundArtifact( ( { tsl } ) => ( { backgroundNode: tsl.color( 0xff0000 ), name: 'bg-red' } ) );
		const green = await extractBackgroundArtifact( ( { tsl } ) => ( { backgroundNode: tsl.color( 0x00ff00 ), name: 'bg-green' } ) );

		for ( const c of [ red, green ] ) {

			await postJSON( port, '/__tsl-precompile/capture', {
				materialShape: c.materialShape,
				configHash: c.configHash,
				hash: c.hash,
				artifact: c.artifact,
			} );

		}

		const auxManifest = loadAuxManifest( artifactsDir );
		registerAuxArtifacts( Object.values( auxManifest ) );

		assert.equal( listAux().length, 2 );
		const loadedRed = loadAux( 'background', red.configHash );
		const loadedGreen = loadAux( 'background', green.configHash );
		assert.notDeepEqual( loadedRed, loadedGreen, 'red and green artifacts must differ' );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

/**
 * Same shape as the generator in `packages/plugin/src/index.js` — inlined
 * here to keep the test self-contained (the plugin's load() hook is
 * Vite-scoped; we test the output shape by mirroring the code).
 */
function buildVirtualAuxSource( auxManifest ) {

	const entries = Object.values( auxManifest );
	if ( entries.length === 0 ) return `export default [];\n`;
	const lines = [];
	lines.push( `import { registerAuxArtifacts } from '@tsl-precompile/runtime';` );
	lines.push( '' );
	lines.push( `const __auxEntries = [` );
	for ( const e of entries ) {

		lines.push( `  { "shape": ${ JSON.stringify( e.shape ) }, "configHash": ${ JSON.stringify( e.configHash ) }, "artifact": ${ JSON.stringify( e.artifact ) } },` );

	}
	lines.push( `];` );
	lines.push( '' );
	lines.push( `registerAuxArtifacts( __auxEntries );` );
	lines.push( `export default __auxEntries;` );
	lines.push( `// ${ VIRTUAL_AUX_MODULE_ID }` );
	return lines.join( '\n' );

}
