/**
 * `material.precompile(name)` — the only author-facing API.
 *
 * Dev-mode behaviour:
 *   - Waits until the material appears in a real render, then borrows the
 *     active WebGPURenderer (registered via `setDevRenderer`) and runs the
 *     extractor with that Scene, Camera, and owning Object as context.
 *   - POSTs the artifact JSON to the dev-capture endpoint.
 *   - Returns the material itself (chainable).
 *   - If the dev endpoint is unreachable, logs once and becomes a no-op for
 *     the rest of the session (so prod-like non-plugin runs still work).
 *
 * Prod-mode behaviour:
 *   - The Vite/Babel transform replaces `.precompile(name)` call sites with
 *     `__applyPrecompiled(material, import('virtual:tsl-precompile/<name>'), '<hash>')`
 *     at build time. This marker method is then never called.
 *
 * If the marker IS called in a prod build (user mounted the runtime without
 * the plugin), it logs a clear warning and no-ops — the full three.js node
 * builder handles rendering, slightly defeating the point but never breaking
 * the app.
 *
 * @module PrecompileMarker
 */

import { MARKER_METHOD_NAME } from './_constants.js';
import { normalizeRevision } from './_normalize-revision.js';
import { hashArtifactContentSync, hashMaterialSync } from './graph-hash.js';
import { __upsertArtifactForDev } from './artifact-loader.js';
import {
	cloneRenderTargetForCapture,
	getMRTCaptureRenderTarget,
	rememberBackgroundCaptureRenderTarget,
	rememberMRTCaptureRenderTarget,
} from './capture-render-target.js';
import { installLiveTextureRegistryPatches } from './hydrate/live-texture-registry.js';
import { MATERIAL_NODE_TEXTURE_KEYS } from '@tsl-precompile/contract/texture-props';
import { countArtifactFragmentOutputs } from '@tsl-precompile/contract/fragment-outputs';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { createRenderContextSignature } from '@tsl-precompile/contract/render-context';
import { ARTIFACT_CONTENT_HASH_VERSION, stringifyArtifactJson } from '@tsl-precompile/contract/artifact-content';
import { mergeArtifactVariantFamily } from '@tsl-precompile/contract/artifact-variants';
import {
	__resetRenderObjectHarvestHandoffForTests,
	publishRenderObjectHarvest,
} from './auxiliary/render-object-harvest-handoff.js';
import { notifyDevRendererObservers } from './dev-render-observers.js';
import { recordDevCaptureOutcome } from './dev-capture-outcome.js';
import { awaitRendererCompileQuiescence } from './auxiliary/cube-render-target-capture.js';
import { installR185PMREMNodeGuard } from './r185-pmrem-node-guard.js';

const MARKER_STATE_SYMBOL = Symbol.for( '@tsl-precompile/runtime/precompile-marker-state' );
const EXPLICIT_MARKER_NAMES_SYMBOL = Symbol.for( '@tsl-precompile/runtime/explicit-precompile-marker@1' );
const DEFAULT_OBSERVE_TIMEOUT_MS = 30_000;
const DEFAULT_AUTO_FALLBACK_DELAY_MS = 250;
const MAX_OBSERVED_COMPUTE_NODES = 256;
const TROUBLESHOOTING_URL = 'https://github.com/Makio64/vite-plugin-tsl-precompile#troubleshooting';

let installations = new WeakMap();
let installationSet = new Set();
let devRenderer = null;
let registeredRenderers = new Set();
let lastArrayCameraByRenderer = new WeakMap();
let lastRenderContextByRenderer = new WeakMap();
let renderCaptureEpochByRenderer = new WeakMap();
let renderCaptureEpochs = new Set();
let observedComputeNodesByRenderer = new WeakMap();

// `.precompile()` is author syntax, but a correct shader variant depends on
// the real RenderObject + Scene + Camera. Calls without an explicit context
// wait here until the material is observed by a registered renderer. A Map is
// intentional: pending entries must be enumerable while walking a scene; they
// are deleted as soon as capture starts so this does not retain materials for
// the lifetime of the app.
let pendingCaptures = new Map(); // Material -> Map<name, PendingCapture>
let inflightCaptures = new Map(); // Material -> Map<name, activeCount>
let captureQueue = [];
let captureQueueRunning = false;

function importOptionalModule( specifier ) {

	return import( /* @vite-ignore */ specifier );

}

function prepareRenderObjectHarvester( installation ) {

	if ( ! installation ) return Promise.resolve( null );
	if ( typeof installation.beginRenderObjectHarvest === 'function' ) {

		return Promise.resolve( installation.beginRenderObjectHarvest );

	}
	if ( installation.renderObjectHarvesterPromise ) return installation.renderObjectHarvesterPromise;

	// Keep the only private Three seam in the plugin's vendored adapter. The
	// runtime owns the public renderer.render() epoch, but it must not grow a
	// second NodeManager/RenderObjects wrapper that can drift from compileTSL.
	installation.renderObjectHarvesterPromise = import( /* @vite-ignore */ 'vite-plugin-tsl-precompile/src/vendor/compileTSL.js' ).then(
		( module ) => {

			const begin = module && module.beginRenderObjectHarvest;
			if ( typeof begin === 'function' ) installation.beginRenderObjectHarvest = begin;
			return typeof begin === 'function' ? begin : null;

		},
		() => null,
	);
	return installation.renderObjectHarvesterPromise;

}

function exactThreePackageVersion( revision ) {

	const injected = typeof globalThis.__TSLP_THREE_PACKAGE_VERSION__ === 'string'
		? globalThis.__TSLP_THREE_PACKAGE_VERSION__
		: '';
	return injected || normalizeRevision( revision );

}

function snapshotMaterialSourceGraphHash( material, name, installation ) {

	try {

		return hashMaterialSync( material, {
			name,
			threeVersion: exactThreePackageVersion( installation && installation.three && installation.three.REVISION ),
			toolchainVersion: ARTIFACT_TOOLCHAIN_VERSION,
		} );

	} catch ( _ ) {

		// Preserve marker chainability for unusual/proxied author graphs. The
		// capture path retains its historical late-hash fallback, which will
		// fail noisily if the graph is still unhashable.
		return null;

	}

}

function isBrowserOrWorkerRuntime() {

	return typeof window !== 'undefined' || (
		typeof self !== 'undefined' &&
		typeof WorkerGlobalScope !== 'undefined' &&
		self instanceof WorkerGlobalScope
	);

}

function captureCounterRoot() {

	if ( typeof window !== 'undefined' ) return window;
	if ( typeof self !== 'undefined' ) return self;
	return globalThis;

}

function adjustPendingCaptureCount( delta ) {

	const root = captureCounterRoot();
	root.__tslpPrecompilePending = Math.max( 0, ( root.__tslpPrecompilePending | 0 ) + delta );

}

function captureNamesFor( map, material, create = false ) {

	let names = map.get( material );
	if ( ! names && create ) {

		names = new Map();
		map.set( material, names );

	}
	return names || null;

}

function rememberExplicitMarkerName( material, name ) {

	try {

		let names = material[ EXPLICIT_MARKER_NAMES_SYMBOL ];
		if ( ! names || typeof names.add !== 'function' ) {

			names = new Set();
			Object.defineProperty( material, EXPLICIT_MARKER_NAMES_SYMBOL, {
				value: names,
				configurable: true,
			} );

		}
		names.add( name );

	} catch {

		// Unusual/proxied materials retain normal capture behavior.

	}

}

function hasExplicitMarkerName( material ) {

	try {

		return Number( material[ EXPLICIT_MARKER_NAMES_SYMBOL ]?.size ) > 0;

	} catch {

		return false;

	}

}

function normalizeCaptureContext( material, context ) {

	const explicit = context || {};
	const scene = explicit.scene || material.__tslpPrecompileScene || null;
	const object = explicit.object || material.__tslpPrecompileObject || findMaterialOwner( scene, material );
	return {
		scene: scene || findParentScene( object ),
		camera: explicit.camera || material.__tslpPrecompileCamera || null,
		object,
		renderTarget: explicit.renderTarget || material.__tslpPrecompileRenderTarget || null,
		...( Object.prototype.hasOwnProperty.call( explicit, 'mrt' ) ? { mrt: explicit.mrt } : {} ),
	};

}

function explicitCaptureRenderer( context ) {

	if ( ! context || ! Object.prototype.hasOwnProperty.call( context, 'renderer' ) ) return null;
	const renderer = context.renderer;
	return renderer && ( typeof renderer === 'object' || typeof renderer === 'function' ) ? renderer : null;

}

function hasUsableCaptureContext( context ) {

	return !! ( context && context.object && context.scene && context.camera );

}

function findMaterialOwner( scene, material ) {

	if ( ! scene || ! material ) return null;
	let owner = null;
	const visit = ( object ) => {

		const materials = Array.isArray( object && object.material ) ? object.material : [ object && object.material ];
		if ( ! materials.includes( material ) ) return;
		if ( ! owner || captureObjectScore( object ) > captureObjectScore( owner ) ) owner = object;

	};
	if ( typeof scene.traverse === 'function' ) scene.traverse( visit );
	else if ( Array.isArray( scene.children ) ) {

		for ( const child of scene.children ) visit( child );

	}
	return owner;

}

