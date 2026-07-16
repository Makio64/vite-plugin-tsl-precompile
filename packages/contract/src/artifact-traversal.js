/**
 * Visit every artifact payload represented by a generated module root.
 *
 * Generated modules can expose one artifact, an array of auxiliary entries,
 * or wrappers with an `artifact` property. Variant families and material
 * compute kernels are artifact payloads too, so sidecar materializers share
 * this traversal instead of maintaining package-local shape guesses.
 *
 * @param {*} value
 * @param {(artifact: Object) => void} visitor
 * @return {*}
 */
export function forEachArtifactPayload( value, visitor ) {

	if ( typeof visitor !== 'function' ) throw new TypeError( 'forEachArtifactPayload: visitor must be a function' );
	const seenArtifacts = new WeakSet();
	const seenRoots = new WeakSet();
	const visitArtifact = ( artifact ) => {

		if ( ! artifact || typeof artifact !== 'object' || seenArtifacts.has( artifact ) ) return;
		seenArtifacts.add( artifact );
		visitor( artifact );
		for ( const variant of Object.values( artifact.variants || {} ) ) visitArtifact( variant );
		for ( const kernel of artifact.materialCompute && Array.isArray( artifact.materialCompute.kernels )
			? artifact.materialCompute.kernels
			: [] ) visitArtifact( kernel && kernel.artifact );

	};
	const visitRoot = ( root ) => {

		if ( Array.isArray( root ) ) {

			for ( const entry of root ) visitRoot( entry );
			return;

		}
		if ( ! root || typeof root !== 'object' || seenRoots.has( root ) ) return;
		seenRoots.add( root );
		visitArtifact( root.artifact && typeof root.artifact === 'object' ? root.artifact : root );

	};
	visitRoot( value );
	return value;

}
