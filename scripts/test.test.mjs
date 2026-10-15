import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createTestPlan, executePlan, parseOptions, runGroup } from './test.mjs';
import report from './test-reporter.mjs';

const ROOT = resolve( import.meta.dirname, '..' );
const files = ( args ) => createTestPlan( parseOptions( args, {} ) ).flatMap( ( group ) => group.files || [] ).sort();

test( 'complete plugin selection covers every unit and coverage file exactly once', () => {

	const expected = [ 'unit', 'coverage' ].flatMap( ( directory ) => readdirSync( join( ROOT, 'packages/plugin/test', directory ) )
		.filter( ( name ) => name.endsWith( '.test.js' ) )
		.map( ( name ) => join( ROOT, 'packages/plugin/test', directory, name ) ) ).sort();
	const complete = files( [ 'full', '--scope=plugin' ] );
	assert.deepEqual( complete, expected );
	assert.equal( new Set( complete ).size, complete.length );
	const quick = files( [ 'quick', '--scope=plugin' ] );
	for ( const tier of [ 'generation', 'rewrite', 'coverage' ] ) {

		for ( const file of files( [ tier ] ) ) {

			assert.ok( complete.includes( file ) );
			assert.ok( ! quick.includes( file ) );

		}

	}
	assert.ok( createTestPlan( parseOptions( [ 'full', '--scope=plugin' ], {} ) ).some( ( group ) => group.concurrency === 1 ) );

} );

test( 'complete repository selection includes package and script tests without browser campaigns', () => {

	const plan = createTestPlan( parseOptions( [ 'full' ], {} ) );
	assert.deepEqual( [ ...new Set( plan.map( ( group ) => group.scope ) ) ], [ 'contract', 'contract:types', 'plugin', 'runtime', 'inspector', 'site', 'tooling' ] );
	assert.ok( plan.find( ( group ) => group.scope === 'tooling' ).files.some( ( file ) => file.endsWith( 'release-state.test.mjs' ) ) );
	assert.ok( files( [ 'quick' ] ).includes( join( ROOT, 'scripts/test.test.mjs' ) ) );
	const campaign = join( ROOT, 'packages/site/test/examples-evidence-contract.test.mjs' );
	assert.ok( files( [ 'full' ] ).includes( campaign ) );
	assert.ok( ! files( [ 'quick' ] ).includes( campaign ) );
	assert.ok( files( [ 'full', '--scope=batch' ] ).includes( join( ROOT, 'packages/examples/batch/test/psnr-ignore-regions.test.mjs' ) ) );

} );

test( 'file filtering avoids unrelated tests and preserves whole test files', () => {

	assert.deepEqual( files( [ 'quick', '--scope=runtime', '--match=hydrate-storage-buffer.test.js' ] ), [ join( ROOT, 'packages/runtime/test/hydrate-storage-buffer.test.js' ) ] );
	assert.ok( ! createTestPlan( parseOptions( [ '--scope=contract', '--match=stable-json' ], {} ) ).some( ( group ) => group.args ) );
	assert.throws( () => files( [ '--match=nonexistent-test' ] ), /No test files/ );
	assert.throws( () => files( [ 'coverage', '--scope=runtime' ] ), /plugin tier/ );
	assert.deepEqual( files( [ '--scope=runtime', '--match=hydrate-storage-buffer.test.js', '--match=hydrate-material-compute.test.js' ] ), [
		join( ROOT, 'packages/runtime/test/hydrate-material-compute.test.js' ),
		join( ROOT, 'packages/runtime/test/hydrate-storage-buffer.test.js' ),
	] );

} );

test( 'explicit plugin matches classify selected files without opening unrelated compiler fixtures', t => {

	const directory = mkdtempSync( join( tmpdir(), 'tslp-selection-test-' ) );
	t.after( () => rmSync( directory, { recursive: true, force: true } ) );
	const fixtures = join( directory, 'packages/plugin/test/unit' );
	mkdirSync( fixtures, { recursive: true } );
	const selected = join( fixtures, 'selected.test.js' );
	const unclassified = join( fixtures, 'unclassified.test.js' );
	writeFileSync( selected, "import test from 'node:test'; test('selected', () => {});\n" );
	writeFileSync( unclassified, "import { compileTSL } from '../src/vendor/compileTSL.js';\n" );
	const plan = createTestPlan( parseOptions( [ 'quick', '--scope=plugin', '--match=selected.test.js' ], {} ), directory );
	assert.deepEqual( plan.flatMap( group => group.files ), [ selected ] );
	assert.throws( () => createTestPlan( parseOptions( [ 'full', '--scope=plugin', '--match=unclassified' ], {} ), directory ), /Generation-heavy test must be classified/ );
	assert.throws( () => createTestPlan( parseOptions( [ 'full', '--scope=plugin' ], {} ), directory ), /Generation-heavy test must be classified/ );

} );

