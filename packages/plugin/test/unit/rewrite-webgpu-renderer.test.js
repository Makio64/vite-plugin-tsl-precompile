/**
 * Snapshot tests for the WebGPURenderer.js three.js-source rewrite.
 *
 * This is the load-bearing patch — swapping `StandardNodeLibrary` for the
 * base `NodeLibrary` eliminates the ≈100 KB barrel of `*NodeMaterial` +
 * `*LightNode` + tone-mapping-TSL imports that otherwise anchor the full
 * node builder inside the slim bundle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';

import { rewriteThreeSource } from '../../src/three-rewrite.js';
import { THREE_SRC } from '../_three-src.js';
const PATH = resolve( THREE_SRC, 'renderers/webgpu/WebGPURenderer.js' );

test( 'rewrite/WebGPURenderer: swaps StandardNodeLibrary import for NodeLibrary + drops WebGL fallback', () => {

	const src = readFileSync( PATH, 'utf8' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r, 'handler should return a result' );
	assert.equal( r.warning, null, `expected no warning; got: ${ r.warning }` );

	const out = r.code;

	// Library swap.
	assert.doesNotMatch( out, /import\s+StandardNodeLibrary\s+from/ );
	assert.match( out, /import\s+NodeLibrary\s+from\s+["'][^"']*\/common\/nodes\/NodeLibrary\.js["']/ );
	assert.doesNotMatch( out, /new StandardNodeLibrary\s*\(/ );
	assert.match( out, /new NodeLibrary\s*\(\s*\)/ );

	// WebGL fallback is gone: no import, no construction, no getFallback wiring.
	assert.doesNotMatch( out, /import\s+WebGLBackend\s+from/ );
	assert.doesNotMatch( out, /parameters\.getFallback\s*=/ );

} );

test( 'rewrite/WebGPURenderer: output parses as valid ESM', () => {

	const src = readFileSync( PATH, 'utf8' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r && r.code );
	assert.doesNotThrow( () => parse( r.code, { sourceType: 'module', plugins: [ 'importAttributes' ] } ) );

} );

test( 'rewrite/WebGPURenderer: shape-gate fails loudly when import shape drifts', () => {

	// Remove the StandardNodeLibrary import line to simulate shape drift.
	const src = readFileSync( PATH, 'utf8' )
		.replace( /import\s+StandardNodeLibrary\s+from[^;]+;\n/, '' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r );
	assert.equal( r.code, null );
	assert.match( r.warning, /shape changed/ );

} );
