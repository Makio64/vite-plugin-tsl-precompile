import test from 'node:test';
import assert from 'node:assert/strict';

import { createSlimSceneSupport, pinClock, unpinClock } from '../src/slim-support/scene-support.js';

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

			this._rendered = { scene, camera };

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
	assert.equal( typeof support.shareTexture, 'function' );
	assert.equal( typeof support.shareShadowTexture, 'function' );

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

	const support = createSlimSceneSupport( { renderer: fakeRenderer() } );
	const tex = { isTexture: true, uuid: 'scene-tex', image: { width: 1, height: 1 } };
	const scene = {
		background: tex,
		traverse( visit ) { visit( { material: {} } ); },
	};
	support.indexScene( scene );
	const found = support.liveSceneIndex.texturesByUuid.get( 'scene-tex' );
	assert.equal( found, tex );

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

test( 'createSlimSceneSupport exposes pinClock/unpinClock that flip the same global', () => {

	const support = createSlimSceneSupport( { renderer: fakeRenderer() } );
	try {

		assert.equal( typeof support.pinClock, 'function' );
		assert.equal( typeof support.unpinClock, 'function' );
		support.pinClock( 0.5 );
		assert.equal( globalThis.__tslpPinnedClock, 0.5 );
		support.unpinClock();
		assert.equal( globalThis.__tslpPinnedClock, null );

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

test( 'createSlimSceneSupport renderPassWithFallback reports a missing fallback without throwing', async () => {

	const support = createSlimSceneSupport( { renderer: fakeRenderer(), fullRendererFallback: false } );
	let message = '';
	const stats = await support.renderPassWithFallback( { scene: {}, renderTarget: {} }, {
		onError: ( err ) => { message = err.message; },
	} );

	assert.deepEqual( stats, { rendered: false, texturesShared: 0, depthShared: false } );
	assert.match( message, /fullRendererFallback: true/ );

} );
