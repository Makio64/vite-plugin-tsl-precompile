/**
 * Snapshot tests for the Nodes.js + WebGPUBackend.js rewrites — the pair
 * that makes `WGSLNodeBuilder` dead code once activated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';
import _generate from '@babel/generator';

import { rewriteThreeSource } from '../../src/three-rewrite.js';
import { THREE_SRC, THREE_R185_SRC } from '../_three-src.js';
const NODES_PATH = resolve( THREE_SRC, 'renderers/common/nodes/NodeManager.js' );
const BACKEND_PATH = resolve( THREE_R185_SRC, 'renderers/webgpu/WebGPUBackend.js' );
const WEBGL_BACKEND_PATH = resolve( THREE_SRC, 'renderers/webgl-fallback/WebGLBackend.js' );
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
	// Tier C: the fourth argument carries the live RenderObject for semantic
	// topology selection plus the private cache key for unsigned legacy
	// artifacts.
	assert.match( out, /hydrateNodeBuilderState\s*\(\s*material\.precompiledArtifact\s*,\s*material\s*,\s*renderObject\.object\s*,\s*\{/ );
	assert.match( out, /cacheKey:\s*typeof\s+this\.getForRenderCacheKey/ );
	assert.match( out, /renderObject:\s*renderObject/ );
	assert.match( out, /this\.getForRenderCacheKey\(\s*renderObject\s*\)/ );
	assert.match( out, /computeNode\.isPrecompiledCompute/ );
	assert.match( out, /hydrateNodeBuilderState\s*\(\s*computeNode\.precompiledArtifact/ );

	// The render helper is guarded before it can call the backend builder.
	assert.match( out, /only PrecompiledMaterial is supported in the slim bundle/ );
	assert.match( out, /only PrecompiledComputeNode is supported in the slim bundle/ );

	// Hydration and fallback import their exact private owners.
	assert.match( out, /import\s*\{\s*hydrateNodeBuilderState\s*\}\s*from\s*["']virtual:tsl-precompile\/__slim-rewrite-runtime\/hydrator["']/ );
	assert.match( out, /import\s*\{\s*getSlimRenderFallback\s*\}\s*from\s*["']virtual:tsl-precompile\/__slim-rewrite-runtime\/render-fallback-registry["']/ );
	assert.doesNotMatch( out, /@tsl-precompile\/runtime['"]/ );

	// A slim hydration failure cannot recover through the compiler: the
	// backend builder is deliberately absent. Keep NodeFrame for live updater
	// scheduling, but sever the broad node barrel and generic NodeMaterial
	// fallback completely.
	assert.doesNotMatch( out, /new NodeMaterial\s*\(/ );
	assert.doesNotMatch( out, /materials\/nodes\/NodeMaterial\.js/ );
	assert.doesNotMatch( out, /nodes\/Nodes\.js/ );
	assert.match( out, /nodes\/core\/NodeFrame\.js/ );
	assert.match( out, /nodes\/core\/constants\.js/ );
	assert.match( out, /NodeUpdateType/ );
	assert.doesNotMatch( out, /new StackTrace\s*\(/ );

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
	assert.doesNotMatch( out, /currentBindingGroups\.length\s*=\s*0/ );
	assert.match( out, /currentBindingGroups\[i\] !== bindingsData\.group/ );
	assert.match( out, /this\.createBindings\(bindGroup, bindings, 0\)/ );
	assert.match( out, /const bindingData = this\.get\(binding\)/ );
	assert.match( out, /bindingData\.buffer === undefined/ );
	assert.match( out, /this\.createUniformBuffer\(binding\)/ );
	assert.match( out, /bindingData\.sampler === undefined/ );
	assert.match( out, /this\.updateSampler\(binding\)/ );
	assert.doesNotMatch( out, /this\.updateSampler\(texture\)/ );
	assert.match( out, /cameraIndex &&/ );
	assert.match( out, /__tslpPreservedBindingGroups/ );
	assert.doesNotMatch( out, /__slim-rewrite-runtime\//, 'pure backend rewrite must not add a runtime edge' );

} );

test( 'rewrite/WebGPUBackend.js: output parses as valid ESM', () => {

	const src = readFileSync( BACKEND_PATH, 'utf8' );
	const r = rewriteThreeSource( src, BACKEND_PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r && r.code );
	assert.doesNotThrow( () => parse( r.code, { sourceType: 'module', plugins: [ 'importAttributes' ] } ) );

} );

test( 'rewrite/WebGLBackend.js: retains the backend and strips only GLSLNodeBuilder', () => {

	const src = readFileSync( WEBGL_BACKEND_PATH, 'utf8' );
	const r = rewriteThreeSource( src, WEBGL_BACKEND_PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r, 'handler should return a result' );
	assert.equal( r.warning, null, `expected no warning; got: ${ r.warning }` );

	const out = r.code;
	assert.doesNotMatch( out, /import\s+GLSLNodeBuilder\s+from/ );
	assert.doesNotMatch( out, /new GLSLNodeBuilder\s*\(/ );
	assert.match( out, /createNodeBuilder\s*\([^)]*\)\s*\{[\s\S]*GLSLNodeBuilder is stripped from the slim bundle/ );
	assert.match( out, /this\.isWebGLBackend\s*=\s*true/ );
	assert.match( out, /createRenderPipeline\s*\(/ );
	assert.doesNotMatch( out, /__slim-rewrite-runtime\//, 'pure backend rewrite must not add a runtime edge' );

} );

test( 'rewrite/WebGLBackend.js: output parses as valid ESM', () => {

	const src = readFileSync( WEBGL_BACKEND_PATH, 'utf8' );
	const r = rewriteThreeSource( src, WEBGL_BACKEND_PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
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

function rewrittenBackend( source = readFileSync( BACKEND_PATH, 'utf8' ) ) {

	const result = rewriteThreeSource( source, BACKEND_PATH, { threeVersion: '185', pluginVersion: '0.0.0' } );
	assert.equal( result.warning, null );
	const ast = parse( result.code, { sourceType: 'module' } );
	return ast.program.body.find( ( node ) => node.type === 'ClassDeclaration' && node.id.name === 'WebGPUBackend' );

}

function backendHarness( source ) {

	const generate = _generate.default || _generate;
	const backend = rewrittenBackend( source );
	const method = backend.body.body.find( ( node ) => node.key?.name === '_draw' );
	// Execute the complete rewritten draw method, with GPU calls recorded.
	const draw = new Function( `return ({ ${ generate( method ).code } })._draw;` )();
	const data = new Map();
	const calls = [];
	const owner = {
		get( key ) { if ( ! data.has( key ) ) data.set( key, {} ); return data.get( key ); },
		createBindings( group ) { this.get( group ).group = {}; },
		createUniformBuffer( binding ) { this.get( binding ).buffer = {}; },
	};
	const encoder = { setPipeline() {}, setBindGroup( ...args ) { calls.push( args ); }, draw() {} };
	const renderObject = { object: {}, material: {}, context: {}, getIndex: () => null, getIndirect: () => null };
	const pipeline = {};
	return {
		backend, data, owner, encoder, calls,
		draw( bindings, sets ) {
			draw.call( owner, renderObject, { update() {} }, {}, pipeline, bindings, [], {}, encoder, sets );
		},
	};

}

test( 'rewrite/WebGPUBackend: repeated groups skip commands; replaced GPU resources and fresh passes rebind', () => {

	const h = backendHarness();
	const groups = [ { id: 1, bindings: [ { isUniformBuffer: true } ] }, { id: 2, bindings: [] } ];
	const sets = { bindingGroups: [], attributes: {} };
	h.draw( groups, sets );
	assert.equal( h.calls.length, 2 );
	h.draw( groups, sets );
	assert.equal( h.calls.length, 2, 'same resources produce no extra commands' );
	const replacement = {};
	h.owner.get( groups[ 0 ] ).group = replacement;
	h.draw( groups, sets );
	assert.deepEqual( h.calls.at( -1 ), [ 0, replacement ] );
	assert.equal( h.calls.length, 3, 'same CPU id with changed GPU resource must rebind' );
	delete h.owner.get( groups[ 0 ] ).group;
	h.draw( groups, sets );
	assert.equal( h.calls.length, 4, 'disposed group is re-created and bound' );
	h.draw( groups, { bindingGroups: [], attributes: {} } );
	assert.equal( h.calls.length, 6, 'fresh pass or bundle starts with empty state' );
	h.draw( groups.toReversed(), sets );
	assert.equal( h.calls.length, 8, 'cache follows slots, not a global set of groups' );

} );

test( 'rewrite/WebGPUBackend: ArrayCamera manual native group survives exactly its own draw', () => {

	const h = backendHarness();
	const generate = _generate.default || _generate;
	let manualStatements;
	function visit( node ) {

		if ( ! node || typeof node !== 'object' ) return;
		if ( Array.isArray( node ) ) {

			const index = node.findIndex( ( statement ) => statement?.type === 'ExpressionStatement' && generate( statement ).code.startsWith( 'sets.bindingGroups[indexPos] =' ) );
			if ( index >= 0 ) manualStatements = node.slice( index - 1, index + 3 );
			for ( const child of node ) visit( child );

		} else for ( const [ key, child ] of Object.entries( node ) ) if ( key !== 'loc' ) visit( child );

	}
	visit( h.backend.body.body.find( ( node ) => node.key?.name === 'draw' ) );
	assert.equal( manualStatements?.length, 4 );
	const manual = new Function( 'sets', 'pass', 'cameraData', 'i', 'indexPos', 'cameraIndex', manualStatements.map( ( node ) => generate( node ).code ).join( '\n' ) );
	const sets = { bindingGroups: [], attributes: {} };
	const cameraIndex = { id: 42, bindings: [] };
	const cameras = { indexesGPU: [ {}, {} ] };
	for ( let i = 0; i < 2; i ++ ) {

		manual( sets, h.encoder, cameras, i, 0, cameraIndex );
		h.draw( [ cameraIndex ], sets );
		assert.equal( h.calls.length, i + 1 );
		assert.equal( sets.bindingGroups[ 0 ], cameras.indexesGPU[ i ] );

	}
	h.draw( [ cameraIndex ], sets );
	assert.equal( h.calls.length, 3, 'next ordinary draw replaces the camera override' );
	assert.equal( sets.bindingGroups[ 0 ], h.owner.get( cameraIndex ).group );
	manual( sets, h.encoder, cameras, 0, 0, cameraIndex );
	h.draw( [ { id: 99, bindings: [] } ], sets );
	assert.equal( h.calls.length, 5, 'override never suppresses a different group at the same slot' );

} );

test( 'rewrite/WebGPUBackend: retains the r184 lookup and sampler ownership shape', () => {

	const source = readFileSync( BACKEND_PATH, 'utf8' )
		.replace( /if \( currentBindingGroups\[ i \] !== bindGroup.id \) \{\s*const bindingsData = this.get\( bindGroup \);/, 'const bindingsData = this.get( bindGroup );\nif ( currentBindingGroups[ i ] !== bindGroup.id ) {' )
		.replace( /updateSampler\( binding \) \{\s*return this.textureUtils.updateSampler\( binding \);/, 'updateSampler( texture ) { return this.textureUtils.updateSampler( texture );' );
	const h = backendHarness( source );
	const group = { id: 1, bindings: [] };
	const sets = { bindingGroups: [], attributes: {} };
	h.draw( [ group ], sets );
	h.draw( [ group ], sets );
	assert.equal( h.calls.length, 1 );
	h.owner.get( group ).group = {};
	h.draw( [ group ], sets );
	assert.equal( h.calls.length, 2 );

} );

test( 'rewrite/WebGPUBackend: cache assignment drift fails closed', () => {

	const source = readFileSync( BACKEND_PATH, 'utf8' ).replace( 'currentBindingGroups[ i ] = bindGroup.id;', 'currentBindingGroups[ i ] = bindGroup.version;' );
	const result = rewriteThreeSource( source, BACKEND_PATH, { threeVersion: '185' } );
	assert.equal( result.code, null );
	assert.match( result.warning, /bind group cache assignment/ );

} );
