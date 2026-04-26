/**
 * Slim-bundle size guard. Phase 7 gate: the built
 * `@tsl-precompile/runtime/build/three.webgpu.slim.js` must be ≤ 300 KB gzip.
 *
 * If the bundle hasn't been built yet, skip. `pnpm --filter @tsl-precompile/runtime build:slim`
 * produces it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const HERE = dirname( fileURLToPath( import.meta.url ) );
const BUNDLE = resolve( HERE, '../../../runtime/build/three.webgpu.slim.js' );

// Phase 7 gate. Three relevant benchmarks:
//   - `three.webgpu.min.js` (0.175) ships at 145 KB gzip — our slim targets
//     beating this with a minimal API allowlist.
//   - With the compat allowlist (`export * from Three.Core.js`, 0.184)
//     we ship ~217 KB, which still beats three.webgpu.nodes.min.js.
//   - Three.js 0.184 core is larger than 0.175 core — adjust gate accordingly.
// Cap at 225 KB: catches regressions, accommodates three-version churn.
const GATE_KB = 225;

const bundleExists = existsSync( BUNDLE );

test( 'slim bundle — exists after pnpm build:slim', { skip: bundleExists ? false : 'run `pnpm --filter @tsl-precompile/runtime build:slim` first' }, () => {

	assert.ok( bundleExists, `expected ${ BUNDLE }` );

} );

test( 'slim bundle — gzip size ≤ 300 KB (Phase 7 gate)', { skip: bundleExists ? false : 'bundle not built' }, () => {

	const raw = readFileSync( BUNDLE );
	const gz = gzipSync( raw, { level: 9 } );
	const kb = gz.length / 1024;
	console.log( `    bundle: ${ ( raw.length / 1024 ).toFixed( 1 ) } KB raw, ${ kb.toFixed( 1 ) } KB gzip` );
	assert.ok( kb <= GATE_KB, `slim bundle is ${ kb.toFixed( 1 ) } KB gzip, over the ${ GATE_KB } KB gate. Check for node-builder leakage via grep NodeBuilder.` );

} );

test( 'slim bundle — exports the promised slim surface', { skip: bundleExists ? false : 'bundle not built' }, () => {

	const src = readFileSync( BUNDLE, 'utf8' );
	// Positive checks: the slim surface must export these symbols.
	assert.match( src, /WebGPURenderer/, 'slim bundle missing WebGPURenderer' );
	assert.match( src, /PrecompiledMaterial/, 'slim bundle missing PrecompiledMaterial' );
	assert.match( src, /PrecompiledComputeNode/, 'slim bundle missing PrecompiledComputeNode' );
	assert.match( src, /writeMat4|writeVec3|writeF32/, 'slim bundle missing writers' );

} );

test( 'slim bundle — diagnostic report on node-builder residue', { skip: bundleExists ? false : 'bundle not built' }, () => {

	// Diagnostic only — NOT a hard gate. Fully stripping the node builder
	// would require aliasing `three/src/nodes/**` to empty shims, which
	// currently breaks WebGPURenderer's internal dispatch. This reports
	// residual fingerprints so future tree-shake work has a measurable
	// baseline. The real gate is the 300KB gzip size check above.
	const src = readFileSync( BUNDLE, 'utf8' );
	const fingerprints = [ 'OperatorNode', 'TempNode', 'FunctionNode', 'ContextNode' ];
	const counts = fingerprints.map( ( s ) => ( { s, n: ( src.match( new RegExp( s, 'g' ) ) || [] ).length } ) );
	for ( const { s, n } of counts ) console.log( `    ${ s }: ${ n } occurrence(s)` );

} );
