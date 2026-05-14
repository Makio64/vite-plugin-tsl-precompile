/**
 * @module SlimSupport/PostprocessWire
 *
 * Productized seam for wiring live post-processing node graphs
 * (`PostProcessing`, `bloom()`, `outline()`, `gtao()`, etc.) back to their
 * precompiled aux artifacts at slim-replay time.
 *
 * Why this exists: the slim three.js bundle has the node-builder stripped, so
 * code that constructs TSL postprocess helpers like `bloom(scenePass)` at
 * runtime cannot compile their internal materials. We capture those internal
 * materials as aux artifacts during dev (see `aux-marker.js` —
 * `bloom-high-pass`, `bloom-blur-N`, `bloom-composite`). At replay time this
 * module discovers the same live nodes and stamps each internal material with
 * `__tslpAuxShape` / `__tslpAuxConfigHash` so the slim runtime can resolve them
 * through `aux-loader.loadAux(shape, configHash)`.
 *
 * Today this implements the bloom shape (most-requested per BACKLOG). The
 * same pattern generalises to `outline`, `gtao`, `ssr`, etc. — call
 * `wireBloomNodes` from `wirePrecompiledPostprocess` and add sibling discovery
 * helpers when each follow-up shape is unblocked.
 */

import { bindAuxConfig, listAux, findAux } from '../aux-loader.js';

const MAX_TRAVERSAL_DEPTH = 32;

/**
 * Discover bloom effect nodes inside a post-processing graph.
 *
 * Mirrors the discovery in `aux-marker.js::collectBloomEffectNodes` so capture
 * and replay agree on what counts as a "bloom effect node" — duck-typed by the
 * pair of `_renderTargetsHorizontal` + `_renderTargetsVertical` arrays and a
 * `_renderTargetBright` render target.
 *
 * @param {Object|Function} root - typically `postProcessing.outputNode`.
 * @return {Array<Object>} live bloom effect nodes (deduplicated, traversal order)
 */
export function collectLiveBloomNodes( root ) {

	const out = [];
	const seen = new Set();
	walkBloomCandidates( root, out, seen, 0 );
	return out;

}

function walkBloomCandidates( node, out, seen, depth ) {

	if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) ) return;
	if ( depth > MAX_TRAVERSAL_DEPTH || seen.has( node ) ) return;
	seen.add( node );

	if ( isLiveBloomNode( node ) ) {

		if ( ! out.includes( node ) ) out.push( node );
		return;

	}

	let keys;
	try { keys = Object.getOwnPropertyNames( node ); } catch ( _ ) { return; }
	const skip = SKIP_KEYS;
	for ( const key of keys ) {

		if ( skip.has( key ) ) continue;
		let child;
		try { child = node[ key ]; } catch ( _ ) { continue; }
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {

			for ( const item of child ) walkBloomCandidates( item, out, seen, depth + 1 );

		} else {

			walkBloomCandidates( child, out, seen, depth + 1 );

		}

	}

}

const SKIP_KEYS = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );

function isLiveBloomNode( node ) {

	return !! ( node
		&& typeof node.updateBefore === 'function'
		&& node._renderTargetBright
		&& Array.isArray( node._renderTargetsHorizontal )
		&& Array.isArray( node._renderTargetsVertical ) );

}

/**
 * Wire one bloom node's internal materials to their precompiled aux artifacts.
 *
 * For each of `_highPassFilterMaterial`, `_separableBlurMaterials[i]`, and
 * `_compositeMaterial`, look up the matching aux entry by name (the dev-time
 * default is `aux-bloom-<sub>-<hash12>`; the capture also stamps a shape +
 * config), then stamp `__tslpAuxShape` / `__tslpAuxConfigHash` on the material
 * via `bindAuxConfig`. The slim render path uses those properties to resolve
 * the captured WGSL through `aux-loader.loadAux`.
 *
 * Materials that don't exist yet at call time are reported as `missed` rather
 * than thrown; bloom subnodes can construct their internal materials lazily
 * (e.g. during the first `updateBefore`). Callers can `rescan()` later.
 *
 * @param {Object} bloomNode - a node returned by `collectLiveBloomNodes`.
 * @param {{ bloomIndex?: number }} [opts]
 * @return {{ wired: Array<{ shape: string, name?: string, configHash: string }>, missed: Array<{ shape: string, reason: string }> }}
 */
