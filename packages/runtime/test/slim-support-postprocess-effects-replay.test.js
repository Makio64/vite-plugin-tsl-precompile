import test from 'node:test';
import assert from 'node:assert/strict';

import {
	preparePrecompiledPostprocess,
	prepareEffectNodeForReplay,
	makePrecompiledAuxMaterial,
	cloneAuxArtifact,
	wireLiveNodeSidecarsToArtifact,
	artifactLooksLikeRetroPassMaterial,
} from '../src/slim-support/postprocess-effects-replay.js';
import {
	registerEffectHandler,
	unregisterEffectHandler,
	findEffectHandler,
	__resetEffectHandlersForTests,
} from '../src/slim-support/postprocess-effects.js';
import {
	collectTRAASelfTextures,
	wireTRAAResolveArtifact,
} from '../src/slim-support/traa-replay.js';

// ---------------------------------------------------------------------------
// Stub PrecompiledMaterial — mirrors the real class's contract: takes an
// artifact in the constructor and exposes it as `precompiledArtifact`.
// ---------------------------------------------------------------------------
class StubPrecompiledMaterial {

	constructor( artifact ) {

		this.precompiledArtifact = artifact;
		this.isNodeMaterial = true;
		this.isPrecompiledMaterial = true;
		this.needsUpdate = false;
		this.name = '';

	}

}

// ---------------------------------------------------------------------------
// Aux artifact factory used by the in-test loadAux. Each shape gets a
// distinct uniformPlan so cloning and per-replay mutations can be verified
// in isolation.
// ---------------------------------------------------------------------------
function makeAuxArtifact( shape ) {

	return {
		version: 3,
		shape,
		uniformPlan: [
			{
				slots: [
					{ dtype: 'vec2', source: { kind: 'uniform.live', name: 'direction', valueSnapshot: { data: [ 1, 0 ] } } },
					{ dtype: 'vec2', source: { kind: 'uniform.live', name: 'invSize', valueSnapshot: { data: [ 0.001, 0.001 ] } } },
				],
				textures: [
					{ source: { kind: 'artifact.texture', textureUuid: 'tex-' + shape, textureName: 'tex-' + shape } },
				],
			},
		],
		defaults: {},
		renderState: {},
		fragmentShader: '',
		vertexShader: '',
	};

}

function makeBloomLikeNode( opts = {} ) {

	const blurCount = opts.blurCount || 2;
	const node = {
		updateBefore: () => {},
		_renderTargetBright: { texture: { isTexture: true, uuid: 'rt-bright', name: 'bright' } },
		_renderTargetsHorizontal: [],
		_renderTargetsVertical: [],
		_highPassFilterMaterial: { name: 'highPass', isLive: true, fragmentNode: { isNode: true } },
		_compositeMaterial: { name: 'composite', isLive: true, fragmentNode: { isNode: true } },
		_separableBlurMaterials: [],
	};
	for ( let i = 0; i < blurCount; i ++ ) {

		const blurMat = {
			name: 'blur-' + i,
			isLive: true,
			colorTexture: { value: null },
			direction: { isUniformNode: true, isVector2: true, value: { isVector2: true, x: 1, y: 0 }, name: 'direction' },
			invSize: { isUniformNode: true, isVector2: true, value: { isVector2: true, x: 0.001, y: 0.001 }, name: 'invSize' },
		};
		node._separableBlurMaterials.push( blurMat );
		node._renderTargetsHorizontal.push( { texture: { isTexture: true, uuid: 'rt-h-' + i, name: 'rt-h-' + i } } );
		node._renderTargetsVertical.push( { texture: { isTexture: true, uuid: 'rt-v-' + i, name: 'rt-v-' + i } } );

	}
	return node;

}

