/**
 * Deterministic JSON encoding for small contract descriptors. Object keys are
 * sorted recursively; cycles and unsupported runtime values are rejected so
 * persisted selectors cannot depend on process identity.
 *
 * @param {*} value
 * @param {string} [label]
 * @return {string}
 */
export function stableJsonStringify( value, label = 'value' ) {

	return JSON.stringify( stableJsonValue( value, new Set(), label ) );

}

function stableJsonValue( value, seen, path ) {

	if ( value === null || typeof value === 'string' || typeof value === 'boolean' ) return value;
	if ( typeof value === 'number' ) {

		if ( ! Number.isFinite( value ) ) throw new TypeError( `${ path } contains a non-finite number` );
		return Object.is( value, - 0 ) ? 0 : value;

	}
	if ( value === undefined ) return null;
	if ( typeof value !== 'object' ) throw new TypeError( `${ path } contains unsupported ${ typeof value } data` );
	if ( seen.has( value ) ) throw new TypeError( `${ path } contains a cycle` );
	seen.add( value );

	let normalized;
	if ( Array.isArray( value ) ) {

		normalized = value.map( ( item, index ) => stableJsonValue( item, seen, `${ path }[${ index }]` ) );

	} else {

		normalized = {};
		for ( const key of Object.keys( value ).sort() ) {

			const item = value[ key ];
			if ( item === undefined ) continue;
			normalized[ key ] = stableJsonValue( item, seen, `${ path }.${ key }` );

		}

	}
	seen.delete( value );
	return normalized;

}
