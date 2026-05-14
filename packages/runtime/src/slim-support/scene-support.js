/**
 * `createSlimSceneSupport()` — the public, opt-in orchestrator that ties
 * the four primitive `slim-support` modules into one entry point for slim-
 * runtime adopters.
 *
 * The slim three.js bundle ships no node-graph compiler, so a real-world
 * app sometimes needs to compose two `WebGPURenderer` instances on the
 * same `GPUDevice`: slim for the main render, full for the work that
 * generates dynamic WGSL (compute kernels, shadow scenes, dynamic
 * `PassNode`s, PMREM). The harness has been doing this for ~3.6k lines;
 * this orchestrator is the equivalent public API.
 *
 * The intent is *opt-in* composition: a project that just precompiles
 * its materials needs nothing here. Projects that need compute or shadow
 * fallback build a `createSlimSceneSupport()` once at startup and call
 * the methods they actually use.
 *
 * ```js
 * import * as ThreeFull from 'three/webgpu';
 * import { createSlimSceneSupport } from '@tsl-precompile/runtime';
 *
 * const support = createSlimSceneSupport( {
 *   renderer: slimRenderer,
 *   threeFullModule: ThreeFull,   // only needed if any *Fallback option is on
 *   fullRendererFallback: true,
 * } );
 *
 * support.indexScene( scene );
 * const stats = support.syncComputeOutputs( computeNode, fullRenderer );
 * ```
 *
 * @module SlimSupportSceneSupport
 */

import { createLiveSceneIndex } from './live-scene-index.js';
import { createPMREMSupport } from './pmrem.js';
import {
	syncComputeStorageOutputs,
	syncComputeStorageOutputsPerPass,
	pingPongInvalidate,
	shareInstancedAttributeBufferIntoSlim,
	computeNodeUsesStorageTexture,
} from './compute-sync.js';
import { shareGPUTextureEntry, shareShadowGPUTextureIntoSlim } from './gpu-texture-share.js';
import { createFullRendererFallback } from './full-renderer-fallback.js';
import { setSlimRenderFallback } from './render-fallback-registry.js';
import { wirePrecompiledPostprocess } from './postprocess-wire.js';
import { preparePrecompiledPostprocess } from './postprocess-effects-replay.js';
import { loadAux } from '../aux-loader.js';
import PrecompiledMaterial from '../_vendor-PrecompiledMaterial.js';

const DEFAULT_OPTS = {
	// Wave 5 Phase B3 — default to `'auto'` so any three.js project that
	// also configures `threeFullModule` or `loadThreeFullModule` gets the
	// fallback for free. Slim renders the precompiled fast-path; anything
	// unrecognised proxies to the full renderer. Set `false` explicitly to
	// opt out (smaller bundle if you control every material). `'auto'`
	// silently skips when no `threeFullModule`/`loadThreeFullModule` is
	// configured — i.e. zero surprise for legacy callers.
	fullRendererFallback: 'auto',
	pmrem: true,
	computeSync: true,
	textureSharing: true,
};

/**
 * @param {Object} opts
 * @param {Object}  opts.renderer                - The slim `WebGPURenderer`. Required.
 * @param {Object}  [opts.threeFullModule]       - The full `three/webgpu` module namespace. Required when `fullRendererFallback: true` (or pass `loadThreeFullModule`).
 * @param {Function} [opts.loadThreeFullModule]  - Async factory for the full-three module, used by the fallback boot.
 * @param {boolean} [opts.fullRendererFallback=false] - Enable the on-the-side full `WebGPURenderer` for compute / shadows / dynamic passes.
 * @param {boolean} [opts.pmrem=true]            - Build a PMREM support sub-helper (always cheap; disable to opt out of the cache).
 * @param {boolean} [opts.computeSync=true]      - Expose `syncComputeOutputs()` (pure compute output sync; safe to leave on).
 * @param {boolean} [opts.textureSharing=true]   - Expose `shareTexture()` / `shareShadowTexture()` convenience wrappers.
 * @param {Object}  [opts.diagnostics]           - Optional counter bag — sub-modules write under `{ pmrem, textureShare, compute }` namespaces.
 * @param {Function} [opts.pmremGenerator]       - `(renderer, sourceTexture) => Promise<pmremTexture>` used by `generatePMREMAsync()` to bake source environments. Required to call `generatePMREMAsync()`; can be omitted if the caller never asks for PMREM.
 * @param {Function} [opts.textureImageReady]    - Optional readiness predicate for PMREM sources. Defaults to permissive because explicit public generators can own readiness.
 * @param {Function} [opts.onError]              - `(err, where) => void` for non-fatal sub-module errors.
 */
