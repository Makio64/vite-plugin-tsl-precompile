import assert from 'node:assert/strict';
import test from 'node:test';

import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import { SLIM_THREE_PACKAGE_VERSION } from '@tsl-precompile/contract/slim-three-policy';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';

import { computeArtifactContentHash } from '../../../plugin/src/hash.js';
import {
	fatalCaptureReplayBrowserErrors,
	validateCapturedMaterialRecord,
	validateLoadedCapturedMaterial,
} from '../capture-replay-gate.mjs';

const NAME = 'ocean-water';

function validRecord( mutateArtifact = null ) {

	const artifact = {
		version: 3,
		materialShape: 'node-material',
		vertexShader: '@vertex fn main() {}',
		fragmentShader: '@fragment fn main() {}',
		computeShader: '',
		attributes: [],
		bindings: [],
		uniformPlan: [],
		sourceGraphHash: 'a'.repeat( 64 ),
		sourceHashVersion: ARTIFACT_TOOLCHAIN_VERSION,
		sourceThreeVersion: SLIM_THREE_PACKAGE_VERSION,
		renderContextSignature: '{"version":"render-context@0.1.0"}',
		artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION,
	};
	if ( mutateArtifact ) mutateArtifact( artifact );
	const hash = computeArtifactContentHash( artifact, {
		shape: `material:${ NAME }`,
		threeVersion: artifact.sourceThreeVersion,
		pluginVersion: artifact.sourceHashVersion,
	} );
	return {
		file: `${ NAME }.${ hash.slice( 0, 12 ) }.json`,
		hash,
		entry: {
			__name: NAME,
			__hash: hash,
			artifact,
		},
	};

}

test( 'capture replay gate accepts an authoritative contract-valid signed artifact', () => {

	const record = validRecord();
	const result = validateLoadedCapturedMaterial( {
		authoritative: true,
		manifest: { [ NAME ]: record },
	}, NAME );

	assert.equal( result.file, record.file );
	assert.equal( result.hash, record.hash );
	assert.equal( result.validation.ok, true );

} );

test( 'capture replay gate rejects filename-only legacy scans and missing manifest entries', () => {

	assert.throws(
		() => validateLoadedCapturedMaterial( {
			authoritative: false,
			manifest: { [ NAME ]: validRecord() },
		}, NAME ),
		/authoritative manifest/,
	);
	assert.throws(
		() => validateLoadedCapturedMaterial( {
			authoritative: true,
			manifest: {},
		}, NAME ),
		/manifest is missing "ocean-water"/,
	);

} );

test( 'capture replay gate rejects an artifact that fails the shared contract', () => {

	const record = validRecord( ( artifact ) => {

		artifact.uniformPlan = {};

	} );

	assert.throws(
		() => validateCapturedMaterialRecord( record, NAME ),
		/failed the shared artifact contract: .*uniformPlan must be an array/,
	);

} );

test( 'capture replay gate rejects signed runtime-content corruption', () => {

	const record = validRecord();
	record.entry.artifact.fragmentShader += '\n// corrupt after signing';

	assert.throws(
		() => validateCapturedMaterialRecord( record, NAME ),
		/content does not match its stored __hash/,
	);

} );

test( 'capture replay gate rejects stale provenance and non-content-addressed filenames', () => {

	const stale = validRecord();
	stale.entry.artifact.sourceThreeVersion = '0.184.0';
	assert.throws(
		() => validateCapturedMaterialRecord( stale, NAME ),
		/sourceThreeVersion must be exact current baseline/,
	);

	const wrongFilename = validRecord();
	wrongFilename.file = 'ocean-water.exists-but-is-not-addressed.json';
	assert.throws(
		() => validateCapturedMaterialRecord( wrongFilename, NAME ),
		/filename must be/,
	);

} );

test( 'capture replay gate makes plugin, failed-resource, and favicon-like failures fatal', () => {

	const failures = fatalCaptureReplayBrowserErrors( [
		{
			kind: 'console',
			message: '[tsl-precompile] Failed to load resource: capture rejected',
			url: 'http://localhost/__tsl_precompile_capture',
		},
		{
			kind: 'console',
			message: 'Failed to load resource',
			url: 'http://localhost/favicon.ico',
		},
		{
			kind: 'response',
			message: '404',
			url: 'http://localhost/assets/myfavicon-bad.png',
		},
		{
			kind: 'requestfailed',
			message: 'net::ERR_FAILED',
			url: 'http://localhost/assets/required.bin',
		},
		{
			kind: 'pageerror',
			message: 'ReferenceError: render failed',
			url: '',
		},
	] );

	assert.deepEqual( failures.map( ( failure ) => failure.message ), [
		'[tsl-precompile] Failed to load resource: capture rejected',
		'Failed to load resource',
		'404',
		'net::ERR_FAILED',
		'ReferenceError: render failed',
	] );

} );
