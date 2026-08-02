#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright';
import { preview } from 'vite';

import {
	BROWSER_FAILURE_POLICY_SHA256,
	installBrowserFailureCollector,
} from '../../examples/browser-failure-policy.mjs';
import { createProductionBrowserLaunchPlan } from '../../examples/preview-smoke/run-production-routes.mjs';
import {
	comparisonImageFailures,
	createStaticSiteBrowserReport,
	decodedImageFailures,
	parseStaticSiteBrowserArgs,
	resolveStaticSiteRouteUrls,
} from './static-site-browser-contract.mjs';

const SITE_ROOT = resolve( import.meta.dirname, '..' );
const VIEWPORT = Object.freeze( { width: 1440, height: 960 } );
const REPORT_FILE = 'report.json';

const HELP = `
Usage: node scripts/test-static-site.mjs [options]

Options:
  --output-dir <path>  Screenshot and report directory
                       (default: TSLP_SITE_BROWSER_OUT or results/static-site-browser)
  --timeout <ms>       Per-operation timeout (default: 30000)
  -h, --help           Show this help
`;

function errorText( error ) {

	return error?.stack || error?.message || String( error );

}

function relativeOutputPath( outputDir, file ) {

	return relative( outputDir, file ).replaceAll( '\\', '/' );

}

async function launchStaticSiteBrowser() {

	const failures = [];
	for ( const candidate of createProductionBrowserLaunchPlan() ) {

		try {

			const browser = await chromium.launch( candidate.options );
			return { browser, channel: candidate.channel };

		} catch ( error ) {

			failures.push( `${ candidate.channel }: ${ error?.message || error }` );

		}

	}
	throw new Error( `Could not launch the static-site Chromium browser (${ failures.join( '; ' ) }).` );

}

async function inspectImages( page, selector, label, options ) {

	const locator = page.locator( selector );
	await locator.first().waitFor( { state: 'attached', timeout: options.timeoutMs } );
	const count = await locator.count();
	const images = [];
	for ( let index = 0; index < count; index ++ ) {

		const image = locator.nth( index );
		await image.scrollIntoViewIfNeeded( { timeout: options.timeoutMs } );
		images.push( await image.evaluate( async element => {

			let decodeError = null;
			try {

				await element.decode();

			} catch ( error ) {

				decodeError = error?.message || String( error );

			}
			return {
				src: element.currentSrc || element.src || '',
				alt: element.alt || '',
				complete: element.complete === true,
				naturalWidth: element.naturalWidth,
				naturalHeight: element.naturalHeight,
				decodeError,
			};

		} ) );

	}
	return {
		images,
		failures: decodedImageFailures( label, images, options ),
	};

}

async function captureScreenshot( page, locator, outputDir, filename ) {

	const file = join( outputDir, filename );
	await locator.screenshot( { path: file, animations: 'disabled' } );
	return relativeOutputPath( outputDir, file );

}

async function probeRoute( context, {
	name,
	pageUrl,
	outputDir,
	timeoutMs,
	probe,
} ) {

	const page = await context.newPage();
	const collector = installBrowserFailureCollector( page, { pageUrl } );
	const failures = [];
	let evidence = null;
	let failureScreenshot = null;
	try {

		const response = await page.goto( pageUrl, { waitUntil: 'networkidle', timeout: timeoutMs } );
		if ( ! response || ! response.ok() ) failures.push(
			`${ name } navigation returned HTTP ${ response?.status() ?? '<no response>' }.`,
		);
		evidence = await probe( page );
		failures.push( ...evidence.failures );
		await page.waitForTimeout( 100 );

	} catch ( error ) {

		failures.push( errorText( error ) );
		const file = join( outputDir, `${ name }-failure.png` );
		try {

			await page.screenshot( { path: file, fullPage: true, animations: 'disabled' } );
			failureScreenshot = relativeOutputPath( outputDir, file );

		} catch ( _ ) {

			// The browser may already be gone; the report still carries the error.

		}

	} finally {

		collector.dispose();

	}
	const browserFailures = collector.failures();
	failures.push( ...browserFailures.map( failure => failure.text ) );
	await page.close();
	return {
		name,
		url: pageUrl,
		ok: failures.length === 0,
		evidence,
		browserFailures,
		failureScreenshot,
		failures: [ ...new Set( failures ) ],
	};

}

async function probeLanding( page, { outputDir, timeoutMs } ) {

	const capture = await inspectImages(
		page,
		'[data-featured-evidence-image="capture"]',
		'landing featured capture',
		{ expectedCount: 1, timeoutMs },
	);
	const replay = await inspectImages(
		page,
		'[data-featured-evidence-image="replay"]',
		'landing featured replay',
		{ expectedCount: 1, timeoutMs },
	);
	const featured = [ capture.images[ 0 ], replay.images[ 0 ] ];
	const failures = [
		...capture.failures,
		...replay.failures,
		...comparisonImageFailures( 'Landing featured comparison', featured ),
	];
	const screenshot = await captureScreenshot(
		page,
		page.locator( '[data-featured-evidence-example]' ),
		outputDir,
		'landing-featured.png',
	);
	return {
		failures,
		featured: { capture: featured[ 0 ] || null, replay: featured[ 1 ] || null },
		screenshots: [ screenshot ],
	};

}

