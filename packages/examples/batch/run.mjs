#!/usr/bin/env node
/**
 * Official Three.js stock-render gate for every supported `webgpu_*.html`
 * route in a checkout.
 *
 * Each route must load without page, console, request, or HTTP failures;
 * acquire and observe a real WebGPU device; install uncaptured-error and
 * device-loss listeners; complete a submitted-work queue fence; and produce a
 * non-empty decoded canvas frame. Canonical reports additionally bind the
 * exact official r185 Git blobs, recursive harness/dependency inputs, and the
 * Node/Chromium/WebGPU/backend execution environment.
 *
 * This runner proves the untouched upstream stock surface. Artifact
 * capture/slim replay and extractor/codegen coverage are graded separately by
 * run-e2e.mjs and run-coverage-summary.mjs.
 *
 *   node packages/examples/batch/run.mjs --three-repo=../../../three.js \
 *     [--filter=<substr>] [--limit=<n>] [--offset=<n>] [--port=<n>]
 *     [--report=<diagnostic-name.json>] [--output-root=<isolated-directory>]
 *     [--canonical-evidence]
 *
 * @module BatchHarness
 */

import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { readdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

import { aggregateFailureCategories } from '../../plugin/src/_shared/batch-report.js';
import { installBrowserFailureCollector } from '../browser-failure-policy.mjs';
import {
	assertOfficialThreeR185Checkout,
	assertThreeCheckoutMatchesVersion,
	createOfficialThreeR185SourceVerifier,
} from './_three-version.mjs';
import { readSafeContainedFile } from './e2e-evidence.mjs';
import { shouldSkipE2EExample } from './example-skip-policy.mjs';
import {
	assertOutputFileTarget,
	assertSafeJsonOutputName,
	prepareOutputRoot,
	removeOutputPath,
	writeOutputFileAtomic,
} from './output-path-safety.mjs';
import {
	assertEvidenceEnvironmentMatches,
	collectEvidenceEnvironment,
	launchEvidenceBrowser,
} from './e2e-environment.mjs';
import {
	drainAndSettleE2EGpuDiagnostics,
	e2eGpuObservationIssues,
	installE2EGpuDiagnostics,
	snapshotE2EGpuObservation,
} from './e2e-gpu-diagnostics.mjs';
import {
	classifyStockRun,
	STOCK_MINIMUM_BRIGHT_FRACTION,
	STOCK_REPORT_SCHEMA,
	resolveStockHarnessSourceFiles,
	stockHarnessFingerprint,
	stockCorpusFingerprint,
	upstreamStockExampleNames,
} from './stock-report-contract.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const REPO = resolve( SELF, '../../..' );
const CANONICAL_OUT = resolve( SELF, 'results' );
const CATALOGUE_PATH = resolve( SELF, 'example-catalogue.json' );

// ---- CLI args -------------------------------------------------------------

const args = process.argv.slice( 2 );
function getArg( prefix, def ) {

	const a = args.find( ( x ) => x.startsWith( prefix ) );
	return a ? a.slice( prefix.length ) : def;

}

function parseIntegerArg( prefix, defaultValue, { min, max = Number.MAX_SAFE_INTEGER } ) {

	const raw = getArg( prefix, null );
	if ( raw === null ) return defaultValue;
	if ( ! /^(0|[1-9]\d*)$/.test( raw ) ) throw new Error( `${ prefix } must be a non-negative integer` );
	const value = Number( raw );
	if ( ! Number.isSafeInteger( value ) || value < min || value > max ) {

		throw new Error( `${ prefix } must be between ${ min } and ${ max }` );

	}
	return value;

}

const knownArgument = /^(--three-repo=|--filter=|--limit=|--offset=|--port=|--report=|--output-root=|--canonical-evidence$)/;
const unknownArguments = args.filter( ( argument ) => ! knownArgument.test( argument ) );
if ( unknownArguments.length > 0 ) throw new Error( `unknown batch argument(s): ${ unknownArguments.join( ', ' ) }` );
for ( const prefix of [ '--three-repo=', '--filter=', '--limit=', '--offset=', '--port=', '--report=', '--output-root=' ] ) {

	if ( args.filter( ( argument ) => argument.startsWith( prefix ) ).length > 1 ) {

		throw new Error( `batch argument ${ prefix.slice( 0, - 1 ) } may be provided only once` );

	}

}
if ( args.filter( ( argument ) => argument === '--canonical-evidence' ).length > 1 ) {

	throw new Error( 'batch argument --canonical-evidence may be provided only once' );

}

const threeRepo = resolve( getArg( '--three-repo=', resolve( SELF, '../../../../three.js' ) ) );
const filter = getArg( '--filter=', '' );
const hasExplicitLimit = args.some( ( argument ) => argument.startsWith( '--limit=' ) );
const limit = parseIntegerArg( '--limit=', Number.MAX_SAFE_INTEGER, { min: 1 } );
const offset = parseIntegerArg( '--offset=', 0, { min: 0 } );
const port = parseIntegerArg( '--port=', 8718, { min: 1, max: 65535 } );
const exactFullSelection = filter === '' && ! hasExplicitLimit && offset === 0;
const requestedReportFile = assertSafeJsonOutputName(
	getArg( '--report=', 'report.json' ),
	{ label: '--report=' },
);
const requestedOutputRoot = getArg( '--output-root=', process.env.TSLP_STOCK_OUT || CANONICAL_OUT );
const OUT = prepareOutputRoot( requestedOutputRoot, {
	repositoryRoot: REPO,
	allowedRepositoryRoots: [ CANONICAL_OUT ],
	label: 'Stock report output root',
} );
const canonicalOutput = OUT === resolve( CANONICAL_OUT );
const reportPath = join( OUT, requestedReportFile );
assertOutputFileTarget( OUT, reportPath, { label: 'Stock report' } );
const stockRun = classifyStockRun( {
	exactFullSelection,
	writesCanonicalRoot: canonicalOutput,
	canonicalEvidenceRequested: args.includes( '--canonical-evidence' ),
	reportFile: requestedReportFile,
} );
if ( ! existsSync( join( threeRepo, 'examples' ) ) ) {

	console.error( `[batch] three.js examples not found at ${ threeRepo }/examples. Pass --three-repo=<absolute-path>` );
	process.exit( 2 );

}

const catalogueRaw = readSafeContainedFile( REPO, CATALOGUE_PATH, {
	label: 'current example catalogue',
} );
const catalogue = JSON.parse( catalogueRaw.toString( 'utf8' ) );
const expectedStockNames = upstreamStockExampleNames( catalogue );
const threeCheckout = exactFullSelection
	? assertOfficialThreeR185Checkout( threeRepo, 'batch' )
	: assertThreeCheckoutMatchesVersion( threeRepo, catalogue.threeVersion, 'batch' );
const officialThreeSourceVerifier = stockRun.canonical
	? createOfficialThreeR185SourceVerifier( threeRepo, 'canonical stock Three sources' )
	: null;
const stockHarnessSourceFiles = resolveStockHarnessSourceFiles( REPO );
const harnessSha256 = stockHarnessFingerprint( stockHarnessSourceFiles.map( ( file ) => (
	readSafeContainedFile( REPO, file, {
		label: `current stock harness source ${ relative( REPO, file ) }`,
	} )
) ) );
const catalogueSha256 = createHash( 'sha256' ).update( catalogueRaw ).digest( 'hex' );

// ---- example discovery ---------------------------------------------------

const discoveredExamples = readdirSync( join( threeRepo, 'examples' ) )
	.filter( ( f ) => f.startsWith( 'webgpu_' ) && f.endsWith( '.html' ) )
	.sort();
const supportedExamples = discoveredExamples.filter( ( filename ) => ! shouldSkipE2EExample( filename ) );
if ( exactFullSelection && JSON.stringify( supportedExamples ) !== JSON.stringify( expectedStockNames ) ) {

	const supportedSet = new Set( supportedExamples );
	const expectedSet = new Set( expectedStockNames );
	const missing = expectedStockNames.filter( ( name ) => ! supportedSet.has( name ) );
	const unexpected = supportedExamples.filter( ( name ) => ! expectedSet.has( name ) );
	throw new Error(
		`exact r185 stock corpus does not match example-catalogue.json ` +
		`(missing: ${ missing.join( ', ' ) || 'none' }; unexpected: ${ unexpected.join( ', ' ) || 'none' })`,
	);

}
const allExamples = discoveredExamples
	.filter( ( f ) => ! filter || f.includes( filter ) )
	.slice( offset, offset + limit );

const candidates = allExamples.filter( ( f ) => ! shouldSkipE2EExample( f ) );
if ( candidates.length === 0 ) throw new Error( 'stock sweep selected zero supported examples' );
// A failed replacement sweep must not leave a previous completed report
// looking current. Invalidate only after checkout, catalogue, and selection
// preflight have all succeeded.
removeOutputPath( OUT, reportPath, { label: 'Previous stock report' } );
console.log( `[batch] discovered ${ allExamples.length } webgpu_*.html — ${ candidates.length } after skip list` );

// ---- static file server for three.js --------------------------------------

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.mjs': 'application/javascript; charset=utf-8',
	'.json': 'application/json',
	'.wasm': 'application/wasm',
	'.css': 'text/css; charset=utf-8',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.hdr': 'application/octet-stream',
	'.exr': 'application/octet-stream',
	'.bin': 'application/octet-stream',
	'.glb': 'model/gltf-binary',
	'.gltf': 'model/gltf+json',
	'.ktx2': 'application/octet-stream',
	'.wgsl': 'text/plain; charset=utf-8',
};

