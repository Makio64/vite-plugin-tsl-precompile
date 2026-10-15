/**
 * Runtime aux-loader — registry + lookup semantics.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	registerAuxArtifact,
	registerAuxArtifacts,
	__registerAuxArtifactsOnly,
	loadAux,
	hasAux,
	listAux,
	findAux,
	bindAuxByName,
	resolveAuxArtifactForInput,
	cloneAuxArtifactForReplay,
	setupViewportTextureClasses,
	__resetAuxRegistryForTests,
} from '../../../runtime/src/aux-loader.js';

test( 'aux-loader: register + load round-trip', () => {

	__resetAuxRegistryForTests();
	const artifact = { uniformPlan: [], vertexShader: '', fragmentShader: '' };
	registerAuxArtifact( 'background', 'abcd0123', artifact );
	assert.equal( hasAux( 'background', 'abcd0123' ), true );
	assert.equal( loadAux( 'background', 'abcd0123' ), artifact );

} );

test( 'aux-loader: miss throws with a clear diagnostic naming the shape and known hashes', () => {

	__resetAuxRegistryForTests();
	assert.throws(
		() => loadAux( 'background', 'cccc' ),
		( err ) => /no artifact for "background:cccc"/.test( err.message ) && /\(none\)/.test( err.message ),
	);

} );

test( 'aux-loader: miss falls back to the first artifact for the shape with a warning', () => {

	__resetAuxRegistryForTests();
	const artifact = { x: 1 };
	const second = { x: 2 };
	registerAuxArtifact( 'background', 'aaaa', artifact );
	registerAuxArtifact( 'background', 'bbbb', second );
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = ( message ) => warnings.push( message );
	try {

		assert.equal( loadAux( 'background', 'stub-hash' ), artifact );

	} finally {

		console.warn = originalWarn;

	}
	assert.equal( warnings.length, 1 );
	assert.match( warnings[ 0 ], /shape-compatible fallback/ );
	assert.match( warnings[ 0 ], /background:stub-hash/ );
	assert.match( warnings[ 0 ], /background:aaaa/ );

} );

test( 'aux-loader: different shapes with the same hash coexist', () => {

	__resetAuxRegistryForTests();
	const a = { kind: 'bg' };
	const b = { kind: 'pp' };
	registerAuxArtifact( 'background', 'same-hash', a );
	registerAuxArtifact( 'post-process', 'same-hash', b );
	assert.equal( loadAux( 'background', 'same-hash' ), a );
	assert.equal( loadAux( 'post-process', 'same-hash' ), b );

} );

test( 'aux-loader: render-output fragCoord divisor uses live renderer size', () => {

	__resetAuxRegistryForTests();
	const artifact = {
		materialShape: 'render-output',
		vertexShader: '',
		fragmentShader: 'nodeVar0 = textureSample( nodeUniform0, nodeUniform0_sampler, ( fragCoord.xy / object.nodeUniform1 ) );',
		uniformPlan: [ {
			name: 'object',
			slots: [
				{
					name: 'nodeUniform1',
					dtype: 'vec2',
					source: { kind: 'uniform.live', valueSnapshot: { type: 'vec2', data: [ 512, 512 ] } },
				},
			],
			orderedBindings: [ {
				type: 'ubo',
				slots: [
					{
						name: 'nodeUniform1',
						dtype: 'vec2',
						source: { kind: 'uniform.live', valueSnapshot: { type: 'vec2', data: [ 512, 512 ] } },
					},
				],
			} ],
		} ],
	};

	registerAuxArtifact( 'render-output', 'hash-ro', artifact );
	const loaded = loadAux( 'render-output', 'hash-ro' );

	assert.equal( loaded.uniformPlan[ 0 ].slots[ 0 ].source.kind, 'renderer.size' );
	assert.equal( loaded.uniformPlan[ 0 ].orderedBindings[ 0 ].slots[ 0 ].source.kind, 'renderer.size' );

} );

test( 'aux-loader: registerAuxArtifacts (bulk) + listAux', () => {

	__resetAuxRegistryForTests();
	registerAuxArtifacts( [
		{ shape: 'background', configHash: 'h1', artifact: {} },
		{ shape: 'lights', configHash: 'h2', artifact: {} },
	] );
	const list = listAux().sort( ( a, b ) => a.shape.localeCompare( b.shape ) );
	assert.equal( list.length, 2 );
	assert.equal( list[ 0 ].shape, 'background' );
	assert.equal( list[ 0 ].configHash, 'h1' );
	assert.equal( list[ 1 ].shape, 'lights' );

} );

test( 'aux-loader: named aux captures can be found and bound to a node', () => {

	__resetAuxRegistryForTests();
	const artifact = { kind: 'pp' };
	registerAuxArtifact( 'post-process', 'hash-pp', artifact, { name: 'scene-bloom' } );

	const listed = listAux();
	assert.equal( listed.length, 1 );
	assert.equal( listed[ 0 ].name, 'scene-bloom' );
	assert.equal( findAux( 'post-process', 'scene-bloom' ).configHash, 'hash-pp' );

	const node = { isNode: true };
	bindAuxByName( node, 'post-process', 'scene-bloom' );
	assert.equal( node.__tslpAuxConfigHash, 'hash-pp' );
	assert.equal( node.__tslpAuxShape, 'post-process' );

} );

test( 'aux-loader: named lookup rejects duplicate friendly names but exact hashes remain deterministic', () => {

	__resetAuxRegistryForTests();
	const first = { kind: 'first' };
	const second = { kind: 'second' };
	registerAuxArtifact( 'post-process', 'hash-a', first, { name: 'same-name' } );
	registerAuxArtifact( 'post-process', 'hash-b', second, { name: 'same-name' } );

	assert.equal( findAux( 'post-process', 'hash-a' ).artifact, first );
	assert.equal( findAux( 'post-process', 'hash-b' ).artifact, second );
	assert.throws(
		() => findAux( 'post-process', 'same-name' ),
		( error ) => error.name === 'AuxArtifactSelectionError'
			&& error.code === 'AUX_ARTIFACT_AMBIGUOUS'
			&& error.shape === 'post-process'
			&& error.knownCaptures.length === 2
			&& /Use a unique capture name/.test( error.message ),
	);

	const node = { isNode: true };
	assert.throws(
		() => bindAuxByName( node, 'post-process', 'same-name' ),
		( error ) => error.code === 'AUX_ARTIFACT_AMBIGUOUS',
	);
	assert.equal( node.__tslpAuxConfigHash, undefined );

} );

test( 'aux-loader: deterministic resolver tries each registered hash domain before reporting ambiguity', () => {

	__resetAuxRegistryForTests();
	const first = {};
	const second = {};
	registerAuxArtifact( 'background', 'hash-old', first, { threeVersion: '0.184.0', pluginVersion: '0.1.0' } );
	registerAuxArtifact( 'background', 'hash-new', second, { threeVersion: '0.185.0', pluginVersion: '0.1.0' } );
	const domains = [];
	const selected = resolveAuxArtifactForInput( 'background', { isNode: true }, {
		computeConfigHash( _input, options ) {

			domains.push( options.threeVersion );
			return options.threeVersion === '0.185.0' ? 'hash-new' : 'miss';

		},
	} );
	assert.equal( selected.artifact, second );
	assert.equal( selected.matchedBy, 'hash' );
	assert.deepEqual( domains, [ '0.184.0', '0.185.0' ] );

} );

test( 'aux-loader: resolver reports binding and unique-fallback provenance', () => {

	__resetAuxRegistryForTests();
	const artifact = {};
	registerAuxArtifact( 'post-process', 'captured', artifact, { threeVersion: '0.184.0', pluginVersion: '0.1.0' } );
	const unbound = resolveAuxArtifactForInput( 'post-process', {}, { computeConfigHash: () => 'miss' } );
	assert.equal( unbound.matchedBy, 'unique' );

	const node = {};
	bindAuxByName( node, 'post-process', 'captured' );
	const bound = resolveAuxArtifactForInput( 'post-process', node );
	assert.equal( bound.matchedBy, 'binding' );

} );

test( 'aux-loader: bound lookups ignore unrelated metadata and observe registry replacement and reset', () => {

	__resetAuxRegistryForTests();
	const selected = {};
	const unrelated = {};
	registerAuxArtifact( 'post-process', 'selected', selected );
	registerAuxArtifact( 'post-process', 'unrelated', unrelated );
	const input = {};
	bindAuxByName( input, 'post-process', 'selected' );
	assert.throws( () => resolveAuxArtifactForInput( 'post-process', {
		__tslpAuxShape: 'post-process', __tslpAuxConfigHash: 'missing',
	} ), error => {

		assert.equal( error.code, 'AUX_ARTIFACT_NOT_FOUND' );
		assert.deepEqual( error.knownCaptures.map( entry => entry.configHash ), [ 'selected', 'unrelated' ] );
		return true;

	} );
	Object.defineProperty( unrelated, 'name', { get() { assert.fail( 'exact lookup must not inspect another capture' ); } } );
	assert.equal( resolveAuxArtifactForInput( 'post-process', input ).artifact, selected );
	const replacement = {};
	registerAuxArtifact( 'post-process', 'selected', replacement );
	assert.equal( resolveAuxArtifactForInput( 'post-process', input ).artifact, replacement );
	assert.throws( () => resolveAuxArtifactForInput( 'background', input ), {
		name: 'AuxArtifactSelectionError', code: 'AUX_ARTIFACT_SHAPE_MISMATCH',
	} );
	__resetAuxRegistryForTests();
	assert.throws( () => resolveAuxArtifactForInput( 'post-process', input ), error => {

		assert.equal( error.code, 'AUX_ARTIFACT_NOT_FOUND' );
		assert.equal( error.configHash, 'selected' );
		assert.deepEqual( error.knownCaptures, [] );
		return true;

	} );

} );

test( 'aux-loader: exact adapters can reject a mismatched single capture', () => {

	__resetAuxRegistryForTests();
	registerAuxArtifact( 'render-output', 'captured', {}, { threeVersion: '0.184.0', pluginVersion: '0.1.0' } );
	assert.throws(
		() => resolveAuxArtifactForInput( 'render-output', {}, {
			computeConfigHash: () => 'active',
			allowUniqueFallback: false,
		} ),
		( error ) => error.code === 'AUX_ARTIFACT_NOT_FOUND' && /do not guess by shape/.test( error.message ),
	);

} );

test( 'aux-loader: replay clones isolate mutable sidecars', () => {

	const texture = {};
	const artifact = {};
	Object.defineProperty( artifact, '_textureRefs', { value: new Map( [ [ 'a', texture ] ] ), configurable: true } );
	Object.defineProperty( artifact, '_liveUpdateBeforeNodes', { value: [ { id: 1 } ], configurable: true } );
	const clone = cloneAuxArtifactForReplay( artifact );
	assert.notEqual( clone, artifact );
	assert.notEqual( clone._textureRefs, artifact._textureRefs );
	assert.notEqual( clone._liveUpdateBeforeNodes, artifact._liveUpdateBeforeNodes );
	clone._textureRefs.set( 'b', {} );
	clone._liveUpdateBeforeNodes.push( { id: 2 } );
	assert.equal( artifact._textureRefs.has( 'b' ), false );
	assert.equal( artifact._liveUpdateBeforeNodes.length, 1 );

} );

test( 'aux-loader: empty/invalid inputs reject', () => {

	__resetAuxRegistryForTests();
	assert.throws( () => registerAuxArtifact( '', 'abc', {} ), /shape/ );
	assert.throws( () => registerAuxArtifact( 'background', '', {} ), /configHash/ );

} );


test( 'generated aux-only registration shares lookup, metadata and validation with manual registration', () => {

	for ( const register of [ registerAuxArtifacts, __registerAuxArtifactsOnly ] ) {

		__resetAuxRegistryForTests();
		const artifact = { materialShape: 'post-process', uniformPlan: [] };
		register( [ { shape: 'post-process', configHash: 'exact', artifact, name: 'pass', threeVersion: '0.185.1', pluginVersion: '0.1.0' } ] );
		assert.equal( loadAux( 'post-process', 'exact' ), artifact );
		assert.equal( findAux( 'post-process', 'pass' ).artifact, artifact );
		assert.equal( artifact.__tslpAuxThreeVersion, '0.185.1' );
		assert.equal( artifact.__tslpAuxPluginVersion, '0.1.0' );
		assert.throws( () => register( [ { shape: '', configHash: 'x', artifact } ] ), /shape must be a non-empty string/ );
		assert.throws( () => register( [ { shape: 'post-process', configHash: '', artifact } ] ), /configHash must be a non-empty string/ );

	}
	for ( const shape of [ 'shadow-depth', 'render-pipeline', 'output-transform' ] ) {

		__resetAuxRegistryForTests();
		const artifact = {};
		assert.throws( () => __registerAuxArtifactsOnly( [ { shape, configHash: 'x', artifact } ] ), /renderer-owned shapes require registerAuxArtifacts/ );
		assert.equal( hasAux( shape, 'x' ), false );
		assert.deepEqual( Reflect.ownKeys( artifact ), [], 'rejected registration must not stamp or wire the artifact' );

	}

} );

function viewportFixture( uuid, depth = false ) {

	return {
		uniformPlan: [ { name: 'object', textures: [ { name: 'input', source: { kind: 'artifact.texture', mapping: 300, textureUuid: uuid } } ] } ],
		fragmentShader: `var input: ${ depth ? 'texture_depth_2d' : 'texture_2d<f32>' };`,
	};

}

function countViewportTextures() {

	const counts = { color: 0, depth: 0 };
	setupViewportTextureClasses( {
		FramebufferTexture: class { constructor() { counts.color ++; this.isFramebufferTexture = true; } },
		DepthTexture: class { constructor() { counts.depth ++; this.isDepthTexture = true; } },
	} );
	return counts;

}

test( 'deferred preparation retries after late texture setup or a failed constructor', async () => {

	const runtime = await import( '../../../runtime/src/aux-loader.js?deferred-bootstrap-test' );
	const artifact = viewportFixture( 'late' );
	runtime.__registerAuxArtifactsOnly( [ { shape: 'background', configHash: 'a', artifact } ], null, true );
	assert.equal( runtime.loadAux( 'background', 'a' ), artifact );
	assert.equal( artifact._textureRefs, undefined );
	let fail = true;
	runtime.setupViewportTextureClasses( {
		FramebufferTexture: class { constructor() { if ( fail ) throw new Error( 'texture setup failed' ); } },
		DepthTexture: class {},
	} );
	assert.throws( () => runtime.loadAux( 'background', 'a' ), /texture setup failed/ );
	fail = false;
	assert.equal( runtime.loadAux( 'background', 'a' ), artifact );
	assert.equal( artifact._textureRefs.has( 'late' ), true );

} );

test( 'generated deferred tables prepare only requested shapes and preserve table access', () => {

	__resetAuxRegistryForTests();
	const counts = countViewportTextures();
	const color = viewportFixture( 'color' ), depth = viewportFixture( 'depth', true );
	const entries = [
		{ shape: 'post-process', configHash: 'a', name: 'color-pass', artifact: color },
		{ shape: 'background', configHash: 'b', name: 'depth-pass', artifact: depth },
	];
	__registerAuxArtifactsOnly( entries, null, true );
	assert.deepEqual( counts, { color: 0, depth: 0 } );
	assert.equal( hasAux( 'post-process', 'a' ), true );
	assert.equal( listAux()[ 0 ].name, 'color-pass' );
	assert.deepEqual( counts, { color: 0, depth: 0 }, 'metadata inspection does not construct textures' );
	assert.equal( loadAux( 'background', 'b' ), depth );
	assert.equal( depth._textureRefs.get( 'depth' ).isDepthTexture, true );
	assert.equal( depth._textureRefs.get( 'depth' ).isFramebufferTexture, undefined );
	assert.equal( color._textureRefs, undefined );
	assert.equal( loadAux( 'background', 'b' ), depth );
	assert.deepEqual( counts, { color: 0, depth: 1 }, 'repeat lookup does not prepare again' );
	Object.freeze( entries[ 0 ] );
	assert.equal( entries[ 0 ].artifact, color );
	assert.deepEqual( counts, { color: 1, depth: 1 } );
	assert.throws( () => { entries[ 0 ].artifact = {}; }, TypeError );

} );

test( 'deferred preparation preserves registered identity, cloning and eager manual registration', () => {

	__resetAuxRegistryForTests();
	const counts = countViewportTextures();
	const artifact = viewportFixture( 'original' );
	const entry = { shape: 'background', configHash: 'a', artifact };
	__registerAuxArtifactsOnly( [ entry ], null, true );
	const replacement = {};
	entry.artifact = replacement;
	assert.equal( entry.artifact, replacement );
	assert.equal( counts.color, 0 );
	const clone = cloneAuxArtifactForReplay( artifact );
	assert.equal( counts.color, 1 );
	assert.notEqual( clone._textureRefs, artifact._textureRefs );
	assert.equal( clone._textureRefs.get( 'original' ), artifact._textureRefs.get( 'original' ) );
	assert.equal( findAux( 'background', 'a' ).artifact, artifact );
	assert.equal( counts.color, 1 );
	registerAuxArtifact( 'background', 'manual', viewportFixture( 'manual' ) );
	assert.equal( counts.color, 2, 'public registration remains eager' );
	__registerAuxArtifactsOnly( [ { shape: 'background', configHash: 'legacy', artifact: viewportFixture( 'legacy' ) } ] );
	assert.equal( counts.color, 3, 'existing private callers retain eager behavior without the flag' );

} );

test( 'deferred entries preserve replacement order, named ambiguity and registry reset', () => {

	__resetAuxRegistryForTests();
	const counts = countViewportTextures();
	const old = viewportFixture( 'old' ), latest = viewportFixture( 'latest' );
	__registerAuxArtifactsOnly( [
		{ shape: 'background', configHash: 'a', name: 'same', artifact: old },
		{ shape: 'background', configHash: 'a', name: 'same', artifact: latest },
		{ shape: 'background', configHash: 'b', name: 'same', artifact: viewportFixture( 'b' ) },
	], null, true );
	assert.equal( loadAux( 'background', 'a' ), latest );
	assert.equal( old._textureRefs, undefined );
	assert.equal( counts.color, 1 );
	assert.throws( () => findAux( 'background', 'same' ), error => error.code === 'AUX_ARTIFACT_AMBIGUOUS' );
	assert.equal( counts.color, 2 );
	__resetAuxRegistryForTests();
	assert.equal( hasAux( 'background', 'a' ), false );
	assert.deepEqual( listAux(), [] );
	assert.throws( () => loadAux( 'background', 'a' ), /no artifact/ );

} );
