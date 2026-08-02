import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
	captureCanSettle,
	classifyRecaptureResourceFailure,
	isCorrelatedRecaptureFaviconConsoleError,
	isExactRecaptureFaviconFailure,
	classifyRecaptureRendererBackendEvidence,
	classifyRecaptureRendererBackendGate,
	classifyRecaptureRouteOutcome,
	createRecaptureFailureTracker,
	createRecaptureRouteMatrix,
	createRecaptureRetryArgv,
	createRecaptureVerifyArgv,
	installRecaptureActivityCounter,
	isTransientRecaptureNavigationError,
	navigateWithColdReloadRetry,
	parseRecaptureArgs,
	recaptureBrowserLaunchArgs,
	recaptureBrowserLaunchOptions,
	recoverColdReloadDuringPolling,
} from '../../src/cli/recapture-support.js';

const REPO = resolve( import.meta.dirname, '../../../..' );
const CLI = resolve( REPO, 'packages/plugin/src/cli/recapture.js' );

test( 'recapture CLI parser accepts explicit validated options', () => {

	assert.deepEqual(
		parseRecaptureArgs( [
			'--url', 'http://127.0.0.1:5199/',
			'--paths=/first,/second?mode=a',
			'--backends=webgpu,webgl',
			'--timeout', '45000',
			'--settle=750.5',
			'--browser', 'webkit',
			'--no-headless',
			'--allow-empty',
			'--source', 'client/main.ts',
			'--source=client/materials.ts',
			'--source-root', '../..',
			'--artifacts=generated/tsl',
			'--no-auto-mark',
			'--auto-mark-prefix', 'shader',
		] ),
		{
			url: 'http://127.0.0.1:5199',
			paths: [ '/first', '/second?mode=a' ],
			backends: [ 'webgpu', 'webgl' ],
			timeout: 45000,
			settle: 750.5,
			headless: false,
			browserName: 'webkit',
			allowEmpty: true,
			sources: [ 'client/main.ts', 'client/materials.ts' ],
			sourceRoot: '../..',
			artifacts: 'generated/tsl',
			autoMark: false,
			autoMarkPrefix: 'shader',
			json: false,
			help: false,
		},
	);

} );

test( 'recapture Chromium launch preserves macOS behavior and enables both software backends on Linux', async () => {

	const macArgs = [
		'--enable-unsafe-webgpu',
		'--ignore-gpu-blocklist',
		'--no-sandbox',
		'--disable-dev-shm-usage',
	];
	assert.deepEqual( recaptureBrowserLaunchArgs( 'chromium', 'darwin' ), macArgs );
	assert.deepEqual( recaptureBrowserLaunchArgs( 'firefox', 'linux' ), [] );
	assert.deepEqual(
		recaptureBrowserLaunchOptions( 'chromium', { platform: 'linux', headless: true } ),
		{
			channel: 'chromium',
			headless: true,
			args: recaptureBrowserLaunchArgs( 'chromium', 'linux' ),
		},
	);
	assert.deepEqual(
		recaptureBrowserLaunchOptions( 'chromium', { platform: 'darwin', headless: true } ),
		{ headless: true, args: macArgs },
	);

	const { evidenceBrowserLaunchArgs, LINUX_SWIFTSHADER_BROWSER_ARGS } = await import(
		'../../../examples/batch/e2e-environment.mjs'
	);
	assert.deepEqual(
		recaptureBrowserLaunchArgs( 'chromium', 'linux' ),
		evidenceBrowserLaunchArgs( macArgs, 'linux' ),
	);
	assert.deepEqual(
		recaptureBrowserLaunchArgs( 'chromium', 'linux' )
			.filter( ( arg ) => LINUX_SWIFTSHADER_BROWSER_ARGS.includes( arg ) ),
		[ ...LINUX_SWIFTSHADER_BROWSER_ARGS ],
	);
	for ( const arg of LINUX_SWIFTSHADER_BROWSER_ARGS ) {

		assert.equal( recaptureBrowserLaunchArgs( 'chromium', 'linux' ).includes( arg ), true );

	}

} );

