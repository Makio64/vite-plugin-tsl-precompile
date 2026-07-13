import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const THREE_CHECKOUT_VERSION_MISMATCH = 'TSLP_THREE_CHECKOUT_VERSION_MISMATCH';

export class ThreeCheckoutVersionError extends Error {

	constructor( message, options ) {

		super( message, options );
		this.name = 'ThreeCheckoutVersionError';
		this.code = THREE_CHECKOUT_VERSION_MISMATCH;

	}

}

/**
 * Read both identities exposed by a three.js source checkout. The package
 * version alone is insufficient: development checkouts can retain an older
 * package.json while src/constants.js has already advanced to the next
 * REVISION.
 */
export function readThreeCheckoutVersion( threeRepo, label = 'batch' ) {

	const constantsPath = join( threeRepo, 'src/constants.js' );
	if ( ! existsSync( constantsPath ) ) {

		throw new ThreeCheckoutVersionError( `[${ label }] cannot verify three.js revision: ${ constantsPath } not found.` );

	}

	const packagePath = join( threeRepo, 'package.json' );
	if ( ! existsSync( packagePath ) ) {

		throw new ThreeCheckoutVersionError( `[${ label }] cannot verify three.js package version: ${ packagePath } not found.` );

	}

	let constantsSource;
	try {

		constantsSource = readFileSync( constantsPath, 'utf8' );

	} catch ( cause ) {

		throw new ThreeCheckoutVersionError( `[${ label }] could not read three.js revision from ${ constantsPath }.`, { cause } );

	}

	const revisionMatch = constantsSource.match( /^\s*export\s+const\s+REVISION\s*=\s*['"](\d+)([^'"]*)['"]\s*;/m );
	if ( ! revisionMatch ) {

		throw new ThreeCheckoutVersionError( `[${ label }] could not parse REVISION from ${ constantsPath }.` );

	}

	let packageJson;
	try {

		packageJson = JSON.parse( readFileSync( packagePath, 'utf8' ) );

	} catch ( cause ) {

		throw new ThreeCheckoutVersionError( `[${ label }] could not parse three.js package metadata from ${ packagePath }.`, { cause } );

	}

	if ( ! packageJson || typeof packageJson.version !== 'string' || packageJson.version.length === 0 ) {

		throw new ThreeCheckoutVersionError( `[${ label }] three.js package metadata at ${ packagePath } has no version.` );

	}

	return {
		revision: `${ revisionMatch[ 1 ] }${ revisionMatch[ 2 ] }`,
		revisionNumber: parseInt( revisionMatch[ 1 ], 10 ),
		packageVersion: packageJson.version,
		constantsPath,
		packagePath,
	};

}

/**
 * Ensure capture/example source and compiler-free replay use the same exact
 * stable three.js release. This is deliberately a release-identity gate, not
 * a source-tree-integrity check: local modifications inside an otherwise
 * matching release remain outside the signed slim-bundle provenance domain.
 * Artifact hashes cannot make r185 WGSL/runtime topology safe to replay
 * through a bundle built from r184.
 */
export function assertThreeCheckoutMatchesVersion( threeRepo, expectedPackageVersion, label = 'batch' ) {

	const expectedMatch = typeof expectedPackageVersion === 'string'
		? expectedPackageVersion.match( /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/ )
		: null;
	if ( ! expectedMatch ) {

		throw new ThreeCheckoutVersionError( `[${ label }] signed slim bundle reports invalid three.js package version ${ JSON.stringify( expectedPackageVersion ) }; rebuild the slim bundle.` );

	}

	const checkout = readThreeCheckoutVersion( threeRepo, label );
	const expectedRevision = expectedMatch[ 1 ];
	const mismatches = [];
	if ( checkout.revision !== expectedRevision ) {

		mismatches.push( `src/constants.js reports REVISION=${ JSON.stringify( checkout.revision ) }, expected ${ JSON.stringify( expectedRevision ) }` );

	}
	if ( checkout.packageVersion !== expectedPackageVersion ) {

		mismatches.push( `package.json reports version ${ JSON.stringify( checkout.packageVersion ) }, expected ${ JSON.stringify( expectedPackageVersion ) }` );

	}
	if ( mismatches.length > 0 ) {

		throw new ThreeCheckoutVersionError(
			`[${ label }] three.js checkout ${ threeRepo } does not match the signed slim bundle (${ expectedPackageVersion }): ${ mismatches.join( '; ' ) }. ` +
			`Use the stable release checkout with REVISION=${ JSON.stringify( expectedRevision ) } and package version ${ JSON.stringify( expectedPackageVersion ) } via --three-repo=<path>, ` +
			`or build/pass a slim bundle whose signed stable release matches the checkout. Development REVISION suffixes are intentionally rejected.`,
		);

	}

	return checkout;

}

/**
 * Refuse to run any batch script against a three.js source tree that
 * identifies as anything below r184. The slim bundle, hashes, and runtime
 * are all pinned to >= r184; mixing in an older revision silently produces
 * stale captures and bogus PSNR misses.
 *
 * Reads the shared checkout descriptor above and exits non-zero with a clear
 * message if its revision is missing or below 184.
 */
export function assertThreeAtLeast184( threeRepo, label = 'batch' ) {

	let checkout;
	try {

		checkout = readThreeCheckoutVersion( threeRepo, label );

	} catch ( error ) {

		console.error( error && error.message || error );
		process.exit( 2 );

	}

	if ( checkout.revisionNumber < 184 ) {

		console.error( `[${ label }] three.js at ${ threeRepo } reports REVISION=${ JSON.stringify( checkout.revision ) } (r${ checkout.revisionNumber }); this harness requires >= r184.` );
		process.exit( 2 );

	}

	return checkout.revision;

}
