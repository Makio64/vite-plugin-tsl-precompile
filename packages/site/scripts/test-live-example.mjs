#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import sharp from 'sharp';
import { preview } from 'vite';

const SITE_ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const BROWSER_ARGS = [ '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage' ];

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

const server = await preview( {
	root: SITE_ROOT,
	configFile: resolve( SITE_ROOT, 'vite.config.js' ),
	preview: { host: '127.0.0.1', port: 5191, strictPort: false },
} );
const baseUrl = server.resolvedUrls?.local?.[ 0 ];
if ( ! baseUrl ) throw new Error( 'Vite preview did not expose a local URL' );

let browser;
try {

	try {

		browser = await chromium.launch( { channel: 'chrome', headless: true, args: BROWSER_ARGS } );

	} catch {

		browser = await chromium.launch( { headless: true, args: BROWSER_ARGS } );

	}
	const page = await browser.newPage( { viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 } );
	const errors = [];
	const captureRequests = [];
	page.on( 'pageerror', error => errors.push( `pageerror: ${ error.message || error }` ) );
	page.on( 'console', message => {

		if ( message.type() === 'error' ) errors.push( `console: ${ message.text() }` );

	} );
	page.on( 'request', request => {

		if ( request.method() !== 'GET' || /__tslp__.*capture/i.test( request.url() ) ) captureRequests.push( `${ request.method() } ${ request.url() }` );

	} );
	page.on( 'response', response => {

		if ( response.status() >= 400 && ! /favicon\.ico(?:\?|$)/.test( response.url() ) ) errors.push( `HTTP ${ response.status() }: ${ response.url() }` );

	} );

	await page.goto( new URL( 'examples.html', baseUrl ).href, { waitUntil: 'networkidle', timeout: 30000 } );
	const open = page.locator( '#ex-live-open' );
	await open.waitFor( { state: 'visible' } );
	if ( await open.isDisabled() ) throw new Error( `compiled route did not enable: ${ await open.textContent() }` );
	await open.click();
	await page.locator( '#ex-live-dialog[open]' ).waitFor();
	const liveFrame = page.frameLocator( '#ex-live-frame' );
	await page.waitForFunction( () => document.querySelector( '#ex-live-status' )?.classList.contains( 'is-ready' ), null, { timeout: 30000 } );
	const runtime = await liveFrame.locator( 'body' ).evaluate( () => ( { ...window.__TSLP_SITE_RESULT__, webgpu: !!navigator.gpu } ) );
	if ( ! runtime.webgpu ) throw new Error( 'navigator.gpu is unavailable in the compiled route' );
	if ( runtime.runtimeMode !== 'pure-slim' || runtime.compilerFree !== true ) throw new Error( `unexpected runtime mode: ${ JSON.stringify( runtime ) }` );
	if ( ! runtime.ready || runtime.canvasCount < 1 || runtime.errors.length > 0 ) throw new Error( `compiled route did not become healthy: ${ JSON.stringify( runtime ) }` );

	const canvas = liveFrame.locator( 'canvas' ).first();
	await canvas.waitFor( { state: 'visible' } );
	const firstPng = await canvas.screenshot();
	await page.waitForTimeout( 800 );
	const secondPng = await canvas.screenshot();
	const first = await sharp( firstPng ).ensureAlpha().raw().toBuffer( { resolveWithObject: true } );
	const second = await sharp( secondPng ).ensureAlpha().raw().toBuffer( { resolveWithObject: true } );
	const stats = await sharp( secondPng ).stats();
	const maxRgbDeviation = Math.max( ...stats.channels.slice( 0, 3 ).map( channel => channel.stdev ) );
	if ( maxRgbDeviation < 2 ) throw new Error( `compiled canvas is blank or uniform (RGB deviation ${ maxRgbDeviation })` );
	if ( first.info.width !== second.info.width || first.info.height !== second.info.height ) throw new Error( 'compiled canvas changed dimensions during the motion probe' );
	const motion = pixelDifference( first.data, second.data );
	if ( motion.changedFraction < 0.001 ) throw new Error( `compiled canvas did not animate: ${ JSON.stringify( motion ) }` );
	if ( captureRequests.length > 0 ) throw new Error( `production route attempted capture/network mutation: ${ captureRequests.join( ', ' ) }` );
	if ( errors.length > 0 ) throw new Error( errors.join( '\n' ) );

	await page.locator( '.ex-live-close' ).click();
	await page.waitForFunction( () => document.querySelector( '#ex-live-frame' )?.getAttribute( 'src' ) === 'about:blank' );
	console.log( `[site-live-test] pure-slim route ready; RGB deviation ${ maxRgbDeviation.toFixed( 2 ) }; ${( motion.changedFraction * 100 ).toFixed( 2 )}% pixels moved` );

} finally {

	await browser?.close();
	await new Promise( resolveClose => server.httpServer.close( resolveClose ) );

}
