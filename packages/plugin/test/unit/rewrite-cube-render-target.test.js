/**
 * Snapshot test for the CubeRenderTarget three.js-source rewrite.
 *
 * Feeds the verbatim three.js CubeRenderTarget.js into `rewriteThreeSource`
 * and asserts structural properties of the output:
 *
 *   a. `new NodeMaterial()` has been replaced with `new PrecompiledMaterial(loadAux(...))`.
 *   b. `loadAux('cube-render-target', ...)` appears with a `hashNodeGraphSync(uvNode, ...)` argument.
 *   c. The `material.colorNode = TSL_Texture(...)` assignment is gone.
 *   d. Unused imports from `../../nodes/utils/EquirectUVNode.js` etc. are dropped
 *      (only if unused after rewrite — `equirectUV` stays because `uvNode = equirectUV(...)` still references it).
 *   e. Runtime imports + the aux side-effect import are present.
 *   f. Output parses as valid ESM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

import { rewriteThreeSource } from '../../src/three-rewrite.js';

const HERE = dirname( fileURLToPath( import.meta.url ) );
const THREE_SRC = resolve( HERE, '../../../../node_modules/three/src' );
const CUBE_RT_PATH = resolve( THREE_SRC, 'renderers/common/CubeRenderTarget.js' );

test( 'rewrite/CubeRenderTarget: replaces new NodeMaterial with PrecompiledMaterial + loadAux', () => {

	const source = readFileSync( CUBE_RT_PATH, 'utf8' );
	const result = rewriteThreeSource( source, CUBE_RT_PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( result, 'rewriteThreeSource should return a non-null result' );
	assert.equal( result.warning, null, `expected no warning, got: ${ result.warning }` );

	const out = result.code;

	// (a) no more `new NodeMaterial()`
	assert.doesNotMatch( out, /new NodeMaterial\s*\(/, 'all NodeMaterial constructions should be rewritten' );

	// (b) PrecompiledMaterial + loadAux with the right shape literal
	assert.match( out, /new PrecompiledMaterial\s*\(/ );
	assert.match( out, /loadAux\s*\(\s*["']cube-render-target["']\s*,/ );
	assert.match( out, /hashNodeGraphSync\s*\(\s*uvNode/ );

	// (c) the graph-assignment is dropped
	assert.doesNotMatch( out, /material\.colorNode\s*=/ );

	// non-graph assignments stay
	assert.match( out, /material\.side\s*=\s*BackSide/ );
	assert.match( out, /material\.blending\s*=\s*NoBlending/ );

	// (d) NodeMaterial import is gone (it's under `../../materials/nodes/...`)
	assert.doesNotMatch( out, /import\s+NodeMaterial\s+from\s+['"][^'"]*materials\/nodes\/NodeMaterial\.js['"]/ );

	// `equirectUV` is STILL used (we hash uvNode which was defined via equirectUV(...))
	assert.match( out, /equirectUV/ );

	// (e) runtime imports injected
	assert.match( out, /from ['"]@tsl-precompile\/runtime['"]/ );
	assert.match( out, /virtual:tsl-precompile\/__aux/ );

	// __tslpHashOpts constant (versions only; shape inlined at call sites)
	assert.match( out, /const __tslpHashOpts\s*=\s*\{/ );
	assert.match( out, /shape:\s*["']cube-render-target["']/ );
	assert.match( out, /threeVersion:\s*["']175["']/ );

} );

test( 'rewrite/CubeRenderTarget: output parses as valid ESM', () => {

	const source = readFileSync( CUBE_RT_PATH, 'utf8' );
	const result = rewriteThreeSource( source, CUBE_RT_PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( result && result.code );
	assert.doesNotThrow( () => parse( result.code, { sourceType: 'module', plugins: [ 'importAttributes' ] } ) );

} );

test( 'rewrite/CubeRenderTarget: shape-gate fails loudly on drift (simulated)', () => {

	// Remove the material.colorNode = ... line to simulate a three.js shape
	// that no longer matches expectations. The handler should throw and the
	// public API should return a warning, not a rewritten source.
	const source = readFileSync( CUBE_RT_PATH, 'utf8' )
		.replace( /material\.colorNode\s*=\s*TSL_Texture[^;]+;/, '' );

	const result = rewriteThreeSource( source, CUBE_RT_PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( result, 'handler should return a result even on shape drift' );
	assert.equal( result.code, null );
	assert.match( result.warning, /shape changed|shape drifted/ );

} );

test( 'rewrite/CubeRenderTarget: not-a-target file returns null (no transformation)', () => {

	const unrelated = 'export const foo = 1;';
	const result = rewriteThreeSource( unrelated, '/some/unrelated/file.js', { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.equal( result, null );

} );
