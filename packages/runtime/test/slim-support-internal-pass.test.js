import assert from 'node:assert/strict';
import test from 'node:test';

import {
	INTERNAL_PASS_FAMILY_REQUIREMENTS,
	INTERNAL_PASS_SHAPES,
	assertInternalPassArtifact,
	assertInternalPassFamilyStages,
	validateInternalPassDescriptor,
	validateInternalPassFamily,
	validateInternalPassFamilyStages,
} from '@tsl-precompile/contract/internal-pass';
import {
	createVSMSupportConfig,
	vsmMomentsTopology,
	vsmSourceInputTopology,
} from '@tsl-precompile/contract/vsm-config';
import { DepthTexture } from 'three/src/textures/DepthTexture.js';

import { hydrateNodeBuilderState } from '../src/hydrator.js';
import {
	bindInternalPassArtifact,
	createInternalPassMaterial,
} from '../src/slim-support/internal-pass.js';

function liveSlot( name, offset, dtype = 'number', sourceKind = 'uniform.live', property = null ) {

	return {
		name,
		offset,
		dtype,
		source: {
			kind: sourceKind,
			name,
			...( property ? { property } : {} ),
			valueSnapshot: {
				type: dtype === 'number' ? 'float' : dtype,
				data: dtype === 'vec2' ? [ 0, 0 ] : dtype === 'vec3' ? [ 0, 0, 0 ] : 0,
			},
		},
	};

}

function textureEntry( name, uuid, kind = 'artifact.texture' ) {

	return {
		name,
		bindingKind: 'sampled-texture',
		textureType: '2d',
		source: {
			kind,
			textureUuid: uuid,
			...( kind === 'depth.texture' ? {
				fromMaterialGraph: false,
				lightIndex: 0,
				lightUuid: 'captured-vsm-light',
			} : {} ),
		},
	};

}

function vsmDescriptor() {

	const config = createVSMSupportConfig();
	return {
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
		output: {
			topology: vsmMomentsTopology( config ),
		},
	};

}

function vsmMember( textureUuid ) {

	return {
		materialShape: 'shadow-vsm-vertical',
		vertexShader: 'vsm vertex',
		fragmentShader: '@group(1) @binding(0) var nodeUniform1: texture_depth_2d;\nvsm fragment',
		uniformPlan: [
			{
				name: 'render',
				slots: [
					liveSlot( 'nodeUniform0', 0, 'number', 'light.shadowBlurSamples', 'blurSamples' ),
					liveSlot( 'nodeUniform3', 4, 'number', 'light.shadowRadius', 'radius' ),
					liveSlot( 'nodeUniform4', 8, 'vec2', 'light.shadowMapSize', 'mapSize' ),
				],
				textures: [],
			},
			{
				name: 'object',
				slots: [],
				textures: [ textureEntry( 'nodeUniform1', textureUuid, 'depth.texture' ) ],
			},
		],
	};

}

function vsmArtifact() {

	return {
		...vsmMember( 'captured-depth-root' ),
		cacheKey: 'root',
		__hash: 'durable-vsm-hash',
		bindings: [ {
			name: 'render',
			bindings: [ { name: 'render', kind: 'uniform-buffer', visibility: 3, byteLength: 16 } ],
		}, {
			name: 'object',
			bindings: [ {
				name: 'nodeUniform1',
				kind: 'sampled-texture',
				visibility: 2,
				textureType: '2d',
				access: 'readOnly',
			} ],
		} ],
		internalPass: vsmDescriptor(),
		variants: {
			variant: {
				...vsmMember( 'captured-depth-variant' ),
				cacheKey: 'variant',
			},
		},
	};

}

