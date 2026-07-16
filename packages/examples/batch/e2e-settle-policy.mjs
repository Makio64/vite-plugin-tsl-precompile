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
 * Keep the compute-audio example active until its asynchronous initialization
 * has produced the analyser that drives the visible spectrum. The page starts
 * that work from a click handler, outside Three's loader manager, so the
 * ordinary loader counters cannot otherwise distinguish "not started yet"
 * from "ready to capture".
 *
 * Keep this installer self-contained: Playwright serializes it into the page
 * without preserving module closures.
 */
export function installAudioAnalyserReadiness( target = globalThis ) {

	const AudioContext = target.AudioContext || target.webkitAudioContext;
	const proto = AudioContext && AudioContext.prototype;
	const createAnalyser = proto && proto.createAnalyser;
	if ( typeof createAnalyser !== 'function' || proto.__tslpAnalyserReadinessPatched === true ) return false;

	proto.__tslpAnalyserReadinessPatched = true;
	target.__tslpAudioAnalyserReady = false;
	target.__tslpLoaderPending = ( target.__tslpLoaderPending | 0 ) + 1;
	let pending = true;
	const touch = () => {

		target.__tslpLoaderLastBusyAt = typeof target.__tslpRealNow === 'function'
			? target.__tslpRealNow()
			: Date.now();

	};
	touch();
	proto.createAnalyser = function createAnalyserWithReadiness( ...args ) {

		const analyser = createAnalyser.apply( this, args );
		if ( pending ) {

			pending = false;
			target.__tslpAudioAnalyserReady = true;
			target.__tslpLoaderPending = Math.max( 0, ( target.__tslpLoaderPending | 0 ) - 1 );
			touch();

		}
		return analyser;

	};
	return true;

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

/**
 * Whether animation callbacks must pause while capture/replay async work is
 * pending. Count-driven simulations otherwise advance during a different
 * number of shader-compilation frames in each mode, even though their final
 * quiet-frame count is identical.
 */
export function holdAnimationUntilReadyForExample( name ) {

	if (
		// Backdrop water advances auto-rotating OrbitControls once per callback,
		// without a delta. Pause it while loaders/compilers differ between modes.
		name === 'webgpu_backdrop_water.html' ||
		name === 'webgpu_postprocessing_traa.html' ||
		name === 'webgpu_postprocessing_lensflare.html' ||
		name === 'webgpu_postprocessing_smaa.html' ||
		name === 'webgpu_postprocessing_ssgi_ballpool.html' ||
		name === 'webgpu_test_memory.html'
	) return true;
	return false;

}

/**
 * Synthetic animation tick at which an example becomes temporally pinned.
 */
export function targetTickForExample( name, defaultTargetTick = 0, hasExplicitTargetTick = false ) {

	if ( hasExplicitTargetTick ) return defaultTargetTick;
	// Motion vectors need one completed animation step so VelocityNode has a
	// meaningful previous/current pose pair.
	if ( name === 'webgpu_postprocessing_motion_blur.html' ) return 1;
	// Bounce treats a zero dt as an omitted argument and advances by a fixed
	// physics step. Pinning at one gives it a truthy clock, so the later clamped
	// SSGI/TRAA convergence callbacks keep one stable ball arrangement.
	if ( name === 'webgpu_postprocessing_ssgi_ballpool.html' ) return 1;
	return defaultTargetTick;

}

/**
 * Long-running examples sometimes expose a render-visible state machine through
 * a wall-clock timeout rather than their animation loop. Return the exact delay
 * and number of callbacks the harness should drain before capture, or null when
 * native wall-clock scheduling is appropriate.
 */
export function deterministicTimeoutPolicyForExample( name ) {

	// Reduce renders before toggling its validation uniform. Each half owns its
	// own timer, so draining Run Algo and then Validate for both canvases leaves
	// the frame on the computed green result in every mode, independent of shader
	// compilation and renderer-startup latency.
	if ( name === 'webgpu_compute_reduce.html' ) return Object.freeze( { delayMs: 1000, steps: 4 } );
	return null;

}

/**
 * Number of quiet animation-loop callbacks required before freezing an
 * example. Keep these harness-only policies outside the main runner so their
 * temporal assumptions can be tested without launching a browser.
 */
export function settleFramesForExample( name, defaultSettleFrames = 8, hasExplicitSettleFrames = false ) {

	if ( hasExplicitSettleFrames ) return defaultSettleFrames;
	// ArrayCamera has no asynchronous scene assets and mutates rotation by
	// frame count, not by the rAF timestamp. One quiet present frame is enough
	// to capture the stable canvas; the general eight-frame settle advances the
	// capture and replay wrappers through different renderer-initialization
	// work, which shows up as a false visual diff.
	if ( name === 'webgpu_camera_array.html' ) return 1;
	// These examples keep advancing render-visible state on every clamped
	// animation-loop callback (compute steps, helper/scissor state, media frames,
	// postprocessing history, TSL time, or damping-driven camera state). Extra
	// settle frames can therefore compare different histories instead of replay
	// fidelity.
	if ( name === 'webgpu_camera.html' ) return 1;
	if ( name === 'webgpu_compute_birds.html' ) return 1;
	if ( name === 'webgpu_compute_sort_bitonic.html' ) return 1;
	if ( name === 'webgpu_tsl_compute_attractors_particles.html' ) return 1;
	if ( name === 'webgpu_instance_path.html' ) return 1;
	if ( name === 'webgpu_lights_custom.html' ) return 1;
	if ( name === 'webgpu_lights_projector.html' ) return 1;
	if ( name === 'webgpu_materials_video.html' ) return 1;
	if ( name === 'webgpu_textures_anisotropy.html' ) return 1;
	if ( name === 'webgpu_postprocessing_dof.html' ) return 1;
	if ( name === 'webgpu_postprocessing_retro.html' ) return 1;
	if ( name === 'webgpu_postprocessing_smaa.html' ) return 1;
	if ( name === 'webgpu_postprocessing_ssr.html' ) return 1;
	// Water advances its height and duck kernels on every second application
	// callback. Replay can restart the quiet-frame count once while its PMREM is
	// generated asynchronously; one callback therefore straddles the dispatch
	// boundary in replay but not in stock. Two callbacks leave both modes after
	// exactly one simulation step, without advancing to the next dispatch.
	if ( name === 'webgpu_compute_water.html' ) return 2;
	// The first render containing the async Xbot initializes its skinned velocity
	// history. A second render is required before the motion-blur pass has a real
	// previous/current pose pair.
	if ( name === 'webgpu_postprocessing_motion_blur.html' ) return 2;
	// SSGI rotates a stochastic sampling pattern and feeds it through TRAA.
	// Sixty-four quiet frames let both capture and replay converge before comparison
	// instead of grading different amounts of residual noise.
	if ( name === 'webgpu_postprocessing_ssgi.html' ) return 64;
	// Ballpool has the same stochastic SSGI + TRAA history, after its physics
	// pose is pinned by targetTickForExample().
	if ( name === 'webgpu_postprocessing_ssgi_ballpool.html' ) return 64;
	// TRAA-backed effects need several quiet frames to build usable history
	// after the harness holds pre-ready count-driven callbacks.
	if ( name === 'webgpu_postprocessing_ao.html' ) return 16;
	// TRAA's temporal resolve needs enough same-pose history to converge to the
	// stock frame. With jitter pinned in both modes, 80 quiet frames reaches a
	// bit-for-bit identical replay for this callback-count-driven example.
	if ( name === 'webgpu_postprocessing_traa.html' ) return 80;
	if ( name === 'webgpu_sandbox.html' ) return 1;
	if ( name === 'webgpu_shadowmap_progressive.html' ) return 1;
	if ( name === 'webgpu_tsl_wood.html' ) return 1;
	// The transmitted shadow needs several completed renders before its projected
	// caustic texture is usable. A single quiet frame freezes the reference while
	// the duck and floor are still nearly black. The deterministic rAF wrapper
	// keeps the eight callback-count rotations aligned across all three passes.
	if ( name === 'webgpu_caustics.html' ) return 8;
	// Replay generates PMREM for the cube-camera render target asynchronously.
	// Extra settle frames run another cubeCamera.update(), invalidating the
	// just-finished PMREM and keeping the visual gate in a moving target loop.
	if ( name === 'webgpu_cubemap_dynamic.html' ) return 1;
	return defaultSettleFrames;

}
