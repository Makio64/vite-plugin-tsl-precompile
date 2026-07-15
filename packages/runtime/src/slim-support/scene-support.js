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
	computeSyncNeedsPresentation,
	shareComputeSampledInputs,
} from './compute-sync.js';
import { collectMaterialComputeBindings, collectMaterialComputeOwners, createAutoComputeDispatcher } from './auto-compute.js';
import { shareGPUTextureEntry, shareShadowGPUTextureIntoSlim } from './gpu-texture-share.js';
import { createFullRendererFallback } from './full-renderer-fallback.js';
import { setSlimRenderFallback } from './render-fallback-registry.js';
import { normalizeSlimRenderFallbackState } from './render-fallback-state.js';
import {
	renderOffscreenOverrideWithFullRenderer,
	renderPassWithFullRenderer,
	sharePassRenderTargetTextures,
} from './pass-render-fallback.js';
import { disposeShadowMapsWithFullRenderer, populateShadowMapsWithFullRenderer } from './shadow-fallback.js';
import { updateRendererLightingForSlim } from './renderer-lighting.js';
import { wirePrecompiledPostprocess } from './postprocess-wire.js';
import { preparePrecompiledPostprocess } from './postprocess-effects-replay.js';
import { loadAux } from '../aux-loader.js';
import { installLiveTextureRegistryPatches, installTextureLoaderTracking, registerLiveTexture } from '../hydrate/live-texture-registry.js';
import {
	claimMaterialComputeDelegation,
	inspectRuntimeMaterialComputeFamily,
	releaseMaterialComputeDelegation,
	resolveMaterialComputePath,
} from '../hydrate/material-compute-ownership.js';
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