test( 'recapture parser and route outcome expose stable JSON-oriented states', () => {

	assert.equal( parseRecaptureArgs( [ '--json' ] ).json, true );
	assert.equal( parseRecaptureArgs( [] ).backends, null );
	assert.deepEqual( classifyRecaptureRouteOutcome( {
		captureStarts: 2,
		acceptedPosts: 2,
	} ), {
		ok: true,
		status: 'captured',
		failures: [],
	} );
	assert.equal( classifyRecaptureRouteOutcome( {
		allowEmpty: true,
	} ).status, 'empty-allowed' );
	assert.deepEqual( classifyRecaptureRouteOutcome( {
		timedOut: true,
	} ).failures.map( ( failure ) => failure.code ), [ 'NO_CAPTURE_ACTIVITY' ] );
	assert.deepEqual( classifyRecaptureRouteOutcome( {
		timedOut: true,
		captureStarts: 1,
	} ).failures.map( ( failure ) => failure.code ), [ 'NO_ACCEPTED_CAPTURE' ] );
	assert.deepEqual( classifyRecaptureRouteOutcome( {
		timedOut: true,
		failedCaptures: 1,
	} ).failures.map( ( failure ) => failure.code ), [ 'CAPTURE_FAILED' ] );
	assert.deepEqual( classifyRecaptureRouteOutcome( {
		timedOut: true,
		failedCaptures: 1,
		captureFailures: [ {
			code: 'CAPTURE_FAILED',
			shape: 'post-process',
			message: 'isolated pipeline failed',
		} ],
	} ).failures, [ {
		code: 'CAPTURE_FAILED',
		kind: 'capture',
		message: '1 capture operation(s) failed: post-process: isolated pipeline failed',
		details: [ {
			code: 'CAPTURE_FAILED',
			shape: 'post-process',
			error: 'isolated pipeline failed',
			message: 'isolated pipeline failed',
			profile: null,
			configHash: null,
		} ],
	} ] );
	assert.match(
		classifyRecaptureRouteOutcome( {
			failedCaptures: 1,
			captureFailures: [ {
				shape: 'pmrem',
				error: 'cube sampling mismatch',
				profile: 'texture-cubemap',
				configHash: 'abc123',
			} ],
		} ).failures[ 0 ].message,
		/pmrem\[texture-cubemap\]#abc123: cube sampling mismatch/,
	);
	assert.deepEqual( classifyRecaptureRouteOutcome( {
		pollingError: new Error( 'context lost' ),
	} ).failures.map( ( failure ) => failure.code ), [ 'CAPTURE_POLLING_FAILED' ] );
	assert.deepEqual( classifyRecaptureRouteOutcome( {
		captureStarts: 1,
		acceptedPosts: 1,
		routeFailures: [
			{ type: 'pageerror', message: 'boom' },
			{ type: 'console', message: 'bad log' },
			{ type: 'requestfailed', message: 'model failed' },
			{ type: 'response', message: 'HTTP 500' },
		],
	} ).failures.map( ( failure ) => failure.code ), [
		'PAGE_ERROR',
		'CONSOLE_ERROR',
		'REQUEST_FAILED',
		'HTTP_ERROR',
	] );

} );

test( 'recapture expands every explicit route across the requested backend matrix', () => {

	assert.deepEqual(
		createRecaptureRouteMatrix( [ '/', '/viewer' ], [ 'webgpu', 'webgl' ] ),
		[
			{ path: '/', requestedBackend: 'webgpu' },
			{ path: '/viewer', requestedBackend: 'webgpu' },
			{ path: '/', requestedBackend: 'webgl' },
			{ path: '/viewer', requestedBackend: 'webgl' },
		],
	);
	assert.deepEqual( createRecaptureRouteMatrix( [ '/legacy' ] ), [
		{ path: '/legacy', requestedBackend: null },
	] );

} );

