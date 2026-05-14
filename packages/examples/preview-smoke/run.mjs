#!/usr/bin/env node
/**
 * preview-smoke harness
 *
 *   1. Build the named example via `pnpm --filter examples-<name> build`.
 *   2. Spawn `vite preview` for that example on a free port.
 *   3. Drive Playwright Chromium with Vulkan/SwiftShader to load the page.
 *   4. Assert the canvas rendered (non-trivial pixels), animation advanced
 *      (inter-frame byte diff above threshold), and no pageerror fired.
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

const SELF = dirname( fileURLToPath( import.meta.url ) );

function getArg( prefix, def ) {

	const a = process.argv.slice( 2 ).find( ( x ) => x.startsWith( prefix ) );
	return a ? a.slice( prefix.length ) : def;

}

const example = getArg( '--example=', 'ocean' );
const port = parseInt( getArg( '--port=', '4173' ), 10 );
const minNonZeroRatio = parseFloat( getArg( '--min-nonzero=', '0.5' ) );
const minDiffRatio = parseFloat( getArg( '--min-diff=', '0.05' ) );
const firstFrameMs = parseInt( getArg( '--first-frame-ms=', '5000' ), 10 );
const interFrameMs = parseInt( getArg( '--inter-frame-ms=', '3000' ), 10 );
const totalTimeoutMs = parseInt( getArg( '--total-timeout-ms=', '90000' ), 10 );

const resultsDir = resolve( SELF, 'results', example );
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
	const previewChild = spawn( 'pnpm', [ '--filter', `examples-${ example }`, 'preview', '--', '--port', String( port ), '--strictPort' ], { stdio: [ 'ignore', 'pipe', 'pipe' ] } );

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
	report.thresholds = { minNonZeroRatio, minDiffRatio };

	writeFileSync( resolve( resultsDir, 'report.json' ), JSON.stringify( report, null, 2 ) );
	console.log( JSON.stringify( report ) );

	if ( ! report.ok ) exitCode = exitCode || 1;
	process.exit( exitCode );

}

function waitForServerReady( child, expectedPort, timeoutMs ) {

	return new Promise( ( resolveFn ) => {

		const re = new RegExp( `http://(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${ expectedPort }/?` );
		const timer = setTimeout( () => resolveFn( false ), timeoutMs );
		const onChunk = ( chunk ) => {

			const text = chunk.toString();
			process.stdout.write( text );
			if ( re.test( text ) ) {

				clearTimeout( timer );
				setTimeout( () => resolveFn( true ), 250 );

			}

		};
		child.stdout?.on( 'data', onChunk );
		child.stderr?.on( 'data', onChunk );

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
	const pageErrors = [];
	const consoleErrors = [];
	page.on( 'pageerror', ( e ) => pageErrors.push( e.message ) );
	page.on( 'console', ( m ) => { if ( m.type() === 'error' ) consoleErrors.push( m.text() ); } );

	try {

		await page.goto( url, { waitUntil: 'networkidle', timeout: 30000 } );
		await page.waitForTimeout( firstFrameMs );
		const a = await page.screenshot( { fullPage: false } );
		await page.waitForTimeout( interFrameMs );
		const b = await page.screenshot( { fullPage: false } );

		writeFileSync( resolve( resultsDir, 'frame-a.png' ), a );
		writeFileSync( resolve( resultsDir, 'frame-b.png' ), b );

		const aStats = pixelStats( a );
		const diffRatio = byteDiffRatio( a, b );
		const nonZeroRatio = aStats.nonZero / aStats.total;

		const failures = [];
		if ( pageErrors.length > 0 ) failures.push( `${ pageErrors.length } pageerror(s): ${ pageErrors.slice( 0, 3 ).join( '; ' ) }` );
		if ( consoleErrors.length > 0 ) failures.push( `${ consoleErrors.length } console.error(s): ${ consoleErrors.slice( 0, 3 ).join( '; ' ) }` );
		if ( nonZeroRatio < minNonZeroRatio ) failures.push( `canvas appears blank (nonZeroRatio=${ nonZeroRatio.toFixed( 3 ) } < ${ minNonZeroRatio })` );
		if ( diffRatio < minDiffRatio ) failures.push( `frames identical / no animation (diffRatio=${ diffRatio.toFixed( 3 ) } < ${ minDiffRatio })` );

		return {
			ok: failures.length === 0,
			nonZeroRatio: Number( nonZeroRatio.toFixed( 4 ) ),
			diffRatio: Number( diffRatio.toFixed( 4 ) ),
			pageErrors,
			consoleErrors,
			failures,
		};

	} finally {

		await browser.close();

	}

}

function pixelStats( buf ) {

	let total = 0; let nonZero = 0;
	for ( let i = 8000; i < buf.length; i += 200 ) {

		total ++;
		if ( buf[ i ] > 5 ) nonZero ++;

	}
	return { total, nonZero };

}

function byteDiffRatio( a, b ) {

	const n = Math.min( a.length, b.length );
	if ( n === 0 ) return 0;
	let diff = 0;
	for ( let i = 0; i < n; i ++ ) if ( a[ i ] !== b[ i ] ) diff ++;
	return diff / n;

}

main().catch( ( err ) => {

	console.error( `[preview-smoke:${ example }] FAIL:`, err );
	writeFileSync( resolve( resultsDir, 'report.json' ), JSON.stringify( { ok: false, error: err && err.message || String( err ) }, null, 2 ) );
	process.exit( 1 );

} );