function makeTRAAResolveArtifact() {

	return {
		version: 3,
		shape: 'traa-resolve',
		uniformPlan: [
			{
				slots: [],
				textures: [
					{ source: { kind: 'artifact.texture', textureUuid: 'captured-output', textureName: 'output' } },
					{ source: { kind: 'artifact.texture', textureUuid: 'captured-velocity', textureName: 'velocity' } },
					{ source: { kind: 'artifact.texture', textureUuid: 'captured-history', textureName: 'TRAANode.history' } },
					{ source: { kind: 'depth.texture', textureUuid: 'captured-current-depth', fromMaterialGraph: true } },
					{ source: { kind: 'depth.texture', textureUuid: 'captured-history-depth', fromMaterialGraph: true } },
				],
			},
		],
		defaults: {},
		renderState: {},
		fragmentShader: '',
		vertexShader: '',
	};

}

function makeTRAALikeNode() {

	const textures = {
		output: { isTexture: true, uuid: 'live-output', name: 'output' },
		velocity: { isTexture: true, uuid: 'live-velocity', name: 'velocity' },
		currentDepth: { isTexture: true, isDepthTexture: true, uuid: 'live-current-depth', name: 'depth' },
		resolve: { isTexture: true, uuid: 'live-resolve', name: '' },
		history: { isTexture: true, uuid: 'live-history', name: '' },
		historyDepth: { isTexture: true, isDepthTexture: true, uuid: 'live-history-depth', name: '' },
	};
	const passNode = {
		name: 'Pre Pass',
		__tslpPassIndex: 0,
		getTexture( name ) {

			if ( name === 'output' ) return textures.output;
			if ( name === 'velocity' ) return textures.velocity;
			if ( name === 'depth' ) return textures.currentDepth;
			return null;

		},
	};
	const node = {
		type: 'TRAANode',
		_resolveMaterial: { name: 'traa-resolve-source', fragmentNode: { isNode: true } },
		_resolveRenderTarget: { texture: textures.resolve },
		_historyRenderTarget: { texture: textures.history, depthTexture: textures.historyDepth },
		beautyNode: { passNode },
		depthNode: {},
	};
	return { node, passNode, textures };

}

function makeLoadAux( shapes ) {

	const map = new Map();
	for ( const shape of shapes ) map.set( shape, makeAuxArtifact( shape ) );
	const fn = ( shape /* , configHash */ ) => map.get( shape ) || null;
	fn._map = map;
	return fn;

}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test( 'cloneAuxArtifact deep-clones — separate uniformPlan slots and textures', () => {

	const artifact = makeAuxArtifact( 'bloom-high-pass' );
	const clone = cloneAuxArtifact( artifact );
	assert.notEqual( clone, artifact );
	assert.notEqual( clone.uniformPlan, artifact.uniformPlan );
	assert.notEqual( clone.uniformPlan[ 0 ], artifact.uniformPlan[ 0 ] );
	clone.uniformPlan[ 0 ].slots[ 0 ].source.name = 'mutated';
	assert.equal( artifact.uniformPlan[ 0 ].slots[ 0 ].source.name, 'direction', 'original is untouched' );

} );

test( 'artifactLooksLikeRetroPassMaterial uses browser-safe string checks', () => {

	assert.equal( artifactLooksLikeRetroPassMaterial( {
		vertexShader: 'nodeVar10 = vec4<f32>( round( nodeVar9.xy ), nodeVar9.zw );',
	} ), true );
	assert.equal( artifactLooksLikeRetroPassMaterial( {
		vertexShader: 'let pixel = position.xy * screenSize;',
	} ), true );
	assert.equal( artifactLooksLikeRetroPassMaterial( {
		vertexShader: 'fn main() -> vec4<f32> { return vec4<f32>( 1.0 ); }',
	} ), false );
	assert.equal( artifactLooksLikeRetroPassMaterial( null ), false );

} );

