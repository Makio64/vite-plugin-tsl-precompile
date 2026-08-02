import assert from 'node:assert/strict';
import { lstatSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import viteConfig from '../vite.config.js';
import {
	assertExactShowcaseRouteIds,
	SHOWCASE_ROUTE_IDS,
} from '../src/route-manifest.js';
import { SITES } from '../src/sites.js';

const ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );

test( 'showcase metadata, HTML routes, and Vite build inputs exactly match the shared manifest', () => {

	assert.ok( SHOWCASE_ROUTE_IDS.length > 0 );
	assert.deepEqual( SITES.map( site => site.id ), [ ...SHOWCASE_ROUTE_IDS ] );

	const buildInputs = viteConfig.build?.rollupOptions?.input;
	assert.ok( buildInputs && typeof buildInputs === 'object' && ! Array.isArray( buildInputs ) );
	assert.equal( buildInputs.index, resolve( ROOT, 'index.html' ) );
	const indexStat = lstatSync( buildInputs.index );
	assert.equal( indexStat.isFile(), true, 'index.html must be a regular file' );
	assert.equal( indexStat.isSymbolicLink(), false, 'index.html must not be a symbolic link' );
	const routeInputIds = Object.keys( buildInputs ).filter( id => id !== 'index' );
	assertExactShowcaseRouteIds( routeInputIds, 'Vite showcase build route inputs' );
	for ( const id of SHOWCASE_ROUTE_IDS ) {

		const input = resolve( ROOT, `${ id }.html` );
		assert.equal( buildInputs[ id ], input );
		const inputStat = lstatSync( input );
		assert.equal( inputStat.isFile(), true, `${ id }.html must be a regular file` );
		assert.equal( inputStat.isSymbolicLink(), false, `${ id }.html must not be a symbolic link` );

	}

	const htmlEntries = readdirSync( ROOT, { withFileTypes: true } )
		.filter( entry => entry.name.endsWith( '.html' ) && entry.name !== 'index.html' );
	for ( const entry of htmlEntries ) {

		assert.equal( entry.isSymbolicLink(), false, `${ entry.name } must not be a symbolic link` );
		assert.equal( entry.isFile(), true, `${ entry.name } must be a regular file` );

	}
	const htmlRouteIds = htmlEntries
		.map( entry => entry.name.slice( 0, - '.html'.length ) )
		.sort();
	assert.deepEqual( htmlRouteIds, [ ...SHOWCASE_ROUTE_IDS ].sort() );

} );

test( 'showcase route equality rejects empty, missing, additional, and malformed routes', () => {

	for ( const ids of [
		[],
		SHOWCASE_ROUTE_IDS.slice( 1 ),
		[ ...SHOWCASE_ROUTE_IDS, 'extra' ],
		SHOWCASE_ROUTE_IDS.map( ( id, index ) => index === 0 ? '../escape' : id ),
	] ) {

		assert.throws(
			() => assertExactShowcaseRouteIds( ids, 'Tampered route set' ),
			/non-empty|exactly match|non-canonical/,
		);

	}

} );
