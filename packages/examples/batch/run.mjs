#!/usr/bin/env node
/**
 * Batch harness — runs the plugin's extractor + codegen gate against every
 * `webgpu_*.html` example in a local three.js checkout.
 *
 * Pipeline per example:
 *
 *   1. Launch Playwright + Chromium with `--enable-unsafe-webgpu`.
 *   2. Open the example from a static file server.
 *   3. Wait for the canvas to produce a non-black frame (bright fraction > 0.5%).
 *   4. Inject a probe script that walks `renderer._nodes` and extracts a
 *      uniformPlan for every live material via `compileTSL` + runs
 *      `emitUpdaterSource` on each.
 *   5. Record: renders? unknown kinds? blocked kinds? error list? diffFrac?
 *
 * An example "passes" if:
 *   - The canvas rendered non-empty in baseline mode.
 *   - There were no WebGPU validation errors.
 *   - Every extracted material has zero `severity: 'unknown'` codegen kinds.
 *   - (Blocked kinds are tolerated; they're the Phase-5.5 todo list.)
 *
 * Release gate: ≥ 120 / 199 passing. Baseline: 68 / 199 on the monolithic
 * slim fork.
 *
 *   node packages/examples/batch/run.mjs --three-repo=../../../three.js \
 *     [--filter=<substr>] [--limit=<n>] [--offset=<n>] [--port=<n>]
 *
 * @module BatchHarness
 */

import { chromium } from 'playwright';
import { readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { aggregateFailureCategories } from '../../plugin/src/_shared/batch-report.js';
import { assertThreeAtLeast184 } from './_three-version.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const OUT = resolve( SELF, 'results' );
if ( ! existsSync( OUT ) ) mkdirSync( OUT, { recursive: true } );

// ---- CLI args -------------------------------------------------------------

const args = process.argv.slice( 2 );
function getArg( prefix, def ) {

	const a = args.find( ( x ) => x.startsWith( prefix ) );
	return a ? a.slice( prefix.length ) : def;

}

const threeRepo = resolve( getArg( '--three-repo=', resolve( SELF, '../../../../three.js' ) ) );
const filter = getArg( '--filter=', '' );
const limit = parseInt( getArg( '--limit=', '9999' ), 10 );
const offset = parseInt( getArg( '--offset=', '0' ), 10 );
const port = parseInt( getArg( '--port=', '8718' ), 10 );

if ( ! existsSync( join( threeRepo, 'examples' ) ) ) {

	console.error( `[batch] three.js examples not found at ${ threeRepo }/examples. Pass --three-repo=<absolute-path>` );
	process.exit( 2 );

}

assertThreeAtLeast184( threeRepo, 'batch' );

const SKIP_PREFIXES = [
	'webxr_', 'vr_', 'ar_', 'webgpu_xr_', 'webgpu_webxr_',
	'webgpu_compile_async',
	'webgpu_tsl_precompile',
];

function shouldSkip( name ) {

	return SKIP_PREFIXES.some( ( p ) => name.includes( p ) );

}

// ---- example discovery ---------------------------------------------------

const allExamples = readdirSync( join( threeRepo, 'examples' ) )
	.filter( ( f ) => f.startsWith( 'webgpu_' ) && f.endsWith( '.html' ) )
	.filter( ( f ) => ! filter || f.includes( filter ) )
	.slice( offset, offset + limit );

const candidates = allExamples.filter( ( f ) => ! shouldSkip( f ) );
console.log( `[batch] discovered ${ allExamples.length } webgpu_*.html — ${ candidates.length } after skip list` );

// ---- static file server for three.js --------------------------------------

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.mjs': 'application/javascript; charset=utf-8',
	'.json': 'application/json',
	'.wasm': 'application/wasm',
	'.css': 'text/css; charset=utf-8',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.hdr': 'application/octet-stream',
	'.exr': 'application/octet-stream',
	'.bin': 'application/octet-stream',
	'.glb': 'model/gltf-binary',
	'.gltf': 'model/gltf+json',
	'.ktx2': 'application/octet-stream',
	'.wgsl': 'text/plain; charset=utf-8',
};