test( 'makePrecompiledAuxMaterial returns a PrecompiledMaterial with a cloned artifact and mirrors uniforms', () => {

	const loadAux = makeLoadAux( [ 'bloom-blur-0' ] );
	const source = {
		name: 'live-blur-0',
		colorTexture: { value: null },
		direction: { isUniformNode: true, name: 'direction', value: { isVector2: true, x: 1, y: 0 } },
		invSize: { isUniformNode: true, name: 'invSize', value: { isVector2: true, x: 0.001, y: 0.001 } },
		toneMapped: true,
	};
	const mat = makePrecompiledAuxMaterial( 'bloom-blur-0', source, { loadAux, PrecompiledMaterial: StubPrecompiledMaterial } );
	const mat2 = makePrecompiledAuxMaterial( 'bloom-blur-0', source, { loadAux, PrecompiledMaterial: StubPrecompiledMaterial } );
	assert.ok( mat instanceof StubPrecompiledMaterial );
	assert.equal( mat.name, 'live-blur-0' );
	assert.equal( mat.precompiledArtifact.shape, 'bloom-blur-0' );
	// Cloned, not aliased
	assert.notEqual( mat.precompiledArtifact, loadAux._map.get( 'bloom-blur-0' ) );
	// Mutable blur sidecars are cloned so replay rewiring does not mutate the source material.
	assert.notEqual( mat.colorTexture, source.colorTexture );
	assert.deepEqual( mat.colorTexture, source.colorTexture );
	assert.notEqual( mat.direction, source.direction );
	assert.deepEqual( mat.direction.value, source.direction.value );
	assert.equal( mat.invSize, source.invSize );
	assert.equal( mat.toneMapped, false, 'bloom aux materials render into intermediate targets without tone mapping' );
	assert.equal( typeof mat.customProgramCacheKey, 'function' );
	assert.equal( typeof mat2.customProgramCacheKey, 'function' );
	assert.notEqual( mat.customProgramCacheKey(), mat2.customProgramCacheKey(), 'blur materials with cloned sidecars must not share a node-builder cache key' );
	assert.equal( mat.needsUpdate, true );

} );

test( 'makePrecompiledAuxMaterial returns null when no aux artifact is registered', () => {

	const loadAux = makeLoadAux( [] );
	const mat = makePrecompiledAuxMaterial( 'bloom-blur-0', {}, { loadAux, PrecompiledMaterial: StubPrecompiledMaterial } );
	assert.equal( mat, null );

} );

test( 'makePrecompiledAuxMaterial validates options', () => {

	assert.throws( () => makePrecompiledAuxMaterial( 'x', {}, { PrecompiledMaterial: StubPrecompiledMaterial } ) );
	assert.throws( () => makePrecompiledAuxMaterial( 'x', {}, { loadAux: () => null } ) );

} );

test( 'prepareEffectNodeForReplay wraps bloom sub-materials as PrecompiledMaterials', () => {

	const loadAux = makeLoadAux( [ 'bloom-high-pass', 'bloom-blur-0', 'bloom-blur-1', 'bloom-composite' ] );
	const node = makeBloomLikeNode( { blurCount: 2 } );
	const handler = findEffectHandler( node );
	assert.equal( handler && handler.name, 'bloom', 'bloom handler should match the fake bloom node' );

	const result = prepareEffectNodeForReplay( handler, node, {
		loadAux,
		PrecompiledMaterial: StubPrecompiledMaterial,
		effectIndex: 0,
	} );
	assert.equal( result.alreadyPrepared, false );
	assert.equal( result.missed.length, 0, 'no misses expected with full aux registry: ' + JSON.stringify( result.missed ) );
	assert.equal( result.prepared.length, 4 ); // 1 high-pass + 2 blur + 1 composite
	// Each sub-material on the live node is now an instance of StubPrecompiledMaterial.
	assert.ok( node._highPassFilterMaterial instanceof StubPrecompiledMaterial );
	assert.ok( node._compositeMaterial instanceof StubPrecompiledMaterial );
	assert.ok( node._separableBlurMaterials[ 0 ] instanceof StubPrecompiledMaterial );
	assert.ok( node._separableBlurMaterials[ 1 ] instanceof StubPrecompiledMaterial );
	// The shapes are preserved on the prepared records.
	const shapes = result.prepared.map( ( p ) => p.shape ).sort();
	assert.deepEqual( shapes, [ 'bloom-blur-0', 'bloom-blur-1', 'bloom-composite', 'bloom-high-pass' ] );

} );

