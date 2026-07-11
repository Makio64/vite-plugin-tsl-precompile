import test from 'node:test';
import assert from 'node:assert/strict';

import { createFullRendererFallback } from '../src/slim-support/full-renderer-fallback.js';

function fakeSlimRenderer( { device = { id: 'gpu-shared' }, reversedDepthBuffer } = {} ) {

	const renderer = { backend: { device } };
	if ( reversedDepthBuffer !== undefined ) renderer.reversedDepthBuffer = reversedDepthBuffer;
	return renderer;

}

function makeFullRendererClass( { onConstruct, failInit = false, initDelayMs = 0 } = {} ) {

	let instances = 0;
	class FakeFull {

		constructor( options = {} ) {

			instances ++;
			this.constructedAt = instances;
			this.options = options;
			this.shadowMap = { enabled: false };
			this.initialised = false;
			this.disposed = false;
			if ( typeof onConstruct === 'function' ) onConstruct( this );

		}
		async init() {

			if ( initDelayMs > 0 ) await new Promise( ( r ) => setTimeout( r, initDelayMs ) );
			if ( failInit ) throw new Error( 'init-blown' );
			this.initialised = true;

		}
		dispose() { this.disposed = true; }

	}
	return { FakeFull, getInstances: () => instances };

}

test( 'createFullRendererFallback boots a renderer with the shared device on first getRenderer()', async () => {

	const slim = fakeSlimRenderer();
	const { FakeFull, getInstances } = makeFullRendererClass();
	const fallback = createFullRendererFallback( {
		slimRenderer: slim,
		WebGPURendererClass: FakeFull,
	} );

	assert.equal( fallback.isInitialised(), false );
	const r = await fallback.getRenderer();
	assert.ok( r );
	assert.equal( r.initialised, true );
	assert.equal( r.options.device, slim.backend.device, 'reused the slim device' );
	assert.equal( r.shadowMap.enabled, true );
	assert.equal( getInstances(), 1 );
	assert.equal( fallback.isInitialised(), true );

} );

test( 'createFullRendererFallback de-duplicates concurrent calls into a single boot promise', async () => {

	const slim = fakeSlimRenderer();
	const { FakeFull, getInstances } = makeFullRendererClass( { initDelayMs: 10 } );
	const fallback = createFullRendererFallback( {
		slimRenderer: slim,
		WebGPURendererClass: FakeFull,
	} );

	const [ a, b, c ] = await Promise.all( [
		fallback.getRenderer(),
		fallback.getRenderer(),
		fallback.getRenderer(),
	] );
	assert.equal( a, b );
	assert.equal( b, c );
	assert.equal( getInstances(), 1, 'only one renderer constructed' );

} );

test( 'createFullRendererFallback forwards reversedDepthBuffer when slim has it set', async () => {

	const slim = fakeSlimRenderer( { reversedDepthBuffer: true } );
	const { FakeFull } = makeFullRendererClass();
	const fallback = createFullRendererFallback( {
		slimRenderer: slim,
		WebGPURendererClass: FakeFull,
	} );
	const r = await fallback.getRenderer();
	assert.equal( r.options.reversedDepthBuffer, true );

} );

test( 'createFullRendererFallback honours shadowMapEnabled: false', async () => {

	const slim = fakeSlimRenderer();
	const { FakeFull } = makeFullRendererClass();
	const fallback = createFullRendererFallback( {
		slimRenderer: slim,
		WebGPURendererClass: FakeFull,
		shadowMapEnabled: false,
	} );
	const r = await fallback.getRenderer();
	assert.equal( r.shadowMap.enabled, false );

} );

test( 'createFullRendererFallback returns null and calls onError when init fails', async () => {

	const slim = fakeSlimRenderer();
	const { FakeFull } = makeFullRendererClass( { failInit: true } );
	const errs = [];
	const fallback = createFullRendererFallback( {
		slimRenderer: slim,
		WebGPURendererClass: FakeFull,
		onError: ( err ) => errs.push( err.message ),
	} );
	const r = await fallback.getRenderer();
	assert.equal( r, null );
	assert.deepEqual( errs, [ 'init-blown' ] );
	assert.equal( fallback.isInitialised(), false );

} );

test( 'createFullRendererFallback retries after a transient boot failure', async () => {

	const slim = fakeSlimRenderer();
	let attempts = 0;
	class FlakyFull {

		constructor() {

			this.shadowMap = { enabled: false };

		}
		async init() {

			attempts ++;
			if ( attempts === 1 ) throw new Error( 'transient-init' );

		}
		dispose() {}

	}
	const errors = [];
	const fallback = createFullRendererFallback( {
		slimRenderer: slim,
		WebGPURendererClass: FlakyFull,
		onError: ( error ) => errors.push( error.message ),
	} );

	assert.equal( await fallback.getRenderer(), null );
	assert.ok( await fallback.getRenderer(), 'second call should retry the boot' );
	assert.equal( attempts, 2 );
	assert.deepEqual( errors, [ 'transient-init' ] );

} );

