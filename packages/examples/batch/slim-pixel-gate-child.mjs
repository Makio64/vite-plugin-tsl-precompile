import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

function outputTail( value, lineCount ) {

	return String( value || '' )
		.split( '\n' )
		.filter( Boolean )
		.slice( -lineCount )
		.join( ' | ' );

}

function isPathWithin( root, candidate ) {

	const pathFromRoot = relative( root, candidate );
	return pathFromRoot === '' || (
		pathFromRoot !== '..' &&
		! pathFromRoot.startsWith( '../' ) &&
		! pathFromRoot.startsWith( '..\\' ) &&
		! isAbsolute( pathFromRoot )
	);

}

/**
 * Create a new output root for one slim pixel-gate invocation.
 *
 * The caller may choose a parent directory, but never the final run directory:
 * mkdtempSync makes every invocation empty and unguessable. This prevents a
 * successful report from an earlier diagnostic from becoming the current
 * child's report.
 */
export function createSlimPixelGateRunRoot( {
	baseRoot = tmpdir(),
	canonicalRoot = null,
} = {} ) {

	mkdirSync( baseRoot, { recursive: true } );
	const canonicalBase = realpathSync( baseRoot );
	if ( canonicalRoot ) {

		mkdirSync( canonicalRoot, { recursive: true } );
		const canonicalEvidenceRoot = realpathSync( canonicalRoot );
		if ( isPathWithin( canonicalEvidenceRoot, canonicalBase ) ) {

			throw new Error(
				`pixel-gate output parent ${ canonicalBase } is inside the canonical results root ${ canonicalEvidenceRoot }; ` +
				'use a separate diagnostic directory',
			);

		}

	}
	return mkdtempSync( join( canonicalBase, 'tslp-slim-pixel-gate-' ) );

}

/**
 * Spawn one run-e2e child and read its report only after an unambiguous
 * successful exit. spawnSync communicates launch errors and signal deaths on
 * the result object, so all three failure planes must be checked before any
 * report I/O.
 */
export function runSlimPixelGateChild( {
	executable = process.execPath,
	args,
	reportPath,
	spawn = spawnSync,
	readReport = readFileSync,
} ) {

	let child;
	try {

		child = spawn( executable, args, {
			stdio: [ 'ignore', 'pipe', 'pipe' ],
			encoding: 'utf8',
		} );

	} catch ( error ) {

		throw new Error( `run-e2e child could not be spawned: ${ error && error.message || error }`, { cause: error } );

	}

	const stdoutTail = outputTail( child && child.stdout, 3 );
	const stderrTail = outputTail( child && child.stderr, 2 );
	const diagnosticTail = stderrTail || stdoutTail;
	if ( ! child || typeof child !== 'object' ) {

		throw new Error( 'run-e2e child returned no process result' );

	}
	if ( child.error ) {

		throw new Error(
			`run-e2e child failed to start: ${ child.error.message || child.error }${ diagnosticTail ? `; ${ diagnosticTail }` : '' }`,
			{ cause: child.error },
		);

	}
	if ( child.signal ) {

		throw new Error( `run-e2e child was terminated by ${ child.signal }${ diagnosticTail ? `; ${ diagnosticTail }` : '' }` );

	}
	if ( child.status !== 0 ) {

		const status = Number.isInteger( child.status ) ? child.status : 'without an exit status';
		throw new Error( `run-e2e child exited with status ${ status }${ diagnosticTail ? `; ${ diagnosticTail }` : '' }` );

	}

	let report;
	try {

		report = JSON.parse( readReport( reportPath, 'utf8' ) );

	} catch ( error ) {

		throw new Error( `run-e2e child exited successfully but its report could not be read from ${ reportPath }: ${ error.message }`, { cause: error } );

	}
	return { report, stdoutTail, stderrTail };

}