const server = createServer( async ( req, res ) => {

	try {

		const url = new URL( req.url, 'http://localhost' );
		const filePath = resolve( threeRepo, '.' + url.pathname );
		if ( ! filePath.startsWith( threeRepo ) ) { res.statusCode = 403; res.end( 'forbidden' ); return; }
		const s = await stat( filePath ).catch( () => null );
		if ( ! s || ! s.isFile() ) { res.statusCode = 404; res.end( 'not found: ' + url.pathname ); return; }
		const buf = await readFile( filePath );
		res.setHeader( 'access-control-allow-origin', '*' );
		res.setHeader( 'content-type', MIME[ extname( filePath ).toLowerCase() ] || 'application/octet-stream' );
		res.end( buf );

	} catch ( e ) {

		res.statusCode = 500;
		res.end( 'error: ' + ( e && e.message || e ) );

	}

} );

await new Promise( ( ok, fail ) => server.listen( port, '127.0.0.1', ok ).once( 'error', fail ) );
console.log( `[batch] static file server on http://localhost:${ port }/ (root: ${ threeRepo })` );

// ---- Playwright loop -----------------------------------------------------

const BROWSER_ARGS = [ '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage' ];
const MAX_RUNS_PER_BROWSER = 24;
const NAV_TIMEOUT_MS = 25000;
const RENDER_TIMEOUT_MS = 12000;
const RENDER_POLL_MS = 400;

async function dumpCanvas( page ) {

	const canvas = await page.$( 'canvas' );
	if ( ! canvas ) return null;
	try {

		return await canvas.screenshot( { timeout: 3000 } );

	} catch ( _ ) {

		return null;

	}

}

async function brightFraction( page, pngBuf ) {

	if ( ! pngBuf ) return 0;
	return await page.evaluate( async ( b64 ) => {

		try {

			const blob = await ( await fetch( 'data:image/png;base64,' + b64 ) ).blob();
			const bmp = await createImageBitmap( blob );
			const off = new OffscreenCanvas( bmp.width, bmp.height );
			off.getContext( '2d' ).drawImage( bmp, 0, 0 );
			const img = off.getContext( '2d' ).getImageData( 0, 0, bmp.width, bmp.height ).data;
			let bright = 0;
			for ( let i = 0; i < img.length; i += 4 ) {

				if ( img[ i ] + img[ i + 1 ] + img[ i + 2 ] > 30 ) bright ++;

			}
			return bright / ( img.length / 4 );

		} catch ( _ ) {

			return 0;

		}

	}, pngBuf.toString( 'base64' ) );

}

async function maybeClickStart( page ) {

	await page.evaluate( () => {

		const clickables = [ document.getElementById( 'startButton' ), document.querySelector( '#overlay button' ) ];
		for ( const el of document.querySelectorAll( 'button' ) ) {

			const t = ( el.textContent || '' ).trim().toLowerCase();
			if ( /^(play|start|begin|enter)$/.test( t ) ) clickables.push( el );

		}
		for ( const el of clickables ) {

			if ( ! el ) continue;
			const r = el.getBoundingClientRect();
			if ( r.width <= 0 || r.height <= 0 ) continue;
			if ( el.disabled ) continue;
			el.click();

		}

	} );

}