export function wireBloomNode( bloomNode, opts = {} ) {

	const bloomIndex = typeof opts.bloomIndex === 'number' ? opts.bloomIndex : 0;
	const wired = [];
	const missed = [];

	const attempts = [];
	if ( bloomNode._highPassFilterMaterial ) {

		attempts.push( { material: bloomNode._highPassFilterMaterial, shape: 'bloom-high-pass' } );

	} else {

		missed.push( { shape: 'bloom-high-pass', reason: 'material not constructed yet' } );

	}
	if ( Array.isArray( bloomNode._separableBlurMaterials ) ) {

		for ( let i = 0; i < bloomNode._separableBlurMaterials.length; i ++ ) {

			const material = bloomNode._separableBlurMaterials[ i ];
			if ( material ) attempts.push( { material, shape: `bloom-blur-${ i }`, blurIndex: i } );
			else missed.push( { shape: `bloom-blur-${ i }`, reason: 'material not constructed yet' } );

		}

	} else {

		missed.push( { shape: 'bloom-blur', reason: 'separable blur materials array missing' } );

	}
	if ( bloomNode._compositeMaterial ) {

		attempts.push( { material: bloomNode._compositeMaterial, shape: 'bloom-composite' } );

	} else {

		missed.push( { shape: 'bloom-composite', reason: 'material not constructed yet' } );

	}

	for ( const attempt of attempts ) {

		const entry = pickAuxForShape( attempt.shape, bloomIndex );
		if ( ! entry ) {

			missed.push( { shape: attempt.shape, reason: 'no aux artifact registered for shape' } );
			continue;

		}
		try {

			bindAuxConfig( attempt.material, entry );
			wired.push( { shape: entry.shape, name: entry.name, configHash: entry.configHash } );

		} catch ( err ) {

			missed.push( { shape: attempt.shape, reason: ( err && err.message ) || String( err ) } );

		}

	}

	return { wired, missed };

}

/**
 * Pick the best aux entry for a given shape. We prefer an exact friendly name
 * (`aux-<shape>-<hash12>` is the dev default) but fall back to "first known of
 * matching shape" — the same fallback policy as `aux-loader.loadAux`.
 *
 * @param {string} shape
 * @param {number} bloomIndex
 * @return {?{ shape: string, configHash: string, name?: string }}
 */
function pickAuxForShape( shape, _bloomIndex ) {

	const candidates = listAux().filter( ( e ) => e.shape === shape );
	if ( candidates.length === 0 ) return null;

	// If multiple bloom indices were captured (rare), prefer the one whose
	// friendly name contains a matching `bloomIndex`. Fall through to the
	// first candidate when no name-based disambiguation is possible — this
	// matches `loadAux`'s shape-only fallback (with a one-time warn).
	for ( const c of candidates ) {

		if ( c.name && c.name.indexOf( `_${ _bloomIndex }_` ) !== -1 ) return c;

	}
	return candidates[ 0 ];

}

/**
 * Discover every bloom effect node in `outputNode` and wire each one.
 *
 * Idempotent: re-wiring a node whose internal materials are already stamped
 * is a no-op (`bindAuxConfig` is itself idempotent). Safe to call from a
 * resize handler or per-frame rescan loop.
 *
 * @param {{ postProcessing?: Object, outputNode?: Object|Function }} args - one of
 *   `postProcessing.outputNode` or a raw `outputNode` reference.
 * @return {{ bloomNodes: number, wired: Array, missed: Array }}
 */
export function wirePrecompiledPostprocess( args = {} ) {

	const root = ( args.postProcessing && args.postProcessing.outputNode ) || args.outputNode || null;
	if ( ! root ) return { bloomNodes: 0, wired: [], missed: [ { shape: '*', reason: 'no outputNode passed' } ] };

	const bloomNodes = collectLiveBloomNodes( root );
	const allWired = [];
	const allMissed = [];

	for ( let i = 0; i < bloomNodes.length; i ++ ) {

		const { wired, missed } = wireBloomNode( bloomNodes[ i ], { bloomIndex: i } );
		allWired.push( ...wired );
		allMissed.push( ...missed );

	}

	return { bloomNodes: bloomNodes.length, wired: allWired, missed: allMissed };

}

/**
 * Look up a single aux entry by shape + friendly name. Re-exported as a
 * convenience for adopters who need to inspect what's available before
 * deciding how to wire it.
 *
 * @param {string} shape
 * @param {string} nameOrConfigHash
 */
export function findPostprocessAux( shape, nameOrConfigHash ) {

	return findAux( shape, nameOrConfigHash );

}
