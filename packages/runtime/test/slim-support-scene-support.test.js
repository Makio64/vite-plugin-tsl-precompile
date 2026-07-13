import test from 'node:test';
import assert from 'node:assert/strict';

import { createSlimSceneSupport, pinClock, unpinClock } from '../src/slim-support/scene-support.js';
import { getSlimRenderFallback, setSlimRenderFallback } from '../src/slim-support/render-fallback-registry.js';
import { clearLiveTextureIndex } from '../src/hydrator.js';
import { lookupLiveTextureByIdentity } from '../src/hydrate/live-texture-registry.js';
import { getTemporalFrameState } from '../src/slim-support/temporal-frame.js';

function fakeDataMap() {

	const store = new WeakMap();
	return { store, get( key ) { let e = store.get( key ); if ( ! e ) { e = {}; store.set( key, e ); } return e; } };

}

function fakeRenderer( { device = { id: 'gpu-shared' } } = {} ) {

	const backend = fakeDataMap();
	const _textures = fakeDataMap();
	const _attributes = fakeDataMap();
	backend.device = device ? { ...device, queue: { submit() {} }, createCommandEncoder: () => ( { copyBufferToBuffer() {}, finish: () => ( {} ) } ) } : null;
	backend.generateMipmaps = () => {};
	return { backend, _textures, _attributes, _bindings: { getForCompute: () => [] } };

}

function fakePassFullRenderer() {

	const renderer = fakeRenderer();
	Object.assign( renderer, {
		autoClear: false,
		transparent: false,
		opaque: true,
		_target: null,
		_mrt: null,
		getRenderTarget() { return this._target; },
		setRenderTarget( target ) { this._target = target; },
		getMRT() { return this._mrt; },
		setMRT( mrt ) { this._mrt = mrt; },
		render( scene, camera ) {

			this._rendered = { scene, camera, mrt: this._mrt };

		},
	} );
	return renderer;

}

class FakeFullRenderer {

	constructor( options = {} ) {

		this.options = options;
		this.shadowMap = { enabled: false };
		this.initialised = false;

	}
	async init() { this.initialised = true; }
	dispose() { this.disposed = true; }

}

class FakeFullRendererWithPrivateNodes extends FakeFullRenderer {

	async init() {

		await super.init();
		this._nodes = {
			getForRender( renderObject ) {

				const state = {
					vertexShader: 'vertex',
					fragmentShader: 'fragment',
					computeShader: '',
					nodeAttributes: [ 'position' ],
					bindings: [ 'group' ],
					updateNodes: [ 'update' ],
					updateBeforeNodes: [ 'before' ],
					updateAfterNodes: [ 'after' ],
					observer: 'observer',
					transforms: [ 'transform' ],
					renderObject,
				};
				state.createBindings = () => [ { cloneFor: renderObject } ];
				return state;

			},
			delete( renderObject ) { this.released = renderObject; },
		};

	}

}

class FakeFullRendererWithCompute extends FakeFullRendererWithPrivateNodes {

	async init() {

		await super.init();
		this._bindings = { getForCompute: () => [] };

	}

	compute( computeNode, ...rest ) {

		this.computed = { computeNode, rest };

	}

}

class FakeFullRendererWithBuilderOnly extends FakeFullRenderer {

	async init() {

		await super.init();
		this._nodes = {
			_createNodeBuilder( renderObject ) {

				return {
					vertexShader: '', fragmentShader: '', computeShader: '',
					build() { this.vertexShader = 'built-vertex'; this.fragmentShader = 'built-fragment'; },
					getAttributesArray: () => [ 'position' ],
					getBindings: () => [],
					updateNodes: [],
					renderObject,
				};

			},
		};

	}

}

test( 'createSlimSceneSupport requires a renderer', () => {

	assert.throws( () => createSlimSceneSupport( {} ), /opts\.renderer is required/ );

} );

