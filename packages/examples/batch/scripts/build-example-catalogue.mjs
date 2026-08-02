#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertOfficialThreeR185Checkout } from '../_three-version.mjs';
import { readSafeContainedFile } from '../e2e-evidence.mjs';
import { shouldSkipE2EExample } from '../example-skip-policy.mjs';
import { discoverLocalExampleCases } from '../local-example-discovery.mjs';
import {
	assertCanonicalExampleId,
	prepareOutputRoot,
	writeOutputFileAtomic,
} from '../output-path-safety.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const BATCH_ROOT = resolve( SELF, '..' );
const REPO_ROOT = resolve( BATCH_ROOT, '../../..' );
const EXAMPLES_ROOT = resolve( REPO_ROOT, 'packages/examples' );
const OUTPUT_PATH = resolve( BATCH_ROOT, 'example-catalogue.json' );
const THREE_VERSION = '0.185.1';

function splitRoute( route ) {

	const [ pathAndQuery, hash = '' ] = String( route ).split( '#', 2 );
	const [ path, query = '' ] = pathAndQuery.split( '?', 2 );
	return { path, query, hash };

}

export function localSources( {
	repoRoot = REPO_ROOT,
	examplesRoot = EXAMPLES_ROOT,
} = {} ) {

	const byName = new Map();
	const packageDirectories = readdirSync( examplesRoot, { withFileTypes: true } )
		.filter( ( entry ) => entry.isDirectory() && entry.name !== 'batch' )
		.map( ( entry ) => resolve( examplesRoot, entry.name ) );

	for ( const packageRoot of packageDirectories ) {

		const project = basename( packageRoot );
		for ( const entry of discoverLocalExampleCases( packageRoot ) ) {

			const routeParts = splitRoute( entry.path );
			const source = {
				kind: 'local',
				project,
				path: relative( repoRoot, resolve( packageRoot, routeParts.path ) ),
				route: entry.path,
			};
			if ( byName.has( entry.name ) ) throw new Error( `duplicate local example case name ${ entry.name }` );
			byName.set( entry.name, source );

		}

	}
	return byName;

}

export function threeExampleCaseNames( threeRepoPath, verifyCheckout = assertOfficialThreeR185Checkout ) {

	verifyCheckout( threeRepoPath, 'example-catalogue' );
	const examplesRoot = resolve( threeRepoPath, 'examples' );
	if ( ! existsSync( examplesRoot ) ) throw new Error( `three.js checkout is missing examples: ${ examplesRoot }` );

	return readdirSync( examplesRoot, { withFileTypes: true } )
		.filter( ( entry ) => entry.isFile() )
		.map( ( entry ) => entry.name )
		.filter( ( filename ) => filename.startsWith( 'webgpu_' ) && filename.endsWith( '.html' ) )
		.filter( ( filename ) => ! shouldSkipE2EExample( filename ) )
		.sort();

}