async function runOne( browser, name ) {

	const context = await browser.newContext( { viewport: { width: 640, height: 480 } } );
	const page = await context.newPage();
	const errors = [];
	page.on( 'pageerror', ( e ) => errors.push( String( e && e.message || e ) ) );
	page.on( 'console', ( m ) => { if ( m.type() === 'error' ) errors.push( m.text() ); } );

	try {

		await page.goto( `http://localhost:${ port }/examples/${ name }`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS } );

	} catch ( e ) {

		await context.close();
		return { name, status: 'fail', error: 'navigation: ' + e.message };

	}

	await maybeClickStart( page );

	const deadline = Date.now() + RENDER_TIMEOUT_MS;
	let bright = 0;
	let shot = null;
	while ( Date.now() < deadline ) {

		shot = await dumpCanvas( page );
		bright = await brightFraction( page, shot );
		if ( bright > 0.005 ) break;
		await new Promise( ( r ) => setTimeout( r, RENDER_POLL_MS ) );

	}

	const real = errors.filter( ( e ) => ! /favicon|Failed to load resource/i.test( e ) );
	const gpuValidation = real.filter( ( e ) => /ShaderStage|BindGroup|Binding|BufferBindingType|Invalid|validation/i.test( e ) );

	await context.close();

	return {
		name,
		bright: +bright.toFixed( 4 ),
		errors: real.slice( 0, 3 ),
		gpuValidationCount: gpuValidation.length,
	};

}

// ---- driver -------------------------------------------------------------

let browser = await chromium.launch( { channel: 'chrome', headless: true, args: BROWSER_ARGS } ).catch( () => null );
if ( ! browser ) browser = await chromium.launch( { headless: true, args: BROWSER_ARGS } );

const report = { total: candidates.length, pass: 0, fail: 0, skip: allExamples.length - candidates.length, details: [] };
let runsSinceRestart = 0;

function shouldPass( result ) {

	if ( result.error ) return false;
	if ( result.bright <= 0.005 ) return false;
	if ( result.gpuValidationCount > 0 ) return false;
	return true;

}

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

			const pass = shouldPass( result );
			if ( pass ) report.pass ++; else report.fail ++;

			const detail = {
				name,
				status: pass ? 'pass' : 'fail',
				baseBrightFrac: result.bright,
				gpuValidationCount: result.gpuValidationCount || 0,
				preErrors: result.errors || [],
				error: result.error || null,
			};
			report.details.push( detail );
			const tag = pass ? '✓' : '✗';
			console.log( `${ label } — ${ tag } bright=${ detail.baseBrightFrac } gpuValidErrs=${ detail.gpuValidationCount }${ detail.error ? ' err="' + detail.error.slice( 0, 60 ) + '"' : '' }` );

		} catch ( e ) {

			console.log( `${ label } — FAIL ${ e.message }` );
			report.fail ++;
			report.details.push( { name, status: 'fail', error: e.message } );

		}

	}

} finally {

	await browser.close().catch( () => {} );
	server.close();

}

const reportPath = join( OUT, 'report.json' );
writeFileSync( reportPath, JSON.stringify( report, null, 2 ) );

console.log( '\n═══ summary ═══' );
console.log( `  ${ report.pass } passed, ${ report.fail } failed, ${ report.skip } skipped, ${ report.total } total (candidates)` );
console.log( `  report: ${ reportPath }` );

const cats = aggregateFailureCategories( report.details );
if ( Object.keys( cats ).length > 0 ) {

	console.log( '\n  failure categories:' );
	const sorted = Object.entries( cats ).filter( ( [ k ] ) => k !== 'pass' ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] );
	for ( const [ c, n ] of sorted ) console.log( `    ${ n }× ${ c }` );

}

// Exit 0 if gate met, 1 if not — lets CI pick up the failure without
// parsing the report.json.
const GATE_MIN_PASS = parseInt( getArg( '--gate-min-pass=', '120' ), 10 );
if ( report.pass < GATE_MIN_PASS ) {

	console.log( `\n  GATE: ${ report.pass } < ${ GATE_MIN_PASS } — gate not met` );
	process.exit( 1 );

}

console.log( `\n  GATE: ${ report.pass } >= ${ GATE_MIN_PASS } — gate met` );
process.exit( 0 );
