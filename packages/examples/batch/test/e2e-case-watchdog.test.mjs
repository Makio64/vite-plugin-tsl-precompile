import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
	DEFAULT_E2E_CASE_TIMEOUT_MS,
	E2E_CASE_TIMEOUT_CODE,
	isE2ECaseTimeoutError,
	runE2ECaseWithWatchdog,
} from '../e2e-case-watchdog.mjs';

test( 'the complete-case watchdog defaults to five minutes and preserves successful results', async () => {

	assert.equal( DEFAULT_E2E_CASE_TIMEOUT_MS, 300_000 );
	const result = await runE2ECaseWithWatchdog( 'healthy.html', 100, async () => ( { status: 'pass' } ) );
	assert.deepEqual( result, { status: 'pass' } );

} );

test( 'the complete-case watchdog rejects with stable fail-closed metadata', async () => {

	await assert.rejects(
		runE2ECaseWithWatchdog( 'wedged.html', 10, () => new Promise( () => {} ) ),
		( error ) => {

			assert.equal( isE2ECaseTimeoutError( error ), true );
			assert.equal( error.code, E2E_CASE_TIMEOUT_CODE );
			assert.equal( error.caseName, 'wedged.html' );
			assert.equal( error.timeoutMs, 10 );
			assert.match( error.message, /"wedged\.html".*10ms fail-closed watchdog/ );
			return true;

		},
	);

} );

test( 'the complete-case watchdog preserves ordinary run failures', async () => {

	const failure = new Error( 'renderer initialization failed' );
	await assert.rejects(
		runE2ECaseWithWatchdog( 'broken.html', 100, () => Promise.reject( failure ) ),
		( error ) => error === failure,
	);

} );

test( 'a late losing-run rejection remains observed after the watchdog fires', async () => {

	let rejectRun;
	const unhandled = [];
	const onUnhandled = ( reason ) => unhandled.push( reason );
	process.on( 'unhandledRejection', onUnhandled );
	try {

		const guarded = runE2ECaseWithWatchdog( 'late-rejection.html', 10, () => new Promise( ( _resolve, reject ) => {

			rejectRun = reject;

		} ) );
		await assert.rejects( guarded, ( error ) => error.code === E2E_CASE_TIMEOUT_CODE );
		rejectRun( new Error( 'late browser disconnect' ) );
		await new Promise( ( resolve ) => setImmediate( resolve ) );
		await new Promise( ( resolve ) => setImmediate( resolve ) );
		assert.deepEqual( unhandled, [] );

	} finally {

		process.off( 'unhandledRejection', onUnhandled );

	}

} );

test( 'the runner records and atomically persists timeout failure metadata before immediate exit', () => {

	const source = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );
	assert.match(
		source,
		/const result = await runE2ECaseWithWatchdog\( name, caseTimeoutMs, \(\) => runOne\( browser, name \) \);/,
	);
	assert.match(
		source,
		/const caseTimeoutMs = parseIntAtLeast\( getArg\( '--case-timeout-ms=', process\.env\.TSLP_E2E_CASE_TIMEOUT_MS \|\| String\( DEFAULT_E2E_CASE_TIMEOUT_MS \) \), DEFAULT_E2E_CASE_TIMEOUT_MS, 1 \);/,
	);
	const timeoutBranch = source.slice( source.indexOf( 'if ( timeoutMetadata ) {' ), source.indexOf( '\n\t\t\t}', source.indexOf( 'if ( timeoutMetadata ) {' ) ) + 5 );
	for ( const expected of [
		"report.status = 'failed';",
		'report.completedAt = timeoutMetadata.completedAt;',
		'report.timeout = timeoutMetadata;',
		'writeReport();',
		'process.exit( 1 );',
	] ) assert.ok( timeoutBranch.includes( expected ), `timeout branch must contain ${ expected }` );
	assert.ok( timeoutBranch.indexOf( 'writeReport();' ) < timeoutBranch.indexOf( 'process.exit( 1 );' ) );
	const configuration = source.slice(
		source.indexOf( 'const configuration = {' ),
		source.indexOf( 'configuration.fingerprint = fingerprintJson( configuration );' ),
	);
	assert.match( configuration, /\bcaseTimeoutMs,/ );

} );