test( 'prepareEffectNodeForReplay is idempotent — second call is a no-op', () => {

	const loadAux = makeLoadAux( [ 'bloom-high-pass', 'bloom-blur-0', 'bloom-blur-1', 'bloom-composite' ] );
	const node = makeBloomLikeNode( { blurCount: 2 } );
	const handler = findEffectHandler( node );
	const first = prepareEffectNodeForReplay( handler, node, { loadAux, PrecompiledMaterial: StubPrecompiledMaterial } );
	assert.equal( first.prepared.length, 4 );
	assert.equal( first.alreadyPrepared, false );
	const firstHighPass = node._highPassFilterMaterial;
	const second = prepareEffectNodeForReplay( handler, node, { loadAux, PrecompiledMaterial: StubPrecompiledMaterial } );
	assert.equal( second.alreadyPrepared, true );
	assert.equal( second.prepared.length, 0 );
	// Material identity is preserved across re-call — we did not re-swap.
	assert.equal( node._highPassFilterMaterial, firstHighPass );

} );

test( 'prepareEffectNodeForReplay calls handler hooks when defined', () => {

	__resetEffectHandlersForTests();
	const calls = { forceSetup: 0, wireSubPassUniforms: 0, wireSubPassTextures: 0, patchUpdateBefore: 0 };

	const fakeMaterial = { name: 'fake-fx-mat' };
	const fakeNode = { __fakeFx: true, _mat: fakeMaterial };

	registerEffectHandler( {
		name: 'fake-fx',
		detect: ( n ) => !! ( n && n.__fakeFx === true ),
		subPasses: ( n ) => [ { material: n._mat, shape: 'fake-fx', config: {} } ],
		forceSetup: () => { calls.forceSetup ++; },
		wireSubPassUniforms: ( subPass, source ) => {

			calls.wireSubPassUniforms ++;
			// Hook sees the *replacement* material (carries `precompiledArtifact`)
			// and the original source material.
			assert.ok( subPass.material.precompiledArtifact );
			assert.equal( source, fakeMaterial );

		},
		wireSubPassTextures: ( subPass, node ) => { calls.wireSubPassTextures ++; assert.equal( node, fakeNode ); },
		patchUpdateBefore: () => { calls.patchUpdateBefore ++; },
	} );

	const loadAux = makeLoadAux( [ 'fake-fx' ] );
	const handler = findEffectHandler( fakeNode );
	const result = prepareEffectNodeForReplay( handler, fakeNode, { loadAux, PrecompiledMaterial: StubPrecompiledMaterial } );
	assert.equal( result.missed.length, 0 );
	assert.deepEqual( calls, { forceSetup: 1, wireSubPassUniforms: 1, wireSubPassTextures: 1, patchUpdateBefore: 1 } );

	unregisterEffectHandler( 'fake-fx' );

} );

