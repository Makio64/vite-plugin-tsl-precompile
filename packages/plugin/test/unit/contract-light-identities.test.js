import test from 'node:test';
import assert from 'node:assert/strict';

import { createArtifactContentHashPayload } from '@tsl-precompile/contract/artifact-content';
import { createArtifactVariantPayload } from '@tsl-precompile/contract/artifact-variants';
import { collectArtifactDynamicBindings, dynamicBindingDescriptor } from '@tsl-precompile/contract/dynamic-bindings';
import {
	LIGHT_IDENTITY_CAPTURE,
	LIGHT_IDENTITY_SCHEMA,
	createCapturedLightIdentity,
	createLightSourceIdentityMetadata,
	normalizeArtifactLightIdentities,
	normalizeArtifactLightIdentitiesDeep,
} from '@tsl-precompile/contract/light-identities';
import { validateArtifact } from '@tsl-precompile/contract/kinds';

function lightFixture( overrides = {} ) {

	return {
		id: 999,
		uuid: 'capture-light-a',
		type: 'SpotLight',
		name: 'Key light',
		userData: { tslPrecompileId: 'studio:key' },
		position: { x: 1, y: 2, z: 3 },
		matrixWorld: { elements: [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 11, 12, 13, 1 ] },
		target: {
			position: { x: 4, y: 5, z: 6 },
			matrixWorld: { elements: [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 14, 15, 16, 1 ] },
		},
		color: { r: 0.25, g: 0.5, b: 0.75 },
		intensity: 3,
		distance: 20,
		decay: 2,
		angle: 0.7,
		penumbra: 0.2,
		castShadow: true,
		shadow: { type: 'SpotLightShadow', camera: { type: 'PerspectiveCamera' } },
		...overrides,
	};

}

test( 'light identity capture uses durable metadata and world-space evidence', () => {

	const record = createCapturedLightIdentity( lightFixture(), 4 );
	assert.equal( record.schema, LIGHT_IDENTITY_SCHEMA );
	assert.equal( record.captureIndex, 4 );
	assert.equal( record.captureUuid, 'capture-light-a' );
	assert.equal( record.explicitKey, 'studio:key' );
	assert.equal( record.name, 'Key light' );
	assert.equal( record.type, 'SpotLight' );
	assert.deepEqual( record.snapshot.position, [ 11, 12, 13 ], 'parented lights use matrixWorld translation' );
	assert.deepEqual( record.snapshot.targetPosition, [ 14, 15, 16 ], 'parented targets use matrixWorld translation' );
	assert.equal( Object.hasOwn( record, 'id' ), false, 'process-local Object3D.id must not become durable identity' );

} );

test( 'normalizer aggregates one complete record and preserves legacy fields', () => {

	const base = createLightSourceIdentityMetadata( lightFixture(), 2 );
	const liveNode = {};
	const positionSlot = {
		name: 'position',
		offset: 0,
		source: { kind: 'light.position', ...base, valueSnapshot: { type: 'vec3', data: [ 11, 12, 13 ] } },
	};
	Object.defineProperty( positionSlot, '_liveNode', { value: liveNode, enumerable: false } );
	const distanceSlot = {
		name: 'distance',
		offset: 16,
		source: { kind: 'light.distance', ...base, valueSnapshot: { type: 'number', data: 20 } },
	};
	const depthTexture = {
		name: 'shadowMap',
		source: { kind: 'depth.texture', ...base, textureUuid: 'depth-a', vsm: false },
	};
	const artifact = {
		uniformPlan: [ {
			name: 'render',
			slots: [ positionSlot, distanceSlot ],
			textures: [ depthTexture ],
			orderedBindings: [ { type: 'ubo', slots: [ positionSlot, distanceSlot ] }, { type: 'sampled-texture', ref: depthTexture } ],
		} ],
	};

	assert.equal( JSON.stringify( artifact ).includes( 'studio:key' ), false, 'Symbol capture evidence is not serialized per source' );
	const normalized = normalizeArtifactLightIdentities( artifact );
	assert.notEqual( normalized, artifact );
	assert.equal( artifact.uniformPlan[ 0 ].slots[ 0 ].source.lightIdentity, undefined, 'normalization is non-mutating' );
	assert.equal( normalized.lightIdentities.length, 1 );
	assert.deepEqual( normalized.lightIdentities[ 0 ], createCapturedLightIdentity( lightFixture(), 2 ) );

	const group = normalized.uniformPlan[ 0 ];
	for ( const item of [ ...group.slots, ...group.textures ] ) {

		assert.equal( item.source.lightIdentity, 0 );
		assert.equal( item.source.lightIndex, 2, 'legacy capture order remains available' );
		assert.equal( item.source.lightUuid, 'capture-light-a', 'legacy capture UUID remains available' );
		assert.equal( item.source[ LIGHT_IDENTITY_CAPTURE ], undefined, 'transient evidence is removed after aggregation' );

	}
	assert.equal( group.orderedBindings[ 0 ].slots[ 0 ], group.slots[ 0 ], 'ordered and flat plan views retain shared slot identity' );
	assert.equal( group.orderedBindings[ 1 ].ref, group.textures[ 0 ], 'ordered and flat plan views retain shared texture identity' );
	assert.equal( group.slots[ 0 ]._liveNode, liveNode, 'non-enumerable live sidecars survive normalization' );

} );

