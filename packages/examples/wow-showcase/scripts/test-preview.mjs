#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { build, preview } from 'vite';

import {
	BROWSER_FAILURE_POLICY_SHA256,
	installBrowserFailureCollector,
} from '../../browser-failure-policy.mjs';
import { SHOWCASE_ROUTE_IDS } from '../src/route-manifest.js';

const ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const CONFIG = resolve( ROOT, 'vite.config.js' );
const RESULTS = resolve( process.env.TSLP_WOW_RESULTS || resolve( ROOT, 'results' ) );
const MANIFEST = resolve( ROOT, 'artifacts/manifest.json' );
const EXPECTED_ARTIFACTS = SHOWCASE_ROUTE_IDS.flatMap( id => [ `wow-${ id }-surface`, `wow-${ id }-accent` ] );
const BROWSER_ARGS = [
	'--enable-unsafe-webgpu',
	'--ignore-gpu-blocklist',
	'--enable-features=Vulkan,WebGPUService',
	'--use-vulkan=swiftshader',
	'--use-angle=swiftshader',
	'--no-sandbox',
	'--disable-dev-shm-usage',
];

await mkdir( RESULTS, { recursive: true } );
const manifest = JSON.parse( await readFile( MANIFEST, 'utf8' ) );
const missingArtifacts = EXPECTED_ARTIFACTS.filter( name => ! manifest[ name ] );
if ( missingArtifacts.length > 0 ) {

	throw new Error( `[wow-preview] capture first; missing ${ missingArtifacts.join( ', ' ) }` );

}

await build( {
	root: ROOT,
	configFile: CONFIG,
	logLevel: 'info',
} );

const server = await preview( {
	root: ROOT,
	configFile: CONFIG,
	preview: {
		host: '127.0.0.1',
		port: 5193,
		strictPort: false,
		open: false,
	},
} );
const baseUrl = server.resolvedUrls?.local?.[ 0 ];
if ( ! baseUrl ) throw new Error( '[wow-preview] Vite preview did not expose a local URL.' );

const report = {
	schemaVersion: 1,
	ok: false,
	runtimeMode: 'pure-slim',
	expectedArtifacts: EXPECTED_ARTIFACTS,
	harness: {
		browserFailurePolicySha256: BROWSER_FAILURE_POLICY_SHA256,
	},
	routes: [],
};

let browser;
try {

	browser = await launchBrowser();
	for ( const id of SHOWCASE_ROUTE_IDS ) report.routes.push( await testRoute( browser, baseUrl, id ) );
	report.ok = report.routes.every( route => route.ok );

} finally {

	await browser?.close();
	await new Promise( resolveClose => server.httpServer.close( resolveClose ) );
	await writeFile( resolve( RESULTS, 'report.json' ), JSON.stringify( report, null, 2 ) + '\n' );

}

if ( ! report.ok ) {

	const failed = report.routes.filter( route => ! route.ok );
	throw new Error( `[wow-preview] ${ failed.length } route(s) failed: ${ failed.map( route => `${ route.id }: ${ route.failures.join( '; ' ) }` ).join( ' | ' ) }` );

}

console.log( `[wow-preview] ${ report.routes.length } / ${ report.routes.length } compiler-free routes passed` );