function isPathWithin( root, filePath ) {

	const pathFromRoot = relative( root, filePath );
	return pathFromRoot !== '..' &&
		! pathFromRoot.startsWith( '../' ) &&
		! pathFromRoot.startsWith( '..\\' ) &&
		! isAbsolute( pathFromRoot );

}

async function safeResolveUnder( root, canonicalRoot, requestPath ) {

	const filePath = resolve( root, requestPath.replace( /^\/+/, '' ) );
	if ( ! isPathWithin( root, filePath ) ) return { status: 'forbidden' };

	let canonicalFilePath;
	try {

		canonicalFilePath = await realpath( filePath );

	} catch ( error ) {

		if ( error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ) return { status: 'missing' };
		throw error;

	}

	if ( ! isPathWithin( canonicalRoot, canonicalFilePath ) ) return { status: 'forbidden' };
	return { status: 'ok', filePath: canonicalFilePath };

}

const canonicalThreeRepo = await realpath( threeRepo );

const server = createServer( async ( req, res ) => {

	try {

		const url = new URL( req.url, 'http://localhost' );
		const requestPath = decodeURIComponent( url.pathname );
		if ( requestPath === '/__tslp__/environment-probe.html' ) {

			res.statusCode = 200;
			res.setHeader( 'content-type', 'text/html; charset=utf-8' );
			res.setHeader( 'cache-control', 'no-store' );
			res.end( '<!doctype html><html><head><meta charset="utf-8"><title>TSL stock environment probe</title></head><body></body></html>' );
			return;

		}
		if ( requestPath === '/favicon.ico' ) {

			res.statusCode = 204;
			res.setHeader( 'cache-control', 'no-store' );
			res.end();
			return;

		}
		const resolvedRequest = await safeResolveUnder( threeRepo, canonicalThreeRepo, requestPath );
		if ( resolvedRequest.status === 'forbidden' ) { res.statusCode = 403; res.end( 'forbidden' ); return; }
		if ( resolvedRequest.status === 'missing' ) { res.statusCode = 404; res.end( 'not found: ' + requestPath ); return; }
		const { filePath } = resolvedRequest;
		const s = await stat( filePath ).catch( () => null );
		if ( ! s || ! s.isFile() ) { res.statusCode = 404; res.end( 'not found: ' + requestPath ); return; }
		const buf = await readFile( filePath );
		officialThreeSourceVerifier?.verify( filePath, buf );
		res.setHeader( 'access-control-allow-origin', '*' );
		res.setHeader( 'content-type', MIME[ extname( filePath ).toLowerCase() ] || 'application/octet-stream' );
		res.end( buf );

	} catch {

		if ( ! res.headersSent ) {

			res.statusCode = 500;
			res.setHeader( 'content-type', 'text/plain; charset=utf-8' );
			res.setHeader( 'cache-control', 'no-store' );

		}
		res.end( 'internal server error' );

	}

} );

