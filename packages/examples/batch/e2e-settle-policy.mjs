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
		presentationReady = true,
		retainAsyncProgress = false,
		settleFrames = 0,
		shadowPending = false,
		waitingForAsyncCounters = false,
		waitingForAsyncWork = false,
	} = {} ) => {

		let nextAnimationLoopCalls = animationLoopCalls | 0;
		const settleTarget = Math.max( 0, settleFrames | 0 );
		const callbackBlocked = ( waitingForAsyncCounters && holdAnimationUntilReady )
			|| shadowPending
			|| computePending;
		if ( ! atTarget ) {

			if ( callbackBlocked ) return { animationLoopCalls: nextAnimationLoopCalls, runCallback: false };
			return { animationLoopCalls: nextAnimationLoopCalls + 1, runCallback: true };

		}

		// Before the first authoritative presentation, changed loader/compile/
		// compute inputs invalidate the completed-callback budget. Once a
		// presentation after the readiness boundary has succeeded, retain that
		// progress while recurring async work drains. Otherwise a pipeline that
		// starts a short compile job every frame can reset forever even though it
		// has already presented the requested scene.
		if ( waitingForAsyncWork && retainAsyncProgress !== true ) nextAnimationLoopCalls = 0;
		if (
			callbackBlocked ||
			( presentationReady === true && nextAnimationLoopCalls >= settleTarget )
		) {

			return { animationLoopCalls: nextAnimationLoopCalls, runCallback: false };

		}

		return { animationLoopCalls: nextAnimationLoopCalls + 1, runCallback: true };

	};

	target.__tslpTransitionAnimationLoopSettle = transitionAnimationLoopSettle;
	return transitionAnimationLoopSettle;

}

/**
 * Track settle progress independently for every renderer animation-loop owner.
 * A single global callback count lets one renderer consume another renderer's
 * readiness budget in examples that initialize multiple canvases in parallel.
 *
 * Keep this installer self-contained: Playwright serializes it into the page
 * without preserving module closures.
 */
export function installAnimationLoopOwnerReadiness( target = globalThis ) {

	const ownerStates = new Map();
	const stateKeyFor = ( owner, callback ) => {

		if ( owner && ( typeof owner === 'object' || typeof owner === 'function' ) ) return owner;
		return callback;

	};
	const states = () => [ ...ownerStates.values() ];
	const sync = () => {

		const active = states();
		target.__tslpAnimationLoopRegistered = active.length > 0;
		target.__tslpAnimationLoopCalls = active.length > 0
			? Math.min( ...active.map( ( state ) => state.animationLoopCalls | 0 ) )
			: 0;
		return active.length;

	};
	const api = {
		register( owner, callback ) {

			const key = stateKeyFor( owner, callback );
			if ( typeof callback !== 'function' ) {

				if ( key ) ownerStates.delete( key );
				sync();
				return null;

			}
			const state = {
				animationLoopCalls: 0,
				successfulCallbacks: 0,
			};
			ownerStates.set( key, state );
			sync();
			return state;

		},
		ready( minimumOwners = 1, minimumSuccessfulCallbacks = 1 ) {

			const active = states();
			const requiredOwners = Math.max( 1, minimumOwners | 0 );
			const requiredCallbacks = Math.max( 0, minimumSuccessfulCallbacks | 0 );
			return active.length >= requiredOwners
				&& active.every( ( state ) => ( state.successfulCallbacks | 0 ) >= requiredCallbacks );

		},
		snapshot() {

			return states().map( ( state ) => ( {
				animationLoopCalls: state.animationLoopCalls | 0,
				successfulCallbacks: state.successfulCallbacks | 0,
			} ) );

		},
		sync,
	};
	target.__tslpAnimationLoopOwnerReadiness = api;
	return api;

}

/** Number of independently owned animation loops that must present. */
export function minimumAnimationLoopOwnersForExample( name ) {

	// Bitonic sort initializes its local/global canvases through two independent
	// async WebGPURenderers. Both must present before either logical canvas is
	// valid capture/replay evidence.
	if ( name === 'webgpu_compute_sort_bitonic.html' ) return 2;
	return 1;

}