test( 'recapture derives verifier and retry argv from the exact effective project inputs', () => {

	const options = parseRecaptureArgs( [
		'--json',
		'--url', 'http://127.0.0.1:5199',
		'--paths', '/first,/second',
		'--backends', 'webgpu,webgl',
		'--source', 'client/main.ts',
		'--source', 'client/materials.ts',
		'--source-root', '../..',
		'--artifacts', 'generated/tsl',
		'--no-auto-mark',
		'--auto-mark-prefix', 'shader',
	] );
	assert.deepEqual(
		createRecaptureVerifyArgv( options, {
			nodeExecutable: '/absolute/node',
			verifyCli: '/absolute/verify.js',
		} ),
		[
			'/absolute/node',
			'/absolute/verify.js',
			'--json',
			'--source',
			'client/main.ts',
			'--source',
			'client/materials.ts',
			'--source-root',
			'../..',
			'--no-auto-mark',
			'--auto-mark-prefix',
			'shader',
			'generated/tsl',
		],
	);
	const retry = createRecaptureRetryArgv( options, {
		nodeExecutable: '/absolute/node',
		recaptureCli: '/absolute/recapture.js',
		headless: false,
	} );
	assert.deepEqual( retry.slice( 0, 4 ), [
		'/absolute/node',
		'/absolute/recapture.js',
		'--json',
		'--url',
	] );
	assert.equal( retry.includes( '--no-headless' ), true );
	assert.deepEqual( retry.slice( retry.indexOf( '--backends' ), retry.indexOf( '--backends' ) + 2 ), [
		'--backends',
		'webgpu,webgl',
	] );
	assert.equal( retry.includes( 'client/materials.ts' ), true );
	assert.equal( retry.includes( 'generated/tsl' ), true );
	assert.equal( retry.includes( '--no-auto-mark' ), true );

} );

test( 'recapture CLI parser rejects unknown, missing, and invalid options', () => {

	for ( const args of [
		[ '--unknown' ],
		[ '--timeout' ],
		[ '--timeout=abc' ],
		[ '--timeout=Infinity' ],
		[ '--timeout=0' ],
		[ '--settle=-1' ],
		[ '--paths=/' + ',' ],
		[ '--backends=' ],
		[ '--backends=webgpu,' ],
		[ '--backends=webgpu,webgpu' ],
		[ '--backends=webgpu,webgl1' ],
		[ '--url=not-a-url' ],
		[ '--browser=safari' ],
		[ '--source' ],
		[ '--source-root=' ],
		[ '--artifacts' ],
		[ '--auto-mark-prefix=' ],
	] ) {

		assert.throws( () => parseRecaptureArgs( args ), undefined, args.join( ' ' ) );

	}

} );

test( 'recapture browser-launch JSON uses the installed Playwright CLI and preserves retry context', () => {

	const missingBrowsers = resolve( REPO, '.test-missing-playwright-browsers' );
	const result = spawnSync(
		process.execPath,
		[
			CLI,
			'--json',
			'--browser',
			'webkit',
			'--source',
			'client/main.ts',
			'--source-root',
			'project',
			'--artifacts',
			'generated/tsl',
		],
		{
			cwd: REPO,
			encoding: 'utf8',
			env: {
				...process.env,
				PLAYWRIGHT_BROWSERS_PATH: missingBrowsers,
			},
		},
	);
	assert.equal( result.status, 1, result.stderr );
	const report = JSON.parse( result.stdout );
	assert.equal( report.command, 'tsl-precompile-recapture' );
	assert.equal( report.issues[ 0 ].code, 'BROWSER_LAUNCH_FAILED' );
	const install = report.nextActions.find( ( action ) => action.code === 'install-webkit-browser' );
	assert.equal( install.kind, 'command' );
	assert.equal( install.cwd, REPO );
	assert.equal( install.argv[ 0 ], process.execPath );
	assert.equal( existsSync( install.argv[ 1 ] ), true );
	assert.deepEqual( install.argv.slice( 2 ), [ 'install', 'webkit' ] );
	const retry = report.nextActions.find( ( action ) => action.code === 'retry-recapture' );
	assert.deepEqual( retry.dependsOn, [ 'install-webkit-browser' ] );
	assert.equal( retry.argv[ 0 ], process.execPath );
	assert.equal( retry.argv.includes( 'client/main.ts' ), true );
	assert.equal( retry.argv.includes( 'project' ), true );
	assert.equal( retry.argv.includes( 'generated/tsl' ), true );
	assert.equal( retry.argv.some( ( value ) => value === 'npx' || value === 'pnpm' ), false );

} );

