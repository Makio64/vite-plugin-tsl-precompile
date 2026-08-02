import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
	acquireRecaptureRepositoryLock,
	assertRecaptureArtifactInventoryCoverage,
	assertRecaptureAuxiliaryObligations,
	compareRecaptureArtifactInventories,
	installRecaptureSignalHandlers,
	recaptureDevServerArgs,
	recaptureVerificationDirectories,
	recaptureVerificationArgs,
	selectRecaptureExamples,
	stageFreshArtifactDirectories,
	terminateRecaptureChild,
	waitForRecaptureServerReady,
} from '../../src/cli/recapture-all-support.js';

const REPO = resolve( import.meta.dirname, '../../../..' );

function writeArtifact( repo, example, name, value ) {

	const directory = resolve( repo, 'packages/examples', example, 'artifacts' );
	mkdirSync( directory, { recursive: true } );
	writeFileSync( resolve( directory, name ), value );
	return directory;

}

test( 'recapture-all example selection supports a validated repeatable subset', () => {

	const examples = [
		{ name: 'first', paths: [ '/' ] },
		{ name: 'second', paths: [ '/a' ] },
	];
	assert.deepEqual( selectRecaptureExamples( examples, [] ).examples, examples );
	assert.deepEqual(
		selectRecaptureExamples( examples, [ '--example', 'second', '--example=first', '--example', 'second' ] ).examples,
		[ examples[ 1 ], examples[ 0 ] ],
	);
	assert.equal( selectRecaptureExamples( examples, [ '--help' ] ).help, true );
	assert.deepEqual(
		selectRecaptureExamples( examples, [
			'--example=second',
			'--port=9010',
			'--allow-prune',
			'--skip-build',
		] ),
		{
			examples: [ examples[ 1 ] ],
			help: false,
			port: 9010,
			allowPrune: true,
			build: false,
		},
	);
	assert.throws(
		() => selectRecaptureExamples( examples, [ '--example', 'missing' ] ),
		/Unknown recapture example: missing/,
	);
	assert.throws(
		() => selectRecaptureExamples( examples, [ '--example' ] ),
		/--example requires/,
	);
	assert.throws(
		() => selectRecaptureExamples( examples, [ '--all' ] ),
		/Unknown recapture-all option/,
	);
	for ( const value of [ '0', '65536', '1.5', 'port' ] ) assert.throws(
		() => selectRecaptureExamples( examples, [ '--port', value ] ),
		/--port must be an integer between 1 and 65535/,
	);
	assert.deepEqual(
		recaptureVerificationDirectories( [ examples[ 1 ] ] ),
		[ 'packages/examples/second/artifacts' ],
		'narrow recaptures verify only the selected transactional directory',
	);

} );

test( 'recapture owns the only browser and preserves an explicit Vite mode', () => {

	assert.deepEqual(
		recaptureDevServerArgs( {
			filter: 'examples-getting-started',
			mode: 'tslp-site-live',
		}, 8999 ),
		[
			'--filter', 'examples-getting-started',
			'dev',
			'--host', '127.0.0.1',
			'--port', '8999',
			'--strictPort',
			'--open=false',
			'--mode', 'tslp-site-live',
		],
	);
	assert.throws( () => recaptureDevServerArgs( { filter: 'example' }, 0 ), /between 1 and 65535/ );

} );

test( 'recapture verification arguments prove the selected project source coverage policy', () => {

	assert.deepEqual(
		recaptureVerificationArgs( {
			name: 'shadow-debug',
			sourceRoot: 'packages/examples/shadow-debug',
			sources: [
				'packages/examples/shadow-debug/src',
				'packages/examples/shadow-debug/vsm.html',
			],
			autoMark: false,
		} ),
		[
			'packages/examples/shadow-debug/artifacts',
			'--source-root',
			'packages/examples/shadow-debug',
			'--source',
			'packages/examples/shadow-debug/src',
			'--source',
			'packages/examples/shadow-debug/vsm.html',
			'--no-auto-mark',
		],
	);
	assert.throws(
		() => recaptureVerificationArgs( { name: 'missing-metadata' } ),
		/missing sourceRoot metadata/,
	);

} );