/**
 * Keep the compute-audio example active until its asynchronous initialization
 * has produced nonzero analyser data that drives the visible spectrum. Once
 * audio is live, replace its wall-clock-dependent FFT phase with one stable,
 * representative spectrum. The renderer still uploads and samples the same
 * analyser texture, while stock/capture/replay no longer compare unrelated
 * moments of real audio playback.
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
	let pinnedSpectrum = null;
	const fillPinnedSpectrum = ( values ) => {

		if ( ! values || typeof values.length !== 'number' ) return;
		if ( ! pinnedSpectrum || pinnedSpectrum.length !== values.length ) {

			pinnedSpectrum = new Uint8Array( values.length );
			const denominator = Math.max( 1, values.length - 1 );
			for ( let i = 0; i < values.length; i ++ ) {

				const envelope = Math.exp( - 3 * i / denominator );
				const pulse = 0.35 + 0.65 * Math.sin( Math.PI * ( ( i % 48 ) + 1 ) / 48 ) ** 2;
				pinnedSpectrum[ i ] = Math.max( 1, Math.min( 255, Math.round( 220 * envelope * pulse ) ) );

			}

		}
		if ( typeof values.set === 'function' ) values.set( pinnedSpectrum );
		else for ( let i = 0; i < values.length; i ++ ) values[ i ] = pinnedSpectrum[ i ];

	};
	const touch = () => {

		target.__tslpLoaderLastBusyAt = typeof target.__tslpRealNow === 'function'
			? target.__tslpRealNow()
			: Date.now();

	};
	touch();
	proto.createAnalyser = function createAnalyserWithReadiness( ...args ) {

		const analyser = createAnalyser.apply( this, args );
		target.__tslpAudioAnalyserCreated = true;
		touch();
		const getByteFrequencyData = analyser && analyser.getByteFrequencyData;
		if ( typeof getByteFrequencyData === 'function' ) analyser.getByteFrequencyData = function getByteFrequencyDataWithReadiness( values ) {

			if ( ! pending ) {

				fillPinnedSpectrum( values );
				return undefined;

			}
			const result = getByteFrequencyData.call( this, values );
			if ( pending && values && typeof values.length === 'number' ) {

				let hasEnergy = false;
				for ( let i = 0; i < values.length; i ++ ) {

					if ( values[ i ] > 0 ) {

						hasEnergy = true;
						break;

					}

				}
				if ( hasEnergy ) {

					pending = false;
					fillPinnedSpectrum( values );
					target.__tslpAudioAnalyserReady = true;
					target.__tslpAudioAnalyserPinned = true;
					target.__tslpLoaderPending = Math.max( 0, ( target.__tslpLoaderPending | 0 ) - 1 );
					touch();

				}

			}
			return result;

		};
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
	// Progressive shadows create the ground and first TransformControls helper
	// synchronously, then use an explicit LoadingManager to attach the GLTF
	// subject and its second helper. The harness only observes
	// DefaultLoadingManager, and the incomplete helper topology already counts
	// 68 geometry/material descendants, so require one object beyond it.
	if ( name === 'webgpu_shadowmap_progressive.html' ) return 69;
	// Retro starts with the procedural smoke plane, then async-loads the coffee
	// mug scene. A one-object gate can freeze stock before the model appears,
	// while replay captures it after loader settle.
	if ( name === 'webgpu_postprocessing_retro.html' ) return 2;
	// SSR starts with only its reflective floor. Once the steampunk camera loads,
	// the main pass observes the floor plus three model meshes. The renderable
	// tracker retains that maximum so nested fullscreen post-process renders
	// cannot overwrite it with their single helper mesh.
	if ( name === 'webgpu_postprocessing_ssr.html' ) return 4;
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
	// Procedural wood yields one preset block per setTimeout(0), then appends a
	// custom label and custom block synchronously. The complete authored scene
	// is the grid plane, 15 labels, and 41 blocks.
	if ( name === 'webgpu_tsl_wood.html' ) return 57;
	return 1;

}

/**
 * Whether animation callbacks must pause while capture/replay async work is
 * pending. Count-driven simulations otherwise advance during a different
 * number of shader-compilation frames in each mode, even though their final
 * quiet-frame count is identical.
 */
