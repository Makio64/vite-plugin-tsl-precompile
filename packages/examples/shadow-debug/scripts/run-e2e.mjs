#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname( fileURLToPath( import.meta.url ) );
const PACKAGE_ROOT = resolve( HERE, '..' );
const REPO_ROOT = resolve( PACKAGE_ROOT, '../../..' );
const BATCH_E2E = resolve( REPO_ROOT, 'packages/examples/batch/run-e2e.mjs' );

const require = createRequire( import.meta.url );
const threeEntry = require.resolve( 'three' );
const threeRepo = resolve( dirname( threeEntry ), '..' );

const args = process.argv.slice( 2 ).filter( ( arg ) => arg !== '--' );
const hasOutputRoot = args.some( ( arg ) => arg.startsWith( '--output-root=' ) );
const evidenceRoot = resolve( process.env.TSLP_E2E_OUT || resolve( REPO_ROOT, 'packages/examples/batch/results' ) );
const forwarded = [
	`--three-repo=${ threeRepo }`,
	`--local-examples-root=${ PACKAGE_ROOT }`,
	'--save-shots',
	'--report=shadow-debug-e2e-report.json',
	...( hasOutputRoot ? [] : [ `--output-root=${ resolve( evidenceRoot, 'cohorts/shadow-debug' ) }` ] ),
	...args,
];

const child = spawn( process.execPath, [ BATCH_E2E, ...forwarded ], {
	cwd: REPO_ROOT,
	stdio: 'inherit',
} );

child.on( 'error', ( err ) => {
	console.error( `[shadow-debug-e2e] failed to start: ${ err.message }` );
	process.exit( 1 );
} );

child.on( 'close', ( code, signal ) => {
	if ( signal === 'SIGINT' ) process.exit( 130 );
	if ( signal === 'SIGTERM' ) process.exit( 143 );
	process.exit( code ?? 1 );
} );
