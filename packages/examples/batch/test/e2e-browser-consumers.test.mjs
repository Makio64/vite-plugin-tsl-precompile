import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const AsyncFunction = Object.getPrototypeOf( async () => {} ).constructor;
const sources = Object.fromEntries( [
	'e2e', 'stock', 'slim', 'capture-replay', 'inspector-smoke',
].map( name => [ name, readFileSync( new URL( '../' + ( name === 'stock' ? 'run' : 'run-' + name ) + '.mjs', import.meta.url ), 'utf8' ) ] ) );

function between( source, start, end ) {

	const first = source.indexOf( start );
	const last = source.indexOf( end, first + start.length );
	assert.ok( first >= 0 && last > first, 'the actual driver fragment must remain extractable: ' + start );
	return source.slice( first, last );

}

function execute( fragment, scope, result = '' ) {

	return new AsyncFunction( ...Object.keys( scope ), fragment + '\n' + result )( ...Object.values( scope ) );

}

function driverFragment( mode ) {

	const source = sources[ mode ];
	if ( mode === 'e2e' ) return between( source, '\nconst lifecycleErrors = [];', '\nif ( officialThreeSourcesRequired ) {' );
	return between( source, '\nconst lifecycleErrors = [];', '\nif ( interruptedSignal ) {' );

}

function signalFragment( mode ) {

	return mode === 'e2e' ? '' : between( sources[ mode ], "for ( const signal of [ 'SIGINT', 'SIGTERM', 'SIGHUP' ] ) {", '\nconst ' + ( mode === 'stock' ? 'runId' : 'report' ) + ' = ' );

}

function launchFragment( mode ) {

	if ( mode === 'e2e' ) return between( sources.e2e, 'async function recycleBrowser(', '\nlet initialBrowser = null;' );
	if ( mode === 'stock' ) return between( sources.stock, 'async function launchStockBrowser(', '\nfunction signalExitCode(' );
	return between( sources.slim, 'async function launchSlimBrowser(', '\nlet browser = null;' );

}

function errorIncludes( error, expected ) {

	return error === expected || error instanceof AggregateError && error.errors.some( entry => errorIncludes( entry, expected ) );

}

function fixture( mode, { maxRuns = 1, count = 2, closeError, closeId = 'initial', environmentError, environmentId = 'initial', serverError, caseError, signal, writeError } = {} ) {

	const events = [], callbacks = new Map(), closes = new WeakMap();
	const browsers = [ { id: 'initial' }, { id: 'recycled' }, { id: 'unexpected-third' } ];
	const report = { pass: 0, fail: 0, complete: false, categories: {}, details: [], configuration: {} };
	let launchCount = 0, writes = 0;
	const closeOwnedEvidenceBrowser = browser => {

		events.push( 'close:' + ( browser?.id || 'none' ) );
		if ( ! browser ) return Promise.resolve();
		if ( ! closes.has( browser ) ) closes.set( browser, browser.id === closeId && closeError
			? Promise.reject( closeError ) : Promise.resolve() );
		return closes.get( browser );

	};
	const launch = async () => {

		const browser = browsers[ launchCount ++ ];
		events.push( 'launch:' + browser.id );
		return { browser, channel: 'chrome' };

	};
	const scope = {
		browser: mode === 'e2e' ? browsers[ 0 ] : null,
		interruptedSignal: null, runsSinceRestart: 0, report,
		candidates: Array.from( { length: count }, ( _, index ) => 'case-' + index ),
		MAX_RUNS_PER_BROWSER: maxRuns, BROWSER_RESPAWN_DELAY_MS: 0, BROWSER_ARGS: [ '--existing-gpu-flag' ],
		port: 1234, chromium: { launch: async () => ( await launch() ).browser },
		launchOwnedBrowser: callback => callback(), launchOwnedEvidenceBrowser: launch, launchBrowser: launch,
		closeOwnedEvidenceBrowser,
		collectEvidenceEnvironment: async ( { browser } ) => {

			events.push( 'environment:' + browser.id );
			if ( browser.id === environmentId && environmentError ) throw environmentError;
			return { adapter: 'same' };

		},
		assertEvidenceEnvironmentMatches: () => {}, evidenceEnvironment: { adapter: 'same' },
		server: { listening: true, close( callback ) { events.push( 'server.close' ); this.listening = false; callback( serverError ); } },
		process: { once: ( name, callback ) => callbacks.set( name, callback ), exit: () => assert.fail( 'driver must not exit inside this test' ) },
		globalThis: {}, console: { log() {}, error() {} },
		runOne: async ( browser, name ) => {

			events.push( 'case:' + name );
			if ( signal ) callbacks.get( signal )();
			if ( caseError ) throw caseError;
			return { name, status: 'pass', bright: 0.5, category: 'rendered' };

		},
		runE2ECaseWithWatchdog: ( name, timeout, callback ) => callback(), caseTimeoutMs: 100,
		isE2ECaseTimeoutError: () => false, caseEvidenceConfiguration: () => ( {} ), RUN_ID: 'test',
		createE2EEvidenceGate: value => value, timingsEnabled: false, formatResultLine: () => '', formatTimingLine: () => '',
		shouldPass: () => true,
		writeReport: () => { events.push( 'report.write' ); if ( writes ++ === 0 && writeError ) throw writeError; },
		writePartialReport: () => { events.push( 'report.write' ); },
	};
	return {
		scope, report, events, browsers,
		launchCount: () => launchCount,
		run: () => execute( launchFragment( mode ) + signalFragment( mode ) + driverFragment( mode ), scope, 'return { report, browser, interruptedSignal };' ),
	};

}

