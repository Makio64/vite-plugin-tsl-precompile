import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { deterministicTimeoutPolicyForExample, holdAnimationUntilReadyForExample, installAnimationLoopOwnerReadiness, installAnimationLoopSettleTransition, installAudioAnalyserReadiness, minimumAnimationLoopOwnersForExample, minimumRenderableObjectsForExample, settleFramesForExample, targetTickForExample } from '../e2e-settle-policy.mjs';
import { minimumBrightFractionForExample, pixelGateDisabledReasonForExample } from '../psnr.mjs';

function transitionForTest() {

	return installAnimationLoopSettleTransition( {} );

}

test( 'the Playwright init-script installer is self-contained', () => {

	const transition = runInNewContext( `( ${ installAnimationLoopSettleTransition.toString() } )()` );
	assert.equal( typeof transition, 'function' );
	assert.deepEqual( { ...transition( { atTarget: true, settleFrames: 1 } ) }, {
		animationLoopCalls: 1,
		runCallback: true,
	} );

} );

test( 'multi-renderer readiness requires successful callbacks from every owner', () => {

	const target = {};
	const readiness = installAnimationLoopOwnerReadiness( target );
	const ownerA = {};
	const ownerB = {};
	const callback = () => {};
	const stateA = readiness.register( ownerA, callback );
	stateA.animationLoopCalls = 2;
	stateA.successfulCallbacks = 2;
	readiness.sync();

	assert.equal( readiness.ready( 2, 1 ), false, 'one renderer cannot consume both readiness claims' );
	const stateB = readiness.register( ownerB, callback );
	assert.equal( readiness.ready( 2, 1 ), false, 'registration alone is not a presented frame' );
	stateB.animationLoopCalls = 1;
	readiness.sync();
	assert.equal( readiness.ready( 2, 1 ), false, 'an allowed callback does not count before it returns successfully' );
	stateB.successfulCallbacks = 1;
	readiness.sync();
	assert.equal( readiness.ready( 2, 1 ), true );
	assert.equal( target.__tslpAnimationLoopCalls, 1, 'legacy diagnostics expose the least-settled owner' );
	assert.deepEqual( readiness.snapshot(), [
		{ animationLoopCalls: 2, successfulCallbacks: 2 },
		{ animationLoopCalls: 1, successfulCallbacks: 1 },
	] );

	readiness.register( ownerB, null );
	assert.equal( readiness.ready( 2, 1 ), false );
	assert.equal( target.__tslpAnimationLoopRegistered, true );

} );

test( 'the animation-loop owner installer is self-contained for browser evaluation', () => {

	const result = runInNewContext( `
		const target = {};
		const api = ( ${ installAnimationLoopOwnerReadiness.toString() } )( target );
		const state = api.register( {}, () => {} );
		state.successfulCallbacks = 1;
		api.sync();
		[ api.ready( 1, 1 ), target.__tslpAnimationLoopRegistered, target.__tslpAnimationLoopCalls ];
	` );
	assert.deepEqual( [ ...result ], [ true, true, 0 ] );

} );

test( 'bitonic sort requires both renderer animation-loop owners', () => {

	assert.equal( minimumAnimationLoopOwnersForExample( 'webgpu_compute_sort_bitonic.html' ), 2 );
	assert.equal( minimumAnimationLoopOwnersForExample( 'webgpu_materials.html' ), 1 );

} );

