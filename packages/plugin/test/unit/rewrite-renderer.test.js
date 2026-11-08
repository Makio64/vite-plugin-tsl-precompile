/**
 * Snapshot tests for the Renderer.js three.js-source rewrite.
 *
 * Expected rewrite:
 *   - Construction `new QuadMesh(new NodeMaterial())` becomes
 *     `new QuadMesh(new Material())`.
 *   - Output cache/material ownership delegates to the graph-free replay
 *     adapter, including sampled texture topology and safe disposal.
 *   - Renderer context identity and high-precision state delegate to a
 *     graph-free replay carrier.
 *   - Shadow overrides retain the exact caster through a stable per-caster
 *     replay material without changing callback-visible material identity.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';

import { rewriteThreeSource } from '../../src/three-rewrite.js';
import { THREE_R185_SRC } from '../_three-src.js';
const PATH = resolve( THREE_R185_SRC, 'renderers/common/Renderer.js' );

function replayCompilationLoop() {

	const result = rewriteThreeSource( readFileSync( PATH, 'utf8' ), PATH, { threeVersion: '185', pluginVersion: '0.1.0' } );
	assert.equal( result.warning, null );
	const ast = parse( result.code, { sourceType: 'module' } );
	const renderer = ast.program.body.find( node => node.type === 'ClassDeclaration' && node.id.name === 'Renderer' );
	const body = renderer.body.body.find( node => node.key?.name === 'compileAsync' ).body.body;
	const start = body.find( node => node.type === 'VariableDeclaration' && node.declarations[ 0 ].id.name === 'compileYieldDeadline' );
	const end = body.at( -1 );
	return new ( Object.getPrototypeOf( async function () {} ).constructor )( 'compilationPromises', 'yieldToMain', 'performance', result.code.slice( start.start, end.end ) );

}

test( 'rewrite/Renderer compileAsync batches cheap replay objects within a four millisecond yield budget', async () => {

	const compile = replayCompilationLoop();
	let now = 0;
	const yielded = [], events = [];
	const items = Array.from( { length: 10 }, ( _, id ) => ( { object: { id, geometry: { drawRange: { start: id } } }, group: { id } } ) );
	const owner = {
		_objects: { get( object ) { return { object }; } },
		_nodes: {
			getForRender( ro ) { assert.equal( ro.drawRange, ro.object.geometry.drawRange ); assert.equal( ro.group, items[ ro.object.id ].group ); events.push( [ ro.object.id, 'hydrate' ] ); },
			updateBefore( ro ) { events.push( [ ro.object.id, 'before' ] ); },
			updateForRender( ro ) { events.push( [ ro.object.id, 'uniforms' ] ); },
			updateAfter( ro ) { events.push( [ ro.object.id, 'after' ] ); },
		},
		_geometries: { updateForRender() { now ++; } },
		_bindings: { updateForRender() {} },
		_pipelines: { getForRender( ro, promises ) { assert.deepEqual( promises, [] ); events.push( [ ro.object.id, 'pipeline' ] ); } },
	};
	await compile.call( owner, items, async () => { yielded.push( now ); }, { now: () => now } );
	assert.deepEqual( yielded, [ 4, 8 ], 'reused pipelines do not force one scheduler/RAF yield per object' );
	assert.deepEqual( events, items.flatMap( ( { object } ) => [ 'hydrate', 'before', 'uniforms', 'pipeline', 'after' ].map( stage => [ object.id, stage ] ) ) );

} );

test( 'rewrite/Renderer compileAsync retains native pipeline dependency and error barriers', async () => {

	const compile = replayCompilationLoop();
	const first = Promise.withResolvers(), second = Promise.withResolvers(), startedSecond = Promise.withResolvers();
	const events = [];
	const items = [ 0, 1 ].map( id => ( { object: { id, geometry: {} } } ) );
	const owner = {
		_objects: { get( object ) { return { object }; } },
		_nodes: {
			getForRender( ro ) { events.push( `hydrate${ ro.object.id }` ); },
			updateBefore() {}, updateForRender() {},
			updateAfter( ro ) { events.push( `after${ ro.object.id }` ); },
		},
		_geometries: { updateForRender() {} }, _bindings: { updateForRender() {} },
		_pipelines: { getForRender( ro, promises ) {

			promises.push( ro.object.id === 0 ? first.promise : second.promise );
			if ( ro.object.id === 1 ) startedSecond.resolve();

		} },
	};
	const pending = compile.call( owner, items, async () => {}, { now: () => 0 } );
	assert.deepEqual( events, [ 'hydrate0' ] );
	first.resolve();
	await startedSecond.promise;
	assert.deepEqual( events, [ 'hydrate0', 'after0', 'hydrate1' ] );
	const error = new Error( 'native pipeline failed' );
	second.reject( error );
	await assert.rejects( pending, value => value === error );
	assert.deepEqual( events, [ 'hydrate0', 'after0', 'hydrate1' ] );

} );

for ( const replacement of [ 'await this._nodes.getForRenderAsync( item );', 'await this._nodes.getForRenderDeferred( renderObject );' ] ) {

	test( `rewrite/Renderer rejects changed async hydration: ${ replacement }`, () => {

		const source = readFileSync( PATH, 'utf8' ).replace( 'await this._nodes.getForRenderAsync( renderObject );', replacement );
		const result = rewriteThreeSource( source, PATH, { threeVersion: '185', pluginVersion: '0.1.0' } );
		assert.equal( result.code, null );
		assert.match( result.warning, /compileAsync work loop shape changed/ );

	} );

}

test( 'rewrite/Renderer schedules captured shadows before the main scene and after initialization', () => {

	const result = rewriteThreeSource( readFileSync( PATH, 'utf8' ), PATH, { threeVersion: '185', pluginVersion: '0.1.0' } );
	assert.equal( result.warning, null );
	const ast = parse( result.code, { sourceType: 'module' } );
	const rendererClass = ast.program.body.find( node => node.type === 'ClassDeclaration' && node.id.name === 'Renderer' );
	const body = rendererClass.body.body.find( node => node.key?.name === 'render' ).body;
	const render = new Function( 'scene', 'camera', result.code.slice( body.start + 1, body.end - 1 ) );
	const events = [];
	const scene = {}, camera = {};
	const owner = {
		_initialized: false,
		_nodes: { renderShadows( input, view ) { assert.equal( input, scene ); assert.equal( view, camera ); events.push( 'shadows' ); } },
		_renderScene() { events.push( 'scene' ); },
	};
	assert.throws( () => render.call( owner, scene, camera ), /before the backend is initialized/ );
	assert.deepEqual( events, [] );
	owner._initialized = true;
	render.call( owner, scene, camera );
	assert.deepEqual( events, [ 'shadows', 'scene' ] );

} );

test( 'rewrite/Renderer releases replay targets before backend sampler caches', () => {

	const result = rewriteThreeSource( readFileSync( PATH, 'utf8' ), PATH, { threeVersion: '185', pluginVersion: '0.1.0' } );
	assert.equal( result.warning, null );
	const ast = parse( result.code, { sourceType: 'module' } );
	const rendererClass = ast.program.body.find( node => node.type === 'ClassDeclaration' && node.id.name === 'Renderer' );
	const body = rendererClass.body.body.find( node => node.key?.name === 'dispose' ).body;
	const dispose = new Function( result.code.slice( body.start + 1, body.end - 1 ) );
	const events = [];
	const owner = {
		_initialized: true,
		backend: { dispose() { events.push( 'backend' ); }, timestampQueryPool: {} },
		_nodes: { disposeRendererResources() { events.push( 'resources' ); }, dispose() { events.push( 'nodes' ); } },
		_frameBufferTargets: new Map(),
		setRenderTarget() {},
		setAnimationLoop() {},
	};
	for ( const key of [ 'info', '_animation', '_objects', '_geometries', '_pipelines', '_bindings', '_renderLists', '_renderContexts', '_textures' ] ) owner[ key ] = { dispose() {} };
	dispose.call( owner );
	assert.deepEqual( events, [ 'resources', 'backend', 'nodes' ] );

} );

test( 'rewrite/Renderer: NodeMaterial replaced with Material sentinel + fragmentNode swap', () => {

	const src = readFileSync( PATH, 'utf8' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r, 'handler should return a result' );
	assert.equal( r.warning, null, `expected no warning; got: ${ r.warning }` );

	const out = r.code;
	assert.doesNotMatch( out, /new NodeMaterial\s*\(/ );
	assert.match( out, /new QuadMesh\s*\(\s*new Material\s*\(\s*\)\s*\)/ );
	assert.doesNotMatch( out, /common\/nodes\/NodeLibrary\.js/ );
	assert.match( out, /import\s+ReplayNodeLibrary\s+from\s+["']virtual:tsl-precompile\/__slim-rewrite-runtime\/node-library["']/ );
	assert.match( out, /this\.library\s*=\s*new ReplayNodeLibrary\s*\(\s*\)/ );
	assert.match( out, /\.material\s*=\s*createReplayRenderOutputMaterial\s*\(/ );
	assert.match( out, /getReplayRenderOutputCacheKey\s*\(\s*this\s*,\s*renderTarget\.texture\s*\)/ );
	assert.match( out, /renderTarget\.texture/ );
	assert.doesNotMatch( out, /this\._nodes\.getOutputNode/ );
	assert.doesNotMatch( out, /this\._nodes\.getOutputCacheKey/ );
	assert.match( out, /material\s*=\s*createReplayShadowMaterial\s*\(\s*overrideMaterial\s*,\s*material\s*\)/ );
	assert.match( out, /getReplayRenderCallbackMaterial\s*\(\s*material\s*\)/ );
	assert.doesNotMatch( out, /_getShadowNodes|_cacheShadowNodes/ );
	assert.doesNotMatch( out, /overrideMaterial\.(?:colorNode|depthNode|positionNode)\s*=\s*(?:colorNode|depthNode|positionNode)/ );
	assert.match( out, /material\.castShadowNode\s*&&\s*material\.castShadowNode\.isNode/ );
	assert.match( out, /shadowMap\.transmitted\s*!==\s*true/ );
	assert.match( out, /shadowMap\.transmitted.*material\.castShadowNode/ );
	assert.match( out, /this\.shadowMap\.type\s*===\s*VSMShadowMap/ );
	assert.match( out, /_shadowSide\s*\[\s*material\.side\s*\]/ );

	// Original fragmentNode assignment LHS should be gone.
	assert.doesNotMatch( out, /\.material\.fragmentNode\s*=/ );

	// Material import added (named specifier, matches three's named export).
	assert.match( out, /import\s*\{[^}]*\bMaterial\b[^}]*\}\s*from\s*["'][^"']*\/Material\.js["']/ );

	// Renderer output imports only its exact replay owner.
	assert.match( out, /import\s*\{[^}]*getReplayRenderOutputCacheKey[^}]*createReplayRenderOutputMaterial[^}]*\}\s*from\s*["']virtual:tsl-precompile\/__slim-rewrite-runtime\/renderer-output["']/ );
	assert.doesNotMatch( out, /@tsl-precompile\/runtime['"]/ );
	assert.doesNotMatch( out, /__slim-rewrite-runtime\/render-pipeline/ );
	assert.doesNotMatch( out, /virtual:tsl-precompile\/__aux/ );

	// Renderer cache identity and high-precision selection no longer retain
	// ContextNode or the highp ModelNode graph in compiler-free replay.
	assert.match( out, /this\.contextNode\s*=\s*createReplayRendererContext\s*\(\s*\)/ );
	assert.match( out, /setReplayRendererHighPrecision\s*\(\s*this\s*,\s*value\s*\)/ );
	assert.match( out, /return getReplayRendererHighPrecision\s*\(\s*this\s*\)/ );
	assert.match( out, /from\s*["']virtual:tsl-precompile\/__slim-rewrite-runtime\/renderer-context["']/ );
	assert.match( out, /import\s*\{[^}]*createReplayShadowMaterial[^}]*getReplayRenderCallbackMaterial[^}]*\}\s*from\s*["']virtual:tsl-precompile\/__slim-rewrite-runtime\/shadow-material["']/ );
	assert.doesNotMatch( out, /nodes\/core\/ContextNode\.js/ );
	assert.doesNotMatch( out, /\bhighpModel(?:Normal)?ViewMatrix\b/ );
	assert.doesNotMatch( out, /nodes\/tsl\/TSLCore\.js/ );
	assert.doesNotMatch( out, /nodes\/accessors\/ReferenceNode\.js/ );

} );

const SHADOW_CUT_DRIFTS = [
	{
		name: '_getShadowNodes method',
		mutate: ( source ) => source.replace( '_getShadowNodes( material ) {', '_collectShadowNodes( material ) {' ),
	},
	{
		name: '_cacheShadowNodes initializer',
		mutate: ( source ) => source.replace( 'this._cacheShadowNodes = new WeakMap();', 'this._cacheShadowNodes = new Map();' ),
	},
	{
		name: '_getShadowNodes call',
		mutate: ( source ) => source.replace(
			'const { colorNode, depthNode, positionNode } = this._getShadowNodes( material );',
			'const { colorNode, depthNode, positionNode } = this._getShadowNodes( scene.overrideMaterial );',
		),
	},
	{
		name: 'shadow-node assignment',
		mutate: ( source ) => source.replace( 'overrideMaterial.colorNode = colorNode;', 'overrideMaterial.colorNode = material.colorNode;' ),
	},
	{
		name: 'shadow transmission warning',
		mutate: ( source ) => source.replace(
			'Renderer: `shadowMap.transmitted` needs to be set to `true` when using `material.castShadowNode`.',
			'Renderer: shadow transmission warning changed.',
		),
	},
];

for ( const drift of SHADOW_CUT_DRIFTS ) test( `rewrite/Renderer: shape-gate fails when ${ drift.name } drifts`, () => {

	const src = drift.mutate( readFileSync( PATH, 'utf8' ) );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r );
	assert.equal( r.code, null );
	assert.match( r.warning, /shadow|_getShadowNodes|_cacheShadowNodes|shape changed/ );

} );

test( 'rewrite/Renderer: shape-gate fails loudly when shadow override handoff drifts', () => {

	const src = readFileSync( PATH, 'utf8' )
		.replace( 'material = overrideMaterial;', 'material = scene.overrideMaterial;' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r );
	assert.equal( r.code, null );
	assert.match( r.warning, /shadow override handoff|shape changed/ );

} );

test( 'rewrite/Renderer: shape-gate fails loudly when onAfterRender material identity drifts', () => {

	const src = readFileSync( PATH, 'utf8' )
		.replace(
			'object.onAfterRender( this, scene, camera, geometry, material, group );',
			'object.onAfterRender( this, scene, camera, geometry, scene.overrideMaterial, group );',
		);
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r );
	assert.equal( r.code, null );
	assert.match( r.warning, /onAfterRender callback|shape changed/ );

} );

test( 'rewrite/Renderer: output parses as valid ESM', () => {

	const src = readFileSync( PATH, 'utf8' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r && r.code );
	assert.doesNotThrow( () => parse( r.code, { sourceType: 'module', plugins: [ 'importAttributes' ] } ) );

} );

test( 'rewrite/Renderer: shape-gate fails loudly when late assignment is missing', () => {

	// Strip the fragmentNode assignment line to simulate shape drift.
	const src = readFileSync( PATH, 'utf8' )
		.replace( /quad\.material\.fragmentNode\s*=[^;]+;/g, '' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r );
	assert.equal( r.code, null );
	assert.match( r.warning, /shape changed/ );

} );

test( 'rewrite/Renderer: shape-gate fails loudly when renderer context construction drifts', () => {

	const src = readFileSync( PATH, 'utf8' )
		.replace( 'this.contextNode = context();', 'this.contextNode = null;' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r );
	assert.equal( r.code, null );
	assert.match( r.warning, /contextNode.*shape changed|shape changed.*contextNode/ );

} );

test( 'rewrite/Renderer: shape-gate fails loudly when highPrecision semantics drift', () => {

	const src = readFileSync( PATH, 'utf8' )
		.replace(
			'contextNodeData.modelViewMatrix = highpModelViewMatrix;',
			'contextNodeData.modelViewMatrix = null;',
		);
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r );
	assert.equal( r.code, null );
	assert.match( r.warning, /highPrecision setter shape changed/ );

} );

test( 'rewrite/Renderer: ignores unrelated highPrecision accessors', () => {

	const src = readFileSync( PATH, 'utf8' ) + '\nclass ForeignPrecision { set highPrecision(value) { this.value = value; } get highPrecision() { return "foreign"; } }\n';
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r && r.code );
	assert.match( r.code, /class ForeignPrecision/ );
	assert.match( r.code, /return ["']foreign["']/ );
	assert.match( r.code, /this\.value\s*=\s*value/ );

} );
