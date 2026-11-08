/** Emit immutable JSON expressions for updater-owned binding descriptors. */
export function frozenJsonLiteral( value ) {

	if ( Array.isArray( value ) ) return `Object.freeze([${ value.map( frozenJsonLiteral ).join( ',' ) }])`;
	if ( value && typeof value === 'object' ) return `Object.freeze({${ Object.entries( value ).map( ( [ key, item ] ) => `${ JSON.stringify( key ) }:${ frozenJsonLiteral( item ) }` ).join( ',' ) }})`;
	return JSON.stringify( value );

}