for ( const mode of [ 'e2e', 'stock', 'slim' ] ) test( mode + ' recycle cleanup failure escapes the case catch and prevents the next launch', async () => {

	const closeError = new Error( 'owned process cleanup failed' );
	const target = fixture( mode, { closeError } );
	await assert.rejects( target.run(), error => errorIncludes( error, closeError ) );
	assert.deepEqual( target.events.filter( event => event.startsWith( 'case:' ) ), [ 'case:case-0' ] );
	assert.equal( target.launchCount(), mode === 'e2e' ? 0 : 1 );
	assert.equal( target.report.pass, 1 ); assert.equal( target.report.fail, 0 );
	assert.equal( target.report.details.length, 1 );
	assert.equal( target.events.filter( event => event === 'server.close' ).length, 1 );

} );

for ( const mode of [ 'e2e', 'stock', 'slim' ] ) test( mode + ' final browser failure still closes HTTP and preserves server diagnostics', async () => {

	const closeError = new Error( 'final browser cleanup failed' ), serverError = new Error( 'HTTP close failed' );
	const target = fixture( mode, { closeError, serverError, count: 1 } );
	await assert.rejects( target.run(), error => errorIncludes( error, closeError ) && errorIncludes( error, serverError ) );
	assert.equal( target.report.pass, 1 ); assert.equal( target.report.complete, false );
	assert.equal( target.events.filter( event => event === 'server.close' ).length, 1 );
	assert.ok( target.events.indexOf( 'server.close' ) > target.events.lastIndexOf( 'close:initial' ) );

} );

test( 'E2E crash-recovery cleanup failure aborts before another case or browser launch', async () => {

	const closeError = new Error( 'crash cleanup failed' );
	const target = fixture( 'e2e', { closeError, caseError: new Error( 'Target page, context or browser has been closed' ), maxRuns: 100 } );
	await assert.rejects( target.run(), error => errorIncludes( error, closeError ) );
	assert.equal( target.launchCount(), 0 );
	assert.equal( target.report.fail, 1 ); assert.equal( target.report.details.length, 1 );
	assert.equal( target.events.filter( event => event.startsWith( 'case:' ) ).length, 1 );
	assert.equal( target.events.filter( event => event === 'server.close' ).length, 1 );

} );

test( 'E2E first report write failure disposes browser and HTTP before propagating', async () => {

	const writeError = new Error( 'report disk write failed' ), closeError = new Error( 'cleanup also failed' );
	const target = fixture( 'e2e', { writeError, closeError } );
	await assert.rejects( target.run(), error => errorIncludes( error, writeError ) && errorIncludes( error, closeError ) );
	assert.equal( target.events.filter( event => event.startsWith( 'case:' ) ).length, 0 );
	assert.equal( target.events.filter( event => event === 'close:initial' ).length, 1 );
	assert.equal( target.events.filter( event => event === 'server.close' ).length, 1 );

} );

