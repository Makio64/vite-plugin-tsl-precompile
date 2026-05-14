#!/usr/bin/env node
/**
 * Vendor import probe — `pnpm vendor:probe`.
 *
 * The vendored extractor/compileTSL files import from `three` and `three/tsl`
 * surface paths that the upstream package has reorganised in the past. If
 * a future three.js release moves or renames one of those exports, the
 * import fails at load time and the slim bundle silently mis-extracts.
 * This probe imports each vendored module from Node and asserts they
 * resolve cleanly. CI runs it on locked + latest three.js so a routine
 * three.js bump surfaces vendor drift before it reaches the slim build.
 *
 * Pairs with `.github/workflows/three-compat.yml`.
 */

const VENDOR_MODULES = [
	'../src/vendor/compileTSL.js',
	'../src/vendor/extractUniformPlan.js',
];

const failures = [];

for ( const specifier of VENDOR_MODULES ) {

	try {

		await import( specifier );
		// eslint-disable-next-line no-console
		console.log( `[vendor-probe] ok: ${ specifier }` );

	} catch ( err ) {

		failures.push( { specifier, message: err && err.message || String( err ) } );

	}

}

// Independently probe the `three/tsl` surface the extractor uses — even if
// the vendor file's top-level imports succeed, this re-asserts the specific
// named exports the extractor depends on, so a partial rename of just the
// missing export still fails the probe (instead of throwing at runtime when
// the extractor actually walks a node graph).
try {

	const tsl = await import( 'three/tsl' );
	const REQUIRED_TSL_EXPORTS = [
		'modelNormalMatrix',
		'modelWorldMatrixInverse',
		'time',
		'deltaTime',
		'frameId',
		'backgroundBlurriness',
		'backgroundIntensity',
		'backgroundRotation',
		'toneMappingExposure',
		'lightPosition',
		'lightTargetPosition',
		'lightViewPosition',
		'lightShadowMatrix',
	];
	const missing = REQUIRED_TSL_EXPORTS.filter( ( name ) => tsl[ name ] === undefined );
	if ( missing.length > 0 ) {

		failures.push( {
			specifier: 'three/tsl',
			message: `missing required exports: ${ missing.join( ', ' ) }`,
		} );

	} else {

		// eslint-disable-next-line no-console
		console.log( `[vendor-probe] ok: three/tsl (${ REQUIRED_TSL_EXPORTS.length } named exports present)` );

	}

} catch ( err ) {

	failures.push( { specifier: 'three/tsl', message: err && err.message || String( err ) } );

}

if ( failures.length > 0 ) {

	// eslint-disable-next-line no-console
	console.error( `[vendor-probe] ${ failures.length } failure(s):` );
	for ( const f of failures ) {

		// eslint-disable-next-line no-console
		console.error( `  - ${ f.specifier }: ${ f.message }` );

	}
	process.exit( 1 );

}

// eslint-disable-next-line no-console
console.log( '[vendor-probe] all vendor surfaces resolved cleanly.' );