export function holdAnimationUntilReadyForExample( name ) {

	// This page starts its RenderPipeline before the dungeon GLTF callback adds
	// any meshes. Keep presenting startup frames so the pass can observe that
	// deferred scene mutation; the generic renderable-object and async-quiescence
	// gates still prevent an environment-only frame from becoming final evidence.
	if ( name === 'webgpu_postprocessing_ssr_denoise.html' ) return false;

	if (
		// Backdrop water advances auto-rotating OrbitControls once per callback,
		// without a delta. Pause it while loaders/compilers differ between modes.
		name === 'webgpu_backdrop_water.html' ||
		// Rain advances four storage buffers once per author callback. Capture and
		// replay must not run extra compute steps while their async work differs.
		name === 'webgpu_compute_particles_rain.html' ||
		// Temporal upscaling accumulates every callback. Replay performs extra
		// loader/material preparation, so starting history before the GLTF and
		// its textures settle compares different temporal phases.
		name === 'webgpu_upscaling_taau.html' ||
		// Monaco performs the initial editor build asynchronously. Preserve the
		// author's first callback until that build can produce a real presentation.
		name === 'webgpu_tsl_editor.html' ||
		name === 'webgpu_postprocessing_traa.html' ||
		name === 'webgpu_postprocessing_lensflare.html' ||
		name === 'webgpu_postprocessing_smaa.html' ||
		name === 'webgpu_postprocessing_ssgi_ballpool.html' ||
		// Sandbox awaits a worker-decoded KTX2 texture before it creates any
		// scene materials. Its first callback must not consume the pinned tick
		// while the scene is still empty.
		name === 'webgpu_sandbox.html' ||
		// The HDR callback establishes selector-relevant scene environment state.
		name === 'webgpu_reflection_roughness.html' ||
		// The graph example renders its ground before the awaited HDR callback
		// adds the selector-relevant directional light.
		name === 'webgpu_tsl_graph.html' ||
		// Both crate textures must be ready before the single camera-alignment callback.
		name === 'webgpu_textures_anisotropy.html' ||
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
	// Linked particles spawn from delta time. A nonzero pinned tick yields a
	// representative deterministic population instead of forty overlapping
	// particles at the origin; 180 clears the standard visual evidence floor.
	if ( name === 'webgpu_tsl_vfx_linkedparticles.html' ) return 180;
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
	// Storage-buffer starts from its authored immediate inversion. Queueing but
	// not draining the recurring 1 s callbacks freezes that first stable phase
	// instead of racing a second in-place inversion at screenshot time.
	if ( name === 'webgpu_storage_buffer.html' ) return Object.freeze( { delayMs: 1000, steps: 0 } );
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
	// Log-depth advances its exponential zoom once per raw rAF callback rather
	// than from the callback timestamp. One presented frame avoids grading a
	// different number of zoom steps after capture-only shader work.
	if ( name === 'webgpu_camera_logarithmicdepthbuffer.html' ) return 1;
	if ( name === 'webgpu_compute_birds.html' ) return 1;
	// Rasterizer IBL performs a complete visibility-buffer compute transaction
	// on every animation callback. The generic eight quiet callbacks repeat the
	// same very large authored dispatch after the deterministic clock is already
	// pinned, monopolizing the renderer before Playwright can observe its timeout.
	// One callback still runs the full r185 compute + shaded resolve topology.
	if ( name === 'webgpu_compute_rasterizer_ibl.html' ) return 1;
	if ( name === 'webgpu_compute_sort_bitonic.html' ) return 1;
	if ( name === 'webgpu_tsl_compute_attractors_particles.html' ) return 1;
	if ( name === 'webgpu_tsl_vfx_linkedparticles.html' ) return 1;
	if ( name === 'webgpu_instance_path.html' ) return 1;
	if ( name === 'webgpu_lights_custom.html' ) return 1;
	if ( name === 'webgpu_lights_projector.html' ) return 1;
	if ( name === 'webgpu_materials_video.html' ) return 1;
	if ( name === 'webgpu_textures_anisotropy.html' ) return 1;
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
	// SSR denoise feeds a stochastic SSR sample through a 16-frame
	// TemporalReproject window and RecurrentDenoise's default 32-frame window.
	// Let both modes complete the longer authored history before comparison.
	if ( name === 'webgpu_postprocessing_ssr_denoise.html' ) return 32;
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
	// TAAU gives each new sample only 2.5% weight. The generic eight-frame
	// settle therefore retains about 82% of its mode-specific startup history
	// and produces a stable but false edge mismatch. Keep the pose pinned while
	// both temporal histories converge through the same 80 jittered callbacks.
	if ( name === 'webgpu_upscaling_taau.html' ) return 80;
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
