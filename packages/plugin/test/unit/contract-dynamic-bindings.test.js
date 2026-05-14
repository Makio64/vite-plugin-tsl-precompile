import test from 'node:test';
import assert from 'node:assert/strict';

import {
	DYNAMIC_BINDING_PHASE,
	DYNAMIC_BINDING_TARGET,
	collectArtifactDynamicBindings,
	dynamicBindingDescriptor,
	isDynamicBindingKind,
	validateDynamicBindingSource,
} from '@tsl-precompile/contract/dynamic-bindings';

test( 'dynamicBindingDescriptor resolves exact kinds', () => {

	assert.equal( dynamicBindingDescriptor( 'artifact.texture' ).target, DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE );
	assert.ok( dynamicBindingDescriptor( 'artifact.texture' ).optional.includes( 'imageWidth' ) );
	assert.equal( dynamicBindingDescriptor( 'depth.texture' ).target, DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE );
	assert.ok( dynamicBindingDescriptor( 'reflector.texture' ).optional.includes( 'generateMipmaps' ) );
	assert.equal( dynamicBindingDescriptor( 'uniform.live' ).target, DYNAMIC_BINDING_TARGET.UNIFORM_SLOT );
	assert.equal( dynamicBindingDescriptor( 'object3d.nodeUniform' ).owner, 'object3d' );
	assert.equal( dynamicBindingDescriptor( 'builtin.dfgLUT' ).owner, 'runtime' );

} );

test( 'dynamicBindingDescriptor resolves prefix kinds with the original kind preserved', () => {

	const cam = dynamicBindingDescriptor( 'camera.projectionMatrix' );
	assert.equal( cam.kind, 'camera.projectionMatrix' );
	assert.equal( cam.owner, 'camera' );
	assert.equal( cam.phase, DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE );

	const light = dynamicBindingDescriptor( 'light.position' );
	assert.equal( light.kind, 'light.position' );
	assert.equal( light.phase, DYNAMIC_BINDING_PHASE.UPDATE_BEFORE );

} );

test( 'dynamicBindingDescriptor returns null for unknown kinds', () => {

	assert.equal( dynamicBindingDescriptor( 'completely.made.up' ), null );
	assert.equal( dynamicBindingDescriptor( null ), null );
	assert.equal( dynamicBindingDescriptor( '' ), null );

} );

test( 'isDynamicBindingKind agrees with the descriptor lookup', () => {

	assert.equal( isDynamicBindingKind( 'artifact.texture' ), true );
	assert.equal( isDynamicBindingKind( 'camera.viewMatrix' ), true );
	assert.equal( isDynamicBindingKind( 'definitely.not.real' ), false );

} );

test( 'validateDynamicBindingSource enforces required fields for material.* texture descriptors', () => {

	const errors = validateDynamicBindingSource( { kind: 'material.map' } );
	assert.equal( errors.length, 1 );
	assert.equal( errors[ 0 ].field, 'property' );
	assert.equal( validateDynamicBindingSource( { kind: 'material.map', property: 'map' } ).length, 0 );

} );

test( 'collectArtifactDynamicBindings emits one entry per uniformPlan slot with a known source.kind', () => {

	const artifact = {
		uniformPlan: [
			{
				name: 'render',
				slots: [
					{ name: 'projectionMatrix', offset: 0, source: { kind: 'camera.projectionMatrix' } },
					{ name: 'time', offset: 64, source: { kind: 'frame.time' } },
					{ name: 'distortionScale', offset: 96, source: { kind: 'object3d.nodeUniform', property: 'distortionScale' } },
					{ name: 'mystery', offset: 128, source: { kind: 'mystery.unknown' } },
				],
				textures: [
					{ name: 'envMap', textureType: '2d', source: { kind: 'artifact.texture', textureUuid: 'a' } },
					{ name: 'shadowMap', textureType: 'depth', source: { kind: 'depth.texture', lightIndex: 0 } },
				],
			},
		],
	};
	const entries = collectArtifactDynamicBindings( artifact );

	// 3 known slots + 2 textures (unknown 'mystery.unknown' is skipped).
	assert.equal( entries.length, 5 );

	const camera = entries.find( ( e ) => e.kind === 'camera.projectionMatrix' );
	assert.equal( camera.target, DYNAMIC_BINDING_TARGET.UNIFORM_SLOT );
	assert.equal( camera.binding, 'projectionMatrix' );
	assert.equal( camera.group, 'render' );

	const frame = entries.find( ( e ) => e.kind === 'frame.time' );
	assert.equal( frame.phase, DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE );

	const objectUniform = entries.find( ( e ) => e.kind === 'object3d.nodeUniform' );
	assert.equal( objectUniform.owner, 'object3d' );
	assert.equal( objectUniform.source.property, 'distortionScale' );

	const envMap = entries.find( ( e ) => e.kind === 'artifact.texture' );
	assert.equal( envMap.target, DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE );
	assert.equal( envMap.textureType, '2d' );

	const shadow = entries.find( ( e ) => e.kind === 'depth.texture' );
	assert.equal( shadow.phase, DYNAMIC_BINDING_PHASE.UPDATE_BEFORE );
	assert.equal( shadow.source.lightIndex, 0 );

} );

