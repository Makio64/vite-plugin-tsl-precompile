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
export const PRODUCTION_CANARY_CAPTURE_STATES = Object.freeze( [
	Object.freeze( { id: 'pose-a', rotation: Object.freeze( [ 0.2, 0.35 ] ) } ),
	Object.freeze( { id: 'pose-b', rotation: Object.freeze( [ 1.1, 1.55 ] ) } ),
] );

export function collectCanaryRuntimeEvidence() {

	const root = globalThis;
	const render = root.__TSLP_CANARY_RENDER_EVIDENCE__;
	const samples = Array.isArray( root.__tslpHarnessDiagnostics?.objectUboSamples )
		? root.__tslpHarnessDiagnostics.objectUboSamples
		: [];
	const matrices = samples.flatMap( ( sample ) => {

		const slot = Array.isArray( sample?.slots )
			? sample.slots.find( ( entry ) => entry?.sourceKind === 'object.worldMatrix' )
			: null;
		return slot && Array.isArray( slot.floats )
			? [ { phase: sample.phase, value: slot.floats.slice() } ]
			: [];

	} );
	const phaseSummary = ( phase ) => {

		const values = matrices.filter( ( entry ) => entry.phase === phase ).map( ( entry ) => entry.value );
		return {
			count: values.length,
			first: values[ 0 ] || null,
			last: values.at( - 1 ) || null,
			distinct: new Set( values.map( ( value ) => JSON.stringify( value ) ) ).size,
		};

	};
	return {
		render: render && typeof render === 'object' ? {
			renderFrames: Number( render.renderFrames ) || 0,
			naturalRenderFrames: Number( render.naturalRenderFrames ) || 0,
			controlledRenderFrames: Number( render.controlledRenderFrames ) || 0,
			controlled: render.controlled === true,
			rotation: Array.isArray( render.rotation ) ? render.rotation.slice() : null,
			worldMatrix: Array.isArray( render.worldMatrix ) ? render.worldMatrix.slice() : null,
		} : null,
		objectUbo: {
			sampleCount: samples.length,
			update: phaseSummary( 'update' ),
			upload: phaseSummary( 'upload' ),
		},
	};

}