test( 'audio analyser readiness holds capture until asynchronous audio setup completes', () => {

	const analyser = {};
	let energy = 0;
	let nativeReads = 0;
	analyser.getByteFrequencyData = ( values ) => {

		nativeReads ++;
		values[ 0 ] = energy;

	};
	class AudioContext {}
	AudioContext.prototype.createAnalyser = function () {

		assert.equal( this, context );
		return analyser;

	};
	let now = 10;
	const target = {
		AudioContext,
		__tslpLoaderPending: 2,
		__tslpLoaderLastBusyAt: 0,
		__tslpRealNow: () => now,
	};
	const context = new AudioContext();

	assert.equal( installAudioAnalyserReadiness( target ), true );
	assert.equal( target.__tslpLoaderPending, 3 );
	assert.equal( target.__tslpLoaderLastBusyAt, 10 );
	assert.equal( target.__tslpAudioAnalyserReady, false );
	assert.equal( context.createAnalyser(), analyser );
	assert.equal( target.__tslpAudioAnalyserCreated, true );
	assert.equal( target.__tslpLoaderPending, 3, 'construction alone does not prove visible spectrum data' );
	const values = new Uint8Array( 4 );
	analyser.getByteFrequencyData( values );
	assert.equal( target.__tslpLoaderPending, 3, 'silent analyser data keeps the readiness hold active' );

	energy = 12;
	analyser.getByteFrequencyData( values );
	assert.equal( target.__tslpLoaderPending, 2 );
	assert.equal( target.__tslpAudioAnalyserReady, true );
	assert.equal( target.__tslpAudioAnalyserPinned, true );
	assert.ok( values.every( ( value ) => value > 0 ), 'the first audible read is normalized to a deterministic visible spectrum' );
	const pinned = [ ...values ];

	now = 20;
	energy = 255;
	analyser.getByteFrequencyData( values );
	assert.equal( target.__tslpLoaderPending, 2, 'later analysers do not release another loader hold' );
	assert.equal( target.__tslpLoaderLastBusyAt, 10 );
	assert.deepEqual( [ ...values ], pinned, 'later playback phase cannot move the pinned visual spectrum' );
	assert.equal( nativeReads, 2, 'native FFT sampling stops once a representative spectrum is available' );
	assert.equal( installAudioAnalyserReadiness( target ), false, 'the native prototype is patched only once' );

} );

test( 'the audio readiness installer is self-contained for browser evaluation', () => {

	const result = runInNewContext( `
		class AudioContext {}
		AudioContext.prototype.createAnalyser = () => ( { getByteFrequencyData() {} } );
		const target = { AudioContext, __tslpLoaderPending: 0, __tslpRealNow: () => 5 };
		( ${ installAudioAnalyserReadiness.toString() } )( target );
		[ target.__tslpLoaderPending, target.__tslpAudioAnalyserReady, target.__tslpLoaderLastBusyAt ];
	` );
	assert.deepEqual( [ ...result ], [ 1, false, 5 ] );

} );

test( 'pending shadow work pauses without resetting completed callbacks', () => {

	const transition = transitionForTest();
	const result = transition( {
		animationLoopCalls: 7,
		atTarget: true,
		settleFrames: 8,
		shadowPending: true,
		waitingForAsyncCounters: true,
		waitingForAsyncWork: false,
	} );

	assert.deepEqual( result, { animationLoopCalls: 7, runCallback: false } );
	assert.deepEqual( transition( {
		...result,
		atTarget: true,
		settleFrames: 8,
		shadowPending: true,
		waitingForAsyncCounters: true,
		waitingForAsyncWork: false,
	} ), { animationLoopCalls: 7, runCallback: false } );

} );

test( 'pre-target readiness holds pause without consuming callback progress', () => {

	const transition = transitionForTest();
	const blocked = transition( {
		animationLoopCalls: 2,
		atTarget: false,
		holdAnimationUntilReady: true,
		waitingForAsyncCounters: true,
		waitingForAsyncWork: true,
	} );

	assert.deepEqual( blocked, { animationLoopCalls: 2, runCallback: false } );
	assert.deepEqual( transition( {
		...blocked,
		atTarget: false,
		holdAnimationUntilReady: true,
		waitingForAsyncCounters: false,
		waitingForAsyncWork: false,
	} ), { animationLoopCalls: 3, runCallback: true } );

} );

test( 'pre-target shadow and compute jobs pause without an opt-in readiness hold', () => {

	const transition = transitionForTest();
	for ( const pendingField of [ 'shadowPending', 'computePending' ] ) {

		assert.deepEqual( transition( {
			animationLoopCalls: 4,
			atTarget: false,
			[ pendingField ]: true,
		} ), { animationLoopCalls: 4, runCallback: false }, pendingField );

	}

} );

