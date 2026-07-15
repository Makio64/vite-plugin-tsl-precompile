/**
 * Process-wide weak registry for UniformNodes created by the slim TSL facade.
 *
 * Some user uniforms live only inside `Fn()` closures, so they cannot be
 * rediscovered by walking a material after JSON artifacts have dropped their
 * object sidecars. Extraction assigns artifact-local `liveNodeId` values; the
 * registry supplies the freshly-created runtime candidates used to reconnect
 * those identities. A Symbol-backed state keeps duplicate runtime copies and
 * HMR on one ledger without retaining nodes when WeakRef is available.
 */

import {
	createLiveUniformNodeIdentity,
	isLiveUniformNodeIdentity,
	LIVE_UNIFORM_NODE_IDENTITY_SYMBOL_KEY,
} from '@tsl-precompile/contract/dynamic-bindings';

const REGISTRY_KEY = Symbol.for( '@tsl-precompile/runtime/live-uniform-registry@1' );
const NODE_IDENTITY_KEY = Symbol.for( LIVE_UNIFORM_NODE_IDENTITY_SYMBOL_KEY );

function registryState() {

	const owner = typeof globalThis !== 'undefined' ? globalThis : {};
	let state = owner[ REGISTRY_KEY ];
	if ( ! state ) {

		state = { refs: [], seen: new WeakSet() };
		try { Object.defineProperty( owner, REGISTRY_KEY, { value: state, configurable: true } ); } catch ( _ ) { owner[ REGISTRY_KEY ] = state; }

	}
	return state;

}

export function registerLiveUniformNode( node, callsiteIdentity = null, occurrence = null ) {

	if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) || node.isUniformNode !== true ) return node;
	const identity = callsiteIdentity === null
		? null
		: createLiveUniformNodeIdentity( callsiteIdentity, occurrence );
	if ( identity !== null && getLiveUniformNodeIdentity( node ) === null ) {

		try {

			Object.defineProperty( node, NODE_IDENTITY_KEY, {
				value: identity,
				enumerable: false,
				configurable: true,
			} );

		} catch ( _ ) {}

	}
	const state = registryState();
	if ( state.seen.has( node ) ) return node;
	state.seen.add( node );
	state.refs.push( typeof WeakRef === 'function' ? new WeakRef( node ) : node );
	return node;

}

export function getLiveUniformNodeIdentity( node ) {

	if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) ) return null;
	let identity = null;
	try { identity = node[ NODE_IDENTITY_KEY ]; } catch ( _ ) { return null; }
	return isLiveUniformNodeIdentity( identity ) ? identity : null;

}

export function listLiveUniformNodes() {

	const state = registryState();
	const nodes = [];
	const liveRefs = [];
	for ( const ref of state.refs ) {

		const node = ref && typeof ref.deref === 'function' ? ref.deref() : ref;
		if ( ! node || node.isUniformNode !== true ) continue;
		nodes.push( node );
		liveRefs.push( ref );

	}
	state.refs = liveRefs;
	return nodes;

}

export function clearLiveUniformRegistryForTests() {

	const state = registryState();
	for ( const node of listLiveUniformNodes() ) {

		try { delete node[ NODE_IDENTITY_KEY ]; } catch ( _ ) {}

	}
	state.refs = [];
	state.seen = new WeakSet();

}
