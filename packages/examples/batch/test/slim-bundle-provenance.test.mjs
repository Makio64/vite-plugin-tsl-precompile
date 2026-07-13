import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadSlimBundle, slimBundleReportProvenance } from '../slim-bundle-provenance.mjs';

function fixture() {

	const root = mkdtempSync( join( tmpdir(), 'tslp-slim-bundle-' ) );
	test.after( () => rmSync( root, { recursive: true, force: true } ) );
	return root;

}

test( 'CLI bundle paths override environment and default paths', () => {

	const root = fixture();
	writeFileSync( join( root, 'default.js' ), 'default' );
	writeFileSync( join( root, 'environment.js' ), 'environment' );
	writeFileSync( join( root, 'cli.js' ), 'abc' );

	const bundle = loadSlimBundle( {
		defaultPath: 'default.js',
		args: [ '--slim-bundle=cli.js' ],
		env: { TSLP_E2E_SLIM_BUNDLE: 'environment.js' },
		cwd: root,
	} );
	assert.equal( bundle.absolutePath, join( root, 'cli.js' ) );
	assert.equal( bundle.bytes.toString( 'utf8' ), 'abc' );
	assert.equal( bundle.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' );
	assert.equal( bundle.shortSha256, 'ba7816bf8f01' );
	assert.deepEqual( slimBundleReportProvenance( bundle ), {
		absolutePath: join( root, 'cli.js' ),
		sha256: bundle.sha256,
	} );

} );

test( 'environment and default bundle paths resolve relative to the working directory', () => {

	const root = fixture();
	writeFileSync( join( root, 'default.js' ), 'default' );
	mkdirSync( join( root, 'tmp' ) );
	writeFileSync( join( root, 'tmp/environment.js' ), 'environment' );
	writeFileSync( join( root, 'tmp/general.js' ), 'general' );

	const fromEnvironment = loadSlimBundle( {
		defaultPath: 'default.js',
		env: {
			TSLP_E2E_SLIM_BUNDLE: 'tmp/environment.js',
			TSLP_SLIM_BUNDLE: 'tmp/general.js',
		},
		envKeys: [ 'TSLP_E2E_SLIM_BUNDLE', 'TSLP_SLIM_BUNDLE' ],
		cwd: root,
	} );
	assert.equal( fromEnvironment.absolutePath, join( root, 'tmp/environment.js' ) );

	const fromGeneralAlias = loadSlimBundle( {
		defaultPath: 'default.js',
		env: { TSLP_SLIM_BUNDLE: 'tmp/general.js' },
		cwd: root,
	} );
	assert.equal( fromGeneralAlias.absolutePath, join( root, 'tmp/general.js' ) );

	const fromDefault = loadSlimBundle( { defaultPath: 'default.js', env: {}, cwd: root } );
	assert.equal( fromDefault.absolutePath, join( root, 'default.js' ) );

} );

test( 'bundle validation rejects missing paths and directories at startup', () => {

	const root = fixture();
	assert.throws(
		() => loadSlimBundle( { defaultPath: 'missing.js', env: {}, cwd: root } ),
		/Slim bundle not found: .*missing\.js/,
	);
	assert.throws(
		() => loadSlimBundle( { defaultPath: '.', env: {}, cwd: root } ),
		/Slim bundle path is not a file:/,
	);

} );