test( 'page-init activity counter observes captures that start and finish between polls', () => {

	const pageGlobal = {};
	installRecaptureActivityCounter( pageGlobal );
	pageGlobal.__tslpPrecompilePending = 1;
	pageGlobal.__tslpPrecompilePending = 2;
	pageGlobal.__tslpPrecompilePending = 1;
	pageGlobal.__tslpPrecompilePending = 0;

	assert.equal( pageGlobal.__tslpPrecompilePending, 0 );
	assert.equal( pageGlobal.__tslpRecaptureActivity.captureStarts, 2 );
	assert.equal( pageGlobal.__tslpRecaptureActivity.acceptedPosts, 0 );
	assert.equal( pageGlobal.__tslpRecaptureActivity.failedCaptures, 0 );
	assert.deepEqual( pageGlobal.__tslpRecaptureActivity.failures, [] );
	assert.equal( pageGlobal.__tslpRecaptureActivity.maxPending, 2 );
	assert.equal( pageGlobal.__tslpRecaptureActivity.assignments, 4 );
	assert.deepEqual( pageGlobal.__tslpRecaptureActivity.rendererBackends, {
		observedRenderers: 0,
		initializedRenderers: 0,
		initFailures: 0,
		webgpu: 0,
		webgl: 0,
		unknown: 0,
	} );

} );

test( 'page-init backend observer records the initialized WebGPURenderer backend after fallback selection', async () => {

	class FakeEventTarget {

		listeners = new Map();

		addEventListener( type, listener ) {

			const listeners = this.listeners.get( type ) || [];
			listeners.push( listener );
			this.listeners.set( type, listeners );

		}

		dispatchEvent( event ) {

			for ( const listener of this.listeners.get( event.type ) || [] ) listener( event );
			return true;

		}

	}

	const pageGlobal = { EventTarget: FakeEventTarget };
	installRecaptureActivityCounter( pageGlobal );
	const renderer = {
		isWebGPURenderer: true,
		initialized: false,
		backend: { isWebGPUBackend: true },
		async init() {

			// Model WebGPURenderer's WebGPU init rejection followed by the
			// constructor-provided WebGL fallback.
			this.backend = { isWebGLBackend: true };
			this.initialized = true;
			return this;

		},
	};
	pageGlobal.__THREE_DEVTOOLS__.dispatchEvent( { type: 'observe', detail: renderer } );
	await renderer.init();

	assert.deepEqual(
		classifyRecaptureRendererBackendEvidence( pageGlobal.__tslpRecaptureActivity.rendererBackends ),
		{
			observer: 'three-devtools-observe',
			backend: 'webgl',
			initialized: true,
			observedRenderers: 1,
			initializedRenderers: 1,
			initFailures: 0,
			backends: { webgpu: 0, webgl: 1, unknown: 0 },
		},
	);

} );

test( 'page-init backend control requests WebGL through Three\'s real fallback path', async () => {

	class FakeEventTarget {

		listeners = new Map();

		addEventListener( type, listener ) {

			const listeners = this.listeners.get( type ) || [];
			listeners.push( listener );
			this.listeners.set( type, listeners );

		}

		dispatchEvent( event ) {

			for ( const listener of this.listeners.get( event.type ) || [] ) listener( event );
			return true;

		}

	}

	let fallbackError = null;
	const pageGlobal = { EventTarget: FakeEventTarget };
	installRecaptureActivityCounter( { requestedBackend: 'webgl' }, pageGlobal );
	const renderer = {
		isWebGPURenderer: true,
		initialized: false,
		backend: {
			isWebGPUBackend: true,
			async init() {},
		},
		_getFallback( error ) {

			fallbackError = error;
			return {
				isWebGLBackend: true,
				async init() {},
			};

		},
		async init() {

			try {

				await this.backend.init( this );

			} catch ( error ) {

				this.backend = this._getFallback( error );
				await this.backend.init( this );

			}
			this.initialized = true;
			return this;

		},
	};
	pageGlobal.__THREE_DEVTOOLS__.dispatchEvent( { type: 'observe', detail: renderer } );
	await renderer.init();

	assert.equal( renderer.backend.isWebGLBackend, true );
	assert.equal( fallbackError?.code, 'TSLP_RECAPTURE_FORCE_WEBGL' );
	assert.deepEqual( pageGlobal.__tslpRecaptureActivity.backendControl, {
		requestedBackend: 'webgl',
		strategy: 'three-webgpu-fallback',
		observedRenderers: 1,
		eligibleWebgpuRenderers: 1,
		armedFallbacks: 1,
		forcedInitRejections: 1,
		alreadyWebglRenderers: 0,
		unsupportedRenderers: 0,
		errors: [],
	} );
	assert.equal( pageGlobal.__tslpRecaptureActivity.rendererBackends.webgl, 1 );
	assert.equal( pageGlobal.__tslpRecaptureActivity.rendererBackends.initFailures, 0 );

} );