test( 'recapture readiness polls HTTP status and bounds a stalled request', async () => {

	let attempts = 0;
	let waits = 0;
	let bodyCancelled = false;
	const response = await waitForRecaptureServerReady( 'http://127.0.0.1:8999/vsm.html', {
		timeoutMs: 1_000,
		intervalMs: 0,
		fetchImpl: async () => {

			attempts ++;
			if ( attempts === 1 ) throw new Error( 'connection refused' );
			if ( attempts === 2 ) return { status: 503 };
			return {
				status: 204,
				body: {
					async cancel() { bodyCancelled = true; },
				},
			};

		},
		wait: async () => { waits ++; },
	} );
	assert.equal( response.status, 204 );
	assert.equal( attempts, 3 );
	assert.equal( waits, 2 );
	assert.equal( bodyCancelled, true );

	const startedAt = Date.now();
	await assert.rejects(
		waitForRecaptureServerReady( 'http://127.0.0.1:8999/stalled.html', {
			timeoutMs: 20,
			intervalMs: 0,
			fetchImpl: ( _url, options ) => new Promise( ( _resolveRequest, rejectRequest ) => {

				options.signal.addEventListener( 'abort', () => rejectRequest( options.signal.reason ), { once: true } );

			} ),
		} ),
		/within 20ms.*Readiness request timed out/,
	);
	assert.ok( Date.now() - startedAt < 500, 'a stalled response must not hold the artifact transaction open' );

} );

test( 'recapture inventory preserves semantic support across hash refreshes without hiding cardinality loss', () => {

	const previous = [ {
		name: 'pmrem-debug',
		identities: [
			'material:floor',
			'aux:pmrem-blur:old-a',
			'aux:pmrem-blur:old-b',
		],
	} ];
	const refreshed = [ {
		name: 'pmrem-debug',
		identities: [
			'material:floor',
			'aux:pmrem-blur:new-a',
			'aux:pmrem-blur:new-b',
		],
	} ];
	const refreshedReport = assertRecaptureArtifactInventoryCoverage( previous, refreshed );
	assert.deepEqual( refreshedReport[ 0 ].missing, [] );
	assert.deepEqual( refreshedReport[ 0 ].added, [] );
	assert.equal( refreshedReport[ 0 ].replaced.length, 2 );

	const collapsed = [ {
		name: 'pmrem-debug',
		identities: [ 'material:floor', 'aux:pmrem-blur:new-a' ],
	} ];
	const collapsedReport = compareRecaptureArtifactInventories( previous, collapsed );
	assert.equal( collapsedReport[ 0 ].replaced.length, 1 );
	assert.equal( collapsedReport[ 0 ].missing.length, 1 );
	assert.throws(
		() => assertRecaptureArtifactInventoryCoverage( previous, collapsed ),
		/omitted previously supported artifact identities/,
	);

} );

test( 'recapture auxiliary obligations reject a baseline that never captured PMREM or VSM', () => {

	const examples = [
		{
			name: 'pmrem-debug',
			requiredAuxiliaryShapes: [ 'pmrem-equirect', 'pmrem-blur', 'pmrem-ggx' ],
		},
		{
			name: 'shadow-debug',
			requiredAuxiliaryShapes: [ 'shadow-depth', 'shadow-vsm-vertical', 'shadow-vsm-horizontal' ],
		},
	];
	const unrelatedOnly = [
		{ name: 'pmrem-debug', auxiliaryShapes: [ 'background', 'lights', 'render-output' ] },
		{ name: 'shadow-debug', auxiliaryShapes: [ 'lights', 'render-output' ] },
	];
	assert.throws(
		() => assertRecaptureAuxiliaryObligations( unrelatedOnly, examples ),
		/pmrem-debug: pmrem-blur, pmrem-equirect, pmrem-ggx.*shadow-debug: shadow-depth, shadow-vsm-horizontal, shadow-vsm-vertical/,
	);

	const complete = [
		{ name: 'pmrem-debug', auxiliaryShapes: [ 'pmrem-equirect', 'pmrem-blur', 'pmrem-ggx' ] },
		{ name: 'shadow-debug', auxiliaryShapes: [ 'shadow-depth', 'shadow-vsm-vertical', 'shadow-vsm-horizontal' ] },
	];
	assert.equal( assertRecaptureAuxiliaryObligations( complete, examples ).every( ( entry ) => entry.missing.length === 0 ), true );

} );