async function testRoute( activeBrowser, activeBaseUrl, id ) {

	const page = await activeBrowser.newPage( { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } );
	const failures = [];
	const captureRequests = [];
	const pageUrl = new URL( `${ id }.html`, activeBaseUrl ).href;
	const browserFailures = installBrowserFailureCollector( page, { pageUrl } );
	page.on( 'request', request => {

		if ( /(?:__tsl-precompile|__tslp__.*capture)/i.test( request.url() ) ) captureRequests.push( request.url() );

	} );

	let runtime = null;
	let pixels = null;
	try {

		await page.goto( pageUrl, {
			waitUntil: 'networkidle',
			timeout: 45000,
		} );
		await page.waitForFunction( expectedId => {

			const value = window.__TSLP_SITE_RESULT__;
			return value?.id === expectedId && value.ready === true && value.canvasCount === 1 && value.errors?.length === 0;

		}, id, { timeout: 45000 } );
		runtime = await page.evaluate( () => ( {
			...window.__TSLP_SITE_RESULT__,
			webgpu: !!navigator.gpu,
		} ) );
		if ( ! runtime.webgpu ) failures.push( 'navigator.gpu is unavailable' );
		if ( runtime.runtimeMode !== 'pure-slim' || runtime.compilerFree !== true ) {

			failures.push( `unexpected runtime: ${ JSON.stringify( runtime ) }` );

		}
		if ( captureRequests.length > 0 ) failures.push( `production attempted capture: ${ captureRequests.join( ', ' ) }` );

		const canvas = page.locator( '.visual-stage canvas' ).first();
		await canvas.waitFor( { state: 'visible', timeout: 15000 } );
		await page.waitForTimeout( 550 );
		const first = await canvas.screenshot();
		await page.waitForTimeout( 650 );
		const second = await canvas.screenshot();
		pixels = await compareFrames( page, first, second );
		if ( pixels.rgbDeviation < 4 ) failures.push( `canvas is blank/uniform (RGB deviation ${ pixels.rgbDeviation })` );
		if ( pixels.changedFraction < 0.0005 ) failures.push( `canvas is not animating (${ pixels.changedFraction } changed)` );

		await page.screenshot( {
			path: resolve( RESULTS, `${ id }.png` ),
			fullPage: false,
		} );

	} catch ( error ) {

		failures.push( error?.message || String( error ) );

	} finally {

		failures.push( ...browserFailures.messages() );
		browserFailures.dispose();
		await page.close();

	}

	const route = {
		id,
		ok: failures.length === 0,
		runtime,
		pixels,
		failures,
	};
	console.log( `[wow-preview] ${ id }: ${ route.ok ? 'PASS' : 'FAIL' }${ pixels ? ` · deviation ${ pixels.rgbDeviation.toFixed( 2 )} · motion ${( pixels.changedFraction * 100 ).toFixed( 2 )}%` : '' }` );
	return route;

}

async function launchBrowser() {

	try {

		return await chromium.launch( { channel: 'chrome', headless: true, args: BROWSER_ARGS } );

	} catch {

		return chromium.launch( { headless: true, args: BROWSER_ARGS } );

	}

}

async function compareFrames( page, first, second ) {

	return page.evaluate( async ( { firstBase64, secondBase64 } ) => {

		async function pixelsFrom( base64 ) {

			const response = await fetch( `data:image/png;base64,${ base64 }` );
			const bitmap = await createImageBitmap( await response.blob() );
			const canvas = new OffscreenCanvas( bitmap.width, bitmap.height );
			const context = canvas.getContext( '2d' );
			context.drawImage( bitmap, 0, 0 );
			return context.getImageData( 0, 0, bitmap.width, bitmap.height ).data;

		}

		const left = await pixelsFrom( firstBase64 );
		const right = await pixelsFrom( secondBase64 );
		const length = Math.min( left.length, right.length );
		let count = 0;
		let mean = 0;
		let meanSquared = 0;
		let changed = 0;
		for ( let index = 0; index < length; index += 4 ) {

			const luminance = left[ index ] * 0.2126 + left[ index + 1 ] * 0.7152 + left[ index + 2 ] * 0.0722;
			mean += luminance;
			meanSquared += luminance * luminance;
			const delta = Math.abs( left[ index ] - right[ index ] )
				+ Math.abs( left[ index + 1 ] - right[ index + 1 ] )
				+ Math.abs( left[ index + 2 ] - right[ index + 2 ] );
			if ( delta > 9 ) changed ++;
			count ++;

		}
		mean /= Math.max( 1, count );
		meanSquared /= Math.max( 1, count );
		return {
			rgbDeviation: Math.sqrt( Math.max( 0, meanSquared - mean * mean ) ),
			changedFraction: changed / Math.max( 1, count ),
		};

	}, {
		firstBase64: first.toString( 'base64' ),
		secondBase64: second.toString( 'base64' ),
	} );

}
