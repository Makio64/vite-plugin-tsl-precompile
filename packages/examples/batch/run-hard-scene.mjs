#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	hardSceneHarnessArgv,
	hardScenePlan,
	loadHardSceneManifest,
	selectHardSceneCase,
} from './hard-scene-plan.mjs';
import { prepareOutputRoot } from './output-path-safety.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const REPO = resolve( SELF, '../../..' );
const RUNNER = fileURLToPath( import.meta.url );
const args = process.argv.slice( 2 ).filter( ( argument ) => argument !== '--' );
const valuePrefixes = [ '--case=', '--three-repo=', '--output-root=', '--slim-bundle=' ];
const flags = new Set( [ '--plan' ] );
const unknown = args.filter(
	( argument ) => ! flags.has( argument ) && ! valuePrefixes.some( ( prefix ) => argument.startsWith( prefix ) )
);
if ( unknown.length > 0 ) {

	console.error( `[hard-scene] unknown option(s): ${ unknown.join( ', ' ) }.` );
	process.exit( 2 );

}
for ( const prefix of valuePrefixes ) {

	if ( args.filter( ( argument ) => argument.startsWith( prefix ) ).length > 1 ) {

		console.error( `[hard-scene] option ${ prefix.slice( 0, - 1 ) } may be provided only once.` );
		process.exit( 2 );

	}

}
if ( args.filter( ( argument ) => argument === '--plan' ).length > 1 ) {

	console.error( '[hard-scene] option --plan may be provided only once.' );
	process.exit( 2 );

}

function argumentValue( prefix ) {

	const argument = args.find( ( value ) => value.startsWith( prefix ) );
	return argument ? argument.slice( prefix.length ) : '';

}

let manifest;
let selectedCase = null;
try {

	manifest = loadHardSceneManifest();
	const requestedCase = argumentValue( '--case=' );
	if ( requestedCase ) selectedCase = selectHardSceneCase( manifest, requestedCase );

} catch ( error ) {

	console.error( `[hard-scene] ${ error?.message || error }.` );
	process.exit( 2 );

}

const threeRepo = resolve(
	argumentValue( '--three-repo=' ) ||
	process.env.TSLP_THREE_REPO ||
	resolve( REPO, '../three.js' )
);
const slimBundleValue = argumentValue( '--slim-bundle=' ) || process.env.TSLP_E2E_SLIM_BUNDLE || '';
const slimBundle = slimBundleValue ? resolve( slimBundleValue ) : '';
const threeRepoAvailable = existsSync( resolve( threeRepo, 'examples' ) );

if ( args.includes( '--plan' ) ) {

	console.log( JSON.stringify( hardScenePlan( {
		manifest,
		selectedCase,
		threeRepo,
		threeRepoAvailable,
		slimBundle,
		runnerPath: RUNNER,
		repositoryRoot: REPO,
	} ) ) );
	process.exit( 0 );

}
if ( ! selectedCase ) {

	console.error( '[hard-scene] --case=<exact-filename.html> is required; use --plan to list cases.' );
	process.exit( 2 );

}
if ( ! threeRepoAvailable ) {

	console.error( `[hard-scene] Three examples not found below ${ threeRepo }; pass --three-repo=<clean-official-r185-checkout>.` );
	process.exit( 2 );

}
if ( slimBundle && ! existsSync( slimBundle ) ) {

	console.error( `[hard-scene] slim bundle not found at ${ slimBundle }.` );
	process.exit( 2 );

}

const explicitOutputRoot = argumentValue( '--output-root=' );
if ( explicitOutputRoot && existsSync( resolve( explicitOutputRoot ) ) ) {

	console.error( '[hard-scene] --output-root must not already exist; refusing to overwrite shared or prior evidence.' );
	process.exit( 2 );

}
let outputRoot;
try {

	const selectedOutputRoot = explicitOutputRoot
		? resolve( explicitOutputRoot )
		: mkdtempSync( join( tmpdir(), 'tslp-hard-scene-' ) );
	outputRoot = prepareOutputRoot( selectedOutputRoot, {
		repositoryRoot: REPO,
		label: 'Hard-scene output root',
	} );

} catch ( error ) {

	console.error( `[hard-scene] unsafe output root: ${ error?.message || error }` );
	process.exit( 2 );

}

const childArgv = hardSceneHarnessArgv( {
	selectedCase,
	threeRepo,
	outputRoot,
	slimBundle,
	psnrThresholdDb: manifest.psnrThresholdDb,
} );
console.log( `[hard-scene] case ${ selectedCase.filename }` );
console.log( `[hard-scene] evidence ${ outputRoot }` );

const child = spawn( process.execPath, childArgv, {
	cwd: REPO,
	stdio: 'inherit',
} );
child.on( 'error', ( error ) => {

	console.error( `[hard-scene] could not start the existing E2E harness: ${ error.message }` );
	process.exit( 1 );

} );
child.on( 'close', ( code, signal ) => {

	if ( signal === 'SIGINT' ) process.exit( 130 );
	if ( signal === 'SIGTERM' ) process.exit( 143 );
	if ( signal === 'SIGHUP' ) process.exit( 129 );
	process.exit( code ?? 1 );

} );
