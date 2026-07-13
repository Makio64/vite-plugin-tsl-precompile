import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { rollup } from 'rollup';

import {
	SLIM_BUNDLE_FILE_NAME,
	SLIM_BUNDLE_METADATA_FILE_NAME,
	SLIM_BUNDLE_PROVENANCE_ERROR_CODES,
	computeSlimBundleSourceFingerprint,
	createSlimBundleMetadata,
	createSlimBundleSourceInputs,
	createSlimBundleVersionIdentity,
	formatSlimBundleStamp,
	parseSlimBundleMetadata,
	verifySlimBundleProvenance,
} from '@tsl-precompile/contract/slim-bundle-provenance-node';
import {
	SLIM_BUNDLE_SOURCE_INPUTS,
	SLIM_BUNDLE_VERSIONS,
	createSlimBundleProvenancePlugin,
} from '../rollup.config.js';

const VERSIONS = createSlimBundleVersionIdentity( {
	threeVersion: '0.184.0',
	policyVersion: 'slim-three-policy@8',
	artifactToolchainVersion: '0.1.0',
} );

test( 'slim source fingerprint is path-independent, order-independent, and byte-sensitive', async () => {

	const firstRoot = await mkdtemp( join( tmpdir(), 'tslp-provenance-a-' ) );
	const secondRoot = await mkdtemp( join( tmpdir(), 'tslp-provenance-b-' ) );
	try {

		const firstInputs = await writeSourceFixture( firstRoot );
		const secondInputs = await writeSourceFixture( secondRoot );
		secondInputs.rollupRecipeFiles.reverse();

		const first = await computeSlimBundleSourceFingerprint( firstInputs, VERSIONS );
		const second = await computeSlimBundleSourceFingerprint( secondInputs, VERSIONS );
		assert.deepEqual( second, first );
		assert.equal( JSON.stringify( first ).includes( firstRoot ), false );
		assert.equal( JSON.stringify( first ).includes( secondRoot ), false );

		// Package managers intentionally rewrite workspace protocols, scripts,
		// property order, and formatting while packing. Those manifest bytes are
		// not build inputs and must not make a published install look stale.
		await writeFile( join( secondRoot, 'runtime/package.json' ), '{"name":"@tsl-precompile/runtime","dependencies":{"@tsl-precompile/contract":"0.1.0"}}' );
		assert.equal(
			( await computeSlimBundleSourceFingerprint( secondInputs, VERSIONS ) ).fingerprint,
			first.fingerprint,
		);

		await writeFile( join( secondRoot, 'runtime/rollup.config.js' ), 'export default { changed: true };\n' );
		const changedRecipe = await computeSlimBundleSourceFingerprint( secondInputs, VERSIONS );
		assert.notEqual( changedRecipe.fingerprint, first.fingerprint );
		assert.notEqual(
			changedRecipe.groups.find( ( group ) => group.name === 'rollup/recipe' ).sha256,
			first.groups.find( ( group ) => group.name === 'rollup/recipe' ).sha256,
		);
		await writeFile( join( secondRoot, 'runtime/rollup.config.js' ), 'export default {};\n' );
		await writeFile( join( secondRoot, 'runtime/build-tools/slim-bundle-analysis.js' ), 'export const analysis = 2;\n' );
		const changedGuard = await computeSlimBundleSourceFingerprint( secondInputs, VERSIONS );
		assert.notEqual( changedGuard.fingerprint, first.fingerprint );
		await writeFile( join( secondRoot, 'runtime/build-tools/slim-bundle-analysis.js' ), 'export const analysis = 1;\n' );

		await writeFile( join( secondRoot, 'runtime/src/runtime.js' ), 'export const runtime = 2;\n' );
		const changed = await computeSlimBundleSourceFingerprint( secondInputs, VERSIONS );
		assert.notEqual( changed.fingerprint, first.fingerprint );
		assert.notEqual(
			changed.groups.find( ( group ) => group.name === 'runtime/src' ).sha256,
			first.groups.find( ( group ) => group.name === 'runtime/src' ).sha256,
		);

	} finally {

		await Promise.all( [
			rm( firstRoot, { recursive: true, force: true } ),
			rm( secondRoot, { recursive: true, force: true } ),
		] );

	}

} );

