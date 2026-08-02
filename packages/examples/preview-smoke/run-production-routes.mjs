#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

import {
	BROWSER_FAILURE_POLICY_SHA256,
	installBrowserFailureCollector,
} from '../browser-failure-policy.mjs';
import { evidenceBrowserLaunchArgs } from '../batch/e2e-environment.mjs';
import {
	analyzePngFrames,
	primaryCanvasLocator,
} from '../visual-pixel-evidence.mjs';
import { createRecapturePlan } from '../../plugin/src/cli/recapture-plan.js';
import {
	createProductionRouteReport,
	productionRouteFailures,
} from './production-route-contract.mjs';
import {
	classifyRecaptureRendererBackendEvidence,
	installRecaptureActivityCounter,
	RECAPTURE_VIEWPORT,
} from '../../plugin/src/cli/recapture-support.js';

const REPO = resolve( import.meta.dirname, '../../..' );
const CAPTURE_REQUEST = /(?:__tsl-precompile|__tslp__.*capture)/i;
export const PRODUCTION_BROWSER_BASE_ARGS = Object.freeze( [
	'--enable-unsafe-webgpu',
	'--ignore-gpu-blocklist',
	'--no-sandbox',
	'--disable-dev-shm-usage',
] );
export const PRODUCTION_PREVIEW_VIEWPORT = Object.freeze( { width: 1280, height: 800 } );

function parseArgs( args ) {

	let example = null;
	let baseUrl = null;
	for ( let index = 0; index < args.length; index ++ ) {

		const arg = args[ index ];
		if ( arg === '--example' || arg.startsWith( '--example=' ) ) {

			const inline = arg.startsWith( '--example=' ) ? arg.slice( '--example='.length ) : null;
			example = inline === null ? args[ ++ index ] : inline;
			if ( ! example || example.startsWith( '-' ) ) throw new Error( '--example requires a configured example name.' );
			continue;

		}
		if ( arg === '--base-url' || arg.startsWith( '--base-url=' ) ) {

			const inline = arg.startsWith( '--base-url=' ) ? arg.slice( '--base-url='.length ) : null;
			baseUrl = inline === null ? args[ ++ index ] : inline;
			if ( ! baseUrl || baseUrl.startsWith( '-' ) ) throw new Error( '--base-url requires an HTTP(S) URL.' );
			continue;

		}
		throw new Error( `Unknown production preview option: ${ arg }` );

	}
	if ( ! example ) throw new Error( '--example is required.' );
	if ( ! baseUrl ) throw new Error( '--base-url is required.' );
	const parsedBaseUrl = new URL( baseUrl );
	if ( ! [ 'http:', 'https:' ].includes( parsedBaseUrl.protocol ) ) {

		throw new Error( '--base-url must use HTTP(S).' );

	}
	return {
		example,
		baseUrl: parsedBaseUrl,
	};

}

export function createProductionBrowserLaunchPlan( {
	platform = process.platform,
	headless = true,
} = {} ) {

	const args = evidenceBrowserLaunchArgs( PRODUCTION_BROWSER_BASE_ARGS, platform );
	const bundled = {
		channel: 'playwright-chromium',
		options: { headless, args: [ ...args ] },
	};
	const system = {
		channel: 'chrome',
		options: { channel: 'chrome', headless, args: [ ...args ] },
	};

	// Bind Linux CI to Playwright's installed Chromium revision so its software
	// adapter behavior is reproducible. On macOS, retain system Chrome first:
	// bundled Chromium can initialize Metal WebGPU yet render a blank surface.
	return platform === 'linux' ? [ bundled, system ] : [ system, bundled ];

}

export async function launchProductionBrowser( chromiumApi = chromium, options = {} ) {

	const failures = [];
	for ( const candidate of createProductionBrowserLaunchPlan( options ) ) {

		try {

			return await chromiumApi.launch( candidate.options );

		} catch ( error ) {

			failures.push( `${ candidate.channel }: ${ error?.message || error }` );

		}

	}
	throw new Error( `Could not launch a production preview browser (${ failures.join( '; ' ) }).` );

}

