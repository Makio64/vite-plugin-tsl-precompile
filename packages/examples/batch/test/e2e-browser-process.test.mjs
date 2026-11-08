import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import diagnostics from 'node:diagnostics_channel';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { launchOwnedBrowser, launchOwnedEvidenceBrowser, closeOwnedEvidenceBrowser } from '../e2e-browser-process.mjs';

const channel = diagnostics.channel( 'child_process' );

function deferred() {

	let resolve, reject;
	const promise = new Promise( ( ok, fail ) => { resolve = ok; reject = fail; } );
	return { promise, resolve, reject };

}

async function flush() {

	for ( let index = 0; index < 12; index ++ ) await Promise.resolve();

}

function fixture( { pid = 900001, processInfo = [ { type: 'browser', id: pid } ], activeContexts = [], payload = true } = {} ) {

	const child = new childProcess.ChildProcess();
	const events = [], launchCalls = [];
	const graceful = deferred(), profile = deferred();
	profile.resolve();
	let contexts = activeContexts;
	const browser = {
		contexts: () => contexts,
		async close() { events.push( 'browser.close' ); await graceful.promise; await profile.promise; events.push( 'profile.cleanup' ); },
		async newBrowserCDPSession() {

			events.push( 'cdp' );
			return { async send( command ) { assert.equal( command, 'SystemInfo.getProcessInfo' ); return { processInfo }; }, async detach() { events.push( 'detach' ); } };

		},
	};
	const chromium = {
		async launch( options ) {

			launchCalls.push( options );
			if ( payload ) channel.publish( { process: child } );
			// The real diagnostic arrives from the constructor, before .pid exists.
			child.pid = pid;
			return browser;

		},
	};
	return {
		child, browser, chromium, events, launchCalls, graceful, profile,
		setContexts( next ) { contexts = next; },
		exit( signal = null ) {

			child.exitCode = signal ? null : 0; child.signalCode = signal;
			child.emit( 'exit', child.exitCode, signal ); child.emit( 'close', child.exitCode, signal );
			graceful.resolve();

		},
	};

}

function proofMocks( t, target, { row, error = null, afterProof, killError, onKill } = {} ) {

	const ps = t.mock.method( childProcess, 'execFile', ( file, args, options, callback ) => {

		assert.equal( file, '/bin/ps' );
		assert.deepEqual( args, [ '-p', String( target.child.pid ), '-o', 'pid=,ppid=,pgid=' ] );
		assert.equal( options.timeout, 1000 );
		assert.equal( options.maxBuffer, 4096 );
		target.events.push( 'ps' );
		afterProof?.();
		callback( error, row ?? `${ target.child.pid } ${ process.pid } ${ target.child.pid }\n` );

	} );
	const kill = t.mock.method( process, 'kill', ( pid, signal ) => {

		assert.equal( pid, - target.child.pid ); assert.equal( signal, 'SIGKILL' );
		target.events.push( 'group.kill' );
		if ( killError ) throw killError;
		if ( onKill ) onKill( signal );
		else target.exit( signal );
		return true;

	} );
	return { ps, kill };

}

test( 'direct launch retains exact identity, captures pre-PID handles and unsubscribes after CDP', async t => {

	const subscribe = t.mock.method( diagnostics, 'subscribe' ), unsubscribe = t.mock.method( diagnostics, 'unsubscribe' );
	const target = fixture();
	const result = await launchOwnedEvidenceBrowser( target.chromium, { platform: 'darwin', args: [ '--unsafe' ] } );
	assert.equal( result.browser, target.browser ); assert.equal( result.channel, 'chrome' );
	assert.deepEqual( target.launchCalls, [ { channel: 'chrome', headless: true, args: [ '--unsafe' ] } ] );
	assert.deepEqual( target.events, [ 'cdp', 'detach' ] );
	assert.equal( subscribe.mock.callCount(), 1 ); assert.equal( unsubscribe.mock.callCount(), 1 );
	assert.equal( channel.hasSubscribers, false );
	target.exit(); await closeOwnedEvidenceBrowser( target.browser );
	assert.equal( target.child.listenerCount( 'exit' ), 0 ); assert.equal( target.child.listenerCount( 'close' ), 0 );

} );

test( 'generic fresh launcher preserves its result, argument policy and owned child', async t => {

	const target = fixture();
	const options = { headless: false, args: [ '--custom' ] };
	const launched = { browser: target.browser, channel: 'custom-channel', marker: {} };
	const result = await launchOwnedBrowser( async () => {

		await target.chromium.launch( options ); return launched;

	} );
	assert.equal( result, launched ); assert.equal( target.launchCalls[ 0 ], options );
	const { ps, kill } = proofMocks( t, target );
	target.exit(); await closeOwnedEvidenceBrowser( target.browser );
	assert.equal( ps.mock.callCount(), 0 ); assert.equal( kill.mock.callCount(), 0 );

} );