function queueMaterialCapture( material, name, installation, context, sourceIdentity = null, sourceRevision = null ) {

	const sourceGraphHash = snapshotMaterialSourceGraphHash( material, name, installation );
	const queuedNames = captureNamesFor( pendingCaptures, material, true );
	const alreadyQueued = queuedNames.get( name );
	if ( alreadyQueued ) {

		const nextContext = normalizeCaptureContext( material, context );
		const nextExplicitRenderer = explicitCaptureRenderer( context );
		for ( const key of [ 'scene', 'camera', 'object', 'renderTarget' ] ) alreadyQueued.context[ key ] = nextContext[ key ] || alreadyQueued.context[ key ];
		if ( Object.prototype.hasOwnProperty.call( nextContext, 'mrt' ) ) alreadyQueued.context.mrt = nextContext.mrt;
		if ( nextExplicitRenderer ) {

			alreadyQueued.explicitRenderer = nextExplicitRenderer;
			alreadyQueued.renderer = nextExplicitRenderer;

		}
		alreadyQueued.allowAutoFallback = alreadyQueued.allowAutoFallback || context && context.__tslpAutoMark === true;
		alreadyQueued.observeNextRender = alreadyQueued.observeNextRender || context && context.__tslpObserveNextRender === true;
		retainExplicitObservationRenderer( alreadyQueued );
		if ( alreadyQueued.observeNextRender && alreadyQueued.autoFallbackTimer ) {

			clearTimeout( alreadyQueued.autoFallbackTimer );
			alreadyQueued.autoFallbackTimer = null;

		}
		if ( hasUsableCaptureContext( alreadyQueued.context ) && ! alreadyQueued.observedRenderTarget ) {

			alreadyQueued.observedRenderTarget = alreadyQueued.context.renderTarget || activeRenderTarget( alreadyQueued.renderer ) ||
				( alreadyQueued.explicitRenderer ? activeOutputIntermediateTarget( alreadyQueued.renderer ) : null );

		}
		alreadyQueued.sourceIdentity = sourceIdentity || alreadyQueued.sourceIdentity;
		alreadyQueued.sourceRevision = sourceRevision || alreadyQueued.sourceRevision;
		alreadyQueued.sourceGraphHash = alreadyQueued.sourceGraphHash || sourceGraphHash;
		return;

	}

	const normalizedContext = normalizeCaptureContext( material, context );
	const explicitRenderer = explicitCaptureRenderer( context );
	const renderer = explicitRenderer || installation.renderer || ( installationSet.size === 1 ? devRenderer : null );
	const lastRender = renderer && lastRenderContextByRenderer.get( renderer );
	if ( ! normalizedContext.camera && lastRender && normalizedContext.scene === lastRender.scene ) normalizedContext.camera = lastRender.camera;
	const entry = {
		material,
		name,
		installation,
		context: normalizedContext,
		renderer,
		explicitRenderer,
		started: false,
		observeTimer: null,
		autoFallbackTimer: null,
		allowAutoFallback: context && context.__tslpAutoMark === true,
		// Harness-owned capture policy. Keep it beside the queue lifecycle rather
		// than in `context`, whose normalized fields feed artifact signatures and
		// persisted capture metadata.
		observeNextRender: context && context.__tslpObserveNextRender === true,
		observedRenderTarget: normalizedContext.renderTarget || null,
		sourceIdentity,
		sourceRevision,
		sourceGraphHash,
		sourceMaterialNodeProps: materialNodeProps( material ),
	};
	retainExplicitObservationRenderer( entry );
	// Auto-mark instrumentation may carry the target observed during an earlier
	// render, while ordinary markers can be invoked inside the active pass.
	// Preserve either source before PassNode restores the canvas; otherwise the
	// synthetic compile falls back to Three's private output-intermediate target
	// and signs the wrong topology.
	if ( ! entry.observedRenderTarget && hasUsableCaptureContext( entry.context ) ) {

		entry.observedRenderTarget = activeRenderTarget( renderer ) ||
			( entry.explicitRenderer ? activeOutputIntermediateTarget( renderer ) : null );

	}
	queuedNames.set( name, entry );
	adjustPendingCaptureCount( 1 );
	armCaptureObservationTimeout( entry );

	// Explicit/legacy sidecar context is already sufficient to preserve the
	// render-dependent shader shape. Context-free markers deliberately wait for
	// the material to appear in a real render (see setDevRenderer below).
	const autoCaptureHasExplicitTarget = entry.allowAutoFallback && (
		entry.context.renderTarget || entry.observedRenderTarget || Object.prototype.hasOwnProperty.call( entry.context, 'mrt' ) && entry.context.mrt
	);
	// Auto-mark instrumentation supplies Scene/Camera/Object hints before the
	// material's first real draw. Unless it also observed an explicit RT/MRT,
	// wait for the renderer wrapper to collect the exact RenderObject family;
	// starting immediately would sign the extractor's synthetic offscreen target
	// instead of the renderer-owned output-intermediate topology.
	if ( ! entry.observeNextRender && entry.renderer && hasUsableCaptureContext( entry.context ) && ( ! entry.allowAutoFallback || autoCaptureHasExplicitTarget ) ) startQueuedCapture( entry );
	else if ( ! entry.observeNextRender && entry.allowAutoFallback && entry.renderer && lastRender ) scheduleAutoFallbackEntry( entry, lastRender.scene, lastRender.camera );

}

function activeRenderTarget( renderer ) {

	if ( ! renderer || typeof renderer.getRenderTarget !== 'function' ) return null;
	try {

		return renderer.getRenderTarget() || null;

	} catch ( _ ) {

		return null;

	}

}

function activeOutputIntermediateTarget( renderer ) {

	if ( ! renderer || typeof renderer._getFrameBufferTarget !== 'function' ) return null;
	try {

		const target = renderer._getFrameBufferTarget();
		return target && target.isPostProcessingRenderTarget === true ? target : null;

	} catch ( _ ) {

		return null;

	}

}

function armCaptureObservationTimeout( entry ) {

	const configured = Number( globalThis.__TSLP_PRECOMPILE_OBSERVE_TIMEOUT_MS__ );
	const timeoutMs = Number.isFinite( configured ) && configured > 0 ? configured : DEFAULT_OBSERVE_TIMEOUT_MS;
	entry.observeTimer = setTimeout( () => {

		if ( entry.started ) return;
		const queuedNames = captureNamesFor( pendingCaptures, entry.material );
		if ( ! queuedNames || queuedNames.get( entry.name ) !== entry ) return;
		queuedNames.delete( entry.name );
		if ( queuedNames.size === 0 ) pendingCaptures.delete( entry.material );
		adjustPendingCaptureCount( - 1 );
		releaseExplicitObservationRenderer( entry );
		recordDevCaptureOutcome( false );
		console.error( `[tsl-precompile] .precompile(${ JSON.stringify( entry.name ) }) was not observed in a real renderer.render(scene, camera) call within ${ timeoutMs }ms. Mount the material before rendering, or pass { scene, camera, object } as the second argument.` );

	}, timeoutMs );
	if ( entry.observeTimer && typeof entry.observeTimer.unref === 'function' ) entry.observeTimer.unref();

}

function startQueuedCapture( entry ) {

	if ( ! entry || entry.started || ! entry.renderer ) return;
	entry.started = true;
	if ( entry.observeTimer ) clearTimeout( entry.observeTimer );
	if ( entry.autoFallbackTimer ) clearTimeout( entry.autoFallbackTimer );

	const queuedNames = captureNamesFor( pendingCaptures, entry.material );
	if ( queuedNames ) {

		queuedNames.delete( entry.name );
		if ( queuedNames.size === 0 ) pendingCaptures.delete( entry.material );

	}

	const activeNames = captureNamesFor( inflightCaptures, entry.material, true );
	activeNames.set( entry.name, ( activeNames.get( entry.name ) || 0 ) + 1 );

	// compileTSL temporarily mutates renderer-wide MRT/render-target state.
	// Serialize captures even when one frame reveals many marked materials;
	// parallel extraction can poison three.js's shared NodeBuilder cache. Real
	// observed/manual captures are selected ahead of delayed auto-mark fallbacks
	// so a burst of unused helper materials cannot block the visible scene.
	captureQueue.push( entry );
	void drainCaptureQueue();

}

async function drainCaptureQueue() {

	if ( captureQueueRunning ) return;
	captureQueueRunning = true;
	try {

		while ( captureQueue.length > 0 ) {

			let index = captureQueue.findIndex( ( candidate ) => ! candidate.allowAutoFallback || candidate.context.object );
			if ( index === - 1 ) index = 0;
			const [ entry ] = captureQueue.splice( index, 1 );
			try {

				await captureMaterialInDev( entry );

			} finally {

				finishCapture( entry );

			}

		}

	} finally {

		captureQueueRunning = false;
		if ( captureQueue.length > 0 ) void drainCaptureQueue();

	}

}

function finishCapture( entry ) {

	const names = captureNamesFor( inflightCaptures, entry.material );
	if ( names ) {

		const remaining = ( names.get( entry.name ) || 1 ) - 1;
		if ( remaining > 0 ) names.set( entry.name, remaining );
		else names.delete( entry.name );
		if ( names.size === 0 ) inflightCaptures.delete( entry.material );

	}
	adjustPendingCaptureCount( - 1 );
	releaseExplicitObservationRenderer( entry );

}

function captureObjectScore( object ) {

	if ( ! object ) return - 1;
	let score = 0;
	if ( object.receiveShadow ) score += 8;
	if ( object.castShadow ) score += 4;
	if ( object.isSkinnedMesh ) score += 4;
	if ( object.isInstancedMesh || object.count > 1 ) score += 3;
	if ( object.geometry ) score += 1;
	return score;

}

function bindPendingCapturesFromRender( renderer, scene, camera, renderTopology = null ) {

	if ( pendingCaptures.size === 0 || ! scene ) return [];
	const ready = new Set();
	const visit = ( object ) => {

		if ( camera && camera.layers && object && object.layers && typeof object.layers.test === 'function' ) {

			try {

				if ( ! object.layers.test( camera.layers ) ) return;

			} catch ( _ ) {
				// Custom layer implementations may refuse cross-realm objects.
				// Preserve the prior best-effort capture behavior in that case.
			}

		}
		const objectMaterial = object && object.material;
		const materials = scene.overrideMaterial && object && object.geometry
			? [ scene.overrideMaterial ]
			: Array.isArray( objectMaterial ) ? [ ...objectMaterial ] : [ objectMaterial ];
		for ( const material of materials ) {

			if ( ! material ) continue;
			const entries = captureNamesFor( pendingCaptures, material );
			if ( ! entries ) continue;
			for ( const entry of entries.values() ) {

				if ( entry.explicitRenderer && entry.explicitRenderer !== renderer ) continue;
				entry.renderer = entry.explicitRenderer || renderer;
				if ( ! entry.observedRenderTarget && renderTopology && renderTopology.renderTarget ) {

					entry.observedRenderTarget = renderTopology.renderTarget;

				}
				if ( ! entry.mrtRenderTarget && renderTopology && renderTopology.mrtNode && renderTopology.renderTarget ) {

					entry.mrtNode = renderTopology.mrtNode;
					entry.mrtRenderTarget = renderTopology.renderTarget;

				}
				entry.context.scene = entry.context.scene || scene;
				entry.context.camera = entry.context.camera || camera || null;
				if ( ! entry.context.object || captureObjectScore( object ) > captureObjectScore( entry.context.object ) ) {

					entry.context.object = object;

				}
				// Snapshot the author-visible graph before Three's real render calls
				// NodeMaterial.setup(), which can populate internal *Node properties.
				// Those builder-owned nodes describe the captured shader, but they are
				// not present yet when compiler-free replay selects an artifact.
				entry.sourceMaterialNodeProps = materialNodeProps( material );
				ready.add( entry );

			}

		}

	};

	if ( typeof scene.traverse === 'function' ) scene.traverse( visit );
	else {

		visit( scene );
		if ( Array.isArray( scene.children ) ) {

			for ( const child of scene.children ) visit( child );

		}

	}
	return [ ...ready ];

}

function scheduleAutoFallbackCaptures( renderer, scene, camera ) {

	for ( const entries of pendingCaptures.values() ) {

		for ( const entry of entries.values() ) {

			if ( ! entry.allowAutoFallback || entry.started || entry.autoFallbackTimer ) continue;
			if ( entry.explicitRenderer && entry.explicitRenderer !== renderer ) continue;
			if ( ! entry.explicitRenderer && entry.installation.renderer && entry.installation.renderer !== renderer ) continue;
			entry.renderer = entry.explicitRenderer || renderer;
			scheduleAutoFallbackEntry( entry, scene, camera );

		}

	}

}

function scheduleAutoFallbackEntry( entry, scene, camera ) {

	if ( ! entry || entry.started || entry.autoFallbackTimer ) return;
	const configured = Number( globalThis.__TSLP_AUTO_FALLBACK_DELAY_MS__ );
	const delayMs = Number.isFinite( configured ) && configured >= 0 ? configured : DEFAULT_AUTO_FALLBACK_DELAY_MS;
	entry.autoFallbackTimer = setTimeout( () => {

		const queued = captureNamesFor( pendingCaptures, entry.material );
		if ( entry.started || ! queued || queued.get( entry.name ) !== entry ) return;
		entry.context.scene = entry.context.scene || scene;
		entry.context.camera = entry.context.camera || camera;
		// A late auto-mark fallback has missed the RenderObject observer, but the
		// renderer still owns the exact intermediate target used by its latest
		// main output pass. Preserve that topology instead of letting synthetic
		// extraction invent a generic offscreen-2d surface.
		if ( ! entry.observedRenderTarget ) entry.observedRenderTarget =
			activeRenderTarget( entry.renderer ) || activeOutputIntermediateTarget( entry.renderer );
		entry.sourceMaterialNodeProps = materialNodeProps( entry.material );
		logOnce( 'auto-context-fallback:' + entry.name, () => console.warn( `[tsl-precompile] auto-marked material ${ JSON.stringify( entry.name ) } was not observed on a render object; capturing it with the latest Scene/Camera and a generic mesh fallback.` ) );
		startQueuedCapture( entry );

	}, delayMs );
	if ( entry.autoFallbackTimer && typeof entry.autoFallbackTimer.unref === 'function' ) entry.autoFallbackTimer.unref();

}