await new Promise( ( ok, fail ) => server.listen( port, '127.0.0.1', ok ).once( 'error', fail ) );
console.log( `[batch] static file server on http://localhost:${ port }/ (root: ${ threeRepo })` );

// ---- Playwright loop -----------------------------------------------------

const BROWSER_ARGS = [ '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage' ];
const MAX_RUNS_PER_BROWSER = 24;
const NAV_TIMEOUT_MS = 25000;
const RENDER_TIMEOUT_MS = 12000;
const RENDER_POLL_MS = 400;

async function dumpCanvas( page ) {

	const canvas = await page.$( 'canvas' );
	if ( ! canvas ) return null;
	try {

		return await canvas.screenshot( { timeout: 3000 } );

	} catch ( _ ) {

		return null;

	}

}

function brightFraction( pngBuf ) {

	if ( ! pngBuf ) return 0;
	try {

		const image = PNG.sync.read( pngBuf );
		let bright = 0;
		for ( let i = 0; i < image.data.length; i += 4 ) {

			if ( image.data[ i ] + image.data[ i + 1 ] + image.data[ i + 2 ] > 30 ) bright ++;

		}
		return bright / ( image.data.length / 4 );

	} catch ( _ ) {

		return 0;

	}

}

async function maybeClickStart( page ) {

	await page.evaluate( () => {

		const clickables = [ document.getElementById( 'startButton' ), document.querySelector( '#overlay button' ) ];
		for ( const el of document.querySelectorAll( 'button' ) ) {

			const t = ( el.textContent || '' ).trim().toLowerCase();
			if ( /^(play|start|begin|enter)$/.test( t ) ) clickables.push( el );

		}
		for ( const el of clickables ) {

			if ( ! el ) continue;
			const r = el.getBoundingClientRect();
			if ( r.width <= 0 || r.height <= 0 ) continue;
			if ( el.disabled ) continue;
			el.click();

		}

	} );

}

