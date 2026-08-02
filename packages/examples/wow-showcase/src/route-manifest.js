export const SHOWCASE_ROUTE_IDS = Object.freeze( [
	'race',
	'tool',
	'women',
	'robots',
	'abyss',
	'orbit',
	'pulse',
	'climate',
	'fashion',
	'architecture',
] );

function canonicalRouteId( value ) {

	return typeof value === 'string' &&
		/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test( value );

}

export function assertExactShowcaseRouteIds( actualIds, label = 'Showcase routes' ) {

	if ( ! Array.isArray( actualIds ) || actualIds.length === 0 ) {

		throw new Error( `${ label } must be a non-empty route array.` );

	}
	if ( actualIds.some( id => ! canonicalRouteId( id ) ) ) {

		throw new Error( `${ label } contains a non-canonical route identifier.` );

	}
	if ( new Set( actualIds ).size !== actualIds.length ) {

		throw new Error( `${ label } contains duplicate route identifiers.` );

	}
	if (
		actualIds.length !== SHOWCASE_ROUTE_IDS.length ||
		actualIds.some( ( id, index ) => id !== SHOWCASE_ROUTE_IDS[ index ] )
	) {

		throw new Error(
			`${ label } must exactly match the shared showcase route manifest: ` +
			SHOWCASE_ROUTE_IDS.join( ', ' ),
		);

	}
	return actualIds;

}

export function createShowcaseRouteRecord( valueForRoute, label = 'Showcase route record' ) {

	if ( typeof valueForRoute !== 'function' ) throw new TypeError( `${ label } requires a value factory.` );
	const record = Object.fromEntries(
		SHOWCASE_ROUTE_IDS.map( id => [ id, valueForRoute( id ) ] ),
	);
	assertExactShowcaseRouteIds( Object.keys( record ), label );
	return Object.freeze( record );

}

assertExactShowcaseRouteIds( [ ...SHOWCASE_ROUTE_IDS ], 'Shared showcase route manifest' );
