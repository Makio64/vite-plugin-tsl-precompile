import test from 'node:test';
import assert from 'node:assert/strict';

import ReplayNodeManager from '../src/slim-replay-node-manager.js';
import { setSlimRenderFallback } from '../src/slim-support/render-fallback-registry.js';
import { createRenderObjectContextSelector } from '@tsl-precompile/contract/render-selector';

function fakeRenderer() {

	return {
		backend: { isWebGPUBackend: true },
		info: { calls: 1 },
		shadowMap: { enabled: true, type: 1 },
		toneMapping: 0,
		currentColorSpace: 'srgb',
		xr: { isPresenting: false },
		getOutputRenderTarget() { return null; },
		getRenderTarget() { return null; },
	};

}

function artifact( overrides = {} ) {

	return {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		computeShader: '',
		bindings: [ {
			name: 'object',
			bindings: [ { name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ],
		} ],
		uniformPlan: [ { name: 'object', byteLength: 16, shared: false, slots: [] } ],
		...overrides,
	};

}

function material( sourceArtifact = artifact() ) {

	return {
		isPrecompiledMaterial: true,
		type: 'PrecompiledMaterial',
		precompiledArtifact: sourceArtifact,
		fog: true,
	};

}

function renderObject( renderer, sourceMaterial, overrides = {} ) {

	const object = {
		type: 'Mesh',
		material: sourceMaterial,
		geometry: { attributes: {} },
		...overrides.object,
	};
	return {
		isRenderObject: true,
		initialCacheKey: 42,
		renderer,
		material: sourceMaterial,
		object,
		scene: {},
		camera: {},
		context: {},
		lightsNode: { getLights: () => [], getCacheKey: () => 0 },
		clippingContext: null,
		...overrides,
		object,
	};

}

test( 'replay NodeManager exposes the renderer active-light list on its NodeFrame', () => {

	const renderer = fakeRenderer();
	const manager = new ReplayNodeManager( renderer, renderer.backend );
	const live = renderObject( renderer, material() );
	const frame = manager.getNodeFrameForRender( live );
	assert.equal( frame.lightsNode, live.lightsNode );
	assert.equal( frame.renderObject, live );

} );

test( 'replay NodeManager returns direct hydrated state and material-scoped semantic caches', () => {

	const renderer = fakeRenderer();
	const manager = new ReplayNodeManager( renderer, renderer.backend );
	const firstMaterial = material();
	const sameA = renderObject( renderer, firstMaterial );
	const sameB = renderObject( renderer, firstMaterial );
	const differentMaterial = renderObject( renderer, material( firstMaterial.precompiledArtifact ) );
	const differentTopology = renderObject( renderer, firstMaterial, { object: { isInstancedMesh: true, count: 4 } } );

	const firstState = manager.getForRender( sameA );
	assert.equal( manager.getForRender( sameB ), firstState, 'same material and selector share hydration' );
	assert.notEqual( manager.getForRender( differentMaterial ), firstState, 'material-bound rebinders never cross material instances' );
	assert.notEqual( manager.getForRender( differentTopology ), firstState, 'semantic topology participates in replay caching' );
	assert.equal( firstState.usedTimes, 2 );

	const bindingsA = firstState.createBindings();
	const bindingsB = firstState.createBindings();
	assert.notEqual( bindingsA[ 0 ].bindings[ 0 ], bindingsB[ 0 ].bindings[ 0 ], 'hydrator createBindings keeps per-object UBO clones' );
	assert.equal( manager.getForRenderDeferred( sameA ), firstState, 'replay has no deferred compiler queue' );

	manager.delete( sameA );
	assert.equal( firstState.usedTimes, 1 );
	manager.delete( sameB );
	assert.equal( firstState.usedTimes, 0 );
	assert.notEqual( manager.getForRender( renderObject( renderer, firstMaterial ) ), firstState, 'zero-ref state is evicted' );

} );

test( 'replay NodeManager stale deletion cannot evict a newer state at the same key', () => {

	const renderer = fakeRenderer();
	const manager = new ReplayNodeManager( renderer, renderer.backend );
	const sourceMaterial = material();
	const staleObject = renderObject( renderer, sourceMaterial );
	const staleState = manager.getForRender( staleObject );
	manager.nodeBuilderCache.clear();
	const liveObject = renderObject( renderer, sourceMaterial );
	const liveState = manager.getForRender( liveObject );
	assert.notEqual( liveState, staleState );
	manager.delete( staleObject );
	assert.equal( manager.nodeBuilderCache.size, 1 );
	assert.equal( manager.getForRender( liveObject ), liveState );

} );

test( 'replay NodeManager applies the background selector profile from aux metadata', () => {

	const sourceRenderer = fakeRenderer();
	const unsigned = artifact();
	const sourceMaterial = material( unsigned );
	const live = renderObject( sourceRenderer, sourceMaterial, {
		scene: {
			fog: { isFogExp2: true },
			environment: { isTexture: true, isCubeTexture: true, mapping: 301 },
			traverse() {},
		},
	} );
	const captureDescriptor = JSON.parse( createRenderObjectContextSelector( live, sourceRenderer ) );
	captureDescriptor.scene = { fog: null, environment: null };
	captureDescriptor.lights = [];
	captureDescriptor.renderer.shadowMap = { enabled: false, type: 0 };
	unsigned.renderContextSelectors = [ JSON.stringify( captureDescriptor ) ];
	Object.defineProperty( unsigned, '__tslpAuxShape', { value: 'background' } );

	const manager = new ReplayNodeManager( sourceRenderer, sourceRenderer.backend );
	assert.doesNotThrow( () => manager.getForRender( live ) );

} );

test( 'replay NodeManager applies the shadow-depth selector profile from artifact shape metadata', () => {

	const sourceRenderer = fakeRenderer();
	const signed = artifact( { materialShape: 'shadow-depth' } );
	const shadowMaterial = material( signed );
	shadowMaterial.isShadowPassMaterial = true;
	const casterMaterial = {
		map: null,
		alphaMap: null,
		alphaTest: 0,
		castShadowNode: Object.assign( function inertCastShadow() {}, { isNode: true } ),
		castShadowPositionNode: null,
		positionNode: null,
		depthNode: null,
	};
	const live = renderObject( sourceRenderer, shadowMaterial, {
		object: { material: casterMaterial },
		scene: {
			fog: { isFogExp2: true },
			environment: { isTexture: true, isCubeTexture: true, mapping: 301 },
			traverse() {},
		},
	} );
	const captureDescriptor = JSON.parse( createRenderObjectContextSelector( live, sourceRenderer ) );
	captureDescriptor.scene = { fog: null, environment: null };
	captureDescriptor.lights = [ { type: 'DirectionalLight', castShadow: true } ];
	signed.renderContextSelectors = [ JSON.stringify( captureDescriptor ) ];

	const manager = new ReplayNodeManager( sourceRenderer, sourceRenderer.backend );
	assert.doesNotThrow( () => manager.getForRender( live ) );

} );

test( 'replay NodeManager supports compute, update scheduling, groups, and disposal', async () => {

	const renderer = fakeRenderer();
	const manager = new ReplayNodeManager( renderer, renderer.backend );
	const computeNode = {
		isPrecompiledCompute: true,
		precompiledArtifact: artifact( { kind: 'compute', vertexShader: '', fragmentShader: '', computeShader: 'compute' } ),
	};
	const computeState = manager.getForCompute( computeNode );
	assert.equal( computeState.computeShader, 'compute' );
	assert.equal( manager.getForCompute( computeNode ), computeState );
	assert.throws( () => manager.getForCompute( {} ), /only PrecompiledComputeNode/ );

	const groupNode = { version: 1 };
	const binding = { groupNode };
	assert.equal( manager.updateGroup( binding ), true );
	assert.equal( manager.updateGroup( binding ), false );
	groupNode.version ++;
	assert.equal( manager.updateGroup( binding ), true );

	const state = { updateBeforeNodes: [ { id: 'before' } ], updateNodes: [ { id: 'update' } ], updateAfterNodes: [ { id: 'after' } ] };
	const calls = [];
	manager.nodeFrame.updateBeforeNode = ( node ) => calls.push( node.id );
	manager.nodeFrame.updateNode = ( node ) => calls.push( node.id );
	manager.nodeFrame.updateAfterNode = ( node ) => calls.push( node.id );
	const ro = {
		renderer,
		scene: {}, object: {}, camera: {}, material: {},
		getNodeBuilderState: () => state,
		getMonitor: () => ( { needsRefresh: () => true } ),
	};
	manager.updateBefore( ro );
	manager.updateForRender( ro );
	manager.updateAfter( ro );
	assert.deepEqual( calls, [ 'before', 'update', 'after' ] );
	assert.equal( manager.needsRefresh( ro ), true );
	assert.equal( ( await manager.getForRenderAsync( renderObject( renderer, material() ) ) ).vertexShader, 'vertex' );
	const asyncFailure = manager.getForRenderAsync( renderObject( renderer, { type: 'Material' } ) );
	assert.ok( asyncFailure instanceof Promise );
	await assert.rejects( asyncFailure, /only PrecompiledMaterial/ );

	const oldFrame = manager.nodeFrame;
	manager.dispose();
	assert.notEqual( manager.nodeFrame, oldFrame );
	assert.equal( manager.nodeBuilderCache.size, 0 );

} );

test( 'replay NodeManager keeps fallback state per object and releases it', () => {

	const renderer = fakeRenderer();
	const manager = new ReplayNodeManager( renderer, renderer.backend );
	const released = [];
	const handler = ( ro ) => ( {
		vertexShader: 'fallback-v',
		fragmentShader: 'fallback-f',
		bindings: [ ro ],
		createBindings: () => [ { owner: ro } ],
		updateNodes: [],
		updateBeforeNodes: [],
		updateAfterNodes: [],
		observer: { needsRefresh: () => true },
	} );
	handler.release = ( ro ) => released.push( ro );
	setSlimRenderFallback( handler );
	try {

		const first = renderObject( renderer, { type: 'NodeMaterial' } );
		const second = renderObject( renderer, { type: 'NodeMaterial' } );
		const firstState = manager.getForRender( first );
		assert.notEqual( manager.getForRender( second ), firstState );
		assert.deepEqual( firstState.createBindings(), [ { owner: first } ] );
		manager.delete( first );
		assert.deepEqual( released, [ first ] );

	} finally {

		setSlimRenderFallback( null );

	}
	const unsupported = renderObject( renderer, { type: 'MeshStandardMaterial' } );
	assert.throws( () => manager.getForRender( unsupported ), ( error ) => error.tslPrecompileSlimOnly === true );

} );

test( 'replay NodeManager builds and normalizes legacy raw-builder fallbacks', () => {

	const renderer = fakeRenderer();
	const manager = new ReplayNodeManager( renderer, renderer.backend );
	let builds = 0;
	setSlimRenderFallback( () => ( {
		vertexShader: '', fragmentShader: '', computeShader: '',
		build() {

			builds ++;
			this.vertexShader = 'built-vertex';
			this.fragmentShader = 'built-fragment';

		},
		getAttributesArray: () => [ 'position' ],
		getBindings: () => [],
		updateNodes: [],
	} ) );
	try {

		const state = manager.getForRender( renderObject( renderer, { type: 'LegacyNodeMaterial' } ) );
		assert.equal( builds, 1 );
		assert.equal( state.vertexShader, 'built-vertex' );
		assert.deepEqual( state.nodeAttributes, [ 'position' ] );
		assert.equal( typeof state.createBindings, 'function' );
		assert.deepEqual( state.updateBeforeNodes, [] );

	} finally {

		setSlimRenderFallback( null );

	}

} );

test( 'replay NodeManager clears local object data when fallback release throws', () => {

	const renderer = fakeRenderer();
	const manager = new ReplayNodeManager( renderer, renderer.backend );
	const handler = () => ( { bindings: [], updateNodes: [] } );
	handler.release = () => { throw new Error( 'release failed' ); };
	setSlimRenderFallback( handler );
	const ro = renderObject( renderer, { type: 'NodeMaterial' } );
	try {

		manager.getForRender( ro );
		assert.equal( manager.has( ro ), true );
		assert.throws( () => manager.delete( ro ), /release failed/ );
		assert.equal( manager.has( ro ), false );

	} finally {

		setSlimRenderFallback( null );

	}

} );
