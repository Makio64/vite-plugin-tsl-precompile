import test from 'node:test';
import assert from 'node:assert/strict';

import { hydrateNodeBuilderState } from '../src/hydrator.js';
import {
	classifyPmremObjectUniformSlots,
	objectUboDiagnosticsEnabled,
} from '../src/hydrate/object-ubo-diagnostics.js';

const IDENTITY_MATRIX = [
	1, 0, 0, 0,
	0, 1, 0, 0,
	0, 0, 1, 0,
	0, 0, 0, 1,
];

function makeIblArtifact() {

	const slots = [
		{
			name: 'nodeUniform14',
			offset: 84,
			size: 4,
			dtype: 'number',
			source: { kind: 'uniform.live', liveNodeId: 1, valueSnapshot: { type: 'number', data: 9 } },
		},
		{
			name: 'nodeUniform15',
			offset: 96,
			size: 64,
			dtype: 'mat4',
			source: { kind: 'uniform.live', liveNodeId: 2, valueSnapshot: { type: 'mat4', data: IDENTITY_MATRIX } },
		},
		{
			name: 'nodeUniform19',
			offset: 160,
			size: 4,
			dtype: 'number',
			source: { kind: 'uniform.live', liveNodeId: 3, valueSnapshot: { type: 'number', data: 1 / 1536 } },
		},
		{
			name: 'nodeUniform20',
			offset: 164,
			size: 4,
			dtype: 'number',
			source: { kind: 'uniform.live', liveNodeId: 4, valueSnapshot: { type: 'number', data: 1 / 2048 } },
		},
		{
			name: 'nodeUniform22',
			offset: 168,
			size: 4,
			dtype: 'number',
			source: { kind: 'uniform.live', liveNodeId: 5, valueSnapshot: { type: 'number', data: 1 } },
		},
	];
	return {
		name: 'ibl-resolve',
		materialShape: 'mesh-standard',
		vertexShader: '',
		fragmentShader: `
			mip = clamp( roughnessToMip( roughness ), -2.0, object.nodeUniform14 );
			uv.y = uv.y + 4.0 * ( exp2( object.nodeUniform14 ) - faceSize );
			face = getFace( ( object.nodeUniform15 * vec4<f32>( direction, 1.0 ) ).xyz );
			uv.x = ( uv.x * object.nodeUniform19 );
			uv.y = ( uv.y * object.nodeUniform20 );
			radiance = sampleColor * vec3<f32>( object.nodeUniform22 );
		`,
		bindings: [ {
			name: 'object',
			bindings: [ {
				name: 'object',
				kind: 'uniform-buffer',
				byteLength: 176,
				visibility: 2,
			} ],
		} ],
		uniformPlan: [ {
			name: 'object',
			shared: false,
			byteLength: 176,
			slots,
		} ],
	};

}

function objectBinding( bindGroups ) {

	const group = bindGroups.find( candidate => candidate && candidate.name === 'object' );
	return {
		group,
		binding: group && group.bindings.find( candidate => candidate && candidate.isUniformBuffer === true ),
	};

}

function closeTo( actual, expected ) {

	assert.ok( Math.abs( actual - expected ) < 1e-9, `${ actual } should be close to ${ expected }` );

}

test( 'object UBO diagnostic flag accepts the environment spelling', () => {

	assert.equal( objectUboDiagnosticsEnabled( { process: { env: { TSLP_DEBUG_OBJECT_UBO: '1' } } } ), true );
	assert.equal( objectUboDiagnosticsEnabled( { process: { env: { TSLP_DEBUG_OBJECT_UBO: '0' } } } ), false );

} );

