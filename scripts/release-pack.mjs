#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	collectReleaseTarballIntegrity,
	PUBLIC_PACKAGES,
} from './release-tarball-integrity.mjs';

const SCRIPT_DIR = dirname( fileURLToPath( import.meta.url ) );
const REPO_ROOT = resolve( SCRIPT_DIR, '..' );

export function prepareReleaseTarballDirectory( {
	requestedDirectory = '',
	environment = process.env,
} = {} ) {

	const configured = requestedDirectory || environment.TSLP_RELEASE_TARBALL_DIR || '';
	if ( ! configured ) {

		return mkdtempSync( join( tmpdir(), 'tslp-release-tarballs-' ) );

	}
	const directory = resolve( configured );
	if ( existsSync( directory ) ) {

		if ( readdirSync( directory ).length > 0 ) {

			throw new Error( `release tarball directory is not empty: ${ directory }` );

		}

	} else {

		mkdirSync( directory, { recursive: true, mode: 0o700 } );

	}
	chmodSync( directory, 0o700 );
	return directory;

}

export function packReleaseTarballs( {
	repoRoot = REPO_ROOT,
	tarballDirectory,
	execute = spawnSync,
} ) {

	if ( ! tarballDirectory ) throw new Error( 'tarballDirectory is required' );
	const args = [
		...PUBLIC_PACKAGES.flatMap( ( pkg ) => [ '--filter', `{${ pkg.directory }}` ] ),
		'pack',
		'--pack-destination',
		tarballDirectory,
	];
	const result = execute( 'pnpm', args, {
		cwd: repoRoot,
		stdio: 'inherit',
	} );
	if ( result?.error ) throw result.error;
	if ( result?.signal ) throw new Error( `pnpm pack terminated by ${ result.signal }` );
	if ( result?.status !== 0 ) throw new Error( `pnpm pack exited ${ result?.status ?? 'without a status' }` );
	return collectReleaseTarballIntegrity( { repoRoot, tarballDirectory } );

}

export function parsePackArgs( argv ) {

	const normalized = argv[ 0 ] === '--' ? argv.slice( 1 ) : argv;
	const directoryArgs = normalized.filter( ( arg ) => arg.startsWith( '--directory=' ) );
	const unknown = normalized.filter( ( arg ) => ! arg.startsWith( '--directory=' ) );
	if ( unknown.length > 0 ) throw new Error( `unknown option(s): ${ unknown.join( ' ' ) }` );
	if ( directoryArgs.length > 1 ) throw new Error( '--directory may be provided only once' );
	return directoryArgs[ 0 ]?.slice( '--directory='.length ) || '';

}

if ( process.argv[ 1 ] && resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {

	try {

		const requestedDirectory = parsePackArgs( process.argv.slice( 2 ) );
		const tarballDirectory = prepareReleaseTarballDirectory( { requestedDirectory } );
		const packages = packReleaseTarballs( { tarballDirectory } );
		console.log( JSON.stringify( {
			tarballDirectory,
			packages,
		}, null, 2 ) );

	} catch ( error ) {

		console.error( `[release-pack] FAILED: ${ error.message }` );
		process.exitCode = 1;

	}

}
