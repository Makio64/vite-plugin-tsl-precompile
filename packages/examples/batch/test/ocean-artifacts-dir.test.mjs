import test from 'node:test';
import assert from 'node:assert/strict';
import {
	mkdtempSync,
	mkdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
	dirname,
	join,
	resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	OCEAN_DIAGNOSTIC_ARTIFACTS_DIR_ENV,
	oceanArtifactsDir,
} from '../../ocean/artifacts-dir.js';

test( 'ocean artifact output defaults to the example artifacts directory', () => {

	assert.equal( oceanArtifactsDir( {} ), './artifacts' );

} );

test( 'ocean diagnostics may select an absolute isolated artifact directory', () => {

	const root = realpathSync( mkdtempSync( join( tmpdir(), 'tslp-inspector-smoke-' ) ) );
	const absolute = resolve( root, 'artifacts' );
	mkdirSync( absolute );
	try {

		assert.equal( oceanArtifactsDir( {
			[ OCEAN_DIAGNOSTIC_ARTIFACTS_DIR_ENV ]: absolute,
		} ), absolute );

	} finally {

		rmSync( root, { recursive: true, force: true } );

	}

} );

test( 'ocean diagnostic artifact override rejects empty and relative paths', () => {

	for ( const value of [ '', './artifacts', '../artifacts', 'artifacts' ] ) {

		assert.throws(
			() => oceanArtifactsDir( {
				[ OCEAN_DIAGNOSTIC_ARTIFACTS_DIR_ENV ]: value,
			} ),
			/isolated ocean diagnostic temporary root/,
		);

	}

} );

test( 'ocean diagnostic artifact override rejects broad and repository paths', () => {

	const repositoryRoot = resolve(
		dirname( fileURLToPath( import.meta.url ) ),
		'../../../..',
	);
	for ( const value of [ '/', tmpdir(), repositoryRoot ] ) {

		assert.throws(
			() => oceanArtifactsDir( {
				[ OCEAN_DIAGNOSTIC_ARTIFACTS_DIR_ENV ]: value,
			} ),
			/isolated ocean diagnostic temporary root/,
		);

	}

} );

test( 'ocean diagnostic artifact override rejects a symlinked artifacts directory', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-capture-replay-' ) );
	const realArtifacts = resolve( root, 'real-artifacts' );
	const linkedArtifacts = resolve( root, 'artifacts' );
	mkdirSync( realArtifacts );
	try {

		try {

			symlinkSync( realArtifacts, linkedArtifacts, 'dir' );

		} catch ( error ) {

			if ( error?.code === 'EPERM' || error?.code === 'EACCES' ) {

				t.skip( `directory symlinks unavailable: ${ error.code }` );
				return;

			}
			throw error;

		}
		assert.throws(
			() => oceanArtifactsDir( {
				[ OCEAN_DIAGNOSTIC_ARTIFACTS_DIR_ENV ]: linkedArtifacts,
			} ),
			/isolated ocean diagnostic temporary root/,
		);

	} finally {

		rmSync( root, { recursive: true, force: true } );

	}

} );