test( 'createSlimSceneSupport exposes the four sub-helpers by default (no fallback)', () => {

	const support = createSlimSceneSupport( { renderer: fakeRenderer() } );
	assert.ok( support.liveSceneIndex );
	assert.ok( support.pmrem );
	assert.equal( support.fallback, null );
	assert.equal( typeof support.indexScene, 'function' );
	assert.equal( typeof support.syncComputeOutputs, 'function' );
	assert.equal( typeof support.shareComputeInputs, 'function' );
	assert.equal( typeof support.shareTexture, 'function' );
	assert.equal( typeof support.shareShadowTexture, 'function' );
	assert.equal( typeof support.updateRendererLighting, 'function' );
	assert.equal( typeof support.renderOffscreenOverrideWithFallback, 'function' );

} );

test( 'createSlimSceneSupport boots the fallback renderer on demand', async () => {

	const slim = fakeRenderer();
	const support = createSlimSceneSupport( {
		renderer: slim,
		fullRendererFallback: true,
		threeFullModule: { WebGPURenderer: FakeFullRenderer },
	} );

	assert.ok( support.fallback );
	const full = await support.getFullRenderer();
	assert.ok( full instanceof FakeFullRenderer );
	assert.equal( full.options.device, slim.backend.device, 'fallback shares the GPU device' );
	assert.equal( full.initialised, true );

} );

test( 'createSlimSceneSupport ensureFallback registers private _nodes as a slim builder fallback', async () => {

	setSlimRenderFallback( null );
	const renderObject = { material: { type: 'NodeMaterial' } };
	const support = createSlimSceneSupport( {
		renderer: fakeRenderer(),
		fullRendererFallback: true,
		threeFullModule: { WebGPURenderer: FakeFullRendererWithPrivateNodes },
	} );

	try {

		await support.ensureFallback();
		const fallback = getSlimRenderFallback();
		assert.equal( typeof fallback, 'function' );
		const builder = fallback( renderObject );
		assert.equal( builder.vertexShader, 'vertex' );
		assert.deepEqual( builder.getAttributesArray(), [ 'position' ] );
		assert.deepEqual( builder.getBindings(), [ 'group' ] );
		assert.deepEqual( builder.createBindings(), [ { cloneFor: renderObject } ] );
		assert.equal( typeof builder.build, 'function' );
		assert.equal( typeof builder.buildAsync, 'function' );
		fallback.release( renderObject );
		assert.equal( ( await support.getFullRenderer() )._nodes.released, renderObject );

	} finally {

		support.dispose();
		setSlimRenderFallback( null );

	}

} );

test( 'createSlimSceneSupport builds legacy private node builders before fallback replay', async () => {

	setSlimRenderFallback( null );
	const support = createSlimSceneSupport( {
		renderer: fakeRenderer(),
		fullRendererFallback: true,
		threeFullModule: { WebGPURenderer: FakeFullRendererWithBuilderOnly },
	} );
	try {

		await support.ensureFallback();
		const state = getSlimRenderFallback()( { material: { type: 'LegacyNodeMaterial' } } );
		assert.equal( state.vertexShader, 'built-vertex' );
		assert.equal( state.fragmentShader, 'built-fragment' );
		assert.deepEqual( state.getAttributesArray(), [ 'position' ] );
		assert.deepEqual( state.createBindings(), [] );

	} finally {

		support.dispose();
		setSlimRenderFallback( null );

	}

} );

test( 'createSlimSceneSupport ensureFallback installs raw compute fallback on the slim renderer', async () => {

	const slim = fakeRenderer();
	let originalComputeNode = null;
	slim.compute = ( node ) => { originalComputeNode = node; return 'original'; };
	const support = createSlimSceneSupport( {
		renderer: slim,
		fullRendererFallback: true,
		threeFullModule: { WebGPURenderer: FakeFullRendererWithCompute },
	} );

	try {

		await support.ensureFallback();
		const full = await support.getFullRenderer();
		const rawCompute = { isComputeNode: true };
		const precompiledCompute = { isComputeNode: true, isPrecompiledCompute: true };

		const stats = slim.compute( rawCompute, 12 );
		assert.equal( full.computed.computeNode, rawCompute );
		assert.deepEqual( full.computed.rest, [ 12 ] );
		assert.equal( stats.pass, 0 );

		assert.equal( slim.compute( precompiledCompute ), 'original' );
		assert.equal( originalComputeNode, precompiledCompute );

		support.dispose();
		assert.equal( slim.compute( precompiledCompute ), 'original' );

	} finally {

		support.dispose();
		setSlimRenderFallback( null );

	}

} );

