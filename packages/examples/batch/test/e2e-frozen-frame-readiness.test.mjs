import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { waitForFrozenWebGPUFrame } from '../e2e-frozen-frame-readiness.mjs';

async function environment( run ) {

	const saved = Object.getOwnPropertyDescriptor( globalThis, 'window' );
	const pending = Promise.withResolvers();
	let calls = 0;
	const renderer = { _initialized: true, backend: { isWebGPUBackend: true, device: { queue: { onSubmittedWorkDone() { calls ++; return pending.promise; } } } } };
	const state = { __tslpFrozen: true, __tslpHarnessRenderer: renderer };
	state.__tslpHarnessGPUDevices = [ renderer.backend.device ];
	state.__tslpHarnessDiagnostics = { gpuObservation: { hookInstalled: true, requestDeviceCalls: 1, devicesObserved: 1 } };
	Object.defineProperty( globalThis, 'window', { value: state, configurable: true } );
	try { await run( { state, renderer, pending, calls: () => calls } ); }
	finally { if ( saved ) Object.defineProperty( globalThis, 'window', saved ); else delete globalThis.window; }

}

test( 'a frozen WebGPU frame needs actual queue completion and rechecks intervening work', async () => {

	await environment( async ( { state, pending, calls } ) => {

		let completed = false;
		const ready = waitForFrozenWebGPUFrame( 1000 ).then( result => { completed = true; return result; } );
		await Promise.resolve();
		assert.equal( completed, false );
		assert.equal( calls(), 1 );
		state.__tslpLoaderPending = 1;
		pending.resolve();
		assert.equal( await ready, false );
		state.__tslpLoaderPending = 0;
		assert.equal( await waitForFrozenWebGPUFrame( 1000 ), true );

	} );

} );

test( 'live and busy states keep waiting; unsupported backends never use the shortcut', async () => {

	await environment( async ( { state, renderer, calls } ) => {

		for ( const key of [ '__tslpLoaderPending', '__tslpCompilePending', '__tslpPmremPending', '__tslpShadowPending', '__tslpComputePending', '__tslpPrecompilePending', '__tslpAuxCapturePending' ] ) {

			state[ key ] = 1; assert.equal( await waitForFrozenWebGPUFrame( 20 ), false ); state[ key ] = 0;

		}
		state.__tslpFrozen = false; assert.equal( await waitForFrozenWebGPUFrame( 20 ), false ); state.__tslpFrozen = true;
		state.__tslpDeterministicTimeoutInstalled = true; assert.equal( await waitForFrozenWebGPUFrame( 20 ), false ); state.__tslpDeterministicTimeoutInstalled = false;
		renderer._initialized = false; assert.equal( await waitForFrozenWebGPUFrame( 20 ), false ); renderer._initialized = true;
		renderer.backend.isWebGPUBackend = false; assert.equal( await waitForFrozenWebGPUFrame( 20 ), false ); renderer.backend.isWebGPUBackend = true;
		renderer._isDeviceLost = true; assert.equal( await waitForFrozenWebGPUFrame( 20 ), false );
		assert.equal( calls(), 0 );

	} );

} );

test( 'the existing freeze signal can settle inside the budget before the queue is fenced', async () => {

	await environment( async ( { state, pending, calls } ) => {

		state.__tslpFrozen = false;
		state.__tslpCompilePending = 1;
		const ready = waitForFrozenWebGPUFrame( 1000 );
		assert.equal( calls(), 0 );
		state.__tslpFrozen = true;
		state.__tslpCompilePending = 0;
		pending.resolve();
		assert.equal( await ready, true );
		assert.equal( calls(), 1 );

	} );

} );

test( 'a second device observed during the freeze wait disables the shortcut', async () => {

	await environment( async ( { state, calls } ) => {

		state.__tslpFrozen = false;
		const ready = waitForFrozenWebGPUFrame( 1000 );
		state.__tslpHarnessDiagnostics.gpuObservation.requestDeviceCalls = 2;
		state.__tslpFrozen = true;
		assert.equal( await ready, false );
		assert.equal( calls(), 0 );

	} );

} );

test( 'stalled work retains the wait budget and queue failures remain failures', async () => {

	await environment( async ( { pending } ) => {

		assert.equal( await waitForFrozenWebGPUFrame( 5 ), false );
		const failure = new Error( 'Device lost' );
		const ready = waitForFrozenWebGPUFrame( 1000 ); pending.reject( failure );
		await assert.rejects( ready, error => error === failure );

	} );

} );

test( 'unobserved or multiple devices retain the ordinary brightness budget', async () => {

	await environment( async ( { state, renderer, calls } ) => {

		state.__tslpHarnessGPUDevices = []; assert.equal( await waitForFrozenWebGPUFrame( 20 ), false );
		state.__tslpHarnessGPUDevices = [ renderer.backend.device, {} ]; assert.equal( await waitForFrozenWebGPUFrame( 20 ), false );
		state.__tslpHarnessGPUDevices = [ renderer.backend.device ];
		state.__tslpHarnessDiagnostics.gpuObservation.requestDeviceCalls = 2;
		assert.equal( await waitForFrozenWebGPUFrame( 20 ), false );
		assert.equal( calls(), 0 );

	} );

} );

test( 'the helper works when serialized into an independent browser-like realm', async () => {

	await environment( async ( { state, pending } ) => {

		pending.resolve();
		const result = await runInNewContext( '(' + waitForFrozenWebGPUFrame.toString() + ')(1000)', { window: state, setTimeout, clearTimeout } );
		assert.equal( result, true );

	} );

} );
