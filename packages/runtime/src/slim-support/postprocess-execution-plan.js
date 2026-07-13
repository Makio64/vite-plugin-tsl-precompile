/**
 * Build the smallest useful execution plan for pass-context effects.
 *
 * A pass that contains a live effect dependency consumes that effect's output;
 * effect handlers explicitly identify the passes that produce their inputs.
 * Keeping the partition in runtime code prevents replay callers from rendering
 * every pass both before and after effects such as GTAO.
 */

import { getLiveNodeDependencies } from './node-dependencies.js';
import { collectEffectNodes } from './postprocess-effects.js';

const SKIP_KEYS = new Set( [
	'parent', 'children', '_cache', 'scene', 'camera', 'renderer',
	'geometry', 'material', 'domElement',
] );

function uniqueIdentities( values ) {

	const out = [];
	for ( const value of Array.isArray( values ) ? values : [] ) {

		if ( value && ! out.includes( value ) ) out.push( value );

	}
	return out;

}

/**
 * Determine whether `root` reaches `target` through explicit live dependency
 * edges or ordinary own properties. Safe against cycles and throwing getters.
 *
 * @param {*} root
 * @param {*} target
 * @param {{ depthCap?: number }} [options]
 * @return {boolean}
 */
export function postprocessGraphContains( root, target, options = {} ) {

	if ( ! target ) return false;
	const seen = new Set();
	const cap = typeof options.depthCap === 'number' ? options.depthCap : 32;
	return walk( root, 0 );

	function walk( value, depth ) {

		if ( value === target ) return true;
		if ( ! value || ( typeof value !== 'object' && typeof value !== 'function' ) ) return false;
		if ( depth > cap || seen.has( value ) ) return false;
		seen.add( value );

		for ( const dependency of getLiveNodeDependencies( value ) ) {

			if ( walk( dependency.node, depth + 1 ) ) return true;

		}

		let keys = [];
		try { keys = Object.getOwnPropertyNames( value ); } catch ( _ ) { return false; }
		for ( const key of keys ) {

			if ( SKIP_KEYS.has( key ) ) continue;
			let child = null;
			try { child = value[ key ]; } catch ( _ ) { continue; }
			if ( Array.isArray( child ) ) {

				for ( const item of child ) if ( walk( item, depth + 1 ) ) return true;

			} else if ( walk( child, depth + 1 ) ) {

				return true;

			}

		}
		return false;

	}

}

/**
 * Build a conservative single pass-context wave from registered handler
 * metadata. Callers should keep their legacy ordering when `supported` is
 * false; this planner intentionally does not attempt a general render DAG.
 *
 * @param {{ passNodes?: Array<any>, outputNode?: any, collectEffects?: (root:any) => Array<{handler:any,node:any}> }} [options]
 * @return {{ mode:'single-context-wave', supported:boolean, producerPasses:Array<any>, contextEffects:Array<{handler:any,node:any,producerPasses:Array<any>,consumerPasses:Array<any>}>, consumerPasses:Array<any>, terminalEffects:Array<{handler:any,node:any}>, unplacedPasses:Array<any>, issues:Array<string> }}
 */
export function createPostprocessExecutionPlan( options = {} ) {

	const passNodes = uniqueIdentities( options.passNodes );
	const collectEffects = typeof options.collectEffects === 'function' ? options.collectEffects : collectEffectNodes;
	let matches = [];
	try { matches = collectEffects( options.outputNode ); } catch ( _ ) { matches = []; }
	if ( ! Array.isArray( matches ) ) matches = [];

	const contextMatches = matches.filter( ( match ) => match && match.handler && match.handler.execution && match.handler.execution.phase === 'pass-context' && match.node );
	const terminalEffects = matches.filter( ( match ) => match && match.handler && match.handler.execution && match.handler.execution.phase === 'terminal' && match.node );
	const contextEffects = [];
	const consumerPasses = [];
	const explicitProducerPasses = [];
	const issues = [];

	for ( const match of contextMatches ) {

		const consumers = passNodes.filter( ( passNode ) => postprocessGraphContains( passNode, match.node ) );
		let declaredProducers = [];
		try {

			declaredProducers = typeof match.handler.execution.getProducerPasses === 'function'
				? uniqueIdentities( match.handler.execution.getProducerPasses( match.node ) ).filter( ( passNode ) => passNodes.includes( passNode ) )
				: [];

		} catch ( _ ) { declaredProducers = []; }
		if ( consumers.length === 0 ) issues.push( `effect "${ match.handler.name }" has no consuming pass` );
		if ( declaredProducers.length === 0 ) issues.push( `effect "${ match.handler.name }" has no declared producer pass` );
		for ( const passNode of consumers ) if ( ! consumerPasses.includes( passNode ) ) consumerPasses.push( passNode );
		for ( const passNode of declaredProducers ) if ( ! explicitProducerPasses.includes( passNode ) ) explicitProducerPasses.push( passNode );
		contextEffects.push( { handler: match.handler, node: match.node, producerPasses: declaredProducers, consumerPasses: consumers } );

	}

	const overlappingPasses = explicitProducerPasses.filter( ( passNode ) => consumerPasses.includes( passNode ) );
	const producerPasses = passNodes.filter( ( passNode ) => explicitProducerPasses.includes( passNode ) && ! consumerPasses.includes( passNode ) );
	const unplacedPasses = passNodes.filter( ( passNode ) => ! producerPasses.includes( passNode ) && ! consumerPasses.includes( passNode ) );
	if ( contextEffects.length > 0 && consumerPasses.length !== 1 ) issues.push( `single context wave requires exactly one consumer pass (found ${ consumerPasses.length })` );
	if ( contextEffects.length > 0 && unplacedPasses.length > 0 ) issues.push( `pass-context wave has ${ unplacedPasses.length } unplaced pass(es)` );
	if ( overlappingPasses.length > 0 ) issues.push( 'pass-context wave has a pass placed as both producer and consumer' );

	return {
		mode: 'single-context-wave',
		supported: contextEffects.length > 0 && issues.length === 0,
		producerPasses,
		contextEffects,
		consumerPasses,
		terminalEffects,
		unplacedPasses,
		issues,
	};

}
