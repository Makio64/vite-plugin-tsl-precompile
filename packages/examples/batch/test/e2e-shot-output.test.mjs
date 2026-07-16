import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { writeCurrentShotPair } from '../e2e-shot-output.mjs';

test( 'current screenshot evidence never mixes generations', async ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-e2e-shots-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	const cases = [
		{ name: 'capture-only', captureShot: Buffer.from( 'new-capture' ), replayShot: null },
		{ name: 'replay-only', captureShot: null, replayShot: Buffer.from( 'new-replay' ) },
		{ name: 'missing-pair', captureShot: null, replayShot: null },
		{ name: 'complete-pair', captureShot: Buffer.from( 'new-capture' ), replayShot: Buffer.from( 'new-replay' ) },
	];
	for ( const current of cases ) await t.test( current.name, () => {

		const shotsDir = join( root, current.name );
		const stem = 'example';
		const capturePath = join( shotsDir, `${ stem }.capture.png` );
		const replayPath = join( shotsDir, `${ stem }.replay.png` );
		writeCurrentShotPair( {
			shotsDir,
			stem,
			captureShot: Buffer.from( 'old-capture' ),
			replayShot: Buffer.from( 'old-replay' ),
		} );
		writeCurrentShotPair( { shotsDir, stem, ...current } );

		assert.equal( existsSync( capturePath ), !! current.captureShot );
		assert.equal( existsSync( replayPath ), !! current.replayShot );
		if ( current.captureShot ) assert.deepEqual( readFileSync( capturePath ), current.captureShot );
		if ( current.replayShot ) assert.deepEqual( readFileSync( replayPath ), current.replayShot );

	} );

} );
