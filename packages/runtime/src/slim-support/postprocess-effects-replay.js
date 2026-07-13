/**
 * @module SlimSupport/PostprocessEffectsReplay
 *
 * Productized replay machinery for the post-processing effect handlers
 * defined in `postprocess-effects.js`. Where `postprocess-wire.js` simply
 * tags an effect's internal materials with `__tslpAuxShape`/
 * `__tslpAuxConfigHash` for late binding, this module goes one step
 * further and **physically swaps** each internal material for a
 * `PrecompiledMaterial` carrying a cloned aux artifact — the same shape
 * of work the e2e harness used to do inline for bloom.
 *
 * Adopters running the slim three.js bundle with `PostProcessing` +
 * `bloom()` / `outline()` / `ssr()` / `dof()` / `traa()` graph helpers
 * call `preparePrecompiledPostprocess({ postProcessing, loadAux,
 * PrecompiledMaterial })` once after building their graph. The function walks
 * the registry, calls the effect handler's
 * optional `forceSetup`/`wireSubPassUniforms`/`wireSubPassTextures`
 * hooks, and returns a `prepared` record describing exactly what was
 * swapped. Call `refreshPreparedPostprocessResources()` around later effect
 * updates so target resize/replacement is rebound without rebuilding the
 * materials.
 *
 * What this module deliberately does NOT do:
 *   - It does not patch `updateBefore` to run the effect inline with the
 *     slim renderer. Handlers that need that level of takeover register
 *     a `patchUpdateBefore` hook (currently none of the built-ins do —
 *     the bloom in-process loop is still owned by the harness while
 *     Agent B iterates on it).
 *   - It does not perform the harness-only full-renderer fallback path.
 *     Diagnostic counters, two-renderer state restoration, and the
 *     associated "render bloom through the full WebGPURenderer" code
 *     stay in `run-e2e.mjs` because they're benchmarking machinery, not
 *     production-relevant.
 */

import { listAux, findAux, attachPostprocessTextureRefs } from '../aux-loader.js';
import {
	collectEffectNodes,
	findEffectHandler,
	getEffectHandlers,
} from './postprocess-effects.js';
import { wireLiveNodeSidecarsToArtifact } from './live-node-sidecars.js';
import { rememberPreparedPostprocessResources } from './postprocess-resource-refresh.js';

export { wireLiveNodeSidecarsToArtifact } from './live-node-sidecars.js';
export { refreshPreparedPostprocessResources } from './postprocess-resource-refresh.js';

const PREPARED_FLAG = '__tslpEffectReplayReady';

/**
 * Detect the generated scene material used by three.js's RetroPassNode.
 *
 * The replay path needs this in browser-generated modules, so keep it as
 * simple string checks instead of a regexp that has to survive another
 * template-literal/codegen escaping layer.
 *
 * @param {Object} artifact
 * @return {boolean}
 */
export function artifactLooksLikeRetroPassMaterial( artifact ) {

	const vertexShader = artifact && typeof artifact.vertexShader === 'string' ? artifact.vertexShader : '';
	return vertexShader.includes( 'round(' ) || vertexShader.includes( 'screenSize' );

}

/**
 * Public entry point. Walks the live post-processing graph rooted at
 * `postProcessing.outputNode` (or `outputNode` directly), finds every
 * registered effect node, and prepares each one for slim replay.
 *
 * @param {Object}   args
 * @param {Object}   [args.postProcessing] - Live `PostProcessing` instance — its `outputNode` is the walk root.
 * @param {Object}   [args.outputNode]     - Alternative walk root (a TSL node or a thunk that resolves to one).
 * @param {Function} args.loadAux          - `(shape, configHash) => artifact`, typically the slim runtime's `loadAux`.
 * @param {Function} args.PrecompiledMaterial - Class that wraps an aux artifact for the hydrator's fast-path.
 * @param {string}   [args.auxConfigHash='tslp-e2e-bypass'] - Config-hash to request from `loadAux`. Set to the captured hash if you want strict matching; the default lets `loadAux`'s shape-fallback policy pick whichever capture is registered for the shape.
 * @param {Object}   [args.sharedContext]  - Forwarded to `handler.forceSetup` for effects whose `setup()` reads from a context object (e.g. bloom).
 * @param {Object}   [args.renderer]       - Renderer forwarded to effect setup hooks (required by SSS when material setup is still lazy).
 * @param {Array}    [args.passNodes]      - Optional live PassNode list for effects whose aux artifacts need current pass depth textures (TRAA).
 * @param {Object}   [args.diagnostics]    - Optional bag; per-handler counters are written under `diagnostics.byHandler[ handler.name ]`.
 * @return {{ effects: number, prepared: Array, missed: Array }}
 */
