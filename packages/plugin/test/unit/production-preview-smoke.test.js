import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
	createProductionRouteReport,
	PRODUCTION_CANARY_PIXEL_THRESHOLDS,
	productionRouteFailures,
} from '../../../examples/preview-smoke/production-route-contract.mjs';
import {
	collectCanaryRuntimeEvidence,
	createProductionBrowserLaunchPlan,
	launchProductionBrowser,
	PRODUCTION_BROWSER_BASE_ARGS,
	PRODUCTION_CANARY_CAPTURE_STATES,
	PRODUCTION_PREVIEW_VIEWPORT,
	settleCanaryPresentation,
} from '../../../examples/preview-smoke/run-production-routes.mjs';
import {
	evidenceBrowserLaunchArgs,
	LINUX_SWIFTSHADER_BROWSER_ARGS,
} from '../../../examples/batch/e2e-environment.mjs';
import { RECAPTURE_VIEWPORT } from '../../src/cli/recapture-support.js';

const REPO = resolve( import.meta.dirname, '../../../..' );
const PIXELS = Object.freeze( {
	width: 640,
	height: 480,
	pixelCount: 307_200,
	sampleCount: 4_800,
	rgbDeviation: 20,
	luminanceDeviation: 12,
	luminanceRange: 80,
	contentFraction: 0.5,
	framesCompared: false,
	changedFraction: null,
	meanFrameDelta: null,
} );

test( 'production canary summarizes changing render and object UBO evidence', () => {

	const previousRender = globalThis.__TSLP_CANARY_RENDER_EVIDENCE__;
	const previousDiagnostics = globalThis.__tslpHarnessDiagnostics;
	try {

		globalThis.__TSLP_CANARY_RENDER_EVIDENCE__ = {
			renderFrames: 9,
			naturalRenderFrames: 7,
			controlledRenderFrames: 2,
			controlled: true,
			rotation: [ 0.4, 0.6 ],
			worldMatrix: [ 1, 0, 0, 1 ],
		};
		const sample = ( phase, value ) => ( {
			phase,
			slots: [ { sourceKind: 'object.worldMatrix', floats: [ value, 0, 0, 1 ] } ],
		} );
		globalThis.__tslpHarnessDiagnostics = {
			objectUboSamples: [
				sample( 'update', 1 ),
				sample( 'upload', 1 ),
				sample( 'update', 2 ),
				sample( 'upload', 2 ),
			],
		};

		const evidence = collectCanaryRuntimeEvidence();
		assert.equal( evidence.render.renderFrames, 9 );
		assert.equal( evidence.render.naturalRenderFrames, 7 );
		assert.equal( evidence.render.controlledRenderFrames, 2 );
		assert.equal( evidence.render.controlled, true );
		assert.deepEqual( evidence.render.rotation, [ 0.4, 0.6 ] );
		assert.deepEqual( evidence.objectUbo.update, {
			count: 2,
			first: [ 1, 0, 0, 1 ],
			last: [ 2, 0, 0, 1 ],
			distinct: 2,
		} );
		assert.equal( evidence.objectUbo.upload.distinct, 2 );

	} finally {

		if ( previousRender === undefined ) delete globalThis.__TSLP_CANARY_RENDER_EVIDENCE__;
		else globalThis.__TSLP_CANARY_RENDER_EVIDENCE__ = previousRender;
		if ( previousDiagnostics === undefined ) delete globalThis.__tslpHarnessDiagnostics;
		else globalThis.__tslpHarnessDiagnostics = previousDiagnostics;

	}

} );