test( 'page-init backend control leaves the requested WebGPU path native', () => {

	class FakeEventTarget {

		listeners = [];

		addEventListener( type, listener ) {

			if ( type === 'observe' ) this.listeners.push( listener );

		}

		dispatchEvent( event ) {

			for ( const listener of this.listeners ) listener( event );
			return true;

		}

	}

	const nativeInit = async () => {};
	const pageGlobal = { EventTarget: FakeEventTarget };
	installRecaptureActivityCounter( { requestedBackend: 'webgpu' }, pageGlobal );
	const renderer = {
		isWebGPURenderer: true,
		backend: { isWebGPUBackend: true, init: nativeInit },
		async init() {},
	};
	pageGlobal.__THREE_DEVTOOLS__.dispatchEvent( { type: 'observe', detail: renderer } );

	assert.equal( renderer.backend.init, nativeInit );
	assert.equal( pageGlobal.__tslpRecaptureActivity.backendControl.strategy, 'native-webgpu' );
	assert.equal( pageGlobal.__tslpRecaptureActivity.backendControl.armedFallbacks, 0 );

} );

test( 'recapture backend evidence accepts WebGPU and fails closed for uninitialized or unknown renderers', async () => {

	const webgpu = classifyRecaptureRendererBackendEvidence( {
		observedRenderers: 1,
		initializedRenderers: 1,
		webgpu: 1,
	} );
	assert.equal( webgpu.backend, 'webgpu' );
	assert.equal( webgpu.initialized, true );

	const missing = classifyRecaptureRendererBackendEvidence( {
		observedRenderers: 1,
		initializedRenderers: 1,
		unknown: 1,
	} );
	assert.equal( missing.backend, 'uninitialized' );
	assert.equal( missing.initialized, false );
	assert.deepEqual( missing.backends, { webgpu: 0, webgl: 0, unknown: 1 } );

} );

test( 'recapture backend gate accepts WebGL2 without navigator.gpu and preserves legacy WebGPU failures when neither backend starts', () => {

	const forceWebGL = classifyRecaptureRendererBackendGate( {
		evidence: {
			observedRenderers: 1,
			initializedRenderers: 1,
			webgl: 1,
		},
		webgpuAvailable: false,
		browserName: 'chromium',
		path: '/force-webgl',
	} );
	assert.equal( forceWebGL.ok, true );
	assert.equal( forceWebGL.rendererBackend.backend, 'webgl' );
	assert.deepEqual( forceWebGL.failures, [] );

	const missing = classifyRecaptureRendererBackendGate( {
		evidence: { observedRenderers: 1 },
		webgpuAvailable: false,
		browserName: 'chromium',
		path: '/missing',
	} );
	assert.equal( missing.ok, false );
	assert.equal( missing.status, 'webgpu-unavailable' );
	assert.deepEqual( missing.failures.map( ( failure ) => failure.code ), [
		'WEBGPU_UNAVAILABLE',
		'RENDERER_BACKEND_UNINITIALIZED',
	] );
	assert.match( missing.failures[ 0 ].message, /navigator\.gpu/ );

} );