export function preparePrecompiledPostprocess( args = {} ) {

	if ( ! args || typeof args !== 'object' ) throw new TypeError( 'preparePrecompiledPostprocess: args object is required.' );
	if ( typeof args.loadAux !== 'function' ) throw new TypeError( 'preparePrecompiledPostprocess: args.loadAux must be a function.' );
	if ( typeof args.PrecompiledMaterial !== 'function' ) throw new TypeError( 'preparePrecompiledPostprocess: args.PrecompiledMaterial must be a class/constructor.' );

	const root = ( args.postProcessing && args.postProcessing.outputNode ) || args.outputNode || null;
	if ( ! root ) {

		return { effects: 0, prepared: [], missed: [ { shape: '*', reason: 'no outputNode passed' } ] };

	}

	const matches = collectEffectNodes( root );
	const allPrepared = [];
	const allMissed = [];
	const indexByHandler = new Map();
	const diag = args.diagnostics || null;
	if ( diag && ! diag.byHandler ) diag.byHandler = {};

	for ( const { handler, node } of matches ) {

		const effectIndex = indexByHandler.get( handler.name ) || 0;
		indexByHandler.set( handler.name, effectIndex + 1 );

		const result = prepareEffectNodeForReplay( handler, node, {
			loadAux: args.loadAux,
			PrecompiledMaterial: args.PrecompiledMaterial,
			auxConfigHash: args.auxConfigHash || 'tslp-e2e-bypass',
			sharedContext: args.sharedContext || null,
			renderer: args.renderer || null,
			passNodes: Array.isArray( args.passNodes ) ? args.passNodes : null,
			effectIndex,
		} );

		if ( diag ) {

			const slot = diag.byHandler[ handler.name ] || ( diag.byHandler[ handler.name ] = { prepared: 0, missed: 0 } );
			slot.prepared += result.prepared.length;
			slot.missed += result.missed.length;

		}

		allPrepared.push( ...result.prepared );
		allMissed.push( ...result.missed );

	}

	return { effects: matches.length, prepared: allPrepared, missed: allMissed };

}

/**
 * Prepare a single effect node for slim replay. Walks the handler's
 * sub-passes, wraps each material in a `PrecompiledMaterial`, runs any
 * registered handler hooks, and stamps the node with `PREPARED_FLAG`
 * so subsequent calls become no-ops.
 *
 * @param {Object} handler  - Effect handler from `getEffectHandlers()`.
 * @param {Object} node     - Live runtime effect node (BloomNode, OutlineNode, …).
 * @param {Object} opts
 * @param {Function} opts.loadAux
 * @param {Function} opts.PrecompiledMaterial
 * @param {string}   [opts.auxConfigHash='tslp-e2e-bypass']
 * @param {Object}   [opts.sharedContext]
 * @param {Object}   [opts.renderer]
 * @param {Array}    [opts.passNodes]
 * @param {number}   [opts.effectIndex=0]
 * @return {{ prepared: Array, missed: Array, alreadyPrepared: boolean }}
 */
