import test from 'node:test';
import assert from 'node:assert/strict';

import {
	createLiveUniformCallsiteIdentity,
	createLiveUniformNodeIdentity,
	DYNAMIC_BINDING_PHASE,
	DYNAMIC_BINDING_TARGET,
	collectArtifactDynamicBindings,
	dynamicBindingDescriptor,
	isDynamicBindingKind,
	isLiveUniformCallsiteIdentity,
	isLiveUniformNodeIdentity,
	validateDynamicBindingSource,
} from '@tsl-precompile/contract/dynamic-bindings';
import { collectArtifactSourceKinds, validateArtifact } from '@tsl-precompile/contract/kinds';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';

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

test( 'validateDynamicBindingSource accepts only serializable uniform.live node paths', () => {

	assert.equal( validateDynamicBindingSource( {
		kind: 'uniform.live',
		nodePath: [ 'positionNode', 'leftNode', 'valueNode' ],
	} ).length, 0 );
	for ( const nodePath of [ [], [ '' ], [ 'positionNode', 0 ], [ 'positionNode', '__proto__' ], [ 'constructor' ], 'positionNode' ] ) {

		const errors = validateDynamicBindingSource( { kind: 'uniform.live', nodePath } );
		assert.equal( errors.length, 1 );
		assert.equal( errors[ 0 ].code, 'dynamic-binding.node-path' );
		assert.equal( errors[ 0 ].field, 'nodePath' );

	}

} );

test( 'validateDynamicBindingSource accepts only non-negative uniform.live identity ids', () => {

	assert.equal( validateDynamicBindingSource( { kind: 'uniform.live', liveNodeId: 0 } ).length, 0 );
	assert.equal( validateDynamicBindingSource( { kind: 'uniform.live', liveNodeId: 7 } ).length, 0 );
	for ( const liveNodeId of [ - 1, 1.5, '1', null ] ) {

		const errors = validateDynamicBindingSource( { kind: 'uniform.live', liveNodeId } );
		assert.equal( errors.length, 1 );
		assert.equal( errors[ 0 ].code, 'dynamic-binding.live-node-id' );

	}

} );

test( 'uniform.live call-site identities are stable, instance-qualified, and validated', () => {

	const callsite = createLiveUniformCallsiteIdentity( 'src/materials.js?subresource=abc', 2 );
	const identity = createLiveUniformNodeIdentity( callsite, 7 );
	assert.equal( callsite, 'uniform-callsite@1#src/materials.js?subresource=abc#2' );
	assert.equal( identity, 'uniform-callsite@1#src/materials.js?subresource=abc#2#7' );
	assert.equal( isLiveUniformCallsiteIdentity( callsite ), true );
	assert.equal( isLiveUniformNodeIdentity( identity ), true );
	assert.equal( validateDynamicBindingSource( { kind: 'uniform.live', liveNodeId: 0, liveNodeIdentity: identity } ).length, 0 );
	assert.equal( validateDynamicBindingSource( { kind: 'uniform.live', liveNodeIdentity: identity } )[ 0 ].code, 'dynamic-binding.live-node-identity-owner' );
	for ( const invalid of [ '', callsite, 'uniform-callsite@1#src/materials.js#x#0', 'other@1#src/materials.js#2#0', null ] ) {

		assert.equal( isLiveUniformNodeIdentity( invalid ), false );
		assert.ok( validateDynamicBindingSource( { kind: 'uniform.live', liveNodeId: 0, liveNodeIdentity: invalid } ).length > 0 );

	}

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
				storageBuffers: [
					{ name: 'StorageBuffer_17', source: { kind: 'storage.buffer', attributeName: 'Current_Left' } },
				],
			},
		],
	};
	const entries = collectArtifactDynamicBindings( artifact );

	// 3 known slots + 2 textures + 1 storage buffer (unknown 'mystery.unknown' is skipped).
	assert.equal( entries.length, 6 );

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

	const storage = entries.find( ( e ) => e.kind === 'storage.buffer' );
	assert.equal( storage.target, DYNAMIC_BINDING_TARGET.STORAGE_BUFFER );
	assert.equal( storage.binding, 'StorageBuffer_17' );
	assert.equal( storage.group, 'render' );
	assert.equal( storage.source.attributeName, 'Current_Left' );

} );