test( 'recapture-all help documents the narrow example selector without staging artifacts', () => {

	const result = spawnSync(
		process.execPath,
		[ resolve( REPO, 'packages/plugin/src/cli/recapture-all.js' ), '--help' ],
		{ cwd: REPO, encoding: 'utf8' },
	);
	assert.equal( result.status, 0, result.stderr );
	assert.match( result.stdout, /--example <name>/ );
	assert.match( result.stdout, /production build and configured preview gates/ );
	assert.match( result.stdout, /Only one recapture transaction may own a repository at a time/ );

} );

test( 'recapture-all serializes repository transactions before artifact staging', () => {

	const repo = mkdtempSync( join( tmpdir(), 'tslp-recapture-lock-repo-' ) );
	const locks = mkdtempSync( join( tmpdir(), 'tslp-recapture-lock-root-' ) );
	try {

		const first = acquireRecaptureRepositoryLock( repo, {
			temporaryRoot: locks,
			pid: 4101,
			startedAt: '2026-07-30T12:00:00.000Z',
			token: 'first-owner',
		} );
		assert.equal( first.state, 'active' );
		assert.equal( readFileSync( resolve( first.path, 'owner.json' ), 'utf8' ).includes( '"pid": 4101' ), true );

		assert.throws(
			() => acquireRecaptureRepositoryLock( repo, {
				temporaryRoot: locks,
				pid: 4102,
				token: 'second-owner',
			} ),
			( error ) => {

				assert.equal( error.code, 'RECAPTURE_ALREADY_RUNNING' );
				assert.equal( error.owner.pid, 4101 );
				assert.equal( Object.hasOwn( error.owner, 'token' ), false );
				assert.match( error.message, /Wait for it to finish before retrying/ );
				assert.equal( error.lockPath, first.path );
				return true;

			},
		);

		first.release();
		assert.equal( first.state, 'released' );
		const second = acquireRecaptureRepositoryLock( repo, {
			temporaryRoot: locks,
			pid: 4102,
			token: 'second-owner',
		} );
		second.release();
		assert.equal( second.state, 'released' );

	} finally {

		rmSync( repo, { recursive: true, force: true } );
		rmSync( locks, { recursive: true, force: true } );

	}

} );

test( 'recapture artifact staging rolls back only the selected directories', () => {

	const repo = mkdtempSync( join( tmpdir(), 'tslp-recapture-transaction-' ) );
	const backups = mkdtempSync( join( tmpdir(), 'tslp-recapture-backups-' ) );
	try {

		const first = writeArtifact( repo, 'first', 'old.json', 'first-old' );
		const second = writeArtifact( repo, 'second', 'keep.json', 'second-keep' );
		const transaction = stageFreshArtifactDirectories(
			repo,
			[ { name: 'first' } ],
			{ temporaryRoot: backups },
		);
		assert.equal( existsSync( first ), false );
		assert.equal( readFileSync( resolve( second, 'keep.json' ), 'utf8' ), 'second-keep' );

		writeArtifact( repo, 'first', 'partial.json', 'partial-capture' );
		transaction.rollback();
		assert.equal( transaction.state, 'rolled-back' );
		assert.equal( readFileSync( resolve( first, 'old.json' ), 'utf8' ), 'first-old' );
		assert.equal( existsSync( resolve( first, 'partial.json' ) ), false );
		assert.equal( readFileSync( resolve( second, 'keep.json' ), 'utf8' ), 'second-keep' );

	} finally {

		rmSync( repo, { recursive: true, force: true } );
		rmSync( backups, { recursive: true, force: true } );

	}

} );

