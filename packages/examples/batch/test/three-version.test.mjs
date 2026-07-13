import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
	assertThreeCheckoutMatchesVersion,
	THREE_CHECKOUT_VERSION_MISMATCH,
} from '../_three-version.mjs';

function checkoutFixture( { revision, packageVersion } ) {

	const root = mkdtempSync( join( tmpdir(), 'tslp-three-checkout-' ) );
	test.after( () => rmSync( root, { recursive: true, force: true } ) );
	mkdirSync( join( root, 'src' ) );
	writeFileSync( join( root, 'src/constants.js' ), `export const REVISION = ${ JSON.stringify( revision ) };\n` );
	writeFileSync( join( root, 'package.json' ), `${ JSON.stringify( { name: 'three', version: packageVersion }, null, 2 ) }\n` );
	return root;

}

test( 'exact checkout gate accepts r184 source and package 0.184.0', () => {

	const root = checkoutFixture( { revision: '184', packageVersion: '0.184.0' } );
	const result = assertThreeCheckoutMatchesVersion( root, '0.184.0', 'test-exact-three' );
	assert.equal( result.revision, '184' );
	assert.equal( result.revisionNumber, 184 );
	assert.equal( result.packageVersion, '0.184.0' );

} );

test( 'exact checkout gate rejects r185dev source and package 0.185.0', () => {

	const root = checkoutFixture( { revision: '185dev', packageVersion: '0.185.0' } );
	assert.throws(
		() => assertThreeCheckoutMatchesVersion( root, '0.184.0', 'test-exact-three' ),
		( error ) => {

			assert.equal( error.code, THREE_CHECKOUT_VERSION_MISMATCH );
			assert.match( error.message, /REVISION="185dev", expected "184"/ );
			assert.match( error.message, /version "0\.185\.0", expected "0\.184\.0"/ );
			assert.match( error.message, /--three-repo=<path>/ );
			assert.match( error.message, /signed stable release matches/ );
			assert.match( error.message, /Development REVISION suffixes are intentionally rejected/ );
			return true;

		},
	);

} );

test( 'exact checkout gate rejects mismatched package metadata even at the expected revision', () => {

	const root = checkoutFixture( { revision: '184', packageVersion: '0.183.0' } );
	assert.throws(
		() => assertThreeCheckoutMatchesVersion( root, '0.184.0', 'test-exact-three' ),
		( error ) => {

			assert.equal( error.code, THREE_CHECKOUT_VERSION_MISMATCH );
			assert.doesNotMatch( error.message, /src\/constants\.js reports/ );
			assert.match( error.message, /version "0\.183\.0", expected "0\.184\.0"/ );
			return true;

		},
	);

} );

test( 'exact checkout gate rejects an invalid signed bundle version', () => {

	const root = checkoutFixture( { revision: '184', packageVersion: '0.184.0' } );
	assert.throws(
		() => assertThreeCheckoutMatchesVersion( root, '184dev', 'test-exact-three' ),
		( error ) => {

			assert.equal( error.code, THREE_CHECKOUT_VERSION_MISMATCH );
			assert.match( error.message, /signed slim bundle reports invalid three\.js package version/ );
			return true;

		},
	);

} );

test( 'checkout reader ignores comments and similarly named constants', () => {

	const root = checkoutFixture( { revision: '184', packageVersion: '0.184.0' } );
	writeFileSync(
		join( root, 'src/constants.js' ),
		`// export const REVISION = '999';\nexport const SOME_REVISION = '998';\nexport const REVISION = '184';\n`,
	);
	const result = assertThreeCheckoutMatchesVersion( root, '0.184.0', 'test-exact-three' );
	assert.equal( result.revision, '184' );

} );

test( 'exact checkout gate rejects a development revision hidden by matching package metadata', () => {

	const root = checkoutFixture( { revision: '185dev', packageVersion: '0.184.0' } );
	assert.throws(
		() => assertThreeCheckoutMatchesVersion( root, '0.184.0', 'test-exact-three' ),
		( error ) => {

			assert.equal( error.code, THREE_CHECKOUT_VERSION_MISMATCH );
			assert.match( error.message, /REVISION="185dev", expected "184"/ );
			assert.doesNotMatch( error.message, /package\.json reports version/ );
			return true;

		},
	);

} );

test( 'both replay entry points derive the exact checkout gate from the signed bundle', () => {

	const e2eSource = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );
	const slimSource = readFileSync( new URL( '../run-slim.mjs', import.meta.url ), 'utf8' );
	assert.match( e2eSource, /assertThreeCheckoutMatchesVersion\( threeRepo, SLIM_HASH_OPTS\.threeVersion, 'batch-e2e' \)/ );
	assert.match( slimSource, /slimBundleHashOptions\( slimBundle \)/ );
	assert.match( slimSource, /assertThreeCheckoutMatchesVersion\( threeRepo, slimHashOptions\.threeVersion, 'batch-slim' \)/ );

} );