const MATERIAL_COMPUTE_WRITE_ACCESS = new Set( [ 'readWrite', 'writeOnly' ] );

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
	const materialCompute = createAutoComputeDispatcher( {
		renderer,
		onError: ( err, detail ) => onError && onError( err, { where: 'materialCompute', detail } ),
	} );
	const materialComputeDelegationOwner = {};
	const delegatedMaterialComputeMaterials = new Set();
	let materialComputeDispatchTail = Promise.resolve();
	let materialComputeDispatchPending = 0;
	let materialComputeDisposed = false;

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
	const shadowCache = new Map();
	const shadowDisposals = new Set();
	let activeDispose = null;

	// --- API surface --------------------------------------------------------

	function indexScene( scene ) {

		if ( ! scene || typeof liveSceneIndex.indexScene !== 'function' ) return;
		liveSceneIndex.indexScene( scene );

	}

	function rememberLiveTexture( texture ) {

		if ( texture && typeof liveSceneIndex.rememberLiveTexture === 'function' ) liveSceneIndex.rememberLiveTexture( texture );

	}

	async function getFullRenderer() {

		if ( cachedFullRenderer ) return cachedFullRenderer;
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

		if ( ! settings.computeSync ) return { texturesShared: 0, storageAttrs: 0, buffersAdopted: 0, buffersCopied: 0 };
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

		if ( ! settings.computeSync ) return { texturesShared: 0, storageAttrs: 0, buffersAdopted: 0, buffersCopied: 0, pass: typeof passIndex === 'number' ? passIndex : null };
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
			cache: shadowCache,
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

	function requestShadowMapDisposals( scene ) {

		const scenes = scene === undefined ? Array.from( shadowCache.keys() ) : [ scene ];
		let immediate = 0;
		const pending = [];
		for ( const targetScene of scenes ) {

			const result = disposeShadowMapsWithFullRenderer( { scene: targetScene, cache: shadowCache } );
			if ( result && typeof result.then === 'function' ) {

				const tracked = Promise.resolve( result ).then( ( disposed ) => disposed ? 1 : 0 );
				shadowDisposals.add( tracked );
				void tracked.finally( () => shadowDisposals.delete( tracked ) );
				pending.push( tracked );

			} else if ( result ) {

				immediate ++;

			}

		}
		return { immediate, pending };

	}

	/**
	 * Dispose one scene's cached shadow proxy, or every proxy owned by this
	 * support object when `scene` is omitted.
	 *
	 * @param {Object} [scene]
	 * @returns {Promise<number>} number of cached scene states disposed
	 */
	function disposeShadowMaps( scene ) {

		const { immediate, pending } = requestShadowMapDisposals( scene );
		if ( pending.length === 0 ) return Promise.resolve( immediate );
		return Promise.all( pending ).then( ( counts ) => immediate + counts.reduce( ( total, count ) => total + count, 0 ) );

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

	function syncDelegatedComputeOutputs( computeNode, fullRenderer, syncOpts = {} ) {

		const nodeKey = computeNode && typeof computeNode === 'object' ? computeNode : null;
		const passIndex = nodeKey ? ( computePassByNode.get( nodeKey ) | 0 ) : 0;
		if ( nodeKey ) computePassByNode.set( nodeKey, passIndex + 1 );

		const seenStorageTextures = [];
		const seenStorageAttrs = [];
		const stats = syncComputeOutputsPerPass( computeNode, fullRenderer, passIndex, {
			...syncOpts,
			onStorageAttr: ( attr, binding, location ) => {

				seenStorageAttrs.push( attr );
				if ( typeof syncOpts.onStorageAttr === 'function' ) syncOpts.onStorageAttr( attr, binding, location );

			},
			onStorageTexture: ( texture, binding, location ) => {

				seenStorageTextures.push( texture );
				if ( typeof syncOpts.onStorageTexture === 'function' ) syncOpts.onStorageTexture( texture, binding, location );

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
	const initializedMaterialComputeNodes = new WeakSet();

	function isRawComputeNode( computeNode ) {

		return computeNode && computeNode.isComputeNode === true && computeNode.isPrecompiledCompute !== true;

	}

	function installComputeFallback( sourceRenderer = null ) {

		if ( sourceRenderer ) cachedFullRenderer = sourceRenderer;
		if ( computeFallbackInstalled ) return true;
		if ( ! fallback && ! cachedFullRenderer ) return false;
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
			const fullRenderer = cachedFullRenderer || await getFullRenderer();
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

	function finalizeMaterialComputeStats( stats ) {

		stats.inputTexturesShared = 0;
		stats.texturesShared = 0;
		stats.storageAttrs = 0;
		stats.buffersAdopted = 0;
		stats.buffersCopied = 0;
		stats.presentationNeeded = false;
		for ( const result of stats.dispatchResults ) {

			if ( ! result || typeof result !== 'object' ) continue;
			stats.inputTexturesShared += result.inputTexturesShared || 0;
			stats.texturesShared += result.texturesShared || 0;
			stats.storageAttrs += result.storageAttrs || 0;
			stats.buffersAdopted += result.buffersAdopted || 0;
			stats.buffersCopied += result.buffersCopied || 0;
			if ( computeSyncNeedsPresentation( result ) ) stats.presentationNeeded = true;

		}
		return stats;

	}

	async function initializeMaterialComputeNode( computeNode ) {

		const onInit = computeNode && computeNode.onInitFunction;
		if ( typeof onInit !== 'function' || initializedMaterialComputeNodes.has( computeNode ) ) return;
		initializedMaterialComputeNodes.add( computeNode );
		// Three invokes this callback without awaiting it and exposes the full
		// renderer. In hybrid mode the application owns the slim renderer, so
		// preserve that public identity and await nested initialization kernels.
		try { computeNode.onInitFunction = null; } catch ( _ ) {}
		if ( computeNode.onInitFunction !== null ) {

			initializedMaterialComputeNodes.delete( computeNode );
			const error = new Error( 'createSlimSceneSupport: material compute onInitFunction must be temporarily writable so initialization can be awaited exactly once.' );
			error.code = 'TSLP_MATERIAL_COMPUTE_ON_INIT_IMMUTABLE';
			throw error;

		}
		try {

			await onInit.call( computeNode, { renderer } );

		} catch ( error ) {

			initializedMaterialComputeNodes.delete( computeNode );
			try {

				if ( computeNode.onInitFunction === null ) computeNode.onInitFunction = onInit;

			} catch ( _ ) { /* the next transaction will fail closed as immutable */ }
			throw error;

		}

	}

	async function rejectMaterialComputeDispatch( scene, computeOpts, bindings, error ) {

		if ( typeof computeOpts.onError === 'function' ) computeOpts.onError( error, { where: 'dispatchMaterialComputes' } );
		if ( onError ) onError( error, { where: 'dispatchMaterialComputes' } );
		const stats = await materialCompute.dispatch( scene, {
			...computeOpts,
			bindings: [],
			fullRenderer: null,
			shouldDispatch: () => false,
		} );
		stats.owners = bindings.length;
		stats.nodes = new Set( bindings.map( ( binding ) => binding && binding.computeNode ).filter( Boolean ) ).size;
		stats.errors ++;
		return finalizeMaterialComputeStats( stats );

	}

	/**
	 * Dispatch raw ComputeNodes owned by precompiled material slots, then
	 * reconnect their writable storage attributes to the selected artifact
	 * variant. Rendering stays explicit so applications control presentation:
	 * `await support.dispatchMaterialComputes(scene); renderer.render(...)`.
	 *
	 * This hybrid path requires the real ComputeNode graph to remain reachable
	 * from `material.__tslpSourceMaterial` (or the material itself) and a full
	 * renderer capable of compiling it.
	 */
	async function dispatchMaterialComputesNow( scene, computeOpts = {} ) {

		computeOpts = computeOpts || {};
		const collectedBindings = Array.isArray( computeOpts.bindings )
			? computeOpts.bindings.slice()
			: collectMaterialComputeBindings( scene, computeOpts );
		const ownerRecords = collectMaterialComputeOwners( scene, computeOpts );
		const ownerByMaterial = new Map( ownerRecords.map( ( owner ) => [ owner.material, owner ] ) );
		for ( const binding of collectedBindings ) if ( binding && binding.material && ! ownerByMaterial.has( binding.material ) ) ownerByMaterial.set( binding.material, {
			object: binding.object || null,
			objects: binding.object ? [ binding.object ] : [],
			material: binding.material,
			sourceMaterial: binding.sourceMaterial || binding.material.__tslpSourceMaterial || binding.material,
		} );
		// A lease proves that one complete dispatch/synchronisation transaction
		// succeeded. Revoke this support owner's previous transaction before
		// inspecting or dispatching the next one; every failure below therefore
		// leaves hydration closed instead of presenting stale output.
		for ( const material of ownerByMaterial.keys() ) if ( delegatedMaterialComputeMaterials.has( material ) ) {

			releaseMaterialComputeDelegation( material, materialComputeDelegationOwner );
			delegatedMaterialComputeMaterials.delete( material );

		}
		const bindingsByMaterial = new Map();
		for ( const binding of collectedBindings ) {

			let materialBindings = bindingsByMaterial.get( binding && binding.material );
			if ( ! materialBindings ) bindingsByMaterial.set( binding && binding.material, materialBindings = [] );
			materialBindings.push( binding );

		}
		const bindingPolicies = new Map();
		const policiesByMaterial = new Map();
		const hybridExpectedByMaterial = new Map();
		const precompiledNodes = new Set();
		const includedNodes = new Set();
		const bindings = [];
		try {

			for ( const [ material, owner ] of ownerByMaterial ) {

				const artifact = material && material.precompiledArtifact;
				const inspection = artifact ? inspectRuntimeMaterialComputeFamily( artifact ) : { status: 'none' };
				const mode = inspection.status === 'uniform' ? inspection.descriptor.mode : 'legacy';
				const materialBindings = bindingsByMaterial.get( material ) || [];
				const rawNodes = new Set( materialBindings.map( ( binding ) => binding.computeNode ) );
				const expectedNodes = new Set();
				const expectedKernelByNode = new Map();
				const scheduleCadences = inspection.status === 'uniform'
					? new Set( inspection.descriptor.schedule.map( ( entry ) => entry.updateType ) )
					: new Set();
				if ( mode === 'hybrid-required' && scheduleCadences.size !== 1 ) {

					const error = new Error( 'createSlimSceneSupport: hybrid material compute requires one uniform update cadence per delegated transaction.' );
					error.code = 'TSLP_MATERIAL_COMPUTE_MIXED_CADENCE_UNSUPPORTED';
					throw error;

				}
				const objectCadence = inspection.status === 'uniform' && (
					inspection.descriptor.schedule.some( ( entry ) => entry && entry.updateType === 'object' )
					|| inspection.descriptor.kernels.some( ( kernel ) => kernel.updates.some( ( entry ) => entry && entry.updateType === 'object' ) )
				);
				if ( mode === 'hybrid-required' && objectCadence && Array.isArray( owner.objects ) && owner.objects.length > 1 ) {

					const error = new Error( 'createSlimSceneSupport: hybrid object-cadence material compute cannot be delegated once for a material shared by multiple scene objects.' );
					error.code = 'TSLP_MATERIAL_COMPUTE_OBJECT_CADENCE_UNSUPPORTED';
					throw error;

				}
				if ( inspection.status === 'uniform' && ( mode === 'hybrid-required' || rawNodes.size > 0 ) ) {

					for ( const kernel of inspection.descriptor.kernels ) {

						const node = resolveMaterialComputePath( owner.sourceMaterial, kernel.nodePath );
						if ( ! node || node.isComputeNode !== true || node.isPrecompiledCompute === true ) {

							const error = new Error( `createSlimSceneSupport: ${ kernel.id } did not resolve the exact retained raw ComputeNode at ${ JSON.stringify( kernel.nodePath ) }.` );
							error.code = 'TSLP_MATERIAL_COMPUTE_KERNEL_PATH_MISS';
							throw error;

						}
						expectedNodes.add( node );
						expectedKernelByNode.set( node, kernel );

					}
					if ( mode === 'hybrid-required' ) for ( const node of expectedNodes ) if ( ! rawNodes.has( node ) ) {

						const kernel = expectedKernelByNode.get( node );
						const binding = {
							object: owner.object || null,
							material,
							sourceMaterial: owner.sourceMaterial,
							computeNode: node,
							properties: kernel && kernel.nodePath.length > 0 ? [ kernel.nodePath[ 0 ] ] : [],
						};
						collectedBindings.push( binding );
						materialBindings.push( binding );
						rawNodes.add( node );

					}
					const exact = expectedNodes.size === inspection.descriptor.kernels.length
						&& rawNodes.size === expectedNodes.size
						&& [ ...rawNodes ].every( ( node ) => expectedNodes.has( node ) );
					if ( ! exact ) {

						const error = new Error( `createSlimSceneSupport: retained raw material compute does not exactly match its ${ inspection.descriptor.kernels.length } contracted kernel path(s).` );
						error.code = 'TSLP_MATERIAL_COMPUTE_KERNEL_SET_MISMATCH';
						throw error;

					}

				}
				const policy = { inspection, mode, expectedNodes, expectedKernelByNode, objectCadence, cadence: scheduleCadences.values().next().value || null, objects: owner.objects || [] };
				policiesByMaterial.set( material, policy );
				if ( mode === 'hybrid-required' ) {

					hybridExpectedByMaterial.set( material, { inspection, nodes: expectedNodes } );

				}

			}
			const objectCadenceOwnersByNode = new Map();
			for ( const binding of collectedBindings ) {

				const policy = policiesByMaterial.get( binding.material ) || { inspection: { status: 'none' }, mode: 'legacy', expectedNodes: new Set() };
				bindingPolicies.set( binding, policy );
				if ( policy.mode === 'hybrid-required' && policy.objectCadence ) {

					let owners = objectCadenceOwnersByNode.get( binding.computeNode );
					if ( ! owners ) objectCadenceOwnersByNode.set( binding.computeNode, owners = new Set() );
					const objects = Array.isArray( policy.objects ) && policy.objects.length > 0 ? policy.objects : [ binding.object || binding.material ];
					for ( const object of objects ) owners.add( object );

				}
				if ( policy.mode === 'precompiled' ) {

					precompiledNodes.add( binding.computeNode );
					continue;

				}
				bindings.push( binding );
				includedNodes.add( binding.computeNode );

			}
			for ( const owners of objectCadenceOwnersByNode.values() ) if ( owners.size > 1 ) {

				const error = new Error( 'createSlimSceneSupport: one hybrid object-cadence ComputeNode cannot be delegated once for multiple live object owners.' );
				error.code = 'TSLP_MATERIAL_COMPUTE_OBJECT_CADENCE_UNSUPPORTED';
				throw error;

			}

		} catch ( error ) {

			return rejectMaterialComputeDispatch( scene, computeOpts, collectedBindings, error );

		}
		for ( const node of precompiledNodes ) if ( includedNodes.has( node ) ) return rejectMaterialComputeDispatch(
			scene,
			computeOpts,
			collectedBindings,
			new Error( 'createSlimSceneSupport: one raw ComputeNode is shared by precompiled and delegated material-compute owners; recapture those owners together so sharing can fail closed.' ),
		);
		if ( bindings.length === 0 ) return finalizeMaterialComputeStats( await materialCompute.dispatch( scene, { ...computeOpts, bindings } ) );
		if ( ! settings.computeSync ) {

			return rejectMaterialComputeDispatch( scene, computeOpts, bindings, new Error( 'createSlimSceneSupport: dispatchMaterialComputes() requires `computeSync: true` so delegated outputs can be adopted by the slim renderer.' ) );

		}

		const fullRenderer = computeOpts.fullRenderer || await getFullRenderer();
		if ( ! fullRenderer ) {

			return rejectMaterialComputeDispatch( scene, computeOpts, bindings, new Error( 'createSlimSceneSupport: dispatchMaterialComputes() requires a full renderer. Enable `fullRendererFallback` or pass `computeOpts.fullRenderer`.' ) );

		}
		const slimDevice = renderer.backend && renderer.backend.device;
		const fullDevice = fullRenderer.backend && fullRenderer.backend.device;
		if ( slimDevice && fullDevice && slimDevice !== fullDevice ) {

			return rejectMaterialComputeDispatch( scene, computeOpts, bindings, new Error( 'createSlimSceneSupport: dispatchMaterialComputes() requires slim and full renderers to share the same GPUDevice.' ) );

		}

		// Material compute `onInit()` callbacks can call the app's slim
		// renderer. Route those nested raw kernels through this same full
		// renderer while the explicit owner dispatch is active.
		installComputeFallback( fullRenderer );
		try {

			// Initialization can mutate the kernel graph and its bind groups. It
			// must complete before auto-compute asks `_nodes.getForCompute()` to
			// prepare output ownership, otherwise a failed/partial onInit can be
			// cached as if it were the final kernel.
			for ( const computeNode of includedNodes ) await initializeMaterialComputeNode( computeNode );

		} catch ( error ) {

			return rejectMaterialComputeDispatch( scene, computeOpts, bindings, error );

		}
		let resourceErrors = 0;
		const dispatchedNodes = new Set();
		const dispatchedHybridNodes = new Set();
		const hybridNodes = new Set();
		for ( const expected of hybridExpectedByMaterial.values() ) for ( const node of expected.nodes ) hybridNodes.add( node );
		const hybridOutputRequirements = ( computeNode, owners ) => {

			const requirements = new Map();
			for ( const owner of owners ) {

				const policy = bindingPolicies.get( owner );
				if ( ! policy || policy.mode !== 'hybrid-required' || policy.inspection.status !== 'uniform' ) continue;
				const descriptor = policy.inspection.descriptor;
				const kernel = policy.expectedKernelByNode.get( computeNode );
				if ( ! kernel ) continue;
				const resources = new Map( descriptor.resources.map( ( resource ) => [ resource.id, resource ] ) );
				for ( const binding of descriptor.bindings ) {

					if ( binding.kernel !== kernel.id || ! MATERIAL_COMPUTE_WRITE_ACCESS.has( binding.access ) ) continue;
					const resource = resources.get( binding.resource );
					if ( ! resource ) continue;
					const key = `${ resource.kind }:${ binding.group }:${ binding.binding }`;
					requirements.set( key, { ...binding, kind: resource.kind } );

				}

			}
			return requirements;

		};
		const callerDispatchOnce = computeOpts.dispatchOnce instanceof Set ? computeOpts.dispatchOnce : null;
		// Contracted hybrid kernels must participate in this transaction even if
		// a caller-owned once set still contains a claim from an older frame. Keep
		// legacy nodes on the caller policy and publish successful hybrid dispatches
		// back into that set only after they complete.
		const dispatchOnce = callerDispatchOnce && hybridNodes.size > 0
			? new Set( [ ...callerDispatchOnce ].filter( ( node ) => ! hybridNodes.has( node ) ) )
			: callerDispatchOnce;
		const reportResourceError = ( error, detail ) => {

			resourceErrors ++;
			if ( typeof computeOpts.onError === 'function' ) computeOpts.onError( error, detail );

		};
		const stats = await materialCompute.dispatch( scene, {
			...computeOpts,
			bindings,
			dispatchOnce,
			forceDispatch: ( computeNode, owners ) => {

				const contractRequiresDispatch = owners.some( ( owner ) => bindingPolicies.get( owner )?.mode === 'hybrid-required' );
				if ( contractRequiresDispatch ) return true;
				if ( computeOpts.forceDispatch === true ) return true;
				return typeof computeOpts.forceDispatch === 'function' && computeOpts.forceDispatch( computeNode, owners ) === true;

			},
			onDispatched: ( computeNode, owners, result ) => {

				if ( typeof computeOpts.onDispatched === 'function' ) computeOpts.onDispatched( computeNode, owners, result );
				dispatchedNodes.add( computeNode );
				if ( owners.some( ( owner ) => bindingPolicies.get( owner )?.mode === 'hybrid-required' ) ) dispatchedHybridNodes.add( computeNode );

			},
			fullRenderer,
			dispatchNode: async ( computeNode, owners ) => {

				await initializeMaterialComputeNode( computeNode );
				const outputRequirements = hybridOutputRequirements( computeNode, owners );
				const shareOptions = computeOpts.shareOptions || {};
				const inputStats = shareComputeInputs( computeNode, fullRenderer, {
					...shareOptions,
					onError: ( error, resource ) => {

						if ( typeof shareOptions.onError === 'function' ) shareOptions.onError( error, resource );
						reportResourceError( error, { where: 'dispatchMaterialComputes.shareInputs', resource } );

					},
				} );
				const args = typeof computeOpts.computeArgs === 'function'
					? computeOpts.computeArgs( computeNode, owners )
					: computeOpts.computeArgs;
				const rest = Array.isArray( args ) ? args : [];
				if ( typeof fullRenderer.computeAsync === 'function' ) await fullRenderer.computeAsync( computeNode, ...rest );
				else if ( typeof fullRenderer.compute === 'function' ) await fullRenderer.compute( computeNode, ...rest );
				else throw new Error( 'createSlimSceneSupport: the full renderer exposes neither computeAsync() nor compute().' );
				const syncOptions = computeOpts.syncOptions || {};
				const syncedOutputLocations = new Set();
				const syncStats = syncDelegatedComputeOutputs( computeNode, fullRenderer, {
					...syncOptions,
					onStorageAttrSynced: ( attribute, binding, location ) => {

						if ( typeof syncOptions.onStorageAttrSynced === 'function' ) syncOptions.onStorageAttrSynced( attribute, binding, location );
						syncedOutputLocations.add( `storage-buffer:${ location.group }:${ location.binding }` );

					},
					onStorageTextureSynced: ( texture, binding, location ) => {

						if ( typeof syncOptions.onStorageTextureSynced === 'function' ) syncOptions.onStorageTextureSynced( texture, binding, location );
						syncedOutputLocations.add( `storage-texture:${ location.group }:${ location.binding }` );

					},
					onError: ( error ) => {

						if ( typeof syncOptions.onError === 'function' ) syncOptions.onError( error );
						reportResourceError( error, { where: 'dispatchMaterialComputes.syncOutputs' } );

					},
				} );
				const missingOutputs = [ ...outputRequirements ].filter( ( [ key ] ) => ! syncedOutputLocations.has( key ) );
				if ( missingOutputs.length > 0 ) {

					const error = new Error( `createSlimSceneSupport: delegated material compute did not synchronize ${ missingOutputs.length } contracted output binding(s).` );
					error.code = 'TSLP_MATERIAL_COMPUTE_OUTPUT_SYNC_MISS';
					error.missingOutputs = missingOutputs.map( ( [ , requirement ] ) => requirement );
					throw error;

				}
				return {
					...syncStats,
					inputTexturesShared: inputStats.texturesShared || 0,
				};

			},
		} );

		stats.errors += resourceErrors;
		if ( stats.errors === 0 && callerDispatchOnce ) for ( const node of dispatchedNodes ) callerDispatchOnce.add( node );
		if ( stats.errors === 0 && hybridExpectedByMaterial.size > 0 ) {

			const claimable = [];
			for ( const [ material, expected ] of hybridExpectedByMaterial ) {

				const complete = [ ...expected.nodes ].every( ( node ) => dispatchedHybridNodes.has( node ) );
				if ( complete ) claimable.push( material );
				else {

					stats.errors ++;
					const error = new Error( 'createSlimSceneSupport: hybrid material-compute delegation did not dispatch every contracted raw kernel.' );
					if ( typeof computeOpts.onError === 'function' ) computeOpts.onError( error, { where: 'dispatchMaterialComputes.claim', material } );
					if ( onError ) onError( error, { where: 'dispatchMaterialComputes.claim', material } );

				}

			}
			if ( stats.errors === 0 ) {

				const newlyClaimed = [];
				try {

					for ( const material of claimable ) {

						claimMaterialComputeDelegation( material, materialComputeDelegationOwner, material.precompiledArtifact );
						delegatedMaterialComputeMaterials.add( material );
						newlyClaimed.push( material );

					}

				} catch ( error ) {

					for ( const material of newlyClaimed ) {

						releaseMaterialComputeDelegation( material, materialComputeDelegationOwner );
						delegatedMaterialComputeMaterials.delete( material );

					}
					stats.errors ++;
					if ( typeof computeOpts.onError === 'function' ) computeOpts.onError( error, { where: 'dispatchMaterialComputes.claim' } );
					if ( onError ) onError( error, { where: 'dispatchMaterialComputes.claim' } );

				}

			}

		}
		return finalizeMaterialComputeStats( stats );

	}

	function dispatchMaterialComputes( scene, computeOpts = {} ) {

		if ( materialComputeDisposed ) return Promise.reject( new Error( 'createSlimSceneSupport: dispatchMaterialComputes() cannot run after dispose().' ) );
		materialComputeDispatchPending ++;
		const run = materialComputeDispatchTail.then( () => {

			if ( materialComputeDisposed ) throw new Error( 'createSlimSceneSupport: dispatchMaterialComputes() was cancelled by dispose().' );
			return dispatchMaterialComputesNow( scene, computeOpts );

		} );
		materialComputeDispatchTail = run.then( () => undefined, () => undefined );
		run.finally( () => { materialComputeDispatchPending --; } ).catch( () => {} );
		return run;

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

		if ( activeDispose ) return activeDispose;
		materialComputeDisposed = true;
		for ( const material of delegatedMaterialComputeMaterials ) releaseMaterialComputeDelegation( material, materialComputeDelegationOwner );
		delegatedMaterialComputeMaterials.clear();
		requestShadowMapDisposals();
		const pendingShadowDisposals = Array.from( shadowDisposals );
		const finish = () => {

			// An in-flight transaction may have acquired a lease after disposal
			// began. Revoke again only after the serialized dispatch queue drains.
			for ( const material of delegatedMaterialComputeMaterials ) releaseMaterialComputeDelegation( material, materialComputeDelegationOwner );
			delegatedMaterialComputeMaterials.clear();
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
			cachedFullRenderer = null;

		};
		const pending = pendingShadowDisposals.slice();
		if ( materialComputeDispatchPending > 0 ) pending.push( materialComputeDispatchTail );
		if ( pending.length === 0 ) {

			finish();
			return Promise.resolve();

		}
		activeDispose = Promise.allSettled( pending ).then( finish ).finally( () => {

			activeDispose = null;

		} );
		return activeDispose;

	}

	return {
		// Sub-helpers (exposed for callers that need lower-level access)
		liveSceneIndex,
		pmrem,
		fallback,
		materialCompute,
		diagnostics,

		// Convenience methods
		indexScene,
		rememberLiveTexture,
		getFullRenderer,
		ensureFallback,
		generatePMREMAsync,
		setPMREMGenerator,
		syncComputeOutputs,
		dispatchMaterialComputes,
		shareComputeInputs,
		syncComputeOutputsPerPass,
		pingPongInvalidate: pingPongInvalidateTextures,
		shareInstancedAttributeBuffer,
		computeNodeUsesStorageTexture: ( node, source ) => computeNodeUsesStorageTexture( node, source ),
		shareTexture,
		shareShadowTexture,
		populateShadowMaps,
		disposeShadowMaps,
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