test( 'collectArtifactDynamicBindings tolerates empty/missing input', () => {

	assert.deepEqual( collectArtifactDynamicBindings( null ), [] );
	assert.deepEqual( collectArtifactDynamicBindings( {} ), [] );
	assert.deepEqual( collectArtifactDynamicBindings( { uniformPlan: [] } ), [] );

} );

test( 'validateArtifact flags stored dynamicBindings that drift from the computed view', async () => {

	const { validateArtifact } = await import( '@tsl-precompile/contract/kinds' );
	const artifact = {
		__name: 'drift-test',
		artifact: {
			vertexShader: 'void main(){}',
			fragmentShader: 'void main(){}',
			uniformPlan: [ {
				name: 'render',
				slots: [ { name: 'time', offset: 0, source: { kind: 'frame.time' } } ],
			} ],
			// Stale: declares a depth.texture entry that the uniformPlan doesn't have.
			dynamicBindings: [
				{ kind: 'depth.texture', group: 'render', binding: 'fake', target: 'sampled-texture', phase: 'update-before', owner: 'light-or-material-graph', resolver: 'hydrator/shadow-depth-rebinder', source: { kind: 'depth.texture' } },
			],
		},
	};
	const result = validateArtifact( artifact, { label: 'drift-test' } );
	assert.equal( result.ok, false );
	// One stale error (declared but not in plan) + one missing error (frame.time slot not in dynamicBindings).
	const codes = result.errors.map( ( e ) => e.code );
	assert.ok( codes.includes( 'dynamicBindings.stale' ), `expected dynamicBindings.stale, got ${ codes.join( ', ' ) }` );
	assert.ok( codes.includes( 'dynamicBindings.missing' ), `expected dynamicBindings.missing, got ${ codes.join( ', ' ) }` );

} );

test( 'validateArtifact accepts a dynamicBindings section that matches the computed view', async () => {

	const { validateArtifact } = await import( '@tsl-precompile/contract/kinds' );
	const planSlot = { kind: 'frame.time', group: 'render', binding: 'time', target: 'uniform-slot', phase: 'codegen-update', owner: 'frame', resolver: 'emit-updater/frame', source: { kind: 'frame.time' } };
	const artifact = {
		__name: 'match-test',
		artifact: {
			vertexShader: 'void main(){}',
			fragmentShader: 'void main(){}',
			uniformPlan: [ {
				name: 'render',
				slots: [ { name: 'time', offset: 0, source: { kind: 'frame.time' } } ],
			} ],
			dynamicBindings: [ planSlot ],
		},
	};
	const result = validateArtifact( artifact, { label: 'match-test' } );
	assert.deepEqual( result.errors, [] );

} );

test( 'collectArtifactDynamicBindings is idempotent and does not mutate the input', () => {

	const artifact = {
		uniformPlan: [ {
			name: 'render',
			slots: [ { name: 'time', offset: 0, source: { kind: 'frame.time' } } ],
			textures: [],
		} ],
	};
	const original = JSON.stringify( artifact );
	const a = collectArtifactDynamicBindings( artifact );
	const b = collectArtifactDynamicBindings( artifact );
	assert.equal( original, JSON.stringify( artifact ) );
	assert.equal( a.length, 1 );
	assert.equal( b.length, 1 );
	assert.notEqual( a, b ); // fresh array each call
	assert.deepEqual( a[ 0 ], b[ 0 ] );

} );
