/**
 * Strip any non-digit suffix from a three.js REVISION string so that
 * fork builds (e.g. `'184dev'`) hash identically to released bundles
 * (e.g. `'184'`). Throws if the input doesn't begin with at least one
 * digit — the test harness pins to >= r184, so a missing or non-numeric
 * REVISION must fail loud rather than silently mismatch.
 *
 * Mirrors `packages/plugin/src/_shared/normalize-revision.js` — the runtime
 * is published independently and must not import from the plugin package.
 */
export function normalizeRevision( rev ) {

	if ( rev === null || rev === undefined ) {

		throw new Error( 'normalizeRevision: REVISION is required (>= 184)' );

	}
	const str = String( rev );
	const m = str.match( /^(\d+)/ );
	if ( ! m ) {

		throw new Error( `normalizeRevision: REVISION ${ JSON.stringify( str ) } has no numeric prefix` );

	}
	const major = parseInt( m[ 1 ], 10 );
	if ( major < 184 ) {

		throw new Error( `normalizeRevision: three.js r${ major } is below the supported minimum (>= r184)` );

	}
	return m[ 1 ];

}