test( 'generic launcher without diagnostic ownership preserves borrowed result and native close', async t => {

	const target = fixture( { payload: false } );
	const launched = { browser: target.browser, channel: 'original-channel' };
	assert.equal( await launchOwnedBrowser( async () => { await target.chromium.launch( {} ); return launched; } ), launched );
	const closeError = new Error( 'borrowed close failed' );
	target.browser.close = async () => { throw closeError; };
	const { ps, kill } = proofMocks( t, target );
	await assert.rejects( closeOwnedEvidenceBrowser( target.browser ), error => error === closeError );
	assert.equal( ps.mock.callCount(), 0 ); assert.equal( kill.mock.callCount(), 0 );
	assert.equal( target.child.listenerCount( 'exit' ), 0 ); assert.equal( target.child.listenerCount( 'close' ), 0 );

} );

test( 'bounded direct close proves its exact child group, waits cleanup and is idempotent', async t => {

	t.mock.timers.enable( { apis: [ 'setTimeout' ] } );
	const clear = t.mock.method( globalThis, 'clearTimeout' );
	const target = fixture();
	await launchOwnedEvidenceBrowser( target.chromium );
	const { ps, kill } = proofMocks( t, target );
	const close = closeOwnedEvidenceBrowser( target.browser );
	assert.equal( close, closeOwnedEvidenceBrowser( target.browser ) );
	await flush(); t.mock.timers.tick( 249 ); await flush(); assert.equal( kill.mock.callCount(), 0 );
	t.mock.timers.tick( 1 ); await close;
	assert.equal( ps.mock.callCount(), 1 ); assert.equal( kill.mock.callCount(), 1 );
	assert.ok( target.events.indexOf( 'profile.cleanup' ) > target.events.indexOf( 'group.kill' ) );
	assert.equal( clear.mock.callCount(), 1 );
	assert.equal( closeOwnedEvidenceBrowser( target.browser ), close ); await close;
	assert.equal( target.events.filter( event => event === 'browser.close' ).length, 1 );
	assert.equal( target.child.listenerCount( 'exit' ), 0 ); assert.equal( target.child.listenerCount( 'close' ), 0 );

} );

test( 'graceful direct close clears the deadline and never invokes process proof or kill', async t => {

	t.mock.timers.enable( { apis: [ 'setTimeout' ] } );
	const target = fixture(); await launchOwnedEvidenceBrowser( target.chromium );
	const { ps, kill } = proofMocks( t, target );
	const close = closeOwnedEvidenceBrowser( target.browser );
	target.exit(); await close;
	t.mock.timers.tick( 1000 ); await flush();
	assert.equal( ps.mock.callCount(), 0 ); assert.equal( kill.mock.callCount(), 0 );

} );

test( 'premature Browser.close completion keeps the deadline until actual child close', async t => {

	t.mock.timers.enable( { apis: [ 'setTimeout' ] } );
	const target = fixture(); await launchOwnedEvidenceBrowser( target.chromium );
	target.graceful.resolve();
	const { kill } = proofMocks( t, target, { onKill: signal => {

		target.child.signalCode = signal; target.child.emit( 'exit', null, signal );

	} } );
	let done = false;
	const close = closeOwnedEvidenceBrowser( target.browser ); close.then( () => { done = true; } );
	await flush(); assert.equal( target.events.includes( 'profile.cleanup' ), true ); assert.equal( done, false );
	t.mock.timers.tick( 249 ); await flush(); assert.equal( kill.mock.callCount(), 0 );
	t.mock.timers.tick( 1 ); await flush(); assert.equal( kill.mock.callCount(), 1 ); assert.equal( done, false );
	target.child.emit( 'close', null, 'SIGKILL' ); await close; assert.equal( done, true );

} );

test( 'actual child close within grace completes an already closed browser without signalling', async t => {

	t.mock.timers.enable( { apis: [ 'setTimeout' ] } );
	const clear = t.mock.method( globalThis, 'clearTimeout' );
	const target = fixture(); await launchOwnedEvidenceBrowser( target.chromium );
	target.graceful.resolve();
	const { ps, kill } = proofMocks( t, target );
	const close = closeOwnedEvidenceBrowser( target.browser );
	await flush(); t.mock.timers.tick( 200 ); target.exit(); await close;
	t.mock.timers.tick( 1000 ); await flush();
	assert.equal( ps.mock.callCount(), 0 ); assert.equal( kill.mock.callCount(), 0 ); assert.equal( clear.mock.callCount(), 1 );

} );