test( 'explicit recapture backend gates require an exact post-init backend match', () => {

	const exactWebGL = classifyRecaptureRendererBackendGate( {
		evidence: {
			observedRenderers: 1,
			initializedRenderers: 1,
			webgl: 1,
		},
		backendControl: { unsupportedRenderers: 0 },
		expectedBackend: 'webgl',
		webgpuAvailable: true,
		path: '/viewer',
	} );
	assert.equal( exactWebGL.ok, true );

	const fallbackInsteadOfWebGPU = classifyRecaptureRendererBackendGate( {
		evidence: {
			observedRenderers: 1,
			initializedRenderers: 1,
			webgl: 1,
		},
		expectedBackend: 'webgpu',
		webgpuAvailable: false,
		browserName: 'chromium',
		path: '/viewer',
	} );
	assert.equal( fallbackInsteadOfWebGPU.ok, false );
	assert.equal( fallbackInsteadOfWebGPU.status, 'renderer-backend-mismatch' );
	assert.deepEqual( fallbackInsteadOfWebGPU.failures.map( ( failure ) => failure.code ), [
		'WEBGPU_UNAVAILABLE',
		'RENDERER_BACKEND_MISMATCH',
	] );

	const mixed = classifyRecaptureRendererBackendGate( {
		evidence: {
			observedRenderers: 2,
			initializedRenderers: 2,
			webgpu: 1,
			webgl: 1,
		},
		expectedBackend: 'webgl',
		webgpuAvailable: true,
		path: '/mixed',
	} );
	assert.equal( mixed.ok, false );
	assert.equal( mixed.failures.at( - 1 ).code, 'RENDERER_BACKEND_MISMATCH' );

	const webglUninitialized = classifyRecaptureRendererBackendGate( {
		evidence: { observedRenderers: 1 },
		expectedBackend: 'webgl',
		webgpuAvailable: false,
		path: '/missing',
	} );
	assert.deepEqual( webglUninitialized.failures.map( ( failure ) => failure.code ), [
		'RENDERER_BACKEND_UNINITIALIZED',
	] );

} );

test( 'recapture completion requires activity, allows empty routes, and settles known failures', () => {

	assert.equal( captureCanSettle( {
		pending: 0,
		captureStarts: 0,
		allowEmpty: false,
		idleMs: 5000,
		settle: 1000,
	} ), false );
	assert.equal( captureCanSettle( {
		pending: 0,
		captureStarts: 1,
		acceptedPosts: 1,
		allowEmpty: false,
		idleMs: 1000,
		settle: 1000,
	} ), true );
	assert.equal( captureCanSettle( {
		pending: 0,
		captureStarts: 0,
		allowEmpty: true,
		idleMs: 1000,
		settle: 1000,
	} ), true );
	assert.equal( captureCanSettle( {
		pending: 1,
		captureStarts: 1,
		acceptedPosts: 1,
		allowEmpty: false,
		idleMs: 5000,
		settle: 1000,
	} ), false );
	assert.equal( captureCanSettle( {
		pending: 0,
		captureStarts: 1,
		acceptedPosts: 0,
		allowEmpty: false,
		idleMs: 5000,
		settle: 1000,
	} ), false );
	assert.equal( captureCanSettle( {
		pending: 0,
		captureStarts: 1,
		acceptedPosts: 1,
		failedCaptures: 1,
		allowEmpty: true,
		idleMs: 5000,
		settle: 1000,
	} ), true );

} );

test( 'recapture executable rejects invalid numeric input before loading Playwright', () => {

	const result = spawnSync(
		process.execPath,
		[ CLI, '--timeout=abc' ],
		{ cwd: REPO, encoding: 'utf8' },
	);
	assert.equal( result.status, 1 );
	assert.match( result.stderr, /finite positive number/ );
	assert.doesNotMatch( result.stderr, /Playwright is required/ );

} );

test( 'recapture executable keeps invalid JSON invocations machine-readable', () => {

	const result = spawnSync(
		process.execPath,
		[ CLI, '--json', '--timeout=abc' ],
		{ cwd: REPO, encoding: 'utf8' },
	);
	assert.equal( result.status, 1 );
	assert.equal( result.stderr, '' );
	const parsed = JSON.parse( result.stdout );
	assert.equal( parsed.schemaVersion, 1 );
	assert.equal( parsed.ok, false );
	assert.equal( parsed.status, 'failed' );
	assert.equal( parsed.command, 'tsl-precompile-recapture' );
	assert.equal( parsed.issues[ 0 ].code, 'INVALID_ARGUMENTS' );
	assert.equal( parsed.nextActions[ 0 ].kind, 'command' );
	assert.equal( parsed.nextActions[ 0 ].code, 'show-help' );
	assert.equal( parsed.nextActions[ 0 ].cwd, REPO );
	assert.deepEqual( parsed.nextActions[ 0 ].argv, [ process.execPath, CLI, '--help' ] );
	assert.deepEqual( parsed.nextActions[ 0 ].commands, [ parsed.nextActions[ 0 ].argv ] );
	const [ command, ...args ] = parsed.nextActions[ 0 ].argv;
	const followup = spawnSync( command, args, {
		cwd: parsed.nextActions[ 0 ].cwd,
		encoding: 'utf8',
	} );
	assert.equal( followup.status, 0 );
	assert.match( followup.stdout, /Usage: tsl-precompile-recapture/ );

} );

