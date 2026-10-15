import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { installBrowserFailureCollector } from '../../browser-failure-policy.mjs';
import { firstFatalPageErrorMessage, installE2EFatalPageErrorGuard, isE2EFatalPageError } from '../e2e-fatal-page-error.mjs';

const delay = ms => new Promise( resolve => setTimeout( resolve, ms ) );

test( 'failed row names the first original fatal page error before generic empty-frame diagnostics', () => {

	const visits = [
		{ phase: 'stock', visit: { errors: [ 'pageerror: expected source fixture' ], timings: { freezeCompleted: true } } },
		{ phase: 'replay', visit: { errors: [ 'network evidence: request incomplete', 'pageerror: Cannot read properties of null' ], timings: { fatalPageError: true } } },
	];
	assert.equal( firstFatalPageErrorMessage( visits ), 'replay pageerror: Cannot read properties of null' );
	visits.push( { phase: 'later', visit: { errors: [ 'pageerror: later exception' ], timings: { fatalPageError: true } } } );
	assert.equal( firstFatalPageErrorMessage( visits ), 'replay pageerror: Cannot read properties of null' );
	assert.equal( firstFatalPageErrorMessage( [ visits[ 0 ] ] ), null );
	assert.equal( firstFatalPageErrorMessage( [ { phase: 'replay', visit: { errors: [], timings: { fatalPageError: true } } } ] ), null );

} );

test( 'a fatal page error ends an unresolved freeze wait immediately and retains semantic failure evidence', async () => {

	const page = new EventEmitter();
	const failures = installBrowserFailureCollector( page, { pageUrl: 'http://localhost/example.html' } );
	const guard = installE2EFatalPageErrorGuard( page );
	const started = performance.now();
	let freezeTimedOut = false;
	let drained = false;
	try {

		const freeze = guard.run( () => new Promise( () => {} ) );
		page.emit( 'pageerror', new TypeError( 'textureNode.isSampleCompare is not a function' ) );
		await assert.rejects( freeze, error => {

			assert.ok( isE2EFatalPageError( error ) );
			assert.match( error.message, /textureNode\.isSampleCompare/ );
			return true;

		} );
		assert.ok( performance.now() - started < 500, 'does not wait for the 45-second freeze deadline' );
		await assert.rejects( guard.run( () => { throw new Error( 'must not start another readiness wait' ); } ), isE2EFatalPageError );
		drained = true;
		assert.deepEqual( failures.messages(), [ 'pageerror: textureNode.isSampleCompare is not a function' ] );

	} catch ( error ) {

		if ( ! isE2EFatalPageError( error ) ) freezeTimedOut = true;
		throw error;

	} finally {

		guard.dispose();
		failures.dispose();

	}
	assert.equal( freezeTimedOut, false );
	assert.equal( drained, true );
	assert.equal( page.listenerCount( 'pageerror' ), 0 );

} );

test( 'healthy loaders retain their readiness window and expected page errors or warnings do not abort it', async () => {

	const page = new EventEmitter();
	const guard = installE2EFatalPageErrorGuard( page, { expectedPatterns: [ /^pageerror: expected fixture error$/g ] } );
	try {

		const started = performance.now();
		const pending = guard.run( async () => { await delay( 25 ); return 'loaded'; } );
		page.emit( 'console', { type: () => 'warning', text: () => '[tsl-precompile] recoverable texture warning' } );
		page.emit( 'pageerror', new Error( 'expected fixture error' ) );
		page.emit( 'pageerror', new Error( 'expected fixture error' ) );
		assert.equal( await pending, 'loaded' );
		assert.ok( performance.now() - started >= 15 );
		assert.equal( await guard.run( () => 'frozen' ), 'frozen' );

	} finally {

		guard.dispose();

	}

} );

test( 'a losing readiness operation can reject during cleanup without an unhandled rejection', async () => {

	const page = new EventEmitter();
	const guard = installE2EFatalPageErrorGuard( page );
	let rejectWait;
	const operation = new Promise( ( _resolve, reject ) => { rejectWait = reject; } );
	const pending = guard.run( () => operation );
	page.emit( 'pageerror', new Error( 'fatal render error' ) );
	await assert.rejects( pending, isE2EFatalPageError );
	rejectWait( new Error( 'page closed during waiter cleanup' ) );
	await delay( 0 );
	guard.dispose();
	assert.equal( page.listenerCount( 'pageerror' ), 0 );

} );

test( 'visit integrates fatal waits while retaining GPU/network diagnostics and the case cleanup owner', () => {

	const source = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );
	assert.match( source, /fatalPageErrors\.run\( \(\) => page\.goto/ );
	assert.match( source, /waitForFrame\( page,[^\n]+fatalPageErrors, minimumAnimationLoopOwners === 1 \)/ );
	assert.match( source, /if \( singleAnimationOwner && await fatalPageErrors\.run\( \(\) => page\.evaluate\( waitForFrozenWebGPUFrame/ );
	assert.match( source, /settleAssets\( page, ASSET_SETTLE_MS, fatalPageErrors \)/ );
	const freeze = source.slice( source.indexOf( '// Wait until the init-script rAF wrapper reaches TARGET_TICK' ), source.indexOf( "trace( `canvas-backends-collected" ) );
	assert.match( freeze, /fatalPageErrors\.run\( \(\) => page\.waitForFunction/ );
	assert.match( freeze, /if \( isE2EFatalPageError\( error \) \) throw error;/ );
	const failure = source.slice( source.indexOf( 'const fatalPageError = isE2EFatalPageError( err );' ), source.indexOf( 'function pixelGateEnabledForExample' ) );
	assert.match( failure, /timings\.freezeTimedOut = false;/ );
	assert.match( failure, /await page\.evaluate\( drainE2EGpuDiagnostics \)/ );
	assert.match( failure, /await finalizeNetworkEvidence\(\)/ );
	assert.match( failure, /browserFailures\.messages\(\)/ );
	assert.match( source, /fatalPageErrors\.dispose\(\);\s*browserFailures\.dispose\(\)/ );

} );
