import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { installAnimationLoopSettleTransition, minimumRenderableObjectsForExample } from '../e2e-settle-policy.mjs';

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

test( 'pending shadow work resets the quiet callback count without freezing the loop', () => {

	const transition = transitionForTest();
	const result = transition( {
		animationLoopCalls: 7,
		atTarget: true,
		settleFrames: 8,
		shadowPending: true,
		waitingForAsyncCounters: true,
		waitingForAsyncWork: true,
	} );

	assert.deepEqual( result, { animationLoopCalls: 0, runCallback: false } );
	assert.deepEqual( transition( {
		...result,
		atTarget: true,
		settleFrames: 8,
		shadowPending: true,
		waitingForAsyncCounters: true,
		waitingForAsyncWork: true,
	} ), { animationLoopCalls: 0, runCallback: false } );

} );

test( 'shadow completion requires exactly the configured 1/8/32 quiet callbacks', () => {

	const transition = transitionForTest();
	for ( const settleFrames of [ 1, 8, 32 ] ) {

		// The first callback starts the asynchronous shadow job while its pending
		// counter is still zero. Observing the pending job then resets that call.
		let state = transition( { atTarget: true, settleFrames } );
		assert.equal( state.runCallback, true, `settle=${ settleFrames } starts shadow work` );
		state = transition( {
			...state,
			atTarget: true,
			settleFrames,
			shadowPending: true,
			waitingForAsyncCounters: true,
			waitingForAsyncWork: true,
		} );
		assert.deepEqual( state, { animationLoopCalls: 0, runCallback: false } );

		let quietCallbacks = 0;
		while ( true ) {

			state = transition( {
				animationLoopCalls: state.animationLoopCalls,
				atTarget: true,
				settleFrames,
			} );
			if ( ! state.runCallback ) break;
			quietCallbacks ++;

		}

		assert.equal( quietCallbacks, settleFrames, `settle=${ settleFrames } quiet callback count` );
		assert.equal( state.animationLoopCalls, settleFrames, `settle=${ settleFrames } retained count` );

	}

} );

test( 'deferred subjects must be present before an example can freeze', () => {

	assert.equal( minimumRenderableObjectsForExample( 'webgpu_backdrop.html' ), 9 );
	assert.equal( minimumRenderableObjectsForExample( 'webgpu_lights_projector.html' ), 3 );
	assert.equal( minimumRenderableObjectsForExample( 'webgpu_postprocessing_retro.html' ), 2 );
	assert.equal( minimumRenderableObjectsForExample( 'webgpu_loader_materialx.html' ), 65 );
	assert.equal( minimumRenderableObjectsForExample( 'webgpu_tsl_wood.html' ), 55 );
	assert.equal( minimumRenderableObjectsForExample( 'webgpu_materials.html' ), 1 );

} );
