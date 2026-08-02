import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync,
} from 'node:fs';
import {
	join,
	resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTslpBrowserImportMap } from '../e2e-browser-import-map.mjs';

const REPO = fileURLToPath( new URL( '../../../../', import.meta.url ) );
const CATALOGUE = JSON.parse( readFileSync(
	new URL( '../example-catalogue.json', import.meta.url ),
	'utf8',
) );
const RUNNER_SOURCE = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );
const LOCAL_PROJECTS = [ ...new Set(
	CATALOGUE.cases
		.filter( ( entry ) => entry.source?.kind === 'local' )
		.map( ( entry ) => entry.source.project ),
) ].sort();

function sourceFilesBelow( root ) {

	const files = [];
	function visit( directory ) {

		for ( const name of readdirSync( directory ).sort() ) {

			const file = join( directory, name );
			const stat = lstatSync( file );
			if ( stat.isDirectory() ) {

				visit( file );

			} else if ( stat.isFile() && /\.(?:js|mjs)$/.test( name ) ) {

				files.push( file );

			}

		}

	}
	visit( root );
	return files;

}

function packageSpecifiers( source ) {

	const specifiers = [];
	const staticImport = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
	const dynamicImport = /\bimport\s*\(\s*['"]([^'"]+)['"]/g;
	for ( const match of source.matchAll( staticImport ) ) specifiers.push( match[ 1 ] );
	for ( const match of source.matchAll( dynamicImport ) ) specifiers.push( match[ 1 ] );
	return specifiers;

}

function localTslpSpecifiers() {

	const found = new Map();
	for ( const project of LOCAL_PROJECTS ) {

		const sourceRoot = resolve( REPO, 'packages/examples', project, 'src' );
		for ( const file of sourceFilesBelow( sourceRoot ) ) {

			const source = readFileSync( file, 'utf8' );
			for ( const specifier of packageSpecifiers( source ) ) {

				if ( ! specifier.startsWith( '@tsl-precompile/' ) ) continue;
				if ( ! found.has( specifier ) ) found.set( specifier, [] );
				found.get( specifier ).push( file );

			}

		}

	}
	return found;

}

test( 'native-browser setup uses the endpoint-preserving capture adapter only during capture', () => {

	assert.match(
		RUNNER_SOURCE,
		/\.\.\.createTslpBrowserImportMap\( mode, \{\s*auxVirtualUrl: bust\( '\/__tslp__\/aux-virtual\.js' \),\s*\} \)/,
		'the browser import-map rewrite must consume the tested mapping helper',
	);
	assert.equal(
		createTslpBrowserImportMap( 'capture' )[ '@tsl-precompile/runtime/setup' ],
		'/__tslp_batch/e2e-capture-setup-adapter.js',
	);
	for ( const mode of [ 'stock', 'replay' ] ) {

		assert.equal(
			createTslpBrowserImportMap( mode )[ '@tsl-precompile/runtime/setup' ],
			'/__tslp_runtime/setup-production.js',
			`${ mode } must not install the development capture setup`,
		);

	}

} );

test( 'every local-cohort @tsl-precompile browser import has an exact native mapping', () => {

	const specifiers = localTslpSpecifiers();
	for ( const required of [
		'@tsl-precompile/runtime/setup',
		'@tsl-precompile/runtime/compute',
		'@tsl-precompile/runtime/material-variants',
		'@tsl-precompile/runtime/slim-support/precompiled-shadows',
	] ) {

		assert.ok( specifiers.has( required ), `expected the local source fixture ${ required }` );

	}

	for ( const mode of [ 'stock', 'capture', 'replay' ] ) {

		const imports = createTslpBrowserImportMap( mode );
		for ( const [ specifier, files ] of specifiers ) {

			assert.ok(
				Object.hasOwn( imports, specifier ),
				`${ mode} has no exact mapping for ${ specifier} imported by ${ files.join( ', ' ) }`,
			);
			assert.match(
				imports[ specifier ],
				/\.js(?:\?|$)/,
				`${ mode} mapping for ${ specifier } must target an extension-complete source file`,
			);
			const target = imports[ specifier ].split( '?', 1 )[ 0 ];
			const sourceFile = target.startsWith( '/__tslp_runtime/' )
				? resolve( REPO, 'packages/runtime/src', target.slice( '/__tslp_runtime/'.length ) )
				: target.startsWith( '/__tslp_batch/' )
					? resolve( REPO, 'packages/examples/batch', target.slice( '/__tslp_batch/'.length ) )
				: target.startsWith( '/__tslp_contract/' )
					? resolve( REPO, 'packages/contract/src', target.slice( '/__tslp_contract/'.length ) )
					: null;
			assert.ok(
				sourceFile && existsSync( sourceFile ),
				`${ mode} mapping for ${ specifier } targets a missing browser source file ${ target }`,
			);

		}

	}

} );