async function runOne( browser, name ) {

	const context = await browser.newContext( { viewport: { width: 640, height: 480 } } );
	let failureCollector = null;

	try {

		const page = await context.newPage();
		const pageUrl = `http://localhost:${ port }/examples/${ name }`;
		failureCollector = installBrowserFailureCollector( page, { pageUrl } );
		await page.addInitScript( installE2EGpuDiagnostics );
		try {

			await page.goto( pageUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS } );

		} catch ( error ) {

			return { name, status: 'fail', error: `navigation: ${ error.message }` };

		}

		await maybeClickStart( page );

		const deadline = Date.now() + RENDER_TIMEOUT_MS;
		let bright = 0;
		let shot = null;
		while ( Date.now() < deadline ) {

			shot = await dumpCanvas( page );
			bright = brightFraction( shot );
			if ( bright > 0.005 ) break;
			await new Promise( ( resolvePoll ) => setTimeout( resolvePoll, RENDER_POLL_MS ) );

		}

		await drainAndSettleE2EGpuDiagnostics( page );
		await page.evaluate( () => new Promise( ( resolveFrame ) => {

			requestAnimationFrame( () => requestAnimationFrame( resolveFrame ) );

		} ) );
		const settledShot = await dumpCanvas( page );
		const settledBright = brightFraction( settledShot );
		if ( settledBright > bright ) {

			shot = settledShot;
			bright = settledBright;

		}
		const diagnostics = await page.evaluate( () => window.__tslpHarnessDiagnostics || null );
		const gpuObservation = snapshotE2EGpuObservation( diagnostics?.gpuObservation );
		const gpuErrors = Array.isArray( diagnostics?.gpuErrors )
			? diagnostics.gpuErrors.map( ( error ) => String( error ) )
			: [];
		const failures = failureCollector.messages();
		const gpuValidation = [ ...failures, ...gpuErrors ]
			.filter( ( error ) => /ShaderStage|BindGroup|Binding|BufferBindingType|Invalid|validation/i.test( error ) );

		return {
			name,
			bright: +bright.toFixed( 4 ),
			errors: failures.slice( 0, 10 ),
			gpuValidationCount: gpuValidation.length,
			gpuErrors: gpuErrors.slice( 0, 10 ),
			gpuErrorCount: gpuErrors.length,
			gpuObservation,
		};

	} finally {

		failureCollector?.dispose();
		await context.close().catch( () => {} );

	}

}