async function probeRoute( browser, baseUrl, route, timeoutMs ) {

	const pageUrl = new URL( route.path, baseUrl ).href;
	const context = await browser.newContext( {
		// Deliberately differ from the capture viewport. Renderer-output replay
		// must bind the live target through the variant family, not accidentally
		// succeed by globally matching stale captured extent hints.
		viewport: { ...PRODUCTION_PREVIEW_VIEWPORT },
		deviceScaleFactor: 1,
	} );
	if ( route.requestedBackend ) await context.addInitScript(
		installRecaptureActivityCounter,
		{ requestedBackend: route.requestedBackend },
	);
	const page = await context.newPage();
	const collector = installBrowserFailureCollector( page, { pageUrl } );
	const captureRequests = [];
	page.on( 'request', ( request ) => {

		if ( CAPTURE_REQUEST.test( request.url() ) ) captureRequests.push( request.url() );

	} );

	let siteResult = null;
	let pixelEvidence = null;
	let webgpu = false;
	let rendererBackends = null;
	const failures = [];
	let browserFailures = [];
	try {

		await page.goto( pageUrl, {
			waitUntil: 'networkidle',
			timeout: timeoutMs,
		} );
		await page.waitForFunction( ( expected ) => {

			const value = window.__TSLP_SITE_RESULT__;
			if ( value?.id !== expected.receiptId || value.ready !== true ) return false;
			const domain = value.domain;
			if ( expected.domainType === 'canary' ) return value.runtimeMode === 'pure-slim' &&
				value.compilerFree === true &&
				value.canvasCount === 1 &&
				value.animationFrames > 0;
			if ( expected.domainType === 'vsm' ) return domain?.type === 'vsm' &&
				domain.schedulerCalls > 0 &&
					domain.complete === true &&
					domain.rendered === true &&
					domain.lights === 1 &&
					domain.outputBound === true &&
					domain.renderFrames > 0;
			return domain?.type === 'pmrem' &&
					domain.generated === true &&
					domain.isPMREMTexture === true &&
					domain.outputBound === true &&
					domain.renderFrames > 0;

		}, {
			receiptId: route.receiptId,
			domainType: route.domain.type,
		}, { timeout: timeoutMs } );
		( { siteResult, webgpu, rendererBackends } = await page.evaluate( () => {

			const result = window.__TSLP_SITE_RESULT__;
			return {
				siteResult: result ? {
					...result,
					errors: Array.isArray( result.errors ) ? [ ...result.errors ] : result.errors,
					domain: result.domain ? {
						...result.domain,
						unsupported: Array.isArray( result.domain.unsupported )
							? [ ...result.domain.unsupported ]
							: result.domain.unsupported,
					} : result.domain,
				} : null,
				webgpu: Boolean( navigator.gpu ),
				rendererBackends: window.__tslpRecaptureActivity?.rendererBackends || null,
			};

		} ) );
		const canvas = await primaryCanvasLocator( page );
		await canvas.waitFor( { state: 'visible', timeout: timeoutMs } );
		await page.waitForTimeout( 250 );
		const firstFrame = await canvas.screenshot();
		let secondFrame = null;
		if ( route.domain.type === 'canary' ) {

			await page.waitForTimeout( 250 );
			secondFrame = await canvas.screenshot();

		}
		pixelEvidence = await analyzePngFrames( page, firstFrame, secondFrame );

	} catch ( error ) {

		failures.push( error?.message || String( error ) );

	} finally {

		browserFailures = collector.failures();
		collector.dispose();
		await context.close();

	}

	const observation = {
		path: route.path,
		requestedBackend: route.requestedBackend || 'app-selected',
		rendererBackend: classifyRecaptureRendererBackendEvidence( rendererBackends ),
		webgpu,
		siteResult,
		captureRequests,
		browserFailures,
		pixelEvidence,
	};
	failures.push( ...productionRouteFailures( route, observation ) );
	return {
		path: route.path,
		ok: failures.length === 0,
		...observation,
		failures,
	};

}

export async function runProductionRoutes( args = process.argv.slice( 2 ) ) {

	const options = parseArgs( args );
	const example = createRecapturePlan( REPO ).find( ( entry ) => entry.name === options.example );
	if ( ! example ) throw new Error( `Unknown recapture example: ${ options.example }` );
	if ( example.productionPreviewRoutes.length === 0 ) throw new Error(
		`Recapture example ${ options.example } has no production preview routes.`,
	);

	const timeoutMs = example.timeout || 45_000;
	let browser = null;
	const routes = [];
	try {

		browser = await launchProductionBrowser();
		for ( const route of example.productionPreviewRoutes ) {

			const result = await probeRoute( browser, options.baseUrl, route, timeoutMs );
			routes.push( result );
			console.log(
				`[production-preview:${ example.name }] ${ route.path }${ route.requestedBackend ? ` [${ route.requestedBackend }]` : '' }: ` +
				`${ result.ok ? 'PASS' : `FAIL — ${ result.failures.join( '; ' ) }` }`,
			);

		}
		const report = createProductionRouteReport( example.name, routes, {
			browserFailurePolicySha256: BROWSER_FAILURE_POLICY_SHA256,
			browserVersion: await browser.version(),
		} );
		console.log( `[production-preview:report] ${ JSON.stringify( report ) }` );
		if ( ! report.ok ) throw new Error(
			`${ routes.filter( ( route ) => ! route.ok ).length } production preview route(s) failed for ${ example.name }.`,
		);
		return report;

	} finally {

		await browser?.close();

	}

}

const isDirectInvocation = process.argv[ 1 ] &&
	pathToFileURL( resolve( process.argv[ 1 ] ) ).href === import.meta.url;
if ( isDirectInvocation ) {

	runProductionRoutes().catch( ( error ) => {

		console.error( `[production-preview] FAIL: ${ error?.stack || error }` );
		process.exitCode = 1;

	} );

}
