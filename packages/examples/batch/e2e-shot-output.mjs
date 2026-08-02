import { lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { assertSafeContainedPath, describeEvidenceBytes } from './e2e-evidence.mjs';

function nearestExistingAncestor( file ) {

	let current = resolve( file );
	while ( true ) {

		try {

			lstatSync( current );
			return current;

		} catch ( error ) {

			if ( error?.code !== 'ENOENT' ) throw error;
			const parent = dirname( current );
			if ( parent === current ) return current;
			current = parent;

		}

	}

}

function assertFutureEvidenceFile( outputRoot, file ) {

	const root = resolve( outputRoot );
	const absolute = resolve( file );
	const rel = relative( root, absolute );
	if ( ! rel || rel === '..' || rel.startsWith( `..${ sep }` ) || isAbsolute( rel ) ) {

		throw new Error( `Evidence shot target ${ absolute } escapes its output root ${ root }.` );

	}

}

/**
 * Replace the current capture/replay evidence as one generation.
 *
 * Both old paths are removed before either new image is written. A missing or
 * failed pass therefore leaves an incomplete pair instead of comparing a new
 * image with its stale counterpart from an earlier run.
 */
export function writeCurrentShotPair( {
	outputRoot,
	runId,
	shotsDir,
	stem,
	captureShot,
	replayShot,
} ) {

	if ( typeof stem !== 'string' || ! /^[A-Za-z0-9_.-]+$/.test( stem ) ) {

		throw new Error( `Invalid evidence shot stem ${ JSON.stringify( stem ) }.` );

	}
	const capturePath = join( shotsDir, `${ stem }.capture.png` );
	const replayPath = join( shotsDir, `${ stem }.replay.png` );
	assertFutureEvidenceFile( outputRoot, capturePath );
	assertFutureEvidenceFile( outputRoot, replayPath );
	assertSafeContainedPath( outputRoot, nearestExistingAncestor( shotsDir ), {
		allowRoot: true,
		kind: 'directory',
		label: 'Evidence shot directory ancestor',
	} );
	mkdirSync( shotsDir, { recursive: true } );
	assertSafeContainedPath( outputRoot, shotsDir, {
		allowRoot: true,
		kind: 'directory',
		label: 'Evidence shot directory',
	} );
	rmSync( capturePath, { force: true } );
	rmSync( replayPath, { force: true } );
	if ( captureShot ) writeFileSync( capturePath, captureShot );
	if ( replayShot ) writeFileSync( replayPath, replayShot );
	return {
		capturePath,
		replayPath,
		capture: captureShot ? describeEvidenceBytes( {
			outputRoot,
			file: capturePath,
			bytes: captureShot,
			runId,
		} ) : null,
		replay: replayShot ? describeEvidenceBytes( {
			outputRoot,
			file: replayPath,
			bytes: replayShot,
			runId,
		} ) : null,
	};

}