test( 'production canary deterministically renders and fences before two compositor frames', async () => {

	const previousRenderAt = globalThis.__TSLP_CANARY_RENDER_AT__;
	const previousAnimationFrame = globalThis.requestAnimationFrame;
	const previousDiagnostics = globalThis.__tslpHarnessDiagnostics;
	const events = [];
	const capture = { ...PRODUCTION_CANARY_CAPTURE_STATES[ 0 ], fenceTimeoutMs: 250 };
	try {

		globalThis.__tslpHarnessDiagnostics = { objectUboSamples: [ { phase: 'natural' }, { phase: 'natural' } ] };
		globalThis.__TSLP_CANARY_RENDER_AT__ = async ( requestedCapture ) => {

			events.push( `render:${ requestedCapture.id }:samples=${ globalThis.__tslpHarnessDiagnostics.objectUboSamples.length }` );
			return {
				backend: 'webgpu',
				method: 'GPUQueue.onSubmittedWorkDone',
				captureId: requestedCapture.id,
				pausedNaturalRendering: true,
				fenceCompleted: true,
				requestedRotation: requestedCapture.rotation.slice(),
				rotation: requestedCapture.rotation.slice(),
				naturalRenderFrames: 10,
				controlledRenderFrames: 1,
				submittedRenderFrames: 12,
				completedRenderFrames: 12,
			};

		};
		globalThis.requestAnimationFrame = ( callback ) => {

			events.push( 'raf' );
			callback();
			return events.length;

		};
		assert.deepEqual( await settleCanaryPresentation( capture ), {
			backend: 'webgpu',
			method: 'GPUQueue.onSubmittedWorkDone',
			captureId: 'pose-a',
			pausedNaturalRendering: true,
			fenceCompleted: true,
			requestedRotation: [ 0.2, 0.35 ],
			rotation: [ 0.2, 0.35 ],
			naturalRenderFrames: 10,
			controlledRenderFrames: 1,
			submittedRenderFrames: 12,
			completedRenderFrames: 12,
			discardedObjectUboSamples: 2,
			compositorAnimationFrames: 2,
		} );
		assert.deepEqual( events, [ 'render:pose-a:samples=0', 'raf', 'raf' ] );

	} finally {

		if ( previousRenderAt === undefined ) delete globalThis.__TSLP_CANARY_RENDER_AT__;
		else globalThis.__TSLP_CANARY_RENDER_AT__ = previousRenderAt;
		if ( previousAnimationFrame === undefined ) delete globalThis.requestAnimationFrame;
		else globalThis.requestAnimationFrame = previousAnimationFrame;
		if ( previousDiagnostics === undefined ) delete globalThis.__tslpHarnessDiagnostics;
		else globalThis.__tslpHarnessDiagnostics = previousDiagnostics;

	}

} );

test( 'production canary deterministic render fails closed and accepts WebGL evidence', async () => {

	const previousRenderAt = globalThis.__TSLP_CANARY_RENDER_AT__;
	const previousAnimationFrame = globalThis.requestAnimationFrame;
	const capture = { ...PRODUCTION_CANARY_CAPTURE_STATES[ 1 ], fenceTimeoutMs: 250 };
	try {

		globalThis.requestAnimationFrame = ( callback ) => { callback(); return 1; };
		delete globalThis.__TSLP_CANARY_RENDER_AT__;
		await assert.rejects( settleCanaryPresentation( capture ), /missing its deterministic render hook/ );

		globalThis.__TSLP_CANARY_RENDER_AT__ = async () => ( {
			backend: 'webgpu',
			method: 'unavailable',
			captureId: capture.id,
			pausedNaturalRendering: true,
			fenceCompleted: true,
			requestedRotation: capture.rotation.slice(),
			rotation: capture.rotation.slice(),
			naturalRenderFrames: 3,
			controlledRenderFrames: 1,
			submittedRenderFrames: 1,
			completedRenderFrames: 1,
		} );
		await assert.rejects( settleCanaryPresentation( capture ), /did not use GPUQueue\.onSubmittedWorkDone/ );

		globalThis.__TSLP_CANARY_RENDER_AT__ = async () => ( {
			backend: 'webgl',
			method: 'WebGL2RenderingContext.finish',
			captureId: capture.id,
			pausedNaturalRendering: true,
			fenceCompleted: true,
			requestedRotation: capture.rotation.slice(),
			rotation: capture.rotation.slice(),
			naturalRenderFrames: 3,
			controlledRenderFrames: 1,
			submittedRenderFrames: 4,
			completedRenderFrames: 4,
		} );
		const webgl = await settleCanaryPresentation( capture );
		assert.equal( webgl.backend, 'webgl' );
		assert.equal( webgl.compositorAnimationFrames, 2 );

		globalThis.__TSLP_CANARY_RENDER_AT__ = async () => new Promise( () => {} );
		await assert.rejects(
			settleCanaryPresentation( { ...capture, fenceTimeoutMs: 10 } ),
			/backend fence did not complete within 10ms/,
		);

	} finally {

		if ( previousRenderAt === undefined ) delete globalThis.__TSLP_CANARY_RENDER_AT__;
		else globalThis.__TSLP_CANARY_RENDER_AT__ = previousRenderAt;
		if ( previousAnimationFrame === undefined ) delete globalThis.requestAnimationFrame;
		else globalThis.requestAnimationFrame = previousAnimationFrame;

	}

} );

