/**
 * @module SlimSupport/PostprocessWire
 *
 * Productized seam for wiring live post-processing node graphs
 * (`PostProcessing`, `bloom()`, `outline()`, `ssr()`, `dof()`, `traa()`,
 * ...) back to their precompiled aux artifacts at slim-replay time.
 *
 * Why this exists: the slim three.js bundle has the node-builder stripped,
 * so code that constructs TSL postprocess helpers like `bloom(scenePass)`
 * at runtime cannot compile their internal materials. We capture those
 * internal materials as aux artifacts during dev (see `aux-marker.js`
 * `captureRegisteredEffectArtifactsLive`). At replay time this module
 * discovers the same live nodes via the shared registry in
 * `postprocess-effects.js` and stamps each internal material with
 * `__tslpAuxShape` / `__tslpAuxConfigHash` so the slim runtime can resolve
 * them through `aux-loader.loadAux(shape, configHash)`.
 *
 * Adding a new effect: register a handler in `postprocess-effects.js`. The
 * capture path AND the replay path pick it up automatically — no edits
 * needed here.
 */

import { bindAuxConfig, listAux, findAux } from '../aux-loader.js';
import { collectEffectNodes, getEffectHandlers } from './postprocess-effects.js';

/**
 * Discover every registered effect node in `outputNode` and wire each
 * one's internal materials to their precompiled aux artifacts.
 *
 * Idempotent: re-wiring a node whose internal materials are already
 * stamped is a no-op. Safe to call from a resize handler or per-frame
 * rescan loop.
 *
 * Materials that don't exist yet at call time (effects can construct
 * their internal materials lazily during the first `updateBefore`) are
 * reported in `missed` rather than thrown. Callers can rescan later.
 *
 * @param {{ postProcessing?: Object, outputNode?: Object|Function }} args
 * @return {{ effects: number, wired: Array, missed: Array }}
 */
export function wirePrecompiledPostprocess( args = {} ) {

	const root = ( args.postProcessing && args.postProcessing.outputNode ) || args.outputNode || null;
	if ( ! root ) return { effects: 0, wired: [], missed: [ { shape: '*', reason: 'no outputNode passed' } ] };

	const matches = collectEffectNodes( root );
	const allWired = [];
	const allMissed = [];
	const indexByHandler = new Map();

	for ( const { handler, node } of matches ) {

		const effectIndex = indexByHandler.get( handler.name ) || 0;
		indexByHandler.set( handler.name, effectIndex + 1 );

		const { wired, missed } = wireRegisteredEffectNode( handler, node, effectIndex );
		allWired.push( ...wired );
		allMissed.push( ...missed );

	}

	return { effects: matches.length, wired: allWired, missed: allMissed };

}

/**
 * Wire one effect node's internal materials to their precompiled aux
 * artifacts. Used internally by `wirePrecompiledPostprocess`; exported
 * for adopters who manage their own walk.
 *
 * @param {Object} handler - handler from `getEffectHandlers()`
 * @param {Object} node - live runtime effect node
 * @param {number} effectIndex - 0-based index among same-handler matches
 * @return {{ wired: Array<{shape: string, name?: string, configHash: string}>, missed: Array<{shape: string, reason: string}> }}
 */
export function wireRegisteredEffectNode( handler, node, effectIndex = 0 ) {

	const wired = [];
	const missed = [];

	if ( ! handler || typeof handler.subPasses !== 'function' || ! node ) {

		missed.push( { shape: '*', reason: 'invalid handler or node' } );
		return { wired, missed };

	}

	let subPasses = [];
	try { subPasses = handler.subPasses( node, effectIndex ); } catch ( err ) {

		missed.push( { shape: handler.name + ':*', reason: ( err && err.message ) || String( err ) } );
		return { wired, missed };

	}

	if ( ! Array.isArray( subPasses ) || subPasses.length === 0 ) {

		missed.push( { shape: handler.name + ':*', reason: 'handler returned no sub-passes (materials not constructed yet?)' } );
		return { wired, missed };

	}

	for ( const subPass of subPasses ) {

		if ( ! subPass || ! subPass.material || typeof subPass.shape !== 'string' ) continue;

		const entry = pickAuxForShape( subPass.shape, effectIndex );
		if ( ! entry ) {

			missed.push( { shape: subPass.shape, reason: 'no aux artifact registered for shape' } );
			continue;

		}
		try {

			bindAuxConfig( subPass.material, entry );
			wired.push( { shape: entry.shape, name: entry.name, configHash: entry.configHash } );

		} catch ( err ) {

			missed.push( { shape: subPass.shape, reason: ( err && err.message ) || String( err ) } );

		}

	}

	return { wired, missed };

}

/**
 * Pick the best aux entry for a given shape. We prefer an entry whose
 * friendly name contains `_${effectIndex}_` (rare but possible when
 * multiple instances were captured), and fall back to the first known
 * shape match — the same fallback policy as `aux-loader.loadAux`.
 *
 * @param {string} shape
 * @param {number} effectIndex
 * @return {?{ shape: string, configHash: string, name?: string }}
 */
function pickAuxForShape( shape, effectIndex ) {

	const candidates = listAux().filter( ( e ) => e.shape === shape );
	if ( candidates.length === 0 ) return null;

	for ( const c of candidates ) {

		if ( c.name && c.name.indexOf( `_${ effectIndex }_` ) !== - 1 ) return c;

	}
	return candidates[ 0 ];

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

// ---------------------------------------------------------------------------
// Back-compat shims
// ---------------------------------------------------------------------------

/**
 * Back-compat alias. Use `collectEffectNodes` from `postprocess-effects.js`
 * instead — it returns `[{ handler, node }, ...]` for every registered
 * effect handler, not just bloom.
 *
 * @deprecated Prefer `collectEffectNodes` from `./postprocess-effects.js`.
 * @param {*} root
 * @return {Array<Object>} live bloom effect nodes only (filtered for compat)
 */
export function collectLiveBloomNodes( root ) {

	const matches = collectEffectNodes( root );
	return matches.filter( ( m ) => m.handler.name === 'bloom' ).map( ( m ) => m.node );

}

/**
 * Back-compat alias. Use `wireRegisteredEffectNode` instead.
 *
 * @deprecated Prefer `wireRegisteredEffectNode` from this module.
 * @param {Object} bloomNode
 * @param {{ bloomIndex?: number }} [opts]
 */
export function wireBloomNode( bloomNode, opts = {} ) {

	const bloomIndex = typeof opts.bloomIndex === 'number' ? opts.bloomIndex : 0;
	const handler = getEffectHandlerByName( 'bloom' );
	if ( ! handler ) {

		return { wired: [], missed: [ { shape: 'bloom:*', reason: 'bloom handler not registered' } ] };

	}
	return wireRegisteredEffectNode( handler, bloomNode, bloomIndex );

}

function getEffectHandlerByName( name ) {

	for ( const h of getEffectHandlers() ) if ( h.name === name ) return h;
	return null;

}