function startExplicitPendingCaptures( renderer, installation = null ) {

	for ( const entries of pendingCaptures.values() ) {

		for ( const entry of entries.values() ) {

			if ( installation && entry.installation !== installation ) continue;
			if ( entry.explicitRenderer && entry.explicitRenderer !== renderer ) continue;
			if ( ! entry.explicitRenderer && ! installation && entry.installation.renderer && entry.installation.renderer !== renderer ) continue;
			if ( entry.observeNextRender ) continue;
			if ( ! hasUsableCaptureContext( entry.context ) ) continue;
			entry.renderer = entry.explicitRenderer || renderer;
			startQueuedCapture( entry );

		}

	}

}

function rendererIsAssigned( renderer ) {

	for ( const installation of installationSet ) {

		if ( installation.renderer === renderer ) return true;

	}
	return false;

}

function unregisterRendererIfUnused( renderer ) {

	if ( ! renderer || rendererIsAssigned( renderer ) || renderer === devRenderer ) return;
	registeredRenderers.delete( renderer );
	clearObservedComputeNodes( renderer );

}

// setDevRenderer() deliberately treats a later renderer as a replacement for
// ordinary context-free markers. A marker with an explicit renderer and an
// observe-next-render contract is different: it owns a short observation
// lease on that exact renderer even if a multi-renderer application initialized
// another renderer afterward. Release the lease as soon as the marker starts
// capture or times out so replacement semantics and object retention stay
// bounded.
function retainExplicitObservationRenderer( entry ) {

	const renderer = entry && entry.explicitRenderer;
	if ( ! renderer || entry.observeNextRender !== true || entry.explicitObservationRendererRetained === true ) return;
	entry.explicitObservationRendererRetained = true;
	registeredRenderers.add( renderer );
	wrapDevRenderer( renderer );

}

function releaseExplicitObservationRenderer( entry ) {

	const renderer = entry && entry.explicitRenderer;
	if ( ! renderer || entry.explicitObservationRendererRetained !== true ) return;
	entry.explicitObservationRendererRetained = false;
	for ( const entries of pendingCaptures.values() ) {

		for ( const pendingEntry of entries.values() ) {

			if (
				pendingEntry !== entry &&
				pendingEntry.explicitRenderer === renderer &&
				pendingEntry.explicitObservationRendererRetained === true
			) return;

		}

	}
	unregisterRendererIfUnused( renderer );

}

function associateRenderer( installation, renderer ) {

	if ( ! installation || ! renderer ) return Promise.resolve();
	const previous = installation.renderer;
	installation.renderer = renderer;
	registeredRenderers.add( renderer );
	wrapDevRenderer( renderer );
	if ( previous && previous !== renderer ) unregisterRendererIfUnused( previous );
	startExplicitPendingCaptures( renderer, installation );
	return prepareRenderObjectHarvester( installation ).then( () => undefined );

}

const LIGHT_NODE_GRAPH_PROPS = [
	'colorNode',
];

function artifactLooksMRT( artifact ) {

	return !! ( artifact && typeof artifact.mrtOutputCount === 'number' && artifact.mrtOutputCount > 0 );

}

function selectPreferredCaptureArtifact( current, candidate ) {

	if ( ! current ) return candidate;
	if ( ! candidate ) return current;

	const currentUsable = countArtifactFragmentOutputs( current, 1 ) > 0;
	const candidateUsable = countArtifactFragmentOutputs( candidate, 1 ) > 0;
	if ( candidateUsable && ! currentUsable ) return candidate;

	if ( candidateUsable && artifactLooksMRT( current ) && ! artifactLooksMRT( candidate ) ) return candidate;

	return current;

}

function collectCodegenUnsupportedKinds( artifact, codegen ) {

	const unsupported = [];
	const rootKey = artifact.cacheKey === undefined || artifact.cacheKey === null ? null : String( artifact.cacheKey );
	const variants = Object.values( artifact.variants || {} ).filter( ( variant ) => rootKey === null || String( variant && variant.cacheKey ) !== rootKey );
	for ( const candidate of [ artifact, ...variants ] ) {

		const result = codegen( candidate );
		for ( const entry of result.unsupportedKinds || [] ) unsupported.push( {
			...entry,
			...( candidate === artifact ? {} : { variantCacheKey: candidate.cacheKey ?? null } ),
		} );

	}
	return unsupported;

}

function mergeArtifactTextureRefs( target, source ) {

	const sourceRefs = source && source._textureRefs;
	if ( ! ( sourceRefs instanceof Map ) || sourceRefs.size === 0 ) return;
	const existingRefs = target._textureRefs instanceof Map ? target._textureRefs : null;
	const refs = existingRefs || new Map();
	let changed = false;
	for ( const [ uuid, texture ] of sourceRefs ) {

		if ( refs.has( uuid ) ) continue;
		refs.set( uuid, texture );
		changed = true;

	}
	if ( ! changed ) return;
	if ( existingRefs ) return;
	Object.defineProperty( target, '_textureRefs', {
		value: refs,
		enumerable: false,
		configurable: true,
		writable: true,
	} );

}

function collectMaterialVariantList( artifactSets, materialUuid ) {

	const variants = [];
	const seen = new Set();
	for ( const artifacts of artifactSets ) {

		const list = artifacts && artifacts.byMaterialVariants && artifacts.byMaterialVariants.get( materialUuid );
		if ( ! Array.isArray( list ) ) continue;
		for ( const variant of list ) {

			if ( ! variant || variant.cacheKey === undefined || variant.cacheKey === null ) continue;
			if ( seen.has( variant ) ) continue;
			seen.add( variant );
			variants.push( variant );

		}

	}
	return variants;

}

function attachMaterialVariantFamily( artifact, variantList ) {

	if ( ! artifact || ! Array.isArray( variantList ) || variantList.length <= 1 ) return;
	for ( const variant of variantList ) {

		mergeArtifactTextureRefs( artifact, variant );

	}
	mergeArtifactVariantFamily( artifact, variantList );

}

function objectSourceMetadata( object ) {

	if ( ! object ) return null;
	return {
		type: object.type || object.constructor && object.constructor.name || null,
		renderOrder: Number.isFinite( object.renderOrder ) ? object.renderOrder : 0,
		castShadow: object.castShadow === true,
		receiveShadow: object.receiveShadow === true,
		isInstancedMesh: object.isInstancedMesh === true,
		count: Number.isFinite( object.count ) ? object.count : null,
		isSkinnedMesh: object.isSkinnedMesh === true,
		position: object.position ? [ object.position.x, object.position.y, object.position.z ] : null,
		scale: object.scale ? [ object.scale.x, object.scale.y, object.scale.z ] : null,
	};

}

function materialNodeProps( material ) {

	const nodeProps = [];
	// Line2NodeMaterial.setup() builds these roots from the public wide-line
	// controls on every compile. They are compiler output, not author graph
	// inputs, and compiler-free replay never runs setup() before artifact
	// selection. Keep the actual author inputs (lineColorNode, offsetNode, dash
	// nodes, etc.) while excluding the generated roots from source matching.
	const setupOwnedNodeProps = material && ( material.isLine2NodeMaterial === true || material.type === 'Line2NodeMaterial' )
		? new Set( [ 'vertexNode', 'colorNode', 'outputNode' ] )
		: null;
	if ( material ) {

		for ( const key of MATERIAL_NODE_TEXTURE_KEYS ) {

			if ( setupOwnedNodeProps && setupOwnedNodeProps.has( key ) ) continue;
			const value = material[ key ];
			if ( value && value.isNode === true ) nodeProps.push( key );

		}

	}
	return nodeProps;

}

function materialSourceMetadata( material, sourceObject = null ) {

	return {
		type: material && typeof material.type === 'string' ? material.type : null,
		name: material && typeof material.name === 'string' ? material.name : '',
		nodeProps: materialNodeProps( material ),
		object: objectSourceMetadata( sourceObject ),
	};

}

function updateInstallation( installation, three, opts ) {

	installation.three = three;
	installation.devEndpoint = opts.devEndpoint || null;
	installation.devEndpointDead = false;
	installation.extractor = opts.extractor || null;
	installation.codegen = opts.codegen || null;
	if ( typeof opts.beginRenderObjectHarvest === 'function' ) installation.beginRenderObjectHarvest = opts.beginRenderObjectHarvest;
	if ( installation.devEndpoint ) void prepareRenderObjectHarvester( installation );

}

/**
 * Install `.precompile(name)` on the three.js Material prototype. Safe to call
 * multiple times; subsequent calls update the dev endpoint.
 *
 * @param {Object} three - A `three` or `three/webgpu` module, providing `Material`.
 * @param {Object} [opts]
 * @param {?string} [opts.devEndpoint] - e.g. 'http://localhost:5173/__tsl-precompile/capture'.
 * @param {?Function} [opts.extractor] - `(renderer, scene, camera, options) => Promise<artifacts>`.
 *   Defaults to a dynamic import of `vite-plugin-tsl-precompile/src/vendor/compileTSL.js`.
 * @param {?Function} [opts.codegen] - Test/advanced override for updater validation.
 * @param {?Function} [opts.beginRenderObjectHarvest] - Test/advanced override for the plugin-owned real RenderObject observer.
 */