test( 'recapture JSON help remains one machine-readable result', () => {

	const run = spawnSync( process.execPath, [ CLI, '--json', '--help' ], { encoding: 'utf8' } );
	assert.equal( run.status, 0 );
	assert.equal( run.stderr, '' );
	const report = JSON.parse( run.stdout );
	assert.equal( report.schemaVersion, 1 );
	assert.equal( report.ok, true );
	assert.equal( report.status, 'help' );
	assert.equal( report.command, 'tsl-precompile-recapture' );
	assert.deepEqual( report.nextActions, [] );
	assert.match( report.help, /--allow-empty/ );
	assert.match( report.help, /--backends/ );

} );

test( 'cold Vite dependency-optimization reload is accepted after an aborted goto', async () => {

	let gotoCalls = 0;
	let waitCalls = 0;
	const page = {
		async goto() {

			gotoCalls ++;
			throw new Error( 'page.goto: net::ERR_ABORTED at http://127.0.0.1:5199/' );

		},
		async waitForLoadState() {

			waitCalls ++;

		},
		url() {

			return 'http://127.0.0.1:5199/';

		},
	};
	const result = await navigateWithColdReloadRetry( page, 'http://127.0.0.1:5199/', { timeout: 1000 } );

	assert.deepEqual( result, { response: null, retries: 1, recoveredReload: true } );
	assert.equal( gotoCalls, 1 );
	assert.equal( waitCalls, 1 );
	assert.equal( isTransientRecaptureNavigationError( new Error( 'Execution context was destroyed' ) ), true );

} );

test( 'recapture network policy ignores only exact same-origin favicon failures', () => {

	const pageUrl = 'http://127.0.0.1:5199/example';
	assert.equal( classifyRecaptureResourceFailure( {
		kind: 'response',
		status: 404,
		url: 'http://127.0.0.1:5199/favicon.ico',
	}, pageUrl ), null );
	for ( const url of [
		'http://127.0.0.1:5199/assets/favicon.ico',
		'http://127.0.0.1:5199/favicon.ico?v=1',
		'http://localhost:5199/favicon.ico',
		'https://example.invalid/favicon.ico',
	] ) {

		assert.match( classifyRecaptureResourceFailure( {
			kind: 'response',
			status: 404,
			url,
		}, pageUrl ), /HTTP 404/ );

	}
	assert.match( classifyRecaptureResourceFailure( {
		kind: 'response',
		method: 'POST',
		status: 500,
		url: 'http://127.0.0.1:5199/favicon.ico',
	}, pageUrl ), /HTTP 500/ );

} );

test( 'recapture correlates Chromium URL-less console duplicates only after an exact favicon failure', () => {

	const pageUrl = 'http://127.0.0.1:5199/example';
	const faviconFailure = {
		kind: 'response',
		method: 'GET',
		status: 404,
		url: 'http://127.0.0.1:5199/favicon.ico',
	};
	assert.equal( isExactRecaptureFaviconFailure( faviconFailure, pageUrl ), true );
	assert.equal( isExactRecaptureFaviconFailure( {
		...faviconFailure,
		url: 'http://127.0.0.1:5199/assets/favicon.ico',
	}, pageUrl ), false );

	const consoleError = {
		level: 'error',
		message: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
		url: '',
	};
	assert.equal( isCorrelatedRecaptureFaviconConsoleError( consoleError, pageUrl ), false );
	assert.equal( isCorrelatedRecaptureFaviconConsoleError(
		consoleError,
		pageUrl,
		{ networkFailureObserved: true },
	), true );
	assert.equal( isCorrelatedRecaptureFaviconConsoleError( {
		...consoleError,
		url: 'http://127.0.0.1:5199/favicon.ico',
	}, pageUrl ), true );
	assert.equal( isCorrelatedRecaptureFaviconConsoleError( {
		...consoleError,
		message: 'application failed while handling favicon',
		url: 'http://127.0.0.1:5199/favicon.ico',
	}, pageUrl ), false );

} );

