import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { THREE_RELEASE_PROFILES, resolveSlimThreeRelease } from '../src/slim-three-policy.js';
import {
	computeThreeReleaseFingerprint,
	createSlimBundleVersionIdentity,
	formatSlimBundleStamp,
	parseSlimBundleStamp,
	readSlimThreeReleaseProfile,
} from '../src/slim-bundle-provenance-node.js';

test( 'development identity requires both renderer revision and exact source commit', () => {

	const { stable, development } = THREE_RELEASE_PROFILES;
	assert.equal( resolveSlimThreeRelease( { packageVersion: stable.packageVersion } ), stable );
	assert.equal( resolveSlimThreeRelease( { packageVersion: stable.packageVersion, revision: '187dev' } ), null );
	assert.equal( resolveSlimThreeRelease( { packageVersion: development.packageVersion } ), null );
	assert.equal( resolveSlimThreeRelease( { packageVersion: development.packageVersion, revision: development.revision } ), null );
	assert.equal( resolveSlimThreeRelease( { packageVersion: development.packageVersion, revision: development.revision, sourceCommit: 'f'.repeat( 40 ) } ), null );
	assert.equal( resolveSlimThreeRelease( { packageVersion: development.packageVersion, revision: development.revision, sourceCommit: development.gitCommit } ), development );
	assert.ok( Object.isFrozen( THREE_RELEASE_PROFILES ) && Object.isFrozen( development ) );

} );

test( 'development provenance retains its pinned identity and refuses forged stamps', () => {

	const development = THREE_RELEASE_PROFILES.development;
	const identity = {
		threeVersion: development.packageVersion, threeRevision: development.revision,
		threeCommit: development.gitCommit, policyVersion: 'test-policy', artifactToolchainVersion: 'test-artifact',
	};
	const versions = createSlimBundleVersionIdentity( identity );
	assert.deepEqual( parseSlimBundleStamp( formatSlimBundleStamp( { sourceFingerprint: 'a'.repeat( 64 ), versions } ) ).versions, versions );
	assert.throws( () => createSlimBundleVersionIdentity( { ...identity, threeCommit: 'f'.repeat( 40 ) } ), /unverified development/ );
	assert.throws( () => createSlimBundleVersionIdentity( { ...identity, threeRevision: undefined } ), /unverified development/ );
	const stable = createSlimBundleVersionIdentity( { threeVersion: THREE_RELEASE_PROFILES.stable.packageVersion, policyVersion: 'test-policy', artifactToolchainVersion: 'test-artifact' } );
	assert.equal( Object.keys( stable ).length, 4, 'ordinary and legacy stamps keep their four identity axes' );

} );

test( 'source fingerprint binds paths and bytes, survives relocation, and refuses symlinks', async ( t ) => {

	const root = await mkdtemp( join( tmpdir(), 'tslp-release-fingerprint-' ) );
	t.after( () => rm( root, { recursive: true, force: true } ) );
	for ( const candidate of [ 'first', 'second' ] ) {

		await mkdir( join( root, candidate, 'src' ), { recursive: true } );
		await mkdir( join( root, candidate, 'build' ), { recursive: true } );
		await writeFile( join( root, candidate, 'src/constants.js' ), 'source' );
		await writeFile( join( root, candidate, 'build/three.js' ), 'build' );

	}
	const baseline = await computeThreeReleaseFingerprint( join( root, 'first' ) );
	assert.deepEqual( await computeThreeReleaseFingerprint( join( root, 'second' ) ), baseline );
	await writeFile( join( root, 'second', 'src/constants.js' ), 'changed' );
	assert.notEqual( ( await computeThreeReleaseFingerprint( join( root, 'second' ) ) ).sha256, baseline.sha256 );
	await symlink( join( root, 'first/build/three.js' ), join( root, 'first/src/alias.js' ) );
	await assert.rejects( computeThreeReleaseFingerprint( join( root, 'first' ) ), /non-file/ );

} );

test( 'claiming a development revision cannot authenticate unrelated source files', async ( t ) => {

	const root = await mkdtemp( join( tmpdir(), 'tslp-release-impostor-' ) );
	t.after( () => rm( root, { recursive: true, force: true } ) );
	await mkdir( join( root, 'src' ) );
	await mkdir( join( root, 'build' ) );
	await writeFile( join( root, 'package.json' ), JSON.stringify( { name: 'three', version: THREE_RELEASE_PROFILES.development.packageVersion } ) );
	await writeFile( join( root, 'src/constants.js' ), `export const REVISION = '${ THREE_RELEASE_PROFILES.development.revision }';` );
	await writeFile( join( root, 'build/three.js' ), 'unrelated build' );
	await assert.rejects( readSlimThreeReleaseProfile( root, { sourceCommit: THREE_RELEASE_PROFILES.development.gitCommit } ), /Unsupported Three source/ );

} );
