#!/usr/bin/env node
/**
 * Browser-level proof that the ocean marker produces a contract-valid,
 * content-integrity-checked artifact through the real Vite capture endpoint.
 *
 * The run uses a unique temporary artifact directory and never reads,
 * refreshes, or removes the example's normal generated artifacts.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { OCEAN_DIAGNOSTIC_ARTIFACTS_DIR_ENV } from '../ocean/artifacts-dir.js';
import {
	fatalCaptureReplayBrowserErrors,
	loadValidatedCapturedMaterial,
} from './capture-replay-gate.mjs';
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
		process.stdout.write( '[vite] ' + text );
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
			'tslp-capture-replay-',
			'Capture replay',
		);
		console.log( '[capture-replay] starting Vite dev server for ocean…' );
		vite = spawn( 'npx', [ 'vite', '--port', '5199', '--strictPort' ], {
			cwd: OCEAN_DIR,
			env: {
				...process.env,
				NO_COLOR: '1',
				[ OCEAN_DIAGNOSTIC_ARTIFACTS_DIR_ENV ]: output.artifactsDir,
			},
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		} );
		const viteUrl = await waitForVite( observeVite( vite ) );
		console.log( `[capture-replay] Vite ready at ${ viteUrl }` );
		await delay( 2000 );

		browser = await launchBrowser();
		context = await browser.newContext( { viewport: { width: 640, height: 480 } } );
		const page = await context.newPage();
		const browserFailures = [];
		const recordBrowserFailure = ( kind, message, url = '' ) => {

			browserFailures.push( {
				kind,
				message: String( message || '<no diagnostic message>' ),
				url: String( url || '' ),
			} );

		};
		page.on( 'pageerror', ( error ) => {

			recordBrowserFailure( 'pageerror', error.message || error );

		} );
		page.on( 'console', ( message ) => {

			if ( message.type() === 'error' ) {

				recordBrowserFailure(
					'console',
					message.text(),
					message.location()?.url || '',
				);

			} else if ( message.type() === 'info' || message.type() === 'log' ) {

				console.log( '[browser/info]', message.text() );

			}

		} );
		page.on( 'requestfailed', ( request ) => {

			recordBrowserFailure(
				'requestfailed',
				request.failure()?.errorText || '<unknown network error>',
				request.url(),
			);

		} );
		page.on( 'response', ( response ) => {

			if ( response.status() >= 400 ) {

				recordBrowserFailure( 'response', String( response.status() ), response.url() );

			}

		} );

		console.log( `[capture-replay] navigating to ${ viteUrl }` );
		await page.goto( viteUrl, { waitUntil: 'load', timeout: 20000 } );
		await delay( 8000 );

		await context.close();
		context = null;
		await browser.close();
		browser = null;
		await stopOwnedChild( vite, 'Capture replay Vite server' );
		vite = null;

		const fatalBrowserErrors = fatalCaptureReplayBrowserErrors( browserFailures );
		console.log( '\n[capture-replay] checking isolated artifacts directory…' );
		const files = existsSync( output.artifactsDir ) ? readdirSync( output.artifactsDir ) : [];
		console.log( '[capture-replay] artifacts:', files );
		const auxArtifacts = files.filter( ( file ) => file.startsWith( 'aux-' ) && file.endsWith( '.json' ) );

		let userArtifact = null;
		let artifactValidationError = null;
		try {

			userArtifact = await loadValidatedCapturedMaterial( output.artifactsDir, 'ocean-water' );

		} catch ( error ) {

			artifactValidationError = error;

		}

		console.log( '\n═══ capture-replay result ═══' );
		console.log(
			'  user material (ocean-water):',
			userArtifact ? `✓ ${ userArtifact.file }` : '✗ INVALID OR NOT CAPTURED',
		);
		if ( artifactValidationError ) {

			console.log( '  artifact validation:', artifactValidationError.message || String( artifactValidationError ) );

		}
		console.log( '  aux artifacts:', auxArtifacts.length, '→', auxArtifacts.join( ', ' ) || '(none)' );
		console.log( '  browser errors:', fatalBrowserErrors.length );
		for ( const failure of fatalBrowserErrors.slice( 0, 5 ) ) {

			console.log( '   ', `${ failure.kind }: ${ failure.message } ${ failure.url }`.trim().slice( 0, 240 ) );

		}

		const ok = userArtifact !== null && fatalBrowserErrors.length === 0;
		console.log( ok
			? '\n  PASS: end-to-end capture produced a contract-valid, content-integrity-checked artifact.'
			: '\n  FAIL: capture replay did not satisfy artifact integrity and browser-error gates.' );
		exitCode = ok ? 0 : 1;

	} catch ( error ) {

		console.error( '[capture-replay] infrastructure failure:', error?.stack || error );
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

			try { await stopOwnedChild( vite, 'Capture replay Vite server' ); } catch ( error ) { cleanupErrors.push( error ); }

		}
		if ( output ) {

			try { cleanupOceanDiagnosticOutput( output, 'Capture replay' ); } catch ( error ) { cleanupErrors.push( error ); }

		}
		if ( cleanupErrors.length > 0 ) {

			for ( const error of cleanupErrors ) {

				console.error( '[capture-replay] cleanup failure:', error?.stack || error );

			}
			exitCode = 2;

		}

	}
	return exitCode;

}

process.exitCode = await main();