test( 'prepareEffectNodeForReplay attaches live postprocess textures by name', () => {

	__resetEffectHandlersForTests();
	const liveTexture = { isTexture: true, name: 'fake-fx-output', uuid: 'live-output' };
	const fakeMaterial = { name: 'fake-fx-mat', fragmentNode: { isNode: true } };
	const fakeNode = { __fakeTextureFx: true, _mat: fakeMaterial, _rt: { isRenderTarget: true, texture: liveTexture } };

	registerEffectHandler( {
		name: 'fake-texture-fx',
		detect: ( n ) => !! ( n && n.__fakeTextureFx === true ),
		subPasses: ( n ) => [ { material: n._mat, shape: 'fake-texture-fx', config: {} } ],
	} );

	const loadAux = () => ( {
		version: 3,
		shape: 'fake-texture-fx',
		uniformPlan: [ {
			slots: [],
			textures: [ { source: { kind: 'artifact.texture', textureUuid: 'captured-output', textureName: 'fake-fx-output' } } ],
		} ],
		defaults: {},
		renderState: {},
		fragmentShader: '',
		vertexShader: '',
	} );
	const handler = findEffectHandler( fakeNode );
	const result = prepareEffectNodeForReplay( handler, fakeNode, { loadAux, PrecompiledMaterial: StubPrecompiledMaterial } );
	assert.equal( result.missed.length, 0 );
	assert.ok( fakeNode._mat instanceof StubPrecompiledMaterial );
	assert.equal( fakeNode._mat.precompiledArtifact._textureRefs.get( 'captured-output' ), liveTexture );

	unregisterEffectHandler( 'fake-texture-fx' );

} );

test( 'wireTRAAResolveArtifact attaches output, velocity, history, and depth textures', () => {

	const { node, passNode, textures } = makeTRAALikeNode();
	const artifact = makeTRAAResolveArtifact();
	const stats = wireTRAAResolveArtifact( artifact, node, { passNodes: [ passNode ] } );

	assert.deepEqual( stats, { outputAttached: 1, velocityAttached: 1, historyAttached: 1, depthAttached: 2 } );
	assert.equal( textures.resolve.name, 'TRAANode.resolve' );
	assert.equal( textures.history.name, 'TRAANode.history' );
	assert.equal( textures.historyDepth.name, 'TRAANode.history.depth' );

	const refs = artifact._textureRefs;
	assert.ok( refs instanceof Map, 'TRAA wiring populates _textureRefs' );
	assert.equal( refs.get( 'captured-output' ), textures.output );
	assert.equal( refs.get( 'captured-velocity' ), textures.velocity );
	assert.equal( refs.get( 'captured-history' ), textures.history );
	assert.equal( refs.get( 'captured-current-depth' ), textures.currentDepth );
	assert.equal( refs.get( 'captured-history-depth' ), textures.historyDepth );

	const sources = artifact.uniformPlan[ 0 ].textures.map( ( entry ) => entry.source );
	assert.equal( sources[ 3 ].kind, 'artifact.texture' );
	assert.equal( sources[ 3 ].textureName, 'depth' );
	assert.equal( sources[ 3 ].__tslpPassDepthAttached, true );
	assert.equal( sources[ 4 ].kind, 'artifact.texture' );
	assert.equal( sources[ 4 ].textureName, 'TRAANode.history.depth' );
	assert.equal( sources[ 4 ].__tslpPassDepthAttached, true );

} );

test( 'collectTRAASelfTextures excludes upstream pass inputs', () => {

	const { node, textures } = makeTRAALikeNode();
	const selfTextures = collectTRAASelfTextures( node );

	assert.equal( selfTextures.has( textures.resolve ), true );
	assert.equal( selfTextures.has( textures.history ), true );
	assert.equal( selfTextures.has( textures.historyDepth ), true );
	assert.equal( selfTextures.has( textures.output ), false );
	assert.equal( selfTextures.has( textures.velocity ), false );
	assert.equal( selfTextures.has( textures.currentDepth ), false );

} );

