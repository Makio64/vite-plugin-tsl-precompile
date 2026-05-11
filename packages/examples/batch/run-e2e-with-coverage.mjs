#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const args = process.argv.slice( 2 );

const parallel = args.includes( '--parallel' );
const coverageEnabled = ! args.includes( '--no-coverage' );
const saveShotsEnabled = ! args.includes( '--no-save-shots' );

const forwarded = args.filter( ( arg ) =>
	arg !== '--parallel' &&
	arg !== '--no-coverage' &&
	arg !== '--no-save-shots' &&
	arg !== '--'
);

if ( saveShotsEnabled && ! forwarded.includes( '--save-shots' ) ) {

	forwarded.push( '--save-shots' );

}

function signalExitCode( signal ) {

	if ( signal === 'SIGINT' ) return 130;
	if ( signal === 'SIGTERM' ) return 143;
	if ( signal === 'SIGHUP' ) return 129;
	return 1;

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

const modeLabel = parallel ? 'running parallel e2e' : 'running serial e2e';
const e2eStatus = await runNode(
	`${ modeLabel }${ saveShotsEnabled ? ' with saved screenshots' : '' }`,
	parallel ? 'run-e2e-parallel.mjs' : 'run-e2e.mjs',
	forwarded
);

let coverageStatus = 0;
if ( coverageEnabled ) {

	coverageStatus = await runNode( 'refreshing coverage summary', 'run-coverage-summary.mjs' );

}

process.exit( e2eStatus || coverageStatus );
