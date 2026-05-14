#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const args = process.argv.slice( 2 );

const coverageEnabled = ! args.includes( '--no-coverage' );
const saveShotsEnabled = ! args.includes( '--no-save-shots' );

const forwarded = args.filter( ( arg ) =>
	arg !== '--no-coverage' &&
	arg !== '--'
);
const reportArg = forwarded.find( ( arg ) => arg.startsWith( '--report=' ) );
const reportFile = reportArg ? reportArg.slice( '--report='.length ) : 'e2e-report.json';
const reportPath = resolve( SELF, 'results', reportFile );

function signalExitCode( signal ) {

	if ( signal === 'SIGINT' ) return 130;
	if ( signal === 'SIGTERM' ) return 143;
	if ( signal === 'SIGHUP' ) return 129;
	return 1;

}

function safeExampleName( name ) {

	return String( name || 'unknown' ).replace( /[^A-Za-z0-9_.-]/g, '_' );

}

function retrySummary( result ) {

	return {
		status: result.status,
		error: result.error || null,
		captureBrightFrac: result.captureBrightFrac,
		replayBrightFrac: result.replayBrightFrac,
		pixelGate: result.pixelGate || null,
		captureErrors: Array.isArray( result.captureErrors ) ? result.captureErrors : [],
		replayErrors: Array.isArray( result.replayErrors ) ? result.replayErrors : [],
	};

}

function readReport( path ) {

	if ( ! existsSync( path ) ) return null;
	try { return JSON.parse( readFileSync( path, 'utf8' ) ); } catch ( _ ) { return null; }

}

function writeReport( path, report ) {

	writeFileSync( path, JSON.stringify( report, null, 2 ) );

}

function retryArgsFor( name, retryReportFile ) {

	const out = forwarded.filter( ( arg ) =>
		! arg.startsWith( '--tier=' ) &&
		! arg.startsWith( '--filter=' ) &&
		! arg.startsWith( '--report=' ) &&
		! arg.startsWith( '--limit=' ) &&
		! arg.startsWith( '--offset=' ) &&
		! arg.startsWith( '--max-runs-per-browser=' )
	);
	out.push( `--filter=${ name }` );
	out.push( `--report=${ retryReportFile }` );
	out.push( '--max-runs-per-browser=1' );
	return out;

}

async function retryFailedExamples( report ) {

	if ( ! report || ! Array.isArray( report.details ) ) return 1;
	const failures = report.details.filter( ( detail ) => detail && detail.status === 'fail' && detail.name );
	if ( failures.length === 0 ) return 0;

	let recovered = 0;
	for ( const failure of failures ) {

		const retryReportFile = `${ reportFile.replace( /\.json$/i, '' ) }.retry-${ safeExampleName( failure.name ) }.json`;
		const status = await runNode(
			`retrying failed example ${ failure.name } in an isolated process`,
			'run-e2e.mjs',
			retryArgsFor( failure.name, retryReportFile ),
		);
		const retryReport = readReport( resolve( SELF, 'results', retryReportFile ) );
		const retryDetail = retryReport && Array.isArray( retryReport.details ) ? retryReport.details.find( ( detail ) => detail.name === failure.name ) : null;
		if ( ! retryDetail ) continue;

		retryDetail.retryOf = retrySummary( failure );
		retryDetail.retryProcessReport = retryReportFile;
		const index = report.details.indexOf( failure );
		if ( index >= 0 ) report.details[ index ] = retryDetail;
		if ( status === 0 && retryDetail.status === 'pass' ) recovered ++;

	}

	report.pass = report.details.filter( ( detail ) => detail && detail.status === 'pass' ).length;
	report.fail = report.details.filter( ( detail ) => detail && detail.status === 'fail' ).length;
	writeReport( reportPath, report );
	if ( recovered > 0 ) console.log( `[e2e-with-coverage] recovered ${ recovered } transient failure(s) via isolated retry` );
	return report.fail === 0 ? 0 : 1;

}

function runNode( label, script, scriptArgs = [] ) {

	return new Promise( ( resolveExit ) => {

		console.log( `[e2e-with-coverage] ${ label }` );
		const child = spawn(
			process.execPath,
			[ resolve( SELF, script ), ...scriptArgs ],
			{ cwd: SELF, stdio: 'inherit' }
		);

		child.on( 'error', ( err ) => {

			console.error( `[e2e-with-coverage] failed to start ${ script }: ${ err.message }` );
			resolveExit( 1 );

		} );

		child.on( 'close', ( code, signal ) => {

			resolveExit( signal ? signalExitCode( signal ) : code ?? 1 );

		} );

	} );

}

let e2eStatus = await runNode(
	`running e2e${ saveShotsEnabled ? ' with saved screenshots' : '' }`,
	'run-e2e.mjs',
	forwarded
);

if ( e2eStatus !== 0 ) {

	const report = readReport( reportPath );
	const retryStatus = await retryFailedExamples( report );
	if ( retryStatus === 0 ) e2eStatus = 0;

}

let coverageStatus = 0;
if ( coverageEnabled ) {

	coverageStatus = await runNode(
		'refreshing coverage summary',
		'run-coverage-summary.mjs',
		reportArg ? [ reportArg ] : []
	);

}

process.exit( e2eStatus || coverageStatus );