test( 'MeshStandard object UBO diagnostics record update and exact upload payloads', () => {

	const previousFlag = globalThis.__TSLP_DEBUG_OBJECT_UBO;
	const previousDiagnostics = globalThis.__tslpHarnessDiagnostics;
	globalThis.__TSLP_DEBUG_OBJECT_UBO = true;
	globalThis.__tslpHarnessDiagnostics = {};
	try {

		const artifact = makeIblArtifact();
		assert.deepEqual( classifyPmremObjectUniformSlots( artifact, artifact.uniformPlan[ 0 ] ), {
			maxMip: 'nodeUniform14',
			transform: 'nodeUniform15',
			reciprocalWidth: 'nodeUniform19',
			reciprocalHeight: 'nodeUniform20',
			intensity: 'nodeUniform22',
		} );

		const material = { type: 'MeshStandardNodeMaterial' };
		const object = { id: 17, uuid: 'object-17', name: 'resolve-mesh', type: 'Mesh' };
		const state = hydrateNodeBuilderState( artifact, material );
		const updater = state.updateNodes.find( node => node && node.getUpdateType() === 'object' );
		assert.ok( updater );
		updater.update( { frameId: 7, material, object } );

		const active = objectBinding( state.createBindings() );
		assert.ok( active.group );
		assert.ok( active.binding );
		// Prove that the upload hook reads the binding offered to the backend,
		// rather than rebuilding its values from the serialized uniform plan.
		active.binding.buffer[ 84 / 4 ] = 7.5;
		assert.equal( active.binding.update(), true );

		const samples = globalThis.__tslpHarnessDiagnostics.objectUboSamples;
		assert.equal( samples.length, 2 );
		const [ update, upload ] = samples;
		assert.equal( update.phase, 'update' );
		assert.equal( upload.phase, 'upload' );
		assert.equal( update.artifact, 'ibl-resolve' );
		assert.equal( upload.materialShape, 'mesh-standard' );
		assert.equal( update.frame.objectName, 'resolve-mesh' );
		assert.equal( upload.frame.objectUuid, 'object-17' );
		assert.notEqual( update.bindGroupIdentity.id, upload.bindGroupIdentity.id );
		assert.equal( upload.bindGroupIdentity.id, active.group.id );
		assert.equal( upload.bindGroupIdentity.name, 'object' );
		assert.equal( upload.binding.name, 'object' );
		assert.equal( upload.group.byteLength, 176 );
		assert.equal( upload.binding.byteLength, active.binding.buffer.byteLength );
		assert.ok( upload.binding.byteLength >= upload.group.byteLength );

		assert.equal( update.pmrem.maxMip.name, 'nodeUniform14' );
		assert.equal( update.pmrem.maxMip.offset, 84 );
		assert.deepEqual( update.pmrem.maxMip.floats, [ 9 ] );
		assert.equal( update.pmrem.transform.name, 'nodeUniform15' );
		assert.equal( update.pmrem.transform.offset, 96 );
		assert.deepEqual( update.pmrem.transform.floats, IDENTITY_MATRIX );
		assert.equal( update.pmrem.transform.liveSidecarAttached, false );
		assert.equal( update.pmrem.transform.liveSidecarOverlay, false );
		closeTo( update.pmrem.reciprocalWidth.floats[ 0 ], Math.fround( 1 / 1536 ) );
		closeTo( update.pmrem.reciprocalHeight.floats[ 0 ], Math.fround( 1 / 2048 ) );
		assert.deepEqual( update.pmrem.intensity.floats, [ 1 ] );

		assert.deepEqual( upload.pmrem.maxMip.floats, [ 7.5 ] );
		assert.equal( upload.bufferFloats[ 84 / 4 ], 7.5 );
		assert.deepEqual( upload.bufferFloats.slice( 96 / 4, 96 / 4 + 16 ), IDENTITY_MATRIX );
		closeTo( upload.bufferFloats[ 160 / 4 ], Math.fround( 1 / 1536 ) );
		closeTo( upload.bufferFloats[ 164 / 4 ], Math.fround( 1 / 2048 ) );
		assert.equal( upload.bufferFloats[ 168 / 4 ], 1 );

	} finally {

		if ( previousFlag === undefined ) delete globalThis.__TSLP_DEBUG_OBJECT_UBO;
		else globalThis.__TSLP_DEBUG_OBJECT_UBO = previousFlag;
		if ( previousDiagnostics === undefined ) delete globalThis.__tslpHarnessDiagnostics;
		else globalThis.__tslpHarnessDiagnostics = previousDiagnostics;

	}

} );
