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
	VIEWPORT_TEXTURE_IDENTITY_SCHEMA,
	createViewportTextureIdentity,
	dynamicBindingDescriptor,
	isDynamicBindingKind,
	validateDynamicBindingSource,
} from '@tsl-precompile/contract/dynamic-bindings';
import { createArtifactVariantPayload } from '@tsl-precompile/contract/artifact-variants';
import {
	RENDER_BINDING_OWNER_KINDS,
	resolveArtifactSourceBindingOwner,
} from '@tsl-precompile/contract/render-selector';
import {
	createVSMSupportConfig,
	vsmMomentsTopology,
	vsmSourceInputTopology,
} from '@tsl-precompile/contract/vsm-config';

test( 'contract kind registry recognises codegen and runtime texture kinds', () => {

	assert.ok( isKnownKind( 'camera.projectionMatrix' ) );
	assert.ok( isKnownKind( 'light.shadowMatrix' ) );
	assert.ok( isKnownKind( 'material.color' ) );
	assert.ok( isKnownKind( 'material.map' ) );
	assert.ok( isKnownKind( 'material.map.matrix' ) );
	assert.ok( isKnownKind( 'object.radius' ) );
	assert.ok( isKnownKind( 'object3d.nodeUniform' ) );
	assert.ok( isKnownKind( 'velocity.currentProjectionMatrix' ) );
	assert.ok( isKnownKind( 'environment.rotation' ) );
	assert.ok( isKnownKind( 'pmrem.maxMip' ) );
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

test( 'contract artifact validation reports malformed plans without throwing from relation checks', () => {

	const result = validateArtifact( {
		vertexShader: 'v',
		fragmentShader: 'f',
		uniformPlan: {},
	}, { label: 'malformed-plan' } );

	assert.equal( result.ok, false );
	assert.ok( result.errors.some( ( error ) =>
		error.code === 'artifact.uniformPlan'
			&& error.path === 'uniformPlan'
			&& /uniformPlan must be an array/.test( error.message )
	) );

} );

test( 'contract artifact validation keeps internal-pass address checks total over a malformed plan', () => {

	const config = createVSMSupportConfig();
	const internalPass = {
		schema: 'internal-pass@1',
		family: 'shadow-vsm',
		stage: 'vertical',
		shape: 'shadow-vsm-vertical',
		config,
		uniforms: [
			{ role: 'blur-samples', group: 'render', binding: 'nodeUniform0', valueType: 'float' },
			{ role: 'radius', group: 'render', binding: 'nodeUniform3', valueType: 'float' },
			{ role: 'map-size', group: 'render', binding: 'nodeUniform4', valueType: 'vec2' },
		],
		inputs: [ {
			role: 'shadow-depth',
			kind: 'texture',
			group: 'object',
			binding: 'nodeUniform1',
			topology: vsmSourceInputTopology( config ),
		} ],
		output: { topology: vsmMomentsTopology( config ) },
	};
	const artifact = {
		materialShape: 'shadow-vsm-vertical',
		vertexShader: 'v',
		fragmentShader: 'f',
		internalPass,
	};
	const result = validateArtifact( {
		...artifact,
		uniformPlan: {},
	}, { label: 'malformed-internal-pass-plan' } );

	assert.equal( result.ok, false );
	assert.ok( result.errors.some( ( error ) => error.code === 'artifact.uniformPlan' ) );
	assert.ok( result.errors.some( ( error ) => error.code === 'internal-pass.uniform.address' ) );
	assert.ok( result.errors.some( ( error ) => error.code === 'internal-pass.texture.address' ) );

	const malformedLists = validateArtifact( {
		...artifact,
		uniformPlan: [
			{ name: 'render', slots: {} },
			{ name: 'object', textures: {} },
		],
	}, { label: 'malformed-internal-pass-lists' } );
	assert.equal( malformedLists.ok, false );
	assert.ok( malformedLists.errors.some( ( error ) => error.code === 'uniformPlan.slots' ) );
	assert.ok( malformedLists.errors.some( ( error ) => error.code === 'uniformPlan.textures' ) );

} );

test( 'contract artifact validation rejects malformed internal-pass descriptors', () => {

	const result = validateArtifact( {
		materialShape: 'pmrem-equirect',
		vertexShader: 'v',
		fragmentShader: 'f',
		uniformPlan: [],
		internalPass: {
			schema: 'internal-pass@1',
			family: 'pmrem',
			stage: 'equirect',
			shape: 'pmrem-equirect',
			uniforms: [],
			inputs: [],
			output: { topology: { dimension: '2d', depth: false } },
		},
	}, { label: 'internal-pass fixture' } );

	assert.equal( result.ok, false );
	assert.ok( result.errors.some( ( error ) => error.code === 'internal-pass.input.required' ) );

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

test( 'contract validates PMREM scalar-to-atlas relations in every effective variant', () => {

	const pmremPlan = ( textureUuid ) => [ {
		name: 'object',
		slots: [
			{ source: { kind: 'pmrem.maxMip', textureUuid, valueSnapshot: { type: 'number', data: 5 } } },
		],
		textures: [
			{ source: { kind: 'artifact.texture', textureUuid, mapping: 306 } },
		],
	} ];
	const valid = {
		cacheKey: 'root',
		vertexShader: 'v',
		fragmentShader: 'f',
		uniformPlan: pmremPlan( 'root-atlas' ),
		variants: {
			child: {
				cacheKey: 'child',
				vertexShader: 'v-child',
				fragmentShader: 'f-child',
				uniformPlan: pmremPlan( 'child-atlas' ),
			},
		},
	};
	assert.equal( validateArtifact( valid ).ok, true );

	const invalid = structuredClone( valid );
	invalid.variants.child.uniformPlan[ 0 ].slots[ 0 ].source.textureUuid = 'wrong-atlas';
	const result = validateArtifact( invalid, { label: 'pmrem-family' } );
	assert.equal( result.ok, false );
	const relationError = result.errors.find( ( error ) => error.code === 'pmrem.uniform.texture-reference' );
	assert.equal(
		relationError.path,
		'variants.child.uniformPlan[0].slots[0].source.textureUuid',
	);
	assert.match( relationError.message, /same artifact variant/ );

} );

test( 'contract validates and preserves render binding ownership', () => {

	const mapSource = { kind: 'material.map', property: 'map' };
	const opacitySource = { kind: 'material.opacity', property: 'opacity', bindingOwner: 'render-material' };
	const shadow = {
		materialShape: 'shadow-depth',
		bindingOwner: 'shadow-caster',
		vertexShader: 'v',
		fragmentShader: 'f',
		uniformPlan: [ {
			name: 'object',
			slots: [ { source: opacitySource } ],
			textures: [ { source: mapSource } ],
		} ],
	};
	assert.equal( validateArtifact( shadow ).ok, true );
	assert.equal( createArtifactVariantPayload( shadow ).bindingOwner, 'shadow-caster' );
	assert.equal( createArtifactVariantPayload( shadow ).uniformPlan[ 0 ].slots[ 0 ].source.bindingOwner, 'render-material' );
	assert.equal( resolveArtifactSourceBindingOwner( shadow, mapSource ), RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER );
	assert.equal( resolveArtifactSourceBindingOwner( shadow, opacitySource ), RENDER_BINDING_OWNER_KINDS.MATERIAL );

	const wrongShape = validateArtifact( { ...shadow, materialShape: 'mesh-standard' } );
	assert.equal( wrongShape.ok, false );
	assert.equal( wrongShape.errors.find( ( error ) => error.code === 'artifact.bindingOwner.materialShape' ).path, 'bindingOwner' );

	const unknown = validateArtifact( { ...shadow, bindingOwner: 'captured-object' } );
	assert.equal( unknown.ok, false );
	assert.equal( unknown.errors.find( ( error ) => error.code === 'artifact.bindingOwner' ).path, 'bindingOwner' );

	const compute = validateArtifact( {
		kind: 'compute',
		computeShader: 'compute',
		bindingOwner: 'render-material',
		uniformPlan: [],
	} );
	assert.equal( compute.ok, false );
	assert.equal( compute.errors.find( ( error ) => error.code === 'artifact.bindingOwner.compute' ).path, 'bindingOwner' );

	const wrongSourceShape = validateArtifact( {
		...shadow,
		bindingOwner: 'render-material',
		materialShape: 'mesh-standard',
		uniformPlan: [ {
			name: 'object',
			slots: [ { source: { ...opacitySource, bindingOwner: 'shadow-caster' } } ],
		} ],
	} );
	assert.equal( wrongSourceShape.ok, false );
	assert.equal( wrongSourceShape.errors.find( ( error ) => error.code === 'source.bindingOwner.materialShape' ).path, 'uniformPlan[0].slots[0].source.bindingOwner' );

	assert.equal( validateDynamicBindingSource( { kind: 'material.opacity', property: 'opacity', bindingOwner: 'render-material' } ).length, 0 );
	assert.equal( validateDynamicBindingSource( { kind: 'camera.position', bindingOwner: 'render-material' } )[ 0 ].code, 'dynamic-binding.binding-owner-target' );
	assert.equal( validateDynamicBindingSource( { kind: 'material.opacity', property: 'opacity', bindingOwner: 'captured-object' } )[ 0 ].code, 'dynamic-binding.binding-owner' );

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

test( 'contract artifact validation checks comparison-sampler descriptors and convergence', () => {

	const artifact = {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'depthSampler', kind: 'sampler', comparison: true },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			textures: [ {
				name: 'depthSampler',
				bindingKind: 'sampler',
				comparison: true,
				source: { kind: 'unsupported' },
			} ],
		} ],
	};

	const valid = validateArtifact( artifact, { label: 'comparison-sampler' } );
	assert.equal( valid.ok, true, JSON.stringify( valid.errors ) );

	const invalidType = validateArtifact( {
		...artifact,
		bindings: [ {
			name: 'object',
			bindings: [ { name: 'depthSampler', kind: 'sampler', comparison: 'yes' } ],
		} ],
	}, { label: 'comparison-sampler-type' } );
	assert.equal( invalidType.ok, false );
	assert.ok( invalidType.errors.some( ( error ) => error.code === 'binding.comparison.type' ) );

	const invalidKind = validateArtifact( {
		...artifact,
		uniformPlan: [ {
			name: 'object',
			textures: [ {
				name: 'depthTexture',
				bindingKind: 'sampled-texture',
				comparison: false,
				source: { kind: 'unsupported' },
			} ],
		} ],
	}, { label: 'comparison-sampler-kind' } );
	assert.equal( invalidKind.ok, false );
	assert.ok( invalidKind.errors.some( ( error ) => error.code === 'uniformPlan.texture.comparison.kind' ) );

	const mismatch = validateArtifact( {
		...artifact,
		uniformPlan: [ {
			...artifact.uniformPlan[ 0 ],
			textures: [ { ...artifact.uniformPlan[ 0 ].textures[ 0 ], comparison: false } ],
		} ],
	}, { label: 'comparison-sampler-mismatch' } );
	assert.equal( mismatch.ok, false );
	assert.ok( mismatch.errors.some( ( error ) => error.code === 'binding.comparison.mismatch' ) );

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
	assert.ok( viewport.optional.includes( 'viewportIdentity' ) );
	assert.equal( VIEWPORT_TEXTURE_IDENTITY_SCHEMA, 'viewport-reference@1' );
	const validViewportIdentity = createViewportTextureIdentity( 'capture-reference' );
	assert.deepEqual( validateDynamicBindingSource( { kind: 'viewport.texture', viewportIdentity: validViewportIdentity } ), [] );
	for ( const viewportIdentity of [ null, '', 42, VIEWPORT_TEXTURE_IDENTITY_SCHEMA, 'viewport-reference@2#capture' ] ) {

		const error = validateDynamicBindingSource( { kind: 'viewport.texture', viewportIdentity } )[ 0 ];
		assert.equal( error.code, 'dynamic-binding.viewport-identity' );
		assert.equal( error.field, 'viewportIdentity' );

	}

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

	const invalidViewport = validateArtifact( {
		fragmentShader: 'var nodeTexture0: texture_2d<f32>;',
		uniformPlan: [ {
			name: 'material',
			textures: [ { name: 'nodeTexture0', source: { kind: 'viewport.texture', viewportIdentity: 'typo' } } ],
		} ],
	}, { label: 'viewport fixture' } );
	assert.equal( invalidViewport.ok, false );
	assert.equal( invalidViewport.errors.find( ( error ) => error.code === 'dynamic-binding.viewport-identity' ).path, 'uniformPlan[0].textures[0].source.viewportIdentity' );

} );

test( 'registerKind makes explicitly blocked custom vocabulary resolvable', () => {

	unregisterKind( 'custom.testFx' );
	assert.equal( isKnownKind( 'custom.testFx' ), false );
	const descriptor = registerKind( {
		kind: 'custom.testFx',
		status: 'blocked',
		reason: 'Install the custom effect adapter before capture.',
	} );
	assert.equal( descriptor.kind, 'custom.testFx' );
	assert.equal( isKnownKind( 'custom.testFx' ), true );
	assert.equal( isBlockedKind( 'custom.testFx' ), true );
	assert.equal( kindInfo( 'custom.testFx' ).status, 'blocked' );
	assert.equal( blockedKindReason( 'custom.testFx' ), 'Install the custom effect adapter before capture.' );
	assert.ok( listRegisteredKinds().some( ( e ) => e.kind === 'custom.testFx' ) );
	unregisterKind( 'custom.testFx' );

} );

test( 'registerKind is idempotent on identical descriptors and rejects conflicts', () => {

	unregisterKind( 'custom.idempotent' );
	const first = registerKind( { kind: 'custom.idempotent', status: 'blocked', reason: 'Adapter is not installed.' } );
	const second = registerKind( { kind: 'custom.idempotent', status: 'blocked', reason: 'Adapter is not installed.' } );
	assert.equal( first, second, 're-registering same descriptor returns the same frozen entry' );

	assert.throws( () => {

		registerKind( { kind: 'custom.idempotent', status: 'blocked', reason: 'Different recovery path.' } );

	}, /different descriptor/ );
	unregisterKind( 'custom.idempotent' );

} );

test( 'registerKind rejects malformed entries and built-in overrides', () => {

	assert.throws( () => registerKind( {} ), /entry\.kind/ );
	assert.throws( () => registerKind( { kind: 'custom.bad' } ), /entry\.status/ );
	assert.throws( () => registerKind( { kind: 'custom.bad', status: 'mystery' } ), /entry\.status must be one of/ );
	assert.throws( () => registerKind( { kind: 'custom.bad', status: 'blocked' } ), /entry\.reason/ );
	assert.throws( () => registerKind( { kind: 'custom.bad', status: 'codegen', codegen: 'user' } ), /entry\.status must be one of/ );
	assert.throws( () => registerKind( { kind: 'custom.bad', status: 'blocked', reason: 'No adapter.', runtime: 'user' } ), /cannot be installed/ );
	assert.throws( () => registerKind( { kind: 'material.color', status: 'blocked', reason: 'No.' } ), /built-in/ );
	assert.throws( () => registerKind( { kind: 'material.thirdPartyScalar', status: 'blocked', reason: 'No.' } ), /built-in/ );
	assert.throws( () => registerKind( { kind: 'object3d.thirdPartyScope', status: 'blocked', reason: 'No.' } ), /built-in/ );

} );

test( 'unregisterKind removes user entries; returns false for non-user kinds', () => {

	registerKind( { kind: 'custom.removable', status: 'blocked', reason: 'Test-only blocked vocabulary.' } );
	assert.equal( unregisterKind( 'custom.removable' ), true );
	assert.equal( unregisterKind( 'custom.removable' ), false, 'second unregister is a no-op' );
	assert.equal( unregisterKind( 'material.color' ), false, 'built-in cannot be unregistered' );
	assert.equal( isKnownKind( 'custom.removable' ), false );

} );

test( 'validateArtifact recognises a registered custom kind only as blocked vocabulary', () => {

	unregisterKind( 'custom.greenLight' );
	registerKind( { kind: 'custom.greenLight', status: 'blocked', reason: 'Custom light writer is not installed.' } );
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
	assert.equal( isBlockedKind( 'custom.greenLight' ), true );
	unregisterKind( 'custom.greenLight' );

} );
