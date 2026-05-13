import test from 'node:test';
import assert from 'node:assert/strict';

import { createSlimSceneSupport } from '../src/slim-support/scene-support.js';

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