export function installPrecompileMarker( three, opts = {} ) {

	const Material = three.Material;
	if ( ! Material || ! Material.prototype ) {

		throw new Error( '[tsl-precompile] installPrecompileMarker requires the three.Material class on the passed module.' );

	}

	// `three` and `three/src/**` can be separate module instances in a full
	// runtime build. Patch the namespace the author actually passed instead of
	// making the slim hydrator dynamically import the entire bare-three barrel.
	installLiveTextureRegistryPatches( three );
	installR185PMREMNodeGuard( three );

	const prototype = Material.prototype;
	let installation = installations.get( prototype );
	if ( installation ) {

		updateInstallation( installation, three, opts );
		return;

	}

	const sharedState = prototype[ MARKER_STATE_SYMBOL ];
	if ( sharedState && sharedState.version === 1 && typeof sharedState.update === 'function' ) {

		sharedState.update( three, opts );
		installation = sharedState.installation;
		installations.set( prototype, installation );
		installationSet.add( installation );
		return;

	}
	if ( typeof prototype[ MARKER_METHOD_NAME ] === 'function' ) {

		throw new Error( `[tsl-precompile] Material.prototype.${ MARKER_METHOD_NAME } is already defined by an incompatible runtime copy or another library.` );

	}

	installation = {
		three,
		devEndpoint: opts.devEndpoint || null,
		devEndpointDead: false,
		extractor: opts.extractor || null,
		codegen: opts.codegen || null,
		beginRenderObjectHarvest: typeof opts.beginRenderObjectHarvest === 'function' ? opts.beginRenderObjectHarvest : null,
		renderObjectHarvesterPromise: null,
		renderer: null,
	};
	installations.set( prototype, installation );
	installationSet.add( installation );
	if ( installation.devEndpoint ) void prepareRenderObjectHarvester( installation );

	// PassNode.setMRT hook: `pass(scene, cam).setMRT(mrtNode)` (the dominant
	// MRT pattern in three.js examples) doesn't write `material.mrtNode` until
	// the pass actually renders — too late for our synthetic warm-up. Stamp
	// the descriptor on `passNode.scene.userData.__tslp_mrtNode` so the marker
	// (and aux-marker, and compileTSL) can find it during capture.
	const PassNode = three.PassNode;
	if ( PassNode && PassNode.prototype && ! PassNode.prototype.__tslpSetMRTHooked ) {

		const _origSetMRT = PassNode.prototype.setMRT;
		PassNode.prototype.setMRT = function ( mrtNode ) {

			const ret = _origSetMRT.call( this, mrtNode );
			if ( this.scene && mrtNode ) {

				this.scene.userData = this.scene.userData || {};
				this.scene.userData.__tslp_mrtNode = mrtNode;
				rememberMRTCaptureRenderTarget( this.scene, this.renderTarget, mrtNode );

			}
			return ret;

		};
		PassNode.prototype.__tslpSetMRTHooked = true;

	}

	prototype[ MARKER_METHOD_NAME ] = function precompile( name, context = null, sourceIdentity = null, sourceRevision = null ) {

		if ( typeof name !== 'string' || name.length === 0 ) {

			throw new TypeError( `[tsl-precompile] material.precompile(name): "name" must be a non-empty string; got ${ typeof name }` );

		}
		if ( context !== null && ( typeof context !== 'object' || Array.isArray( context ) ) ) {

			throw new TypeError( '[tsl-precompile] material.precompile(name, context): context must be an object when provided.' );

		}
		if ( sourceIdentity !== null && ( typeof sourceIdentity !== 'string' || sourceIdentity.length === 0 ) ) {

			throw new TypeError( '[tsl-precompile] internal marker source identity must be a non-empty string when provided.' );

		}
		if ( sourceRevision !== null && ( typeof sourceRevision !== 'string' || ! /^[a-f0-9]{64}$/i.test( sourceRevision ) ) ) {

			throw new TypeError( '[tsl-precompile] internal marker source revision must be a 64-character hexadecimal SHA-256 hash when provided.' );

		}

		// Prod fallback path — transform should have replaced this call.
		if ( ! isBrowserOrWorkerRuntime() || ! installation.devEndpoint ) {

			logOnce( 'no-endpoint:' + name, () => console.warn( `[tsl-precompile] .precompile(${ JSON.stringify( name ) }) was called but no dev endpoint is configured. If this is production, the Babel transform did not run — check your Vite config.` ) );
			return this;

		}

		if ( installation.devEndpointDead ) return this;
		const autoMarked = context && context.__tslpAutoMark === true;
		// Authored markers are the source of truth. Test/plugin auto-marking may
		// discover the same material after the real render has already begun;
		// queueing a second name then can create an orphan observation timeout.
		if ( autoMarked && hasExplicitMarkerName( this ) ) return this;
		if ( ! autoMarked ) rememberExplicitMarkerName( this, name );
		queueMaterialCapture( this, name, installation, context, sourceIdentity, sourceRevision );

		return this;

	};

	Object.defineProperty( prototype, MARKER_STATE_SYMBOL, {
		value: {
			version: 1,
			installation,
			update: ( nextThree, nextOpts = {} ) => updateInstallation( installation, nextThree, nextOpts ),
			setRenderer: ( renderer ) => associateRenderer( installation, renderer ),
			clearRenderer: () => {

				const previous = installation.renderer;
				installation.renderer = null;
				unregisterRendererIfUnused( previous );

			},
		},
		configurable: true,
	} );

}

/**
 * Register the active WebGPURenderer so the marker can borrow it for
 * extraction. Call once after `renderer.init()`. The marker no-ops until
 * this is called.
 *
 * Side-effect: if the renderer carries a `three/addons/inspector/Inspector.js`
 * instance and the application provides the optional inspector integration
 * module, auto-register the precompile panel. The repository workspace uses
 * this hook for its local examples; the integration is not a published runtime
 * dependency.
 *
 * @param {Object} renderer
 * @param {Object} [three] - Optional three namespace; recommended when more than one renderer/three copy is active.
 * @returns {Promise<void>} Resolves once the optional real-render harvester is ready; callers may ignore it and retain synthetic fallback behavior.
 */
export function setDevRenderer( renderer, three = null ) {

	devRenderer = renderer || null;
	if ( renderer && renderer.inspector ) autoAttachInspectorPanel( renderer.inspector );
	if ( ! renderer ) return Promise.resolve();

	const sharedState = three && three.Material && three.Material.prototype && three.Material.prototype[ MARKER_STATE_SYMBOL ];
	if ( sharedState && typeof sharedState.setRenderer === 'function' ) {

		return Promise.resolve( sharedState.setRenderer( renderer ) ).then( () => undefined );

	}
	if ( installationSet.size === 1 ) {

		const installation = installationSet.values().next().value;
		const prototype = installation.three && installation.three.Material && installation.three.Material.prototype;
		const state = prototype && prototype[ MARKER_STATE_SYMBOL ];
		if ( state && typeof state.setRenderer === 'function' ) return Promise.resolve( state.setRenderer( renderer ) ).then( () => undefined );
		return associateRenderer( installation, renderer );

	}

	registeredRenderers.add( renderer );
	wrapDevRenderer( renderer );
	return Promise.resolve();

}

function beginSynchronousRenderCaptureEpoch( renderer, ready ) {

	let epoch = renderCaptureEpochByRenderer.get( renderer );
	if ( epoch && epoch.closed === false ) return epoch;

	let beginHarvest = null;
	for ( const entry of ready ) {

		const candidate = entry && entry.installation && entry.installation.beginRenderObjectHarvest;
		if ( typeof candidate === 'function' ) {

			beginHarvest = candidate;
			break;

		}

	}

	let harvestSession = null;
	if ( beginHarvest ) {

		try {

			harvestSession = beginHarvest( renderer );

		} catch ( _ ) {

			harvestSession = null;

		}

	}
	epoch = {
		renderer,
		harvestSession,
		entries: new Set(),
		scenes: new Set(),
		pendingAsyncRenders: 0,
		closeScheduled: false,
		closed: false,
	};
	renderCaptureEpochByRenderer.set( renderer, epoch );
	renderCaptureEpochs.add( epoch );
	return epoch;

}

function completeRenderCaptureCall( epoch, ready, scene = null ) {

	if ( ! epoch || epoch.closed ) return;
	// Renderer output quads and other standalone Object3D renders are part of
	// the same synchronous burst but are not independent scene owners. Only a
	// single real Scene is safe to hand to aux capture until the harvest
	// contract can project multi-scene families by request provenance.
	if ( scene && scene.isScene === true ) epoch.scenes.add( scene );
	for ( const entry of ready ) epoch.entries.add( entry );
	scheduleRenderCaptureEpochClose( epoch );

}

function scheduleRenderCaptureEpochClose( epoch ) {

	if ( ! epoch || epoch.closed || epoch.closeScheduled ) return;
	epoch.closeScheduled = true;
	Promise.resolve().then( () => {

		epoch.closeScheduled = false;
		if ( epoch.closed || epoch.pendingAsyncRenders > 0 ) return;
		closeRenderCaptureEpoch( epoch );

	} );

}

function closeRenderCaptureEpoch( epoch, startCaptures = true ) {

	if ( ! epoch || epoch.closed ) return;
	epoch.closed = true;
	if ( renderCaptureEpochByRenderer.get( epoch.renderer ) === epoch ) renderCaptureEpochByRenderer.delete( epoch.renderer );
	renderCaptureEpochs.delete( epoch );

	let renderObjectHarvest = Promise.resolve( null );
	if ( epoch.harvestSession && typeof epoch.harvestSession.finish === 'function' ) {

		try {

			renderObjectHarvest = Promise.resolve( epoch.harvestSession.finish() ).catch( () => null );

		} catch ( _ ) {

			renderObjectHarvest = Promise.resolve( null );

		}

	}

	// Claim all materials before yielding to the harvester's asynchronous state
	// joins. A later application frame must not open a second observer epoch for
	// the same pending marker while this immutable result is being completed.
	if ( ! startCaptures ) return;
	if ( epoch.scenes.size === 1 ) {

		publishRenderObjectHarvest( epoch.renderer, epoch.scenes.values().next().value, renderObjectHarvest );

	}
	for ( const entry of epoch.entries ) {

		entry.renderObjectHarvest = renderObjectHarvest;
		startQueuedCapture( entry );

	}

}

function wrapDevRenderer( renderer ) {

	// Intercept renderer.render() to observe the actual Scene, Camera, and
	// RenderObject that select a material's shader shape. Capture starts only
	// after that real render completes, so three.js has populated its normal
	// renderer caches before the extractor borrows the renderer.
	// We only wrap once per renderer instance (guard via __tslpRenderWrapped).
	wrapDevRendererComputeMethod( renderer, 'compute' );
	wrapDevRendererComputeMethod( renderer, 'computeAsync' );
	if ( typeof renderer.render === 'function' && ! renderer.__tslpRenderWrapped ) {

		renderer.__tslpRenderWrapped = true;
		const _originalRender = renderer.render.bind( renderer );
		renderer.render = function ( scene, camera, ...rest ) {

			if ( ! registeredRenderers.has( renderer ) ) return _originalRender( scene, camera, ...rest );
			let activeMRT = null;
			let activeRenderTarget = null;
			const synthetic = ( globalThis.__tslpSyntheticRenderActive | 0 ) > 0;
			// PassNode binds its private render target and MRT immediately before
			// renderer.render(scene, camera). Remember that exact target topology
			// before Three restores the previous target. Keep the target out of
			// Scene.userData because RenderTarget has circular texture backrefs.
			if ( scene && scene.isScene === true ) {

				if ( typeof renderer.getMRT === 'function' ) {

					try { activeMRT = renderer.getMRT(); } catch ( _ ) {}

				}
				if ( typeof renderer.getRenderTarget === 'function' ) {

					try { activeRenderTarget = renderer.getRenderTarget(); } catch ( _ ) {}

				}
				if ( activeMRT && activeRenderTarget ) {

					scene.userData = scene.userData || {};
					scene.userData.__tslp_mrtNode = activeMRT;
					rememberMRTCaptureRenderTarget( scene, activeRenderTarget, activeMRT );

				}
				if ( ! synthetic && ( scene.backgroundNode || scene.background ) ) {

					rememberBackgroundCaptureRenderTarget( scene, renderer, activeRenderTarget, activeMRT );

				}

			}
			if ( camera && camera.isArrayCamera && camera.cameras && camera.cameras.length > 0 ) {

				lastArrayCameraByRenderer.set( renderer, camera );

			}
			if ( ! synthetic ) lastRenderContextByRenderer.set( renderer, { scene, camera } );
			const ready = synthetic ? [] : bindPendingCapturesFromRender( renderer, scene, camera, { mrtNode: activeMRT, renderTarget: activeRenderTarget } );
			// Open the plugin-owned RenderObject observer before the first real
			// request. Closing is deferred to a microtask, so every synchronous
			// render in the current application burst (cube faces, depth/color
			// siblings, offscreen/main passes) contributes to one atomic family.
			const openCaptureEpoch = renderCaptureEpochByRenderer.get( renderer );
			const captureEpoch = openCaptureEpoch && openCaptureEpoch.closed === false
				? openCaptureEpoch
				: ready.length > 0 ? beginSynchronousRenderCaptureEpoch( renderer, ready ) : null;
			let result;
			try {

				result = _originalRender( scene, camera, ...rest );

			} catch ( error ) {

				if ( captureEpoch ) scheduleRenderCaptureEpochClose( captureEpoch );
				throw error;

			}
			const startReady = () => {

				if ( captureEpoch ) completeRenderCaptureCall( captureEpoch, ready, scene );
				if ( ! synthetic ) {

					scheduleAutoFallbackCaptures( renderer, scene, camera );
					notifyDevRendererObservers( renderer, scene, camera );

				}

			};
			if ( result && typeof result.then === 'function' ) {

				if ( captureEpoch ) captureEpoch.pendingAsyncRenders ++;
				Promise.resolve( result ).then(
					() => {

						if ( captureEpoch ) captureEpoch.pendingAsyncRenders --;
						startReady();

					},
					() => {

						if ( captureEpoch ) {

							captureEpoch.pendingAsyncRenders --;
							scheduleRenderCaptureEpochClose( captureEpoch );

						}

					},
				);

			}
			else startReady();
			return result;

		};

	}

}

