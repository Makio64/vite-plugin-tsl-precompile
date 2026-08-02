#!/usr/bin/env node
/**
 * Automated browser recapture CLI.
 *
 * Human mode preserves the historical progress output. `--json` reserves
 * stdout for one schema-versioned result and mirrors progress to stderr so
 * coding agents never have to scrape ANSI logs.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	captureCanSettle,
	classifyRecaptureResourceFailure,
	classifyRecaptureRendererBackendEvidence,
	classifyRecaptureRendererBackendGate,
	classifyRecaptureRouteOutcome,
	createRecaptureFailureTracker,
	createRecaptureRouteMatrix,
	createRecaptureRetryArgv,
	createRecaptureVerifyArgv,
	installRecaptureActivityCounter,
	isCorrelatedRecaptureFaviconConsoleError,
	isExactRecaptureFaviconFailure,
	isTransientRecaptureNavigationError,
	navigateWithColdReloadRetry,
	parseRecaptureArgs,
	recaptureBrowserLaunchOptions,
	RECAPTURE_HELP,
	RECAPTURE_VIEWPORT,
	recoverColdReloadDuringPolling,
} from './recapture-support.js';

const rawArgs = process.argv.slice( 2 );
const requestedJson = rawArgs.includes( '--json' );
const recaptureCli = fileURLToPath( import.meta.url );
const verifyCli = fileURLToPath( new URL( './verify.js', import.meta.url ) );
const require = createRequire( import.meta.url );

function progress( message ) {

	if ( requestedJson ) console.error( message );
	else console.log( message );

}

function warning( message ) {

	console.error( message );

}

function finishBeforeBrowser( code, message, nextActions = [] ) {

	const normalizedNextActions = nextActions.map( ( action, index ) => action.kind
		? action
		: commandAction( {
				code: action.code || `${ code.toLowerCase() }-${ index + 1 }`,
				message: action.message,
				argv: action.argv,
			} ) );
	if ( requestedJson ) {

		console.log( JSON.stringify( {
			schemaVersion: 1,
			ok: false,
			status: 'failed',
			command: 'tsl-precompile-recapture',
			routes: [],
			issues: [ { code, message } ],
			nextActions: normalizedNextActions,
		}, null, 2 ) );

	} else {

		warning( `\x1b[31m[tsl-precompile] Error: ${ message }\x1b[0m` );
		for ( const action of normalizedNextActions ) {

			if ( action.message ) warning( `[tsl-precompile] ${ action.message }` );
			if ( Array.isArray( action.argv ) ) warning( `  ${ action.argv.join( ' ' ) }` );

		}

	}
	process.exit( 1 );

}

let options;
try {

	options = parseRecaptureArgs( rawArgs );

} catch ( error ) {

	const message = error.message || String( error );
	if ( ! requestedJson ) warning( 'Use -h or --help for usage.' );
	finishBeforeBrowser( 'INVALID_ARGUMENTS', message, [ commandAction( {
		code: 'show-help',
		message: 'Run tsl-precompile-recapture --help and correct the arguments.',
		argv: [ process.execPath, recaptureCli, '--help' ],
	} ) ] );

}
if ( options.help ) {

	if ( requestedJson ) console.log( JSON.stringify( {
		schemaVersion: 1,
		ok: true,
		status: 'help',
		command: 'tsl-precompile-recapture',
		help: RECAPTURE_HELP.trim(),
		nextActions: [],
	}, null, 2 ) );
	else console.log( RECAPTURE_HELP );
	process.exit( 0 );

}

const { url, paths, backends, timeout, settle, headless, browserName, allowEmpty } = options;
const routeMatrix = createRecaptureRouteMatrix( paths, backends );
const report = {
	schemaVersion: 1,
	ok: false,
	status: 'running',
	command: 'tsl-precompile-recapture',
	startedAt: new Date().toISOString(),
	baseUrl: url,
	browser: {
		name: browserName,
		headless,
		webgpuPreflight: 'navigator.gpu',
		rendererBackendObserver: 'three-devtools-observe',
	},
	options: {
		paths,
		backends: backends === null ? [ 'app-selected' ] : [ ...backends ],
		timeoutMs: timeout,
		settleMs: settle,
		allowEmpty,
		verification: {
			sources: [ ...options.sources ],
			sourceRoot: options.sourceRoot,
			artifacts: options.artifacts,
			autoMark: options.autoMark,
			autoMarkPrefix: options.autoMarkPrefix,
		},
	},
	routes: [],
	issues: [],
	nextActions: [],
};

let playwright;
try {

	playwright = await import( 'playwright' );

} catch {

	const installAction = createPlaywrightPackageAction();
	finishBeforeBrowser(
		'PLAYWRIGHT_MISSING',
		'Playwright is required for automated recapture.',
		[
			installAction,
			commandAction( {
				code: 'retry-recapture',
				message: 'Retry recapture after installing Playwright with the project package manager.',
				argv: createRecaptureRetryArgv( options, {
					nodeExecutable: process.execPath,
					recaptureCli,
				} ),
				dependsOn: [ installAction.code ],
			} ),
		],
	);

}

const browserType = playwright[ browserName ];
if ( ! browserType ) {

	finishBeforeBrowser(
		'UNSUPPORTED_BROWSER',
		`Unsupported browser type "${ browserName }". Supported: chromium, firefox, webkit.`,
	);

}

const browserLaunchOptions = recaptureBrowserLaunchOptions( browserName, { headless } );

progress( `[tsl-precompile] Launching ${ browserName }...` );
let browser;
try {

	browser = await browserType.launch( browserLaunchOptions );

} catch ( error ) {

	finishBeforeBrowser(
		'BROWSER_LAUNCH_FAILED',
		`Could not launch ${ browserName }: ${ error.message || error }`,
		createBrowserLaunchActions( error, options ),
	);

}

let hasFailures = false;

try {

	for ( const { path, requestedBackend } of routeMatrix ) {

		const routeStarted = Date.now();
		const fullUrl = url.replace( /\/$/, '' ) + '/' + path.replace( /^\//, '' );
		const routeLabel = requestedBackend === null ? path : `${ path } [${ requestedBackend }]`;
		const route = {
			path,
			url: fullUrl,
			requestedBackend: requestedBackend || 'app-selected',
			ok: false,
			status: 'running',
			startedAt: new Date().toISOString(),
			elapsedMs: 0,
			webgpu: {
				available: null,
				backend: 'uninitialized',
			},
			rendererBackend: classifyRecaptureRendererBackendEvidence(),
			backendControl: null,
			capture: {
				pending: 0,
				starts: 0,
				acceptedPosts: 0,
				failedCaptures: 0,
				failureDetails: [],
			},
			coldReload: {
				recoveries: 0,
				retries: 0,
			},
			failures: [],
		};
		report.routes.push( route );
		progress( `[tsl-precompile] Navigating to ${ fullUrl } for ${ route.requestedBackend }...` );

		let context = null;
		let page = null;
		try {

			context = await browser.newContext( {
				viewport: { ...RECAPTURE_VIEWPORT },
			} );
			await context.addInitScript( installRecaptureActivityCounter, { requestedBackend } );
			page = await context.newPage();
			let navigationEpoch = 0;
			let pendingExactFaviconConsoleError = false;
			const routeFailureTracker = createRecaptureFailureTracker();
			page.on( 'framenavigated', ( frame ) => {

				if ( frame === page.mainFrame() ) navigationEpoch ++;

			} );
			page.on( 'pageerror', ( error ) => {

				const message = error.stack || error.message || String( error );
				warning( `\x1b[31m[page-error] ${ message }\x1b[0m` );
				routeFailureTracker.record( navigationEpoch, 'pageerror', message );

			} );
			page.on( 'console', ( message ) => {

				const type = message.type();
				const text = message.text();
				let location = null;
				try {

					location = message.location();

				} catch {

					location = null;

				}
				if ( type === 'error' ) {

					if ( isCorrelatedRecaptureFaviconConsoleError( {
						level: type,
						message: text,
						url: location && location.url || '',
					}, fullUrl, { networkFailureObserved: pendingExactFaviconConsoleError } ) ) {

						pendingExactFaviconConsoleError = false;
						return;

					}
					warning( `\x1b[31m[console-error] ${ text }\x1b[0m` );
					routeFailureTracker.record( navigationEpoch, 'console', text );

				} else if ( text.includes( '[tsl-precompile]' ) ) {

					progress( `[page] ${ text }` );

				}

			} );
			page.on( 'requestfailed', ( request ) => {

				const event = {
					kind: 'requestfailed',
					method: request.method(),
					url: request.url(),
					message: request.failure()?.errorText || 'unknown network failure',
				};
				if ( isExactRecaptureFaviconFailure( event, fullUrl ) ) pendingExactFaviconConsoleError = true;
				const failure = classifyRecaptureResourceFailure( event, fullUrl );
				if ( failure ) {

					warning( `\x1b[31m[request-failed] ${ failure }\x1b[0m` );
					routeFailureTracker.record( navigationEpoch, 'requestfailed', failure );

				}

			} );
			page.on( 'response', ( response ) => {

				const event = {
					kind: 'response',
					method: response.request().method(),
					status: response.status(),
					url: response.url(),
				};
				if ( isExactRecaptureFaviconFailure( event, fullUrl ) ) pendingExactFaviconConsoleError = true;
				const failure = classifyRecaptureResourceFailure( event, fullUrl );
				if ( failure ) {

					warning( `\x1b[31m[response-error] ${ failure }\x1b[0m` );
					routeFailureTracker.record( navigationEpoch, 'response', failure );

				}

			} );

			try {

				const navigation = await navigateWithColdReloadRetry( page, fullUrl, { timeout: timeout * 2 } );
				route.coldReload.retries += navigation.retries;
				if ( navigation.recoveredReload ) {

					route.coldReload.recoveries ++;
					progress( `[tsl-precompile] Recovered ${ navigation.retries } cold dependency-optimization reload${ navigation.retries === 1 ? '' : 's' } on ${ routeLabel }.` );

				}
				routeFailureTracker.markStable( navigationEpoch );

			} catch ( error ) {

				const message = `Failed to navigate to ${ fullUrl } (${ error.message || error })`;
				warning( `\x1b[31m[tsl-precompile] Error: ${ message }\x1b[0m` );
				warning( 'Please ensure your dev server is running before executing this tool.' );
				route.status = 'navigation-failed';
				route.failures.push( {
					code: 'NAVIGATION_FAILED',
					kind: 'navigation',
					message,
				} );
				hasFailures = true;
				continue;

			}

			let webgpuPreflightError = null;
			try {

				route.webgpu.available = await page.evaluate( () => navigator.gpu != null );

			} catch ( error ) {

				route.webgpu.available = false;
				webgpuPreflightError = `Could not evaluate browser WebGPU support: ${ error.message || error }`;
				route.webgpu.preflightError = webgpuPreflightError;

			}

			const start = Date.now();
			let lastActive = Date.now();
			let observedCaptureStarts = 0;
			let observedAcceptedPosts = 0;
			let observedFailedCaptures = 0;
			let observedCaptureFailures = [];
			let observedPending = 0;
			let observedRendererBackends = null;
			let observedBackendControl = null;
			let observedNavigationEpoch = navigationEpoch;
			let pollingError = null;
			let settled = false;

			progress( `[tsl-precompile] Waiting for captures on ${ routeLabel }...` );
			while ( Date.now() - start < timeout ) {

				if ( observedNavigationEpoch !== navigationEpoch ) {

					observedNavigationEpoch = navigationEpoch;
					lastActive = Date.now();
					observedCaptureStarts = 0;
					observedAcceptedPosts = 0;
					observedFailedCaptures = 0;
					observedCaptureFailures = [];
					observedPending = 0;
					observedRendererBackends = null;
					observedBackendControl = null;

				}

				let captureState;
				try {

					captureState = await page.evaluate( () => ( {
						pending: window.__tslpPrecompilePending | 0,
						captureStarts: window.__tslpRecaptureActivity?.captureStarts | 0,
						acceptedPosts: window.__tslpRecaptureActivity?.acceptedPosts | 0,
						failedCaptures: window.__tslpRecaptureActivity?.failedCaptures | 0,
						failures: Array.isArray( window.__tslpRecaptureActivity?.failures )
							? window.__tslpRecaptureActivity.failures.slice( - 20 )
							: [],
						rendererBackends: window.__tslpRecaptureActivity?.rendererBackends || null,
						backendControl: window.__tslpRecaptureActivity?.backendControl || null,
					} ) );

				} catch ( error ) {

					if ( isTransientRecaptureNavigationError( error ) ) {

						lastActive = Date.now();
						try {

							const remaining = Math.max( 1, timeout - ( Date.now() - start ) );
							const recovery = await recoverColdReloadDuringPolling( page, fullUrl, { timeout: remaining } );
							route.coldReload.recoveries ++;
							route.coldReload.retries += recovery.retries || 0;
							routeFailureTracker.markStable( navigationEpoch );
							observedNavigationEpoch = navigationEpoch;
							observedCaptureStarts = 0;
							observedAcceptedPosts = 0;
							observedFailedCaptures = 0;
							observedCaptureFailures = [];
							observedPending = 0;
							observedRendererBackends = null;
							observedBackendControl = null;

						} catch ( reloadError ) {

							pollingError = reloadError;
							break;

						}
						continue;

					}
					pollingError = error;
					break;

				}
				observedPending = captureState.pending;
				observedRendererBackends = captureState.rendererBackends;
				observedBackendControl = captureState.backendControl;
				if ( captureState.captureStarts > 0 && observedCaptureStarts === 0 ) lastActive = Date.now();
				observedCaptureStarts = Math.max( observedCaptureStarts, captureState.captureStarts );
				observedAcceptedPosts = Math.max( observedAcceptedPosts, captureState.acceptedPosts );
				observedFailedCaptures = Math.max( observedFailedCaptures, captureState.failedCaptures );
				if ( captureState.failures.length >= observedCaptureFailures.length ) {

					observedCaptureFailures = captureState.failures;

				}
				if ( observedPending > 0 ) {

					lastActive = Date.now();

				} else if ( classifyRecaptureRendererBackendEvidence( observedRendererBackends ).initialized && captureCanSettle( {
					pending: observedPending,
					captureStarts: observedCaptureStarts,
					acceptedPosts: observedAcceptedPosts,
					failedCaptures: observedFailedCaptures,
					allowEmpty,
					idleMs: Date.now() - lastActive,
					settle,
				} ) ) {

					settled = true;
					break;

				}
				await new Promise( ( resolvePromise ) => setTimeout( resolvePromise, 200 ) );

			}

			const captureElapsed = Date.now() - start;
			const backendGate = classifyRecaptureRendererBackendGate( {
				evidence: observedRendererBackends,
				backendControl: observedBackendControl,
				expectedBackend: requestedBackend,
				webgpuAvailable: route.webgpu.available,
				webgpuPreflightError,
				browserName,
				path,
			} );
			route.rendererBackend = backendGate.rendererBackend;
			route.backendControl = observedBackendControl;
			route.webgpu.backend = route.rendererBackend.backend;
			route.capture = {
				pending: observedPending,
				starts: observedCaptureStarts,
				acceptedPosts: observedAcceptedPosts,
				failedCaptures: observedFailedCaptures,
				failureDetails: observedCaptureFailures,
				elapsedMs: captureElapsed,
			};
			const outcome = classifyRecaptureRouteOutcome( {
				pollingError,
				timedOut: ! settled && ! pollingError,
				captureStarts: observedCaptureStarts,
				acceptedPosts: observedAcceptedPosts,
				failedCaptures: observedFailedCaptures,
				captureFailures: observedCaptureFailures,
				allowEmpty,
				routeFailures: routeFailureTracker.currentFailures(),
			} );
			route.failures.push( ...backendGate.failures );
			route.ok = outcome.ok && backendGate.ok;
			route.status = backendGate.ok
				? outcome.status
				: backendGate.status;
			route.failures.push( ...outcome.failures );
			hasFailures ||= ! route.ok;

			if ( pollingError ) {

				warning( `\x1b[31m[tsl-precompile] Error: capture polling failed on ${ routeLabel } (${ pollingError.message || pollingError })\x1b[0m` );

			} else if ( ! settled ) {

				const failure = outcome.failures.find( ( item ) => item.kind === 'capture' );
				warning( `\x1b[33m[tsl-precompile] Warning: ${ failure?.message || 'capture did not settle' } within ${ timeout }ms on ${ routeLabel }.\x1b[0m` );

			} else if ( outcome.ok ) {

				progress( `[tsl-precompile] Page ${ routeLabel } capture complete in ${ captureElapsed }ms (captureStarts=${ observedCaptureStarts }, acceptedPosts=${ observedAcceptedPosts }, backend=${ route.rendererBackend.backend }).` );

			} else if ( ! requestedJson ) {

				for ( const failure of outcome.failures ) warning(
					`\x1b[31m[tsl-precompile] ${ routeLabel } ${ failure.code || 'CAPTURE_FAILED' }: ${ failure.message }\x1b[0m`,
				);

			}

		} catch ( error ) {

			const message = error.message || String( error );
			warning( `\x1b[31m[tsl-precompile] Error: unexpected recapture failure on ${ routeLabel } (${ message })\x1b[0m` );
			route.status = 'route-failed';
			route.failures.push( {
				code: 'ROUTE_FAILED',
				kind: 'route',
				message,
			} );
			hasFailures = true;

		} finally {

			route.elapsedMs = Date.now() - routeStarted;
			route.finishedAt = new Date().toISOString();
			if ( route.status === 'running' ) route.status = 'route-failed';
			if ( route.failures.length > 0 ) route.ok = false;
			await page?.close().catch( () => {} );
			await context?.close().catch( () => {} );

		}

	}

} finally {

	await browser.close();

}

report.ok = ! hasFailures && report.routes.every( ( route ) => route.ok );
report.status = report.ok ? 'passed' : 'failed';
report.finishedAt = new Date().toISOString();
report.backendCoverage = summarizeBackendCoverage( report.routes, backends );
if ( report.ok ) {

	report.nextActions.push( commandAction( {
		code: 'verify-source-coverage',
		message: 'Run source-aware verification; accepted recapture activity alone does not prove marker coverage.',
		argv: createRecaptureVerifyArgv( options, {
			nodeExecutable: process.execPath,
			verifyCli,
		} ),
	} ) );

} else {

	for ( const route of report.routes ) {

		for ( const failure of route.failures ) report.issues.push( {
			route: route.path,
			requestedBackend: route.requestedBackend,
			...failure,
		} );

	}
	report.nextActions.push( ...createRouteFailureActions( report, options ) );

}

if ( requestedJson ) {

	console.log( JSON.stringify( report, null, 2 ) );

} else if ( report.ok ) {

	console.log( '\x1b[32m[tsl-precompile] Recapture process completed successfully.\x1b[0m' );
	console.log( '[tsl-precompile] Next: run source-aware verification, for example:' );
	console.log( '  tsl-precompile-verify --source src --source-root . artifacts' );

} else {

	console.error( '\x1b[31m[tsl-precompile] Recapture process completed with errors.\x1b[0m' );

}
process.exit( report.ok ? 0 : 1 );

function summarizeBackendCoverage( routes, requestedBackends ) {

	const requested = requestedBackends === null ? [ 'app-selected' ] : [ ...requestedBackends ];
	const byBackend = Object.fromEntries( requested.map( ( backend ) => {

		const matchingRoutes = routes.filter( ( route ) => route.requestedBackend === backend );
		return [ backend, {
			routes: matchingRoutes.length,
			passed: matchingRoutes.filter( ( route ) => route.ok ).length,
			failed: matchingRoutes.filter( ( route ) => ! route.ok ).length,
			observed: [ ...new Set( matchingRoutes.map( ( route ) => route.rendererBackend.backend ) ) ],
		} ];

	} ) );
	return {
		mode: requestedBackends === null ? 'app-selected' : 'explicit',
		requested,
		byBackend,
	};

}

function commandAction( { code, message, argv, dependsOn = [] } ) {

	return {
		kind: 'command',
		code,
		message,
		reason: message,
		action: message,
		cwd: process.cwd(),
		argv: [ ...argv ],
		commands: [ [ ...argv ] ],
		...( dependsOn.length > 0 ? { dependsOn: [ ...dependsOn ] } : {} ),
	};

}

function manualAction( {
	code,
	message,
	dependsOn = [],
	requiresInput = [],
	context = null,
} ) {

	return {
		kind: 'manual',
		code,
		message,
		reason: message,
		action: message,
		cwd: process.cwd(),
		argv: null,
		...( dependsOn.length > 0 ? { dependsOn: [ ...dependsOn ] } : {} ),
		...( requiresInput.length > 0 ? { requiresInput: [ ...requiresInput ] } : {} ),
		...( context === null ? {} : { context } ),
	};

}

function createPlaywrightPackageAction() {

	const manager = detectProjectPackageManager( process.cwd() );
	const argvByManager = {
		pnpm: [ 'pnpm', 'add', '-D', 'playwright' ],
		npm: [ 'npm', 'install', '--save-dev', 'playwright' ],
		yarn: [ 'yarn', 'add', '--dev', 'playwright' ],
		bun: [ 'bun', 'add', '--dev', 'playwright' ],
	};
	if ( manager ) return commandAction( {
		code: 'install-playwright-package',
		message: `Install Playwright with the detected ${ manager } project package manager.`,
		argv: argvByManager[ manager ],
	} );
	return manualAction( {
		code: 'install-playwright-package',
		message: 'Choose the lockfile that owns this application and install Playwright as a development dependency with that package manager.',
		requiresInput: [ 'packageManager' ],
		context: {
			allowedPackageManagers: Object.keys( argvByManager ),
			argvByPackageManager: argvByManager,
		},
	} );

}

function createBrowserLaunchActions( error, currentOptions ) {

	const message = error?.message || String( error );
	if ( /executable (?:doesn't|does not) exist|browser.*not found/i.test( message ) ) {

		const installCode = `install-${ currentOptions.browserName }-browser`;
		const playwrightCli = resolvePlaywrightCli();
		const installAction = playwrightCli
			? commandAction( {
					code: installCode,
					message: `Install the requested ${ currentOptions.browserName } browser with this exact Playwright package.`,
					argv: [ process.execPath, playwrightCli, 'install', currentOptions.browserName ],
				} )
			: manualAction( {
					code: installCode,
					message: `Resolve the installed Playwright CLI and install its ${ currentOptions.browserName } browser binary.`,
					requiresInput: [ 'playwrightCli' ],
				} );
		return [
			installAction,
			commandAction( {
				code: 'retry-recapture',
				message: 'Retry recapture after the requested browser binary is installed.',
				argv: createRecaptureRetryArgv( currentOptions, {
					nodeExecutable: process.execPath,
					recaptureCli,
				} ),
				dependsOn: [ installCode ],
			} ),
		];

	}
	if ( currentOptions.headless ) return [ commandAction( {
		code: 'retry-headful',
		message: 'Retry in a visible browser when the headless browser cannot launch in this environment.',
		argv: createRecaptureRetryArgv( currentOptions, {
			nodeExecutable: process.execPath,
			recaptureCli,
			headless: false,
		} ),
	} ) ];
	return [ manualAction( {
		code: 'inspect-browser-launch',
		message: 'Inspect the browser launch error and make a WebGPU-capable browser available before retrying the exact recapture command.',
		context: { browser: currentOptions.browserName, error: message },
	} ) ];

}

function createRouteFailureActions( currentReport, currentOptions ) {

	const codes = new Set( currentReport.issues.map( ( issue ) => issue.code ) );
	const actions = [];
	if ( codes.has( 'NAVIGATION_FAILED' ) ) {

		actions.push( manualAction( {
			code: 'start-dev-server',
			message: `Start the application's existing development server and confirm that ${ currentReport.baseUrl } is reachable.`,
		} ) );
		actions.push( commandAction( {
			code: 'retry-recapture',
			message: 'Retry the exact recapture request after the development server is reachable.',
			argv: createRecaptureRetryArgv( currentOptions, {
				nodeExecutable: process.execPath,
				recaptureCli,
			} ),
			dependsOn: [ 'start-dev-server' ],
		} ) );

	}
	if ( codes.has( 'WEBGPU_UNAVAILABLE' ) || codes.has( 'WEBGPU_PREFLIGHT_FAILED' ) ) {

		if ( currentOptions.headless ) actions.push( commandAction( {
			code: 'retry-headful',
			message: 'Retry the exact route set in a visible browser to obtain a WebGPU device.',
			argv: createRecaptureRetryArgv( currentOptions, {
				nodeExecutable: process.execPath,
				recaptureCli,
				headless: false,
			} ),
		} ) );
		else actions.push( manualAction( {
			code: 'provide-webgpu-browser',
			message: 'Make navigator.gpu available in this visible browser or rerun on a WebGPU-capable machine.',
			context: { browser: currentOptions.browserName },
		} ) );

	}
	if ( codes.has( 'RENDERER_BACKEND_UNINITIALIZED' ) ) actions.push( manualAction( {
		code: 'initialize-renderer-backend',
		message: 'Ensure the route constructs and initializes WebGPURenderer with either its WebGPU backend or its WebGL2 backend before capture settles.',
	} ) );
	if ( codes.has( 'RENDERER_BACKEND_MISMATCH' ) ) actions.push( manualAction( {
		code: 'fix-renderer-backend-selection',
		message: 'Inspect each issue\'s requestedBackend and backend-control evidence. Ensure every route can initialize WebGPURenderer on that backend; do not hard-code forceWebGL for the WebGPU pass or bypass Three\'s WebGPU-to-WebGL fallback.',
		context: {
			mismatches: currentReport.issues
				.filter( ( issue ) => issue.code === 'RENDERER_BACKEND_MISMATCH' )
				.map( ( issue ) => ( {
					route: issue.route,
					requestedBackend: issue.requestedBackend,
				} ) ),
		},
	} ) );
	const captureCodes = [
		'NO_CAPTURE_ACTIVITY',
		'NO_ACCEPTED_CAPTURE',
		'CAPTURE_FAILED',
		'CAPTURE_POLLING_FAILED',
	];
	if ( captureCodes.some( ( code ) => codes.has( code ) ) ) {

		actions.push( commandAction( {
			code: 'verify-source-coverage',
			message: 'Run source-aware verification to identify exact missing or stale marker ownership before recapturing.',
			argv: createRecaptureVerifyArgv( currentOptions, {
				nodeExecutable: process.execPath,
				verifyCli,
			} ),
		} ) );
		actions.push( manualAction( {
			code: 'inspect-capture-route',
			message: 'Inspect the coded route failures, render every intended material/topology, and fix capture errors before retrying.',
			context: {
				routes: currentReport.issues
					.filter( ( issue ) => captureCodes.includes( issue.code ) )
					.map( ( issue ) => issue.route ),
			},
		} ) );

	}
	if ( [ 'PAGE_ERROR', 'CONSOLE_ERROR', 'REQUEST_FAILED', 'HTTP_ERROR', 'ROUTE_FAILED' ]
		.some( ( code ) => codes.has( code ) ) ) {

		actions.push( manualAction( {
			code: 'fix-route-errors',
			message: 'Fix the reported page, console, request, or route errors before treating recapture as valid.',
		} ) );

	}
	if ( actions.length === 0 ) actions.push( manualAction( {
		code: 'inspect-recapture-failure',
		message: 'Inspect the coded recapture issues and resolve them before retrying.',
	} ) );
	return dedupeActions( actions );

}

function dedupeActions( actions ) {

	const seen = new Set();
	return actions.filter( ( action ) => {

		if ( seen.has( action.code ) ) return false;
		seen.add( action.code );
		return true;

	} );

}

function detectProjectPackageManager( cwd ) {

	const candidates = [
		{ manager: 'pnpm', files: [ 'pnpm-lock.yaml' ] },
		{ manager: 'npm', files: [ 'package-lock.json' ] },
		{ manager: 'yarn', files: [ 'yarn.lock' ] },
		{ manager: 'bun', files: [ 'bun.lock', 'bun.lockb' ] },
	];
	let current = resolve( cwd );
	while ( true ) {

		const found = candidates.filter( ( candidate ) =>
			candidate.files.some( ( file ) => existsSync( resolve( current, file ) ) )
		);
		if ( found.length === 1 ) return found[ 0 ].manager;
		if ( found.length > 1 ) return null;
		const parent = dirname( current );
		if ( parent === current || current === parse( current ).root ) return null;
		current = parent;

	}

}

function resolvePlaywrightCli() {

	try {

		const packageJsonPath = require.resolve( 'playwright/package.json' );
		const manifest = require( packageJsonPath );
		const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.playwright;
		return typeof bin === 'string' ? resolve( dirname( packageJsonPath ), bin ) : null;

	} catch {

		return null;

	}

}
