import { lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
	basename,
	dirname,
	isAbsolute,
	resolve,
} from 'node:path';

export const OCEAN_DIAGNOSTIC_ARTIFACTS_DIR_ENV = 'TSLP_OCEAN_DIAGNOSTIC_ARTIFACTS_DIR';
const DIAGNOSTIC_ROOT_NAME = /^tslp-(?:inspector-smoke|capture-replay)-[A-Za-z0-9]{6}$/;

/**
 * Keep the normal example output stable while allowing the browser diagnostics
 * to capture into an isolated temporary directory.
 */
export function oceanArtifactsDir( env = process.env ) {

	const override = env && env[ OCEAN_DIAGNOSTIC_ARTIFACTS_DIR_ENV ];
	if ( override === undefined ) return './artifacts';
	if (
		typeof override !== 'string'
		|| override.length === 0
		|| override.includes( '\0' )
		|| ! isAbsolute( override )
	) {

		throw invalidOverride();

	}
	const absolute = resolve( override );
	let physical;
	let stat;
	try {

		physical = realpathSync( absolute );
		stat = lstatSync( absolute );

	} catch {

		throw invalidOverride();

	}
	const physicalTemporaryRoot = realpathSync( tmpdir() );
	const parent = dirname( physical );
	if (
		absolute !== physical
		|| stat.isSymbolicLink()
		|| ! stat.isDirectory()
		|| basename( physical ) !== 'artifacts'
		|| dirname( parent ) !== physicalTemporaryRoot
		|| ! DIAGNOSTIC_ROOT_NAME.test( basename( parent ) )
	) {

		throw invalidOverride();

	}
	return physical;

}

function invalidOverride() {

	return new Error(
		`${ OCEAN_DIAGNOSTIC_ARTIFACTS_DIR_ENV } must name the real artifacts directory inside an isolated ocean diagnostic temporary root.`,
	);

}