function wrapDevRendererComputeMethod( renderer, methodName ) {

	const original = renderer && renderer[ methodName ];
	const guard = methodName === 'compute' ? '__tslpComputeObserved' : '__tslpComputeAsyncObserved';
	if ( typeof original !== 'function' || renderer[ guard ] === true ) return;
	renderer[ guard ] = true;
	renderer[ methodName ] = function ( computeNodes, ...rest ) {

		if ( registeredRenderers.has( renderer ) ) recordObservedComputeNodes( renderer, computeNodes );
		return original.call( this, computeNodes, ...rest );

	};

}

function recordObservedComputeNodes( renderer, computeNodes ) {

	let observation = observedComputeNodesByRenderer.get( renderer );
	if ( ! observation ) {

		observation = { nodes: new Set(), disposeHandlers: new Map(), overflow: false };
		observedComputeNodesByRenderer.set( renderer, observation );

	}
	for ( const node of Array.isArray( computeNodes ) ? computeNodes : [ computeNodes ] ) {

		if ( ! node || node.isComputeNode !== true || observation.nodes.has( node ) ) continue;
		if ( observation.nodes.size >= MAX_OBSERVED_COMPUTE_NODES ) {

			observation.overflow = true;
			continue;

		}
		observation.nodes.add( node );
		if ( typeof node.addEventListener === 'function' && typeof node.removeEventListener === 'function' ) {

			const onDispose = () => forgetObservedComputeNode( renderer, node );
			try {

				node.addEventListener( 'dispose', onDispose );
				observation.disposeHandlers.set( node, onDispose );

			} catch ( _ ) { /* cache-only validation still rejects stale opaque nodes */ }

		}

	}

}

function forgetObservedComputeNode( renderer, node ) {

	const observation = observedComputeNodesByRenderer.get( renderer );
	if ( ! observation ) return;
	observation.nodes.delete( node );
	const onDispose = observation.disposeHandlers && observation.disposeHandlers.get( node );
	if ( onDispose ) {

		observation.disposeHandlers.delete( node );
		try { node.removeEventListener( 'dispose', onDispose ); } catch ( _ ) {}

	}

}

function clearObservedComputeNodes( renderer ) {

	const observation = observedComputeNodesByRenderer.get( renderer );
	if ( ! observation ) return;
	for ( const node of [ ...observation.nodes ] ) forgetObservedComputeNode( renderer, node );
	observedComputeNodesByRenderer.delete( renderer );

}

function observedComputeNodesForCapture( renderer ) {

	const observation = observedComputeNodesByRenderer.get( renderer );
	if ( ! observation ) return [];
	if ( observation.overflow ) throw new Error(
		`[tsl-precompile] capture observed more than ${ MAX_OBSERVED_COMPUTE_NODES } distinct compute nodes on one renderer; refusing incomplete storage ownership evidence.`,
	);
	return [ ...observation.nodes ];

}

let _inspectorAttachTried = false;
async function autoAttachInspectorPanel( inspector ) {

	if ( _inspectorAttachTried ) return;
	_inspectorAttachTried = true;
	if ( inspector.__tslPrecompilePanel ) return; // already attached
	try {

		// The specifier is held in a variable so Vite's import-analysis does
		// not statically try to resolve it at dev-server boot. The panel is
		// optional; consumers without it just hit the catch below at runtime.
		const inspectorPanelSpecifier = '@tsl-precompile/inspector-panel';
		const mod = await importOptionalModule( inspectorPanelSpecifier );
		if ( typeof mod.attachToInspector === 'function' ) mod.attachToInspector( inspector );

	} catch ( err ) {

		// The integration is repository/workspace-only unless the application
		// deliberately provides a compatible module. Keep this informational
		// and avoid suggesting an unpublished registry package.
		logOnce( 'no-inspector-panel', () => console.info( '[tsl-precompile] optional Inspector integration is unavailable unless the application provides it; skipping auto-attach.' ) );

	}

}

/**
 * Drop the dev-renderer reference. Useful when the user replaces the renderer
 * mid-session.
 */
export function clearDevRenderer() {

	for ( const epoch of [ ...renderCaptureEpochs ] ) closeRenderCaptureEpoch( epoch, false );

	for ( const installation of installationSet ) {

		const prototype = installation.three && installation.three.Material && installation.three.Material.prototype;
		const sharedState = prototype && prototype[ MARKER_STATE_SYMBOL ];
		if ( sharedState && sharedState.installation === installation && typeof sharedState.clearRenderer === 'function' ) sharedState.clearRenderer();
		else installation.renderer = null;

	}
	for ( const renderer of registeredRenderers ) clearObservedComputeNodes( renderer );
	registeredRenderers.clear();
	devRenderer = null;

}

