import assert from 'node:assert/strict';
import test from 'node:test';

import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import {
	createVSMSupportConfig,
	vsmMomentsTopology,
	vsmSourceInputTopology,
} from '@tsl-precompile/contract/vsm-config';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { SLIM_THREE_PACKAGE_VERSION } from '@tsl-precompile/contract/slim-three-policy';
import {
	validateAuxiliaryFamilyPayload,
} from '../../src/dev-capture-server.js';
import {
	computeArtifactContentHash,
	computePlainConfigHash,
} from '../../src/hash.js';

const PROVENANCE = Object.freeze( {
	threeVersion: SLIM_THREE_PACKAGE_VERSION,
	pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
} );

function vsmArtifact( stage, config ) {

	const vertical = stage === 'vertical';
	const shape = `shadow-vsm-${ stage }`;
	const inputRole = vertical ? 'shadow-depth' : 'vsm-vertical';
	const inputBinding = vertical ? 'nodeUniform1' : 'nodeUniform2';
	return {
		version: 3,
		materialShape: shape,
		vertexShader: `vertex:${ stage }`,
		fragmentShader: `fragment:${ stage }`,
		bindings: [],
		uniformPlan: [
			{
				name: 'render',
				slots: [
					{ name: 'nodeUniform0', source: { kind: 'light.shadowBlurSamples' } },
					{ name: 'nodeUniform3', source: { kind: 'light.shadowRadius' } },
					{ name: 'nodeUniform4', source: { kind: 'light.shadowMapSize' } },
				],
				textures: [],
			},
			{
				name: 'object',
				slots: [],
				textures: [ {
					name: inputBinding,
					bindingKind: 'sampled-texture',
					textureType: '2d',
					source: {
						kind: vertical ? 'depth.texture' : 'artifact.texture',
						textureUuid: `captured-${ inputRole }`,
					},
				} ],
			},
		],
		internalPass: {
			schema: 'internal-pass@1',
			family: 'shadow-vsm',
			stage,
			shape,
			config,
			uniforms: [
				{ role: 'blur-samples', group: 'render', binding: 'nodeUniform0', valueType: 'float' },
				{ role: 'radius', group: 'render', binding: 'nodeUniform3', valueType: 'float' },
				{ role: 'map-size', group: 'render', binding: 'nodeUniform4', valueType: 'vec2' },
			],
			inputs: [ {
				role: inputRole,
				kind: 'texture',
				group: 'object',
				binding: inputBinding,
				topology: vertical
					? vsmSourceInputTopology( config )
					: vsmMomentsTopology( config ),
			} ],
			output: {
				topology: vsmMomentsTopology( config ),
			},
		},
	};

}

function shadowDepthArtifact() {

	return {
		version: 3,
		materialShape: 'shadow-depth',
		vertexShader: 'vertex:shadow-depth',
		fragmentShader: 'fragment:shadow-depth',
		bindings: [],
		uniformPlan: [],
	};

}

function signedMember( materialShape, configHash, sourceArtifact ) {

	const artifact = {
		...sourceArtifact,
		artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION,
		sourceThreeVersion: PROVENANCE.threeVersion,
		sourceHashVersion: PROVENANCE.pluginVersion,
	};
	return {
		materialShape,
		configHash,
		hash: computeArtifactContentHash( artifact, {
			shape: materialShape,
			threeVersion: PROVENANCE.threeVersion,
			pluginVersion: PROVENANCE.pluginVersion,
		} ),
		...PROVENANCE,
		artifact,
	};

}

function validFamilyPayload() {

	const config = createVSMSupportConfig();
	const configHash = computePlainConfigHash( config, {
		shape: 'shadow-vsm',
		...PROVENANCE,
	} );
	return {
		auxiliaryFamily: 'shadow-vsm',
		members: [
			signedMember( 'shadow-depth', 'd'.repeat( 64 ), shadowDepthArtifact() ),
			signedMember( 'shadow-vsm-vertical', configHash, vsmArtifact( 'vertical', config ) ),
			signedMember( 'shadow-vsm-horizontal', configHash, vsmArtifact( 'horizontal', config ) ),
		],
	};

}

test( 'dev capture accepts one complete canonically keyed VSM family', () => {

	assert.doesNotThrow( () => validateAuxiliaryFamilyPayload( validFamilyPayload() ) );

} );

test( 'dev capture rejects unloadable or incomplete VSM family envelopes', () => {

	const splitConfigHash = validFamilyPayload();
	splitConfigHash.members[ 2 ].configHash = 'b'.repeat( 64 );
	assert.throws(
		() => validateAuxiliaryFamilyPayload( splitConfigHash ),
		/internal-pass members must share one configHash/,
	);

	const forgedConfigHash = validFamilyPayload();
	forgedConfigHash.members[ 1 ].configHash = 'c'.repeat( 64 );
	forgedConfigHash.members[ 2 ].configHash = 'c'.repeat( 64 );
	assert.throws(
		() => validateAuxiliaryFamilyPayload( forgedConfigHash ),
		/configHash does not match its canonical internal-pass config/,
	);

	const missingDepth = validFamilyPayload();
	missingDepth.members.shift();
	assert.throws(
		() => validateAuxiliaryFamilyPayload( missingDepth ),
		/missing required support: shadow-depth/,
	);

	const duplicateStage = validFamilyPayload();
	duplicateStage.members.push( {
		...duplicateStage.members[ 1 ],
		configHash: 'e'.repeat( 64 ),
	} );
	assert.throws(
		() => validateAuxiliaryFamilyPayload( duplicateStage ),
		/duplicate shape "shadow-vsm-vertical"/,
	);

} );