export async function settleCanaryPresentation( capture ) {

	const renderAt = globalThis.__TSLP_CANARY_RENDER_AT__;
	if ( typeof renderAt !== 'function' ) {

		throw new Error( 'Production canary is missing its deterministic render hook.' );

	}
	const expectedRotation = Array.isArray( capture?.rotation ) ? capture.rotation : [];
	if ( typeof capture?.id !== 'string' || capture.id.length === 0 ) {

		throw new Error( 'Production canary capture state requires an id.' );

	}
	if ( ! Number.isSafeInteger( capture?.fenceTimeoutMs ) || capture.fenceTimeoutMs < 1 ) {

		throw new Error( 'Production canary capture state requires a positive fence timeout.' );

	}
	if ( expectedRotation.length !== 2 || expectedRotation.some( ( value ) => ! Number.isFinite( value ) ) ) {

		throw new Error( 'Production canary capture state requires two finite rotation values.' );

	}
	const objectUboSamples = globalThis.__tslpHarnessDiagnostics?.objectUboSamples;
	const discardedObjectUboSamples = Array.isArray( objectUboSamples ) ? objectUboSamples.length : 0;
	if ( Array.isArray( objectUboSamples ) ) objectUboSamples.length = 0;
	let timeoutId;
	let renderWork;
	try {

		renderWork = await Promise.race( [
			renderAt( capture ),
			new Promise( ( _, rejectTimeout ) => {

				timeoutId = setTimeout( () => rejectTimeout( new Error(
					`Production canary ${ capture.id } backend fence did not complete within ${ capture.fenceTimeoutMs }ms.`,
				) ), capture.fenceTimeoutMs );

			} ),
		] );

	} finally {

		if ( timeoutId !== undefined ) clearTimeout( timeoutId );

	}
	if ( ! renderWork || ! [ 'webgpu', 'webgl' ].includes( renderWork.backend ) ) {

		throw new Error( 'Production canary render-work fence returned invalid backend evidence.' );

	}
	const expectedMethod = renderWork.backend === 'webgpu'
		? 'GPUQueue.onSubmittedWorkDone'
		: 'WebGL2RenderingContext.finish';
	if ( renderWork.method !== expectedMethod ) {

		throw new Error(
			`Production canary ${ renderWork.backend } render-work fence did not use ${ expectedMethod }().`,
		);

	}
	if ( renderWork.captureId !== capture.id ) {

		throw new Error( 'Production canary deterministic render did not acknowledge the requested capture id.' );

	}
	if ( renderWork.pausedNaturalRendering !== true ) {

		throw new Error( 'Production canary deterministic render did not pause natural submissions.' );

	}
	if ( renderWork.fenceCompleted !== true ) {

		throw new Error( 'Production canary deterministic render did not complete its backend fence.' );

	}
	if (
		! Array.isArray( renderWork.requestedRotation ) ||
		renderWork.requestedRotation.length !== expectedRotation.length ||
		renderWork.requestedRotation.some( ( value, index ) => value !== expectedRotation[ index ] )
	) {

		throw new Error( 'Production canary deterministic render did not acknowledge the requested rotation.' );

	}
	if (
		! Array.isArray( renderWork.rotation ) ||
		renderWork.rotation.length !== expectedRotation.length ||
		renderWork.rotation.some( ( value, index ) => value !== expectedRotation[ index ] )
	) {

		throw new Error( 'Production canary deterministic render did not apply the requested rotation.' );

	}
	if ( ! Number.isSafeInteger( renderWork.naturalRenderFrames ) || renderWork.naturalRenderFrames < 1 ) {

		throw new Error( 'Production canary deterministic control started before natural rendering was proven.' );

	}
	if ( ! Number.isSafeInteger( renderWork.controlledRenderFrames ) || renderWork.controlledRenderFrames < 1 ) {

		throw new Error( 'Production canary deterministic control did not render its requested pose.' );

	}
	if ( ! Number.isSafeInteger( renderWork.submittedRenderFrames ) || renderWork.submittedRenderFrames < 1 ) {

		throw new Error( 'Production canary render-work fence did not cover a rendered frame.' );

	}
	if (
		! Number.isSafeInteger( renderWork.completedRenderFrames ) ||
		renderWork.completedRenderFrames !== renderWork.submittedRenderFrames
	) {

		throw new Error( 'Production canary submitted additional renders while deterministic control was paused.' );

	}
	if ( typeof requestAnimationFrame !== 'function' ) {

		throw new Error( 'Production canary cannot schedule compositor animation frames.' );

	}
	await new Promise( ( resolveFrames ) => requestAnimationFrame( () => {

		requestAnimationFrame( resolveFrames );

	} ) );
	return {
		...renderWork,
		discardedObjectUboSamples,
		compositorAnimationFrames: 2,
	};

}

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
		options: { channel: 'chromium', headless, args: [ ...args ] },
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
	const canaryFenceTimeoutMs = Math.max( 1, Math.min( 15_000, Math.floor( timeoutMs / 2 ) ) );
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
	if ( route.domain.type === 'canary' ) await context.addInitScript( () => {

		globalThis.__TSLP_DEBUG_OBJECT_UBO = true;

	} );
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
	let canaryRuntimeEvidence = null;
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
		const firstSettleEvidence = route.domain.type === 'canary'
			? await page.evaluate( settleCanaryPresentation, {
				...PRODUCTION_CANARY_CAPTURE_STATES[ 0 ],
				fenceTimeoutMs: canaryFenceTimeoutMs,
			} )
			: null;
		const firstRuntimeEvidence = route.domain.type === 'canary'
			? await page.evaluate( collectCanaryRuntimeEvidence )
			: null;
		const firstFrame = await canvas.screenshot();
		let secondFrame = null;
		if ( route.domain.type === 'canary' ) {

			const secondSettleEvidence = await page.evaluate(
				settleCanaryPresentation,
				{
					...PRODUCTION_CANARY_CAPTURE_STATES[ 1 ],
					fenceTimeoutMs: canaryFenceTimeoutMs,
				},
			);
			const secondRuntimeEvidence = await page.evaluate( collectCanaryRuntimeEvidence );
			canaryRuntimeEvidence = {
				first: { ...firstRuntimeEvidence, settle: firstSettleEvidence },
				second: { ...secondRuntimeEvidence, settle: secondSettleEvidence },
			};
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
		canaryRuntimeEvidence,
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