async function captureMaterialInDev( entry ) {

	let guardedRender = null;
	let installedRenderGuard = null;
	let renderGuardActive = false;
	let captureAccepted = false;
	const { material, name, installation } = entry;
	const threeModule = installation.three;
	const captureRenderer = entry.renderer;
	const devEndpoint = installation.devEndpoint;
	let extractor = installation.extractor;
	let codegen = installation.codegen;
	let renderObjectHarvest = null;

	try {

		if ( ! captureRenderer ) {

			logOnce( 'no-renderer:' + name, () => console.warn( `[tsl-precompile] .precompile(${ JSON.stringify( name ) }): no dev renderer registered. Call setDevRenderer(renderer) once after renderer.init() so the marker can borrow it for extraction.` ) );
			return;

		}

		try {

			const resolvedHarvest = entry.renderObjectHarvest ? await entry.renderObjectHarvest : null;
			if ( resolvedHarvest && resolvedHarvest.familiesByMaterial instanceof Map &&
				( ! resolvedHarvest.renderer || resolvedHarvest.renderer === captureRenderer ) ) {

				renderObjectHarvest = resolvedHarvest;

			}

		} catch ( _ ) {

			// Observer loading and state resolution are an optional fidelity path.
			// compileTSL's existing synthetic family remains the safe fallback.

		}

		if ( ! extractor ) {

			const mod = await import( /* @vite-ignore */ 'vite-plugin-tsl-precompile/src/vendor/compileTSL.js' );
			extractor = mod.compileTSL;
			installation.extractor = extractor;

		}

		if ( ! codegen ) {

			const mod = await import( /* @vite-ignore */ 'vite-plugin-tsl-precompile/src/emit-updater.js' );
			codegen = mod.emitUpdaterSource;
			installation.codegen = codegen;

		}

		// Suspend app-initiated renders for the span of this capture. The
		// synthetic warm-up (and the non-MRT sibling pass) mutate renderer-level
		// MRT and render-target state across await points; a live animation
		// frame interleaving into that window builds pipelines against
		// mismatched state — e.g. a per-material mrt() resolves its output
		// names against an unnamed canvas target, emits an empty output struct,
		// and the node build fails with "Cannot read properties of undefined
		// (reading 'type')" — and the broken NodeBuilderState lands in the
		// renderer's shared cache. Renders performed BY the capture itself are
		// recognised via the __tslpSyntheticRenderActive flag set around
		// compileTSL's warm-up renders.
		//
		// Skipped frames are DROPPED, not replayed: a render call can rely on
		// synchronous renderer state its caller set around it (PassNode binds
		// its RT/MRT before its inner render and restores after), so replaying
		// it later re-renders against the wrong state. The app's next animation
		// frame repaints; captures only trigger from materials seen in a render,
		// so even no-loop apps have already drawn. Reentrancy: overlapping
		// captures leave the outer guard in charge.
		if ( typeof captureRenderer.render === 'function' && captureRenderer.render.__tslpCaptureGuard !== true ) {

			guardedRender = captureRenderer.render;
			renderGuardActive = true;
			const captureRenderGuard = function ( ...args ) {

				if ( ! renderGuardActive || ( globalThis.__tslpSyntheticRenderActive | 0 ) > 0 ) {

					return guardedRender.apply( this, args );

				}
				return undefined;

			};
			captureRenderGuard.__tslpCaptureGuard = true;
			installedRenderGuard = captureRenderGuard;
			captureRenderer.render = captureRenderGuard;

		}

		// Build a minimal synthetic scene that drives this single material.
		// Scene-driven capture can attach a source object so custom update nodes
		// that read `frame.object` fields see the same shape they saw in the app.
		const { Scene, Mesh, BoxGeometry, PerspectiveCamera, Color, ClippingGroup, REVISION } = threeModule;
		const scene = new Scene();
		scene.userData = scene.userData || {};
		scene.userData.__tslpSyntheticCaptureScene = true;

		// Determine the capture camera. Priority order:
		//   1. The camera observed for this material's real render
		//   2. material.__tslpArrayCamera — explicit legacy hint
		//   3. The last ArrayCamera seen by this same renderer (legacy sidecar flow)
		//   4. Fallback: plain PerspectiveCamera (pre-existing behaviour)
		//
		// Using an ArrayCamera with at least one sub-camera causes three.js's
		// Camera.js TSL nodes to emit the `cameraViewMatrices[cameraIndex]`
		// array-uniform path instead of the scalar `cameraViewMatrix` path.
		// Without this, all 36 cells of webgpu_camera_array render the same
		// view because the precompiled WGSL bakes the scalar path.
		const captureContext = entry.context || {};
		let sourceArrayCamera = null;
		if ( captureContext.camera && captureContext.camera.isArrayCamera ) {

			sourceArrayCamera = captureContext.camera;

		} else if ( Object.prototype.hasOwnProperty.call( material, '__tslpArrayCamera' ) ) {

			if ( material.__tslpArrayCamera && material.__tslpArrayCamera.isArrayCamera ) {

				sourceArrayCamera = material.__tslpArrayCamera;

			}

		} else if ( ! captureContext.camera && lastArrayCameraByRenderer.has( captureRenderer ) ) {

			sourceArrayCamera = lastArrayCameraByRenderer.get( captureRenderer );

		}

		let camera;
		const sourceCamera = captureContext.camera || material.__tslpPrecompileCamera || null;
		if ( sourceArrayCamera ) {

			// Clone the ArrayCamera shell so we don't mutate the live camera, but
			// re-use the same sub-camera array (read-only during extraction).
			const ArrayCamera = sourceArrayCamera.constructor;
			camera = new ArrayCamera( sourceArrayCamera.cameras );
			camera.position.copy( sourceArrayCamera.position );
			camera.quaternion.copy( sourceArrayCamera.quaternion );
			camera.updateMatrixWorld( true );

		} else if ( sourceCamera && typeof sourceCamera.clone === 'function' && ( sourceCamera.isPerspectiveCamera === true || sourceCamera.isOrthographicCamera === true ) ) {

			camera = sourceCamera.clone();
			if ( typeof camera.updateProjectionMatrix === 'function' ) camera.updateProjectionMatrix();
			camera.updateMatrixWorld( true );

		} else {

			camera = new PerspectiveCamera( 45, 1, 0.1, 100 );
			camera.position.set( 0, 0, 3 );
			camera.lookAt( 0, 0, 0 );

		}
		// Explicit captures can begin before the application's first render. In
		// that case Three has not yet copied the active backend coordinate system
		// onto the camera, and skip-warmup MRT extraction would sign WebGL's
		// default camera topology for a WebGPU pipeline. Mirror the renderer's
		// normal camera preparation before hashing or extracting.
		const rendererCoordinateSystem = captureRenderer && captureRenderer.coordinateSystem;
		if ( rendererCoordinateSystem !== undefined && rendererCoordinateSystem !== null && camera.coordinateSystem !== rendererCoordinateSystem ) {

			camera.coordinateSystem = rendererCoordinateSystem;
			if ( typeof camera.updateProjectionMatrix === 'function' ) camera.updateProjectionMatrix();

		}
		const sourceObject = captureContext.object || material.__tslpPrecompileObject || null;

		// Inherit scene-level state that drives PBR shader binding
		// generation. Without this, MeshStandard/MeshPhysical materials
		// extract WITHOUT the envMap (IBL) binding even when the user's
		// scene has `scene.environment` set — three.js's NodeBuilder reads
		// these off the active scene at compile time. We copy the scalar
		// scene-level fields (environment, fog, background); we do NOT
		// reparent lights, since `Object3D.add()` would detach them from
		// the user's actual scene and break their real render pass.
		const sourceScene = captureContext.scene || material.__tslpPrecompileScene || findParentScene( sourceObject );
		const hasExplicitMRT = Object.prototype.hasOwnProperty.call( captureContext, 'mrt' );
		let renderContextMRT = hasExplicitMRT
			? captureContext.mrt
			: sourceScene && sourceScene.userData && sourceScene.userData.__tslp_mrtNode || null;
		if ( ! hasExplicitMRT && ! renderContextMRT && typeof captureRenderer.getMRT === 'function' ) {

			try { renderContextMRT = captureRenderer.getMRT(); } catch ( _ ) {}

		}
		const sourceThreeVersion = exactThreePackageVersion( REVISION );
		const renderContextSignature = createRenderContextSignature( {
			renderer: captureRenderer,
			scene: sourceScene,
			camera,
			object: sourceObject,
			material,
			mrt: renderContextMRT,
		} );
		if ( sourceScene ) {

			scene.environment = sourceScene.environment || null;
			scene.environmentIntensity = sourceScene.environmentIntensity != null ? sourceScene.environmentIntensity : 1;
			scene.environmentRotation = sourceScene.environmentRotation || scene.environmentRotation;
			scene.background = sourceScene.background || null;
			scene.backgroundIntensity = sourceScene.backgroundIntensity != null ? sourceScene.backgroundIntensity : 1;
			scene.backgroundBlurriness = sourceScene.backgroundBlurriness || 0;
			scene.backgroundRotation = sourceScene.backgroundRotation || scene.backgroundRotation;
			scene.fog = sourceScene.fog || null;
			// Node-graph forms of fog/environment/background — TSL fog like
			// `scene.fogNode = fog(color(0x0000ff), rangeFogFactor(...))`
			// drives per-fragment color mixing at extraction time, and the
			// captured WGSL bakes it in. Without this copy, sprites fade
			// out / blue-shift in capture but render flat in replay.
			if ( sourceScene.fogNode ) scene.fogNode = sourceScene.fogNode;
			if ( sourceScene.environmentNode ) scene.environmentNode = sourceScene.environmentNode;
			if ( sourceScene.backgroundNode ) scene.backgroundNode = sourceScene.backgroundNode;

			// Clone (don't reparent) the user's lights into the throwaway
			// scene. Without this, `LightsNode` sees zero lights at
			// extraction time and emits a no-light shader path, so PBR
			// materials capture WITHOUT per-light uniform bindings — the
			// resulting shader can never light the surface at replay.
			// `Object3D.add()` would detach the original lights from the
			// user's real render pass, so we deep-clone instead.
			cloneLightsInto( sourceScene, scene );

		}

		const mesh = createCaptureObject( Mesh, BoxGeometry, sourceObject, material );
		// Synthetic extraction must compile marked materials even when their live
		// object is currently dormant. Object3D.clone() preserves `visible`, which
		// otherwise makes helpers that become visible later impossible to replay.
		mesh.visible = true;
		if ( sourceObject ) {

			for ( const key of Object.keys( sourceObject ) ) {

				if ( key === 'material' || key === 'geometry' || key === 'parent' || key === 'children' ) continue;
				// `boundingSphere` and `boundingBox` are subclass-coupled to a
				// `computeBoundingSphere`/`computeBoundingBox` method that lives
				// on the source object's class (e.g. InstancedMesh, BatchedMesh,
				// SkinnedMesh). Copying the field onto a plain `Mesh` makes
				// `Frustum.intersectsObject` think the object owns these caches
				// and call the missing `mesh.computeBoundingSphere()`, which
				// throws during `compileAsync` projection. Skip them — frustum
				// culling on the throwaway scene is meaningless anyway.
				if ( key === 'boundingSphere' || key === 'boundingBox' ) continue;
				if ( key in mesh && mesh[ key ] !== undefined && key !== 'color' ) continue;
				mesh[ key ] = sourceObject[ key ];

			}

			// A plain Mesh starts with count=1. Preserve explicit draw counts for
			// both InstancedMesh and shader-instanced Mesh patterns such as
			// `mesh.count = N` with StorageInstancedBufferAttribute inputs.
			if ( sourceObject.count > 1 ) mesh.count = sourceObject.count;
			if ( sourceObject.layers && mesh.layers ) mesh.layers.mask = sourceObject.layers.mask;

		}
		if ( camera && camera.layers && mesh.layers && ! camera.layers.test( mesh.layers ) ) {
			mesh.layers.mask = camera.layers.mask;
		}
		// Force-disable frustum culling on the throwaway mesh. Even after the
		// `boundingSphere` skip above, the source object may still have other
		// subclass-specific cull paths (e.g. `intersectsSprite`); the throwaway
		// camera is a placeholder so culling decisions here are meaningless.
		mesh.frustumCulled = false;
		// Occlusion queries describe the live render schedule, not the material
		// pipeline. Mirroring `occlusionTest` onto this one-object synthetic scene
		// can ask the WebGPU backend to end a query that its compile/warm-up path
		// never began, invalidating the capture command buffer.
		mesh.occlusionTest = false;
		// Propagate shadow flags. The `for...in Object.keys(sourceObject)` loop
		// above SKIPS `receiveShadow` / `castShadow` because they're inherited
		// `Object3D` defaults (so `key in mesh` returns true). Without this,
		// three.js's NodeBuilder compiles materials WITHOUT shadow sampling,
		// so the captured WGSL has no `getShadow()` call and replay shadows
		// can never appear regardless of runtime depth-texture wiring.
		if ( sourceObject ) {

			if ( sourceObject.receiveShadow ) mesh.receiveShadow = true;
			if ( sourceObject.castShadow ) mesh.castShadow = true;

		}
		if ( mesh.color === undefined && Color ) mesh.color = sourceObject && sourceObject.color || material.color || new Color( 1, 1, 1 );

		// ClippingGroup ancestry — when the source mesh is descended from one
		// or more ClippingGroups, three.js's renderer walks that chain at
		// render time to build a per-renderObject ClippingContext, which
		// `NodeMaterial.setupClipping(builder)` then turns into ClippingNode
		// WGSL (`discard()` for default scope, `discard()` + alpha-modulation
		// for `alphaToCoverage:true`). The throwaway scene must mirror that
		// ancestry or the extractor sees `builder.clippingContext === null`,
		// `setupClipping()` returns early, and the captured shader has no
		// clipping logic. Without this, replay can't render examples that
		// rely on `ClippingGroup` (`webgpu_clipping.html`) — the slim runtime
		// has no `Fn(...)`-based ClippingNode to fall back on.
		//
		// Clone the groups (don't reparent — the live groups are still in the
		// user's scene). Order outermost → innermost to preserve parent
		// chaining, matching how `ClippingContext.getGroupContext()` composes
		// nested contexts.
		const clipMountPoint = mountClippingGroupsInto( ClippingGroup, sourceObject, scene );
		clipMountPoint.add( mesh );

		// MRT propagation — the pass/global MRT defines the render-target
		// attachment layout, while `material.mrtNode` can override individual
		// outputs inside that layout. Prefer the pass/global descriptor when it
		// exists so NodeMaterial.setup() can perform the same
		// `rendererMRT.merge(materialMRT)` step it performs during live render.
		// Fall back to a pure material-level MRT when there is no surrounding
		// pass/global MRT.
		//
		// Heuristic: skip the renderer-scope fallback for fullscreen quad
		// meshes (post-process pipelines) — those render to the canvas, not
		// to the user's multi-target RT, so forcing MRT there would emit an
		// empty `OutputType { }` struct and crash WGSL.
		const materialMRTNode = material && material.mrtNode || null;
		let mrtNode = null;
		let captureRenderTarget = null;
		const isFullscreenQuad = sourceObject && ( sourceObject.isQuadMesh || sourceObject.constructor && sourceObject.constructor.name === 'QuadMesh' );
		// PassNode-driven MRT (`pass(scene, cam).setMRT(...)`): aux-marker
		// stamps the descriptor on `scene.userData.__tslp_mrtNode` because the
		// PassNode only writes `material.mrtNode` during a live render — after
		// our synthetic warm-up runs.
		if ( ! isFullscreenQuad && hasExplicitMRT ) {

			mrtNode = captureContext.mrt;

		} else if ( ! isFullscreenQuad && entry.mrtNode ) {

			mrtNode = entry.mrtNode;

		} else if ( ! isFullscreenQuad && sourceScene && sourceScene.userData && sourceScene.userData.__tslp_mrtNode ) {

			mrtNode = sourceScene.userData.__tslp_mrtNode;

		}
		if ( ! mrtNode && ! isFullscreenQuad && typeof captureRenderer.getMRT === 'function' ) {

			mrtNode = captureRenderer.getMRT();

		}
		if ( ! mrtNode ) mrtNode = materialMRTNode;
		let extractorOpts = renderObjectHarvest ? { renderObjectHarvest } : undefined;
		const observedComputeNodes = observedComputeNodesForCapture( captureRenderer );
		extractorOpts ||= {};
		extractorOpts.observedComputeNodes = observedComputeNodes;
		if ( mrtNode ) {

			extractorOpts ||= {};
			extractorOpts.mrtNode = mrtNode;
			const mrtOutputs = mrtNode.nodes || mrtNode.outputNodes || null;
			const mrtOutputNames = mrtOutputs ? Object.keys( mrtOutputs ) : [];
			captureRenderTarget = cloneRenderTargetForCapture( entry.mrtRenderTarget || entry.observedRenderTarget || getMRTCaptureRenderTarget( sourceScene, mrtNode ), mrtOutputNames );
			if ( captureRenderTarget ) extractorOpts.renderTargetOverride = captureRenderTarget;
			if ( mrtOutputNames.length > 1 ) extractorOpts.skipWarmupRender = true;

		} else if ( entry.observedRenderTarget ) {

			captureRenderTarget = cloneRenderTargetForCapture( entry.observedRenderTarget );
			if ( captureRenderTarget ) {

				extractorOpts ||= {};
				extractorOpts.renderTargetOverride = captureRenderTarget;

			}

		}

		const artifactSets = [];
		try {

			artifactSets.push( await extractor( captureRenderer, scene, camera, extractorOpts ) );

			// Pass/global MRT captures can produce a pre-pass shader for the same
			// material that later renders to the canvas/color target. Capture a
			// non-MRT sibling variant as part of the same author-facing artifact so
			// downstream apps get cache-key selection instead of needing the batch
			// harness' historical `:color` duplicate material name.
			//
			// Skip it when the material carries its OWN mrtNode: `noGlobalMRT`
			// only clears the pass/global descriptor, so the warm-up would build
			// the material's mrt() outputs against an unnamed single-attachment
			// canvas target — MRTNode.setup() resolves each output name to index
			// -1, emits an empty output struct, and the node build fails with
			// "Cannot read properties of undefined (reading 'type')"
			// (webgpu_postprocessing_bloom_selective). A material-level mrtNode
			// is inherently MRT-bound; it has no meaningful color-target variant.
			if ( mrtNode && mrtNode !== materialMRTNode && ! materialMRTNode ) {

				try {

						const colorArtifacts = await extractor( captureRenderer, scene, camera, {
							noGlobalMRT: true,
							observedComputeNodes,
						} );
					artifactSets.push( colorArtifacts );

				} catch ( err ) {

					console.warn( `[tsl-precompile] .precompile(${ JSON.stringify( name ) }): non-MRT variant capture failed; continuing with MRT artifact only.`, err );

				}

			}

		} finally {

			if ( captureRenderTarget ) {

				try { captureRenderTarget.dispose(); } catch ( _ ) {}

			}
		}

		let artifact = null;
		for ( const set of artifactSets ) {

			let candidate = set.byMaterialUuid && set.byMaterialUuid.get( material.uuid );
			if ( ! candidate ) {

				for ( const a of set ) {

					if ( a.materialUuid === material.uuid ) { candidate = a; break; }

				}

			}
			artifact = selectPreferredCaptureArtifact( artifact, candidate );

		}

		if ( ! artifact ) {

			console.error( `[tsl-precompile] .precompile(${ JSON.stringify( name ) }): extraction returned no artifact for material uuid=${ material.uuid }. The material may not have produced a NodeBuilderState.` );
			return;

		}

		// Tier C — variant-keyed artifact family.
		//
		// `extractor` walks the renderer's `nodeBuilderCache` and emits one
		// artifact per cacheKey. A single user material can produce multiple
		// cacheKey entries when its render state varies (clipping context,
		// MRT layout, blending, multiview, shadow signatures, …). Today we
		// only carry the "preferred" artifact through, which means scenes
		// whose live `renderObject.cacheKey` doesn't match the captured one
		// render with the wrong WGSL. Attach all variants on the preferred
		// artifact so the runtime can pick the right one per render.
		attachMaterialVariantFamily( artifact, collectMaterialVariantList( artifactSets, material.uuid ) );

		const sourceGraphHash = entry.sourceGraphHash || hashMaterialSync( material, {
			name,
			threeVersion: sourceThreeVersion,
			toolchainVersion: ARTIFACT_TOOLCHAIN_VERSION,
			renderContextSignature,
		} );

		// Phase 2 gate: any `severity: 'unknown'` kind in the codegen means we
		// hit a case the updater can't emit. Throw at capture time so the
		// developer sees the kind name next to their `.precompile()` call
		// (surfaces as an unhandled rejection in the console). Blocked kinds
		// are tolerated — they're known-deferred and get a warning instead.
		const unsupportedKinds = collectCodegenUnsupportedKinds( artifact, codegen );
		const unknowns = unsupportedKinds.filter( ( u ) => u.severity === 'unknown' );
		if ( unknowns.length > 0 ) {

			const summary = unknowns.map( ( u ) => `${ u.kind } @ byteOffset ${ u.byteOffset } — ${ u.reason }` ).join( '\n    ' );
			throw new Error( `[tsl-precompile] .precompile(${ JSON.stringify( name ) }): codegen has no case for ${ unknowns.length } kind(s) the extractor produced:\n    ${ summary }\nAdd a case to packages/plugin/src/emit-updater.js or document-block this kind in DOCUMENTED_BLOCKED_KINDS.` );

		}
		const blocked = unsupportedKinds.filter( ( u ) => u.severity === 'blocked' );
		if ( blocked.length > 0 ) {

			logOnce( 'blocked:' + name, () => console.warn( formatCaptureBlockedKindWarning( name, blocked ) ) );

		}

		// Strip non-serialisable side-cars before POST; dev capture only needs
		// the JSON-safe portion of the artifact.
		artifact.sourceGraphHash = sourceGraphHash;
		artifact.sourceHashVersion = ARTIFACT_TOOLCHAIN_VERSION;
		artifact.sourceThreeVersion = sourceThreeVersion;
		artifact.renderContextSignature = renderContextSignature;
		artifact.artifactContentHashVersion = ARTIFACT_CONTENT_HASH_VERSION;
		// autoMark runs at the constructor expression, before user code assigns
		// later *Node fields. Its build-time material cannot be graph-validated at
		// adoption time; the plugin-owned call-site revision is the correct gate.
		artifact.sourceValidationMode = entry.allowAutoFallback ? 'callsite' : 'runtime-graph';
		const sanitized = jsonSafeArtifact( artifact );
		const sourceMetadata = materialSourceMetadata( material, sourceObject );
		if ( Array.isArray( entry.sourceMaterialNodeProps ) ) sourceMetadata.nodeProps = entry.sourceMaterialNodeProps.slice();
		sanitized.sourceMaterial = sourceMetadata;
		const hash = hashArtifactContentSync( sanitized, {
			shape: `material:${ name }`,
			threeVersion: sourceThreeVersion,
			pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
		} );

		const response = await fetch( devEndpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify( {
				name,
				hash,
				artifact: sanitized,
				...( entry.sourceIdentity ? { sourceIdentity: entry.sourceIdentity } : {} ),
				...( entry.sourceRevision ? { sourceRevision: entry.sourceRevision } : {} ),
			} ),
		} );

		if ( ! response.ok ) {

			const txt = await response.text();
			console.error( `[tsl-precompile] dev capture failed for ${ JSON.stringify( name ) }: ${ response.status } ${ txt }` );
			return;

		}
		const accepted = await acceptedCaptureResponse( response, {
			name,
			hash,
			artifact: sanitized,
			threeVersion: sourceThreeVersion,
		} );
		captureAccepted = true;
		const acceptedUnsupportedKinds = accepted.artifact === sanitized
			? unsupportedKinds
			: collectCodegenUnsupportedKinds( accepted.artifact, codegen );

		// Publish only artifacts accepted by the capture endpoint. Development
		// recaptures intentionally replace the earlier inspector entry; production
		// registrations continue to reject divergent hashes in registerArtifact().
		__upsertArtifactForDev( name, {
			__hash: accepted.hash,
			__name: name,
			artifact: accepted.artifact,
			__unsupportedKinds: acceptedUnsupportedKinds,
		} );

		console.info( `[tsl-precompile] captured "${ name }" (hash ${ accepted.hash.slice( 0, 12 ) })` );

	} catch ( err ) {

		// Connection refused → mark dead so we don't flood the console on HMR.
		const msg = err && err.message ? err.message : String( err );
		if ( /fetch|ECONN|NetworkError|Failed to fetch/i.test( msg ) ) {

			installation.devEndpointDead = true;
			console.warn( `[tsl-precompile] dev capture endpoint ${ devEndpoint } unreachable (${ msg }). Further .precompile() calls in this session will be silent.` );

		} else {

			console.error( `[tsl-precompile] .precompile(${ JSON.stringify( name ) }) threw during capture:`, err );

		}

	} finally {

		// Fail open before awaiting cleanup: if a foreign wrapper prevents the
		// identity-based restore below, this guard can no longer black-hole the
		// application's future frames.
		renderGuardActive = false;
		// Another material or auxiliary capture can start while this capture is
		// awaiting codegen or the dev-endpoint POST. Its compile transaction
		// temporarily replaces renderer.render and later restores the guard it
		// observed here. Wait for the stable (including moving) compile tail
		// before releasing our guard so a queued compile cannot resurrect it
		// after cleanup and silently drop every subsequent application frame.
		if ( installedRenderGuard ) {

			await awaitRendererCompileQuiescence( captureRenderer, () => {

				if ( guardedRender && captureRenderer.render === installedRenderGuard ) captureRenderer.render = guardedRender;

			} );

		}
		recordDevCaptureOutcome( captureAccepted );

	}

}