test( 'unheld pre-target loader work continues to render', () => {

	const transition = transitionForTest();
	assert.deepEqual( transition( {
		animationLoopCalls: 2,
		atTarget: false,
		holdAnimationUntilReady: false,
		waitingForAsyncCounters: true,
		waitingForAsyncWork: true,
	} ), { animationLoopCalls: 3, runCallback: true } );

} );

test( 'positive targets count only allowed author animation callbacks', () => {

	const transition = transitionForTest();
	const freezeAt = 2;
	const settleFrames = 2;
	let animationLoopCalls = 0;
	let frameCallbackCount = 0;
	let rafTick = 0;
	const attempt = ( pending = {} ) => {

		const completedSteps = frameCallbackCount;
		const atTarget = completedSteps >= freezeAt;
		const next = transition( {
			animationLoopCalls,
			atTarget,
			settleFrames,
			...pending,
		} );
		animationLoopCalls = next.animationLoopCalls;
		if ( ! next.runCallback ) return false;
		const nextSteps = completedSteps + 1;
		if ( ! atTarget ) rafTick = Math.min( freezeAt, nextSteps );
		frameCallbackCount = nextSteps;
		return true;

	};

	assert.equal( attempt( { holdAnimationUntilReady: true, waitingForAsyncCounters: true, waitingForAsyncWork: true } ), false );
	assert.deepEqual( { animationLoopCalls, frameCallbackCount, rafTick }, { animationLoopCalls: 0, frameCallbackCount: 0, rafTick: 0 } );
	assert.equal( attempt(), true );
	assert.deepEqual( { animationLoopCalls, frameCallbackCount, rafTick }, { animationLoopCalls: 1, frameCallbackCount: 1, rafTick: 1 } );
	assert.equal( attempt( { computePending: true, waitingForAsyncCounters: true, waitingForAsyncWork: true } ), false );
	assert.deepEqual( { animationLoopCalls, frameCallbackCount, rafTick }, { animationLoopCalls: 1, frameCallbackCount: 1, rafTick: 1 } );
	assert.equal( attempt(), true );
	assert.deepEqual( { animationLoopCalls, frameCallbackCount, rafTick }, { animationLoopCalls: 2, frameCallbackCount: 2, rafTick: 2 } );
	assert.equal( attempt(), false, 'the target is followed by the existing settle stop without extra simulation steps' );

} );

test( 'non-shadow asynchronous work still restarts the settle count', () => {

	const transition = transitionForTest();
	assert.deepEqual( transition( {
		animationLoopCalls: 7,
		atTarget: true,
		settleFrames: 8,
		waitingForAsyncCounters: true,
		waitingForAsyncWork: true,
	} ), { animationLoopCalls: 1, runCallback: true } );

} );

test( 'recurrent callback shadow jobs reach exactly the configured settle count', () => {

	const transition = transitionForTest();
	for ( const settleFrames of [ 1, 8, 32 ] ) {

		let state = { animationLoopCalls: 0 };
		let completedCallbacks = 0;
		while ( completedCallbacks < settleFrames ) {

			state = transition( { ...state, atTarget: true, settleFrames } );
			assert.equal( state.runCallback, true, `settle=${ settleFrames } callback ${ completedCallbacks + 1 } runs` );
			completedCallbacks ++;
			state = transition( {
				...state,
				atTarget: true,
				settleFrames,
				shadowPending: true,
				waitingForAsyncCounters: true,
				waitingForAsyncWork: false,
			} );
			assert.deepEqual( state, { animationLoopCalls: completedCallbacks, runCallback: false } );

		}

		state = transition( { ...state, atTarget: true, settleFrames } );
		assert.equal( state.runCallback, false, `settle=${ settleFrames } stops after its final shadow job` );
		assert.equal( completedCallbacks, settleFrames, `settle=${ settleFrames } completed callback count` );
		assert.equal( state.animationLoopCalls, settleFrames, `settle=${ settleFrames } retained count` );

	}

} );