test( 'prepareEffectNodeForReplay wires TRAA resolve texture refs for real runtime callers', () => {

	const { node, passNode, textures } = makeTRAALikeNode();
	const handler = findEffectHandler( node );
	assert.equal( handler && handler.name, 'traa', 'TRAA handler should match the fake TRAA node' );

	const loadAux = ( shape ) => shape === 'traa-resolve' ? makeTRAAResolveArtifact() : null;
	const result = prepareEffectNodeForReplay( handler, node, {
		loadAux,
		PrecompiledMaterial: StubPrecompiledMaterial,
		passNodes: [ passNode ],
	} );

	assert.equal( result.missed.length, 0, 'no misses expected for TRAA resolve: ' + JSON.stringify( result.missed ) );
	assert.equal( result.prepared.length, 1 );
	assert.ok( node._resolveMaterial instanceof StubPrecompiledMaterial );

	const refs = node._resolveMaterial.precompiledArtifact._textureRefs;
	assert.equal( refs.get( 'captured-output' ), textures.output );
	assert.equal( refs.get( 'captured-velocity' ), textures.velocity );
	assert.equal( refs.get( 'captured-history' ), textures.history );
	assert.equal( refs.get( 'captured-current-depth' ), textures.currentDepth );
	assert.equal( refs.get( 'captured-history-depth' ), textures.historyDepth );

} );

test( 'prepareEffectNodeForReplay records missed shapes when aux is absent', () => {

	const loadAux = makeLoadAux( [ 'bloom-high-pass' ] ); // intentionally missing blur + composite
	const node = makeBloomLikeNode( { blurCount: 1 } );
	const handler = findEffectHandler( node );
	const result = prepareEffectNodeForReplay( handler, node, { loadAux, PrecompiledMaterial: StubPrecompiledMaterial } );
	assert.equal( result.prepared.length, 1 ); // only high-pass landed
	const missedShapes = result.missed.map( ( m ) => m.shape ).sort();
	assert.deepEqual( missedShapes, [ 'bloom-blur-0', 'bloom-composite' ] );

} );

test( 'preparePrecompiledPostprocess walks the registry and prepares all matched effects', () => {

	const loadAux = makeLoadAux( [
		'bloom-high-pass', 'bloom-blur-0', 'bloom-blur-1', 'bloom-composite',
		'outline-depth', 'outline-edge', 'outline-blur', 'outline-composite', 'outline-mask',
	] );
	const bloom = makeBloomLikeNode( { blurCount: 2 } );
	const outline = {
		_depthMaterial: { name: 'd' },
		_edgeDetectionMaterial: { name: 'e' },
		_separableBlurMaterial: { name: 'b' },
		_compositeMaterial: { name: 'c' },
		_prepareMaskMaterial: { name: 'm' },
	};
	const outputNode = { colorNode: bloom, otherNode: { wrapped: outline } };
	const result = preparePrecompiledPostprocess( {
		outputNode,
		loadAux,
		PrecompiledMaterial: StubPrecompiledMaterial,
	} );
	assert.equal( result.effects, 2 );
	assert.ok( result.prepared.length >= 4 + 5, 'bloom (4) + outline (5) sub-passes' );
	const handlers = new Set( result.prepared.map( ( p ) => p.handler ) );
	assert.ok( handlers.has( 'bloom' ) );
	assert.ok( handlers.has( 'outline' ) );

} );

test( 'preparePrecompiledPostprocess forwards passNodes for TRAA depth replay', () => {

	const { node, passNode, textures } = makeTRAALikeNode();
	const loadAux = ( shape ) => shape === 'traa-resolve' ? makeTRAAResolveArtifact() : null;
	const result = preparePrecompiledPostprocess( {
		outputNode: { post: node },
		loadAux,
		PrecompiledMaterial: StubPrecompiledMaterial,
		passNodes: [ passNode ],
	} );

	assert.equal( result.effects, 1 );
	assert.equal( result.missed.length, 0, 'TRAA public prepare path should not miss: ' + JSON.stringify( result.missed ) );
	const refs = node._resolveMaterial.precompiledArtifact._textureRefs;
	assert.equal( refs.get( 'captured-current-depth' ), textures.currentDepth );
	assert.equal( refs.get( 'captured-history-depth' ), textures.historyDepth );

} );