function pmremBlurArtifact() {

	const replayConfig = {
		schema: 'pmrem-layout@1',
		cubeSize: 32,
		lodMax: 5,
		target: { width: 336, height: 128 },
	};
	const weights = {
		name: 'UniformBuffer_0',
		byteLength: 320,
		arrayType: 'Float32Array',
		valueSnapshot: new Array( 80 ).fill( 0 ),
	};
	return {
		materialShape: 'pmrem-blur',
		vertexShader: 'pmrem blur vertex',
		fragmentShader: 'pmrem blur fragment',
		__hash: 'durable-pmrem-hash',
		replayConfig,
		internalPass: {
			schema: 'internal-pass@1',
			family: 'pmrem',
			stage: 'blur',
			shape: 'pmrem-blur',
			config: {
				schema: 'pmrem-support@1',
				profile: 'scene',
				layout: replayConfig,
			},
			uniforms: [
				{ role: 'd-theta', group: 'object', binding: 'nodeUniform6', valueType: 'float' },
				{ role: 'latitudinal', group: 'object', binding: 'nodeUniform0', valueType: 'float' },
				{ role: 'mip-int', group: 'object', binding: 'nodeUniform3', valueType: 'float' },
				{ role: 'pole-axis', group: 'object', binding: 'nodeUniform1', valueType: 'vec3' },
				{ role: 'samples', group: 'object', binding: 'nodeUniform5', valueType: 'float' },
			],
			inputs: [
				{
					role: 'env-map',
					kind: 'texture',
					group: 'object',
					binding: 'nodeUniform4',
					topology: { dimension: '2d' },
				},
				{
					role: 'weights',
					kind: 'buffer',
					group: 'object',
					binding: 'UniformBuffer_0',
					topology: { byteLength: 320, arrayType: 'Float32Array' },
				},
			],
			output: { topology: { dimension: '2d', format: 1023, type: 1016, depth: false } },
		},
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'object', kind: 'uniform-buffer', visibility: 3, byteLength: 64 },
				{ name: 'UniformBuffer_0', kind: 'uniform-buffer', visibility: 3, byteLength: 320 },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			shared: true,
			byteLength: 64,
			slots: [
				liveSlot( 'nodeUniform0', 0 ),
				liveSlot( 'nodeUniform1', 16, 'vec3' ),
				liveSlot( 'nodeUniform3', 32 ),
				liveSlot( 'nodeUniform5', 36 ),
				liveSlot( 'nodeUniform6', 40 ),
			],
			textures: [ textureEntry( 'nodeUniform4', 'captured-pmrem-env' ) ],
			orderedBindings: [
				{ type: 'ubo' },
				{ type: 'buffer-uniform', ref: weights },
			],
		} ],
	};

}

function pmremGgxArtifact( replayConfig ) {

	return {
		materialShape: 'pmrem-ggx',
		vertexShader: 'pmrem ggx vertex',
		fragmentShader: 'pmrem ggx fragment',
		__hash: 'durable-pmrem-ggx-hash',
		replayConfig,
		internalPass: {
			schema: 'internal-pass@1',
			family: 'pmrem',
			stage: 'ggx',
			shape: 'pmrem-ggx',
			config: {
				schema: 'pmrem-support@1',
				profile: 'scene',
				layout: replayConfig,
			},
			uniforms: [
				{ role: 'roughness', group: 'object', binding: 'nodeUniform0', valueType: 'float' },
				{ role: 'mip-int', group: 'object', binding: 'nodeUniform1', valueType: 'float' },
			],
			inputs: [ {
				role: 'env-map',
				kind: 'texture',
				group: 'object',
				binding: 'nodeUniform2',
				topology: { dimension: '2d', format: 1023, type: 1016 },
			} ],
			output: { topology: { dimension: '2d', format: 1023, type: 1016, depth: false } },
		},
		uniformPlan: [ {
			name: 'object',
			slots: [
				liveSlot( 'nodeUniform0', 0 ),
				liveSlot( 'nodeUniform1', 4 ),
			],
			textures: [ textureEntry( 'nodeUniform2', 'captured-pmrem-ggx-env' ) ],
		} ],
	};

}

test( 'internal-pass contract publishes PMREM and VSM shapes and validates semantic addresses', () => {

	assert.deepEqual( INTERNAL_PASS_SHAPES, [
		'pmrem-cubemap',
		'pmrem-equirect',
		'pmrem-blur',
		'pmrem-ggx',
		'shadow-vsm-vertical',
		'shadow-vsm-horizontal',
	] );
	const vsm = vsmArtifact();
	assert.deepEqual( validateInternalPassDescriptor( vsm.internalPass, vsm ), [] );
	assert.equal( assertInternalPassArtifact( vsm ), vsm.internalPass );
	const pmrem = pmremBlurArtifact();
	assert.deepEqual( validateInternalPassDescriptor( pmrem.internalPass, pmrem ), [] );

} );

