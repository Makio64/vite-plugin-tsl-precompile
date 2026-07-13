import test from 'node:test';
import assert from 'node:assert/strict';

import {
	BLOCKED_KINDS,
	KINDS,
	LIGHT_SLOT_KINDS,
	RUNTIME_BINDING_KINDS,
	blockedKindReason,
	isBlockedKind,
	isArtifactCollection,
	isKnownKind,
	kindInfo,
	listRegisteredKinds,
	registerKind,
	unregisterKind,
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
	assert.ok( isKnownKind( 'object.radius' ) );
	assert.ok( isKnownKind( 'object3d.nodeUniform' ) );
	assert.ok( isKnownKind( 'builtin.dfgLUT' ) );
	assert.ok( isBlockedKind( 'builtin.dfgLUT' ) );
	assert.match( blockedKindReason( 'builtin.dfgLUT' ), /DFG LUT/ );
	assert.equal( isKnownKind( 'totally.new.kind' ), false );

} );

test( 'contract owns the canonical generated light slot vocabulary', () => {

	assert.ok( LIGHT_SLOT_KINDS.length > 0 );
	for ( const kind of LIGHT_SLOT_KINDS ) {

		assert.ok( kind.startsWith( 'light.' ) );
		assert.ok( KINDS[ kind ], `${ kind } missing from KINDS` );

	}

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

test( 'contract artifact validation distinguishes empty render computeShader from compute artifacts', () => {

	const render = validateArtifact( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		computeShader: '',
		uniformPlan: [],
	}, { label: 'render', requireShaders: true } );
	assert.equal( render.ok, true, JSON.stringify( render.errors ) );

	const missingRenderShaders = validateArtifact( {
		computeShader: '',
		uniformPlan: [],
	}, { label: 'missing-render-shaders', requireShaders: true } );
	assert.equal( missingRenderShaders.ok, false );
	assert.deepEqual(
		missingRenderShaders.errors.map( ( error ) => error.code ).sort(),
		[ 'artifact.fragmentShader', 'artifact.vertexShader' ],
	);

	const emptyCompute = validateArtifact( {
		kind: 'compute',
		computeShader: '',
		uniformPlan: [],
	}, { label: 'empty-compute', requireShaders: true } );
	assert.equal( emptyCompute.ok, false );
	assert.equal( emptyCompute.errors[ 0 ].code, 'artifact.computeShader' );

} );

test( 'contract artifact validation rejects runtime binding kinds the hydrator cannot allocate', () => {

	assert.deepEqual( RUNTIME_BINDING_KINDS, [ 'uniform-buffer', 'sampled-texture', 'sampler', 'storage-buffer' ] );
	const result = validateArtifact( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		uniformPlan: [],
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'object', kind: 'uniform-buffer' },
				{ name: 'futureTexture', kind: 'storage-texture' },
			],
		} ],
	}, { label: 'runtime-bindings' } );

	assert.equal( result.ok, false );
	const error = result.errors.find( ( item ) => item.code === 'binding.kind.unknown' );
	assert.equal( error.path, 'bindings[0].bindings[1].kind' );
	assert.match( error.message, /storage-texture/ );

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
	assert.ok( viewport.optional.includes( 'shared' ) );

	const live = dynamicBindingDescriptor( 'uniform.live' );
	assert.equal( live.target, DYNAMIC_BINDING_TARGET.UNIFORM_SLOT );
	assert.equal( live.phase, DYNAMIC_BINDING_PHASE.UPDATE_BEFORE );

	const objectUniform = dynamicBindingDescriptor( 'object3d.nodeUniform' );
	assert.equal( objectUniform.target, DYNAMIC_BINDING_TARGET.UNIFORM_SLOT );
	assert.equal( objectUniform.owner, 'object3d' );

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
	assert.deepEqual( validateDynamicBindingSource( { kind: 'object3d.nodeUniform', property: 'distortionScale' } ), [] );
	assert.deepEqual( validateDynamicBindingSource( { kind: 'object3d.nodeUniform' } ).map( ( error ) => error.field ), [ 'property' ] );
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

test( 'registerKind makes a custom kind resolvable via kindInfo / isKnownKind', () => {

	unregisterKind( 'custom.testFx' );
	assert.equal( isKnownKind( 'custom.testFx' ), false );
	const descriptor = registerKind( {
		kind: 'custom.testFx',
		status: 'codegen',
		codegen: 'user-supplied',
		description: 'unit-test custom kind',
	} );
	assert.equal( descriptor.kind, 'custom.testFx' );
	assert.equal( descriptor.codegen, 'user-supplied' );
	assert.equal( isKnownKind( 'custom.testFx' ), true );
	assert.equal( kindInfo( 'custom.testFx' ).status, 'codegen' );
	assert.ok( listRegisteredKinds().some( ( e ) => e.kind === 'custom.testFx' ) );
	unregisterKind( 'custom.testFx' );

} );

test( 'registerKind is idempotent on identical descriptors and rejects conflicts', () => {

	unregisterKind( 'custom.idempotent' );
	const first = registerKind( { kind: 'custom.idempotent', status: 'runtime-texture', runtime: 'user' } );
	const second = registerKind( { kind: 'custom.idempotent', status: 'runtime-texture', runtime: 'user' } );
	assert.equal( first, second, 're-registering same descriptor returns the same frozen entry' );

	assert.throws( () => {

		registerKind( { kind: 'custom.idempotent', status: 'codegen', codegen: 'different' } );

	}, /different descriptor/ );
	unregisterKind( 'custom.idempotent' );

} );

test( 'registerKind rejects malformed entries and built-in overrides', () => {

	assert.throws( () => registerKind( {} ), /entry\.kind/ );
	assert.throws( () => registerKind( { kind: 'custom.bad' } ), /entry\.status/ );
	assert.throws( () => registerKind( { kind: 'custom.bad', status: 'mystery' } ), /entry\.status must be one of/ );
	assert.throws( () => registerKind( { kind: 'material.color', status: 'codegen' } ), /built-in/ );

} );

test( 'unregisterKind removes user entries; returns false for non-user kinds', () => {

	registerKind( { kind: 'custom.removable', status: 'codegen', codegen: 'noop' } );
	assert.equal( unregisterKind( 'custom.removable' ), true );
	assert.equal( unregisterKind( 'custom.removable' ), false, 'second unregister is a no-op' );
	assert.equal( unregisterKind( 'material.color' ), false, 'built-in cannot be unregistered' );
	assert.equal( isKnownKind( 'custom.removable' ), false );

} );

test( 'validateArtifact accepts artifacts that use a user-registered kind', () => {

	unregisterKind( 'custom.greenLight' );
	registerKind( { kind: 'custom.greenLight', status: 'codegen', codegen: 'user-supplied' } );
	const result = validateArtifact( {
		artifact: {
			vertexShader: 'v',
			fragmentShader: 'f',
			uniformPlan: [ {
				name: 'object',
				slots: [ { name: 'fxParams', source: { kind: 'custom.greenLight' } } ],
			} ],
		},
	}, { label: 'custom-kind-fixture' } );
	assert.equal( result.ok, true, JSON.stringify( result.errors ) );
	unregisterKind( 'custom.greenLight' );

} );
