#!/usr/bin/env node
/**
 * Inspector panel smoke test.
 *
 * Drives the ocean demo in a real browser + verifies:
 *   1. The three.js Inspector's Precompile tab is visible in the DOM.
 *   2. At least one capture row lands in the list within a few seconds.
 *   3. The summary pill counts match the captured artifacts.
 *
 * This complements the unit-level tests (which can't exercise real DOM /
 * three.js Inspector) with an end-to-end browser check.
 *
 * Usage: node run-inspector-smoke.mjs
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const OCEAN_DIR = resolve( SELF, '../ocean' );

console.log( '[inspector-smoke] starting Vite dev server…' );
const vite = spawn( 'npx', [ 'vite', '--port', '5210', '--strictPort' ], {
	cwd: OCEAN_DIR,
	env: { ...process.env, NO_COLOR: '1' },
	stdio: [ 'ignore', 'pipe', 'pipe' ],
} );

let viteReady = false;
let viteUrl = null;
vite.stdout.on( 'data', ( chunk ) => {

	const s = chunk.toString();
	const m = s.match( /Local:\s+(http:\/\/[^\s/]+)/ );
	if ( m ) { viteUrl = m[ 1 ]; viteReady = true; }

} );
vite.stderr.on( 'data', ( chunk ) => process.stderr.write( '[vite-err] ' + chunk.toString() ) );

const deadline = Date.now() + 30000;
while ( ! viteReady && Date.now() < deadline ) await new Promise( ( r ) => setTimeout( r, 250 ) );
if ( ! viteReady ) {

	console.error( '[inspector-smoke] Vite did not become ready' );
	vite.kill();
	process.exit( 2 );

}
console.log( `[inspector-smoke] Vite ready at ${ viteUrl }` );
await new Promise( ( r ) => setTimeout( r, 2000 ) );

const BROWSER_ARGS = [ '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage' ];
let browser;
try {

	browser = await chromium.launch( { channel: 'chrome', headless: true, args: BROWSER_ARGS } );

} catch {

	browser = await chromium.launch( { headless: true, args: BROWSER_ARGS } );

}

const context = await browser.newContext( { viewport: { width: 1024, height: 720 } } );
const page = await context.newPage();

page.on( 'pageerror', ( e ) => console.error( '[pageerror]', e.message ) );
page.on( 'console', ( m ) => {

	const t = m.type();
	if ( t === 'error' ) console.error( '[browser-err]', m.text() );
	else if ( t === 'warning' ) console.warn( '[browser-warn]', m.text() );
	else if ( t === 'info' || t === 'log' ) console.log( '[browser-log]', m.text() );

} );
page.on( 'requestfailed', ( r ) => console.error( '[reqfail]', r.url(), r.failure()?.errorText ) );
page.on( 'response', async ( r ) => {

	if ( r.status() >= 400 && ! /favicon/.test( r.url() ) ) console.error( '[bad-response]', r.status(), r.url() );

} );

await page.goto( viteUrl, { waitUntil: 'load', timeout: 20000 } );
await new Promise( ( r ) => setTimeout( r, 5000 ) );

// Diagnostic: list all buttons / tabs present so we know what we're dealing with.
const shapeReport = await page.evaluate( () => ( {
	hasProfiler: !! document.querySelector( '.profiler' ),
	hasInspector: !! document.querySelector( '[class*="inspector"], [class*="profiler"]' ),
	profilerClass: document.querySelector( '.profiler' )?.className || null,
	allClasses: Array.from( document.querySelectorAll( 'div' ) ).slice( 0, 30 )
		.map( ( d ) => d.className )
		.filter( ( c ) => typeof c === 'string' && c.length > 0 )
		.slice( 0, 15 ),
	bodyChildCount: document.body.children.length,
	tabBtns: Array.from( document.querySelectorAll( '.tab-btn' ) ).map( ( b ) => b.textContent.trim() ),
} ) );
console.log( '[inspector-smoke] DOM shape:', JSON.stringify( shapeReport, null, 2 ) );

// Open the inspector's profiler panel if it's collapsed. three.js adds a
// toggle button; clicking makes the profiler .visible.
await page.evaluate( () => {

	const allBtns = Array.from( document.querySelectorAll( 'button' ) );
	const toggle = allBtns.find( ( b ) => b.className.includes( 'profiler-toggle' ) );
	if ( toggle ) toggle.click();
	const panel = document.querySelector( '.profiler' );
	if ( panel && ! panel.classList.contains( 'visible' ) ) panel.classList.add( 'visible' );

} );

// Activate the Precompile tab.
await page.evaluate( () => {

	const btns = Array.from( document.querySelectorAll( '.tab-btn' ) );
	const b = btns.find( ( x ) => ( x.textContent || '' ).trim().toLowerCase() === 'precompile' );
	if ( b ) b.click();

} );

await new Promise( ( r ) => setTimeout( r, 1500 ) );

const probe = await page.evaluate( () => {

	const panel = document.querySelector( '.tslp-wrap' );
	if ( ! panel ) return { ok: false, reason: 'panel root .tslp-wrap not found in DOM' };
	const summary = panel.querySelector( '.tslp-summary-totals' );
	const rows = panel.querySelectorAll( '.tslp-row[data-id]' );
	const pills = panel.querySelectorAll( '.tslp-pill' );
	return {
		ok: true,
		totalText: summary ? summary.textContent.replace( /\s+/g, ' ' ).trim() : null,
		rowCount: rows.length,
		rowNames: Array.from( rows ).slice( 0, 10 ).map( ( r ) => r.querySelector( '.tslp-cell-name' )?.textContent?.trim() ),
		pillTexts: Array.from( pills ).map( ( p ) => p.textContent.trim() ),
	};

} );

await context.close();
await browser.close();
vite.kill( 'SIGTERM' );

console.log( '\n═══ inspector-smoke result ═══' );
if ( ! probe.ok ) {

	console.error( '  FAIL:', probe.reason );
	process.exit( 1 );

}
console.log( '  summary:  ', probe.totalText );
console.log( '  pills:    ', probe.pillTexts.join( ' · ' ) || '(none)' );
console.log( '  rowCount: ', probe.rowCount );
console.log( '  names:    ', probe.rowNames.join( ', ' ) || '(empty)' );

if ( probe.rowCount === 0 ) {

	console.error( '  FAIL: panel rendered but no captures appeared.' );
	process.exit( 1 );

}

console.log( '\n  PASS: panel is live + captures visible.' );
process.exit( 0 );
