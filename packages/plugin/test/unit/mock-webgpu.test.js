import test from 'node:test';
import assert from 'node:assert/strict';
import { installMockWebGPU } from '../../src/mock-webgpu.js';

test( 'mock animation frame yields asynchronously with an active event-loop handle', async () => {

	const target = {};
	installMockWebGPU( target );
	let called = false;
	const frame = new Promise( ( resolve ) => target.requestAnimationFrame( ( timestamp ) => {

		called = true;
		resolve( timestamp );

	} ) );
	await Promise.resolve();
	assert.equal( called, false, 'frame callbacks do not run inline or in a microtask' );
	const timestamp = await frame;
	assert.equal( called, true );
	assert.ok( Number.isFinite( timestamp ) );

} );

test( 'mock animation frame cancellation releases the scheduled callback', async () => {

	const target = {};
	installMockWebGPU( target );
	let called = false;
	const handle = target.requestAnimationFrame( () => { called = true; } );
	target.cancelAnimationFrame( handle );
	await new Promise( ( resolve ) => target.requestAnimationFrame( resolve ) );
	assert.equal( called, false );

} );

test( 'mock installation preserves an existing animation-frame implementation', () => {

	const requestAnimationFrame = () => 1;
	const cancelAnimationFrame = () => {};
	const target = { requestAnimationFrame, cancelAnimationFrame };
	installMockWebGPU( target );
	assert.equal( target.requestAnimationFrame, requestAnimationFrame );
	assert.equal( target.cancelAnimationFrame, cancelAnimationFrame );

} );

test( 'mock GPU render bundle encoders satisfy the native class check', async () => {

	const target = {};
	installMockWebGPU( target );
	const adapter = await target.navigator.gpu.requestAdapter();
	const device = await adapter.requestDevice();
	const encoder = device.createRenderBundleEncoder();
	assert.ok( encoder instanceof target.GPURenderBundleEncoder );
	assert.doesNotThrow( () => encoder.setBindGroup( 0, {} ) );
	assert.equal( encoder.finish().__kind, 'RenderBundle' );
	const NativeEncoder = class NativeEncoder {};
	const nativeTarget = { GPURenderBundleEncoder: NativeEncoder };
	installMockWebGPU( nativeTarget );
	assert.equal( nativeTarget.GPURenderBundleEncoder, NativeEncoder );

} );
