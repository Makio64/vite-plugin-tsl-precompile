import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import { assertArtifactContentIntegrity } from '../../src/artifact-content-integrity.js';
import { computeArtifactContentHash } from '../../src/hash.js';

test( 'shared content-integrity gate rejects a tampered auxiliary artifact', () => {

	const artifact = {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		uniformPlan: [],
		sourceThreeVersion: '0.185.1',
		sourceHashVersion: '0.1.0',
		artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION,
	};
	const opts = {
		label: '[tsl-precompile] auxiliary artifact "background:config"',
		shape: 'background',
		threeVersion: artifact.sourceThreeVersion,
		pluginVersion: artifact.sourceHashVersion,
		required: true,
	};
	const hash = computeArtifactContentHash( artifact, opts );
	assert.equal( assertArtifactContentIntegrity( artifact, hash, opts ), true );

	artifact.fragmentShader = 'tampered';
	assert.throws(
		() => assertArtifactContentIntegrity( artifact, hash, opts ),
		/content does not match its stored __hash/,
	);

} );

test( 'shared content-integrity gate allows only explicitly optional legacy signatures', () => {

	const legacy = { vertexShader: '', fragmentShader: '', uniformPlan: [] };
	const opts = {
		label: '[tsl-precompile] artifact "legacy"',
		shape: 'material:legacy',
		threeVersion: '0.185.1',
		pluginVersion: '0.1.0',
	};
	assert.equal( assertArtifactContentIntegrity( legacy, 'legacy-hash', { ...opts, required: false } ), false );
	assert.throws(
		() => assertArtifactContentIntegrity( legacy, 'legacy-hash', { ...opts, required: true } ),
		/unsupported content-hash version <missing>/,
	);

} );