async function acceptedCaptureResponse( response, fallback ) {

	let body = null;
	if ( response && typeof response.json === 'function' ) {

		try { body = await response.json(); } catch ( _ ) { /* custom endpoints may return an empty success body */ }

	}
	if ( ! body || typeof body !== 'object' || ( body.artifact === undefined && body.hash === undefined ) ) return fallback;
	if ( body.name !== undefined && body.name !== fallback.name ) {

		throw new Error( `[tsl-precompile] dev capture accepted the wrong artifact name ${ JSON.stringify( body.name ) } for ${ JSON.stringify( fallback.name ) }.` );

	}
	const artifact = body.artifact;
	const hash = typeof body.hash === 'string' ? body.hash.replace( /^sha256:/i, '' ).toLowerCase() : '';
	if ( ! artifact || typeof artifact !== 'object' || ! /^[a-f0-9]{64}$/.test( hash ) ) {

		throw new Error( `[tsl-precompile] dev capture returned an incomplete accepted artifact for ${ JSON.stringify( fallback.name ) }.` );

	}
	if ( artifact.artifactContentHashVersion !== ARTIFACT_CONTENT_HASH_VERSION ||
		artifact.sourceThreeVersion !== fallback.threeVersion ||
		artifact.sourceHashVersion !== ARTIFACT_TOOLCHAIN_VERSION ||
		artifact.sourceGraphHash !== fallback.artifact.sourceGraphHash ||
		artifact.sourceValidationMode !== fallback.artifact.sourceValidationMode ) {

		throw new Error( `[tsl-precompile] dev capture returned an incompatible accepted artifact for ${ JSON.stringify( fallback.name ) }.` );

	}
	const computed = hashArtifactContentSync( artifact, {
		shape: `material:${ fallback.name }`,
		threeVersion: fallback.threeVersion,
		pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
	} );
	if ( computed !== hash ) {

		throw new Error( `[tsl-precompile] dev capture returned an accepted artifact whose content does not match hash ${ hash }.` );

	}
	return { name: fallback.name, hash, artifact };

}

/**
 * Strip non-enumerable / non-JSON-serialisable side-cars from an artifact.
 * The vendored `extractArtifact` attaches Maps and live node references via
 * `Object.defineProperty(... { enumerable: false })`; JSON.stringify drops
 * those automatically. The shared serializer also omits stale enumerable
 * private sidecars without traversing their potentially large live payloads.
 *
 * @param {Object} artifact
 * @return {Object}
 */
function jsonSafeArtifact( artifact ) {

	return JSON.parse( stringifyArtifactJson( artifact ) );

}

