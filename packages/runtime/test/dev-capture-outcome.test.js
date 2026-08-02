import assert from 'node:assert/strict';
import test from 'node:test';

import {
	getDevCaptureStatus,
	recordDevCaptureOutcome,
	recordDevCaptureResults,
	waitForDevCaptureSettled,
} from '../src/dev-capture-outcome.js';

test( 'dev capture outcome hook is inert unless the recapture observer is installed', () => {

	const previous = globalThis.__tslpRecaptureActivity;
	try {

		delete globalThis.__tslpRecaptureActivity;
		assert.doesNotThrow( () => recordDevCaptureOutcome( true ) );
		globalThis.__tslpRecaptureActivity = { acceptedPosts: 0, failedCaptures: 0, failures: [] };
		recordDevCaptureOutcome( true );
		recordDevCaptureOutcome( false, { shape: 'post-process', error: 'pipeline capture failed' } );
		recordDevCaptureResults( [ { ok: true }, {
			ok: false,
			shape: 'pmrem',
			profile: 'texture-cubemap',
			configHash: 'abc123',
			error: 'cube sampling mismatch',
		} ] );
		assert.deepEqual( globalThis.__tslpRecaptureActivity, {
			acceptedPosts: 2,
			failedCaptures: 2,
			failures: [
				{
					code: 'CAPTURE_FAILED',
					shape: 'post-process',
					error: 'pipeline capture failed',
					message: 'pipeline capture failed',
					profile: null,
					configHash: null,
				},
				{
					code: 'CAPTURE_FAILED',
					shape: 'pmrem',
					error: 'cube sampling mismatch',
					message: 'cube sampling mismatch',
					profile: 'texture-cubemap',
					configHash: 'abc123',
				},
			],
		} );
		const status = getDevCaptureStatus();
		assert.deepEqual( status.failures.slice( - 2 ), globalThis.__tslpRecaptureActivity.failures );
		assert.equal( Object.isFrozen( status.failures ), true );
		assert.equal( Object.isFrozen( status.failures.at( - 1 ) ), true );

	} finally {

		if ( previous === undefined ) delete globalThis.__tslpRecaptureActivity;
		else globalThis.__tslpRecaptureActivity = previous;

	}

} );

test( 'dev capture diagnostics retain only the latest twenty failures', () => {

	const previous = globalThis.__tslpRecaptureActivity;
	try {

		globalThis.__tslpRecaptureActivity = { acceptedPosts: 0, failedCaptures: 0, failures: [] };
		for ( let index = 0; index < 25; index ++ ) {

			recordDevCaptureOutcome( false, { shape: `failure-${ index }`, error: `error-${ index }` } );

		}
		assert.equal( globalThis.__tslpRecaptureActivity.failures.length, 20 );
		assert.equal( globalThis.__tslpRecaptureActivity.failures[ 0 ].shape, 'failure-5' );
		assert.equal( globalThis.__tslpRecaptureActivity.failures.at( - 1 ).shape, 'failure-24' );
		assert.equal( getDevCaptureStatus().failures.length, 20 );

	} finally {

		if ( previous === undefined ) delete globalThis.__tslpRecaptureActivity;
		else globalThis.__tslpRecaptureActivity = previous;

	}

} );

test( 'capture settlement waits for a new accepted outcome and a zero pending count', async () => {

	const baseline = getDevCaptureStatus();
	const previousPending = globalThis.__tslpPrecompilePending;
	try {

		globalThis.__tslpPrecompilePending = 1;
		const waiting = waitForDevCaptureSettled( {
			since: baseline,
			timeoutMs: 1_000,
			settleMs: 5,
		} );
		await Promise.resolve();
		recordDevCaptureOutcome( true );
		globalThis.__tslpPrecompilePending = 0;

		const settled = await waiting;
		assert.equal( settled.pending, 0 );
		assert.equal( settled.acceptedCaptures, baseline.acceptedCaptures + 1 );
		assert.equal( settled.failedCaptures, baseline.failedCaptures );

	} finally {

		if ( previousPending === undefined ) delete globalThis.__tslpPrecompilePending;
		else globalThis.__tslpPrecompilePending = previousPending;

	}

} );

test( 'capture settlement reports failed capture waves', async () => {

	const baseline = getDevCaptureStatus();
	recordDevCaptureOutcome( false );
	await assert.rejects(
		waitForDevCaptureSettled( {
			since: baseline,
			timeoutMs: 1_000,
			settleMs: 0,
		} ),
		/1 development capture operation failed/,
	);
	const status = await waitForDevCaptureSettled( {
		since: baseline,
		timeoutMs: 1_000,
		settleMs: 0,
		rejectOnFailure: false,
	} );
	assert.equal( status.failedCaptures, baseline.failedCaptures + 1 );

} );

test( 'capture settlement can explicitly allow an empty route', async () => {

	const status = await waitForDevCaptureSettled( {
		since: getDevCaptureStatus(),
		timeoutMs: 1_000,
		settleMs: 0,
		allowEmpty: true,
	} );
	assert.equal( status.pending, 0 );

} );

test( 'capture settlement uses the harness real clock when application time is frozen', async () => {

	const originalDateNow = Date.now;
	const previousRealNow = globalThis.__tslpRealNow;
	let realNow = 0;
	try {

		Date.now = () => 1_000;
		globalThis.__tslpRealNow = () => {

			realNow += 10;
			return realNow;

		};
		const settled = await Promise.race( [
			waitForDevCaptureSettled( {
				since: getDevCaptureStatus(),
				timeoutMs: 100,
				settleMs: 20,
				allowEmpty: true,
			} ),
			new Promise( ( _, reject ) => setTimeout( () => reject( new Error( 'capture settlement ignored __tslpRealNow' ) ), 250 ) ),
		] );
		assert.equal( settled.pending, 0 );
		assert.ok( realNow >= 30 );

	} finally {

		Date.now = originalDateNow;
		if ( previousRealNow === undefined ) delete globalThis.__tslpRealNow;
		else globalThis.__tslpRealNow = previousRealNow;

	}

} );