test( 'createSlimSceneSupport syncComputeOutputs no-ops without throwing on an empty bind-group list', () => {

	const slim = fakeRenderer();
	const fullSrc = fakeRenderer();
	const support = createSlimSceneSupport( { renderer: slim } );
	const stats = support.syncComputeOutputs( 'compute-node', fullSrc );
	assert.deepEqual( stats, { texturesShared: 0, buffersAdopted: 0, buffersCopied: 0 } );

} );

test( 'createSlimSceneSupport dispose() tears the fallback renderer down', async () => {

	const support = createSlimSceneSupport( {
		renderer: fakeRenderer(),
		fullRendererFallback: true,
		threeFullModule: { WebGPURenderer: FakeFullRenderer },
	} );
	const full = await support.getFullRenderer();
	support.dispose();
	assert.equal( full.disposed, true );
	assert.equal( support.fallback.isInitialised(), false );

} );

test( 'createSlimSceneSupport shareTexture forwards diagnostics into the shared bag', () => {

	const slim = fakeRenderer();
	const sourceRenderer = fakeRenderer();
	const tex = { isTexture: true, name: 'shared' };
	sourceRenderer.backend.get( tex ).texture = { __gpu: 'shared-tex' };
	const support = createSlimSceneSupport( { renderer: slim } );

	const ok = support.shareTexture( sourceRenderer, tex );
	assert.equal( ok, true );
	assert.equal( support.diagnostics.textureShare.calls, 1 );
	assert.equal( support.diagnostics.textureShare.success, 1 );

} );

test( 'createSlimSceneSupport indexScene walks scene.traverse + registers textures', () => {

	clearLiveTextureIndex();
	const support = createSlimSceneSupport( { renderer: fakeRenderer() } );
	const tex = { isTexture: true, uuid: 'scene-tex', name: 'scene-color.png', image: { width: 1, height: 1 } };
	const scene = {
		background: tex,
		traverse( visit ) { visit( { material: {} } ); },
	};
	support.indexScene( scene );
	const found = support.liveSceneIndex.texturesByUuid.get( 'scene-tex' );
	assert.equal( found, tex );
	assert.equal( lookupLiveTextureByIdentity( { textureName: 'scene-color.png' } ), tex );
	clearLiveTextureIndex();

} );

test( 'createSlimSceneSupport patches provided TextureLoader classes for artifact relinking', () => {

	clearLiveTextureIndex();
	class FakeTextureLoader {

		load( url, onLoad ) {

			const texture = { isTexture: true, uuid: 'loaded-tex', name: '', userData: {}, image: null };
			if ( typeof onLoad === 'function' ) onLoad( texture );
			return texture;

		}

	}

	const support = createSlimSceneSupport( {
		renderer: fakeRenderer(),
		threeModule: { TextureLoader: FakeTextureLoader },
	} );
	assert.equal( support.diagnostics.loader.patchedClasses, 1 );

	const texture = new FakeTextureLoader().load( 'textures/Caustic_Free.jpg' );
	assert.equal( texture.userData.__tslpLoaderUrl, 'textures/Caustic_Free.jpg' );
	assert.equal( texture.name, 'Caustic_Free.jpg' );
	assert.equal( lookupLiveTextureByIdentity( { imageSrc: 'textures/Caustic_Free.jpg' } ), texture );
	clearLiveTextureIndex();

} );

