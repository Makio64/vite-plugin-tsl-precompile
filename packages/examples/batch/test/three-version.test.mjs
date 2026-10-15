import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
	assertOfficialThreeR185Checkout,
	assertOfficialThreeR185SourceVerification,
	assertPinnedThreeCheckout,
	assertPinnedThreeSourceVerification,
	assertThreeCheckoutMatchesVersion,
	createPinnedThreeSourceVerifier,
	officialThreeReleaseForEvidence,
	THREE_CHECKOUT_VERSION_MISMATCH,
	THREE_R185_OFFICIAL_COMMIT,
	resolveE2EThreeRoot,
} from '../_three-version.mjs';
import { THREE_RELEASE_PROFILES } from '@tsl-precompile/contract/slim-three-policy';

test( 'stable evidence release selection preserves the historical identity and rejects development publication', () => {

	assert.equal( officialThreeReleaseForEvidence( '0.185.1' ).gitCommit, THREE_R185_OFFICIAL_COMMIT );
	assert.equal( officialThreeReleaseForEvidence( THREE_RELEASE_PROFILES.stable.packageVersion ), THREE_RELEASE_PROFILES.stable );
	assert.throws( () => officialThreeReleaseForEvidence( THREE_RELEASE_PROFILES.development.packageVersion ), /No official stable Three evidence profile matches/ );

} );

test( 'local diagnostics default to installed Three without needing a sibling corpus', () => {

	const root = resolveE2EThreeRoot( {
		args: [ '--local-examples-root=packages/examples/getting-started' ],
		env: {},
		selfDir: '/project/packages/examples/batch',
		resolveModule( name ) {

			assert.equal( name, 'three' );
			return '/project/node_modules/three/build/three.cjs';

		},
	} );
	assert.equal( root, '/project/node_modules/three' );

} );

test( 'upstream, tier and official evidence retain the sibling checkout default', () => {

	for ( const args of [
		[],
		[ '--local-examples-root=/scenes', '--tier=tier1' ],
		[ '--local-examples-root=/scenes', '--canonical-evidence' ],
		[ '--local-examples-root=/scenes', '--require-official-three-sources' ],
	] ) {

		assert.equal( resolveE2EThreeRoot( {
			args,
			env: {},
			selfDir: '/project/packages/examples/batch',
			resolveModule() { throw new Error( 'corpus runs must not resolve installed Three' ); },
		} ), '/three.js' );

	}

} );

test( 'explicit Three overrides retain precedence over the installed local default', () => {

	const options = {
		args: [ '--local-examples-root=/scenes' ],
		env: { TSLP_THREE_REPO: 'env-three' },
		selfDir: '/project/packages/examples/batch',
		cwd: '/work',
		resolveModule() { throw new Error( 'explicit overrides must not resolve installed Three' ); },
	};
	assert.equal( resolveE2EThreeRoot( options ), '/work/env-three' );
	assert.equal( resolveE2EThreeRoot( { ...options, args: [ ...options.args, '--three-repo=cli-three' ] } ), '/work/cli-three' );
	assert.equal( resolveE2EThreeRoot( { ...options, env: { TSLP_THREE_SOURCE_ROOT: 'development-source' } } ), '/work/development-source' );

} );

function checkoutFixture( { revision, packageVersion } ) {

	const root = mkdtempSync( join( tmpdir(), 'tslp-three-checkout-' ) );
	test.after( () => rmSync( root, { recursive: true, force: true } ) );
	mkdirSync( join( root, 'src' ) );
	writeFileSync( join( root, 'src/constants.js' ), `export const REVISION = ${ JSON.stringify( revision ) };\n` );
	writeFileSync( join( root, 'package.json' ), `${ JSON.stringify( { name: 'three', version: packageVersion }, null, 2 ) }\n` );
	return root;

}

function git( root, ...args ) {

	return execFileSync( 'git', args, { cwd: root, encoding: 'utf8' } ).trim();

}

function pinnedFixture( release ) {

	const root = checkoutFixture( release );
	git( root, 'init', '-b', 'main' );
	git( root, 'config', 'user.name', 'Three Pinned Source Test' );
	git( root, 'config', 'user.email', 'three-pinned-source@example.invalid' );
	git( root, 'add', '.' );
	git( root, 'commit', '-m', 'pinned source fixture' );
	return {
		root,
		profile: {
			...release,
			gitCommit: git( root, 'rev-parse', 'HEAD' ),
			gitTree: git( root, 'rev-parse', 'HEAD^{tree}' ),
			objectFormat: git( root, 'rev-parse', '--show-object-format' ),
		},
	};

}

