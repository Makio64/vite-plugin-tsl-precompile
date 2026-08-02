#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import sharp from 'sharp';
import { preview } from 'vite';

import { installBrowserFailureCollector } from '../../examples/browser-failure-policy.mjs';

const SITE_ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const BROWSER_ARGS = [ '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage' ];
const MIN_RGB_DEVIATION = 2;
const FIRST_RENDER_TIMEOUT_MS = 10000;
const VISUAL_OVERLAY_SELECTOR = [
	'#hud',
	'.hud',
	'#status',
	'.status',
	'#info',
	'.info',
	'.overlay',
	'.lil-gui',
	'[data-tslp-overlay]',
].join( ',' );
const liveManifest = JSON.parse( await readFile( resolve( SITE_ROOT, 'dist/live-examples.json' ), 'utf8' ) );

function pixelDifference( left, right ) {

	const length = Math.min( left.length, right.length );
	let changed = 0;
	let absolute = 0;
	for ( let index = 0; index < length; index += 4 ) {

		const delta = Math.abs( left[ index ] - right[ index ] )
			+ Math.abs( left[ index + 1 ] - right[ index + 1 ] )
			+ Math.abs( left[ index + 2 ] - right[ index + 2 ] );
		if ( delta > 6 ) changed += 1;
		absolute += delta;

	}
	return {
		changedPixels: changed,
		changedFraction: changed / Math.max( 1, length / 4 ),
		meanAbsoluteRgb: absolute / Math.max( 1, length / 4 ),
	};

}

function sameNames( actual, expected ) {

	if ( ! Array.isArray( actual ) || ! Array.isArray( expected ) ) return false;
	const left = [ ...new Set( actual ) ].sort();
	const right = [ ...new Set( expected ) ].sort();
	return left.length === right.length && left.every( ( name, index ) => name === right[ index ] );

}

const server = await preview( {
	root: SITE_ROOT,
	configFile: resolve( SITE_ROOT, 'vite.config.js' ),
	preview: { host: '127.0.0.1', port: 5191, strictPort: false },
} );
const baseUrl = server.resolvedUrls?.local?.[ 0 ];
if ( ! baseUrl ) throw new Error( 'Vite preview did not expose a local URL' );