test( 'createSlimSceneSupport patches lazy full-module TextureLoader classes after boot', async () => {

	clearLiveTextureIndex();
	class FakeTextureLoader {

		load( url ) {

			return { isTexture: true, uuid: 'lazy-loaded-tex', name: '', userData: {}, image: null };

		}

	}
	const support = createSlimSceneSupport( {
		renderer: fakeRenderer(),
		fullRendererFallback: true,
		loadThreeFullModule: async () => ( {
			WebGPURenderer: FakeFullRenderer,
			TextureLoader: FakeTextureLoader,
		} ),
	} );

	await support.getFullRenderer();
	const texture = new FakeTextureLoader().load( 'textures/lazy-caustic.jpg' );
	assert.equal( texture.userData.__tslpLoaderUrl, 'textures/lazy-caustic.jpg' );
	assert.equal( lookupLiveTextureByIdentity( { textureName: 'lazy-caustic.jpg' } ), texture );
	clearLiveTextureIndex();

} );

test( 'createSlimSceneSupport generatePMREMAsync demands an explicit generator function', async () => {

	const support = createSlimSceneSupport( { renderer: fakeRenderer() } );
	await assert.rejects(
		() => support.generatePMREMAsync( { isTexture: true } ),
		/needs a `\(renderer, sourceTexture\) => Promise/,
	);

} );

test( 'createSlimSceneSupport generatePMREMAsync routes through the PMREM cache on first call', async () => {

	const support = createSlimSceneSupport( { renderer: fakeRenderer() } );
	// `image` is required so the PMREM cache's textureImageReady() returns true.
	const source = { isTexture: true, name: 'env.hdr', image: { width: 256, height: 256 } };
	const pmremResult = { isTexture: true, name: 'PMREM.cubeUv' };
	const generator = async ( _, src ) => {

		assert.equal( src, source );
		return pmremResult;

	};
	const out = await support.generatePMREMAsync( source, generator );
	assert.equal( out, pmremResult );
	// Cache hit on the second call → does not re-invoke the generator.
	let secondCalled = false;
	const cached = await support.generatePMREMAsync( source, async () => { secondCalled = true; return pmremResult; } );
	assert.equal( cached, pmremResult );
	assert.equal( secondCalled, false );

} );

test( 'pinClock(t) stores a finite number on globalThis.__tslpPinnedClock', () => {

	try {

		pinClock( 1.25 );
		assert.equal( globalThis.__tslpPinnedClock, 1.25 );
		pinClock( 0 );
		assert.equal( globalThis.__tslpPinnedClock, 0 );

	} finally {

		unpinClock();

	}

} );

test( 'pinClock with a non-finite value clears the pin', () => {

	try {

		pinClock( 7 );
		assert.equal( globalThis.__tslpPinnedClock, 7 );
		pinClock( NaN );
		assert.equal( globalThis.__tslpPinnedClock, null );
		pinClock( 9 );
		pinClock( Infinity );
		assert.equal( globalThis.__tslpPinnedClock, null );
		pinClock( 3 );
		pinClock( 'oops' );
		assert.equal( globalThis.__tslpPinnedClock, null );

	} finally {

		unpinClock();

	}

} );

test( 'unpinClock() clears the pin', () => {

	pinClock( 42 );
	assert.equal( globalThis.__tslpPinnedClock, 42 );
	unpinClock();
	assert.equal( globalThis.__tslpPinnedClock, null );

} );

test( 'createSlimSceneSupport exposes clock and logical-frame scopes', () => {

	const renderer = fakeRenderer();
	const support = createSlimSceneSupport( { renderer } );
	try {

		assert.equal( typeof support.pinClock, 'function' );
		assert.equal( typeof support.unpinClock, 'function' );
		support.pinClock( 0.5 );
		assert.equal( globalThis.__tslpPinnedClock, 0.5 );
		support.unpinClock();
		assert.equal( globalThis.__tslpPinnedClock, null );
		assert.equal( typeof support.withTemporalFrame, 'function' );
		support.withTemporalFrame( { frameId: 4, advance: false }, () => {

			assert.deepEqual( getTemporalFrameState( renderer ), { frameId: 4, time: null, advance: false } );

		} );
		assert.equal( getTemporalFrameState( renderer ), null );

	} finally {

		unpinClock();

	}

} );

test( 'createSlimSceneSupport renderPassWithFallback renders through a full renderer and shares pass textures', async () => {

	const slim = fakeRenderer();
	const full = fakePassFullRenderer();
	const support = createSlimSceneSupport( { renderer: slim } );
	const texture = { isTexture: true, name: 'pass-color', version: 5 };
	const depthTexture = { isTexture: true, name: 'pass-depth', version: 6 };
	full.backend.get( texture ).texture = { gpu: 'color' };
	full.backend.get( depthTexture ).texture = { gpu: 'depth' };
	const passNode = {
		scene: { isScene: true },
		camera: { isCamera: true },
		renderTarget: { texture, depthTexture },
	};

	const stats = await support.renderPassWithFallback( passNode, { fullRenderer: full } );

	assert.deepEqual( stats, { rendered: true, texturesShared: 1, depthShared: true } );
	assert.equal( full._rendered.scene, passNode.scene );
	assert.equal( slim.backend.get( texture ).texture, full.backend.get( texture ).texture );
	assert.equal( slim.backend.get( depthTexture ).texture, full.backend.get( depthTexture ).texture );

} );

test( 'createSlimSceneSupport renderOffscreenOverrideWithFallback renders current override target and shares textures', async () => {

	const slim = fakeRenderer();
	const full = fakePassFullRenderer();
	const support = createSlimSceneSupport( { renderer: slim } );
	const texture = { isTexture: true, name: 'override-color', version: 9 };
	const depthTexture = { isTexture: true, name: 'override-depth', version: 10 };
	const renderTarget = { texture, depthTexture };
	const scene = { isScene: true, overrideMaterial: { name: 'depth-override' } };
	const camera = { isCamera: true };
	full.backend.get( texture ).texture = { gpu: 'override-color' };
	full.backend.get( depthTexture ).texture = { gpu: 'override-depth' };

	const stats = await support.renderOffscreenOverrideWithFallback( scene, camera, {
		fullRenderer: full,
		renderTarget,
	} );

	assert.deepEqual( stats, { rendered: true, texturesShared: 1, depthShared: true } );
	assert.equal( full._rendered.scene, scene );
	assert.equal( full._rendered.camera, camera );
	assert.equal( slim.backend.get( texture ).texture, full.backend.get( texture ).texture );
	assert.equal( slim.backend.get( depthTexture ).texture, full.backend.get( depthTexture ).texture );

} );

test( 'createSlimSceneSupport renderPassWithFallback shares MRT color attachments', async () => {

	const slim = fakeRenderer();
	const full = fakePassFullRenderer();
	const support = createSlimSceneSupport( { renderer: slim } );
	const colorA = { isTexture: true, name: 'mrt-output', version: 7 };
	const colorB = { isTexture: true, name: 'mrt-normal', version: 8 };
	full.backend.get( colorA ).texture = { gpu: 'mrt-output' };
	full.backend.get( colorB ).texture = { gpu: 'mrt-normal' };
	const passNode = {
		scene: { isScene: true },
		camera: { isCamera: true },
		renderTarget: { textures: [ colorA, colorB ] },
		_mrt: { outputNodes: { output: {}, normal: {} } },
	};

	const stats = await support.renderPassWithFallback( passNode, { fullRenderer: full } );

	assert.deepEqual( stats, { rendered: true, texturesShared: 2, depthShared: false } );
	assert.equal( full._rendered.mrt, passNode._mrt );
	assert.equal( slim.backend.get( colorA ).texture, full.backend.get( colorA ).texture );
	assert.equal( slim.backend.get( colorB ).texture, full.backend.get( colorB ).texture );

} );

test( 'createSlimSceneSupport renderPassWithFallback reports a missing fallback without throwing', async () => {

	const support = createSlimSceneSupport( { renderer: fakeRenderer(), fullRendererFallback: false } );
	let message = '';
	const stats = await support.renderPassWithFallback( { scene: {}, renderTarget: {} }, {
		onError: ( err ) => { message = err.message; },
	} );

	assert.deepEqual( stats, { rendered: false, texturesShared: 0, depthShared: false } );
	assert.match( message, /fullRendererFallback: true/ );

} );