/**
 * Clone every light from the source scene into the destination throwaway
 * scene. We must clone — never reparent — because `Object3D.add()` removes
 * the light from its existing parent and breaks the user's real render pass.
 *
 * three.js's `Light.clone()` (inherited via `Object3D.clone()`) covers every
 * built-in light class: AmbientLight, DirectionalLight, HemisphereLight,
 * PointLight, RectAreaLight, SpotLight, plus the IES/probe variants. It
 * preserves `color`, `intensity`, `position`, `distance`, `decay`, `angle`,
 * `penumbra`, `castShadow`, etc. via the standard `copy()` chain.
 *
 * Targets (DirectionalLight.target, SpotLight.target) are themselves Object3Ds
 * that live in the user's scene graph; `light.clone()` deep-clones the target
 * by default, so the cloned target carries the original target's transform
 * but is unparented. We add it to the throwaway scene alongside the light so
 * `updateMatrixWorld()` finds it during extraction.
 *
 * Lights nested inside transformed parents (e.g. a `PointLight` child of a
 * moving `particleLight` mesh) need their world transform baked in — the
 * throwaway scene won't replicate the parent chain. We compute the source
 * light's world matrix and decompose it onto the clone's local transform.
 *
 * @param {Object} sourceScene - The user's real scene (any Object3D with .traverse).
 * @param {Object} destScene - The throwaway scene to populate.
 */
function cloneLightsInto( sourceScene, destScene ) {

	if ( ! sourceScene || typeof sourceScene.traverse !== 'function' ) return;
	const lights = [];
	sourceScene.traverse( ( o ) => {

		if ( o && o.isLight === true ) lights.push( o );

	} );
	if ( lights.length === 0 ) return;

	// Make sure world matrices are current; users typically call
	// `scene.updateMatrixWorld()` once per frame before render, but the
	// extraction marker can fire from a microtask outside the render loop.
	if ( typeof sourceScene.updateMatrixWorld === 'function' ) sourceScene.updateMatrixWorld( true );

	for ( const light of lights ) {

		let cloned;
		try {

			cloned = typeof light.clone === 'function' ? light.clone() : null;

		} catch ( _ ) {

			cloned = null;

		}
		if ( ! cloned ) continue;
		stripClonedLightChildren( cloned );
		copyLightNodeGraphProps( light, cloned );

		// Bake world transform into the clone so a light parented under a
		// moving rig still illuminates from the right place during capture.
		// We only bother when the source has a non-identity world matrix
		// different from its local matrix (i.e. a non-Scene parent).
		if ( light.matrixWorld && light.parent && light.parent.isScene !== true ) {

			cloned.matrix.copy( light.matrixWorld );
			cloned.matrix.decompose( cloned.position, cloned.quaternion, cloned.scale );
			cloned.matrixWorldNeedsUpdate = true;

		}

		destScene.add( cloned );

		// SpotLight / DirectionalLight carry a separate `target` Object3D.
		// `Light.clone()` already deep-clones it, but the cloned target
		// stays unparented, so its world matrix never updates. Mirror the
		// source target's world transform onto the clone's target and add
		// it to the destination scene.
		if ( cloned.target && cloned.target.isObject3D && cloned.target !== cloned ) {

			const srcTarget = light.target;
			if ( srcTarget && srcTarget.matrixWorld ) {

				cloned.target.matrix.copy( srcTarget.matrixWorld );
				cloned.target.matrix.decompose( cloned.target.position, cloned.target.quaternion, cloned.target.scale );
				cloned.target.matrixWorldNeedsUpdate = true;

			}
			// Only attach if the target isn't already a descendant of the
			// cloned light (some custom Light subclasses parent target to
			// themselves).
			if ( ! cloned.target.parent ) destScene.add( cloned.target );

		}

	}

}

function copyLightNodeGraphProps( source, target ) {

	if ( ! source || ! target ) return;
	for ( const key of LIGHT_NODE_GRAPH_PROPS ) {

		if ( source[ key ] !== undefined ) target[ key ] = source[ key ];

	}

}

function stripClonedLightChildren( light ) {

	if ( ! light || ! Array.isArray( light.children ) ) return;
	const keep = light.target && light.target.isObject3D ? light.target : null;
	for ( const child of [ ...light.children ] ) {

		if ( child === keep ) continue;
		try { light.remove( child ); } catch ( _ ) {}

	}

}

/**
 * Mirror the source object's ClippingGroup ancestry into the throwaway
 * extraction scene. Returns the Object3D the throwaway mesh should be
 * attached to — either the innermost cloned ClippingGroup, or the destScene
 * itself when the source has no ClippingGroup ancestors.
 *
 * Clones, never reparents — the live groups remain in the user's scene.
 * Order is outermost → innermost so the cloned chain matches the user's,
 * which matters because `ClippingContext.getGroupContext()` composes nested
 * contexts by walking parent → child and merging plane sets.
 *
 * @param {Function|undefined} ClippingGroup - The three.js ClippingGroup constructor.
 * @param {Object|null} sourceObject - The user's source mesh, may be null.
 * @param {Object} destScene - The throwaway scene root.
 * @return {Object} The Object3D the throwaway mesh should be added to.
 */
function mountClippingGroupsInto( ClippingGroup, sourceObject, destScene ) {

	if ( ! ClippingGroup || ! sourceObject ) return destScene;

	const chain = [];
	let cursor = sourceObject.parent || null;
	while ( cursor ) {

		if ( cursor.isClippingGroup === true ) chain.unshift( cursor );
		cursor = cursor.parent || null;

	}
	if ( chain.length === 0 ) return destScene;

	let parent = destScene;
	for ( const group of chain ) {

		const cloned = new ClippingGroup();
		// `clippingPlanes` is an array of `Plane` instances. Share the same
		// references so the cloned group reflects live plane mutations during
		// extraction (the user might tweak plane.constant in a GUI between
		// scene mount and our extractor run; the captured shader is invariant
		// to the values, only the count/scope matters for shader shape).
		cloned.clippingPlanes = group.clippingPlanes;
		cloned.enabled = group.enabled;
		cloned.clipIntersection = group.clipIntersection;
		cloned.clipShadows = group.clipShadows;
		parent.add( cloned );
		parent = cloned;

	}
	return parent;

}

/**
 * Walk up an Object3D's parent chain to find the Scene it lives in. Returns
 * the Scene instance (anything with `.isScene === true`) or null. Used by
 * the precompile marker so the throwaway extraction scene can inherit the
 * real scene's environment / lights / fog — without that, PBR materials
 * extract without IBL bindings even when scene.environment is set.
 *
 * @param {Object3D|null} obj
 * @return {Object|null}
 */
function findParentScene( obj ) {

	let cursor = obj;
	while ( cursor ) {

		if ( cursor.isScene === true ) return cursor;
		cursor = cursor.parent || null;

	}
	return null;

}

function createCaptureObject( Mesh, BoxGeometry, sourceObject, material ) {

	if ( sourceObject && typeof sourceObject.clone === 'function' ) {

		try {

			const cloned = sourceObject.clone( false );
			if ( cloned && cloned !== sourceObject ) {

				cloned.parent = null;
				if ( Array.isArray( cloned.children ) && cloned.children.length > 0 ) cloned.children.length = 0;
				cloned.material = Array.isArray( sourceObject.material ) ? sourceObject.material : material;
				mirrorCaptureObjectRuntimeProperties( cloned, sourceObject );
				normalizeDetachedVisualHelper( cloned, sourceObject, Mesh );
				return cloned;

			}

		} catch ( _ ) {

			// Custom Object3D subclasses sometimes require constructor arguments
			// and do not implement clone(). Fall through to a conservative Mesh
			// surrogate while mirroring renderer-dispatch flags below.

		}

	}

	const fallback = new Mesh( sourceObject && sourceObject.geometry || new BoxGeometry( 1, 1, 1 ), material );
	if ( sourceObject ) {

		for ( const key of [
			'isSkinnedMesh', 'isInstancedMesh', 'isBatchedMesh', 'isSprite',
			'isLine', 'isLineSegments', 'isPoints', 'isQuadMesh',
		] ) {

			if ( sourceObject[ key ] === true ) fallback[ key ] = true;

		}
		mirrorCaptureObjectRuntimeProperties( fallback, sourceObject );

	}
	return fallback;

}

function normalizeDetachedVisualHelper( target, sourceObject, Mesh ) {

	const helperType = sourceObject && ( sourceObject.type || sourceObject.constructor && sourceObject.constructor.name ) || '';
	if ( sourceObject && sourceObject.isHelper !== true && ! /Helper$/.test( helperType ) ) return;
	const baseUpdateMatrixWorld = Mesh && Mesh.prototype && Mesh.prototype.updateMatrixWorld;
	if ( typeof baseUpdateMatrixWorld === 'function' ) target.updateMatrixWorld = baseUpdateMatrixWorld;

}

function mirrorCaptureObjectRuntimeProperties( target, sourceObject ) {

	for ( const key of [
		'skeleton', 'bindMatrix', 'bindMatrixInverse', 'instanceMatrix',
		'instanceColor', 'morphTargetInfluences', 'morphTargetDictionary',
		'_matricesTexture', '_colorsTexture', 'count',
	] ) {

		if ( sourceObject[ key ] !== undefined ) target[ key ] = sourceObject[ key ];

	}

}

const logged = new Set();
function logOnce( key, fn ) {

	if ( logged.has( key ) ) return;
	logged.add( key );
	fn();

}

/**
 * Dev capture always runs against full Three.js, even when the eventual
 * production build opts into slim replay. Keep this warning explicit about
 * which mode is affected so compatibility-mode adopters do not mistake a
 * future slim limitation for a problem in their current render.
 */
export function formatCaptureBlockedKindWarning( name, blocked = [] ) {

	const kinds = [ ...new Set( blocked.map( ( entry ) => entry && entry.kind ).filter( Boolean ) ) ];
	return `[tsl-precompile] .precompile(${ JSON.stringify( name ) }): capture recorded ${ blocked.length } kind(s) that slim replay cannot update yet. ` +
		`Full-Three development and compatibility builds remain live and are unaffected. If you later enable slim replay, these values use frozen snapshots and may not animate. ` +
		`Kinds: ${ kinds.join( ', ' ) || '<unknown>' }. Details: ${ TROUBLESHOOTING_URL }`;

}

/**
 * Reset internal state — test-only helper.
 */
export function __resetForTests() {

	for ( const epoch of [ ...renderCaptureEpochs ] ) closeRenderCaptureEpoch( epoch, false );
	for ( const renderer of registeredRenderers ) clearObservedComputeNodes( renderer );

	for ( const entries of pendingCaptures.values() ) {

		for ( const entry of entries.values() ) {

			if ( entry.observeTimer ) clearTimeout( entry.observeTimer );
			if ( entry.autoFallbackTimer ) clearTimeout( entry.autoFallbackTimer );

		}

	}
	installations = new WeakMap();
	installationSet = new Set();
	devRenderer = null;
	registeredRenderers = new Set();
	lastArrayCameraByRenderer = new WeakMap();
	lastRenderContextByRenderer = new WeakMap();
	renderCaptureEpochByRenderer = new WeakMap();
	renderCaptureEpochs = new Set();
	observedComputeNodesByRenderer = new WeakMap();
	__resetRenderObjectHarvestHandoffForTests();
	logged.clear();
	pendingCaptures = new Map();
	inflightCaptures = new Map();
	captureQueue = [];
	captureQueueRunning = false;
	const root = captureCounterRoot();
	if ( root && Object.prototype.hasOwnProperty.call( root, '__tslpPrecompilePending' ) ) root.__tslpPrecompilePending = 0;

}

export function __cloneLightsIntoForTests( sourceScene, destScene ) {

	return cloneLightsInto( sourceScene, destScene );

}

export function __createCaptureObjectForTests( Mesh, BoxGeometry, sourceObject, material ) {

	return createCaptureObject( Mesh, BoxGeometry, sourceObject, material );

}