test( 'production preview exercises a viewport distinct from capture', () => {

	assert.deepEqual( RECAPTURE_VIEWPORT, { width: 1280, height: 720 } );
	assert.deepEqual( PRODUCTION_PREVIEW_VIEWPORT, { width: 1280, height: 800 } );
	assert.notDeepEqual( PRODUCTION_PREVIEW_VIEWPORT, RECAPTURE_VIEWPORT );

} );

function observation( route, domain ) {

	return {
		path: route.path,
		requestedBackend: route.requestedBackend || 'app-selected',
		rendererBackend: route.requestedBackend ? {
			initialized: true,
			backend: route.requestedBackend,
		} : null,
		webgpu: true,
		siteResult: {
			id: route.receiptId,
			ready: true,
			runtimeMode: 'pure-slim',
			compilerFree: true,
			canvasCount: 1,
			errors: [],
			domain,
		},
		captureRequests: [],
		browserFailures: [],
		pixelEvidence: PIXELS,
	};

}

test( 'production preview uses recapture-compatible native WebGPU flags on Darwin', () => {

	const plan = createProductionBrowserLaunchPlan( { platform: 'darwin' } );
	assert.equal( plan[ 0 ].channel, 'chrome' );
	assert.equal( plan[ 0 ].options.channel, 'chrome' );
	assert.deepEqual( plan[ 0 ].options.args, [ ...PRODUCTION_BROWSER_BASE_ARGS ] );
	for ( const candidate of plan ) {

		assert.ok( ! candidate.options.args.some( ( arg ) => /vulkan|swiftshader/i.test( arg ) ) );

	}

} );

test( 'production preview shares deterministic WebGPU and WebGL SwiftShader flags on Linux', () => {

	const plan = createProductionBrowserLaunchPlan( { platform: 'linux', headless: false } );
	const expectedArgs = evidenceBrowserLaunchArgs( PRODUCTION_BROWSER_BASE_ARGS, 'linux' );
	assert.equal( plan[ 0 ].channel, 'playwright-chromium' );
	assert.equal( plan[ 0 ].options.channel, 'chromium' );
	assert.equal( plan[ 0 ].options.headless, false );
	assert.equal( plan[ 1 ].channel, 'chrome' );
	assert.equal( plan[ 1 ].options.channel, 'chrome' );
	for ( const candidate of plan ) {

		assert.deepEqual( candidate.options.args, expectedArgs );
		for ( const arg of LINUX_SWIFTSHADER_BROWSER_ARGS ) {

			assert.ok( candidate.options.args.includes( arg ) );

		}
		assert.ok( candidate.options.args.includes( '--use-vulkan=swiftshader' ) );
		assert.ok( ! candidate.options.args.includes( '--enable-features=Vulkan,WebGPUService' ) );

	}

	const source = readFileSync(
		resolve( REPO, 'packages/examples/preview-smoke/run-production-routes.mjs' ),
		'utf8',
	);
	assert.match( source, /evidenceBrowserLaunchArgs\( PRODUCTION_BROWSER_BASE_ARGS, platform \)/ );
	assert.doesNotMatch( source, /enable-features=Vulkan,WebGPUService/ );

} );