test( 'deep normalization keeps light tables variant-local', () => {

	const source = ( uuid, lightIndex ) => ( {
		kind: 'light.distance',
		lightUuid: uuid,
		lightIndex,
		valueSnapshot: { type: 'number', data: 5 + lightIndex },
	} );
	const artifact = {
		cacheKey: 1,
		uniformPlan: [ { slots: [ { source: source( 'root-light', 0 ) } ] } ],
		variants: {
			2: { cacheKey: 2, uniformPlan: [ { slots: [ { source: source( 'variant-light', 3 ) } ] } ] },
		},
	};
	const normalized = normalizeArtifactLightIdentitiesDeep( artifact );
	assert.equal( normalized.lightIdentities[ 0 ].captureUuid, 'root-light' );
	assert.equal( normalized.variants[ 2 ].lightIdentities[ 0 ].captureUuid, 'variant-light' );
	assert.notEqual( normalized.lightIdentities, normalized.variants[ 2 ].lightIdentities );
	assert.deepEqual( createArtifactVariantPayload( normalized.variants[ 2 ] ).lightIdentities, normalized.variants[ 2 ].lightIdentities );

} );

test( 'validation and dynamic descriptors include light identity references', () => {

	const normalized = normalizeArtifactLightIdentities( {
		vertexShader: 'v',
		fragmentShader: 'f',
		uniformPlan: [ { name: 'render', slots: [ {
			name: 'distance',
			offset: 0,
			source: { kind: 'light.distance', lightIndex: 0, lightUuid: 'capture-light-a', valueSnapshot: { type: 'number', data: 4 } },
		} ] } ],
	} );
	const artifact = { ...normalized, dynamicBindings: collectArtifactDynamicBindings( normalized ) };
	assert.equal( artifact.dynamicBindings[ 0 ].source.lightIdentity, 0 );
	assert.ok( dynamicBindingDescriptor( 'light.distance' ).optional.includes( 'lightIdentity' ) );
	assert.equal( validateArtifact( artifact ).ok, true, JSON.stringify( validateArtifact( artifact ).errors ) );

	const stale = JSON.parse( JSON.stringify( artifact ) );
	delete stale.dynamicBindings[ 0 ].source.lightIdentity;
	const staleResult = validateArtifact( stale );
	assert.equal( staleResult.ok, false );
	assert.ok( staleResult.errors.some( ( error ) => error.code === 'dynamicBindings.mismatch' ) );

	const mismatched = structuredClone( artifact );
	mismatched.lightIdentities[ 0 ].captureUuid = 'wrong-light';
	const mismatchResult = validateArtifact( mismatched );
	assert.ok( mismatchResult.errors.some( ( error ) => error.code === 'lightIdentity.captureUuid.mismatch' ) );

} );

test( 'artifact content identity includes the light table deterministically', () => {

	const artifact = normalizeArtifactLightIdentities( {
		uniformPlan: [ { slots: [ { source: { kind: 'light.distance', lightIndex: 0, lightUuid: 'light-a' } } ] } ],
	} );
	const options = { shape: 'mesh-standard', threeVersion: '0.184.0', toolchainVersion: 'test' };
	const first = createArtifactContentHashPayload( artifact, options );
	const same = createArtifactContentHashPayload( structuredClone( artifact ), options );
	const changed = structuredClone( artifact );
	changed.lightIdentities[ 0 ].name = 'different';
	assert.equal( first, same );
	assert.notEqual( first, createArtifactContentHashPayload( changed, options ) );

} );
