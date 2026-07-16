#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const BATCH_ROOT = resolve( SELF, '..' );
const REPO_ROOT = resolve( BATCH_ROOT, '../../..' );
const EXAMPLES_ROOT = resolve( REPO_ROOT, 'packages/examples' );
const COVERAGE_PATH = resolve( BATCH_ROOT, 'results/coverage-summary.md' );
const OUTPUT_PATH = resolve( BATCH_ROOT, 'example-catalogue.json' );
const THREE_VERSION = '0.184.0';

const args = process.argv.slice( 2 );
const checkOnly = args.includes( '--check' );
const threeRepoArg = args.find( ( value ) => value.startsWith( '--three-repo=' ) );
const threeRepo = threeRepoArg ? resolve( threeRepoArg.slice( '--three-repo='.length ) ) : null;

function coverageCaseNames() {

	const markdown = readFileSync( COVERAGE_PATH, 'utf8' );
	const names = [ ...markdown.matchAll( /^\| ([^ |]+\.html) \|/gm ) ].map( ( match ) => match[ 1 ] );
	const unique = [ ...new Set( names ) ];
	if ( unique.length !== names.length ) throw new Error( 'coverage-summary.md contains duplicate example rows' );
	return unique;

}

function splitRoute( route ) {

	const [ pathAndQuery, hash = '' ] = String( route ).split( '#', 2 );
	const [ path, query = '' ] = pathAndQuery.split( '?', 2 );
	return { path, query, hash };

}

function localSources() {

	const byName = new Map();
	const packageDirectories = readdirSync( EXAMPLES_ROOT, { withFileTypes: true } )
		.filter( ( entry ) => entry.isDirectory() && entry.name !== 'batch' )
		.map( ( entry ) => resolve( EXAMPLES_ROOT, entry.name ) );

	for ( const packageRoot of packageDirectories ) {

		const project = basename( packageRoot );
		const manifestPath = resolve( packageRoot, 'e2e-cases.json' );
		if ( existsSync( manifestPath ) ) {

			const parsed = JSON.parse( readFileSync( manifestPath, 'utf8' ) );
			const cases = Array.isArray( parsed ) ? parsed : parsed.cases || [];
			for ( const entry of cases ) {

				const name = typeof entry === 'string' ? entry : entry.name;
				const route = typeof entry === 'string' ? entry : entry.path;
				if ( ! name || ! route ) continue;
				const source = splitRoute( route );
				byName.set( name, {
					kind: 'local',
					project,
					path: relative( REPO_ROOT, resolve( packageRoot, source.path ) ),
					route,
				} );

			}

		}

		for ( const filename of readdirSync( packageRoot ) ) {

			if ( filename === 'index.html' || ! filename.endsWith( '.html' ) || byName.has( filename ) ) continue;
			const source = {
				kind: 'local',
				project,
				path: relative( REPO_ROOT, resolve( packageRoot, filename ) ),
				route: filename,
			};
			if ( ! byName.has( filename ) ) byName.set( filename, source );

		}

	}
	return byName;

}

function assertThreeCheckout( cases ) {

	if ( ! threeRepo ) return;
	const packagePath = resolve( threeRepo, 'package.json' );
	if ( ! existsSync( packagePath ) ) throw new Error( `three.js checkout is missing package.json: ${ threeRepo }` );
	const version = JSON.parse( readFileSync( packagePath, 'utf8' ) ).version;
	if ( version !== THREE_VERSION ) throw new Error( `expected three.js ${ THREE_VERSION }, received ${ version } at ${ threeRepo }` );
	for ( const entry of cases ) {

		if ( entry.source.kind !== 'three' ) continue;
		const sourcePath = resolve( threeRepo, entry.source.path );
		if ( ! existsSync( sourcePath ) ) throw new Error( `${ entry.id }: missing upstream source ${ sourcePath }` );

	}

}

function buildCatalogue() {

	const local = localSources();
	const cases = coverageCaseNames().map( ( filename ) => {

		const id = filename.replace( /\.html$/, '' );
		if ( filename.startsWith( 'webgpu_' ) ) {

			return {
				id,
				source: {
					kind: 'three',
					path: `examples/${ filename }`,
					route: filename,
					originalUrl: `https://threejs.org/examples/#${ id }`,
				},
			};

		}
		const source = local.get( filename );
		if ( ! source ) throw new Error( `${ filename }: no local source route found` );
		if ( ! existsSync( resolve( REPO_ROOT, source.path ) ) ) throw new Error( `${ filename }: missing local source ${ source.path }` );
		return { id, source };

	} ).sort( ( left, right ) => left.id.localeCompare( right.id ) );

	assertThreeCheckout( cases );
	return {
		schemaVersion: 1,
		threeVersion: THREE_VERSION,
		cases,
	};

}

const catalogue = buildCatalogue();
const serialized = JSON.stringify( catalogue, null, '\t' ) + '\n';

if ( checkOnly ) {

	if ( ! existsSync( OUTPUT_PATH ) ) throw new Error( `missing ${ OUTPUT_PATH }` );
	const current = readFileSync( OUTPUT_PATH, 'utf8' );
	if ( current !== serialized ) throw new Error( 'example-catalogue.json is stale; run pnpm --filter examples-batch catalogue' );
	console.log( `[example-catalogue] ${ catalogue.cases.length } tracked source routes verified` );

} else {

	writeFileSync( OUTPUT_PATH, serialized );
	console.log( `[example-catalogue] wrote ${ OUTPUT_PATH } (${ catalogue.cases.length } source routes)` );

}