async function probeExamples( page, { outputDir, timeoutMs } ) {

	await page.waitForFunction( () => {

		const title = document.querySelector( '#ex-stage-title' )?.textContent?.trim();
		return document.querySelectorAll( '.ex-gallery-card' ).length > 0 && title && title !== 'Loading…';

	}, null, { timeout: timeoutMs } );
	const galleryCardCount = await page.locator( '.ex-gallery-card' ).count();
	const gallery = await inspectImages(
		page,
		'.ex-gallery-card img',
		'examples gallery',
		{ minimumCount: 1, timeoutMs },
	);
	const galleryScreenshot = await captureScreenshot(
		page,
		page.locator( '#ex-gallery' ),
		outputDir,
		'examples-gallery.png',
	);

	const imageBackedCard = page.locator( '.ex-gallery-card:has(img)' ).first();
	const selectedBasename = await imageBackedCard.getAttribute( 'data-basename' );
	if ( ! selectedBasename ) throw new Error( 'Examples gallery has no selectable image-backed card.' );
	await imageBackedCard.click();
	await page.locator( '#ex-browser[data-view="compare"]' ).waitFor( { state: 'attached', timeout: timeoutMs } );
	await page.waitForFunction( expectedBasename => {

		try {

			return decodeURIComponent( location.hash.slice( 1 ) ) === expectedBasename;

		} catch {

			return false;

		}

	}, selectedBasename, { timeout: timeoutMs } );
	await page.locator( '#ex-stage[data-empty="false"]' ).waitFor( { state: 'attached', timeout: timeoutMs } );
	const comparison = await inspectImages(
		page,
		'#cmp-slider-bottom, #cmp-slider-top',
		'examples comparison',
		{ expectedCount: 2, timeoutMs },
	);
	const failures = [
		...gallery.failures,
		...comparison.failures,
		...comparisonImageFailures( 'Examples comparison', comparison.images ),
	];
	const comparisonScreenshot = await captureScreenshot(
		page,
		page.locator( '#ex-stage' ),
		outputDir,
		'examples-comparison.png',
	);
	return {
		failures,
		gallery: {
			cardCount: galleryCardCount,
			imageCount: gallery.images.length,
			placeholderCount: galleryCardCount - gallery.images.length,
			selectedBasename,
			images: gallery.images,
		},
		comparison: {
			title: await page.locator( '#ex-stage-title' ).textContent(),
			images: comparison.images,
		},
		screenshots: [ galleryScreenshot, comparisonScreenshot ],
	};

}

export async function runStaticSiteBrowserGate( args = process.argv.slice( 2 ) ) {

	const options = parseStaticSiteBrowserArgs( args, {
		defaultOutputDir: resolve( SITE_ROOT, 'results/static-site-browser' ),
	} );
	if ( options.help ) {

		console.log( HELP.trim() );
		return null;

	}
	await mkdir( options.outputDir, { recursive: true } );
	const startedAt = new Date().toISOString();
	const routes = [];
	const failures = [];
	let server = null;
	let browser = null;
	let browserDetails = null;
	let baseUrl = null;
	let routeUrls = null;
	try {

		server = await preview( {
			root: SITE_ROOT,
			configFile: resolve( SITE_ROOT, 'vite.config.js' ),
			preview: { host: '127.0.0.1', port: 5192, strictPort: false },
		} );
		const previewUrl = server.resolvedUrls?.local?.[ 0 ] || null;
		if ( ! previewUrl ) throw new Error( 'Vite preview did not expose a local URL.' );
		routeUrls = resolveStaticSiteRouteUrls( previewUrl, server.config?.base || '/' );
		baseUrl = routeUrls.baseUrl;
		const launched = await launchStaticSiteBrowser();
		browser = launched.browser;
		browserDetails = {
			engine: 'chromium',
			channel: launched.channel,
			version: await browser.version(),
			headless: true,
		};
		const context = await browser.newContext( { viewport: { ...VIEWPORT }, deviceScaleFactor: 1 } );
		try {

			routes.push( await probeRoute( context, {
				name: 'landing',
				pageUrl: routeUrls.landing,
				outputDir: options.outputDir,
				timeoutMs: options.timeoutMs,
				probe: page => probeLanding( page, options ),
			} ) );
			routes.push( await probeRoute( context, {
				name: 'examples',
				pageUrl: routeUrls.examples,
				outputDir: options.outputDir,
				timeoutMs: options.timeoutMs,
				probe: page => probeExamples( page, options ),
			} ) );

		} finally {

			await context.close();

		}

	} catch ( error ) {

		failures.push( errorText( error ) );

	} finally {

		await browser?.close().catch( () => {} );
		if ( server?.httpServer ) await new Promise( resolveClose => server.httpServer.close( resolveClose ) );

	}
	const report = createStaticSiteBrowserReport( {
		startedAt,
		completedAt: new Date().toISOString(),
		baseUrl,
		browser: browserDetails,
		browserFailurePolicySha256: BROWSER_FAILURE_POLICY_SHA256,
		routes,
		failures,
	} );
	const reportPath = join( options.outputDir, REPORT_FILE );
	await writeFile( reportPath, `${ JSON.stringify( report, null, 2 ) }\n`, 'utf8' );
	console.log( `[site-static-browser] report: ${ reportPath }` );
	return report;

}

const isDirectInvocation = process.argv[ 1 ] &&
	pathToFileURL( resolve( process.argv[ 1 ] ) ).href === import.meta.url;
if ( isDirectInvocation ) {

	runStaticSiteBrowserGate().then( report => {

		if ( report && ! report.ok ) {

			const routeFailures = report.routes.flatMap( route => route.failures.map( failure => `${ route.name }: ${ failure }` ) );
			throw new Error( [ ...report.failures, ...routeFailures ].join( '\n' ) );

		}

	} ).catch( error => {

		console.error( `[site-static-browser] FAIL: ${ errorText( error ) }` );
		process.exitCode = 1;

	} );

}
