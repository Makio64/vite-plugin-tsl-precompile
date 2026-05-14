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
import { syncComputeStorageOutputs, computeNodeUsesStorageTexture } from './compute-sync.js';
import { shareGPUTextureEntry, shareShadowGPUTextureIntoSlim } from './gpu-texture-share.js';
import { createFullRendererFallback } from './full-renderer-fallback.js';
import { setSlimRenderFallback } from './render-fallback-registry.js';

const DEFAULT_OPTS = {
	fullRendererFallback: false,
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
	const fallback = settings.fullRendererFallback ? createFullRendererFallback( {
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
		computeNodeUsesStorageTexture: ( node, source ) => computeNodeUsesStorageTexture( node, source ),
		shareTexture,
		shareShadowTexture,
		dispose,
	};

}
