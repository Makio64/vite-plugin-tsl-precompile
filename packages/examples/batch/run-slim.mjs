#!/usr/bin/env node
/**
 * Slim-mode batch verification.
 *
 * For each `webgpu_*.html` example, rewrite the served HTML to inject an
 * importmap that maps `three/webgpu` to our slim bundle, then load the page
 * and check for module-resolution errors.
 *
 * This does NOT verify pixel-correct rendering — examples use raw
 * `new *NodeMaterial()` constructions that hit our loud-fail gate
 * (precompile bypass expects an `isPrecompiledMaterial` flag). What it DOES
 * verify:
 *
 *   1. Every symbol each example imports from `three/webgpu` is exported
 *      by our slim bundle. If we stripped `BatchedMesh`, an example
 *      importing `BatchedMesh` from `three/webgpu` fails at module load.
 *   2. Our rewritten three.js modules (Nodes.js, WebGPURenderer, etc.) load
 *      and parse in a real browser — no syntax errors, no missing globals.
 *   3. The failure we DO expect (loud-fail on non-precompiled material)
 *      fires with our specific error message, not a generic crash.
 *
 *   node packages/examples/batch/run-slim.mjs --three-repo=<path>
 *                                             [--filter=<substr>] [--limit=<n>]
 */

import { chromium } from 'playwright';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const OUT = resolve( SELF, 'results' );
const SLIM_BUNDLE = resolve( SELF, '../../runtime/build/three.webgpu.slim.js' );
if ( ! existsSync( OUT ) ) mkdirSync( OUT, { recursive: true } );
if ( ! existsSync( SLIM_BUNDLE ) ) {

	console.error( `[batch-slim] slim bundle not found: ${ SLIM_BUNDLE }\nRun \`pnpm --filter @tsl-precompile/runtime build:slim\` first.` );
	process.exit( 2 );

}

const args = process.argv.slice( 2 );
function getArg( prefix, def ) {

	const a = args.find( ( x ) => x.startsWith( prefix ) );
	return a ? a.slice( prefix.length ) : def;

}

const threeRepo = resolve( getArg( '--three-repo=', resolve( SELF, '../../../../three.js' ) ) );
const filter = getArg( '--filter=', '' );
const limit = parseInt( getArg( '--limit=', '9999' ), 10 );
const offset = parseInt( getArg( '--offset=', '0' ), 10 );
const port = parseInt( getArg( '--port=', '8719' ), 10 );

if ( ! existsSync( join( threeRepo, 'examples' ) ) ) {

	console.error( `[batch-slim] three.js examples not found at ${ threeRepo }/examples` );
	process.exit( 2 );

}

const SKIP_PREFIXES = [
	'webxr_', 'vr_', 'ar_', 'webgpu_xr_', 'webgpu_webxr_',
	'webgpu_compile_async',
	'webgpu_tsl_precompile',
];
function shouldSkip( name ) { return SKIP_PREFIXES.some( ( p ) => name.includes( p ) ); }

const allExamples = readdirSync( join( threeRepo, 'examples' ) )
	.filter( ( f ) => f.startsWith( 'webgpu_' ) && f.endsWith( '.html' ) )
	.filter( ( f ) => ! filter || f.includes( filter ) )
	.slice( offset, offset + limit );
const candidates = allExamples.filter( ( f ) => ! shouldSkip( f ) );
console.log( `[batch-slim] discovered ${ allExamples.length } webgpu_*.html — ${ candidates.length } after skip list` );

// ---- server with slim-bundle endpoint + importmap injection -------------

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.mjs': 'application/javascript; charset=utf-8',
	'.json': 'application/json',
	'.wasm': 'application/wasm',
	'.css': 'text/css; charset=utf-8',
	'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
	'.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
	'.hdr': 'application/octet-stream', '.exr': 'application/octet-stream',
	'.bin': 'application/octet-stream', '.glb': 'model/gltf-binary',
	'.gltf': 'model/gltf+json', '.ktx2': 'application/octet-stream',
	'.wgsl': 'text/plain; charset=utf-8',
};

