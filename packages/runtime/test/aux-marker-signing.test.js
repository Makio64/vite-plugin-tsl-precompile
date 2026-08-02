import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import {
	createSignedAuxiliaryFamilyPayload,
	createSignedAuxiliaryPayload,
} from '../src/aux-marker.js';
import { hashArtifactContentSync } from '../src/graph-hash.js';

test( 'auxiliary POST payloads are JSON-sanitized and content-signed', () => {

	const payload = {
		materialShape: 'background',
		configHash: 'a'.repeat( 64 ),
		artifact: {
			vertexShader: 'vertex',
			fragmentShader: 'fragment',
			uniformPlan: [],
			_privateCaptureState: { shouldNotPersist: true },
		},
	};
	const provenance = {
		threeVersion: '0.185.1',
		pluginVersion: '0.1.0',
	};
	const signed = createSignedAuxiliaryPayload( payload, 'background', provenance );

	assert.equal( signed.artifact.artifactContentHashVersion, ARTIFACT_CONTENT_HASH_VERSION );
	assert.equal( signed.artifact.sourceThreeVersion, provenance.threeVersion );
	assert.equal( signed.artifact.sourceHashVersion, provenance.pluginVersion );
	assert.equal( signed.artifact._privateCaptureState, undefined );
	assert.equal( payload.artifact.artifactContentHashVersion, undefined, 'signing must not mutate the live capture' );
	assert.equal( signed.hash, hashArtifactContentSync( signed.artifact, {
		shape: 'background',
		threeVersion: provenance.threeVersion,
		pluginVersion: provenance.pluginVersion,
	} ) );

	const tampered = { ...signed.artifact, fragmentShader: 'tampered' };
	assert.notEqual( signed.hash, hashArtifactContentSync( tampered, {
		shape: 'background',
		threeVersion: provenance.threeVersion,
		pluginVersion: provenance.pluginVersion,
	} ) );

} );

test( 'internal-pass families are signed as one envelope without mutating captured members', () => {

	const payloads = [
		{
			materialShape: 'shadow-vsm-vertical',
			configHash: 'a'.repeat( 64 ),
			artifact: {
				vertexShader: 'vertical vertex',
				fragmentShader: 'vertical fragment',
				uniformPlan: [],
				_privateCaptureState: { stage: 'vertical' },
			},
		},
		{
			materialShape: 'shadow-vsm-horizontal',
			configHash: 'a'.repeat( 64 ),
			artifact: {
				vertexShader: 'horizontal vertex',
				fragmentShader: 'horizontal fragment',
				uniformPlan: [],
				_privateCaptureState: { stage: 'horizontal' },
			},
		},
	];
	const provenance = {
		threeVersion: '0.185.1',
		pluginVersion: '0.1.0',
	};
	const signed = createSignedAuxiliaryFamilyPayload( 'shadow-vsm', payloads, provenance );

	assert.equal( signed.auxiliaryFamily, 'shadow-vsm' );
	assert.equal( signed.members.length, 2 );
	for ( let index = 0; index < signed.members.length; index ++ ) {

		const member = signed.members[ index ];
		assert.equal( member.materialShape, payloads[ index ].materialShape );
		assert.equal( member.configHash, payloads[ index ].configHash );
		assert.equal( member.artifact._privateCaptureState, undefined );
		assert.equal( member.artifact.sourceThreeVersion, provenance.threeVersion );
		assert.equal( member.artifact.sourceHashVersion, provenance.pluginVersion );
		assert.equal( member.artifact.artifactContentHashVersion, ARTIFACT_CONTENT_HASH_VERSION );
		assert.equal( payloads[ index ].artifact.sourceThreeVersion, undefined );
		assert.equal( payloads[ index ].artifact._privateCaptureState.stage, index === 0 ? 'vertical' : 'horizontal' );
		assert.equal( member.hash, hashArtifactContentSync( member.artifact, {
			shape: member.materialShape,
			threeVersion: provenance.threeVersion,
			pluginVersion: provenance.pluginVersion,
		} ) );

	}

	assert.throws(
		() => createSignedAuxiliaryFamilyPayload( 'unknown', payloads, provenance ),
		/Unsupported auxiliary family/,
	);
	assert.throws(
		() => createSignedAuxiliaryFamilyPayload( 'pmrem', [], provenance ),
		/non-empty payload array/,
	);

} );