test( 'preparePrecompiledPostprocess returns a friendly result when no outputNode is present', () => {

	const loadAux = makeLoadAux( [] );
	const result = preparePrecompiledPostprocess( { loadAux, PrecompiledMaterial: StubPrecompiledMaterial } );
	assert.equal( result.effects, 0 );
	assert.equal( result.prepared.length, 0 );
	assert.equal( result.missed.length, 1 );
	assert.match( result.missed[ 0 ].reason, /no outputNode/ );

} );

test( 'preparePrecompiledPostprocess validates required args', () => {

	assert.throws( () => preparePrecompiledPostprocess( { outputNode: {}, PrecompiledMaterial: StubPrecompiledMaterial } ) );
	assert.throws( () => preparePrecompiledPostprocess( { outputNode: {}, loadAux: () => null } ) );

} );

test( 'wireLiveNodeSidecarsToArtifact matches uniform.live slots by dtype and value', () => {

	const artifact = makeAuxArtifact( 'bloom-blur-0' );
	const liveDirection = { isUniformNode: true, name: 'direction', value: { isVector2: true, x: 1, y: 0 } };
	const liveInvSize = { isUniformNode: true, name: 'invSize', value: { isVector2: true, x: 0.001, y: 0.001 } };
	const sourceMaterial = {
		fragmentNode: {
			isNode: true,
			children: [ liveDirection, liveInvSize ],
		},
		direction: liveDirection,
		invSize: liveInvSize,
	};
	const counters = wireLiveNodeSidecarsToArtifact( artifact, sourceMaterial );
	assert.equal( counters.uniformsMatched, 2, 'both vec2 live slots wired' );
	const slots = artifact.uniformPlan[ 0 ].slots;
	const wireNames = slots.map( ( s ) => s._liveNode && s._liveNode.name ).sort();
	assert.deepEqual( wireNames, [ 'direction', 'invSize' ] );
	assert.equal( slots[ 0 ].__tslpLiveSidecarOverlay, undefined );
	assert.equal( slots[ 1 ].__tslpLiveSidecarOverlay, undefined );

} );

test( 'wireLiveNodeSidecarsToArtifact refuses same-dtype anonymous mismatches', () => {

	const artifact = {
		uniformPlan: [
			{
				slots: [
					{ dtype: 'number', source: { kind: 'uniform.live', valueSnapshot: { type: 'number', data: 3 } } },
					{ dtype: 'number', source: { kind: 'uniform.live', valueSnapshot: { type: 'number', data: 0.15 } } },
					{ dtype: 'number', source: { kind: 'uniform.live', valueSnapshot: { type: 'number', data: 3 } } },
				],
			},
		],
	};
	const iterations = { isUniformNode: true, value: 3 };
	const multiplier = { isUniformNode: true, value: 0.15 };
	const sourceMaterial = {
		fragmentNode: {
			isNode: true,
			wrong: { isUniformNode: true, value: 99 },
			iterations,
			multiplier,
		},
	};

	const counters = wireLiveNodeSidecarsToArtifact( artifact, sourceMaterial );
	assert.equal( counters.uniformsMatched, 3 );
	const slots = artifact.uniformPlan[ 0 ].slots;
	assert.equal( slots[ 0 ]._liveNode, iterations );
	assert.equal( slots[ 1 ]._liveNode, multiplier );
	assert.equal( slots[ 2 ]._liveNode, iterations, 'duplicate snapshots may share the same live UniformNode' );

} );

test( 'wireLiveNodeSidecarsToArtifact does not dtype-wire anonymous captured scalars', () => {

	const artifact = {
		uniformPlan: [
			{
				slots: [
					{ dtype: 'number', source: { kind: 'uniform.live', valueSnapshot: { type: 'number', data: 0.08 } } },
				],
			},
		],
	};
	const sourceMaterial = {
		fragmentNode: {
			isNode: true,
			wrongScalar: { isUniformNode: true, value: 0 },
		},
	};

	const counters = wireLiveNodeSidecarsToArtifact( artifact, sourceMaterial, { overlay: true } );
	const slot = artifact.uniformPlan[ 0 ].slots[ 0 ];
	assert.equal( counters.uniformsMatched, 0 );
	assert.equal( slot._liveNode, undefined );
	assert.equal( slot.__tslpLiveSidecarOverlay, undefined );

} );