test( 'slim bundle verifier distinguishes missing stamps, tampering, staleness, and version drift', async () => {

	const root = await mkdtemp( join( tmpdir(), 'tslp-provenance-verify-' ) );
	try {

		const inputs = await writeSourceFixture( root );
		const source = await computeSlimBundleSourceFingerprint( inputs, VERSIONS );
		const stamp = formatSlimBundleStamp( { sourceFingerprint: source.fingerprint, versions: VERSIONS } );
		const bundleSource = `${ stamp }\nexport const slim = true;\n`;
		const metadata = createSlimBundleMetadata( { bundleSource, source, versions: VERSIONS } );

		assert.equal(
			verifySlimBundleProvenance( {
				bundleSource,
				metadata,
				expectedSource: source,
				expectedVersions: VERSIONS,
			} ).metadata.bundle.sha256,
			metadata.bundle.sha256,
		);
		assert.throws( () => verifySlimBundleProvenance( {
			bundleSource: 'export const slim = true;\n',
			metadata,
			expectedSource: source,
			expectedVersions: VERSIONS,
		} ), ( error ) => error.code === SLIM_BUNDLE_PROVENANCE_ERROR_CODES.STAMP_MISSING );
		assert.throws( () => verifySlimBundleProvenance( {
			bundleSource: `${ bundleSource }// modified\n`,
			metadata,
			expectedSource: source,
			expectedVersions: VERSIONS,
		} ), ( error ) => error.code === SLIM_BUNDLE_PROVENANCE_ERROR_CODES.INTEGRITY_MISMATCH );
		assert.throws( () => verifySlimBundleProvenance( {
			bundleSource,
			metadata,
			expectedSource: { ...source, fingerprint: 'f'.repeat( 64 ) },
			expectedVersions: VERSIONS,
		} ), ( error ) => error.code === SLIM_BUNDLE_PROVENANCE_ERROR_CODES.SOURCE_STALE );
		assert.throws( () => verifySlimBundleProvenance( {
			bundleSource,
			metadata,
			expectedSource: source,
			expectedVersions: { ...VERSIONS, policy: 'slim-three-policy@future' },
		} ), ( error ) => error.code === SLIM_BUNDLE_PROVENANCE_ERROR_CODES.VERSION_MISMATCH );

	} finally {

		await rm( root, { recursive: true, force: true } );

	}

} );

test( 'in-memory Rollup emits a post-transform stamp and final-bundle SHA sidecar', async () => {

	const root = await mkdtemp( join( tmpdir(), 'tslp-provenance-rollup-' ) );
	let build = null;
	try {

		const inputs = await writeSourceFixture( root );
		const source = await computeSlimBundleSourceFingerprint( inputs, VERSIONS );
		build = await rollup( {
			input: 'virtual:entry',
			plugins: [
				{
					name: 'fixture-entry',
					resolveId( id ) { return id === 'virtual:entry' ? '\0virtual:entry' : null; },
					load( id ) { return id === '\0virtual:entry' ? 'export const answer = 42;\n' : null; },
				},
				createSlimBundleProvenancePlugin( { source, versions: VERSIONS } ),
			],
		} );
		const generated = await build.generate( {
			format: 'esm',
			file: join( root, SLIM_BUNDLE_FILE_NAME ),
		} );
		const chunk = generated.output.find( ( output ) => output.type === 'chunk' );
		const sidecar = generated.output.find( ( output ) => output.type === 'asset' && output.fileName === SLIM_BUNDLE_METADATA_FILE_NAME );

		assert.ok( chunk.code.startsWith( '/*!@tsl-precompile/slim-bundle:' ) );
		assert.ok( sidecar, 'expected the adjacent provenance sidecar asset' );
		const metadata = parseSlimBundleMetadata( sidecar.source );
		assert.equal( metadata.bundle.bytes, Buffer.byteLength( chunk.code ) );
		verifySlimBundleProvenance( {
			bundleSource: chunk.code,
			metadata,
			expectedSource: source,
			expectedVersions: VERSIONS,
		} );

	} finally {

		if ( build ) await build.close();
		await rm( root, { recursive: true, force: true } );

	}

} );

