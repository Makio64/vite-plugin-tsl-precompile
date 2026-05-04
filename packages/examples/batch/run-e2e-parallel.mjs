import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';

import { assertThreeAtLeast184 } from './_three-version.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const OUT  = resolve( SELF, 'results' );

const args = process.argv.slice( 2 );

function getArg( prefix, def ) {
	const found = args.find( a => a.startsWith( prefix ) );
	return found ? found.slice( prefix.length ) : def;
}

const workers  = parseInt( getArg( '--workers=', '6' ), 10 );
const basePort = parseInt( getArg( '--base-port=', '8730' ), 10 );
const filter   = getArg( '--filter=', '' );
const threeRepo = resolve( getArg( '--three-repo=', resolve( SELF, '../../../../three.js' ) ) );
const verbose = args.includes( '--verbose' ) || process.env.TSLP_E2E_VERBOSE === '1';

// Forward all flags to workers except the orchestrator-only ones
const forwarded = args.filter( a =>
	! a.startsWith( '--workers=' ) &&
	! a.startsWith( '--base-port=' ) &&
	! a.startsWith( '--port=' ) &&
	! a.startsWith( '--offset=' ) &&
	! a.startsWith( '--limit=' ) &&
	! a.startsWith( '--report=' )
);

const examplesDir = join( threeRepo, 'examples' );
if ( ! existsSync( examplesDir ) ) {
	console.error( `[e2e-parallel] three.js examples not found at ${ examplesDir }. Pass --three-repo=<path>` );
	process.exit( 1 );
}
assertThreeAtLeast184( threeRepo, 'e2e-parallel' );
const allExamples = readdirSync( examplesDir )
	.filter( f => f.startsWith( 'webgpu_' ) && f.endsWith( '.html' ) )
	.filter( f => ! filter || f.includes( filter ) );

const total = allExamples.length;
const actualWorkers = Math.min( workers, total );
const chunk = Math.ceil( total / actualWorkers );

mkdirSync( OUT, { recursive: true } );

const jobs = [];
for ( let i = 0; i < actualWorkers; i++ ) {
	const off = i * chunk;
	const lim = Math.min( chunk, total - off );
	if ( lim <= 0 ) break;
	jobs.push( { off, lim, port: basePort + i, report: `e2e-report-worker-${ i }.json`, idx: i } );
}

console.log( `[e2e-parallel] ${ total } examples → ${ jobs.length } workers, ~${ chunk } each (base-port ${ basePort })` );
if ( ! verbose ) console.log( '[e2e-parallel] showing per-example results only; pass --verbose for page logs and worker boilerplate' );

function shouldForwardWorkerLine( line ) {
	if ( verbose ) return true;
	const text = line.trim();
	if ( ! text ) return false;
	if ( text.startsWith( '[batch-e2e]' ) ) return false;
	if ( text.startsWith( '[page-warn' ) || text.startsWith( '[page-log' ) ) return false;
	if ( text.startsWith( '═══ e2e summary' ) ) return false;
	if ( /^\d+ pass, \d+ fail/.test( text ) ) return false;
	if ( text.startsWith( 'report:' ) ) return false;
	return true;
}

function attachLinePrefix( stream, outStream, prefix, onLine, shouldForward = () => true ) {
	let buf = '';
	stream.on( 'data', ( chunk ) => {
		buf += chunk.toString();
		const lines = buf.split( '\n' );
		buf = lines.pop();
		for ( const line of lines ) {
			if ( onLine ) onLine( line );
			if ( shouldForward( line ) ) outStream.write( `${ prefix } ${ line }\n` );
		}
	} );
	stream.on( 'end', () => {
		if ( buf ) {
			if ( onLine ) onLine( buf );
			if ( shouldForward( buf ) ) outStream.write( `${ prefix } ${ buf }\n` );
		}
	} );
}

function formatPercent( value ) {
	if ( typeof value !== 'number' || ! Number.isFinite( value ) ) return 'n/a';
	return ( value * 100 ).toFixed( 1 ) + '%';
}

function compactText( value, max = 220 ) {
	const text = String( value || '' ).replace( /\s+/g, ' ' ).trim();
	return text.length > max ? text.slice( 0, max - 1 ) + '…' : text;
}

