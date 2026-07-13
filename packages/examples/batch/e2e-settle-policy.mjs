/**
 * Install the animation-loop settle transition into a browser-like target.
 *
 * Keep the transition nested and self-contained: Playwright serializes this
 * installer into an init script without preserving module closures.
 */
export function installAnimationLoopSettleTransition( target = globalThis ) {

	const transitionAnimationLoopSettle = ( {
		animationLoopCalls = 0,
		atTarget = false,
		computePending = false,
		holdAnimationUntilReady = false,
		settleFrames = 0,
		shadowPending = false,
		waitingForAsyncCounters = false,
		waitingForAsyncWork = false,
	} = {} ) => {

		let nextAnimationLoopCalls = animationLoopCalls | 0;
		const settleTarget = Math.max( 0, settleFrames | 0 );
		if ( ! atTarget ) {

			return { animationLoopCalls: nextAnimationLoopCalls + 1, runCallback: true };

		}

		if ( waitingForAsyncWork ) nextAnimationLoopCalls = 0;
		if (
			( waitingForAsyncCounters && holdAnimationUntilReady ) ||
			shadowPending ||
			computePending ||
			( ! waitingForAsyncWork && nextAnimationLoopCalls >= settleTarget )
		) {

			return { animationLoopCalls: nextAnimationLoopCalls, runCallback: false };

		}

		return { animationLoopCalls: nextAnimationLoopCalls + 1, runCallback: true };

	};

	target.__tslpTransitionAnimationLoopSettle = transitionAnimationLoopSettle;
	return transitionAnimationLoopSettle;

}