test( 'production preview falls back through the platform launch plan', async () => {

	const browser = {};
	const calls = [];
	const chromium = {
		async launch( options ) {

			calls.push( options );
			if ( calls.length === 1 ) throw new Error( 'system Chrome unavailable' );
			return browser;

		},
	};
	assert.equal(
		await launchProductionBrowser( chromium, { platform: 'darwin' } ),
		browser,
	);
	assert.equal( calls.length, 2 );
	assert.equal( calls[ 0 ].channel, 'chrome' );
	assert.equal( calls[ 1 ].channel, 'chromium' );

} );

test( 'production preview accepts explicit compiler-free VSM and PMREM receipts without motion', () => {

	const vsmRoute = {
		path: '/vsm.html',
		receiptId: 'shadow-debug:vsm.html',
		domain: { type: 'vsm', lightKind: 'directional' },
	};
	const vsmObservation = observation( vsmRoute, {
		type: 'vsm',
		lightKind: 'directional',
		shadowKind: 'vsm',
		schedulerCalls: 2,
		complete: true,
		rendered: true,
		lights: 1,
		unsupported: [],
		renderFrames: 2,
		outputBound: true,
	} );
	assert.deepEqual( productionRouteFailures( vsmRoute, vsmObservation ), [] );

	const pmremRoute = {
		path: '/from-scene.html',
		receiptId: 'pmrem-debug:from-scene.html',
		domain: { type: 'pmrem', mode: 'from-scene' },
	};
	const pmremObservation = observation( pmremRoute, {
		type: 'pmrem',
		mode: 'from-scene',
		generated: true,
		isPMREMTexture: true,
		width: 336,
		height: 256,
		renderFrames: 1,
		outputBound: true,
	} );
	assert.deepEqual( productionRouteFailures( pmremRoute, pmremObservation ), [] );
	const disconnectedPMREM = structuredClone( pmremObservation );
	disconnectedPMREM.siteResult.domain.outputBound = false;
	assert.ok(
		productionRouteFailures( pmremRoute, disconnectedPMREM )
			.some( ( failure ) => failure.includes( 'scene.environment' ) ),
		'a generated but unbound PMREM texture must fail production verification',
	);

	const report = createProductionRouteReport(
		'pmrem-debug',
		[ { ...pmremObservation, ok: true } ],
		{ browserFailurePolicySha256: 'abc' },
	);
	assert.equal( report.schemaVersion, 1 );
	assert.equal( report.ok, true );
	assert.equal( report.thresholds.minChangedFraction, null );
	assert.equal( report.thresholds.minMeanFrameDelta, null );

} );

test( 'production preview requires exact nonblank WebGPU and WebGL canary backends', () => {

	for ( const backend of [ 'webgpu', 'webgl' ] ) {

		const route = {
			path: '/',
			receiptId: 'getting-started',
			requestedBackend: backend,
			domain: { type: 'canary', backend },
		};
		const observed = observation( route );
		observed.siteResult.animationFrames = 12;
		observed.pixelEvidence = {
			...observed.pixelEvidence,
			framesCompared: true,
			changedFraction: PRODUCTION_CANARY_PIXEL_THRESHOLDS.minChangedFraction,
			meanFrameDelta: PRODUCTION_CANARY_PIXEL_THRESHOLDS.minMeanFrameDelta,
		};
		assert.deepEqual( productionRouteFailures( route, observed ), [] );

		const mismatch = structuredClone( observed );
		mismatch.rendererBackend.backend = backend === 'webgpu' ? 'webgl' : 'webgpu';
		assert.ok(
			productionRouteFailures( route, mismatch ).some( failure => failure.includes( 'canary initialized' ) ),
		);

		const staticCanvas = structuredClone( observed );
		staticCanvas.pixelEvidence.framesCompared = false;
		staticCanvas.pixelEvidence.changedFraction = null;
		staticCanvas.pixelEvidence.meanFrameDelta = null;
		assert.ok(
			productionRouteFailures( route, staticCanvas ).some( failure => failure.includes( 'second frame' ) ),
		);

	}

} );