function upstreamCase( filename ) {

	const id = filename.replace( /\.html$/, '' );
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

function localCase( filename, source, repoRoot ) {

	if ( ! source ) throw new Error( `${ filename }: no local source route found` );
	if ( ! existsSync( resolve( repoRoot, source.path ) ) ) throw new Error( `${ filename }: missing local source ${ source.path }` );
	return {
		id: filename.replace( /\.html$/, '' ),
		source,
	};

}

export function buildCatalogue( {
	threeRepoPath,
	repoRoot = REPO_ROOT,
	examplesRoot = EXAMPLES_ROOT,
	verifyCheckout = assertOfficialThreeR185Checkout,
} = {} ) {

	if ( ! threeRepoPath ) throw new Error( 'authoritative catalogue generation requires --three-repo=<exact-r185-checkout>' );
	const local = localSources( { repoRoot, examplesRoot } );
	const upstream = threeExampleCaseNames( threeRepoPath, verifyCheckout ).map( upstreamCase );
	const localCases = [ ...local.entries() ].map( ( [ filename, source ] ) => localCase( filename, source, repoRoot ) );
	const cases = [ ...upstream, ...localCases ];

	cases.sort( ( left, right ) => left.id.localeCompare( right.id ) );
	const ids = cases.map( ( entry ) => entry.id );
	for ( const id of ids ) assertCanonicalExampleId( id, 'Generated example catalogue identifier' );
	if ( new Set( ids ).size !== ids.length ) throw new Error( 'catalogue contains duplicate case ids' );
	return {
		schemaVersion: 1,
		threeVersion: THREE_VERSION,
		cases,
	};

}

export function validateCatalogueSnapshot( {
	cataloguePath = OUTPUT_PATH,
	repoRoot = REPO_ROOT,
	examplesRoot = EXAMPLES_ROOT,
} = {} ) {

	if ( ! existsSync( cataloguePath ) ) throw new Error( `missing ${ cataloguePath }` );
	const raw = readSafeContainedFile(
		dirname( resolve( cataloguePath ) ),
		cataloguePath,
		{ label: 'Example catalogue snapshot' },
	).toString( 'utf8' );
	const catalogue = JSON.parse( raw );
	if ( ! catalogue || Array.isArray( catalogue ) || typeof catalogue !== 'object' ) throw new Error( 'example-catalogue.json must contain an object' );
	if ( catalogue.schemaVersion !== 1 ) throw new Error( `example-catalogue.json has unsupported schemaVersion ${ catalogue.schemaVersion }` );
	if ( catalogue.threeVersion !== THREE_VERSION ) throw new Error( `example-catalogue.json targets Three ${ catalogue.threeVersion }, expected ${ THREE_VERSION }` );
	if ( ! Array.isArray( catalogue.cases ) || catalogue.cases.length === 0 ) throw new Error( 'example-catalogue.json must contain non-empty cases' );

	const ids = catalogue.cases.map( ( entry ) => entry && entry.id );
	if ( ids.some( ( id ) => typeof id !== 'string' || id.length === 0 ) ) throw new Error( 'example-catalogue.json contains a case without an id' );
	for ( const id of ids ) assertCanonicalExampleId( id, 'Example catalogue identifier' );
	if ( new Set( ids ).size !== ids.length ) throw new Error( 'example-catalogue.json contains duplicate case ids' );
	const sortedIds = ids.slice().sort( ( left, right ) => left.localeCompare( right ) );
	if ( ids.some( ( id, index ) => id !== sortedIds[ index ] ) ) throw new Error( 'example-catalogue.json cases are not sorted by id' );

	const expectedLocal = [ ...localSources( { repoRoot, examplesRoot } ).entries() ]
		.map( ( [ filename, source ] ) => localCase( filename, source, repoRoot ) )
		.sort( ( left, right ) => left.id.localeCompare( right.id ) );
	const actualLocal = catalogue.cases.filter( ( entry ) => entry.source?.kind === 'local' );
	if ( JSON.stringify( actualLocal ) !== JSON.stringify( expectedLocal ) ) {

		throw new Error( 'example-catalogue.json local routes are stale; refresh with an exact r185 checkout' );

	}

	const upstream = catalogue.cases.filter( ( entry ) => entry.source?.kind === 'three' );
	if ( upstream.length === 0 ) throw new Error( 'example-catalogue.json contains no upstream Three cases' );
	for ( const entry of upstream ) {

		const filename = `${ entry.id }.html`;
		if (
			entry.source.path !== `examples/${ filename }` ||
			entry.source.route !== filename ||
			entry.source.originalUrl !== `https://threejs.org/examples/#${ entry.id }`
		) throw new Error( `example-catalogue.json has an invalid upstream source for ${ entry.id }` );
		if ( shouldSkipE2EExample( filename ) ) throw new Error( `example-catalogue.json includes intentionally unsupported upstream case ${ filename }` );

	}

	const normalized = JSON.stringify( catalogue, null, '\t' ) + '\n';
	if ( raw !== normalized ) throw new Error( 'example-catalogue.json is not canonically formatted' );
	return catalogue;

}

function main() {

	const args = process.argv.slice( 2 );
	const checkOnly = args.includes( '--check' );
	const threeRepoArg = args.find( ( value ) => value.startsWith( '--three-repo=' ) );
	const configuredThreeRepo = threeRepoArg?.slice( '--three-repo='.length ) || process.env.TSLP_THREE_REPO || '';
	const threeRepoPath = configuredThreeRepo ? resolve( configuredThreeRepo ) : null;
	if ( args.includes( '--require-three-repo' ) && ! threeRepoPath ) {

		throw new Error( 'authoritative catalogue check requires TSLP_THREE_REPO or --three-repo=<exact-r185-checkout>' );

	}
	if ( ! checkOnly && ! threeRepoPath ) {

		throw new Error( 'catalogue refresh requires --three-repo=<exact-r185-checkout>' );

	}
	const catalogue = threeRepoPath
		? buildCatalogue( { threeRepoPath } )
		: validateCatalogueSnapshot();
	const serialized = JSON.stringify( catalogue, null, '\t' ) + '\n';

	if ( checkOnly ) {

		const current = readSafeContainedFile( BATCH_ROOT, OUTPUT_PATH, {
			label: 'Current example catalogue',
		} ).toString( 'utf8' );
		if ( current !== serialized ) throw new Error( 'example-catalogue.json is stale; refresh it with --three-repo=<exact-r185-checkout>' );
		console.log( `[example-catalogue] ${ catalogue.cases.length } tracked source routes verified${ threeRepoPath ? ' against exact r185 corpus' : ' structurally' }` );

	} else {

		const outputBoundary = prepareOutputRoot( BATCH_ROOT, {
			repositoryRoot: REPO_ROOT,
			allowedRepositoryRoots: [ BATCH_ROOT ],
			label: 'Example catalogue output boundary',
		} );
		writeOutputFileAtomic( outputBoundary, OUTPUT_PATH, serialized, {
			label: 'Example catalogue',
		} );
		console.log( `[example-catalogue] wrote ${ OUTPUT_PATH } (${ catalogue.cases.length } source routes)` );

	}

}

if ( process.argv[ 1 ] && import.meta.url === pathToFileURL( resolve( process.argv[ 1 ] ) ).href ) {

	main();

}