test( 'E2E initial environment and cleanup failures both survive HTTP disposal', async () => {

	const primary = new Error( 'initial adapter probe failed' ), cleanup = new Error( 'initial cleanup failed' );
	const target = fixture( 'e2e', { environmentError: primary, closeError: cleanup } );
	const initial = between( sources.e2e, '\nlet initialBrowser = null;', '\nconst casePolicies = ' );
	const scope = { ...target.scope }; delete scope.browser; delete scope.evidenceEnvironment;
	await assert.rejects( execute( initial, scope ), error => errorIncludes( error, primary ) && errorIncludes( error, cleanup ) );
	assert.equal( target.launchCount(), 1 );
	assert.equal( target.events.filter( event => event === 'server.close' ).length, 1 );

} );

for ( const probe of [ 'collect', 'match' ] ) test( 'E2E recycled environment ' + probe + ' failure retains primary and cleanup errors', async () => {

	const primary = new Error( 'recycled environment failed' ), cleanup = new Error( 'recycled cleanup failed' );
	const target = fixture( 'e2e', { environmentError: probe === 'collect' ? primary : null, closeError: cleanup } );
	target.scope.browser = { id: 'previous' };
	target.scope.assertEvidenceEnvironmentMatches = () => { if ( probe === 'match' ) throw primary; };
	await assert.rejects( execute( launchFragment( 'e2e' ), target.scope, 'return recycleBrowser(browser, evidenceEnvironment);' ),
		error => errorIncludes( error, primary ) && errorIncludes( error, cleanup ) );
	assert.equal( target.launchCount(), 1 );
	assert.deepEqual( target.events.filter( event => event.startsWith( 'close:' ) ), [ 'close:previous', 'close:initial' ] );

} );

for ( const phase of [ 'initial', 'recycled' ] ) test( 'stock ' + phase + ' environment failure retains both diagnostics and closes HTTP', async () => {

	const primary = new Error( phase + ' environment failed' ), cleanup = new Error( phase + ' browser cleanup failed' );
	const target = fixture( 'stock', { environmentError: primary, environmentId: phase, closeError: cleanup, closeId: phase } );
	await assert.rejects( target.run(), error => errorIncludes( error, primary ) && errorIncludes( error, cleanup ) );
	assert.equal( target.launchCount(), phase === 'initial' ? 1 : 2 );
	assert.equal( target.report.details.length, phase === 'initial' ? 0 : 1 );
	assert.equal( target.events.filter( event => event === 'server.close' ).length, 1 );

} );

for ( const mode of [ 'stock', 'slim' ] ) test( mode + ' signal rejection is observed then reawaited by final cleanup', async () => {

	const cleanup = new Error( 'signal cleanup rejected' );
	const target = fixture( mode, { closeError: cleanup, signal: 'SIGTERM', maxRuns: 100 } );
	await assert.rejects( target.run(), error => errorIncludes( error, cleanup ) );
	assert.equal( target.launchCount(), 1 );
	assert.equal( target.events.filter( event => event === 'close:initial' ).length, 2 );
	assert.equal( target.events.filter( event => event === 'server.close' ).length, 1 );
	assert.equal( target.report.details.length, 0 ); assert.equal( target.report.complete, false );

} );

for ( const name of [ 'slim', 'capture-replay', 'inspector-smoke' ] ) test( name + ' owns its launch while preserving exact Chrome and fallback options', async () => {

	const declaration = name === 'slim' ? 'async function launchSlimBrowser(' : 'async function launchBrowser(';
	const end = name === 'slim' ? '\nlet browser = null;' : '\nasync function main() {';
	const fragment = between( sources[ name ], declaration, end );
	for ( const fallback of [ false, true ] ) {

		const options = [], args = [ '--existing-gpu-flag' ], browser = {};
		let owners = 0, selected;
		const result = await execute( fragment, {
			BROWSER_ARGS: args,
			chromium: { async launch( value ) { options.push( value ); if ( fallback && options.length === 1 ) throw new Error( 'Chrome unavailable' ); return browser; } },
			launchOwnedBrowser: async callback => { owners ++; selected = await callback(); return selected; },
		}, 'return ' + ( name === 'slim' ? 'launchSlimBrowser' : 'launchBrowser' ) + '();' );
		assert.equal( owners, 1 ); assert.equal( selected.browser, browser );
		assert.equal( selected.channel, fallback ? 'playwright-chromium' : 'chrome' );
		assert.equal( name === 'slim' ? result.browser : result, browser );
		assert.deepEqual( options, [
			{ channel: 'chrome', headless: true, args },
			...( fallback ? [ { headless: true, args } ] : [] ),
		] );

	}

} );