test( 'internal-pass family contract rejects incomplete and duplicate stage inventories', () => {

	assert.deepEqual( INTERNAL_PASS_FAMILY_REQUIREMENTS, {
		pmrem: {
			requiredStages: [ 'ggx' ],
			oneOfStages: [ 'cubemap', 'equirect', 'blur' ],
			requiredAuxiliaryShapes: [],
		},
		'shadow-vsm': {
			requiredStages: [ 'vertical', 'horizontal' ],
			oneOfStages: [],
			requiredAuxiliaryShapes: [ 'shadow-depth' ],
		},
	} );
	assert.deepEqual(
		validateInternalPassFamilyStages( 'pmrem', [ 'equirect', 'ggx' ] ),
		[],
	);
	assert.deepEqual(
		validateInternalPassFamilyStages( 'pmrem', [ 'blur', 'ggx' ] ),
		[],
	);
	assert.deepEqual(
		validateInternalPassFamilyStages(
			'pmrem',
			[ 'cubemap', 'ggx' ],
			{ profile: 'texture-cubemap' },
		),
		[],
	);
	assert.ok(
		validateInternalPassFamilyStages( 'pmrem', [ 'equirect' ] )
			.some( ( entry ) => entry.code === 'internal-pass.family.missing-stage' ),
	);
	assert.ok(
		validateInternalPassFamilyStages(
			'pmrem',
			[ 'equirect', 'blur', 'ggx' ],
			{ profile: 'texture-equirect' },
		).some( ( entry ) => entry.code === 'internal-pass.family.profile-stage' ),
		'profile-aware validation rejects a scene-only blur stage in a texture family',
	);
	const aliased = pmremBlurArtifact();
	aliased.internalPass.uniforms.find( ( uniform ) => uniform.role === 'mip-int' ).binding = 'nodeUniform0';
	assert.ok(
		validateInternalPassDescriptor( aliased.internalPass, aliased )
			.some( ( entry ) => entry.code === 'internal-pass.address-duplicate' ),
		'two semantic writes may not alias one captured uniform address',
	);
	assert.throws(
		() => assertInternalPassFamilyStages( 'shadow-vsm', [ 'vertical' ] ),
		( error ) => error?.code === 'TSLP_INTERNAL_PASS_FAMILY_INCOMPLETE' &&
			error.issues.some( ( entry ) => entry.message.includes( 'horizontal' ) ),
	);

	const vertical = vsmArtifact();
	assert.ok(
		validateInternalPassFamily( [ vertical ], { family: 'shadow-vsm' } )
			.some( ( entry ) => entry.code === 'internal-pass.family.missing-stage' ),
	);
	assert.ok(
		validateInternalPassFamily( [ vertical, vsmArtifact() ], { family: 'shadow-vsm' } )
			.some( ( entry ) => entry.code === 'internal-pass.family.duplicate-stage' ),
	);

} );

test( 'internal-pass family contract validates the scene blur-to-GGX atlas edge', () => {

	const blur = pmremBlurArtifact();
	const ggx = pmremGgxArtifact( blur.replayConfig );
	assert.deepEqual( validateInternalPassFamily( [ blur, ggx ], { family: 'pmrem' } ), [] );

	ggx.internalPass.inputs[ 0 ].topology.format = 1022;
	const issues = validateInternalPassFamily( [ blur, ggx ], { family: 'pmrem' } );
	assert.ok(
		issues.some( ( entry ) =>
			entry.code === 'internal-pass.family.edge-topology' &&
			entry.message.includes( 'PMREM scene blur output' )
		),
	);

} );