test( 'unknown options and malformed concurrency cannot silently change selection', () => {

	for ( const args of [ [ 'ful' ], [ '--scop=runtime' ], [ '--scope=missing' ], [ 'quick', 'full' ] ] ) {

		assert.throws( () => parseOptions( args, {} ), /Unknown/ );

	}
	for ( const value of [ '2garbage', '2.5', '0', '-1', '', '9007199254740992' ] ) {

		assert.throws( () => parseOptions( [], { TSLP_TEST_CONCURRENCY: value } ), /positive integer/ );

	}
	assert.equal( parseOptions( [ '--', '--scope=runtime' ], { TSLP_TEST_CONCURRENCY: '4' } ).concurrency, 4 );
	assert.equal( parseOptions( [ '--workers=3' ], { TSLP_TEST_CONCURRENCY: 'invalid' } ).concurrency, 3 );
	assert.equal( parseOptions( [ '--low-memory' ], { TSLP_TEST_CONCURRENCY: '8' } ).concurrency, 1 );
	assert.ok( createTestPlan( parseOptions( [ 'full', '--low-memory' ], {} ) ).every( ( group ) => ! group.files || group.concurrency === 1 ) );
	assert.throws( () => parseOptions( [ '--low-memory', '--workers=2' ], {} ), /requires --workers=1/ );
	assert.throws( () => parseOptions( [ '--match=' ], {} ), /nonempty/ );
	for ( const value of [ '-1', '0.1', 'NaN', '', '2147483648' ] ) {

		assert.throws( () => parseOptions( [ `--timeout=${ value }` ], {} ), /milliseconds/ );

	}
	assert.equal( parseOptions( [], {} ).timeout, 300000 );
	assert.equal( parseOptions( [ '--timeout=0', '--fail-fast' ], {} ).timeout, 0 );
	assert.equal( parseOptions( [ '--fail-fast' ], {} ).failFast, true );

} );

test( 'interrupting the runner with SIGINT or SIGTERM stops its workers and descendants', { skip: process.platform === 'win32' }, async ( t ) => {

	const directory = mkdtempSync( join( tmpdir(), 'tslp-interrupt-test-' ) );
	t.after( () => rmSync( directory, { recursive: true, force: true } ) );
	for ( const signal of [ 'SIGINT', 'SIGTERM' ] ) {

		const pidFile = join( directory, `${ signal }.pid` );
		const fixture = join( directory, `${ signal }-fixture.mjs` );
		writeFileSync( fixture, `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const child = spawn(process.execPath, ['-e', "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {stdio: 'ignore'});
writeFileSync(${ JSON.stringify( pidFile ) }, String(child.pid));
while (true) {}
` );
		const launcher = join( directory, `${ signal }-runner.mjs` );
		writeFileSync( launcher, `import {runGroup} from ${ JSON.stringify( join( ROOT, 'scripts/test.mjs' ) ) };
const result = await runGroup([${ JSON.stringify( fixture ) }], {cwd: ${ JSON.stringify( directory ) }, timeout: 0, stdio: 'ignore'});
process.exitCode = result.interrupted === 'SIGINT' ? 130 : 143;
` );
		const child = spawn( process.execPath, [ launcher ], { stdio: 'ignore' } );
		t.after( () => { if ( child.exitCode === null && child.signalCode === null ) child.kill( 'SIGTERM' ); } );
		const exited = once( child, 'exit' );
		const deadline = Date.now() + 3000;
		while ( ! existsSync( pidFile ) && Date.now() < deadline ) await new Promise( ( done ) => setTimeout( done, 10 ) );
		assert.ok( existsSync( pidFile ), 'fixture did not start' );
		child.kill( signal );
		const [ status ] = await exited;
		assert.equal( status, signal === 'SIGINT' ? 130 : 143 );
		const state = spawnSync( 'ps', [ '-o', 'stat=', '-p', readFileSync( pidFile, 'utf8' ) ], { encoding: 'utf8' } );
		assert.ok( ! state.stdout.trim() || state.stdout.trim().startsWith( 'Z' ), state.stdout );

	}

} );

