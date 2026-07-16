import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Replace the current capture/replay evidence as one generation.
 *
 * Both old paths are removed before either new image is written. A missing or
 * failed pass therefore leaves an incomplete pair instead of comparing a new
 * image with its stale counterpart from an earlier run.
 */
export function writeCurrentShotPair( { shotsDir, stem, captureShot, replayShot } ) {

	mkdirSync( shotsDir, { recursive: true } );
	const capturePath = join( shotsDir, `${ stem }.capture.png` );
	const replayPath = join( shotsDir, `${ stem }.replay.png` );
	rmSync( capturePath, { force: true } );
	rmSync( replayPath, { force: true } );
	if ( captureShot ) writeFileSync( capturePath, captureShot );
	if ( replayShot ) writeFileSync( replayPath, replayShot );
	return { capturePath, replayPath };

}
