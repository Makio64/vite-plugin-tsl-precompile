import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { formatSlimBundleStamp } from '@tsl-precompile/contract/slim-bundle-provenance-node';
import { loadSlimBundle, slimBundleHashOptions, slimBundleReportProvenance } from '../slim-bundle-provenance.mjs';

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

test( 'hash options come from the authoritative minification-safe bundle stamp', () => {

	const root = fixture();
	const stamp = formatSlimBundleStamp( {
		sourceFingerprint: 'a'.repeat( 64 ),
		versions: {
			three: '0.184.0',
			policy: 'slim-three-policy@7',
			artifactToolchain: '0.1.0',
			buildToolchain: 'tslp-slim-rollup@1',
		},
	} );
	writeFileSync( join( root, 'stamped.js' ), `${ stamp }\nconst a={};` );
	const bundle = loadSlimBundle( { defaultPath: 'stamped.js', env: {}, cwd: root } );
	assert.deepEqual( slimBundleHashOptions( bundle ), {
		threeVersion: '0.184.0',
		pluginVersion: '0.1.0',
	} );
	assert.throws(
		() => slimBundleHashOptions( { bytes: Buffer.from( 'const threeVersion = "0.184.0";' ) } ),
		/does not begin with its required embedded provenance stamp/,
	);

} );

test( 'replay imports and forwarded exports share one cache-busted slim module identity', () => {

	const source = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );
	assert.match( source, /const SLIM_BUNDLE_BROWSER_MODULE = `\/__tslp__\/three\.webgpu\.slim\.js\?v=\$\{ CACHE_BUST \}`/ );
	assert.match( source, /export \{ \$\{ SLIM_REPLAY_FORWARD_EXPORTS\.join\( ', ' \) \} \} from \$\{ JSON\.stringify\( SLIM_BUNDLE_BROWSER_MODULE \) \}/ );
	assert.match( source, /import \* as Slim from \$\{ JSON\.stringify\( SLIM_BUNDLE_BROWSER_MODULE \) \}/ );
	assert.doesNotMatch( source, /from '\/__tslp__\/three\.webgpu\.slim\.js';/ );

} );
