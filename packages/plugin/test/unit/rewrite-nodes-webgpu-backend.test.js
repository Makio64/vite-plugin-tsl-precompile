/**
 * Snapshot tests for the Nodes.js + WebGPUBackend.js rewrites — the pair
 * that makes `WGSLNodeBuilder` dead code once activated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';

import { rewriteThreeSource } from '../../src/three-rewrite.js';
import { THREE_SRC } from '../_three-src.js';
const NODES_PATH = resolve( THREE_SRC, 'renderers/common/nodes/NodeManager.js' );
const BACKEND_PATH = resolve( THREE_SRC, 'renderers/webgpu/WebGPUBackend.js' );
const PIPELINE_UTILS_PATH = resolve( THREE_SRC, 'renderers/webgpu/utils/WebGPUPipelineUtils.js' );

test( 'rewrite/Nodes.js: getForRender bypasses createNodeBuilder for precompiled materials', () => {

	const src = readFileSync( NODES_PATH, 'utf8' );
	const r = rewriteThreeSource( src, NODES_PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r, 'handler should return a result' );
	assert.equal( r.warning, null, `expected no warning; got: ${ r.warning }` );

	const out = r.code;

	// Precompile bypass appears.
	assert.match( out, /material\.isPrecompiledMaterial/ );
	assert.match( out, /hydrateNodeBuilderState\s*\(\s*material\.precompiledArtifact/ );
	assert.match( out, /hydrateNodeBuilderState\s*\(\s*material\.precompiledArtifact\s*,\s*material\s*,\s*renderObject\.object\s*\)/ );
	assert.match( out, /computeNode\.isPrecompiledCompute/ );
	assert.match( out, /hydrateNodeBuilderState\s*\(\s*computeNode\.precompiledArtifact/ );

	// The render helper is guarded before it can call the backend builder.
	assert.match( out, /only PrecompiledMaterial is supported in the slim bundle/ );
	assert.match( out, /only PrecompiledComputeNode is supported in the slim bundle/ );

	// Hydrator import from the runtime.
	assert.match( out, /import\s*\{[^}]*hydrateNodeBuilderState[^}]*\}\s*from\s*["']@tsl-precompile\/runtime["']/ );

} );

test( 'rewrite/Nodes.js: output parses as valid ESM', () => {

	const src = readFileSync( NODES_PATH, 'utf8' );
	const r = rewriteThreeSource( src, NODES_PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r && r.code );
	assert.doesNotThrow( () => parse( r.code, { sourceType: 'module', plugins: [ 'importAttributes' ] } ) );

} );

test( 'rewrite/WebGPUBackend.js: drops WGSLNodeBuilder import + stubs createNodeBuilder', () => {

	const src = readFileSync( BACKEND_PATH, 'utf8' );
	const r = rewriteThreeSource( src, BACKEND_PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r, 'handler should return a result' );
	assert.equal( r.warning, null, `expected no warning; got: ${ r.warning }` );

	const out = r.code;

	// WGSLNodeBuilder import removed.
	assert.doesNotMatch( out, /import\s+WGSLNodeBuilder\s+from/ );

	// createNodeBuilder now throws (no `new WGSLNodeBuilder(...)` reference).
	assert.doesNotMatch( out, /new WGSLNodeBuilder\s*\(/ );
	assert.match( out, /createNodeBuilder\s*\([^)]*\)\s*\{[\s\S]*throw new Error/ );
	assert.match( out, /if\s*\(\s*buffer === undefined\s*\)/ );
	assert.match( out, /this\.createIndexAttribute\(index\)/ );
	assert.match( out, /this\.createAttribute\(vertexBuffer\)/ );
	assert.match( out, /currentBindingGroups\.length\s*=\s*0/ );
	assert.match( out, /this\.createBindings\(bindGroup, bindings, 0\)/ );
	assert.match( out, /cameraIndex &&/ );
	assert.match( out, /__tslpPreservedBindingGroups/ );

} );

test( 'rewrite/WebGPUBackend.js: output parses as valid ESM', () => {

	const src = readFileSync( BACKEND_PATH, 'utf8' );
	const r = rewriteThreeSource( src, BACKEND_PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r && r.code );
	assert.doesNotThrow( () => parse( r.code, { sourceType: 'module', plugins: [ 'importAttributes' ] } ) );

} );

test( 'rewrite/WebGPUPipelineUtils.js: lazily creates missing bind group layouts', () => {

	const src = readFileSync( PIPELINE_UTILS_PATH, 'utf8' );
	const r = rewriteThreeSource( src, PIPELINE_UTILS_PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r, 'handler should return a result' );
	assert.equal( r.warning, null, `expected no warning; got: ${ r.warning }` );
	assert.match( r.code, /bindingsData\.layout \|\|/ );
	assert.match( r.code, /backend\.bindingUtils\.createBindingsLayout\(bindGroup\)/ );

} );