test( 'slow-file reporting measures complete processes and retains only the three slowest files', async () => {

	const events = [];
	for ( const [ file, duration_ms ] of [ [ '/a.test.js', 500 ], [ '/b.test.js', 800 ], [ '/c.test.js', 300 ], [ '/d.test.js', 400 ] ] ) {

		events.push( { type: 'test:summary', data: { file, duration_ms: 1 } } );
		events.push( { type: 'test:complete', data: { file, name: file, nesting: 0, details: { duration_ms } } } );

	}
	events.push( { type: 'test:summary', data: { success: true, counts: { tests: 4, passed: 4, failed: 0, cancelled: 0, skipped: 0, todo: 0 }, duration_ms: 1000 } } );
	let output = '';
	for await ( const part of report( events ) ) output += part;
	assert.ok( output.indexOf( '0.80s' ) < output.indexOf( '0.50s' ) );
	assert.match( output, /0.40s/ );
	assert.doesNotMatch( output, /0.30s|0.00s/ );

} );

test( 'watchdog stops synchronous hangs and every process in their descendant group', { skip: process.platform === 'win32' }, async ( t ) => {

	const directory = mkdtempSync( join( tmpdir(), 'tslp-watchdog-test-' ) );
	t.after( () => rmSync( directory, { recursive: true, force: true } ) );
	const pidFile = join( directory, 'pid' );
	const script = join( directory, 'hang.test.mjs' );
	writeFileSync( script, `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {stdio: 'ignore'});
writeFileSync(${ JSON.stringify( pidFile ) }, String(child.pid));
while (true) {}
` );
	const listeners = [ process.listenerCount( 'SIGINT' ), process.listenerCount( 'SIGTERM' ) ];
	const result = await runGroup( [ '--test', script ], { cwd: directory, timeout: 500, stdio: 'ignore' } );
	assert.equal( result.timedOut, true );
	assert.equal( result.interrupted, null );
	assert.deepEqual( [ process.listenerCount( 'SIGINT' ), process.listenerCount( 'SIGTERM' ) ], listeners );
	const pid = Number( readFileSync( pidFile, 'utf8' ) );
	// A killed grandchild can briefly be a zombie while launchd reaps it. It must
	// no longer be running, including when its parent died on the first signal.
	const state = spawnSync( 'ps', [ '-o', 'stat=', '-p', String( pid ) ], { encoding: 'utf8' } );
	assert.ok( ! state.stdout.trim() || state.stdout.trim().startsWith( 'Z' ), state.stdout );

} );

test( 'fail-fast leaves later groups untouched and declaration diagnostics are logged', async ( t ) => {

	const directory = mkdtempSync( join( tmpdir(), 'tslp-fail-fast-test-' ) );
	t.after( () => rmSync( directory, { recursive: true, force: true } ) );
	const sentinel = join( directory, 'should-not-exist' );
	const messages = [];
	const originalLog = console.log;
	const originalError = console.error;
	t.after( () => { console.log = originalLog; console.error = originalError; } );
	console.log = ( message ) => messages.push( message );
	console.error = ( message ) => messages.push( message );
	const result = await executePlan( [
		{ scope: 'fixture:types', cwd: directory, args: [ '-e', "console.error('specific declaration error'); process.exitCode = 1" ] },
		{ scope: 'later', cwd: directory, args: [ '-e', `require('fs').writeFileSync(${ JSON.stringify( sentinel ) }, 'ran')` ] },
	], { failFast: true, timeout: 3000 } );
	assert.equal( result, 1 );
	assert.throws( () => readFileSync( sentinel ), { code: 'ENOENT' } );
	const logs = messages[ 0 ].slice( '[test] Complete logs: '.length );
	t.after( () => rmSync( logs, { recursive: true, force: true } ) );
	assert.match( readFileSync( join( logs, '0-fixture-types.log' ), 'utf8' ), /specific declaration error/ );

} );

