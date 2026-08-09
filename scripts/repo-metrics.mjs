// Shared, reproducible source measurements for the architecture gates.
//
// Every number this module produces is defined by an exact, quotable rule so a
// document can cite the command instead of a digit that goes stale the next
// commit. `check-module-budgets.mjs` (concentration ratchet) and
// `check-diagnostic-globals.mjs` (debug-global registry) both read from here so
// the two gates can never disagree about what they measured.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve( fileURLToPath( import.meta.url ), '../..' );

// Matches `grep -oE '\b(if|switch|case)\b' <file> | wc -l`. A deliberately dumb
// proxy for branch density: it counts keyword occurrences in comments and
// strings too. That is acceptable because the value of the metric is that it is
// trivially reproducible and monotone with real complexity, not that it is a
// precise AST measure.
export const BRANCH_KEYWORD_PATTERN = '\\b(?:if|switch|case)\\b';

// Names installed on a global object. Only these cross the product/test
// boundary; a `__tslp*` key on a plain payload object does not.
const GLOBAL_ASSIGNMENT_PATTERNS = Object.freeze( [
	/(?:globalThis|window|self)\s*\.\s*(__(?:tslp|TSLP)[A-Za-z0-9_]*)/g,
	/(?:globalThis|window|self)\s*\[\s*'(__(?:tslp|TSLP)[A-Za-z0-9_]*)'\s*\]/g,
	/(?:globalThis|window|self)\s*\[\s*"(__(?:tslp|TSLP)[A-Za-z0-9_]*)"\s*\]/g,
] );

const SKIPPED_DIRECTORIES = Object.freeze( new Set( [
	'node_modules',
	'dist',
	'build',
	'artifacts',
	'results',
	'.git',
	'.claude',
	'.worktrees',
] ) );

export function readRepoFile( relativePath ) {

	return readFileSync( resolve( REPO_ROOT, relativePath ), 'utf8' );

}

// Matches `wc -l`: counts newline characters, so a file without a trailing
// newline does not count its last line. Keeping the definitions identical is
// what lets a reviewer check a budget by hand.
export function countLines( text ) {

	let count = 0;
	for ( let index = 0; index < text.length; index ++ ) if ( text.charCodeAt( index ) === 10 ) count ++;
	return count;

}

export function countBranchKeywords( text ) {

	return text.match( new RegExp( BRANCH_KEYWORD_PATTERN, 'g' ) )?.length || 0;

}

export function measureFile( relativePath ) {

	const text = readRepoFile( relativePath );
	return { file: relativePath, lines: countLines( text ), branches: countBranchKeywords( text ) };

}

export function listSourceFiles( relativeRoot, { extensions = [ '.js', '.mjs' ], excludeTests = false, onlyTests = false } = {} ) {

	const absoluteRoot = resolve( REPO_ROOT, relativeRoot );
	const found = [];
	const walk = ( directory ) => {

		for ( const entry of readdirSync( directory, { withFileTypes: true } ) ) {

			if ( entry.isDirectory() ) {

				if ( ! SKIPPED_DIRECTORIES.has( entry.name ) ) walk( join( directory, entry.name ) );
				continue;

			}
			if ( ! entry.isFile() ) continue;
			if ( ! extensions.some( ( extension ) => entry.name.endsWith( extension ) ) ) continue;
			const isTest = entry.name.includes( '.test.' ) || entry.name.includes( '.spec.' );
			if ( excludeTests && isTest ) continue;
			if ( onlyTests && ! isTest ) continue;
			found.push( relative( REPO_ROOT, join( directory, entry.name ) ).split( sep ).join( '/' ) );

		}

	};

	if ( ! statSync( absoluteRoot ).isDirectory() ) throw new Error( `${ relativePath( absoluteRoot ) } is not a directory.` );
	walk( absoluteRoot );
	return found.sort();

}

function relativePath( absolute ) {

	return relative( REPO_ROOT, absolute ).split( sep ).join( '/' );

}

export function summarizeTree( relativeRoot, options ) {

	const files = listSourceFiles( relativeRoot, options );
	let lines = 0;
	for ( const file of files ) lines += countLines( readRepoFile( file ) );
	return { root: relativeRoot, files: files.length, lines };

}

// Returns every `__tslp*` / `__TSLP_*` name that some module installs on a
// global object, with the files that install it. Step 3's registry gate treats
// this set as the thing that must be declared.
export function collectDebugGlobals( relativeRoots ) {

	const sites = new Map();
	for ( const root of relativeRoots ) {

		for ( const file of listSourceFiles( root ) ) {

			const text = readRepoFile( file );
			for ( const pattern of GLOBAL_ASSIGNMENT_PATTERNS ) {

				for ( const match of text.matchAll( pattern ) ) {

					const name = match[ 1 ];
					if ( ! sites.has( name ) ) sites.set( name, new Set() );
					sites.get( name ).add( file );

				}

			}

		}

	}

	return new Map( [ ...sites.entries() ]
		.sort( ( a, b ) => ( a[ 0 ] < b[ 0 ] ? - 1 : a[ 0 ] > b[ 0 ] ? 1 : 0 ) )
		.map( ( [ name, files ] ) => [ name, [ ...files ].sort() ] ) );

}
