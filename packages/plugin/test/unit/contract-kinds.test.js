import test from 'node:test';
import assert from 'node:assert/strict';

import {
	BLOCKED_KINDS,
	KINDS,
	blockedKindReason,
	isBlockedKind,
	isArtifactCollection,
	isKnownKind,
	validateArtifact,
} from '@tsl-precompile/contract/kinds';
import {
	DYNAMIC_BINDING_PHASE,
	DYNAMIC_BINDING_TARGET,
	dynamicBindingDescriptor,
	isDynamicBindingKind,
	validateDynamicBindingSource,
} from '@tsl-precompile/contract/dynamic-bindings';

test( 'contract kind registry recognises codegen and runtime texture kinds', () => {

	assert.ok( isKnownKind( 'camera.projectionMatrix' ) );
	assert.ok( isKnownKind( 'light.shadowMatrix' ) );
	assert.ok( isKnownKind( 'material.color' ) );
	assert.ok( isKnownKind( 'material.map' ) );
	assert.ok( isKnownKind( 'material.map.matrix' ) );
	assert.ok( isKnownKind( 'builtin.dfgLUT' ) );
	assert.ok( isBlockedKind( 'builtin.dfgLUT' ) );
	assert.match( blockedKindReason( 'builtin.dfgLUT' ), /DFG LUT/ );
	assert.equal( isKnownKind( 'totally.new.kind' ), false );

} );

test( 'contract blocked kinds are all registered with metadata', () => {

	for ( const [ kind, reason ] of Object.entries( BLOCKED_KINDS ) ) {

		assert.ok( KINDS[ kind ], `${ kind } missing from KINDS` );
		assert.equal( KINDS[ kind ].reason, reason );

	}

} );

test( 'contract artifact validation rejects unknown source kinds', () => {

	const result = validateArtifact( {
		artifact: {
			vertexShader: 'v',
			fragmentShader: 'f',
			uniformPlan: [ {
				name: 'object',
				slots: [ { source: { kind: 'mystery.kind' } } ],
				textures: [ { source: { kind: 'material.map' } } ],
			} ],
		},
	}, { label: 'fixture' } );

	assert.equal( result.ok, false );
	assert.deepEqual( result.sourceKinds, [ 'material.map', 'mystery.kind' ] );
	assert.equal( result.errors[ 0 ].code, 'source.kind.unknown' );
	assert.match( result.errors[ 0 ].message, /mystery\.kind/ );

} );

test( 'contract artifact validation accepts known slot and texture kinds', () => {

	const result = validateArtifact( {
		vertexShader: 'v',
		fragmentShader: 'f',
		uniformPlan: [ {
			name: 'object',
			slots: [
				{ source: { kind: 'camera.viewMatrix' } },
				{ source: { kind: 'material.map.matrix', property: 'map' } },
			],
			textures: [
				{ source: { kind: 'material.map', property: 'map' } },
				{ source: { kind: 'artifact.texture' } },
			],
		} ],
	}, { label: 'fixture' } );

	assert.equal( result.ok, true );
	assert.deepEqual( result.errors, [] );

} );

test( 'contract artifact validation accepts aggregate artifact dumps', () => {

	const collection = {
		first: {
			__hash: 'sha256:first',
			name: 'first',
			artifact: {
				vertexShader: 'v',
				fragmentShader: 'f',
				uniformPlan: [ {
					name: 'object',
					slots: [ { source: { kind: 'camera.viewMatrix' } } ],
				} ],
			},
		},
		second: {
			__hash: 'sha256:second',
			name: 'second',
			artifact: {
				vertexShader: 'v',
				fragmentShader: 'f',
				uniformPlan: [ {
					name: 'material',
					textures: [ { source: { kind: 'material.normalMap', property: 'normalMap' } } ],
				} ],
			},
		},
	};
	const result = validateArtifact( collection, { label: 'aggregate' } );

	assert.equal( isArtifactCollection( collection ), true );
	assert.equal( result.ok, true );
	assert.deepEqual( result.sourceKinds, [ 'camera.viewMatrix', 'material.normalMap' ] );

} );

test( 'contract artifact validation can accept empty aggregate dumps explicitly', () => {

	assert.equal( isArtifactCollection( [], { allowEmpty: true } ), true );
	const result = validateArtifact( [], { label: 'empty-aggregate', allowEmptyCollection: true } );

	assert.equal( result.ok, true );
	assert.deepEqual( result.sourceKinds, [] );

} );

test( 'contract dynamic binding descriptors document runtime texture and live slot resolvers', () => {

	const viewport = dynamicBindingDescriptor( 'viewport.texture' );
	assert.equal( viewport.target, DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE );
	assert.equal( viewport.phase, DYNAMIC_BINDING_PHASE.UPDATE_BEFORE );
	assert.match( viewport.resolver, /viewport-texture/ );

	const live = dynamicBindingDescriptor( 'uniform.live' );
	assert.equal( live.target, DYNAMIC_BINDING_TARGET.UNIFORM_SLOT );
	assert.equal( live.phase, DYNAMIC_BINDING_PHASE.UPDATE_BEFORE );

	const materialMap = dynamicBindingDescriptor( 'material.map' );
	assert.equal( materialMap.target, DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE );
	assert.equal( materialMap.property, 'map' );

	const materialScalar = dynamicBindingDescriptor( 'material.opacity' );
	assert.equal( materialScalar.target, DYNAMIC_BINDING_TARGET.UNIFORM_SLOT );
	assert.equal( materialScalar.owner, 'material' );

	assert.equal( isDynamicBindingKind( 'light.shadowMatrix' ), true );
	assert.equal( isDynamicBindingKind( 'totally.new.kind' ), false );

} );

test( 'contract dynamic binding descriptor validation reports missing required fields', () => {

	assert.deepEqual( validateDynamicBindingSource( { kind: 'object3d.userData', property: 'speed' } ), [] );
	assert.deepEqual( validateDynamicBindingSource( { kind: 'object3d.userData' } ).map( ( error ) => error.field ), [ 'property' ] );
	assert.deepEqual( validateDynamicBindingSource( { kind: 'material.map', property: 'map' } ), [] );
	assert.deepEqual( validateDynamicBindingSource( { kind: 'material.map' } ).map( ( error ) => error.field ), [ 'property' ] );

	const result = validateArtifact( {
		fragmentShader: 'var nodeTexture0: texture_2d<f32>;',
		uniformPlan: [ {
			name: 'material',
			textures: [ { name: 'nodeTexture0', source: { kind: 'material.map' } } ],
		} ],
	}, { label: 'fixture' } );

	assert.equal( result.ok, false );
	assert.equal( result.errors.find( ( error ) => error.code === 'dynamic-binding.required' ).path, 'uniformPlan[0].textures[0].source.property' );

} );
