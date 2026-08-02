import assert from 'node:assert/strict';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
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
			outputRoot: root,
			runId: 'old-run',
			shotsDir,
			stem,
			captureShot: Buffer.from( 'old-capture' ),
			replayShot: Buffer.from( 'old-replay' ),
		} );
		const written = writeCurrentShotPair( {
			outputRoot: root,
			runId: current.name,
			shotsDir,
			stem,
			...current,
		} );

		assert.equal( existsSync( capturePath ), !! current.captureShot );
		assert.equal( existsSync( replayPath ), !! current.replayShot );
		if ( current.captureShot ) {
			assert.deepEqual( readFileSync( capturePath ), current.captureShot );
			assert.equal( written.capture.runId, current.name );
			assert.match( written.capture.sha256, /^[a-f0-9]{64}$/ );
			assert.equal( written.capture.bytes, current.captureShot.length );
		} else {
			assert.equal( written.capture, null );
		}
		if ( current.replayShot ) {
			assert.deepEqual( readFileSync( replayPath ), current.replayShot );
			assert.equal( written.replay.runId, current.name );
			assert.match( written.replay.sha256, /^[a-f0-9]{64}$/ );
			assert.equal( written.replay.bytes, current.replayShot.length );
		} else {
			assert.equal( written.replay, null );
		}

	} );

} );

test( 'shot output rejects a symlinked directory before mutating its target', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-e2e-shot-symlink-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const root = join( scratch, 'root' );
	const outside = join( scratch, 'outside' );
	const shotsDir = join( root, 'shots' );
	const outsideCapture = join( outside, 'example.capture.png' );
	mkdirSync( root );
	mkdirSync( outside );
	writeFileSync( outsideCapture, 'preserve-me' );
	symlinkSync( outside, shotsDir, 'dir' );

	assert.throws(
		() => writeCurrentShotPair( {
			outputRoot: root,
			runId: 'run-symlink',
			shotsDir,
			stem: 'example',
			captureShot: Buffer.from( 'replacement' ),
			replayShot: null,
		} ),
		/symbolic link/,
	);
	assert.equal( readFileSync( outsideCapture, 'utf8' ), 'preserve-me' );

} );

test( 'shot output rejects a traversal stem before mutating outside its root', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-e2e-shot-traversal-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const root = join( scratch, 'root' );
	const outsideCapture = join( scratch, 'escaped.capture.png' );
	mkdirSync( root );
	writeFileSync( outsideCapture, 'preserve-me' );

	assert.throws(
		() => writeCurrentShotPair( {
			outputRoot: root,
			runId: 'run-traversal',
			shotsDir: join( root, 'shots' ),
			stem: '../../escaped',
			captureShot: Buffer.from( 'replacement' ),
			replayShot: null,
		} ),
		/Invalid evidence shot stem/,
	);
	assert.equal( readFileSync( outsideCapture, 'utf8' ), 'preserve-me' );

} );