test( 'createFullRendererFallback lazily loads the three module via loadThreeFullModule', async () => {

	const slim = fakeSlimRenderer();
	const { FakeFull } = makeFullRendererClass();
	let loadCount = 0;
	const fallback = createFullRendererFallback( {
		slimRenderer: slim,
		loadThreeFullModule: async () => { loadCount ++; return { WebGPURenderer: FakeFull }; },
	} );
	assert.equal( fallback.getModule(), null );
	const r = await fallback.getRenderer();
	assert.ok( r );
	assert.equal( loadCount, 1 );
	assert.ok( fallback.getModule() );

} );

test( 'createFullRendererFallback dispose() clears the booted renderer', async () => {

	const slim = fakeSlimRenderer();
	const { FakeFull, getInstances } = makeFullRendererClass();
	const fallback = createFullRendererFallback( {
		slimRenderer: slim,
		WebGPURendererClass: FakeFull,
	} );
	const r = await fallback.getRenderer();
	fallback.dispose();
	assert.equal( r.disposed, true );
	assert.equal( fallback.isInitialised(), false );

	// A subsequent getRenderer() boots fresh.
	const r2 = await fallback.getRenderer();
	assert.notEqual( r2, r );
	assert.equal( getInstances(), 2 );

} );

test( 'createFullRendererFallback dispose() cancels an in-flight boot without resurrection', async () => {

	const slim = fakeSlimRenderer();
	const constructed = [];
	const { FakeFull, getInstances } = makeFullRendererClass( {
		initDelayMs: 10,
		onConstruct: ( renderer ) => constructed.push( renderer ),
	} );
	const fallback = createFullRendererFallback( {
		slimRenderer: slim,
		WebGPURendererClass: FakeFull,
	} );

	const pending = fallback.getRenderer();
	fallback.dispose();
	assert.equal( await pending, null );
	assert.equal( constructed[ 0 ].disposed, true );
	assert.equal( fallback.isInitialised(), false );

	const next = await fallback.getRenderer();
	assert.ok( next );
	assert.equal( getInstances(), 2 );
	assert.equal( fallback.isInitialised(), true );

} );

test( 'createFullRendererFallback throws synchronously when slimRenderer missing', () => {

	assert.throws( () => createFullRendererFallback( {} ), /opts\.slimRenderer is required/ );

} );

test( 'createFullRendererFallback returns null when no module source supplied', async () => {

	const slim = fakeSlimRenderer();
	const errs = [];
	const fallback = createFullRendererFallback( {
		slimRenderer: slim,
		onError: ( err ) => errs.push( err.message ),
	} );
	const r = await fallback.getRenderer();
	assert.equal( r, null );
	assert.equal( errs.length, 1 );
	assert.match( errs[ 0 ], /no full-three module available/ );

} );

test( 'createFullRendererFallback rejects an eagerly supplied slim namespace', () => {

	const slim = fakeSlimRenderer();
	const { FakeFull } = makeFullRendererClass();
	assert.throws( () => createFullRendererFallback( {
		slimRenderer: slim,
		threeFullModule: { __TSLP_SLIM__: true, WebGPURenderer: FakeFull },
	} ), /virtual:tsl-precompile\/full-three/ );

} );

test( 'createFullRendererFallback rejects a constructor marked as slim', () => {

	const slim = fakeSlimRenderer();
	const { FakeFull } = makeFullRendererClass();
	FakeFull.__TSLP_SLIM__ = true;
	assert.throws( () => createFullRendererFallback( {
		slimRenderer: slim,
		WebGPURendererClass: FakeFull,
	} ), /WebGPURendererClass is the slim renderer/ );

} );

test( 'createFullRendererFallback refuses a lazily loaded slim namespace', async () => {

	const slim = fakeSlimRenderer();
	const { FakeFull } = makeFullRendererClass();
	const errs = [];
	const fallback = createFullRendererFallback( {
		slimRenderer: slim,
		loadThreeFullModule: async () => ( { __TSLP_SLIM__: true, WebGPURenderer: FakeFull } ),
		onError: ( err ) => errs.push( err.message ),
	} );
	assert.equal( await fallback.getRenderer(), null );
	assert.equal( fallback.isInitialised(), false );
	assert.match( errs[ 0 ], /loadThreeFullModule\(\) result is the slim renderer/ );

} );