test( 'pinned stable and development checkouts require exact package, revision, commit and tree', () => {

	for ( const release of Object.values( THREE_RELEASE_PROFILES ) ) {

		const { root, profile } = pinnedFixture( release );
		const checkout = assertPinnedThreeCheckout( root, profile, 'pinned fixture' );
		assert.equal( checkout.revision, release.revision );
		assert.equal( checkout.packageVersion, release.packageVersion );
		assert.equal( checkout.gitCommit, profile.gitCommit );
		assert.equal( checkout.gitTree, profile.gitTree );
		assert.equal( checkout.clean, true );
		assert.throws( () => assertPinnedThreeCheckout( root, { ...profile, gitCommit: '0'.repeat( 40 ) } ), /expected official/ );
		assert.throws( () => assertPinnedThreeCheckout( root, { ...profile, gitTree: '0'.repeat( 40 ) } ), /expected official/ );
		assert.throws( () => assertPinnedThreeCheckout( root, { ...profile, revision: '188dev' } ), /expected pinned/ );
		assert.throws( () => assertPinnedThreeCheckout( root, { ...profile, packageVersion: '0.188.0' } ), /expected pinned/ );
		if ( release.channel === 'development' ) {

			assert.throws( () => assertThreeCheckoutMatchesVersion( root, release.packageVersion ), /Development REVISION suffixes are intentionally rejected/ );

		}
		writeFileSync( join( root, 'untracked.js' ), 'export const injected = true;\n' );
		assert.throws( () => assertPinnedThreeCheckout( root, profile ), /local or untracked changes/ );

	}

} );

test( 'pinned source proofs bind every served blob while legacy r185 identity remains separate', () => {

	for ( const release of Object.values( THREE_RELEASE_PROFILES ) ) {

		const { root, profile } = pinnedFixture( release );
		const verifier = createPinnedThreeSourceVerifier( root, profile, 'pinned proof fixture' );
		const constants = join( root, 'src/constants.js' );
		verifier.verify( constants, readFileSync( constants ) );
		const proof = verifier.snapshot();
		assert.equal( assertPinnedThreeSourceVerification( proof, { profile } ), proof );
		assert.throws( () => assertPinnedThreeSourceVerification( proof, { profile: { ...profile, gitTree: '0'.repeat( 40 ) } } ), /aggregate verification record is invalid/ );
		assert.throws( () => assertOfficialThreeR185SourceVerification( proof ), /official Three r185 Git tree/ );
		assert.throws( () => createPinnedThreeSourceVerifier( root, { ...profile, gitTree: '0'.repeat( 40 ) } ), /unexpected tree/ );
		const altered = structuredClone( proof );
		altered.files[ 0 ].gitCommit = '0'.repeat( 40 );
		assert.throws( () => assertPinnedThreeSourceVerification( altered, { profile } ), /source record.*invalid/ );

	}

} );

function withProcessEnvironment( overrides, fn ) {

	const previous = new Map(
		Object.keys( overrides ).map( ( key ) => [ key, process.env[ key ] ] ),
	);
	Object.assign( process.env, overrides );
	try {

		return fn();

	} finally {

		for ( const [ key, value ] of previous ) {

			if ( value === undefined ) delete process.env[ key ];
			else process.env[ key ] = value;

		}

	}

}

test( 'exact checkout gate accepts r185 source and package 0.185.1', () => {

	const root = checkoutFixture( { revision: '185', packageVersion: '0.185.1' } );
	const result = assertThreeCheckoutMatchesVersion( root, '0.185.1', 'test-exact-three' );
	assert.equal( result.revision, '185' );
	assert.equal( result.revisionNumber, 185 );
	assert.equal( result.packageVersion, '0.185.1' );

} );

test( 'canonical evidence gate rejects a version-correct non-official checkout', () => {

	const root = checkoutFixture( { revision: '185', packageVersion: '0.185.1' } );
	assert.throws(
		() => assertOfficialThreeR185Checkout( root, 'test-official-three' ),
		/canonical evidence requires a Git checkout of the official r185 tag/,
	);

} );

test( 'canonical evidence gate cannot be redirected to an official-looking shadow repository', () => {

	const root = checkoutFixture( { revision: '185', packageVersion: '0.185.1' } );
	const shadow = checkoutFixture( { revision: '185', packageVersion: '0.185.1' } );
	git( shadow, 'init', '-b', 'main' );
	git( shadow, 'config', 'user.name', 'Three Shadow Test' );
	git( shadow, 'config', 'user.email', 'three-shadow@example.invalid' );
	git( shadow, 'add', '.' );
	git( shadow, 'commit', '-m', 'shadow checkout' );
	const replacementCommit = git( shadow, 'rev-parse', 'HEAD' );
	const replacementDirectory = join( shadow, '.git/refs/replace' );
	mkdirSync( replacementDirectory, { recursive: true } );
	writeFileSync(
		join( replacementDirectory, THREE_R185_OFFICIAL_COMMIT ),
		`${ replacementCommit }\n`,
	);
	writeFileSync(
		join( shadow, '.git/refs/heads/main' ),
		`${ THREE_R185_OFFICIAL_COMMIT }\n`,
	);

	const hostileEnvironment = {
		GIT_DIR: join( shadow, '.git' ),
		GIT_WORK_TREE: shadow,
	};
	const inheritedOptions = {
		encoding: 'utf8',
		env: { ...process.env, ...hostileEnvironment },
	};
	assert.equal(
		execFileSync( 'git', [ '-C', root, 'rev-parse', 'HEAD' ], inheritedOptions ).trim(),
		THREE_R185_OFFICIAL_COMMIT,
		'fixture must make the inherited shadow report the official commit',
	);
	assert.equal(
		execFileSync(
			'git',
			[ '-C', root, 'status', '--porcelain=v1', '--untracked-files=all' ],
			inheritedOptions,
		).trim(),
		'',
		'fixture must make the inherited shadow report a clean checkout',
	);

	withProcessEnvironment( hostileEnvironment, () => {

		assert.throws(
			() => assertOfficialThreeR185Checkout( root, 'test-official-three-shadow' ),
			/canonical evidence requires a Git checkout of the official r185 tag/,
		);

	} );

} );