test( 'wireLiveNodeSidecarsToArtifact wires VolumeNodeMaterial.steps by shader usage', () => {

	const artifact = {
		uniformPlan: [
			{
				slots: [
					{
						name: 'steps',
						dtype: 'int',
						source: { kind: 'uniform.live', valueSnapshot: { type: 'number', data: 0 } },
					},
				],
			},
		],
		fragmentShader: 'let maxSteps = f32( object.steps ); for ( var i = 0; i < object.steps; i ++ ) {}',
	};
	const sourceMaterial = {
		isVolumeNodeMaterial: true,
		steps: 24,
	};

	const counters = wireLiveNodeSidecarsToArtifact( artifact, sourceMaterial, { overlay: true } );
	const slot = artifact.uniformPlan[ 0 ].slots[ 0 ];
	assert.equal( counters.uniformsMatched, 1 );
	assert.equal( slot._liveNode.value, 24 );
	assert.equal( slot.__tslpLiveSidecarOverlay, true );
	assert.deepEqual( slot.source.valueSnapshot, { type: 'int', data: 24 } );

	sourceMaterial.steps = 48;
	assert.equal( slot._liveNode.value, 48 );

} );

test( 'bloom handler hooks: wireSubPassUniforms attaches _liveNode to blur direction/invSize slots', () => {

	const loadAux = makeLoadAux( [ 'bloom-high-pass', 'bloom-blur-0', 'bloom-composite' ] );
	const node = makeBloomLikeNode( { blurCount: 1 } );
	const handler = findEffectHandler( node );
	const result = prepareEffectNodeForReplay( handler, node, { loadAux, PrecompiledMaterial: StubPrecompiledMaterial } );
	assert.equal( result.missed.length, 0 );
	const blurMaterial = node._separableBlurMaterials[ 0 ];
	const artifact = blurMaterial.precompiledArtifact;
	const slots = artifact.uniformPlan[ 0 ].slots.filter( ( s ) => s.dtype === 'vec2' );
	// Both vec2 slots should now carry a `_liveNode` reference.
	const wireCount = slots.filter( ( s ) => s._liveNode ).length;
	assert.equal( wireCount, 2, 'bloom blur handler wired both vec2 uniform slots' );
	assert.equal( slots.filter( ( s ) => s.__tslpLiveSidecarOverlay === true ).length, 2 );

} );

test( 'bloom handler hooks: wireSubPassTextures attaches composite texture refs by name', () => {

	const loadAux = ( shape ) => {

		if ( shape !== 'bloom-composite' ) return makeAuxArtifact( shape );
		// Composite artifact whose texture-source names mirror the bloom node's
		// per-mip vertical render-target textures.
		return {
			version: 3,
			shape: 'bloom-composite',
			uniformPlan: [
				{
					slots: [],
					textures: [
						{ source: { kind: 'artifact.texture', textureUuid: 'orig-rt-v-0', textureName: 'rt-v-0' } },
					],
				},
			],
			defaults: {},
			renderState: {},
			fragmentShader: '',
			vertexShader: '',
		};

	};
	const node = makeBloomLikeNode( { blurCount: 1 } );
	const handler = findEffectHandler( node );
	const result = prepareEffectNodeForReplay( handler, node, { loadAux, PrecompiledMaterial: StubPrecompiledMaterial } );
	assert.equal( result.missed.length, 0 );
	const composite = node._compositeMaterial;
	const refs = composite.precompiledArtifact._textureRefs;
	assert.ok( refs instanceof Map, 'wireSubPassTextures populates _textureRefs' );
	assert.equal( refs.get( 'orig-rt-v-0' ), node._renderTargetsVertical[ 0 ].texture );

} );