test( 'recapture artifact staging commits a fresh selected directory and is setup-transactional', () => {

	const repo = mkdtempSync( join( tmpdir(), 'tslp-recapture-commit-' ) );
	const backups = mkdtempSync( join( tmpdir(), 'tslp-recapture-commit-backups-' ) );
	try {

		const first = writeArtifact( repo, 'first', 'old.json', 'old' );
		assert.throws(
			() => stageFreshArtifactDirectories(
				repo,
				[ { name: 'first' }, { name: '../escape' } ],
				{ temporaryRoot: backups },
			),
			/Invalid recapture example name/,
		);
		assert.equal( readFileSync( resolve( first, 'old.json' ), 'utf8' ), 'old' );
		assert.deepEqual( readdirSync( backups ), [] );

		const transaction = stageFreshArtifactDirectories(
			repo,
			[ { name: 'first' } ],
			{ temporaryRoot: backups },
		);
		writeArtifact( repo, 'first', 'fresh.json', 'fresh' );
		transaction.commit();
		assert.equal( transaction.state, 'committed' );
		assert.equal( existsSync( resolve( first, 'old.json' ) ), false );
		assert.equal( readFileSync( resolve( first, 'fresh.json' ), 'utf8' ), 'fresh' );
		assert.deepEqual( readdirSync( backups ), [] );

	} finally {

		rmSync( repo, { recursive: true, force: true } );
		rmSync( backups, { recursive: true, force: true } );

	}

} );

test( 'recapture artifact staging rejects a symlinked example parent without touching its target', () => {

	const repo = mkdtempSync( join( tmpdir(), 'tslp-recapture-parent-link-' ) );
	const outside = mkdtempSync( join( tmpdir(), 'tslp-recapture-parent-target-' ) );
	const backups = mkdtempSync( join( tmpdir(), 'tslp-recapture-parent-backups-' ) );
	try {

		mkdirSync( resolve( repo, 'packages/examples' ), { recursive: true } );
		const outsideArtifacts = resolve( outside, 'first/artifacts' );
		mkdirSync( outsideArtifacts, { recursive: true } );
		writeFileSync( resolve( outsideArtifacts, 'sentinel.json' ), 'outside' );
		symlinkSync( resolve( outside, 'first' ), resolve( repo, 'packages/examples/first' ), 'dir' );

		assert.throws(
			() => stageFreshArtifactDirectories(
				repo,
				[ { name: 'first' } ],
				{ temporaryRoot: backups },
			),
			/symbolic-link path component/,
		);
		assert.equal( readFileSync( resolve( outsideArtifacts, 'sentinel.json' ), 'utf8' ), 'outside' );
		assert.deepEqual( readdirSync( backups ), [] );

	} finally {

		rmSync( repo, { recursive: true, force: true } );
		rmSync( outside, { recursive: true, force: true } );
		rmSync( backups, { recursive: true, force: true } );

	}

} );

test( 'recapture artifact staging rejects symlinks inside the artifact tree', () => {

	const repo = mkdtempSync( join( tmpdir(), 'tslp-recapture-tree-link-' ) );
	const outside = mkdtempSync( join( tmpdir(), 'tslp-recapture-tree-target-' ) );
	const backups = mkdtempSync( join( tmpdir(), 'tslp-recapture-tree-backups-' ) );
	try {

		const artifactsDir = writeArtifact( repo, 'first', 'old.json', 'old' );
		const outsideFile = resolve( outside, 'sentinel.json' );
		writeFileSync( outsideFile, 'outside' );
		symlinkSync( outsideFile, resolve( artifactsDir, 'linked.json' ) );

		assert.throws(
			() => stageFreshArtifactDirectories(
				repo,
				[ { name: 'first' } ],
				{ temporaryRoot: backups },
			),
			/symbolic link inside an artifact directory/,
		);
		assert.equal( readFileSync( outsideFile, 'utf8' ), 'outside' );
		assert.equal( readFileSync( resolve( artifactsDir, 'old.json' ), 'utf8' ), 'old' );
		assert.deepEqual( readdirSync( backups ), [] );

	} finally {

		rmSync( repo, { recursive: true, force: true } );
		rmSync( outside, { recursive: true, force: true } );
		rmSync( backups, { recursive: true, force: true } );

	}

} );