test( 'recapture network policy fails resource errors without misclassifying redirects or data URLs', () => {

	assert.match( classifyRecaptureResourceFailure( {
		kind: 'requestfailed',
		message: 'net::ERR_FAILED',
		url: 'http://127.0.0.1:5199/model.glb',
	}, 'http://127.0.0.1:5199/' ), /requestfailed/ );
	assert.equal( classifyRecaptureResourceFailure( {
		kind: 'response',
		status: 308,
		url: 'http://127.0.0.1:5199/redirect',
	}, 'http://127.0.0.1:5199/' ), null );
	assert.equal( classifyRecaptureResourceFailure( {
		kind: 'requestfailed',
		message: 'aborted',
		url: 'data:image/png;base64,AA==',
	}, 'http://127.0.0.1:5199/' ), null );

} );

test( 'recapture navigation rejects an HTTP error response', async () => {

	await assert.rejects(
		navigateWithColdReloadRetry( {
			async goto() {

				return { status: () => 404 };

			},
		}, 'http://127.0.0.1:5199/missing', { timeout: 1000 } ),
		/navigation returned HTTP 404/,
	);

} );

test( 'cold reload navigation retries when the replacement document does not settle', async () => {

	let gotoCalls = 0;
	const response = { ok: true };
	const page = {
		async goto() {

			gotoCalls ++;
			if ( gotoCalls === 1 ) throw new Error( 'Navigation was interrupted by another one' );
			return response;

		},
		async waitForLoadState() {

			throw new Error( 'Execution context was destroyed' );

		},
		url() {

			return 'about:blank';

		},
	};
	const result = await navigateWithColdReloadRetry( page, 'http://127.0.0.1:5199/', { timeout: 1000 } );

	assert.equal( result.response, response );
	assert.equal( result.retries, 1 );
	assert.equal( result.recoveredReload, true );
	assert.equal( gotoCalls, 2 );

} );

test( 'mid-poll cold reload uses bounded navigation retry after a second interruption', async () => {

	let gotoCalls = 0;
	let waitCalls = 0;
	const response = { ok: true };
	const page = {
		async waitForLoadState() {

			waitCalls ++;
			throw new Error( 'Timeout 1000ms exceeded while waiting for load state' );

		},
		async goto() {

			gotoCalls ++;
			if ( gotoCalls === 1 ) throw new Error( 'page.goto: net::ERR_ABORTED' );
			return response;

		},
		url() {

			return 'about:blank';

		},
	};
	const result = await recoverColdReloadDuringPolling(
		page,
		'http://127.0.0.1:5199/',
		{ timeout: 1000, maxRetries: 2 },
	);
	assert.equal( result.response, response );
	assert.equal( result.retries, 1 );
	assert.equal( result.recoveredReload, true );
	assert.equal( gotoCalls, 2 );
	assert.equal( waitCalls, 2, 'one poll recovery wait plus one bounded navigation-retry wait' );

} );

test( 'successful replacement documents discard only abandoned-document errors', () => {

	const tracker = createRecaptureFailureTracker();
	tracker.record( 1, 'console', 'cold dependency document failed' );
	tracker.markStable( 2 );
	assert.equal( tracker.hasFailures(), false );
	tracker.record( 2, 'pageerror', 'replacement document failed' );
	assert.equal( tracker.hasFailures(), true );
	assert.deepEqual( tracker.currentFailures().map( ( failure ) => failure.message ), [ 'replacement document failed' ] );

} );

test( 'recapture navigation does not hide ordinary page failures', async () => {

	const expected = new Error( 'page.goto: net::ERR_CONNECTION_REFUSED' );
	const page = {
		async goto() {

			throw expected;

		},
	};
	await assert.rejects(
		navigateWithColdReloadRetry( page, 'http://127.0.0.1:5199/', { timeout: 1000 } ),
		( error ) => error === expected,
	);

} );