function formatPixelGate( gate ) {
	if ( ! gate ) return 'psnr n/a';
	if ( gate.skipped ) return `psnr skipped (${ compactText( gate.reason, 48 ) })`;
	if ( gate.pass === undefined ) return 'psnr n/a';
	return `psnr ${ gate.psnr }/${ gate.threshold } dB ${ gate.pass ? 'ok' : 'FAIL' }`;
}

function diagnosticNote( diagnostics ) {
	if ( ! diagnostics ) return '';
	const parts = [];
	if ( diagnostics.healedNullTextureImages > 0 ) parts.push( `healed-null-images=${ diagnostics.healedNullTextureImages }` );
	const fallbacks = diagnostics.colorTransferFallbacks || {};
	const fallbackTotal = Object.values( fallbacks ).reduce( ( sum, count ) => sum + ( count | 0 ), 0 );
	if ( fallbackTotal > 0 ) parts.push( `color-fallbacks=${ fallbackTotal }` );
	return parts.join( ', ' );
}

function printFailureSummary( details, max = 25 ) {
	const failures = details.filter( ( result ) => result && result.status === 'fail' );
	if ( failures.length === 0 ) return;
	console.log( '\nTop failures:' );
	for ( const result of failures.slice( 0, max ) ) {
		const captureErrors = Array.isArray( result.captureErrors ) ? result.captureErrors.length : 0;
		const replayErrors = Array.isArray( result.replayErrors ) ? result.replayErrors.length : 0;
		const diag = diagnosticNote( result.replayDiagnostics );
		console.log( `  - ${ result.name }: ${ formatPixelGate( result.pixelGate ) }; replay ${ formatPercent( result.replayBrightFrac ) }; artifacts ${ result.userArtifacts }+${ result.auxArtifacts }; captureErrors=${ captureErrors }; replayErrors=${ replayErrors }${ diag ? '; ' + diag : '' }` );
		if ( result.error ) console.log( `    ${ compactText( result.error ) }` );
	}
	if ( failures.length > max ) console.log( `  ... ${ failures.length - max } more failures in ${ join( OUT, 'e2e-report.json' ) }` );
}

const promises = jobs.map( ( { off, lim, port, report, idx } ) =>
	new Promise( ( resolve ) => {
		const child = spawn(
			process.execPath,
			[
				'run-e2e.mjs',
				`--offset=${ off }`,
				`--limit=${ lim }`,
				`--port=${ port }`,
				`--report=${ report }`,
				...forwarded,
			],
			{ cwd: SELF, stdio: [ 'ignore', 'pipe', 'pipe' ] }
		);

		const prefix = `[w${ idx }]`;
		let summary = '';
		attachLinePrefix( child.stdout, process.stdout, prefix, ( line ) => {
			if ( line.includes( ' pass,' ) ) summary = line.trim();
		}, shouldForwardWorkerLine );
		attachLinePrefix( child.stderr, process.stderr, prefix, null, shouldForwardWorkerLine );

		child.on( 'close', ( code ) => {
			console.log( `[e2e-parallel] worker ${ idx } done (exit=${ code })${ summary ? ' — ' + summary : '' }` );
			resolve( { code, idx, report } );
		} );
	} )
);

const results = await Promise.all( promises );

// Merge worker reports into a single e2e-report.json
console.log( '\n[e2e-parallel] merging reports...' );

const merged = { total: 0, pass: 0, fail: 0, skip: 0, details: [] };

for ( const { report } of jobs ) {
	const reportPath = resolve( OUT, report );
	if ( ! existsSync( reportPath ) ) {
		console.warn( `[e2e-parallel] missing report: ${ report }` );
		continue;
	}
	const w = JSON.parse( readFileSync( reportPath, 'utf8' ) );
	merged.total += w.total || 0;
	merged.pass  += w.pass  || 0;
	merged.fail  += w.fail  || 0;
	merged.skip  += w.skip  || 0;
	merged.details.push( ...( w.details || [] ) );
}

merged.details.sort( ( a, b ) => ( a.name || '' ).localeCompare( b.name || '' ) );

const finalReport = resolve( OUT, 'e2e-report.json' );
writeFileSync( finalReport, JSON.stringify( merged, null, 2 ) );

console.log( '\n═══ e2e-parallel summary ═══' );
console.log( `  ${ merged.pass } pass, ${ merged.fail } fail, ${ merged.total } candidates tested, ${ merged.skip } skipped` );
console.log( `  report: ${ finalReport }` );
printFailureSummary( merged.details );

process.exit( results.some( r => r.code !== 0 ) ? 1 : 0 );