test( 'compact reporting preserves failure diagnostics and full logs with a failing exit code', ( t ) => {

	const directory = mkdtempSync( join( tmpdir(), 'tslp-reporter-test-' ) );
	t.after( () => rmSync( directory, { recursive: true, force: true } ) );
	const fixture = join( directory, 'fixture.test.mjs' );
	const log = join( directory, 'full.log' );
	writeFileSync( fixture, `import test from 'node:test';
import assert from 'node:assert/strict';
test('passing fixture', () => console.log('captured diagnostic'));
test('broken fixture', () => assert.equal(1, 2, 'specific assertion'));
test.skip('skipped fixture', () => {});
test.todo('future fixture');
` );
	const environment = { ...process.env };
	delete environment.NODE_TEST_CONTEXT;
	const result = spawnSync( process.execPath, [
		'--test', `--test-reporter=${ join( ROOT, 'scripts/test-reporter.mjs' ) }`,
		'--test-reporter-destination=stdout', '--test-reporter=spec',
		`--test-reporter-destination=${ log }`, fixture,
	], { encoding: 'utf8', env: environment } );
	assert.equal( result.status, 1 );
	assert.match( result.stdout, /broken fixture/ );
	assert.match( result.stdout, /specific assertion/ );
	assert.match( result.stdout, /1 failed, 0 cancelled, 1 skipped, 1 todo/ );
	assert.doesNotMatch( result.stdout, /captured diagnostic/ );
	assert.match( readFileSync( log, 'utf8' ), /captured diagnostic/ );
	assert.match( readFileSync( log, 'utf8' ), /passing fixture/ );

} );

test( 'large assertion inputs and messages stay bounded in the terminal and complete in the spec log', ( t ) => {

	const directory = mkdtempSync( join( tmpdir(), 'tslp-reporter-large-test-' ) );
	t.after( () => rmSync( directory, { recursive: true, force: true } ) );
	const fixture = join( directory, 'large.test.mjs' );
	const log = join( directory, 'full.log' );
	writeFileSync( fixture, `import test from 'node:test';
import assert from 'node:assert/strict';
test('large source assertion', () => assert.match('source-start\\n' + 'middle-source\\n'.repeat(2000) + 'source-end', /expected-source-marker/));
test('large diagnostic message', () => { const error = new Error('message-start\\n' + 'middle-message\\n'.repeat(2000) + 'message-end'); error.actual = Array.from({length: 1000}, () => 'large-actual'); error.expected = 'expected-value-marker'; throw error; });
` );
	const environment = { ...process.env };
	delete environment.NODE_TEST_CONTEXT;
	const result = spawnSync( process.execPath, [
		'--test', `--test-reporter=${ join( ROOT, 'scripts/test-reporter.mjs' ) }`,
		'--test-reporter-destination=stdout', '--test-reporter=spec',
		`--test-reporter-destination=${ log }`, fixture,
	], { encoding: 'utf8', env: environment, maxBuffer: 1024 * 1024 } );
	assert.equal( result.status, 1 );
	assert.ok( result.stdout.length < 10500, `${ result.stdout.length } terminal characters` );
	assert.match( result.stdout, /expected-source-marker/ );
	assert.match( result.stdout, /message-start/ );
	assert.match( result.stdout, /message-end/ );
	assert.match( result.stdout, /expected-value-marker/ );
	assert.match( result.stdout, /truncated; see full log/ );
	assert.ok( result.stdout.includes( `Full log: ${ log }` ) );
	const complete = readFileSync( log, 'utf8' );
	assert.ok( complete.length > result.stdout.length * 2 );
	// Node's standard spec formatter applies its own assertion-string limits.
	// Compare it directly to prove our compact consumer did not mutate its errors.
	const standalone = join( directory, 'standalone.log' );
	const specOnly = spawnSync( process.execPath, [ '--test', '--test-reporter=spec', `--test-reporter-destination=${ standalone }`, fixture ], { env: environment } );
	assert.equal( specOnly.status, 1 );
	const fingerprint = ( source ) => createHash( 'sha256' ).update( source
		.replace( /\(\d+(?:\.\d+)?ms\)/g, '(TIME)' )
		.replace( /(duration_ms )\d+(?:\.\d+)?/g, '$1TIME' ) ).digest( 'hex' );
	assert.equal( fingerprint( complete ), fingerprint( readFileSync( standalone, 'utf8' ) ), 'compact reporting must preserve the standard spec report' );

} );
