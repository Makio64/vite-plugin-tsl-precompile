import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

function argumentValue( args, prefix ) {

	const argument = args.find( ( value ) => value.startsWith( prefix ) );
	return argument ? argument.slice( prefix.length ) : '';

}

/**
 * Resolve and read one slim bundle at harness startup. Keeping the bytes with
 * the provenance makes the file validated and hashed exactly once; callers can
 * serve the same immutable bytes throughout a diagnostic run.
 */
export function loadSlimBundle( {
	defaultPath,
	args = [],
	env = process.env,
	envKeys = [ 'TSLP_E2E_SLIM_BUNDLE', 'TSLP_SLIM_BUNDLE' ],
	cwd = process.cwd(),
} ) {

	const environmentPath = envKeys
		.map( ( key ) => env[ key ] )
		.find( ( value ) => typeof value === 'string' && value.length > 0 );
	const requestedPath = argumentValue( args, '--slim-bundle=' ) ||
		environmentPath ||
		defaultPath;
	if ( ! requestedPath ) throw new TypeError( 'A default slim bundle path is required.' );

	const absolutePath = resolve( cwd, requestedPath );
	let stats;
	try {

		stats = statSync( absolutePath );

	} catch ( error ) {

		throw new Error( `Slim bundle not found: ${ absolutePath }`, { cause: error } );

	}
	if ( ! stats.isFile() ) throw new Error( `Slim bundle path is not a file: ${ absolutePath }` );

	let bytes;
	try {

		bytes = readFileSync( absolutePath );

	} catch ( error ) {

		throw new Error( `Could not read slim bundle: ${ absolutePath }`, { cause: error } );

	}

	const sha256 = createHash( 'sha256' ).update( bytes ).digest( 'hex' );
	return {
		absolutePath,
		bytes,
		sha256,
		shortSha256: sha256.slice( 0, 12 ),
	};

}

/** JSON-safe full provenance for persisted reports. */
export function slimBundleReportProvenance( bundle ) {

	return {
		absolutePath: bundle.absolutePath,
		sha256: bundle.sha256,
	};

}
