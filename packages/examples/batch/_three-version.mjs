import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Refuse to run any batch script against a three.js source tree that
 * identifies as anything below r184. The slim bundle, hashes, and runtime
 * are all pinned to >= r184; mixing in an older revision silently produces
 * stale captures and bogus PSNR misses.
 *
 * Reads `<threeRepo>/src/constants.js`, parses `REVISION = '<digits>...'`,
 * and exits non-zero with a clear message if missing or below 184.
 */
export function assertThreeAtLeast184( threeRepo, label = 'batch' ) {

	const constantsPath = join( threeRepo, 'src/constants.js' );
	if ( ! existsSync( constantsPath ) ) {

		console.error( `[${ label }] cannot verify three.js revision: ${ constantsPath } not found.` );
		process.exit( 2 );

	}

	const src = readFileSync( constantsPath, 'utf8' );
	const m = src.match( /REVISION\s*=\s*['"](\d+)([^'"]*)['"]/ );
	if ( ! m ) {

		console.error( `[${ label }] could not parse REVISION from ${ constantsPath }.` );
		process.exit( 2 );

	}

	const major = parseInt( m[ 1 ], 10 );
	if ( major < 184 ) {

		console.error( `[${ label }] three.js at ${ threeRepo } reports REVISION='${ m[ 1 ] }${ m[ 2 ] }' (r${ major }); this harness requires >= r184.` );
		process.exit( 2 );

	}

	return `${ m[ 1 ] }${ m[ 2 ] }`;

}
