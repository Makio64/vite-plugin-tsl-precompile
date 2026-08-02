#!/usr/bin/env node
/**
 * preview-smoke harness
 *
 *   1. Build the named example via `pnpm --filter examples-<name> build`.
 *   2. Spawn `vite preview` for that example on a free port.
 *   3. Drive Playwright Chromium with Vulkan/SwiftShader to load the page.
 *   4. Screenshot the canvas element itself, decode both PNGs to RGBA, and
 *      assert finite content variation plus decoded inter-frame motion.
 *
 * Exits 0 on success with a one-line JSON summary on stdout. On failure,
 * exits non-zero and writes both captured frames + a structured report to
 * `results/<example>/`.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	BROWSER_FAILURE_POLICY_SHA256,
	installBrowserFailureCollector,
} from '../browser-failure-policy.mjs';
import { analyzePngFrames, primaryCanvasLocator, visualEvidenceFailures } from '../visual-pixel-evidence.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const RESULTS_ROOT = resolve( process.env.TSLP_PREVIEW_RESULTS || resolve( SELF, 'results' ) );

function getArg( prefix, def ) {

	const a = process.argv.slice( 2 ).find( ( x ) => x.startsWith( prefix ) );
	return a ? a.slice( prefix.length ) : def;

}

const example = getArg( '--example=', 'ocean' );
const port = parseInt( getArg( '--port=', '4173' ), 10 );
const minRgbDeviation = parseFloat( getArg( '--min-rgb-deviation=', '4' ) );
const minLuminanceDeviation = parseFloat( getArg( '--min-luminance-deviation=', '2' ) );
const minContentFraction = parseFloat( getArg( '--min-content=', '0.005' ) );
const minChangedFraction = parseFloat( getArg( '--min-changed=', '0.001' ) );
const minMeanFrameDelta = parseFloat( getArg( '--min-frame-delta=', '0.02' ) );
const firstFrameMs = parseInt( getArg( '--first-frame-ms=', '5000' ), 10 );
const interFrameMs = parseInt( getArg( '--inter-frame-ms=', '3000' ), 10 );
const totalTimeoutMs = parseInt( getArg( '--total-timeout-ms=', '90000' ), 10 );

const resultsDir = resolve( RESULTS_ROOT, example );
mkdirSync( resultsDir, { recursive: true } );

function log( msg ) { console.log( `[preview-smoke:${ example }] ${ msg }` ); }

function runChild( cmd, args, opts = {} ) {

	return new Promise( ( resolveFn, reject ) => {

		const child = spawn( cmd, args, { stdio: 'inherit', ...opts } );
		child.on( 'close', ( code ) => code === 0 ? resolveFn() : reject( new Error( `${ cmd } ${ args.join( ' ' ) } exited ${ code }` ) ) );
		child.on( 'error', reject );

	} );

}

async function main() {

	log( `building examples-${ example }…` );
	await runChild( 'pnpm', [ '--filter', `examples-${ example }`, 'build' ] );

	log( `spawning vite preview on :${ port }…` );
	const previewChild = spawn( 'pnpm', [ '--filter', `examples-${ example }`, 'preview', '--port', String( port ), '--strictPort' ], { stdio: [ 'ignore', 'pipe', 'pipe' ] } );

	const ready = await waitForServerReady( previewChild, port, totalTimeoutMs );
	if ( ! ready ) {

		previewChild.kill();
		throw new Error( `preview server did not signal ready within ${ totalTimeoutMs }ms` );

	}

	let report = null;
	let exitCode = 0;
	try {

		report = await probe( `http://localhost:${ port }/` );

	} catch ( err ) {

		report = { ok: false, error: err && err.message || String( err ) };
		exitCode = 1;

	} finally {

		previewChild.kill( 'SIGTERM' );

	}

	report.example = example;
	report.thresholds = {
		minRgbDeviation,
		minLuminanceDeviation,
		minContentFraction,
		minChangedFraction,
		minMeanFrameDelta,
	};
	report.harness = {
		browserFailurePolicySha256: BROWSER_FAILURE_POLICY_SHA256,
	};

	writeFileSync( resolve( resultsDir, 'report.json' ), JSON.stringify( report, null, 2 ) );
	console.log( JSON.stringify( report ) );

	if ( ! report.ok ) exitCode = exitCode || 1;
	process.exit( exitCode );

}

function waitForServerReady( child, expectedPort, timeoutMs ) {

	return new Promise( ( resolveFn ) => {

		const re = new RegExp( `http://(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${ expectedPort }/?` );
		let output = '';
		let settled = false;
		const finish = ( ready ) => {

			if ( settled ) return;
			settled = true;
			clearTimeout( timer );
			resolveFn( ready );

		};
		const timer = setTimeout( () => finish( false ), timeoutMs );
		const onChunk = ( chunk ) => {

			const text = chunk.toString();
			process.stdout.write( text );
			output = ( output + text ).replace( /\x1b\[[0-9;]*m/g, '' ).slice( - 4096 );
			if ( re.test( output ) ) {

				setTimeout( () => finish( true ), 250 );

			}

		};
		child.stdout?.on( 'data', onChunk );
		child.stderr?.on( 'data', onChunk );
		child.once( 'exit', () => finish( false ) );

	} );

}

async function probe( url ) {

	const browser = await chromium.launch( {
		args: [
			'--enable-unsafe-webgpu',
			'--enable-features=Vulkan,WebGPUService',
			'--use-vulkan=swiftshader',
			'--use-angle=swiftshader',
		],
	} );
	const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } );
	const page = await ctx.newPage();
	const failureCollector = installBrowserFailureCollector( page, { pageUrl: url } );

	try {

		await page.goto( url, { waitUntil: 'networkidle', timeout: 30000 } );
		const canvas = await primaryCanvasLocator( page );
		await canvas.waitFor( { state: 'visible', timeout: 30000 } );
		await page.waitForTimeout( firstFrameMs );
		const a = await canvas.screenshot();
		await page.waitForTimeout( interFrameMs );
		const b = await canvas.screenshot();

		writeFileSync( resolve( resultsDir, 'frame-a.png' ), a );
		writeFileSync( resolve( resultsDir, 'frame-b.png' ), b );

		const failures = [];
		const browserFailures = failureCollector.failures();
		const pageErrors = browserFailures
			.filter( failure => failure.kind === 'pageerror' )
			.map( failure => failure.message );
		const consoleErrors = browserFailures
			.filter( failure => failure.kind === 'console' )
			.map( failure => failure.message );
		failures.push( ...browserFailures.map( failure => failure.text ) );
		const pixelEvidence = await analyzePngFrames( page, a, b );
		failures.push( ...visualEvidenceFailures( pixelEvidence, {
			minRgbDeviation,
			minLuminanceDeviation,
			minContentFraction,
			minChangedFraction,
			minMeanFrameDelta,
		} ) );

		return {
			ok: failures.length === 0,
			pixelEvidence,
			browserFailures,
			pageErrors,
			consoleErrors,
			failures,
		};

	} finally {

		failureCollector.dispose();
		await browser.close();

	}

}

main().catch( ( err ) => {

	console.error( `[preview-smoke:${ example }] FAIL:`, err );
	writeFileSync( resolve( resultsDir, 'report.json' ), JSON.stringify( {
		ok: false,
		error: err && err.message || String( err ),
		harness: {
			browserFailurePolicySha256: BROWSER_FAILURE_POLICY_SHA256,
		},
	}, null, 2 ) );
	process.exit( 1 );

} );
