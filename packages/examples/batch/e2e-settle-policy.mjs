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

/**
 * Minimum visible scene population required before the capture loop may
 * become quiet. Some examples attach a placeholder synchronously and their
 * real subjects in a later loader callback, so a generic one-object gate can
 * freeze a structurally incomplete frame.
 */
export function minimumRenderableObjectsForExample( name ) {

	// Backdrop creates its eight portal meshes synchronously, then attaches the
	// GLTF subject. Freezing at eight makes the stock and replay sphere ordering
	// appear different even though the renderer state is equivalent.
	if ( name === 'webgpu_backdrop.html' ) return 9;
	// The projector-light page renders its plane + SpotLightHelper before the
	// async PLY statue is attached. Waiting for one renderable object lets the
	// stock/reference frame freeze before the loaded subject appears.
	if ( name === 'webgpu_lights_projector.html' ) return 3;
	// Retro starts with the procedural smoke plane, then async-loads the coffee
	// mug scene. A one-object gate can freeze stock before the model appears,
	// while replay captures it after loader settle.
	if ( name === 'webgpu_postprocessing_retro.html' ) return 2;
	// Motion blur creates the floor, room, and two toruses synchronously, then
	// adds the Xbot's two skinned meshes from GLTF. Waiting for the generic first
	// renderable lets capture freeze before either skinned material exists.
	if ( name === 'webgpu_postprocessing_motion_blur.html' ) return 6;
	// MaterialX loads one GLTF prefab, then sequentially awaits 32 MaterialX
	// samples and compileAsync() calls. The loader/compile counters briefly hit
	// zero between samples, so a one-object gate can freeze replay after the
	// first couple of shader balls. The final scene is the grid plane plus two
	// visible meshes per sample (Calibration_Mesh and Preview_Mesh).
	if ( name === 'webgpu_loader_materialx.html' ) return 65;
	// Procedural wood yields one block per setTimeout(0) after the HDR/font
	// loads. Wait for the grid plane, 14 text labels, and all 40 wood blocks.
	if ( name === 'webgpu_tsl_wood.html' ) return 55;
	return 1;

}