test( 'production preview fails closed on fallback, capture, browser, domain, and pixel evidence', () => {

	const route = {
		path: '/spot.html?shadow=vsm',
		receiptId: 'shadow-debug:spot.html?shadow=vsm',
		domain: { type: 'vsm', lightKind: 'spot' },
	};
	const failed = observation( route, {
		type: 'vsm',
		lightKind: 'directional',
		shadowKind: 'pcf',
		schedulerCalls: 0,
		complete: false,
		rendered: false,
		lights: 0,
		unsupported: [ { reason: 'custom shadow node' } ],
		renderFrames: 0,
		outputBound: false,
	} );
	failed.webgpu = false;
	failed.siteResult.runtimeMode = 'capture';
	failed.siteResult.compilerFree = false;
	failed.captureRequests.push( 'http://127.0.0.1:8999/__tsl-precompile/capture' );
	failed.browserFailures.push( { text: 'pageerror: shader replay failed' } );
	failed.pixelEvidence = {
		...PIXELS,
		rgbDeviation: 0,
		luminanceDeviation: 0,
		contentFraction: 0,
	};

	const failures = productionRouteFailures( route, failed );
	for ( const expected of [
		'navigator.gpu is unavailable',
		'expected "pure-slim"',
		'compilerFree=true',
		'production attempted capture',
		'pageerror: shader replay failed',
		'canvas RGB deviation',
		'VSM lightKind',
		'VSM schedulerCalls',
		'complete=true',
		'never rendered',
		'moments output',
		'unsupported lights',
		'renderFrames',
	] ) assert.ok(
		failures.some( ( failure ) => failure.includes( expected ) ),
		`missing fail-closed diagnostic for ${ expected }: ${ failures.join( ' | ' ) }`,
	);

} );

test( 'recapture production preview is wired before commit and fixtures publish domain receipts', () => {

	const recapture = readFileSync(
		resolve( REPO, 'packages/plugin/src/cli/recapture-all.js' ),
		'utf8',
	);
	const buildIndex = recapture.indexOf( 'await runProductionBuild(abortController.signal, example);' );
	const previewIndex = recapture.indexOf( 'await runProductionPreview(abortController.signal, example, selection.port);' );
	const commitIndex = recapture.indexOf( 'transaction.commit()' );
	assert.ok( buildIndex >= 0 && buildIndex < previewIndex && previewIndex < commitIndex );

	const shadow = readFileSync(
		resolve( REPO, 'packages/examples/shadow-debug/src/shared.js' ),
		'utf8',
	);
	assert.match( shadow, /__TSLP_SITE_DOMAIN__ = shadowReplayReceipt/ );
	assert.match( shadow, /populateShadowMaps\( scene, camera \)/ );
	assert.match( shadow, /shadowReplayReceipt\.rendered \|\|=/ );
	assert.match( shadow, /shadowReplayReceipt\.renderFrames \+= 1/ );
	assert.match( shadow, /mapPassTexture === shadowLight\.shadow\.__tslpVsmShadowTexture/ );

	const pmrem = readFileSync(
		resolve( REPO, 'packages/examples/pmrem-debug/src/shared.js' ),
		'utf8',
	);
	assert.match( pmrem, /__TSLP_SITE_DOMAIN__ = pmremReplayReceipt/ );
	assert.match( pmrem, /isPMREMTexture: environmentTarget\?\.texture\?\.isPMREMTexture === true/ );
	assert.match( pmrem, /pmremReplayReceipt\.renderFrames \+= 1/ );
	assert.match( pmrem, /scene\.environment === environmentTarget\.texture/ );
	for ( const page of [ 'equirect', 'cubemap', 'from-scene', 'transmission' ] ) {

		const html = readFileSync(
			resolve( REPO, `packages/examples/pmrem-debug/${ page }.html` ),
			'utf8',
		);
		assert.match( html, /src="\/src\/site-status\.js"/ );

	}

} );