// ---- driver -------------------------------------------------------------

let browser = null;
let interruptedSignal = null;

async function launchStockBrowser( expectedEnvironment = null ) {

	const launched = await launchEvidenceBrowser( chromium, {
		args: BROWSER_ARGS,
		headless: false,
	} );
	try {

		const environment = await collectEvidenceEnvironment( {
			browser: launched.browser,
			channel: launched.channel,
			probeUrl: `http://127.0.0.1:${ port }/__tslp__/environment-probe.html`,
		} );
		if ( expectedEnvironment ) {

			assertEvidenceEnvironmentMatches( expectedEnvironment, environment, 'Recycled stock browser' );

		}
		return { browser: launched.browser, environment };

	} catch ( error ) {

		await launched.browser.close().catch( () => {} );
		throw error;

	}

}

function signalExitCode( signal ) {

	if ( signal === 'SIGINT' ) return 130;
	if ( signal === 'SIGTERM' ) return 143;
	if ( signal === 'SIGHUP' ) return 129;
	return 1;

}
for ( const signal of [ 'SIGINT', 'SIGTERM', 'SIGHUP' ] ) {

	process.once( signal, () => {

		interruptedSignal = signal;
		void browser?.close().catch( () => {} );

	} );

}

const runId = randomUUID();
const partialReportPath = `${ reportPath }.partial-${ runId }`;
const report = {
	schema: STOCK_REPORT_SCHEMA,
	runId,
	startedAt: new Date().toISOString(),
	completedAt: null,
	complete: false,
	total: candidates.length,
	pass: 0,
	fail: 0,
	skip: discoveredExamples.length - supportedExamples.length,
	configuration: {
		mode: stockRun.mode,
		filter: filter || null,
		offset,
		limit: hasExplicitLimit ? limit : null,
		harnessSha256,
		environment: null,
		threeCheckout: {
			root: threeRepo,
			revision: threeCheckout.revision,
			packageVersion: threeCheckout.packageVersion,
			gitCommit: threeCheckout.gitCommit || null,
			clean: threeCheckout.clean === true,
			sourceVerification: officialThreeSourceVerifier?.snapshot() || null,
			discoveredCases: discoveredExamples.length,
		},
		corpus: {
			catalogueSha256,
			namesSha256: stockCorpusFingerprint( expectedStockNames ),
			caseCount: expectedStockNames.length,
			discoveredSupportedCaseCount: supportedExamples.length,
			selectedNamesSha256: stockCorpusFingerprint( candidates ),
		},
	},
	details: [],
};
let runsSinceRestart = 0;

function writePartialReport() {

	writeOutputFileAtomic( OUT, partialReportPath, JSON.stringify( report, null, 2 ), {
		label: 'Partial stock report',
	} );

}

function shouldPass( result ) {

	if ( result.error ) return false;
	if (
		! Number.isFinite( result.bright ) ||
		result.bright <= STOCK_MINIMUM_BRIGHT_FRACTION ||
		result.bright > 1
	) return false;
	if ( result.gpuValidationCount !== 0 ) return false;
	if ( result.gpuErrorCount !== 0 ) return false;
	if ( ! Array.isArray( result.gpuErrors ) || result.gpuErrors.length !== 0 ) return false;
	if ( e2eGpuObservationIssues( result.gpuObservation ).length !== 0 ) return false;
	if ( ! Array.isArray( result.errors ) || result.errors.length !== 0 ) return false;
	return true;

}

