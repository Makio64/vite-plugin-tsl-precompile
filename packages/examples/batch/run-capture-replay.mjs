#!/usr/bin/env node
/**
 * Capture-replay proof-of-concept.
 *
 * Drives the ocean demo through the full precompile loop end-to-end:
 *
 *   1. Spawn `pnpm --filter @tsl-precompile/examples-ocean dev` (Vite dev
 *      server with the plugin, FULL three bundle so the marker can extract).
 *   2. Playwright visits the page, waits for first render. The runtime
 *      `precompile(name)` marker fires on the water material; the
 *      dev-capture server writes `artifacts/ocean-water.<hash>.json`.
 *   3. Kill dev server.
 *   4. Verify an artifact landed on disk.
 *
 * This is intentionally narrow: the proof is that ONE example's capture
 * loop works end-to-end. Scaling to 198 examples requires: per-example
 * Vite entrypoints, auto-marking every material, waiting for capture
 * stability, then swapping to slim mode. That's multi-hour work per
 * example-set; not in this POC's scope.
 *
 * Usage: node run-capture-replay.mjs
 */

import { spawn } from 'node:child_process';
import { readdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const OCEAN_DIR = resolve( SELF, '../ocean' );
const ARTIFACTS_DIR = resolve( OCEAN_DIR, 'artifacts' );

// Clean any stale artifacts so we prove this run captured fresh.
if ( existsSync( ARTIFACTS_DIR ) ) {

	rmSync( ARTIFACTS_DIR, { recursive: true, force: true } );
	console.log( `[capture-replay] cleaned ${ ARTIFACTS_DIR }` );

}

console.log( '[capture-replay] starting Vite dev server for ocean…' );
const vite = spawn( 'npx', [ 'vite', '--port', '5199', '--strictPort' ], {
	cwd: OCEAN_DIR,
	env: { ...process.env, NO_COLOR: '1' },
	stdio: [ 'ignore', 'pipe', 'pipe' ],
} );

let viteReady = false;
let viteUrl = null;

vite.stdout.on( 'data', ( chunk ) => {

	const s = chunk.toString();
	process.stdout.write( '[vite] ' + s );
	const m = s.match( /Local:\s+(http:\/\/[^\s/]+)/ );
	if ( m ) {

		viteUrl = m[ 1 ];
		viteReady = true;

	}

} );
vite.stderr.on( 'data', ( chunk ) => process.stderr.write( '[vite-err] ' + chunk.toString() ) );

// Wait up to 30s for Vite ready.
const deadline = Date.now() + 30000;
while ( ! viteReady && Date.now() < deadline ) await new Promise( ( r ) => setTimeout( r, 250 ) );
if ( ! viteReady ) {

	console.error( '[capture-replay] Vite did not become ready within 30s' );
	vite.kill();
	process.exit( 2 );

}
console.log( `[capture-replay] Vite ready at ${ viteUrl }` );

// Wait a little more for full readiness after banner.
await new Promise( ( r ) => setTimeout( r, 2000 ) );

const BROWSER_ARGS = [ '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage' ];
let browser;
try {

	browser = await chromium.launch( { channel: 'chrome', headless: true, args: BROWSER_ARGS } );

} catch {

	browser = await chromium.launch( { headless: true, args: BROWSER_ARGS } );

}

const context = await browser.newContext( { viewport: { width: 640, height: 480 } } );
const page = await context.newPage();
const consoleErrors = [];
page.on( 'pageerror', ( e ) => consoleErrors.push( String( e.message || e ) ) );
page.on( 'console', ( m ) => {

	if ( m.type() === 'error' ) consoleErrors.push( m.text() );
	if ( m.type() === 'info' ) console.log( '[browser/info]', m.text() );

} );

console.log( `[capture-replay] navigating to ${ viteUrl }` );
await page.goto( viteUrl, { waitUntil: 'load', timeout: 20000 } );

// Give the marker time to capture + POST to dev-capture endpoint.
await new Promise( ( r ) => setTimeout( r, 8000 ) );

const real = consoleErrors.filter( ( e ) => ! /favicon|Failed to load resource/.test( e ) );
await context.close();
await browser.close();
vite.kill( 'SIGTERM' );

console.log( '\n[capture-replay] checking artifacts directory…' );
const files = existsSync( ARTIFACTS_DIR ) ? readdirSync( ARTIFACTS_DIR ) : [];
console.log( '[capture-replay] artifacts:', files );

const userArtifact = files.find( ( f ) => f.startsWith( 'ocean-water.' ) && f.endsWith( '.json' ) );
const auxArtifacts = files.filter( ( f ) => f.startsWith( 'aux-' ) && f.endsWith( '.json' ) );

console.log( '\n═══ capture-replay result ═══' );
console.log( '  user material (ocean-water):', userArtifact ? '✓ ' + userArtifact : '✗ NOT captured' );
console.log( '  aux artifacts:', auxArtifacts.length, '→', auxArtifacts.join( ', ' ) || '(none)' );
console.log( '  browser errors:', real.length );
if ( real.length > 0 ) {

	for ( const e of real.slice( 0, 5 ) ) console.log( '   ', e.slice( 0, 200 ) );

}

const ok = userArtifact && real.filter( ( e ) => ! /tsl-precompile/.test( e ) ).length === 0;
console.log( ok ? '\n  PASS: end-to-end capture works.' : '\n  FAIL: capture did not produce the expected artifact.' );
process.exit( ok ? 0 : 1 );
