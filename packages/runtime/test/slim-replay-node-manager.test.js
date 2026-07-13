import test from 'node:test';
import assert from 'node:assert/strict';

import ReplayNodeManager from '../src/slim-replay-node-manager.js';
import ReplayNodeFrame from '../src/slim-replay-node-frame.js';
import PrecompiledMaterial from '../src/_vendor-PrecompiledMaterial.js';
import { createReplayShadowMaterial } from '../src/slim-replay-shadow-material.js';
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
	assert.ok( frame instanceof ReplayNodeFrame );
	assert.equal( frame.renderer, renderer );
	assert.equal( frame.scene, live.scene );
	assert.equal( frame.object, live.object );
	assert.equal( frame.camera, live.camera );
	assert.equal( frame.material, live.material );
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

test( 'replay NodeManager applies the mesh-basic selector profile from material shape metadata', () => {

	const renderer = fakeRenderer();
	const signed = artifact( { materialShape: 'mesh-basic' } );
	const sourceMaterial = material( signed );
	const live = renderObject( renderer, sourceMaterial, {
		scene: { fog: { isFogExp2: true }, environment: null, environmentNode: null, traverse() {} },
	} );
	const captureDescriptor = JSON.parse( createRenderObjectContextSelector( live, renderer ) );
	captureDescriptor.scene.environment = { kind: '2d', mapping: 303, colorSpace: 'srgb-linear' };
	captureDescriptor.scene.environmentNode = true;
	signed.renderContextSelectors = [ JSON.stringify( captureDescriptor ) ];

	const manager = new ReplayNodeManager( renderer, renderer.backend );
	assert.doesNotThrow( () => manager.getForRender( live ) );

	const physical = artifact( {
		materialShape: 'mesh-physical',
		renderContextSelectors: signed.renderContextSelectors,
	} );
	assert.throws(
		() => new ReplayNodeManager( renderer, renderer.backend ).getForRender( renderObject( renderer, material( physical ), { scene: live.scene } ) ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
		'PBR material families keep strict scene environment selection',
	);

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

test( 'replay NodeManager isolates shared shadow replay state by exact caster identity', () => {

	const renderer = fakeRenderer();
	const signed = artifact( { materialShape: 'shadow-depth', bindingOwner: 'shadow-caster' } );
	const shadowMaterial = material( signed );
	shadowMaterial.isShadowPassMaterial = true;
	const casterA = { map: null, alphaMap: null, alphaTest: 0 };
	const casterB = { map: null, alphaMap: null, alphaTest: 0 };
	const firstA = renderObject( renderer, shadowMaterial, { object: { material: casterA } } );
	const secondA = renderObject( renderer, shadowMaterial, { object: { material: casterA } } );
	const firstB = renderObject( renderer, shadowMaterial, { object: { material: casterB } } );
	const manager = new ReplayNodeManager( renderer, renderer.backend );
	const stateA = manager.getForRender( firstA );
	assert.equal( manager.getForRender( secondA ), stateA, 'the same caster shares hydrated shadow state' );
	assert.notEqual( manager.getForRender( firstB ), stateA, 'same-topology caster instances cannot alias live binding state' );

} );

test( 'replay NodeManager does not reuse hydration after a material cache-key invalidation', () => {

	const renderer = fakeRenderer();
	const sourceMaterial = material();
	const manager = new ReplayNodeManager( renderer, renderer.backend );
	const first = renderObject( renderer, sourceMaterial );
	const firstState = manager.getForRender( first );
	const second = renderObject( renderer, sourceMaterial, { initialCacheKey: 43 } );
	assert.notEqual( manager.getForRender( second ), firstState );

} );

test( 'shadow topology invalidation reselects a signed artifact variant for the same caster overlay', () => {

	const renderer = fakeRenderer();
	const family = artifact( {
		cacheKey: 'without-map',
		materialShape: 'shadow-depth',
		bindingOwner: 'shadow-caster',
		fragmentShader: 'fragment-without-map',
	} );
	const base = new PrecompiledMaterial( family );
	base.isShadowPassMaterial = true;
	const caster = { version: 0, map: null, alphaMap: null, alphaTest: 0 };
	const overlay = createReplayShadowMaterial( base, caster );
	const makeRenderObject = ( initialCacheKey ) => renderObject( renderer, overlay, {
		initialCacheKey,
		object: { material: caster },
	} );
	const withoutMapSelector = createRenderObjectContextSelector( makeRenderObject( 100 ), renderer );
	const map = { isTexture: true, mapping: 300, magFilter: 1006, minFilter: 1008, wrapS: 1001, wrapT: 1001 };
	caster.map = map;
	createReplayShadowMaterial( base, caster );
	const withMapSelector = createRenderObjectContextSelector( makeRenderObject( 101 ), renderer );
	family.renderContextSelectors = [ withoutMapSelector ];
	family.variants = {
		'with-map': artifact( {
			cacheKey: 'with-map',
			materialShape: 'shadow-depth',
			bindingOwner: 'shadow-caster',
			fragmentShader: 'fragment-with-map',
			renderContextSelectors: [ withMapSelector ],
		} ),
	};

	const manager = new ReplayNodeManager( renderer, renderer.backend );
	caster.map = null;
	createReplayShadowMaterial( base, caster );
	const withoutMapState = manager.getForRender( makeRenderObject( 102 ) );
	assert.equal( withoutMapState.fragmentShader, 'fragment-without-map' );
	caster.map = map;
	createReplayShadowMaterial( base, caster );
	const withMapState = manager.getForRender( makeRenderObject( 103 ) );
	assert.equal( withMapState.fragmentShader, 'fragment-with-map' );
	assert.notEqual( withMapState, withoutMapState );

} );

test( 'replay NodeManager applies the post-process selector profile from artifact shape metadata', () => {

	const sourceRenderer = fakeRenderer();
	const signed = artifact( { materialShape: 'post-process' } );
	const replayMaterial = material( signed );
	replayMaterial.fog = false;
	const live = renderObject( sourceRenderer, replayMaterial );
	const captureDescriptor = JSON.parse( createRenderObjectContextSelector( live, sourceRenderer ) );
	captureDescriptor.material.fog = true;
	captureDescriptor.target = {
		...captureDescriptor.target,
		surface: 'output-intermediate',
		colors: [ { kind: 'render-target', format: 1023 } ],
		depthTexture: { kind: 'depth', format: 1026 },
	};
	signed.renderContextSelectors = [ JSON.stringify( captureDescriptor ) ];

	const manager = new ReplayNodeManager( sourceRenderer, sourceRenderer.backend );
	assert.doesNotThrow( () => manager.getForRender( live ) );

} );

test( 'replay NodeManager applies the scene-independent render-output selector profile', () => {

	const renderer = fakeRenderer();
	const signed = artifact( { materialShape: 'render-output' } );
	const replayMaterial = material( signed );
	const live = renderObject( renderer, replayMaterial );
	const captureDescriptor = JSON.parse( createRenderObjectContextSelector( live, renderer ) );
	captureDescriptor.scene = { environment: { kind: '2d', colorSpace: 'srgb-linear' } };
	captureDescriptor.lights = [ { type: 'DirectionalLight', castShadow: true } ];
	signed.renderContextSelectors = [ JSON.stringify( captureDescriptor ) ];

	const manager = new ReplayNodeManager( renderer, renderer.backend );
	assert.doesNotThrow( () => manager.getForRender( live ) );

} );

test( 'replay NodeManager shares one cube conversion state across faces and mips', () => {

	const renderer = fakeRenderer();
	const cubeArtifact = artifact( { materialShape: 'cube-render-target' } );
	const replayMaterial = material( cubeArtifact );
	const texture = {
		isTexture: true,
		isCubeTexture: true,
		isRenderTargetTexture: true,
		format: 1023,
		type: 1009,
		colorSpace: 'srgb-linear',
	};
	const target = {
		isCubeRenderTarget: true,
		texture,
		textures: [ texture ],
		depthBuffer: true,
		stencilBuffer: false,
		samples: 0,
	};
	const atFace = ( activeCubeFace, activeMipmapLevel ) => renderObject( renderer, replayMaterial, {
		context: {
			renderTarget: target,
			textures: [ texture ],
			activeCubeFace,
			activeMipmapLevel,
			sampleCount: 1,
		},
	} );
	const manager = new ReplayNodeManager( renderer, renderer.backend );
	const firstState = manager.getForRender( atFace( 0, 0 ) );
	const sixthFaceState = manager.getForRender( atFace( 5, 0 ) );
	const mipState = manager.getForRender( atFace( 2, 3 ) );

	assert.equal( sixthFaceState, firstState );
	assert.equal( mipState, firstState );
	assert.equal( manager.nodeBuilderCache.size, 1 );

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
