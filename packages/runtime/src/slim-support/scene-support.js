/**
 * `createSlimSceneSupport()` — the public, opt-in orchestrator that ties
 * the focused `slim-support` modules into one entry point for slim-
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
 * import { createSlimSceneSupport } from '@tsl-precompile/runtime';
 *
 * const support = createSlimSceneSupport( {
 *   renderer: slimRenderer,
 *   loadThreeFullModule: () => import('virtual:tsl-precompile/full-three'),
 *   fullRendererFallback: true,
 * } );
 *
 * support.indexScene( scene );
 * const stats = support.syncComputeOutputs( computeNode, fullRenderer );
 * await support.populateShadowMaps( scene, camera );
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
	shareComputeSampledInputs,
} from './compute-sync.js';
import { shareGPUTextureEntry, shareShadowGPUTextureIntoSlim } from './gpu-texture-share.js';
import { createFullRendererFallback } from './full-renderer-fallback.js';
import { setSlimRenderFallback } from './render-fallback-registry.js';
import { normalizeSlimRenderFallbackState } from './render-fallback-state.js';
import {
	renderOffscreenOverrideWithFullRenderer,
	renderPassWithFullRenderer,
	sharePassRenderTargetTextures,
} from './pass-render-fallback.js';
import { populateShadowMapsWithFullRenderer } from './shadow-fallback.js';
import { updateRendererLightingForSlim } from './renderer-lighting.js';
import { wirePrecompiledPostprocess } from './postprocess-wire.js';
import { preparePrecompiledPostprocess } from './postprocess-effects-replay.js';
import { loadAux } from '../aux-loader.js';
import { installLiveTextureRegistryPatches, installTextureLoaderTracking, registerLiveTexture } from '../hydrate/live-texture-registry.js';
import PrecompiledMaterial from '../_vendor-PrecompiledMaterial.js';
import { withTemporalFrame as runWithTemporalFrame } from './temporal-frame.js';

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
 * @param {Object}  [opts.threeModule]           - Optional three namespace used to auto-track TextureLoader/CubeTextureLoader results in the runtime live texture registry.
 * @param {Function} [opts.loadThreeFullModule]  - Async factory for the full-three module, used by the fallback boot.
 * @param {boolean} [opts.fullRendererFallback=false] - Enable the on-the-side full `WebGPURenderer` for compute / shadows / dynamic passes.
 * @param {boolean} [opts.textureLoaderTracking=true] - Patch loader classes from `threeModule`/`threeFullModule` so async textures can relink JSON-loaded artifacts.
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
	function trackLoaderNamespace( namespace ) {

		if ( settings.textureLoaderTracking === false ) return 0;
		const loaderDiagnostics = diagnostics.loader || ( diagnostics.loader = { patchedClasses: 0 } );
		installLiveTextureRegistryPatches( namespace );
		const patched = installTextureLoaderTracking( namespace );
		loaderDiagnostics.patchedClasses += patched;
		return patched;

	}

	const liveSceneIndex = createLiveSceneIndex( { registerLiveTexture } );
	if ( settings.textureLoaderTracking !== false ) {

		trackLoaderNamespace( settings.threeModule );
		if ( settings.threeFullModule && settings.threeFullModule !== settings.threeModule ) {

			trackLoaderNamespace( settings.threeFullModule );

		}

	}

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
	let cachedFullRenderer = null;

	// --- API surface --------------------------------------------------------

	function indexScene( scene ) {

		if ( ! scene || typeof liveSceneIndex.indexScene !== 'function' ) return;
		liveSceneIndex.indexScene( scene );

	}

	function rememberLiveTexture( texture ) {

		if ( texture && typeof liveSceneIndex.rememberLiveTexture === 'function' ) liveSceneIndex.rememberLiveTexture( texture );

	}

	async function getFullRenderer() {

		if ( ! fallback ) return null;
		const fullRenderer = await fallback.getRenderer();
		cachedFullRenderer = fullRenderer || null;
		trackLoaderNamespace( fallback.getModule && fallback.getModule() );
		return fullRenderer;

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

	function shareComputeInputs( computeNode, fullRenderer, shareOpts = {} ) {

		if ( ! settings.computeSync || ! settings.textureSharing ) return { texturesShared: 0, skippedStorageTextures: 0, missingTextures: 0 };
		return shareComputeSampledInputs( computeNode, fullRenderer, renderer, {
			...shareOpts,
			diagnostics: shareOpts.diagnostics || diagnostics.textureShare,
			onError: ( err, tex ) => {

				if ( shareOpts.onError ) shareOpts.onError( err, tex );
				if ( onError ) onError( err, { where: 'shareComputeInputs', texture: tex } );

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

	/**
	 * Populate standard Directional/Spot/Point shadow maps through the lazy full
	 * renderer and share their depth textures back into slim. Transmitted/VSM,
	 * custom, skinned/batched, and morphing cases fail closed with structured
	 * `unsupported` entries; callers can map a retained full node material
	 * through `resolveShadowMaterial`.
	 *
	 * @param {Object} scene
	 * @param {Object} camera
	 * @param {Object} [shadowOpts]
	 * @return {Promise<Object>}
	 */
	async function populateShadowMaps( scene, camera, shadowOpts = {} ) {

		shadowOpts = shadowOpts || {};
		const fullRenderer = shadowOpts.fullRenderer || await getFullRenderer();
		const threeFullModule = shadowOpts.threeFullModule
			|| fallback && fallback.getModule && fallback.getModule()
			|| settings.threeFullModule
			|| null;
		if ( ! fullRenderer || ! threeFullModule ) {

			const err = new Error( 'createSlimSceneSupport: populateShadowMaps() requires a full renderer and its three/webgpu module. Enable `fullRendererFallback` or pass both in shadowOpts.' );
			if ( typeof shadowOpts.onError === 'function' ) shadowOpts.onError( err, { where: 'populateShadowMaps' } );
			if ( onError ) onError( err, { where: 'populateShadowMaps' } );

		}
		const result = await populateShadowMapsWithFullRenderer( {
			...shadowOpts,
			scene,
			camera,
			slimRenderer: renderer,
			fullRenderer,
			threeFullModule,
			resolveShadowMaterial: shadowOpts.resolveShadowMaterial || defaultFullRendererMaterialMapper,
			onError: ( err, detail ) => {

				if ( typeof shadowOpts.onError === 'function' ) shadowOpts.onError( err, detail );
				if ( onError ) onError( err, { where: 'populateShadowMaps', detail } );

			},
		} );
		const shadowDiagnostics = diagnostics.shadow || ( diagnostics.shadow = { calls: 0, rendered: 0, complete: 0, texturesShared: 0, unsupported: 0 } );
		shadowDiagnostics.calls ++;
		if ( result.rendered ) shadowDiagnostics.rendered ++;
		if ( result.complete ) shadowDiagnostics.complete ++;
		shadowDiagnostics.texturesShared += result.texturesShared || 0;
		shadowDiagnostics.unsupported += result.unsupported && result.unsupported.length || 0;
		return result;

	}

	function updateRendererLighting( scene, camera, lightingOpts = {} ) {

		lightingOpts = lightingOpts || {};
		return updateRendererLightingForSlim( renderer, scene, camera, {
			...lightingOpts,
			diagnostics: lightingOpts.diagnostics || diagnostics.compute,
			onError: ( err, where ) => {

				if ( typeof lightingOpts.onError === 'function' ) lightingOpts.onError( err, where );
				if ( onError ) onError( err, { where: 'updateRendererLighting', detail: where } );

			},
		} );

	}

	function createRenderFallbackHandler( fullRenderer ) {

		const nodeManager = fullRenderer && ( fullRenderer.nodes || fullRenderer._nodes );
		if ( ! nodeManager ) return null;

		if ( typeof nodeManager.getForRender === 'function' ) {

			const handler = ( renderObject ) => {

				const result = nodeManager.getForRender( renderObject );
				if ( result && typeof result.then === 'function' ) return null;
				return normalizeSlimRenderFallbackState( result );

			};
			handler.release = ( renderObject ) => {

				if ( typeof nodeManager.delete === 'function' ) nodeManager.delete( renderObject );

			};
			return handler;

		}

		if ( typeof nodeManager._createNodeBuilder === 'function' ) {

			const handler = ( renderObject ) => normalizeSlimRenderFallbackState(
				nodeManager._createNodeBuilder( renderObject, renderObject && renderObject.material ),
			);
			handler.release = ( renderObject ) => {

				if ( typeof nodeManager.delete === 'function' ) nodeManager.delete( renderObject );

			};
			return handler;

		}

		return null;

	}

	// Eagerly boot the full renderer and register a sync `getForRender`
	// fallback so the slim-rewritten Nodes.js can delegate non-precompiled
	// materials (Inspector helpers, addon meshes, etc.) instead of throwing.
	// Idempotent — calling twice is a no-op after the first await resolves.
	let fallbackRegistered = false;
	let computeFallbackInstalled = false;
	let restoreComputeFallback = null;

	function syncDelegatedComputeOutputs( computeNode, fullRenderer ) {

		const nodeKey = computeNode && typeof computeNode === 'object' ? computeNode : null;
		const passIndex = nodeKey ? ( computePassByNode.get( nodeKey ) | 0 ) : 0;
		if ( nodeKey ) computePassByNode.set( nodeKey, passIndex + 1 );

		const seenStorageTextures = [];
		const seenStorageAttrs = [];
		const stats = syncComputeOutputsPerPass( computeNode, fullRenderer, passIndex, {
			onStorageAttr: ( attr ) => {

				seenStorageAttrs.push( attr );

			},
			onStorageTexture: ( texture ) => {

				seenStorageTextures.push( texture );

			},
		} );

		if ( nodeKey && seenStorageTextures.length > 0 ) {

			const prev = computeStorageTextureLedger.get( nodeKey );
			if ( prev && prev.length > 0 ) {

				for ( const texture of seenStorageTextures ) {

					for ( const prevTexture of prev ) {

						if ( prevTexture && prevTexture !== texture ) pingPongInvalidateTextures( prevTexture, texture, fullRenderer );

					}

				}

			}
			computeStorageTextureLedger.set( nodeKey, seenStorageTextures.slice() );

		}

		for ( const attr of seenStorageAttrs ) {

			if ( attr && ( attr.isStorageInstancedBufferAttribute === true || attr.isInstancedBufferAttribute === true ) ) {

				shareInstancedAttributeBuffer( attr, fullRenderer );

			}

		}

		return stats;

	}

	const computePassByNode = new WeakMap();
	const computeStorageTextureLedger = new WeakMap();

	function isRawComputeNode( computeNode ) {

		return computeNode && computeNode.isComputeNode === true && computeNode.isPrecompiledCompute !== true;

	}

	function installComputeFallback() {

		if ( computeFallbackInstalled ) return true;
		if ( ! fallback ) return false;
		const originalCompute = typeof renderer.compute === 'function' ? renderer.compute : null;
		const originalComputeAsync = typeof renderer.computeAsync === 'function' ? renderer.computeAsync : null;

		renderer.compute = function computeWithSlimFallback( computeNode, ...rest ) {

			if ( ! isRawComputeNode( computeNode ) ) return originalCompute ? originalCompute.call( this, computeNode, ...rest ) : undefined;
			const fullRenderer = cachedFullRenderer;
			if ( fullRenderer ) {

				shareComputeInputs( computeNode, fullRenderer );
				const result = typeof fullRenderer.compute === 'function'
					? fullRenderer.compute( computeNode, ...rest )
					: fullRenderer.computeAsync( computeNode, ...rest );
				if ( result && typeof result.then === 'function' ) {

					return result.then( () => syncDelegatedComputeOutputs( computeNode, fullRenderer ) );

				}
				return syncDelegatedComputeOutputs( computeNode, fullRenderer );

			}
			return this.computeAsync( computeNode, ...rest );

		};

		renderer.computeAsync = async function computeAsyncWithSlimFallback( computeNode, ...rest ) {

			if ( ! isRawComputeNode( computeNode ) ) {

				if ( originalComputeAsync ) return originalComputeAsync.call( this, computeNode, ...rest );
				return originalCompute ? originalCompute.call( this, computeNode, ...rest ) : undefined;

			}
			const fullRenderer = await getFullRenderer();
			if ( ! fullRenderer ) return undefined;
			shareComputeInputs( computeNode, fullRenderer );
			if ( typeof fullRenderer.computeAsync === 'function' ) await fullRenderer.computeAsync( computeNode, ...rest );
			else if ( typeof fullRenderer.compute === 'function' ) fullRenderer.compute( computeNode, ...rest );
			return syncDelegatedComputeOutputs( computeNode, fullRenderer );

		};

		restoreComputeFallback = () => {

			if ( originalCompute ) renderer.compute = originalCompute;
			else delete renderer.compute;
			if ( originalComputeAsync ) renderer.computeAsync = originalComputeAsync;
			else delete renderer.computeAsync;

		};
		computeFallbackInstalled = true;
		return true;

	}

	async function ensureFallback() {

		if ( ! fallback ) throw new Error( 'createSlimSceneSupport: ensureFallback() requires `fullRendererFallback: true` at construction.' );
		if ( fallbackRegistered ) return;
		const fullRenderer = await getFullRenderer();
		const handler = createRenderFallbackHandler( fullRenderer );
		if ( ! handler ) {

			throw new Error( 'createSlimSceneSupport: ensureFallback() booted a full renderer that has no node render fallback hook — three.js bundle layout has shifted.' );

		}
		setSlimRenderFallback( handler );
		installComputeFallback();
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

	function defaultFullRendererMaterialMapper( material, _object, context ) {

		if ( material && material.isPrecompiledMaterial === true && material.__tslpSourceMaterial ) return material.__tslpSourceMaterial;
		const originalMaterial = context && context.originalMaterial;
		if ( originalMaterial && originalMaterial.isPrecompiledMaterial === true && originalMaterial.__tslpSourceMaterial === material ) return material;
		return null;

	}

	/**
	 * Render a live PassNode through the full-renderer fallback and share the
	 * produced render-target textures back into the slim renderer. This is the
	 * public orchestrator equivalent of the harness's
	 * `__renderPassNodeWithFullRenderer` primitive, minus harness-specific
	 * material-swap policy.
	 *
	 * @param {Object} passNode
	 * @param {Object} [passOpts]
	 * @param {Object} [passOpts.fullRenderer] - Optional caller-owned full renderer. Defaults to this support object's fallback renderer.
	 * @param {Object} [passOpts.camera] - Camera override. Defaults to `passNode.camera`.
	 * @param {Function} [passOpts.beforeRender] - Optional hook run after render-target state is installed and before `fullRenderer.render`.
	 * @param {boolean} [passOpts.shareTextures=true] - Share color/MRT textures back into slim after a successful render.
	 * @param {boolean} [passOpts.shareDepth=true] - Share `renderTarget.depthTexture` when present.
	 * @param {Function} [passOpts.onError] - Per-call error handler.
	 * @return {Promise<{ rendered: boolean, texturesShared: number, depthShared: boolean }>}
	 */
	async function renderPassWithFallback( passNode, passOpts = {} ) {

		passOpts = passOpts || {};
		const fullRenderer = passOpts.fullRenderer || await getFullRenderer();
		const stats = { rendered: false, texturesShared: 0, depthShared: false };

		if ( ! fullRenderer ) {

			const err = new Error( 'createSlimSceneSupport: renderPassWithFallback() requires `fullRendererFallback: true` or a `passOpts.fullRenderer`.' );
			if ( typeof passOpts.onError === 'function' ) passOpts.onError( err );
			if ( onError ) onError( err, { where: 'renderPassWithFallback' } );
			return stats;

		}

		stats.rendered = renderPassWithFullRenderer( {
			passNode,
			slimRenderer: renderer,
			fullRenderer,
			camera: passOpts.camera,
			beforeRender: passOpts.beforeRender,
			onError: ( err ) => {

				if ( typeof passOpts.onError === 'function' ) passOpts.onError( err );
				if ( onError ) onError( err, { where: 'renderPassWithFallback' } );

			},
		} );

		if ( stats.rendered && passOpts.shareTextures !== false && settings.textureSharing ) {

			const shared = sharePassRenderTargetTextures( {
				passNode,
				slimRenderer: renderer,
				fullRenderer,
				shareDepth: passOpts.shareDepth !== false,
				diagnostics: diagnostics.textureShare,
				onError: ( err, texture ) => {

					if ( typeof passOpts.onError === 'function' ) passOpts.onError( err, texture );
					if ( onError ) onError( err, { where: 'renderPassWithFallback.shareTexture', texture } );

				},
			} );
			stats.texturesShared = shared.texturesShared;
			stats.depthShared = shared.depthShared;

		}

		return stats;

	}

	/**
	 * Render the slim renderer's current offscreen target through the full
	 * renderer when the scene has an override material, then share the produced
	 * target textures back into slim. This covers contact-shadow/depth-style
	 * offscreen passes in real projects using the slim runtime.
	 *
	 * @param {Object} scene
	 * @param {Object} camera
	 * @param {Object} [offscreenOpts]
	 * @param {Object} [offscreenOpts.fullRenderer] - Optional caller-owned full renderer. Defaults to this support object's fallback renderer.
	 * @param {Object} [offscreenOpts.renderTarget] - Optional render target. Defaults to `renderer.getRenderTarget()`.
	 * @param {Function} [offscreenOpts.beforeRender] - Optional hook run after render-target state is installed and before `fullRenderer.render`.
	 * @param {Function} [offscreenOpts.withSourceMaterials] - Optional `(scene, render) => void` wrapper for temporary source-material swaps.
	 * @param {Function} [offscreenOpts.materialMapper] - Optional `(material) => material` mapper for temporary scene material swaps.
	 * @param {boolean} [offscreenOpts.shareTextures=true] - Share color/MRT textures back into slim after a successful render.
	 * @param {boolean} [offscreenOpts.shareDepth=true] - Share `renderTarget.depthTexture` when present.
	 * @param {Function} [offscreenOpts.onError] - Per-call error handler.
	 * @return {Promise<{ rendered: boolean, texturesShared: number, depthShared: boolean }>}
	 */
	async function renderOffscreenOverrideWithFallback( scene, camera, offscreenOpts = {} ) {

		offscreenOpts = offscreenOpts || {};
		const fullRenderer = offscreenOpts.fullRenderer || await getFullRenderer();
		const empty = { rendered: false, texturesShared: 0, depthShared: false };

		if ( ! fullRenderer ) {

			const err = new Error( 'createSlimSceneSupport: renderOffscreenOverrideWithFallback() requires `fullRendererFallback: true` or an `offscreenOpts.fullRenderer`.' );
			if ( typeof offscreenOpts.onError === 'function' ) offscreenOpts.onError( err );
			if ( onError ) onError( err, { where: 'renderOffscreenOverrideWithFallback' } );
			return empty;

		}

		return renderOffscreenOverrideWithFullRenderer( {
			scene,
			camera,
			slimRenderer: renderer,
			fullRenderer,
			renderTarget: offscreenOpts.renderTarget,
			beforeRender: offscreenOpts.beforeRender,
			withSourceMaterials: offscreenOpts.withSourceMaterials,
			materialMapper: offscreenOpts.materialMapper || defaultFullRendererMaterialMapper,
			shareTextures: offscreenOpts.shareTextures !== false && settings.textureSharing,
			shareDepth: offscreenOpts.shareDepth !== false,
			diagnostics: diagnostics.textureShare,
			onError: ( err, texture ) => {

				if ( typeof offscreenOpts.onError === 'function' ) offscreenOpts.onError( err, texture );
				if ( onError ) onError( err, { where: 'renderOffscreenOverrideWithFallback', texture } );

			},
		} );

	}

	function dispose() {

		if ( restoreComputeFallback ) {

			restoreComputeFallback();
			restoreComputeFallback = null;
			computeFallbackInstalled = false;

		}
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
			shareComputeInputs,
			syncComputeOutputsPerPass,
		pingPongInvalidate: pingPongInvalidateTextures,
		shareInstancedAttributeBuffer,
		computeNodeUsesStorageTexture: ( node, source ) => computeNodeUsesStorageTexture( node, source ),
		shareTexture,
		shareShadowTexture,
		populateShadowMaps,
		updateRendererLighting,
		installComputeFallback,
		preparePostprocess,
		wirePostprocess,
		renderPassWithFallback,
		renderOffscreenOverrideWithFallback,
		// Wedge 4: clock alignment helpers (same global the runtime writers
		// consult). Expose on the support object for instance-style callers;
		// also exported as standalone functions from `@tsl-precompile/runtime`.
		pinClock,
		unpinClock,
		withTemporalFrame: ( options, callback, extraRenderers = [] ) => runWithTemporalFrame(
			[ renderer, cachedFullRenderer, ...( Array.isArray( extraRenderers ) ? extraRenderers : [ extraRenderers ] ) ],
			options,
			callback,
		),
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