test( 'bindInternalPassArtifact isolates durable data and rebinds uniform and texture roles across variants', () => {

	const artifact = vsmArtifact();
	const durableBefore = JSON.stringify( artifact );
	let radius = 2;
	const depthA = { isTexture: true, isDepthTexture: true, uuid: 'live-depth-a' };
	const controller = bindInternalPassArtifact( artifact, {
		uniforms: {
			'blur-samples': 8,
			radius: () => radius,
			'map-size': { x: 32, y: 32 },
		},
		textures: { 'shadow-depth': depthA },
	} );

	assert.notEqual( controller.artifact, artifact );
	assert.equal( controller.artifact.__hash, artifact.__hash );
	assert.equal( JSON.stringify( artifact ), durableBefore );
	assert.equal( Object.prototype.hasOwnProperty.call( artifact, '_textureRefs' ), false );
	assert.equal( Object.prototype.hasOwnProperty.call( artifact.uniformPlan[ 0 ].slots[ 0 ], '_liveNode' ), false );

	const rootSlots = controller.artifact.uniformPlan[ 0 ].slots;
	const variantSlots = controller.artifact.variants.variant.uniformPlan[ 0 ].slots;
	assert.equal( rootSlots[ 0 ]._liveNode.value, 8 );
	assert.equal( rootSlots[ 1 ]._liveNode.value, 2 );
	assert.deepEqual( rootSlots[ 2 ]._liveNode.value, { x: 32, y: 32 } );
	assert.equal( variantSlots[ 1 ]._liveNode, rootSlots[ 1 ]._liveNode, 'one semantic resolver owns every family member' );
	radius = 4;
	assert.equal( variantSlots[ 1 ]._liveNode.value, 4 );

	assert.equal( controller.artifact._textureRefs.get( 'captured-depth-root' ), depthA );
	assert.equal( controller.artifact._textureRefs.get( 'captured-depth-variant' ), depthA );

	const state = hydrateNodeBuilderState( controller.artifact, { name: 'VSM vertical replay' } );
	const renderBuffer = state.bindings[ 0 ].bindings.find( ( binding ) => binding.name === 'render' );
	assert.ok( renderBuffer );
	const depthBinding = state.bindings
		.flatMap( ( group ) => group.bindings || [] )
		.find( ( binding ) => binding.name === 'nodeUniform1' );
	assert.equal( depthBinding.texture, depthA,
		'binder-owned light depth is authoritative during initial hydration' );
	const uniformUpdater = state.updateNodes.at( -1 );
	uniformUpdater.update( { material: null } );
	assert.deepEqual( Array.from( renderBuffer.buffer.slice( 0, 4 ) ), [ 8, 4, 32, 32 ],
		'internal-pass sidecars override captured light.* slots without a live LightShadow' );
	controller.setUniform( 'radius', 6 );
	controller.setUniform( 'map-size', { x: 64, y: 16 } );
	uniformUpdater.update( { material: null } );
	assert.deepEqual( Array.from( renderBuffer.buffer.slice( 0, 4 ) ), [ 8, 6, 64, 16 ] );
	const depthB = new DepthTexture( 64, 64 );
	depthB.name = 'live-depth-b';
	depthB.compareFunction = null;
	const depthVersion = depthB.version;
	controller.setTexture( 'shadow-depth', depthB );
	assert.equal( controller.artifact._textureRefs.get( 'captured-depth-root' ), depthB );
	assert.equal( controller.artifact._textureRefs.get( 'captured-depth-variant' ), depthB );
	state.updateBeforeNodes[ 0 ].updateBefore( { scene: null, renderer: null } );
	assert.equal( depthBinding.texture, depthB,
		'binder-owned light depth remains authoritative in the per-frame shadow rebinder' );
	assert.equal( depthB.compareFunction, null,
		'internal-pass topology keeps VSM source depth non-comparison' );
	assert.equal( depthB.version, depthVersion,
		'internal-pass rebinding does not request destructive GPU recreation' );

	const generatedSource = vsmArtifact();
	generatedSource._generatedUpdateGroup = ( _frame, _material, view ) => {

		for ( let offset = 0; offset < 16; offset += 4 ) view.setFloat32( offset, -1, true );

	};
	const generatedController = bindInternalPassArtifact( generatedSource, {
		uniforms: {
			'blur-samples': 12,
			radius: 3,
			'map-size': { x: 128, y: 64 },
		},
	} );
	assert.equal( generatedController.artifact._generatedUpdateGroup, generatedSource._generatedUpdateGroup );
	const generatedState = hydrateNodeBuilderState( generatedController.artifact, { name: 'Generated VSM replay' } );
	generatedState.updateNodes.at( -1 ).update( { material: null } );
	const generatedBuffer = generatedState.bindings[ 0 ].bindings.find( ( binding ) => binding.name === 'render' );
	assert.deepEqual( Array.from( generatedBuffer.buffer.slice( 0, 4 ) ), [ 12, 3, 128, 64 ],
		'internal-pass sidecars override the generated updater for semantic light.* slots' );

	assert.throws(
		() => controller.setUniform( 'unknown-role', 1 ),
		( error ) => error && error.code === 'TSLP_INTERNAL_PASS_ROLE_UNKNOWN',
	);

} );

