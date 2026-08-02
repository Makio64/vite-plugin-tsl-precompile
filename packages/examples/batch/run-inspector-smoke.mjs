#!/usr/bin/env node
/**
 * Browser-level smoke gate for the inspector panel in the ocean example.
 *
 * The run captures into a unique temporary artifact directory so it never
 * reads, refreshes, or removes the example's normal generated artifacts.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { OCEAN_DIAGNOSTIC_ARTIFACTS_DIR_ENV } from '../ocean/artifacts-dir.js';
import { evaluateInspectorSmokeGate } from './inspector-smoke-gate.mjs';
import {
	cleanupOceanDiagnosticOutput,
	createOceanDiagnosticOutput,
	stopOwnedChild,
} from './ocean-diagnostic-lifecycle.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const REPO_ROOT = resolve( SELF, '../../..' );
const OCEAN_DIR = resolve( SELF, '../ocean' );
const BROWSER_ARGS = [
	'--enable-unsafe-webgpu',
	'--ignore-gpu-blocklist',
	'--no-sandbox',
	'--disable-dev-shm-usage',
];

function delay( milliseconds ) {

	return new Promise( ( resolveDelay ) => setTimeout( resolveDelay, milliseconds ) );

}

function observeVite( vite ) {

	const state = { ready: false, url: null, error: null, stdout: '' };
	vite.stdout.on( 'data', ( chunk ) => {

		const text = chunk.toString();
		state.stdout = ( state.stdout + text ).slice( -4096 );
		const match = state.stdout.match( /Local:\s+(http:\/\/[^\s/]+)/ );
		if ( match ) {

			state.url = match[ 1 ];
			state.ready = true;

		}

	} );
	vite.stderr.on( 'data', ( chunk ) => process.stderr.write( '[vite-err] ' + chunk.toString() ) );
	vite.once( 'error', ( error ) => {

		state.error = error;

	} );
	vite.once( 'exit', ( code, signal ) => {

		if ( ! state.ready ) {

			state.error = new Error(
				`Vite exited before readiness (code ${ code ?? 'null' }, signal ${ signal ?? 'none' }).`,
			);

		}

	} );
	return state;

}

async function waitForVite( state ) {

	const deadline = Date.now() + 30000;
	while ( ! state.ready && ! state.error && Date.now() < deadline ) await delay( 250 );
	if ( state.error ) throw state.error;
	if ( ! state.ready ) throw new Error( 'Vite did not become ready within 30s.' );
	return state.url;

}

async function launchBrowser() {

	try {

		return await chromium.launch( {
			channel: 'chrome',
			headless: true,
			args: BROWSER_ARGS,
		} );

	} catch {

		return chromium.launch( { headless: true, args: BROWSER_ARGS } );

	}

}

async function main() {

	let output = null;
	let vite = null;
	let browser = null;
	let context = null;
	let exitCode = 2;
	try {

		output = createOceanDiagnosticOutput(
			REPO_ROOT,
			'tslp-inspector-smoke-',
			'Inspector smoke',
		);
		console.log( '[inspector-smoke] starting Vite dev server…' );
		vite = spawn( 'npx', [ 'vite', '--port', '5210', '--strictPort' ], {
			cwd: OCEAN_DIR,
			env: {
				...process.env,
				NO_COLOR: '1',
				[ OCEAN_DIAGNOSTIC_ARTIFACTS_DIR_ENV ]: output.artifactsDir,
			},
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		} );
		const viteUrl = await waitForVite( observeVite( vite ) );
		console.log( `[inspector-smoke] Vite ready at ${ viteUrl }` );
		await delay( 2000 );

		browser = await launchBrowser();
		context = await browser.newContext( { viewport: { width: 1024, height: 720 } } );
		const page = await context.newPage();
		const browserFailures = [];

		function recordBrowserFailure( kind, message ) {

			const diagnostic = {
				kind,
				message: String( message || '<no diagnostic message>' ),
			};
			browserFailures.push( diagnostic );
			console.error( `[${ kind }]`, diagnostic.message );

		}

		page.on( 'pageerror', ( error ) => recordBrowserFailure( 'pageerror', error.message || error ) );
		page.on( 'console', ( message ) => {

			const type = message.type();
			if ( type === 'error' ) {

				const location = message.location();
				const suffix = location.url
					? ` (${ location.url }:${ location.lineNumber || 0 }:${ location.columnNumber || 0 })`
					: '';
				recordBrowserFailure( 'console', message.text() + suffix );

			} else if ( type === 'warning' ) {

				console.warn( '[browser-warn]', message.text() );

			} else if ( type === 'info' || type === 'log' ) {

				console.log( '[browser-log]', message.text() );

			}

		} );
		page.on( 'requestfailed', ( request ) => {

			recordBrowserFailure(
				'requestfailed',
				`${ request.failure()?.errorText || '<unknown network error>' } ${ request.url() }`,
			);

		} );
		page.on( 'response', ( response ) => {

			if ( response.status() >= 400 ) {

				recordBrowserFailure( 'response', `${ response.status() } ${ response.url() }` );

			}

		} );

		await page.goto( viteUrl, { waitUntil: 'load', timeout: 20000 } );
		await delay( 5000 );

		const shapeReport = await page.evaluate( () => ( {
			hasProfiler: !! document.querySelector( '.profiler' ),
			hasInspector: !! document.querySelector( '[class*="inspector"], [class*="profiler"]' ),
			profilerClass: document.querySelector( '.profiler' )?.className || null,
			allClasses: Array.from( document.querySelectorAll( 'div' ) ).slice( 0, 30 )
				.map( ( element ) => element.className )
				.filter( ( value ) => typeof value === 'string' && value.length > 0 )
				.slice( 0, 15 ),
			bodyChildCount: document.body.children.length,
			tabBtns: Array.from( document.querySelectorAll( '.tab-btn' ) )
				.map( ( button ) => button.textContent.trim() ),
		} ) );
		console.log( '[inspector-smoke] DOM shape:', JSON.stringify( shapeReport, null, 2 ) );

		await page.evaluate( () => {

			const buttons = Array.from( document.querySelectorAll( 'button' ) );
			const toggle = buttons.find( ( button ) => button.className.includes( 'profiler-toggle' ) );
			if ( toggle ) toggle.click();
			const panel = document.querySelector( '.profiler' );
			if ( panel && ! panel.classList.contains( 'visible' ) ) panel.classList.add( 'visible' );

			const tab = Array.from( document.querySelectorAll( '.tab-btn' ) )
				.find( ( button ) => ( button.textContent || '' ).trim().toLowerCase() === 'precompile' );
			if ( tab ) tab.click();

		} );
		await delay( 1500 );

		const probe = await page.evaluate( () => {

			const panel = document.querySelector( '.tslp-wrap' );
			if ( ! panel ) return { ok: false, reason: 'panel root .tslp-wrap not found in DOM' };
			const summary = panel.querySelector( '.tslp-summary-totals' );
			const rows = panel.querySelectorAll( '.tslp-row[data-id]' );
			const pills = panel.querySelectorAll( '.tslp-pill' );
			return {
				ok: true,
				totalText: summary ? summary.textContent.replace( /\s+/g, ' ' ).trim() : null,
				summaryCaptureTotalText: summary?.querySelector( '.tslp-big' )?.textContent?.trim() ?? null,
				rows: Array.from( rows ).map( ( row ) => ( {
					shape: row.querySelector( '.tslp-cell-shape' )?.textContent?.trim() ?? null,
					name: row.querySelector( '.tslp-cell-name' )?.textContent?.trim() ?? null,
					unknownCountText: row.getAttribute( 'data-unknown-count' ),
					blockedCountText: row.getAttribute( 'data-blocked-count' ),
				} ) ),
				pillTexts: Array.from( pills ).map( ( pill ) => pill.textContent.trim() ),
			};

		} );

		await context.close();
		context = null;
		await browser.close();
		browser = null;
		await stopOwnedChild( vite, 'Inspector smoke Vite server' );
		vite = null;

		console.log( '\n═══ inspector-smoke result ═══' );
		if ( probe.ok ) {

			console.log( '  summary:  ', probe.totalText );
			console.log( '  pills:    ', probe.pillTexts.join( ' · ' ) || '(none)' );
			console.log( '  rowCount: ', probe.rows.length );
			console.log(
				'  names:    ',
				probe.rows.slice( 0, 10 ).map( ( row ) => row.name ).join( ', ' ) || '(empty)',
			);

		}

		const gate = evaluateInspectorSmokeGate( probe, browserFailures );
		if ( ! gate.ok ) {

			console.error( '  FAIL: inspector smoke gate rejected the run:' );
			for ( const error of gate.errors ) console.error( '   -', error );
			exitCode = 1;

		} else {

			console.log( '\n  PASS: panel is live, capture totals agree, and the browser stayed error-free.' );
			exitCode = 0;

		}

	} catch ( error ) {

		console.error( '[inspector-smoke] infrastructure failure:', error?.stack || error );
		exitCode = 2;

	} finally {

		const cleanupErrors = [];
		if ( context ) {

			try { await context.close(); } catch ( error ) { cleanupErrors.push( error ); }

		}
		if ( browser ) {

			try { await browser.close(); } catch ( error ) { cleanupErrors.push( error ); }

		}
		if ( vite ) {

			try { await stopOwnedChild( vite, 'Inspector smoke Vite server' ); } catch ( error ) { cleanupErrors.push( error ); }

		}
		if ( output ) {

			try { cleanupOceanDiagnosticOutput( output, 'Inspector smoke' ); } catch ( error ) { cleanupErrors.push( error ); }

		}
		if ( cleanupErrors.length > 0 ) {

			for ( const error of cleanupErrors ) {

				console.error( '[inspector-smoke] cleanup failure:', error?.stack || error );

			}
			exitCode = 2;

		}

	}
	return exitCode;

}

process.exitCode = await main();