test( 'storage-buffer source kinds participate in shared collection and validation', () => {

	const artifact = {
		uniformPlan: [ {
			name: 'render',
			storageBuffers: [ {
				name: 'StorageBuffer_17',
				source: { kind: 'storage.buffer', attributeName: 'Current_Left' },
			} ],
		} ],
	};
	assert.deepEqual( collectArtifactSourceKinds( artifact ), [ 'storage.buffer' ] );
	assert.deepEqual( validateArtifact( artifact ).errors, [] );

	const invalid = validateArtifact( {
		uniformPlan: [ {
			name: 'render',
			storageBuffers: [ {
				name: 'StorageBuffer_18',
				source: { kind: 'storage.future' },
			} ],
		} ],
	} );
	assert.ok( invalid.errors.some( ( error ) =>
		error.code === 'source.kind.unknown'
		&& error.path === 'uniformPlan[0].storageBuffers[0].source.kind'
	) );

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
				{ kind: 'depth.texture', group: 'render', binding: 'fake', target: 'sampled-texture', phase: 'update-before', owner: 'light-or-material-graph', resolver: 'hydrator/shadow-depth-rebinder', textureType: null, source: { kind: 'depth.texture' } },
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
	const planSlot = { kind: 'frame.time', group: 'render', binding: 'time', offset: 0, target: 'uniform-slot', phase: 'codegen-update', owner: 'frame', resolver: 'emit-updater/frame', source: { kind: 'frame.time' } };
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

test( 'validateArtifact recursively validates variant-local plans', async () => {

	const { validateArtifact } = await import( '@tsl-precompile/contract/kinds' );
	const result = validateArtifact( {
		uniformPlan: [],
		variants: {
			variant: {
				uniformPlan: [ {
					name: 'variant',
					slots: [ { source: { kind: 'future.variant.kind' } } ],
				} ],
			},
		},
	} );

	assert.equal( result.ok, false );
	assert.ok( result.errors.some( ( error ) => error.code === 'source.kind.unknown' && error.path.startsWith( 'variants.variant.' ) ) );

} );

test( 'validateArtifact enforces canonical, complete semantic variant families', async () => {

	const { validateArtifact } = await import( '@tsl-precompile/contract/kinds' );
	const selector = stableJsonStringify( { version: 'render-object-selector@1', topology: 'shared' } );
	const variant = ( cacheKey, fragmentShader, selectors = [ selector ] ) => ( {
		cacheKey,
		vertexShader: 'vertex',
		fragmentShader,
		uniformPlan: [],
		renderContextSelectors: selectors,
	} );

	const collision = validateArtifact( {
		...variant( 'a', 'fragment-a' ),
		variants: {
			a: variant( 'a', 'fragment-a' ),
			b: variant( 'b', 'fragment-b' ),
		},
	} );
	assert.ok( collision.errors.some( ( error ) => error.code === 'artifact.renderContextSelector.collision' ) );

	const partial = validateArtifact( {
		...variant( 'a', 'fragment-a' ),
		variants: {
			a: variant( 'a', 'fragment-a' ),
			b: variant( 'wrong-key', 'fragment-b', null ),
		},
	} );
	assert.ok( partial.errors.some( ( error ) => error.code === 'artifact.variant.cacheKey' ) );
	assert.ok( partial.errors.some( ( error ) => error.code === 'artifact.renderContextSelectors.partial-family' ) );

	const nonCanonical = validateArtifact( {
		...variant( 'single', 'fragment', [ JSON.stringify( { version: 'render-object-selector@1', topology: 'shared' } ) ] ),
	} );
	assert.ok( nonCanonical.errors.some( ( error ) => error.code === 'artifact.renderContextSelector.canonical' ) );

} );

test( 'validateArtifact checks the complete stored dynamic binding descriptor', async () => {

	const { validateArtifact } = await import( '@tsl-precompile/contract/kinds' );
	const artifact = {
		vertexShader: 'void main(){}',
		fragmentShader: 'void main(){}',
		uniformPlan: [ {
			name: 'render',
			slots: [ {
				name: 'time',
				offset: 16,
				source: { kind: 'frame.time', valueSnapshot: { type: 'float', data: 1 } },
			} ],
		} ],
		dynamicBindings: [
			{
				kind: 'frame.time',
				target: 'sampled-texture',
				phase: 'update-before',
				owner: 'renderer',
				resolver: 'hydrator/not-real',
				group: 'render',
				binding: 'time',
				textureType: '2d',
				source: { kind: 'frame.time', valueSnapshot: { type: 'float', data: 2 } },
			},
			{
				kind: 'material.map',
				target: 'sampled-texture',
				phase: 'late-rebind',
				owner: 'material',
				resolver: 'hydrator/material-texture',
				group: 'render',
				binding: 'map',
				textureType: '2d',
				source: { kind: 'material.map' },
			},
		],
	};
	const result = validateArtifact( artifact, { label: 'full-shape' } );

	assert.equal( result.ok, false );
	const codes = result.errors.map( ( error ) => error.code );
	assert.ok( codes.includes( 'dynamicBindings.descriptor' ) );
	assert.ok( codes.includes( 'dynamicBindings.mismatch' ) );
	assert.ok( codes.includes( 'dynamic-binding.required' ) );
	assert.ok( result.errors.some( ( error ) => error.path === 'dynamicBindings[0].source' ) );
	assert.ok( result.errors.some( ( error ) => error.path === 'dynamicBindings[1].source.property' ) );

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
