import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { holdAnimationUntilReadyForExample, installAnimationLoopSettleTransition, minimumRenderableObjectsForExample, settleFramesForExample, targetTickForExample } from '../e2e-settle-policy.mjs';
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

	assert.equal( holdAnimationUntilReadyForExample( 'webgpu_postprocessing_traa.html' ), true );
	assert.equal( holdAnimationUntilReadyForExample( 'webgpu_postprocessing_ssgi_ballpool.html' ), true );
	assert.equal( holdAnimationUntilReadyForExample( 'webgpu_materials.html' ), false );

} );

test( 'sparse point renders use a non-zero example-specific brightness floor', () => {

	assert.equal( minimumBrightFractionForExample( 'webgpu_compute_points.html', 0.005 ), 0.0001 );
	assert.equal( minimumBrightFractionForExample( 'webgpu_materials.html', 0.005 ), 0.005 );

} );

test( 'temporal examples freeze only after their required history is available', () => {

	assert.equal( settleFramesForExample( 'webgpu_postprocessing_motion_blur.html' ), 2 );
	assert.equal( settleFramesForExample( 'webgpu_postprocessing_ssgi.html' ), 64 );
	assert.equal( settleFramesForExample( 'webgpu_postprocessing_ssgi_ballpool.html' ), 64 );
	assert.equal( settleFramesForExample( 'webgpu_postprocessing_ao.html' ), 16 );
	assert.equal( settleFramesForExample( 'webgpu_postprocessing_traa.html' ), 80 );
	assert.equal( settleFramesForExample( 'webgpu_camera_array.html' ), 1 );
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

} );
