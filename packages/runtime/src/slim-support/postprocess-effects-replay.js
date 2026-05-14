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
 * PrecompiledMaterial })` once after building their graph (and after each
 * resize). The function walks the registry, calls the effect handler's
 * optional `forceSetup`/`wireSubPassUniforms`/`wireSubPassTextures`
 * hooks, and returns a `prepared` record describing exactly what was
 * swapped — useful for diagnostics and re-wiring after textures change.
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

import { listAux, findAux } from '../aux-loader.js';
import {
	collectEffectNodes,
	findEffectHandler,
	getEffectHandlers,
} from './postprocess-effects.js';

const PREPARED_FLAG = '__tslpEffectReplayReady';

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

		try { handler.forceSetup( node, { sharedContext: opts.sharedContext || null } ); } catch ( err ) {

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
		const subPassWithReplacement = { material: replacement, shape: subPass.shape, config: subPass.config };
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

			const subPassWithReplacement = { material: replacement, shape: subPass.shape, config: subPass.config };
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

	// Mirror commonly-referenced uniform nodes from the source material so
	// effect-specific render loops (e.g. bloom's `material.colorTexture`,
	// `material.direction`, `material.invSize`) still find them on the
	// replacement instance.
	for ( const key of MATERIAL_MIRROR_KEYS ) {

		if ( sourceMaterial && sourceMaterial[ key ] !== undefined && material[ key ] === undefined ) {

			material[ key ] = sourceMaterial[ key ];

		}

	}
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

/**
 * Wire the live runtime uniform/update nodes from `sourceMaterial`'s
 * node graph back onto `artifact`'s uniform slots — the productized
 * equivalent of the harness's `__wireLiveNodeSidecarsToArtifact`.
 *
 * This walks the source material's node graph looking for UniformNode
 * instances and value-matches them to `uniform.live` slots on the
 * artifact, then attaches `_liveUpdateNodes` / `_liveUpdateBeforeNodes`
 * sidecars so the hydrator's per-frame updater finds them.
 *
 * @param {Object} artifact
 * @param {Object} sourceMaterial
 * @param {Object} [replacement] - Replacement material (the wrapped PrecompiledMaterial). Reserved for future deferred-update wiring; currently unused.
 * @return {{ uniformsMatched: number, updateNodes: number, updateBeforeNodes: number, updateAfterNodes: number }}
 */
export function wireLiveNodeSidecarsToArtifact( artifact, sourceMaterial /* , replacement = null */ ) {

	const counters = { uniformsMatched: 0, updateNodes: 0, updateBeforeNodes: 0, updateAfterNodes: 0 };
	if ( ! artifact || ! sourceMaterial ) return counters;

	const uniformNodes = [];
	const updateNodes = [];
	const updateBeforeNodes = [];
	const updateAfterNodes = [];

	walkMaterialNodeGraph( sourceMaterial, ( node ) => {

		if ( node.isUniformNode === true && ! uniformNodes.includes( node ) ) uniformNodes.push( node );
		if ( typeof node.update === 'function' && ! updateNodes.includes( node ) ) updateNodes.push( node );
		if ( typeof node.updateBefore === 'function' && ! updateBeforeNodes.includes( node ) ) updateBeforeNodes.push( node );
		if ( typeof node.updateAfter === 'function' && ! updateAfterNodes.includes( node ) ) updateAfterNodes.push( node );

	} );

	appendArtifactSidecars( artifact, '_liveUpdateNodes', updateNodes );
	appendArtifactSidecars( artifact, '_liveUpdateBeforeNodes', updateBeforeNodes );
	appendArtifactSidecars( artifact, '_liveUpdateAfterNodes', updateAfterNodes );
	counters.updateNodes = updateNodes.length;
	counters.updateBeforeNodes = updateBeforeNodes.length;
	counters.updateAfterNodes = updateAfterNodes.length;

	if ( uniformNodes.length === 0 ) return counters;

	const used = new Set();
	for ( const group of artifact.uniformPlan || [] ) {

		for ( const slot of group.slots || [] ) {

			const source = ( slot && slot.source ) || {};
			if ( source.kind !== 'uniform.live' || slot._liveNode ) continue;
			let match = null;
			if ( source.name ) match = uniformNodes.find( ( node ) => ! used.has( node ) && node.name === source.name && valueMatchesUniformSlot( node.value, slot ) );
			if ( ! match ) match = uniformNodes.find( ( node ) => ! used.has( node ) && valueMatchesUniformSlot( node.value, slot ) );
			if ( ! match ) continue;
			Object.defineProperty( slot, '_liveNode', {
				value: match,
				enumerable: false,
				configurable: true,
				writable: true,
			} );
			used.add( match );
			counters.uniformsMatched ++;

		}

	}

	return counters;

}

// ---------------------------------------------------------------------------
// Internal helpers (kept module-local; their shapes follow the harness's
// `__walkMaterialNodeGraph` / `__appendArtifactSidecars` / `__valueMatchesUniformSlot`
// so the productized API stays bug-compatible with the existing harness
// implementations).
// ---------------------------------------------------------------------------

const WALK_SKIP_KEYS = new Set( [ 'parent', 'children', 'scene', 'camera', 'renderer', 'geometry', '_cache', 'domElement', 'sourceMaterial' ] );
const DEFAULT_WALK_DEPTH = 24;

function walkMaterialNodeGraph( material, visit ) {

	const seen = new Set();
	const stack = [ { node: material, depth: 0 } ];
	while ( stack.length > 0 ) {

		const { node, depth } = stack.pop();
		if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) ) continue;
		if ( seen.has( node ) || depth > DEFAULT_WALK_DEPTH ) continue;
		seen.add( node );

		// Visit the node itself (the seed material gets visited too,
		// matching the harness's loose walker).
		if ( node !== material ) {

			try { visit( node ); } catch ( _ ) {}

		}

		let keys = [];
		try { keys = Object.getOwnPropertyNames( node ); } catch ( _ ) { continue; }
		for ( const key of keys ) {

			if ( WALK_SKIP_KEYS.has( key ) ) continue;
			let value = null;
			try { value = node[ key ]; } catch ( _ ) { continue; }
			if ( ! value ) continue;
			if ( Array.isArray( value ) ) {

				for ( const item of value ) stack.push( { node: item, depth: depth + 1 } );

			} else if ( typeof value === 'object' || typeof value === 'function' ) {

				stack.push( { node: value, depth: depth + 1 } );

			}

		}

	}

}

function appendArtifactSidecars( artifact, key, nodes ) {

	if ( ! artifact || ! Array.isArray( nodes ) || nodes.length === 0 ) return;
	const current = Array.isArray( artifact[ key ] ) ? artifact[ key ].slice() : [];
	let changed = false;
	for ( const node of nodes ) {

		if ( node && ! current.includes( node ) ) {

			current.push( node );
			changed = true;

		}

	}
	if ( changed ) {

		Object.defineProperty( artifact, key, {
			value: current,
			enumerable: false,
			configurable: true,
			writable: true,
		} );

	}

}

function valueMatchesUniformSlot( value, slot ) {

	if ( ! slot ) return false;
	const dtype = slot.dtype || ( slot.source && slot.source.valueSnapshot && slot.source.valueSnapshot.type ) || '';
	if ( dtype === 'color' ) return !! ( value && value.isColor );
	if ( dtype === 'number' || dtype === 'float' ) return typeof value === 'number' || ( value && value.isUniformNode !== true && typeof value.value === 'number' );
	if ( dtype === 'vec2' ) return !! ( value && value.isVector2 );
	if ( dtype === 'vec3' ) return !! ( value && ( value.isVector3 || value.isColor ) );
	if ( dtype === 'vec4' ) return !! ( value && value.isVector4 );
	if ( dtype === 'mat3' ) return !! ( value && value.isMatrix3 );
	if ( dtype === 'mat4' ) return !! ( value && value.isMatrix4 );
	return true;

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
