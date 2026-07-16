/**
 * Fast checked-file guard for the prebuilt slim bundle. Reviewable byte and
 * graph thresholds live in runtime/build-tools/slim-budget.json; production
 * source-profile builds run through the dedicated slim budget command.
 *
 * If the bundle hasn't been built yet, skip. `pnpm --filter @tsl-precompile/runtime build:slim`
 * produces it. `TSLP_ANALYZE=1 pnpm --filter @tsl-precompile/runtime build:slim`
 * prints the per-module size breakdown when investigating a regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const HERE = dirname( fileURLToPath( import.meta.url ) );
const checkedBuildDir = process.env.TSLP_TEST_CHECKED_SLIM_DIR
	? resolve( process.env.TSLP_TEST_CHECKED_SLIM_DIR )
	: resolve( HERE, '../../../runtime/build' );
const BUNDLE = resolve( checkedBuildDir, 'three.webgpu.slim.js' );
const BUDGET = JSON.parse( readFileSync( resolve( HERE, '../../../runtime/build-tools/slim-budget.json' ), 'utf8' ) );

const bundleExists = existsSync( BUNDLE );

test( 'slim bundle — exists after pnpm build:slim', { skip: bundleExists ? false : 'run `pnpm --filter @tsl-precompile/runtime build:slim` first' }, () => {

	assert.ok( bundleExists, `expected ${ BUNDLE }` );

} );

test( 'slim bundle — raw and gzip bytes stay within the machine budget', { skip: bundleExists ? false : 'bundle not built' }, () => {

	const raw = readFileSync( BUNDLE );
	const gz = gzipSync( raw, { level: BUDGET.gzipLevel } );
	const kb = gz.length / 1024;
	console.log( `    bundle: ${ ( raw.length / 1024 ).toFixed( 1 ) } KB raw, ${ kb.toFixed( 1 ) } KB gzip` );
	assert.equal( BUDGET.schema, 'tslp-slim-budget@1' );
	assert.ok( raw.length <= BUDGET.prebuilt.maxRawBytes, `slim bundle is ${ raw.length } raw bytes, over the ${ BUDGET.prebuilt.maxRawBytes } byte budget` );
	assert.ok( gz.length <= BUDGET.prebuilt.maxGzipBytes, `slim bundle is ${ gz.length } gzip bytes, over the ${ BUDGET.prebuilt.maxGzipBytes } byte budget` );

} );

test( 'slim bundle — exports the promised slim surface', { skip: bundleExists ? false : 'bundle not built' }, () => {

	const src = readFileSync( BUNDLE, 'utf8' );
	// Positive checks: the slim surface must export these symbols.
	assert.match( src, /WebGPURenderer/, 'slim bundle missing WebGPURenderer' );
	assert.match( src, /PrecompiledMaterial/, 'slim bundle missing PrecompiledMaterial' );
	assert.match( src, /PrecompiledComputeNode/, 'slim bundle missing PrecompiledComputeNode' );
	assert.match( src, /writeMat4|writeVec3|writeF32/, 'slim bundle missing writers' );
	assert.match( src, /__TSLP_SLIM__/, 'slim bundle missing setupPrecompile slim sentinel' );

} );

test( 'slim bundle — diagnostic report on compatibility symbol strings', { skip: bundleExists ? false : 'bundle not built' }, () => {

	// Compiler-only module IDs are a hard Rollup graph gate in
	// runtime/rollup.config.js, and the budget gate separately requires zero
	// retained Three Node/TSL modules. These names can still appear in graph-free
	// compatibility stubs or diagnostics, so print them only as size clues.
	const src = readFileSync( BUNDLE, 'utf8' );
	const fingerprints = [ 'OperatorNode', 'TempNode', 'FunctionNode', 'ContextNode' ];
	const counts = fingerprints.map( ( s ) => ( { s, n: ( src.match( new RegExp( s, 'g' ) ) || [] ).length } ) );
	for ( const { s, n } of counts ) console.log( `    ${ s }: ${ n } occurrence(s)` );

} );