test( 'buffer role accepts the captured Float32Array topology and refreshes a packed UBO after hydration', () => {

	const artifact = pmremBlurArtifact();
	const weights = Float32Array.from( { length: 20 }, ( _, index ) => index + 1 );
	const envMap = { isTexture: true, uuid: 'live-env-map' };
	const controller = bindInternalPassArtifact( artifact, {
		uniforms: {
			'd-theta': 0.1,
			latitudinal: 1,
			'mip-int': 5,
			'pole-axis': { x: 0, y: 1, z: 0 },
			samples: 20,
		},
		textures: { 'env-map': envMap },
		buffers: { weights },
	} );
	const weightsRef = controller.artifact.uniformPlan[ 0 ].orderedBindings[ 1 ].ref;
	assert.equal( weightsRef._liveArray.length, 80 );
	for ( let index = 0; index < 20; index ++ ) {

		assert.equal( weightsRef._liveArray[ index * 4 ], index + 1 );
		assert.deepEqual( Array.from( weightsRef._liveArray.slice( index * 4 + 1, index * 4 + 4 ) ), [ 0, 0, 0 ] );

	}

	const material = { name: 'PMREM blur replay' };
	const state = hydrateNodeBuilderState( controller.artifact, material );
	const liveBuffer = state.bindings[ 0 ].bindings.find( ( binding ) => binding.name === 'UniformBuffer_0' );
	assert.ok( liveBuffer );
	assert.equal( liveBuffer.buffer[ 0 ], 1 );
	assert.equal( liveBuffer.buffer[ 4 ], 2 );

	controller.setBuffer( 'weights', new Float32Array( 20 ).fill( 0.25 ) );
	assert.equal( liveBuffer.update(), true );
	assert.equal( liveBuffer.buffer[ 0 ], 0.25 );
	assert.equal( liveBuffer.buffer[ 4 ], 0.25 );
	assert.equal( liveBuffer.buffer[ 1 ], 0 );
	assert.throws(
		() => controller.setBuffer( 'weights', new Float32Array( 10 ) ),
		( error ) => error && error.code === 'TSLP_INTERNAL_PASS_BUFFER_LENGTH_MISMATCH',
		'compact buffer topology must not infer an arbitrary stride from any divisor',
	);

} );

test( 'createInternalPassMaterial injects a replay material and invalid descriptors fail closed', () => {

	class FakePrecompiledMaterial {

		constructor( artifact ) {

			this.precompiledArtifact = artifact;

		}

	}

	const controller = createInternalPassMaterial( vsmArtifact(), {}, {
		PrecompiledMaterial: FakePrecompiledMaterial,
	} );
	assert.ok( controller.material instanceof FakePrecompiledMaterial );
	assert.equal( controller.material.name, 'shadow-vsm-vertical' );
	assert.equal( controller.material.precompiledArtifact, controller.artifact );

	const malformed = vsmArtifact();
	malformed.internalPass.inputs[ 0 ].binding = 'missingBinding';
	const issues = validateInternalPassDescriptor( malformed.internalPass, malformed );
	assert.ok( issues.some( ( entry ) => entry.code === 'internal-pass.texture.address' ) );
	assert.throws(
		() => bindInternalPassArtifact( malformed ),
		( error ) => error && error.code === 'TSLP_INTERNAL_PASS_ARTIFACT_INVALID' &&
			error.details.issues.some( ( entry ) => entry.code === 'internal-pass.texture.address' ),
	);

	const wrongVsmSource = vsmArtifact();
	wrongVsmSource.uniformPlan[ 0 ].slots[ 0 ].source.kind = 'uniform.live';
	assert.ok( validateInternalPassDescriptor( wrongVsmSource.internalPass, wrongVsmSource )
		.some( ( entry ) => entry.code === 'internal-pass.uniform.source-kind' ) );

	const invalidBuffer = pmremBlurArtifact();
	invalidBuffer.internalPass.inputs[ 1 ].topology.arrayType = 'Uint8Array';
	assert.ok( validateInternalPassDescriptor( invalidBuffer.internalPass, invalidBuffer )
		.some( ( entry ) => entry.code === 'internal-pass.buffer.array-type' ) );

} );