test( 'deferred subjects must be present before an example can freeze', () => {

	assert.equal( minimumRenderableObjectsForExample( 'webgpu_backdrop.html' ), 9 );
	assert.equal( minimumRenderableObjectsForExample( 'webgpu_lights_projector.html' ), 3 );
	assert.equal( minimumRenderableObjectsForExample( 'webgpu_postprocessing_retro.html' ), 2 );
	assert.equal( minimumRenderableObjectsForExample( 'webgpu_postprocessing_motion_blur.html' ), 6 );
	assert.equal( minimumRenderableObjectsForExample( 'webgpu_loader_materialx.html' ), 65 );
	assert.equal( minimumRenderableObjectsForExample( 'webgpu_tsl_wood.html' ), 55 );
	assert.equal( minimumRenderableObjectsForExample( 'webgpu_materials.html' ), 1 );

} );

test( 'callback-driven simulations wait for capture and replay async work', () => {

	assert.equal( holdAnimationUntilReadyForExample( 'webgpu_backdrop_water.html' ), true );
	assert.equal( holdAnimationUntilReadyForExample( 'webgpu_compute_particles_rain.html' ), true );
	assert.equal( holdAnimationUntilReadyForExample( 'webgpu_postprocessing_traa.html' ), true );
	assert.equal( holdAnimationUntilReadyForExample( 'webgpu_postprocessing_ssgi_ballpool.html' ), true );
	assert.equal( holdAnimationUntilReadyForExample( 'webgpu_materials.html' ), false );

} );

test( 'sparse point renders use a non-zero example-specific brightness floor', () => {

	assert.equal( minimumBrightFractionForExample( 'webgpu_compute_audio.html', 0.005 ), 0.1 );
	assert.equal( minimumBrightFractionForExample( 'webgpu_compute_points.html', 0.005 ), 0.0001 );
	assert.equal( minimumBrightFractionForExample( 'webgpu_materials.html', 0.005 ), 0.005 );

} );

test( 'temporal examples freeze only after their required history is available', () => {

	assert.equal( settleFramesForExample( 'webgpu_postprocessing_motion_blur.html' ), 2 );
	assert.equal( settleFramesForExample( 'webgpu_postprocessing_ssgi.html' ), 64 );
	assert.equal( settleFramesForExample( 'webgpu_postprocessing_ssgi_ballpool.html' ), 64 );
	assert.equal( settleFramesForExample( 'webgpu_postprocessing_ao.html' ), 16 );
	assert.equal( settleFramesForExample( 'webgpu_postprocessing_traa.html' ), 80 );
	assert.equal( settleFramesForExample( 'webgpu_compute_water.html' ), 2 );
	assert.equal( settleFramesForExample( 'webgpu_camera_array.html' ), 1 );
	assert.equal( settleFramesForExample( 'webgpu_camera_logarithmicdepthbuffer.html' ), 1 );
	assert.equal( settleFramesForExample( 'webgpu_textures_anisotropy.html' ), 1 );
	assert.equal( settleFramesForExample( 'webgpu_materials.html', 12 ), 12 );
	assert.equal( settleFramesForExample( 'webgpu_postprocessing_motion_blur.html', 5, true ), 5 );

} );

test( 'physics and velocity examples pin after their first deterministic tick', () => {

	assert.equal( targetTickForExample( 'webgpu_postprocessing_motion_blur.html' ), 1 );
	assert.equal( targetTickForExample( 'webgpu_postprocessing_ssgi_ballpool.html' ), 1 );
	assert.equal( targetTickForExample( 'webgpu_materials.html' ), 0 );
	assert.equal( targetTickForExample( 'webgpu_postprocessing_ssgi_ballpool.html', 5, true ), 5 );
	assert.equal( pixelGateDisabledReasonForExample( 'webgpu_postprocessing_ssgi_ballpool.html' ), null );
	assert.equal( pixelGateDisabledReasonForExample( 'webgpu_postprocessing_godrays.html' ), null );
	assert.equal( pixelGateDisabledReasonForExample( 'webgpu_compute_water.html' ), null );

} );

test( 'deterministic timeout policies expose explicit render-state transactions', () => {

	assert.deepEqual( deterministicTimeoutPolicyForExample( 'webgpu_compute_reduce.html' ), { delayMs: 1000, steps: 4 } );
	assert.equal( deterministicTimeoutPolicyForExample( 'webgpu_materials.html' ), null );

} );