let browser;
let browserFailures;
try {

	try {

		browser = await chromium.launch( { channel: 'chrome', headless: true, args: BROWSER_ARGS } );

	} catch {

		browser = await chromium.launch( { headless: true, args: BROWSER_ARGS } );

	}
	const page = await browser.newPage( { viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 } );
	const examplesPageUrl = new URL( 'examples.html', baseUrl ).href;
	browserFailures = installBrowserFailureCollector( page, { pageUrl: examplesPageUrl } );
	let captureRequests = [];
	page.on( 'request', request => {

		if ( request.method() !== 'GET' || /__tslp__.*capture/i.test( request.url() ) ) captureRequests.push( `${ request.method() } ${ request.url() }` );

	} );

	const initialFailureCheckpoint = browserFailures.checkpoint();
	await page.goto( examplesPageUrl, { waitUntil: 'networkidle', timeout: 30000 } );
	const initialBrowserFailures = browserFailures.messagesSince( initialFailureCheckpoint );
	if ( initialBrowserFailures.length > 0 ) throw new Error( `examples page:\n${ initialBrowserFailures.join( '\n' ) }` );
	const verified = liveManifest.examples.filter( entry => entry.runtimeMode === 'pure-slim' && entry.buildVerified === true );
	if ( verified.length !== liveManifest.examples.length ) throw new Error( 'live manifest contains an unverified route' );
	const freeExamples = verified.filter( entry => entry.role === 'free-example' && entry.collection === 'free-tsl' );
	if ( freeExamples.length !== 10 ) throw new Error( `expected 10 free TSL examples, received ${ freeExamples.length }` );

	async function openRecord( entry ) {

		const failureCheckpoint = browserFailures.checkpoint();
		captureRequests = [];
		if ( entry.role === 'canary' ) {

			const open = page.locator( '#ex-live-open' );
			await open.waitFor( { state: 'visible' } );
			if ( await open.isDisabled() ) throw new Error( `compiled canary did not enable: ${ await open.textContent() }` );
			await open.click();

		} else if ( entry.role === 'free-example' ) {

			const open = page.locator( `[data-free-live-id="${ entry.id }"]` );
			await open.waitFor( { state: 'visible' } );
			await open.click();

		} else {

			await page.evaluate( catalogueId => {

				window.location.hash = encodeURIComponent( catalogueId );

			}, entry.catalogueId );
			const open = page.locator( '#ex-stage-live' );
			await open.waitFor( { state: 'visible' } );
			await page.waitForFunction( expectedId => (
				document.querySelector( '#ex-stage-live' )?.dataset.liveId === expectedId
			), entry.id );
			if ( await open.isDisabled() ) throw new Error( `${ entry.id }: gallery live button is disabled` );
			await open.click();

		}

		await page.locator( '#ex-live-dialog[open]' ).waitFor();
		const liveFrame = page.frameLocator( '#ex-live-frame' );
		const expectedLiveUrl = new URL( entry.playUrl, baseUrl ).href;
		try {

			await page.waitForFunction( ( { expectedLiveUrl, runtimeId } ) => {

				const frame = document.querySelector( '#ex-live-frame' );
				if ( ! frame || frame.src !== expectedLiveUrl ) return false;
				try {

					if ( frame.contentWindow?.location.href !== expectedLiveUrl ) return false;
					const result = frame.contentWindow.__TSLP_SITE_RESULT__;
					if ( ! result?.ready ) return false;
					if ( runtimeId && result.id !== runtimeId ) return false;

				} catch {

					return false;

				}
				return document.querySelector( '#ex-live-status' )?.classList.contains( 'is-ready' ) === true;

			}, { expectedLiveUrl, runtimeId: entry.runtimeId || null }, { timeout: 30000 } );

		} catch ( error ) {

			const statusText = await page.locator( '#ex-live-status' ).textContent();
			const runtime = await liveFrame.locator( 'body' ).evaluate( () => window.__TSLP_SITE_RESULT__ || null ).catch( () => null );
			throw new Error( `${ entry.id }: timed out waiting for ready status (${ statusText }): ${ JSON.stringify( runtime ) }`, { cause: error } );

		}
		const runtime = await liveFrame.locator( 'body' ).evaluate( () => ( { ...window.__TSLP_SITE_RESULT__, webgpu: !!navigator.gpu } ) );
		if ( ! runtime.webgpu ) throw new Error( `${ entry.id }: navigator.gpu is unavailable` );
		if ( runtime.runtimeMode !== 'pure-slim' || runtime.compilerFree !== true ) throw new Error( `${ entry.id }: unexpected runtime mode ${ JSON.stringify( runtime ) }` );
		if ( ! runtime.ready || runtime.canvasCount < 1 || runtime.errors.length > 0 ) throw new Error( `${ entry.id }: route did not become healthy ${ JSON.stringify( runtime ) }` );
		if ( entry.runtimeId && runtime.id !== entry.runtimeId ) throw new Error(
			`${ entry.id }: runtime identified itself as ${ JSON.stringify( runtime.id ) } instead of ${ JSON.stringify( entry.runtimeId ) }`,
		);
		if ( entry.buildId === 'compute-debug' ) {

			if ( runtime.computeReady !== true ) throw new Error( `${ entry.id }: compute runtime did not become ready ${ JSON.stringify( runtime ) }` );
			if ( ! sameNames( runtime.kernelNames, entry.computeKernelNames ) ) throw new Error(
				`${ entry.id }: unexpected compute kernels (expected ${ JSON.stringify( entry.computeKernelNames ) }, ` +
				`received ${ JSON.stringify( runtime.kernelNames ) })`,
			);
			if ( ! Number.isSafeInteger( runtime.computeDispatches ) || runtime.computeDispatches < 1 ) throw new Error(
				`${ entry.id }: no successful compute dispatch was reported ${ JSON.stringify( runtime ) }`,
			);

		}

		const canvas = liveFrame.locator( 'canvas:visible' ).first();
		await canvas.waitFor( { state: 'visible' } );
		// Element screenshots include DOM composited over a WebGPU canvas. Hide
		// known diagnostics before sampling so a text HUD cannot make a blank
		// render pass the non-uniformity gate.
		await liveFrame.locator( 'body' ).evaluate( ( body, selector ) => {

			for ( const overlay of body.querySelectorAll( selector ) ) {

				overlay.style.setProperty( 'visibility', 'hidden', 'important' );

			}

		}, VISUAL_OVERLAY_SELECTOR );
		// `ready` means the renderer and artifact are initialized, but a slower
		// SwiftShader runner can still be compiling the first pipeline. Poll the
		// canvas until a real detailed frame arrives so CI does not sample the
		// uniform clear color and fail nondeterministically.
		const firstRenderDeadline = Date.now() + FIRST_RENDER_TIMEOUT_MS;
		let firstPng;
		let firstRgbDeviation = 0;
		do {

			await page.waitForTimeout( 100 );
			firstPng = await canvas.screenshot();
			const firstStats = await sharp( firstPng ).stats();
			firstRgbDeviation = Math.max( ...firstStats.channels.slice( 0, 3 ).map( channel => channel.stdev ) );

		} while ( firstRgbDeviation < MIN_RGB_DEVIATION && Date.now() < firstRenderDeadline );
		if ( firstRgbDeviation < MIN_RGB_DEVIATION ) throw new Error(
			`${ entry.id }: canvas stayed blank or uniform for ${ FIRST_RENDER_TIMEOUT_MS }ms (RGB deviation ${ firstRgbDeviation })`,
		);
		await page.waitForTimeout( 400 );
		const secondPng = await canvas.screenshot();
		const first = await sharp( firstPng ).ensureAlpha().raw().toBuffer( { resolveWithObject: true } );
		const second = await sharp( secondPng ).ensureAlpha().raw().toBuffer( { resolveWithObject: true } );
		const stats = await sharp( secondPng ).stats();
		const maxRgbDeviation = Math.max( ...stats.channels.slice( 0, 3 ).map( channel => channel.stdev ) );
		if ( maxRgbDeviation < MIN_RGB_DEVIATION ) throw new Error( `${ entry.id }: canvas is blank or uniform (RGB deviation ${ maxRgbDeviation })` );
		if ( first.info.width !== second.info.width || first.info.height !== second.info.height ) throw new Error( `${ entry.id }: canvas changed dimensions during the motion probe` );
		const motion = pixelDifference( first.data, second.data );
		if ( entry.expectsMotion === true && motion.changedFraction < 0.001 ) throw new Error( `${ entry.id }: canvas did not animate ${ JSON.stringify( motion ) }` );
		if ( captureRequests.length > 0 ) throw new Error( `${ entry.id }: production route attempted capture/network mutation: ${ captureRequests.join( ', ' ) }` );

		await page.locator( '.ex-live-close' ).click();
		await page.waitForFunction( () => {

			const frame = document.querySelector( '#ex-live-frame' );
			return frame?.getAttribute( 'src' ) === 'about:blank' &&
				frame.contentWindow?.location.href === 'about:blank';

		} );
		// The attribute changes synchronously, while pagehide and a final queued
		// renderer callback complete with the iframe navigation. Check failures
		// only after the browsing context has actually reached about:blank.
		await page.waitForTimeout( 50 );
		const routeBrowserFailures = browserFailures.messagesSince( failureCheckpoint );
		if ( routeBrowserFailures.length > 0 ) throw new Error( `${ entry.id }:\n${ routeBrowserFailures.join( '\n' ) }` );
		console.log( `[site-live-test] ${ entry.id } ready; RGB deviation ${ maxRgbDeviation.toFixed( 2 ) }; ${( motion.changedFraction * 100 ).toFixed( 2 )}% pixels moved` );

	}

	for ( const entry of verified ) await openRecord( entry );
	console.log( `[site-live-test] ${ verified.length } pure-slim route(s) passed` );

} finally {

	browserFailures?.dispose();
	await browser?.close();
	await new Promise( resolveClose => server.httpServer.close( resolveClose ) );

}
