#!/usr/bin/env node
/**
 * Batch harness — runs the plugin against three.js's webgpu_*.html examples.
 *
 * Phase 6 release gate: ≥ 120 / 199 passing (baseline today: 68 / 199 on the
 * monolithic slim bundle in `Makio64/three.js@tsl-precompile`).
 *
 * Pipeline:
 *
 *   1. Discover examples in `--three-repo=<path>/examples/webgpu_*.html`.
 *   2. For each example:
 *      a. Auto-mark mode: rewrite the example's `<script type="module">` so
 *         every `new *NodeMaterial()` call is followed by `.precompile(...)`.
 *      b. Spawn a transient Vite dev server with the plugin enabled, point
 *         it at the rewritten example, wait for capture.
 *      c. Vite build → static output. Serve, screenshot.
 *      d. Compare against the baseline (full bundle, no precompile).
 *   3. Categorise failures into the buckets from EXPERIMENT_SUMMARY.md.
 *
 * Usage:
 *
 *   node packages/examples/batch/run.mjs --three-repo=../../three.js \
 *     [--filter=<substr>] [--limit=<n>] [--offset=<n>]
 *
 * Notes for the contributor implementing this:
 *
 *   - Vite-per-example is heavyweight; consider using a single Vite dev
 *     server with multiple virtual entry points and switching the active
 *     example by URL.
 *   - The ported `tsl-precompile-demo/shared/batch-precompile.mjs` does the
 *     monolithic-slim equivalent — read that file (referenced below) for
 *     the screenshot + diff logic. We reuse the diff thresholds.
 *   - Skip list mirrors the original: webxr_*, ar_*, vr_*, xr_*,
 *     webgpu_compile_async, webgpu_tsl_precompile (our own).
 *
 * @module BatchHarness
 */

import { readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = process.argv.slice( 2 );
function getArg( prefix, def ) {

	const a = args.find( ( x ) => x.startsWith( prefix ) );
	return a ? a.slice( prefix.length ) : def;

}

const threeRepo = resolve( getArg( '--three-repo=', '../../../three.js' ) );
const filter = getArg( '--filter=', '' );
const limit = parseInt( getArg( '--limit=', '9999' ), 10 );
const offset = parseInt( getArg( '--offset=', '0' ), 10 );

const examplesDir = join( threeRepo, 'examples' );
if ( ! existsSync( examplesDir ) ) {

	console.error( `[batch] three.js examples not found at ${ examplesDir }. Pass --three-repo=<path>` );
	process.exit( 2 );

}

const SKIP = [
	'webxr_', 'vr_', 'ar_', 'webgpu_xr_', 'webgpu_webxr_',
	'webgpu_compile_async',
	'webgpu_tsl_precompile',
];

const examples = readdirSync( examplesDir )
	.filter( ( f ) => f.startsWith( 'webgpu_' ) && f.endsWith( '.html' ) )
	.filter( ( f ) => ! filter || f.includes( filter ) )
	.filter( ( f ) => ! SKIP.some( ( s ) => f.includes( s ) ) )
	.slice( offset, offset + limit );

console.log( `[batch] discovered ${ examples.length } candidate example(s)` );

console.log( '[batch] runner not yet implemented — Phase 6 follow-up.' );
console.log( '[batch] reference implementation:' );
console.log( '  Makio64/three.js@tsl-precompile:tsl-precompile-demo/shared/batch-precompile.mjs (400 lines)' );
console.log( '[batch] example list (first 10):' );
for ( const e of examples.slice( 0, 10 ) ) console.log( '  - ' + e );

process.exit( 0 );