export function prepareEffectNodeForReplay( handler, node, opts = {} ) {

	const prepared = [];
	const missed = [];

	if ( ! handler || typeof handler.subPasses !== 'function' || ! node ) {

		missed.push( { shape: '*', reason: 'invalid handler or node' } );
		return { prepared, missed, alreadyPrepared: false };

	}
	if ( typeof opts.loadAux !== 'function' ) throw new TypeError( 'prepareEffectNodeForReplay: opts.loadAux must be a function.' );
	if ( typeof opts.PrecompiledMaterial !== 'function' ) throw new TypeError( 'prepareEffectNodeForReplay: opts.PrecompiledMaterial must be a class/constructor.' );

	if ( node[ PREPARED_FLAG ] === true ) {

		return { prepared, missed, alreadyPrepared: true };

	}

	// Optional pre-step: ensure the effect's internal materials actually
	// exist on the node. Bloom needs this (lazy `setup()`), outline+ssr
	// usually don't, but we always offer the hook.
	if ( typeof handler.forceSetup === 'function' ) {

		try { handler.forceSetup( node, { renderer: opts.renderer || null, sharedContext: opts.sharedContext || null } ); } catch ( err ) {

			missed.push( { shape: handler.name + ':forceSetup', reason: ( err && err.message ) || String( err ) } );

		}

	}

	let subPasses = [];
	try { subPasses = handler.subPasses( node, opts.effectIndex || 0 ); } catch ( err ) {

		missed.push( { shape: handler.name + ':*', reason: ( err && err.message ) || String( err ) } );
		return { prepared, missed, alreadyPrepared: false };

	}

	if ( ! Array.isArray( subPasses ) || subPasses.length === 0 ) {

		missed.push( { shape: handler.name + ':*', reason: 'handler returned no sub-passes (materials not constructed yet?)' } );
		return { prepared, missed, alreadyPrepared: false };

	}

	const replacements = [];
	for ( const subPass of subPasses ) {

		if ( ! subPass || ! subPass.material || typeof subPass.shape !== 'string' ) continue;

		let replacement = null;
		try {

			replacement = makePrecompiledAuxMaterial( subPass.shape, subPass.material, opts );

		} catch ( err ) {

			missed.push( { shape: subPass.shape, reason: ( err && err.message ) || String( err ) } );
			continue;

		}

		if ( ! replacement ) {

			missed.push( { shape: subPass.shape, reason: 'no aux artifact registered for shape' } );
			continue;

		}

		// Let the handler run effect-specific uniform wiring (e.g. bloom's
		// direction/invSize matching) against the *replacement* material
		// (so the hooks see `replacement.precompiledArtifact`).
		wireLiveNodeSidecarsToArtifact( replacement.precompiledArtifact, subPass.material, { overlay: subPass.liveUniformOverlay === true } );
		attachPostprocessTextureRefs( replacement.precompiledArtifact, node );

		const subPassWithReplacement = { ...subPass, material: replacement };
		if ( typeof handler.wireSubPassUniforms === 'function' ) {

			try { handler.wireSubPassUniforms( subPassWithReplacement, subPass.material, opts ); } catch ( err ) {

				missed.push( { shape: subPass.shape + ':wireSubPassUniforms', reason: ( err && err.message ) || String( err ) } );

			}

		}

		replacements.push( { subPass, replacement } );
		prepared.push( {
			handler: handler.name,
			shape: subPass.shape,
			config: subPass.config || null,
			sourceMaterial: subPass.material,
			replacement,
		} );

	}

	// Swap live materials AFTER all replacements built — keeps the node in
	// a consistent state if any single sub-pass fails (we've already
	// pushed `missed` records for those and just skipped the swap).
	for ( const { subPass, replacement } of replacements ) {

		swapMaterialOnNode( node, subPass, replacement );

	}

	// Run handler-level texture wiring after the swap so hooks can read
	// the live node's per-frame render-target textures and stamp them
	// into `replacement.precompiledArtifact._textureRefs`.
	if ( typeof handler.wireSubPassTextures === 'function' ) {

		for ( const { subPass, replacement } of replacements ) {

			const subPassWithReplacement = { ...subPass, material: replacement };
			try { handler.wireSubPassTextures( subPassWithReplacement, node, opts ); } catch ( err ) {

				missed.push( { shape: subPass.shape + ':wireSubPassTextures', reason: ( err && err.message ) || String( err ) } );

			}

		}

	}

	// Optional last step: install runtime patches (e.g. updateBefore). None
	// of the built-ins use this yet — kept as an extension point so adopter
	// effects can register their own in-process loop.
	if ( typeof handler.patchUpdateBefore === 'function' ) {

		try { handler.patchUpdateBefore( node, { prepared, missed }, opts ); } catch ( err ) {

			missed.push( { shape: handler.name + ':patchUpdateBefore', reason: ( err && err.message ) || String( err ) } );

		}

	}

	if ( prepared.length > 0 ) {

		Object.defineProperty( node, PREPARED_FLAG, {
			value: true,
			configurable: true,
			enumerable: false,
			writable: true,
		} );
		rememberPreparedPostprocessResources( node, { handler, entries: replacements, opts } );

	}

	return { prepared, missed, alreadyPrepared: false };

}

/**
 * Build a `PrecompiledMaterial` for `shape`, cloning the aux artifact so
 * subsequent mutations (texture rebinds, live-uniform sidecars) don't
 * cross-contaminate other replay sites that share the same shape.
 *
 * @param {string} shape
 * @param {Object} sourceMaterial - Live material whose name/uniforms we mirror onto the replacement.
 * @param {Object} opts
 * @param {Function} opts.loadAux
 * @param {Function} opts.PrecompiledMaterial
 * @param {string}   [opts.auxConfigHash='tslp-e2e-bypass']
 * @return {?Object} A new PrecompiledMaterial, or `null` when no aux artifact is registered for the shape.
 */