test( 'owned process exit cannot substitute for awaited Playwright profile cleanup', async t => {

	t.mock.timers.enable( { apis: [ 'setTimeout' ] } );
	const target = fixture();
	const cleanup = deferred();
	target.browser.close = async () => { target.events.push( 'browser.close' ); await target.graceful.promise; await cleanup.promise; target.events.push( 'profile.cleanup' ); };
	await launchOwnedEvidenceBrowser( target.chromium ); proofMocks( t, target );
	let done = false;
	const close = closeOwnedEvidenceBrowser( target.browser ); close.then( () => { done = true; } );
	await flush(); t.mock.timers.tick( 250 ); await flush();
	assert.equal( target.child.signalCode, 'SIGKILL' ); assert.equal( done, false );
	cleanup.resolve(); await close; assert.equal( done, true );

} );

test( 'active contexts remain graceful without an early group kill', async t => {

	t.mock.timers.enable( { apis: [ 'setTimeout' ] } );
	const target = fixture( { activeContexts: [ {} ] } ); await launchOwnedEvidenceBrowser( target.chromium );
	const { ps, kill } = proofMocks( t, target );
	const close = closeOwnedEvidenceBrowser( target.browser );
	await flush(); t.mock.timers.tick( 5000 ); await flush();
	assert.equal( ps.mock.callCount(), 0 ); assert.equal( kill.mock.callCount(), 0 );
	target.exit(); await close;

} );

for ( const scenario of [ 'wrong-parent', 'wrong-group', 'missing-ps', 'exit-during-ps', 'context-during-ps', 'pid-changed' ] ) test( `process ownership rejects ${ scenario } before signalling`, async t => {

	t.mock.timers.enable( { apis: [ 'setTimeout' ] } );
	const target = fixture(); await launchOwnedEvidenceBrowser( target.chromium );
	const options = {
		...( scenario === 'wrong-parent' ? { row: `${ target.child.pid } 1 ${ target.child.pid }` } : {} ),
		...( scenario === 'wrong-group' ? { row: `${ target.child.pid } ${ process.pid } 1` } : {} ),
		...( scenario === 'missing-ps' ? { error: new Error( 'ps unavailable' ) } : {} ),
		...( scenario === 'exit-during-ps' ? { afterProof: () => target.exit() } : {} ),
		...( scenario === 'context-during-ps' ? { afterProof: () => target.setContexts( [ {} ] ) } : {} ),
	};
	const { kill } = proofMocks( t, target, options );
	if ( scenario === 'pid-changed' ) target.child.pid ++;
	const close = closeOwnedEvidenceBrowser( target.browser );
	await flush(); t.mock.timers.tick( 250 ); await flush();
	assert.equal( kill.mock.callCount(), 0 );
	target.exit(); await close;

} );

test( 'observed exit remains monotonic even if public status fields are reset', async t => {

	t.mock.timers.enable( { apis: [ 'setTimeout' ] } );
	const target = fixture(); await launchOwnedEvidenceBrowser( target.chromium );
	target.child.emit( 'exit', 0, null ); target.child.exitCode = null;
	const { kill } = proofMocks( t, target );
	const close = closeOwnedEvidenceBrowser( target.browser );
	await flush(); t.mock.timers.tick( 250 ); await flush(); assert.equal( kill.mock.callCount(), 0 );
	target.exit(); await close;

} );

for ( const scenario of [ 'no-diagnostic', 'wrong-payload', 'no-browser', 'multiple-browser', 'unsupported-cdp', 'windows' ] ) test( `unsupported ${ scenario } retains normal close transport`, async t => {

	t.mock.timers.enable( { apis: [ 'setTimeout' ] } );
	const target = fixture( {
		payload: scenario !== 'no-diagnostic' && scenario !== 'wrong-payload',
		...( scenario === 'no-browser' ? { processInfo: [ { type: 'gpu', id: 900001 } ] } : {} ),
		...( scenario === 'multiple-browser' ? { processInfo: [ { type: 'browser', id: 900001 }, { type: 'browser', id: 900002 } ] } : {} ),
	} );
	if ( scenario === 'wrong-payload' ) {

		const original = target.chromium.launch;
		target.chromium.launch = options => { channel.publish( { process: { pid: 900001 } } ); return original( options ); };

	}
	if ( scenario === 'unsupported-cdp' ) target.browser.newBrowserCDPSession = async () => { throw new Error( 'unsupported' ); };
	const result = await launchOwnedEvidenceBrowser( target.chromium, { platform: scenario === 'windows' ? 'win32' : process.platform } );
	assert.equal( result.browser, target.browser ); assert.equal( channel.hasSubscribers, false );
	const { ps, kill } = proofMocks( t, target );
	const close = closeOwnedEvidenceBrowser( target.browser );
	await flush(); t.mock.timers.tick( 5000 ); await flush();
	assert.equal( ps.mock.callCount(), 0 ); assert.equal( kill.mock.callCount(), 0 );
	target.exit(); await close;

} );

