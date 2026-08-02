#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { installBrowserFailureCollector } from '../../browser-failure-policy.mjs';
import { SHOWCASE_ROUTE_IDS } from '../src/route-manifest.js';

const ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const CONFIG = resolve( ROOT, 'vite.config.js' );
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

const server = await createServer( {
	root: ROOT,
	configFile: CONFIG,
	server: {
		host: '127.0.0.1',
		port: 5192,
		strictPort: false,
		open: false,
	},
} );

let browser;
try {

	await server.listen();
	const baseUrl = server.resolvedUrls?.local?.[ 0 ];
	if ( ! baseUrl ) throw new Error( '[wow-capture] Vite did not expose a local URL.' );
	browser = await launchBrowser();

	for ( const id of SHOWCASE_ROUTE_IDS ) {

		const page = await browser.newPage( { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } );
		const failures = [];
		const pageUrl = new URL( `${ id }.html`, baseUrl ).href;
		const browserFailures = installBrowserFailureCollector( page, { pageUrl } );

		try {

			await page.goto( pageUrl, {
				waitUntil: 'networkidle',
				timeout: 45000,
			} );
			await page.waitForFunction( expectedId => {

				const value = window.__TSLP_SITE_RESULT__;
				return value?.id === expectedId && value.ready === true && value.canvasCount === 1 && value.errors?.length === 0;

			}, id, { timeout: 45000 } );
			await page.waitForTimeout( 700 );
			const runtime = await page.evaluate( () => ( { ...window.__TSLP_SITE_RESULT__ } ) );
			if ( runtime.runtimeMode !== 'capture' || runtime.compilerFree !== false ) {

				failures.push( `unexpected development runtime: ${ JSON.stringify( runtime ) }` );

			}
			failures.push( ...browserFailures.messages() );
			if ( failures.length > 0 ) throw new Error( failures.join( '\n' ) );
			console.log( `[wow-capture] ${ id }: rendered and captured` );

		} finally {

			browserFailures.dispose();
			await page.close();

		}

	}

	const manifest = await waitForManifest( EXPECTED_ARTIFACTS, 60000 );
	const materialNames = Object.keys( manifest ).filter( name => name !== '__aux' );
	const unexpected = materialNames.filter( name => ! EXPECTED_ARTIFACTS.includes( name ) );
	if ( unexpected.length > 0 ) throw new Error( `[wow-capture] unexpected material artifact(s): ${ unexpected.join( ', ' ) }` );
	console.log( `[wow-capture] complete: ${ EXPECTED_ARTIFACTS.length } material artifacts and ${ Object.keys( manifest.__aux || {} ).length } auxiliary capture(s)` );

} finally {

	await browser?.close();
	await server.close();

}

async function launchBrowser() {

	try {

		return await chromium.launch( { channel: 'chrome', headless: true, args: BROWSER_ARGS } );

	} catch {

		return chromium.launch( { headless: true, args: BROWSER_ARGS } );

	}

}

async function waitForManifest( expected, timeoutMs ) {

	const deadline = Date.now() + timeoutMs;
	let lastMissing = [ ...expected ];
	while ( Date.now() < deadline ) {

		try {

			const manifest = JSON.parse( await readFile( MANIFEST, 'utf8' ) );
			lastMissing = expected.filter( name => ! manifest[ name ] );
			if ( lastMissing.length === 0 ) return manifest;

		} catch {

			// The first render creates the directory and manifest asynchronously.

		}
		await new Promise( resolveWait => setTimeout( resolveWait, 250 ) );

	}
	throw new Error( `[wow-capture] manifest did not receive: ${ lastMissing.join( ', ' ) }` );

}