export function createSlimSceneSupport( opts = {} ) {

	if ( ! opts || typeof opts !== 'object' ) throw new TypeError( 'createSlimSceneSupport: opts object is required.' );
	const renderer = opts.renderer;
	if ( ! renderer ) throw new Error( 'createSlimSceneSupport: opts.renderer is required.' );
	const settings = { ...DEFAULT_OPTS, ...opts };
	const diagnostics = settings.diagnostics || { pmrem: {}, textureShare: { calls: 0, success: 0, noSourceData: 0, noSourceTexture: 0, names: [], missingNames: [] }, compute: {} };
	const onError = typeof settings.onError === 'function' ? settings.onError : null;

	// --- live-scene-index (always on; the cheapest of the helpers) ----------
	const liveSceneIndex = createLiveSceneIndex();

	// --- PMREM cache + orchestration ----------------------------------------
	// `pmremGenerator` is the `(renderer, sourceTex) => Promise<pmremTex>` the
	// caller wires up (typically `(_, src) => new ThreeFull.PMREMGenerator(full).fromEquirectangularAsync(src)`).
	// It's optional at construction; `generatePMREMAsync()` will throw a
	// clear error if it's called without one ever being set.
	let pmremGenerator = typeof settings.pmremGenerator === 'function' ? settings.pmremGenerator : null;
	const textureImageReady = typeof settings.textureImageReady === 'function' ? settings.textureImageReady : () => true;
	const pmrem = settings.pmrem ? createPMREMSupport( {
		diagnostics: diagnostics.pmrem,
		textureImageReady,
		generatePMREM: ( r, src ) => pmremGenerator ? pmremGenerator( r, src ) : Promise.reject( new Error( 'createSlimSceneSupport: pmremGenerator was not configured.' ) ),
		onError: ( err, tex ) => onError && onError( err, { where: 'pmrem', texture: tex } ),
	} ) : null;

	// --- full-renderer fallback (lazy, opt-in) ------------------------------
	// `'auto'` means: enable when a full-three module reference is
	// available (either eagerly via `threeFullModule` or lazily via
	// `loadThreeFullModule`). Silently no-op when neither is configured so
	// existing call sites that never expected a fallback don't regress.
	// Explicit `true` keeps the prior behavior. Explicit `false` opts out.
	const fallbackEnabled = settings.fullRendererFallback === 'auto'
		? !! ( settings.threeFullModule || typeof settings.loadThreeFullModule === 'function' )
		: !! settings.fullRendererFallback;
	const fallback = fallbackEnabled ? createFullRendererFallback( {
		slimRenderer: renderer,
		threeFullModule: settings.threeFullModule,
		loadThreeFullModule: settings.loadThreeFullModule,
		onError: ( err ) => onError && onError( err, { where: 'fullRendererFallback' } ),
	} ) : null;

	// --- API surface --------------------------------------------------------

	function indexScene( scene ) {

		if ( ! scene || typeof liveSceneIndex.indexScene !== 'function' ) return;
		liveSceneIndex.indexScene( scene );

	}

	function rememberLiveTexture( texture ) {

		if ( texture && typeof liveSceneIndex.rememberLiveTexture === 'function' ) liveSceneIndex.rememberLiveTexture( texture );

	}

	async function getFullRenderer() {

		return fallback ? fallback.getRenderer() : null;

	}

	function setPMREMGenerator( fn ) {

		pmremGenerator = typeof fn === 'function' ? fn : null;

	}

	async function generatePMREMAsync( sourceTexture, generator ) {

		if ( ! pmrem ) return null;

		// Cache hit on a source we've already generated for, regardless of how
		// it was generated (inline arg, construction-time wiring, or a prior
		// kickGenerate). Mirrors the harness's `__getCachedPMREMForSource`.
		const cached = pmrem.getCachedPMREMForSource( sourceTexture );
		if ( cached ) return cached;

		// Two paths from here:
		//   (a) Inline `generator` argument — the caller is *explicit* about
		//       wanting PMREM for this source right now, so we bypass the
		//       `kickGenerate` readiness gate (which is a guard for the
		//       background fire-and-wait flow) and call the generator
		//       directly. The result is cached via `rememberPMREM` so the
		//       next call hits the cache above instead of regenerating.
		//   (b) No inline arg — defer to `kickGenerate` and let it apply the
		//       construction-time `pmremGenerator`, pending-join, and image-
		//       readiness gates.
		if ( typeof generator === 'function' ) {

			const result = await generator( renderer, sourceTexture );
			return pmrem.rememberPMREM( sourceTexture, result );

		}

		if ( ! pmremGenerator ) {

			throw new Error( 'createSlimSceneSupport: generatePMREMAsync needs a `(renderer, sourceTexture) => Promise<pmremTexture>` generator. Pass `pmremGenerator` at construction, call `setPMREMGenerator(fn)`, or pass one as the second argument.' );

		}
		return pmrem.kickGenerate( renderer, sourceTexture );

	}

	function syncComputeOutputs( computeNode, fullRenderer, syncOpts = {} ) {

		if ( ! settings.computeSync ) return { texturesShared: 0, buffersAdopted: 0, buffersCopied: 0 };
		return syncComputeStorageOutputs( computeNode, fullRenderer, renderer, {
			...syncOpts,
			onError: ( err ) => {

				if ( syncOpts.onError ) syncOpts.onError( err );
				if ( onError ) onError( err, { where: 'syncComputeOutputs' } );

			},
		} );

	}

	/**
	 * Multi-pass variant of {@link syncComputeOutputs}. Call once per pass of
	 * a multi-pass compute graph (e.g. bitonic sort, reductions). The same
	 * sync logic runs, scoped to `passIndex`, and `syncOpts.onPass` (if
	 * supplied) is invoked with `(passIndex, stats)` after the pass.
	 *
	 * When `passIndex` is `undefined`, semantics are identical to
	 * `syncComputeOutputs` (last-pass-only legacy call).
	 */
	function syncComputeOutputsPerPass( computeNode, fullRenderer, passIndex, syncOpts = {} ) {

		if ( ! settings.computeSync ) return { texturesShared: 0, buffersAdopted: 0, buffersCopied: 0, pass: typeof passIndex === 'number' ? passIndex : null };
		return syncComputeStorageOutputsPerPass( computeNode, fullRenderer, renderer, passIndex, {
			...syncOpts,
			onError: ( err ) => {

				if ( syncOpts.onError ) syncOpts.onError( err );
				if ( onError ) onError( err, { where: 'syncComputeOutputsPerPass' } );

			},
		} );

	}

	/**
	 * Invalidate ping-pong storage textures so the slim renderer's bind-group
	 * cache rebuilds against the freshly-swapped resource on the next render.
	 * Pass both texture instances and (optionally) the full renderer that
	 * holds the dispatch-side cache; the slim renderer is always included.
	 *
	 * @param {Object} textureA
	 * @param {Object} textureB
	 * @param {Object} [extraRenderer] - Additional renderer (typically the full renderer) to invalidate alongside slim.
	 */
	function pingPongInvalidateTextures( textureA, textureB, extraRenderer ) {

		const targets = extraRenderer ? [ renderer, extraRenderer ] : [ renderer ];
		return pingPongInvalidate( textureA, textureB, targets );

	}

	/**
	 * Adopt the `GPUBuffer` backing a compute-driven `InstancedBufferAttribute`
	 * (or any `BufferAttribute`) from the full renderer into the slim renderer.
	 * Mirrors `shareShadowTexture` but for the buffer data path.
	 *
	 * Returns `true` on a successful adopt.
	 */
	function shareInstancedAttributeBuffer( attribute, sourceRenderer ) {

		return shareInstancedAttributeBufferIntoSlim( attribute, sourceRenderer, renderer );

	}

	function shareTexture( sourceRenderer, texture ) {

		if ( ! settings.textureSharing ) return false;
		return shareGPUTextureEntry( renderer, sourceRenderer, texture, {
			diagnostics: diagnostics.textureShare,
			onError: ( err, tex ) => onError && onError( err, { where: 'shareTexture', texture: tex } ),
		} );

	}

	function shareShadowTexture( texture, sourceRenderer ) {

		if ( ! settings.textureSharing ) return false;
		return shareShadowGPUTextureIntoSlim( texture, sourceRenderer, renderer );

	}

	// Eagerly boot the full renderer and register a sync `getForRender`
	// fallback so the slim-rewritten Nodes.js can delegate non-precompiled
	// materials (Inspector helpers, addon meshes, etc.) instead of throwing.
	// Idempotent — calling twice is a no-op after the first await resolves.
	let fallbackRegistered = false;
	async function ensureFallback() {

		if ( ! fallback ) throw new Error( 'createSlimSceneSupport: ensureFallback() requires `fullRendererFallback: true` at construction.' );
		if ( fallbackRegistered ) return;
		const fullRenderer = await fallback.getRenderer();
		if ( ! fullRenderer || ! fullRenderer.nodes || typeof fullRenderer.nodes.getForRender !== 'function' ) {

			throw new Error( 'createSlimSceneSupport: ensureFallback() booted a full renderer that has no `nodes.getForRender` — three.js bundle layout has shifted.' );

		}
		setSlimRenderFallback( ( renderObject ) => fullRenderer.nodes.getForRender( renderObject ) );
		fallbackRegistered = true;

	}

	/**
	 * Walk a live post-processing graph and prepare every registered effect
	 * node for slim replay (bloom, outline, ssr, dof, traa, …). This is the
	 * orchestrator equivalent of calling
	 * `preparePrecompiledPostprocess({ ..., loadAux, PrecompiledMaterial })`
	 * directly — it just injects the slim runtime's own `loadAux` and
	 * `PrecompiledMaterial` references for the caller.
	 *
	 * @param {Object} prepArgs - Forwarded to `preparePrecompiledPostprocess`. Pass `{ postProcessing }` or `{ outputNode }`.
	 * @return {{ effects: number, prepared: Array, missed: Array }}
	 */
	function preparePostprocess( prepArgs = {} ) {

		return preparePrecompiledPostprocess( {
			...prepArgs,
			loadAux,
			PrecompiledMaterial,
			diagnostics: prepArgs.diagnostics || diagnostics.postprocess || ( diagnostics.postprocess = { byHandler: {} } ),
		} );

	}

	/**
	 * Lighter-weight companion to `preparePostprocess`. Tags each
	 * sub-pass's live material with `__tslpAuxShape`/`__tslpAuxConfigHash`
	 * so the slim hydrator can bind precompiled WGSL at first render time
	 * instead of physically swapping in `PrecompiledMaterial` instances.
	 * Use this when an effect's `updateBefore` mutates the materials in
	 * ways that don't survive a swap.
	 *
	 * @param {Object} wireArgs - Forwarded to `wirePrecompiledPostprocess`. Pass `{ postProcessing }` or `{ outputNode }`.
	 */
	function wirePostprocess( wireArgs = {} ) {

		return wirePrecompiledPostprocess( wireArgs );

	}

	function dispose() {

		if ( fallbackRegistered ) {

			setSlimRenderFallback( null );
			fallbackRegistered = false;

		}
		if ( fallback ) fallback.dispose();

	}

	return {
		// Sub-helpers (exposed for callers that need lower-level access)
		liveSceneIndex,
		pmrem,
		fallback,
		diagnostics,

		// Convenience methods
		indexScene,
		rememberLiveTexture,
		getFullRenderer,
		ensureFallback,
		generatePMREMAsync,
		setPMREMGenerator,
		syncComputeOutputs,
		syncComputeOutputsPerPass,
		pingPongInvalidate: pingPongInvalidateTextures,
		shareInstancedAttributeBuffer,
		computeNodeUsesStorageTexture: ( node, source ) => computeNodeUsesStorageTexture( node, source ),
		shareTexture,
		shareShadowTexture,
		preparePostprocess,
		wirePostprocess,
		// Wedge 4: clock alignment helpers (same global the runtime writers
		// consult). Expose on the support object for instance-style callers;
		// also exported as standalone functions from `@tsl-precompile/runtime`.
		pinClock,
		unpinClock,
		dispose,
	};

}

/**
 * Pin `nodeFrame.time` to a fixed value during the next render(s). The
 * hydrator runtime + AOT-generated updater both consult
 * `globalThis.__tslpPinnedClock` when writing the `frame.time` UBO slot, so
 * pinning makes time-driven node graphs (`mix(a, b, sin(time*k))`, scrolling
 * UVs, particle position += velocity*time) render with the same `t` value
 * regardless of how many frames replay actually drove before snapshotting.
 *
 * Pass any non-finite value (`null`, `NaN`, `undefined`) to clear the pin —
 * equivalent to `unpinClock()`.
 *
 * @param {number} t
 */
export function pinClock( t ) {

	globalThis.__tslpPinnedClock = ( typeof t === 'number' && Number.isFinite( t ) ) ? t : null;

}

/**
 * Clear the pinned clock — subsequent renders fall back to `frame.time` from
 * the renderer's nodeFrame.
 */
export function unpinClock() {

	globalThis.__tslpPinnedClock = null;

}