test( 'borrowed browsers cannot be signalled by this prototype', async t => {

	const kill = t.mock.method( process, 'kill', () => { throw new Error( 'unowned kill' ); } );
	let closed = 0;
	await closeOwnedEvidenceBrowser( { close: async () => closed ++ } );
	assert.equal( closed, 1 ); assert.equal( kill.mock.callCount(), 0 );

} );

test( 'borrowed browser close preserves the exact native rejection reason and identity', async () => {

	for ( const reason of [ undefined, null, false, new Error( 'native close failed' ) ] ) {

		const browser = { close: async () => { throw reason; } };
		const close = closeOwnedEvidenceBrowser( browser );
		await assert.rejects( close, error => error === reason );
		assert.equal( closeOwnedEvidenceBrowser( browser ), close );

	}

} );

test( 'grace duration rejects timer overflow and accepts the maximum without early clamping', async t => {

	t.mock.timers.enable( { apis: [ 'setTimeout' ] } );
	const target = fixture(); await launchOwnedEvidenceBrowser( target.chromium );
	for ( const graceMs of [ - 1, NaN, Infinity, 2147483648 ] ) await assert.rejects( closeOwnedEvidenceBrowser( target.browser, { graceMs } ), TypeError );
	assert.equal( target.events.includes( 'browser.close' ), false );
	const { ps, kill } = proofMocks( t, target );
	const close = closeOwnedEvidenceBrowser( target.browser, { graceMs: 2147483647 } );
	await flush(); t.mock.timers.tick( 1000 ); await flush();
	assert.equal( ps.mock.callCount(), 0 ); assert.equal( kill.mock.callCount(), 0 );
	target.exit(); await close;

} );

test( 'diagnostic child overflow releases observers and disarms forced shutdown', async t => {

	t.mock.timers.enable( { apis: [ 'setTimeout' ] } );
	const target = fixture(), children = [];
	const original = target.chromium.launch;
	target.chromium.launch = options => {

		for ( let index = 0; index < 40; index ++ ) {

			const child = new childProcess.ChildProcess(); children.push( child ); channel.publish( { process: child } );
			assert.ok( children.reduce( ( total, entry ) => total + entry.listenerCount( 'exit' ), 0 ) <= 32 );

		}
		return original( options );

	};
	await launchOwnedEvidenceBrowser( target.chromium );
	assert.equal( channel.hasSubscribers, false );
	for ( const child of [ ...children, target.child ] ) {

		assert.equal( child.listenerCount( 'exit' ), 0 ); assert.equal( child.listenerCount( 'close' ), 0 );

	}
	const { ps, kill } = proofMocks( t, target );
	const close = closeOwnedEvidenceBrowser( target.browser );
	await flush(); t.mock.timers.tick( 1000 ); await flush();
	assert.equal( ps.mock.callCount(), 0 ); assert.equal( kill.mock.callCount(), 0 );
	target.exit(); await close;

} );

test( 'launch failures unsubscribe and release observers without signalling unproven children', async () => {

	const child = new childProcess.ChildProcess();
	await assert.rejects( launchOwnedEvidenceBrowser( { async launch() { channel.publish( { process: child } ); throw new Error( 'launch failed' ); } } ), /launch failed/ );
	assert.equal( channel.hasSubscribers, false );
	assert.equal( child.listenerCount( 'exit' ), 0 ); assert.equal( child.listenerCount( 'close' ), 0 );

} );

test( 'CDP detach failure unsubscribes before browser rollback and reports cleanup errors', async () => {

	const target = fixture();
	target.browser.newBrowserCDPSession = async () => ( { send: async () => ( { processInfo: [ { type: 'browser', id: target.child.pid } ] } ), detach: async () => { throw new Error( 'detach failed' ); } } );
	target.browser.close = async () => { assert.equal( channel.hasSubscribers, false ); throw new Error( 'rollback failed' ); };
	await assert.rejects( launchOwnedEvidenceBrowser( target.chromium ), error => error instanceof AggregateError && error.errors.length === 2 );
	assert.equal( target.launchCalls.length, 1 ); assert.equal( channel.hasSubscribers, false );
	assert.equal( target.child.listenerCount( 'exit' ), 0 );

} );

