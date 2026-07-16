import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SLIM_REPLAY_SOURCE_CLOSURE = [
	'../src/precompiled-compute-node.js',
	'../src/precompiled-compute-runner.js',
	'../src/hydrate/builtin-textures.js',
	'../src/hydrate/clipping-planes.js',
	'../src/hydrate/dynamic-light-buffers.js',
	'../src/hydrate/fallback-textures.js',
	'../src/hydrate/light-writers.js',
	'../src/hydrate/material-binding-owner.js',
	'../src/hydrate/material-writers.js',
	'../src/hydrate/rebinders/shadow-depth-rebinder.js',
	'../src/hydrate/rebinders/viewport-copy-source.js',
	'../src/hydrate/texture-snapshot.js',
	'../src/hydrate/user-attributes.js',
	'../src/slim-replay-shadow-material.js',
];

const BARE_THREE_IMPORT_RE = /(?:\bfrom\s+|^\s*import\s+|\bimport\s*\(\s*)['"]three['"]/m;
const THREE_IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(\s*)['"](three[^'"]*)['"]/g;

test( 'slim replay source closure avoids the bare Three barrel', () => {

	for ( const relativePath of SLIM_REPLAY_SOURCE_CLOSURE ) {

		const source = readFileSync( new URL( relativePath, import.meta.url ), 'utf8' );
		assert.doesNotMatch( source, BARE_THREE_IMPORT_RE, `${ relativePath } must import the exact Three source module` );

	}

} );

test( 'slim replay source closure routes remaining Three dependencies to direct source modules', () => {

	for ( const relativePath of SLIM_REPLAY_SOURCE_CLOSURE ) {

		const source = readFileSync( new URL( relativePath, import.meta.url ), 'utf8' );
		const specifiers = [ ...source.matchAll( THREE_IMPORT_RE ) ].map( ( match ) => match[ 1 ] );
		for ( const specifier of specifiers ) {

			assert.match( specifier, /^three\/src\/.+\.js$/, `${ relativePath } has a non-source Three import: ${ specifier }` );
			assert.notEqual( specifier, 'three/src/Three.Core.js', `${ relativePath } must not recover the Three.Core barrel` );

		}

	}

} );

test( 'slim replay source closure imports against the installed Three version', async () => {

	await Promise.all( SLIM_REPLAY_SOURCE_CLOSURE.map( ( relativePath ) => import( new URL( relativePath, import.meta.url ) ) ) );

} );
