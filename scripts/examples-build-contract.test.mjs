import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
	assertExamplesBuildContract,
	EXPECTED_EXAMPLE_BUILD_PACKAGES,
	inspectExamplesBuildContract,
} from './examples-build-contract.mjs';

function validRecords() {

	return EXPECTED_EXAMPLE_BUILD_PACKAGES.map( entry => ( {
		manifestPath: entry.manifestPath,
		name: entry.name,
		private: true,
		build: entry.build,
	} ) );

}

test( 'repository example build package set matches the explicit CI contract', () => {

	const result = inspectExamplesBuildContract();
	assert.equal( result.buildPackageCount, EXPECTED_EXAMPLE_BUILD_PACKAGES.length );
	assert.deepEqual(
		Object.keys( result.ciPhases ).sort(),
		[ 'preview-smoke', 'recursive-build', 'showcase-preview' ],
	);

} );

test( 'root build and example CI entry points run the build contract before recursive builds', () => {

	const rootManifest = JSON.parse( readFileSync( new URL( '../package.json', import.meta.url ), 'utf8' ) );
	assert.equal(
		rootManifest.scripts[ 'test:examples:contract' ],
		'node --test scripts/examples-build-contract.test.mjs && node scripts/examples-build-contract.mjs',
	);
	assert.match( rootManifest.scripts.build, /^node scripts\/examples-build-contract\.mjs && / );
	assert.match( rootManifest.scripts[ 'test:examples:build' ], /^pnpm test:examples:contract && / );
	assert.match( rootManifest.scripts[ 'test:examples:ci' ], /^pnpm test:examples:contract && / );

} );

test( 'example build contract rejects a removed package or required build script', () => {

	const records = validRecords();
	assert.throws(
		() => assertExamplesBuildContract( records.slice( 1 ) ),
		/Required CI example package is missing/,
	);
	assert.throws(
		() => assertExamplesBuildContract( records.map( ( record, index ) => (
			index === 0 ? { ...record, build: undefined } : record
		) ) ),
		/missing its required build script/,
	);

} );

test( 'example build contract rejects build-command drift and unreviewed build packages', () => {

	const records = validRecords();
	assert.throws(
		() => assertExamplesBuildContract( records.map( ( record, index ) => (
			index === 0 ? { ...record, build: 'true' } : record
		) ) ),
		/build script drifted/,
	);
	assert.throws(
		() => assertExamplesBuildContract( [
			...records,
			{
				manifestPath: 'packages/examples/unreviewed/package.json',
				name: 'examples-unreviewed',
				private: true,
				build: 'vite build',
			},
		] ),
		/Unexpected: examples-unreviewed/,
	);

} );
