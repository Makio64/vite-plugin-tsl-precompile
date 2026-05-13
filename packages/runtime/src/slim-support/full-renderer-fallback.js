/**
 * Full-`WebGPURenderer` fallback for the slim runtime.
 *
 * Some three.js features need a live node-graph compiler the slim bundle
 * doesn't ship: compute kernels (`renderer.compute(node)`), shadow-map
 * generation, clipping passes, and any dynamic `PassNode` that emits new
 * WGSL at render time. The proven workaround is to boot a *full* three.js
 * `WebGPURenderer` on the **same `GPUDevice`** as the slim renderer, hand
 * it the work that requires shader generation, and copy outputs back via
 * the `gpu-texture-share` / `compute-sync` primitives.
 *
 * This module is the productized version of the harness's
 * `__getComputeRenderer`. It owns the lazy-init + de-duplicated promise +
 * shared-device bootstrap; it does not own the work the full renderer is
 * asked to do (that lives in `compute-sync`, future pass/shadow modules,
 * and the harness scene-walks).
 *
 * Typical wiring:
 *
 * ```js
 * import * as ThreeFull from 'three/webgpu';                      // full bundle
 * import { createFullRendererFallback } from '@tsl-precompile/runtime';
 *
 * const fallback = createFullRendererFallback( {
 *   slimRenderer,
 *   threeFullModule: ThreeFull,
 * } );
 * const full = await fallback.getRenderer();      // shared GPUDevice, init() resolved
 * await full.compute( computeNode );              // node-graph compute kernel
 * syncComputeStorageOutputs( computeNode, full, slimRenderer );
 * ```
 *
 * @module SlimSupportFullRendererFallback
 */

const DEFAULT_OPTS = {
	shadowMapEnabled: true,
	reuseDevice: true,
};

/**
 * @param {Object} opts
 * @param {Object}  opts.slimRenderer       - The slim `WebGPURenderer` (used to source the shared device).
 * @param {Object}  [opts.threeFullModule]  - The *full* three/webgpu module namespace (provides `WebGPURenderer`). Required unless `opts.WebGPURendererClass` is supplied.
 * @param {Function} [opts.WebGPURendererClass] - Direct full-WebGPURenderer constructor. Overrides `threeFullModule.WebGPURenderer` when provided (useful for test injection).
 * @param {Function} [opts.loadThreeFullModule] - Async factory returning the full-three module. Called once on first `getRenderer()` if `threeFullModule` is absent.
 * @param {boolean} [opts.shadowMapEnabled=true] - Enables `r.shadowMap.enabled` on the booted full renderer so shadow passes can fire.
 * @param {boolean} [opts.reuseDevice=true]      - Pass `{ device }` from the slim renderer's backend into the full renderer so both share the same `GPUDevice`.
 * @param {Function} [opts.onError]              - `(err) => void` called when the lazy boot fails. The promise still rejects/returns null.
 * @returns {{
 *   getRenderer: () => Promise<Object|null>,
 *   getModule: () => Object|null,
 *   isInitialised: () => boolean,
 *   dispose: () => void,
 * }}
 */
export function createFullRendererFallback( opts = {} ) {

	if ( ! opts || typeof opts !== 'object' ) throw new TypeError( 'createFullRendererFallback: opts object is required.' );
	if ( ! opts.slimRenderer ) throw new Error( 'createFullRendererFallback: opts.slimRenderer is required.' );

	const settings = { ...DEFAULT_OPTS, ...opts };
	let fullRenderer = null;
	let initPromise = null;
	let resolvedModule = settings.threeFullModule || null;

	async function loadModule() {

		if ( resolvedModule ) return resolvedModule;
		if ( typeof settings.loadThreeFullModule === 'function' ) {

			resolvedModule = await settings.loadThreeFullModule();
			return resolvedModule;

		}
		throw new Error( 'createFullRendererFallback: no full-three module available — pass `threeFullModule` or `loadThreeFullModule()`.' );

	}

	function pickRendererClass( mod ) {

		if ( typeof settings.WebGPURendererClass === 'function' ) return settings.WebGPURendererClass;
		if ( mod && typeof mod.WebGPURenderer === 'function' ) return mod.WebGPURenderer;
		return null;

	}

	function buildOptions( slimRenderer ) {

		const rendererOptions = {};
		if ( settings.reuseDevice ) {

			const device = slimRenderer.backend && slimRenderer.backend.device;
			if ( device ) rendererOptions.device = device;

		}
		if ( slimRenderer.reversedDepthBuffer !== undefined ) {

			rendererOptions.reversedDepthBuffer = slimRenderer.reversedDepthBuffer === true;

		}
		return rendererOptions;

	}

	async function bootOnce() {

		try {

			// Prefer a directly-injected renderer class (test seam) — skip module
			// load entirely when one was passed.
			let Ctor = typeof settings.WebGPURendererClass === 'function' ? settings.WebGPURendererClass : null;
			if ( ! Ctor ) {

				const mod = await loadModule();
				Ctor = pickRendererClass( mod );

			}
			if ( ! Ctor ) throw new Error( 'createFullRendererFallback: threeFullModule has no WebGPURenderer export.' );

			const r = new Ctor( buildOptions( settings.slimRenderer ) );
			if ( typeof r.init === 'function' ) await r.init();
			if ( settings.shadowMapEnabled && r.shadowMap ) r.shadowMap.enabled = true;
			fullRenderer = r;
			return r;

		} catch ( err ) {

			if ( typeof settings.onError === 'function' ) settings.onError( err );
			return null;

		}

	}

	function getRenderer() {

		if ( fullRenderer ) return Promise.resolve( fullRenderer );
		if ( initPromise ) return initPromise;
		initPromise = bootOnce();
		return initPromise;

	}

	function dispose() {

		const r = fullRenderer;
		fullRenderer = null;
		initPromise = null;
		if ( r && typeof r.dispose === 'function' ) {

			try { r.dispose(); } catch ( _ ) { /* tolerate dispose throws */ }

		}

	}

	return {
		getRenderer,
		getModule: () => resolvedModule,
		isInitialised: () => fullRenderer !== null,
		dispose,
	};

}