test( 'checked slim bundle and sidecar match the current source inputs', async () => {

	const buildDirectory = process.env.TSLP_TEST_CHECKED_SLIM_DIR || new URL( '../build/', import.meta.url );
	const [ bundleSource, metadata, expectedSource ] = await Promise.all( [
		readFile( typeof buildDirectory === 'string' ? join( buildDirectory, SLIM_BUNDLE_FILE_NAME ) : new URL( SLIM_BUNDLE_FILE_NAME, buildDirectory ) ),
		readFile( typeof buildDirectory === 'string' ? join( buildDirectory, SLIM_BUNDLE_METADATA_FILE_NAME ) : new URL( SLIM_BUNDLE_METADATA_FILE_NAME, buildDirectory ) ),
		computeSlimBundleSourceFingerprint( SLIM_BUNDLE_SOURCE_INPUTS, SLIM_BUNDLE_VERSIONS ),
	] );
	const verified = verifySlimBundleProvenance( {
		bundleSource,
		metadata,
		expectedSource,
		expectedVersions: SLIM_BUNDLE_VERSIONS,
	} );
	assert.equal( verified.metadata.bundle.file, SLIM_BUNDLE_FILE_NAME );
	assert.equal( verified.metadata.source.fingerprint, expectedSource.fingerprint );

} );

async function writeSourceFixture( root ) {

	const threeRoot = join( root, 'three' );
	const runtimeRoot = join( root, 'runtime' );
	const contractRoot = join( root, 'contract' );
	const pluginRoot = join( root, 'plugin' );
	for ( const directory of [
		join( threeRoot, 'src/math' ),
		join( runtimeRoot, 'src' ),
		join( runtimeRoot, 'build-tools' ),
		join( contractRoot, 'src' ),
		join( pluginRoot, 'src/vendor' ),
	] ) await mkdir( directory, { recursive: true } );

	await Promise.all( [
		writeFile( join( threeRoot, 'src/constants.js' ), 'export const REVISION = 184;\n' ),
		writeFile( join( threeRoot, 'src/math/vector.js' ), 'export const vector = [ 1, 2, 3 ];\n' ),
		writeFile( join( runtimeRoot, 'src/runtime.js' ), 'export const runtime = 1;\n' ),
		writeFile( join( contractRoot, 'src/contract.js' ), 'export const contract = 1;\n' ),
		writeFile( join( pluginRoot, 'src/three-rewrite.js' ), 'export const rewrite = 1;\n' ),
		writeFile( join( pluginRoot, 'src/vendor/vendor.js' ), 'export const vendor = 1;\n' ),
		writeFile( join( runtimeRoot, 'rollup.config.js' ), 'export default {};\n' ),
		writeFile( join( runtimeRoot, 'build-tools/slim-bundle-analysis.js' ), 'export const analysis = 1;\n' ),
		writeFile( join( runtimeRoot, 'package.json' ), '{"name":"@tsl-precompile/runtime"}\n' ),
		writeFile( join( contractRoot, 'package.json' ), '{"name":"@tsl-precompile/contract"}\n' ),
		writeFile( join( pluginRoot, 'package.json' ), '{"name":"vite-plugin-tsl-precompile"}\n' ),
	] );

	return createSlimBundleSourceInputs( {
		threePackageRoot: threeRoot,
		runtimePackageRoot: runtimeRoot,
		contractPackageRoot: contractRoot,
		pluginPackageRoot: pluginRoot,
	} );

}
