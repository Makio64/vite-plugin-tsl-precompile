/**
 * Explicit live-graph dependencies for nodes whose inputs are closure-hidden.
 *
 * Reflective graph walking cannot see values retained only by functions such
 * as builtinAOContext()/builtinShadowContext(). These Symbol sidecars remain
 * non-serializable by design: they reconnect live effect discovery during
 * capture/replay without pretending to be artifact GPU bindings.
 */

const DEPENDENCIES = Symbol.for( '@tsl-precompile/runtime/live-node-dependencies@1' );

export function attachLiveNodeDependency( owner, dependency, metadata = null ) {

	if ( ! owner || ( typeof owner !== 'object' && typeof owner !== 'function' ) ) return owner;
	if ( ! dependency || ( typeof dependency !== 'object' && typeof dependency !== 'function' ) ) return owner;
	let entries = null;
	try { entries = owner[ DEPENDENCIES ]; } catch ( _ ) { return owner; }
	if ( ! Array.isArray( entries ) ) {

		entries = [];
		try {

			Object.defineProperty( owner, DEPENDENCIES, {
				value: entries,
				configurable: true,
			} );

		} catch ( _ ) { return owner; }

	}
	const existing = entries.find( ( entry ) => entry.node === dependency );
	if ( existing ) {

		if ( metadata !== null && metadata !== undefined ) existing.metadata = metadata;
		return owner;

	}
	entries.push( { node: dependency, metadata } );
	return owner;

}

export function getLiveNodeDependencies( owner ) {

	let entries = null;
	try { entries = owner && owner[ DEPENDENCIES ]; } catch ( _ ) { return []; }
	if ( ! Array.isArray( entries ) ) return [];
	return entries.filter( ( entry ) => entry && entry.node ).map( ( entry ) => ( {
		node: entry.node,
		metadata: entry.metadata === undefined ? null : entry.metadata,
	} ) );

}