test( 'exact checkout gate rejects r186dev source and package 0.186.0', () => {

	const root = checkoutFixture( { revision: '186dev', packageVersion: '0.186.0' } );
	assert.throws(
		() => assertThreeCheckoutMatchesVersion( root, '0.185.1', 'test-exact-three' ),
		( error ) => {

			assert.equal( error.code, THREE_CHECKOUT_VERSION_MISMATCH );
			assert.match( error.message, /REVISION="186dev", expected "185"/ );
			assert.match( error.message, /version "0\.186\.0", expected "0\.185\.1"/ );
			assert.match( error.message, /--three-repo=<path>/ );
			assert.match( error.message, /signed stable release matches/ );
			assert.match( error.message, /Development REVISION suffixes are intentionally rejected/ );
			return true;

		},
	);

} );

test( 'exact checkout gate rejects mismatched package metadata even at the expected revision', () => {

	const root = checkoutFixture( { revision: '185', packageVersion: '0.184.0' } );
	assert.throws(
		() => assertThreeCheckoutMatchesVersion( root, '0.185.1', 'test-exact-three' ),
		( error ) => {

			assert.equal( error.code, THREE_CHECKOUT_VERSION_MISMATCH );
			assert.doesNotMatch( error.message, /src\/constants\.js reports/ );
			assert.match( error.message, /version "0\.184\.0", expected "0\.185\.1"/ );
			return true;

		},
	);

} );

test( 'exact checkout gate rejects an invalid signed bundle version', () => {

	const root = checkoutFixture( { revision: '185', packageVersion: '0.185.1' } );
	assert.throws(
		() => assertThreeCheckoutMatchesVersion( root, '185dev', 'test-exact-three' ),
		( error ) => {

			assert.equal( error.code, THREE_CHECKOUT_VERSION_MISMATCH );
			assert.match( error.message, /signed slim bundle reports invalid three\.js package version/ );
			return true;

		},
	);

} );

test( 'checkout reader ignores comments and similarly named constants', () => {

	const root = checkoutFixture( { revision: '185', packageVersion: '0.185.1' } );
	writeFileSync(
		join( root, 'src/constants.js' ),
		`// export const REVISION = '999';\nexport const SOME_REVISION = '998';\nexport const REVISION = '185';\n`,
	);
	const result = assertThreeCheckoutMatchesVersion( root, '0.185.1', 'test-exact-three' );
	assert.equal( result.revision, '185' );

} );

test( 'exact checkout gate rejects a development revision hidden by matching package metadata', () => {

	const root = checkoutFixture( { revision: '185dev', packageVersion: '0.185.1' } );
	assert.throws(
		() => assertThreeCheckoutMatchesVersion( root, '0.185.1', 'test-exact-three' ),
		( error ) => {

			assert.equal( error.code, THREE_CHECKOUT_VERSION_MISMATCH );
			assert.match( error.message, /REVISION="185dev", expected "185"/ );
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

test( 'raw batch pages expose the signed exact Three package version before application modules run', () => {

	const e2eSource = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );
	const injectStart = e2eSource.indexOf( 'function injectHtml( html, example, mode )' );
	const injectEnd = e2eSource.indexOf( '\nfunction rewriteImportmap(', injectStart );
	assert.ok( injectStart >= 0 && injectEnd > injectStart, 'expected the raw HTML injection boundary' );

	const injectSource = e2eSource.slice( injectStart, injectEnd );
	assert.match(
		injectSource,
		/globalThis\.__TSLP_THREE_PACKAGE_VERSION__=\$\{ jsonScriptLiteral\( SLIM_HASH_OPTS\.threeVersion \) \};window\.__TSLP_E2E=/,
	);
	assert.ok(
		injectSource.indexOf( 'globalThis.__TSLP_THREE_PACKAGE_VERSION__=' )
			< injectSource.indexOf( 'window.__TSLP_E2E=' ),
		'version provenance must be available before the page boot payload and module scripts',
	);
	assert.doesNotMatch(
		injectSource,
		/__TSLP_THREE_PACKAGE_VERSION__=\$\{[^}]*REVISION/,
		'the package version must come from signed slim-bundle provenance, not Three.REVISION',
	);

} );
