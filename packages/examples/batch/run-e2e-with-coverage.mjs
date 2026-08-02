#!/usr/bin/env node
import { spawn } from 'node:child_process';
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
const outputRootArg = forwarded.find( ( arg ) => arg.startsWith( '--output-root=' ) );
if ( ! coverageEnabled && ! outputRootArg && ! process.env.TSLP_E2E_OUT ) {

	console.error(
		'[e2e-with-coverage] --no-coverage is diagnostic-only and must use --output-root=<isolated-directory> ' +
		'or TSLP_E2E_OUT so canonical coverage cannot remain stale.',
	);
	process.exit( 2 );

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

const e2eStatus = await runNode(
	`running e2e${ saveShotsEnabled ? ' with saved screenshots' : '' }`,
	'run-e2e.mjs',
	forwarded
);

let coverageStatus = 0;
if ( coverageEnabled && e2eStatus === 0 ) {

	coverageStatus = await runNode(
		'refreshing coverage summary',
		'run-coverage-summary.mjs',
		[ reportArg, outputRootArg ].filter( Boolean )
	);

} else if ( coverageEnabled ) {

	console.error(
		`[e2e-with-coverage] e2e exited with status ${ e2eStatus }; refusing to read old evidence or refresh coverage.`,
	);

}

process.exit( e2eStatus || coverageStatus );