test( 'recapture signal handlers abort once and detach cleanly', () => {

	const processTarget = new EventEmitter();
	const controller = new AbortController();
	const signals = installRecaptureSignalHandlers( processTarget, controller );
	assert.equal( processTarget.listenerCount( 'SIGINT' ), 1 );
	processTarget.emit( 'SIGINT' );
	processTarget.emit( 'SIGTERM' );
	assert.equal( signals.receivedSignal, 'SIGINT' );
	assert.equal( controller.signal.aborted, true );
	assert.match( controller.signal.reason.message, /SIGINT/ );
	signals.dispose();
	assert.equal( processTarget.listenerCount( 'SIGINT' ), 0 );
	assert.equal( processTarget.listenerCount( 'SIGTERM' ), 0 );

} );

test( 'recapture child termination escalates after a bounded grace period', () => {

	const child = new EventEmitter();
	child.exitCode = null;
	child.signalCode = null;
	child.signals = [];
	child.kill = ( signal ) => {

		child.signals.push( signal );
		if ( signal === 'SIGKILL' ) child.signalCode = signal;
		return true;

	};
	let pendingTimer = null;
	let clearedTimer = null;
	const timerToken = { unref() {} };
	terminateRecaptureChild( child, {
		graceMs: 10,
		setTimer( callback ) {

			pendingTimer = callback;
			return timerToken;

		},
		clearTimer( token ) {

			clearedTimer = token;

		},
	} );
	assert.deepEqual( child.signals, [ 'SIGTERM' ] );
	pendingTimer();
	assert.deepEqual( child.signals, [ 'SIGTERM', 'SIGKILL' ] );
	child.emit( 'close' );
	assert.equal( clearedTimer, null, 'an already-fired timer needs no clearing' );

} );

test( 'recapture child termination cancels escalation after graceful close', () => {

	const child = new EventEmitter();
	child.exitCode = null;
	child.signalCode = null;
	child.signals = [];
	child.kill = ( signal ) => {

		child.signals.push( signal );
		return true;

	};
	let pendingTimer = null;
	let clearedTimer = null;
	const timerToken = { unref() {} };
	terminateRecaptureChild( child, {
		setTimer( callback ) {

			pendingTimer = callback;
			return timerToken;

		},
		clearTimer( token ) {

			clearedTimer = token;

		},
	} );
	child.exitCode = 0;
	child.emit( 'close' );
	assert.equal( clearedTimer, timerToken );
	pendingTimer();
	assert.deepEqual( child.signals, [ 'SIGTERM' ] );

} );

test( 'recapture child termination signals the whole POSIX process group', () => {

	const child = new EventEmitter();
	child.exitCode = null;
	child.signalCode = null;
	child.pid = 4242;
	child.__tslpProcessGroup = true;
	child.kill = () => assert.fail( 'direct child signal should not be used when process-group delivery succeeds' );
	const signals = [];
	let escalation;
	terminateRecaptureChild( child, {
		graceMs: 10,
		killProcess( pid, signal ) {

			signals.push( [ pid, signal ] );

		},
		setTimer( callback ) {

			escalation = callback;
			return { unref() {} };

		},
		clearTimer() {},
	} );
	assert.deepEqual( signals, [ [ - 4242, 'SIGTERM' ] ] );
	escalation();
	assert.deepEqual( signals, [ [ - 4242, 'SIGTERM' ], [ - 4242, 'SIGKILL' ] ] );

} );