// The slim bundle's URL on the test server.
const SLIM_URL = '/__tsl-precompile__/three.webgpu.slim.js';

/**
 * Rewrite an example's HTML importmap so `three/webgpu` → our slim bundle.
 * We leave `three` pointing at the stock core (our slim bundle is WebGPU-
 * specific; the regular `three` still comes from three.js).
 */
function injectSlimImportmap( html ) {

	// Three.js examples typically resolve both `"three"` and `"three/webgpu"`
	// to three.webgpu.js. In a real user project, `three` stays core-only
	// while `three/webgpu` is aliased to our slim bundle. For the batch
	// test we redirect both to the slim bundle — that's the maximally
	// slim configuration any real user could hit.
	return html
		.replace( /("three\/webgpu"\s*:\s*")[^"]+(")/g, `$1${ SLIM_URL }$2` )
		.replace( /("three"\s*:\s*")[^"]*three\.webgpu[^"]*(")/g, `$1${ SLIM_URL }$2` );

}

const server = createServer( async ( req, res ) => {

	try {

		const url = new URL( req.url, 'http://localhost' );

		// Serve the slim bundle at a stable path.
		if ( url.pathname === SLIM_URL ) {

			const buf = await readFile( SLIM_BUNDLE );
			res.setHeader( 'access-control-allow-origin', '*' );
			res.setHeader( 'content-type', 'application/javascript; charset=utf-8' );
			res.end( buf );
			return;

		}

		const filePath = resolve( threeRepo, '.' + url.pathname );
		if ( ! filePath.startsWith( threeRepo ) ) { res.statusCode = 403; res.end( 'forbidden' ); return; }
		const s = await stat( filePath ).catch( () => null );
		if ( ! s || ! s.isFile() ) { res.statusCode = 404; res.end( 'not found' ); return; }
		let buf = await readFile( filePath );

		// Rewrite example HTML to use our slim bundle.
		if ( filePath.endsWith( '.html' ) && filePath.includes( '/examples/webgpu_' ) ) {

			buf = Buffer.from( injectSlimImportmap( buf.toString( 'utf8' ) ) );

		}

		res.setHeader( 'access-control-allow-origin', '*' );
		res.setHeader( 'content-type', MIME[ extname( filePath ).toLowerCase() ] || 'application/octet-stream' );
		res.end( buf );

	} catch ( e ) {

		res.statusCode = 500;
		res.end( 'error: ' + ( e && e.message || e ) );

	}

} );

await new Promise( ( ok, fail ) => server.listen( port, '127.0.0.1', ok ).once( 'error', fail ) );
console.log( `[batch-slim] server on http://localhost:${ port }/` );

// ---- playwright loop ----------------------------------------------------

const BROWSER_ARGS = [ '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage' ];
const MAX_RUNS_PER_BROWSER = 24;
const NAV_TIMEOUT_MS = 25000;
const WAIT_MS = 4000;

// Categories of errors the slim bundle PROVOKES by design (expected):
const EXPECTED_SLIM_RX = /tsl-precompile\/slim|tsl-precompile\/aux|PrecompiledMaterial|loadAux|hashNodeGraphSync|only PrecompiledMaterial|Run dev mode on this scene so precompileAuxiliary/i;
// Errors that indicate our bundle is BROKEN (unexpected):
const MODULE_LOAD_RX = /does not provide an export|is not exported|Failed to resolve module|SyntaxError|Unexpected token|Cannot find module|Unable to resolve specifier/i;

async function runOne( browser, name ) {

	const context = await browser.newContext( { viewport: { width: 640, height: 480 } } );
	const page = await context.newPage();

	const errors = [];
	page.on( 'pageerror', ( e ) => errors.push( String( e && e.message || e ) ) );
	page.on( 'console', ( m ) => { if ( m.type() === 'error' ) errors.push( m.text() ); } );

	try {

		await page.goto( `http://localhost:${ port }/examples/${ name }`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS } );
		await new Promise( ( r ) => setTimeout( r, WAIT_MS ) );

	} catch ( e ) {

		await context.close();
		return { name, status: 'fail', category: 'navigation-timeout', firstError: e.message };

	}

	const real = errors.filter( ( e ) => ! /favicon|Failed to load resource/i.test( e ) );
	await context.close();

	// Categorise.
	const moduleLoadFailure = real.find( ( e ) => MODULE_LOAD_RX.test( e ) );
	if ( moduleLoadFailure ) return { name, status: 'fail', category: 'module-load-error', firstError: moduleLoadFailure.slice( 0, 500 ) };

	const expected = real.find( ( e ) => EXPECTED_SLIM_RX.test( e ) );
	if ( expected ) return { name, status: 'pass', category: 'expected-slim-fail', firstError: expected.slice( 0, 500 ) };

	if ( real.length === 0 ) return { name, status: 'pass', category: 'clean', firstError: null };

	return { name, status: 'fail', category: 'other-error', firstError: real[ 0 ].slice( 0, 500 ) };

}

let browser = await chromium.launch( { channel: 'chrome', headless: true, args: BROWSER_ARGS } ).catch( () => null );
if ( ! browser ) browser = await chromium.launch( { headless: true, args: BROWSER_ARGS } );

const report = { total: candidates.length, pass: 0, fail: 0, skip: allExamples.length - candidates.length, categories: {}, details: [] };
let runsSinceRestart = 0;

try {

	for ( let i = 0; i < candidates.length; i ++ ) {

		const name = candidates[ i ];
		const label = `[${ i + 1 }/${ candidates.length }] ${ name }`;

		try {

			if ( runsSinceRestart >= MAX_RUNS_PER_BROWSER ) {

				await browser.close().catch( () => {} );
				browser = await chromium.launch( { channel: 'chrome', headless: true, args: BROWSER_ARGS } ).catch( () => null );
				if ( ! browser ) browser = await chromium.launch( { headless: true, args: BROWSER_ARGS } );
				runsSinceRestart = 0;

			}

			const result = await runOne( browser, name );
			runsSinceRestart ++;

			if ( result.status === 'pass' ) report.pass ++; else report.fail ++;
			report.categories[ result.category ] = ( report.categories[ result.category ] || 0 ) + 1;
			report.details.push( result );

			const tag = result.status === 'pass' ? '✓' : '✗';
			console.log( `${ label } — ${ tag } ${ result.category }${ result.firstError ? ' "' + String( result.firstError ).slice( 0, 60 ) + '"' : '' }` );

		} catch ( e ) {

			report.fail ++;
			report.details.push( { name, status: 'fail', category: 'harness-error', firstError: e.message } );
			console.log( `${ label } — FAIL harness-error "${ e.message }"` );

		}

	}

} finally {

	await browser.close().catch( () => {} );
	server.close();

}

const reportPath = join( OUT, 'slim-report.json' );
writeFileSync( reportPath, JSON.stringify( report, null, 2 ) );
console.log( '\n═══ slim summary ═══' );
console.log( `  ${ report.pass } pass, ${ report.fail } fail, ${ report.skip } skip, ${ report.total } candidates` );
console.log( '\n  categories:' );
for ( const [ c, n ] of Object.entries( report.categories ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] ) ) {

	console.log( `    ${ n }× ${ c }` );

}
console.log( `\n  report: ${ reportPath }` );

// Exit non-zero if any example hit an unexpected error. Expected slim-mode
// failures are counted as passes above because they prove the loud-fail gate
// is firing instead of leaking a generic crash or missing export.
const moduleLoadFails = ( report.categories[ 'module-load-error' ] || 0 );
if ( report.fail > 0 ) {

	console.log( `\n  FAIL: ${ report.fail } unexpected slim-bundle error(s) (${ moduleLoadFails } module-load).` );
	process.exit( 1 );

}

console.log( `\n  PASS: slim bundle loaded cleanly across every example (loud-fail gate firing as designed for non-precompiled materials).` );
process.exit( 0 );