try {

	const initialBrowser = await launchStockBrowser();
	browser = initialBrowser.browser;
	report.configuration.environment = initialBrowser.environment;
	writePartialReport();
	for ( let i = 0; i < candidates.length; i ++ ) {

		if ( interruptedSignal ) break;
		const name = candidates[ i ];
		const label = `[${ i + 1 }/${ candidates.length }] ${ name }`;

		try {

			if ( runsSinceRestart >= MAX_RUNS_PER_BROWSER ) {

				await browser.close().catch( () => {} );
				const recycled = await launchStockBrowser( report.configuration.environment );
				browser = recycled.browser;
				runsSinceRestart = 0;

			}

			const result = await runOne( browser, name );
			if ( interruptedSignal ) break;
			runsSinceRestart ++;

			const pass = shouldPass( result );
			if ( pass ) report.pass ++; else report.fail ++;

			const detail = {
				name,
				status: pass ? 'pass' : 'fail',
				baseBrightFrac: result.bright,
				gpuValidationCount: result.gpuValidationCount || 0,
				gpuErrors: result.gpuErrors || [],
				gpuErrorCount: result.gpuErrorCount ?? ( result.gpuErrors || [] ).length,
				gpuObservation: result.gpuObservation || null,
				preErrors: result.errors || [],
				error: result.error || null,
			};
			report.details.push( detail );
			writePartialReport();
			const tag = pass ? '✓' : '✗';
			console.log( `${ label } — ${ tag } bright=${ detail.baseBrightFrac } gpuValidErrs=${ detail.gpuValidationCount }${ detail.error ? ' err="' + detail.error.slice( 0, 60 ) + '"' : '' }` );

		} catch ( e ) {

			if ( interruptedSignal ) break;
			console.log( `${ label } — FAIL ${ e.message }` );
			report.fail ++;
			report.details.push( { name, status: 'fail', error: e.message } );
			writePartialReport();

		}

	}

} finally {

	await browser?.close().catch( () => {} );
	if ( server.listening ) await new Promise( ( resolveClose ) => server.close( resolveClose ) );

}

if ( interruptedSignal ) {

	report.completedAt = new Date().toISOString();
	writePartialReport();
	console.error(
		`[batch] interrupted by ${ interruptedSignal }; incomplete report retained at ${ partialReportPath }`
	);
	process.exit( signalExitCode( interruptedSignal ) );

}

if ( officialThreeSourceVerifier ) {

	try {

		const sourceVerification = officialThreeSourceVerifier.assertValid();
		assertOfficialThreeR185Checkout( threeRepo, 'batch post-run canonical evidence' );
		report.configuration.threeCheckout.sourceVerification = sourceVerification;

	} catch ( error ) {

		report.completedAt = new Date().toISOString();
		report.integrityError = error && error.message || String( error );
		writePartialReport();
		console.error( `[batch] canonical Three source integrity failed: ${ report.integrityError }` );
		process.exit( 1 );

	}

}

report.completedAt = new Date().toISOString();
report.complete = true;
writePartialReport();
writeOutputFileAtomic( OUT, reportPath, JSON.stringify( report, null, 2 ), {
	label: 'Completed stock report',
} );
removeOutputPath( OUT, partialReportPath, { label: 'Partial stock report' } );

console.log( '\n═══ summary ═══' );
console.log( `  ${ report.pass } passed, ${ report.fail } failed, ${ report.skip } skipped, ${ report.total } total (candidates)` );
console.log( `  report: ${ reportPath }` );

const cats = aggregateFailureCategories( report.details );
if ( Object.keys( cats ).length > 0 ) {

	console.log( '\n  failure categories:' );
	const sorted = Object.entries( cats ).filter( ( [ k ] ) => k !== 'pass' ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] );
	for ( const [ c, n ] of sorted ) console.log( `    ${ n }× ${ c }` );

}

// This is a correctness gate, not a statistical sample: every selected route
// must render without a validation failure.
if ( report.total === 0 || report.fail !== 0 || report.pass !== report.total ) {

	console.log( `\n  GATE: ${ report.pass } / ${ report.total } passed — gate not met` );
	process.exit( 1 );

}

console.log( `\n  GATE: ${ report.pass } / ${ report.total } passed — gate met` );
process.exit( 0 );
