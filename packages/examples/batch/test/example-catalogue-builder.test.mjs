import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { buildCatalogue, validateCatalogueSnapshot } from '../scripts/build-example-catalogue.mjs';

function fixture() {

	const root = mkdtempSync( join( tmpdir(), 'tslp-example-catalogue-' ) );
	const repoRoot = join( root, 'project' );
	const examplesRoot = join( repoRoot, 'packages/examples' );
	const localRoot = join( examplesRoot, 'local-demo' );
	const threeRepoPath = join( root, 'three' );
	const threeExamples = join( threeRepoPath, 'examples' );
	const cataloguePath = join( root, 'example-catalogue.json' );

	mkdirSync( localRoot, { recursive: true } );
	mkdirSync( threeExamples, { recursive: true } );
	mkdirSync( join( threeRepoPath, 'src' ), { recursive: true } );
	writeFileSync( join( threeRepoPath, 'package.json' ), JSON.stringify( { version: '0.185.1' } ) );
	writeFileSync( join( threeRepoPath, 'src/constants.js' ), "export const REVISION = '185';\n" );
	writeFileSync( join( threeExamples, 'webgpu_alpha.html' ), '' );
	writeFileSync( join( threeExamples, 'webgpu_compile_async.html' ), '' );
	writeFileSync( join( threeExamples, 'webgpu_tsl_transpiler.html' ), '' );
	writeFileSync( join( threeExamples, 'webgpu_xr_cubes.html' ), '' );
	writeFileSync( join( localRoot, 'case.html' ), '' );
	writeFileSync( join( localRoot, 'e2e-cases.json' ), JSON.stringify( {
		cases: [
			{ name: 'local-variant.html', path: 'case.html?variant=one' },
		],
	} ) );
	return { root, repoRoot, examplesRoot, threeRepoPath, cataloguePath };

}

test( 'explicit r185 checkout drives upstream discovery and includes every local case', ( t ) => {

	const paths = fixture();
	t.after( () => rmSync( paths.root, { recursive: true, force: true } ) );

	const catalogue = buildCatalogue( { ...paths, verifyCheckout() {} } );
	assert.equal( catalogue.threeVersion, '0.185.1' );
	assert.deepEqual( catalogue.cases.map( ( entry ) => entry.id ), [
		'case',
		'local-variant',
		'webgpu_alpha',
	] );
	assert.equal( catalogue.cases.find( ( entry ) => entry.id === 'local-variant' ).source.route, 'case.html?variant=one' );
	assert.equal( catalogue.cases.some( ( entry ) => entry.id === 'webgpu_stale' ), false );

} );

test( 'checked catalogue snapshot validates local routes without trusting coverage output', ( t ) => {

	const paths = fixture();
	t.after( () => rmSync( paths.root, { recursive: true, force: true } ) );

	const generated = buildCatalogue( { ...paths, verifyCheckout() {} } );
	writeFileSync( paths.cataloguePath, JSON.stringify( generated, null, '\t' ) + '\n' );
	const catalogue = validateCatalogueSnapshot( {
		cataloguePath: paths.cataloguePath,
		repoRoot: paths.repoRoot,
		examplesRoot: paths.examplesRoot,
	} );
	assert.deepEqual( catalogue.cases.map( ( entry ) => entry.id ), [
		'case',
		'local-variant',
		'webgpu_alpha',
	] );

} );

test( 'catalogue generation refuses a coverage-backed refresh without an exact checkout', () => {

	assert.throws( () => buildCatalogue(), /requires --three-repo/ );

} );

test( 'checked catalogue snapshots reject traversal identifiers', ( t ) => {

	const paths = fixture();
	t.after( () => rmSync( paths.root, { recursive: true, force: true } ) );
	const generated = buildCatalogue( { ...paths, verifyCheckout() {} } );
	generated.cases[ 0 ].id = '../../../../outside';
	writeFileSync( paths.cataloguePath, JSON.stringify( generated, null, '\t' ) + '\n' );

	assert.throws(
		() => validateCatalogueSnapshot( {
			cataloguePath: paths.cataloguePath,
			repoRoot: paths.repoRoot,
			examplesRoot: paths.examplesRoot,
		} ),
		/canonical path-segment identifier/,
	);

} );