test( 'owned graceful close failure still terminates its proven child and rejects', async t => {

	const target = fixture(); await launchOwnedEvidenceBrowser( target.chromium );
	target.browser.close = async () => { throw new Error( 'profile cleanup failed' ); };
	const { kill } = proofMocks( t, target );
	await assert.rejects( closeOwnedEvidenceBrowser( target.browser ), error => error instanceof AggregateError && error.errors[ 0 ].message === 'profile cleanup failed' );
	assert.equal( kill.mock.callCount(), 1 );
	assert.equal( target.child.listenerCount( 'exit' ), 0 ); assert.equal( target.child.listenerCount( 'close' ), 0 );

} );

test( 'owned close rejection waits the real child close and remains the same failed cleanup', async t => {

	const target = fixture(); await launchOwnedEvidenceBrowser( target.chromium );
	const closeError = new Error( 'profile cleanup failed' );
	target.browser.close = async () => { throw closeError; };
	proofMocks( t, target, { onKill: signal => {

		target.child.signalCode = signal; target.child.emit( 'exit', null, signal );

	} } );
	let done = false;
	const close = closeOwnedEvidenceBrowser( target.browser );
	const rejection = assert.rejects( close, error => error instanceof AggregateError && error.errors[ 0 ] === closeError );
	close.then( () => { done = true; }, () => { done = true; } );
	await flush(); assert.equal( done, false );
	target.child.emit( 'close', null, 'SIGKILL' ); await rejection;
	assert.equal( closeOwnedEvidenceBrowser( target.browser ), close );
	assert.equal( target.child.listenerCount( 'exit' ), 0 ); assert.equal( target.child.listenerCount( 'close' ), 0 );
	assert.equal( target.launchCalls.length, 1 );

} );

test( 'signal errors reject instead of claiming a completed cleanup or launching another browser', async t => {

	const target = fixture(); await launchOwnedEvidenceBrowser( target.chromium );
	target.browser.close = async () => { throw new Error( 'close failed' ); };
	proofMocks( t, target, { killError: new Error( 'signal failed' ) } );
	const close = closeOwnedEvidenceBrowser( target.browser );
	await assert.rejects( close, error => error instanceof AggregateError && error.errors.length === 2 );
	assert.equal( closeOwnedEvidenceBrowser( target.browser ), close );
	assert.equal( target.child.listenerCount( 'exit' ), 0 ); assert.equal( target.child.listenerCount( 'close' ), 0 );
	assert.equal( target.launchCalls.length, 1 ); target.exit();

} );

test( 'falsey owned close and signal failures cannot claim cleanup success', async t => {

	const closeTarget = fixture(); await launchOwnedEvidenceBrowser( closeTarget.chromium );
	closeTarget.browser.close = async () => { throw undefined; };
	proofMocks( t, closeTarget );
	await assert.rejects( closeOwnedEvidenceBrowser( closeTarget.browser ), error => error instanceof AggregateError && error.errors.length === 1 && error.errors[ 0 ] === undefined );
	assert.equal( closeTarget.child.listenerCount( 'exit' ), 0 ); assert.equal( closeTarget.child.listenerCount( 'close' ), 0 );
	t.mock.restoreAll();

	t.mock.timers.enable( { apis: [ 'setTimeout' ] } );
	const signalTarget = fixture(); await launchOwnedEvidenceBrowser( signalTarget.chromium );
	signalTarget.graceful.resolve(); proofMocks( t, signalTarget );
	t.mock.method( process, 'kill', () => { throw null; } );
	const close = closeOwnedEvidenceBrowser( signalTarget.browser );
	const rejection = assert.rejects( close, error => error instanceof AggregateError && error.errors.length === 1 && error.errors[ 0 ] === null );
	await flush(); t.mock.timers.tick( 250 ); await rejection;
	assert.equal( signalTarget.child.listenerCount( 'exit' ), 0 ); assert.equal( signalTarget.child.listenerCount( 'close' ), 0 );
	signalTarget.exit();

} );

test( 'prototype does not introduce WebSocket transport, private fields or a global process scan', () => {

	const source = readFileSync( new URL( '../e2e-browser-process.mjs', import.meta.url ), 'utf8' );
	assert.doesNotMatch( source, /\._[A-Za-z]|launchServer|chromium\.connect|pkill|killall|pgrep|['"]-A['"]|['"]aux['"]/ );
	assert.match( source, /launchEvidenceBrowser\( chromium, options \)/ );
	assert.match( source, /process\.kill\( - owner\.pid, 'SIGKILL' \)/ );

} );