export function makePrecompiledAuxMaterial( shape, sourceMaterial, opts = {} ) {

	if ( typeof opts.loadAux !== 'function' ) throw new TypeError( 'makePrecompiledAuxMaterial: opts.loadAux must be a function.' );
	if ( typeof opts.PrecompiledMaterial !== 'function' ) throw new TypeError( 'makePrecompiledAuxMaterial: opts.PrecompiledMaterial must be a class/constructor.' );
	const configHash = opts.auxConfigHash || 'tslp-e2e-bypass';

	let artifact = null;
	try { artifact = opts.loadAux( shape, configHash ); } catch ( _ ) { return null; }
	if ( ! artifact ) return null;

	const cloned = cloneAuxArtifact( artifact );
	const material = new opts.PrecompiledMaterial( cloned );
	material.name = ( sourceMaterial && sourceMaterial.name ) || shape;
	isolateClonedSidecarCacheKey( material, shape );

	// Mirror commonly-referenced uniform nodes from the source material so
	// effect-specific render loops (e.g. bloom's `material.colorTexture`,
	// `material.direction`, `material.invSize`) still find them on the
	// replacement instance.
	for ( const key of MATERIAL_MIRROR_KEYS ) {

		if ( sourceMaterial && sourceMaterial[ key ] !== undefined && material[ key ] === undefined ) {

			material[ key ] = shouldCloneMirrorSidecar( shape, key ) ? cloneLiveUniformSidecar( sourceMaterial[ key ] ) : sourceMaterial[ key ];

		}

	}
	for ( const key of MATERIAL_RENDER_STATE_KEYS ) {

		if ( sourceMaterial && sourceMaterial[ key ] !== undefined ) material[ key ] = sourceMaterial[ key ];

	}
	if ( typeof shape === 'string' && shape.startsWith( 'bloom-' ) ) material.toneMapped = false;
	material.needsUpdate = true;
	return material;

}

/**
 * Subset of node-material uniform-property names that effect render loops
 * commonly read off the material instance (rather than going through the
 * node graph). Mirroring them onto the `PrecompiledMaterial` keeps the
 * effect's existing `updateBefore` happy without scanning the node graph.
 */
const MATERIAL_MIRROR_KEYS = [ 'colorTexture', 'direction', 'invSize', 'depthTexture', 'maskTexture', 'historyTexture' ];
const MATERIAL_RENDER_STATE_KEYS = [ 'transparent', 'depthTest', 'depthWrite', 'toneMapped', 'blending', 'premultipliedAlpha' ];
let clonedSidecarMaterialSerial = 0;

function isolateClonedSidecarCacheKey( material, shape ) {

	if ( ! material || typeof shape !== 'string' || ! shape.startsWith( 'bloom-blur-' ) ) return;
	const base = typeof material.customProgramCacheKey === 'function'
		? material.customProgramCacheKey()
		: String( shape );
	const suffix = ++ clonedSidecarMaterialSerial;
	material.customProgramCacheKey = () => base + ':tslp-aux-instance:' + suffix;

}

function shouldCloneMirrorSidecar( shape, key ) {

	return typeof shape === 'string' && shape.startsWith( 'bloom-blur-' )
		&& ( key === 'colorTexture' || key === 'direction' );

}

function cloneLiveUniformSidecar( node ) {

	if ( ! node || typeof node !== 'object' ) return node;
	const value = node.value;
	const clonedValue = value && typeof value.clone === 'function'
		? value.clone()
		: value && typeof value === 'object'
			? { ...value }
			: value;
	return { value: clonedValue };

}

/**
 * Deep-clone an aux artifact. Used before mutating the artifact (texture
 * rebinds, live sidecars) so different replay sites that share the same
 * shape don't trample each other's bindings.
 *
 * @param {Object} artifact
 * @return {Object}
 */
export function cloneAuxArtifact( artifact ) {

	if ( ! artifact ) return artifact;
	try {

		if ( typeof structuredClone === 'function' ) return structuredClone( artifact );

	} catch ( _ ) {
		// Fall through to JSON-based fallback. `structuredClone` rejects on
		// `Texture`/`Function` payloads that might be on the artifact; the
		// JSON path silently drops them which is exactly what we want here.
	}
	return JSON.parse( JSON.stringify( artifact ) );

}

function swapMaterialOnNode( node, subPass, replacement ) {

	// Walk the node's own keys to find the live material instance and
	// swap it in place. Handles both plain references (e.g.
	// `node._highPassFilterMaterial`) and indexed arrays (e.g.
	// `node._separableBlurMaterials[ i ]`). Returns true on swap.
	if ( ! node || ! subPass || ! replacement || ! subPass.material ) return false;
	let swapped = false;
	let keys = [];
	try { keys = Object.getOwnPropertyNames( node ); } catch ( _ ) { return false; }
	for ( const key of keys ) {

		let value = null;
		try { value = node[ key ]; } catch ( _ ) { continue; }
		if ( value === subPass.material ) {

			try { node[ key ] = replacement; swapped = true; } catch ( _ ) {}

		} else if ( Array.isArray( value ) ) {

			for ( let i = 0; i < value.length; i ++ ) {

				if ( value[ i ] === subPass.material ) {

					value[ i ] = replacement;
					swapped = true;

				}

			}

		}

	}
	return swapped;

}

// ---------------------------------------------------------------------------
// Re-exports for adopters who want to read the registry contents without
// importing both modules.
// ---------------------------------------------------------------------------

export { listAux, findAux, collectEffectNodes, findEffectHandler, getEffectHandlers };
