import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inspectMaterialComputeFamily, validateMaterialComputeDescriptor } from '@tsl-precompile/contract/material-compute';

function storagePlanEntry( overrides = {} ) {

	return {
		arrayType: 'Float32Array',
		count: 1,
		itemSize: 4,
		access: 'readWrite',
		...overrides,
	};

}

function storageGroup( overrides = {} ) {

	const ref = storagePlanEntry( overrides );
	return {
		name: 'compute',
		slots: [],
		textures: [],
		storageBuffers: [ ref ],
		orderedBindings: [ { type: 'storage-buffer', ref } ],
	};

}

function storageBindingDescriptor( overrides = {} ) {

	return {
		name: 'positions',
		kind: 'storage-buffer',
		visibility: 4,
		textureType: null,
		byteLength: 16,
		access: 'readWrite',
		...overrides,
	};

}

function validOwner() {

	return {
		attributes: [ {
			name: 'graphPosition',
			type: 'vec4',
			source: 'node',
			storage: true,
			arrayType: 'Float32Array',
			count: 1,
			itemSize: 4,
			arraySnapshot: [ 1, 2, 3, 4 ],
		} ],
		bindings: [ { name: 'render', bindings: [ storageBindingDescriptor( { visibility: 3 } ) ] } ],
		uniformPlan: [ storageGroup() ],
		meta: { updateBeforeNodes: 1 },
	};

}

function validKernel() {

	return {
		version: 3,
		kind: 'compute',
		cacheKey: 1,
		name: 'advance',
		computeShader: '@compute @workgroup_size( 1 ) fn main() {}',
		vertexShader: '',
		fragmentShader: '',
		attributes: [],
		bindings: [ { name: 'compute', bindings: [ storageBindingDescriptor() ] } ],
		uniformPlan: [ storageGroup() ],
		defaults: {},
		dispatchSize: 1,
		workgroupSize: [ 1, 1, 1 ],
		meta: { updateNodes: 0, updateBeforeNodes: 0, updateAfterNodes: 0 },
	};

}

function validDescriptor() {

	return {
		version: 'material-compute@1',
		mode: 'precompiled',
		reasons: [],
		resources: [ {
			id: 'resource:0',
			kind: 'storage-buffer',
			arrayType: 'Float32Array',
			count: 1,
			itemSize: 4,
			byteLength: 16,
		} ],
		kernels: [ { id: 'kernel:0', nodePath: [ 'positionNode' ], updates: [], artifact: validKernel() } ],
		bindings: [ {
			kernel: 'kernel:0',
			resource: 'resource:0',
			group: 0,
			binding: 0,
			access: 'readWrite',
		} ],
		renderBindings: [
			{ resource: 'resource:0', kind: 'attribute', attribute: 0 },
			{ resource: 'resource:0', kind: 'storage-buffer', group: 0, binding: 0 },
		],
		schedule: [ {
			kernel: 'kernel:0',
			phase: 'update-before',
			order: 0,
			updateType: 'object',
		} ],
	};

}

function validStorageTextureFixture( access = 'writeOnly' ) {

	const textureRef = {
		name: 'positionsTexture',
		bindingKind: 'sampled-texture',
		textureType: '2d',
		access,
		visibility: 4,
		source: { kind: 'unsupported' },
	};
	const textureBinding = {
		name: 'positionsTexture',
		kind: 'sampled-texture',
		visibility: 4,
		textureType: '2d',
		byteLength: null,
		access,
		store: true,
	};
	const textureGroup = {
		name: 'compute',
		slots: [],
		textures: [ textureRef ],
		storageBuffers: [],
		orderedBindings: [ { type: 'sampled-texture', ref: textureRef } ],
	};
	const descriptor = validDescriptor();
	descriptor.mode = 'hybrid-required';
	descriptor.reasons = [ 'resource:0:storage-texture' ];
	descriptor.resources = [ { id: 'resource:0', kind: 'storage-texture', textureType: '2d' } ];
	descriptor.bindings[ 0 ].access = access;
	descriptor.kernels[ 0 ].artifact.bindings = [ { name: 'compute', bindings: [ textureBinding ] } ];
	descriptor.kernels[ 0 ].artifact.uniformPlan = [ textureGroup ];
	descriptor.renderBindings = [ { resource: 'resource:0', kind: 'storage-texture', group: 0, binding: 0 } ];

	return {
		descriptor,
		owner: {
			attributes: [],
			bindings: [ { name: 'render', bindings: [ { ...textureBinding, visibility: 3 } ] } ],
			uniformPlan: [ textureGroup ],
			meta: { updateBeforeNodes: 1 },
		},
	};

}

test( 'material-compute contract accepts one exact owner-local storage topology', () => {

	assert.deepEqual( validateMaterialComputeDescriptor( validDescriptor(), { artifact: validOwner() } ), [] );

} );

test( 'precompiled material-compute requires complete compute and render ownership', () => {

	const descriptor = validDescriptor();
	descriptor.resources = [];
	descriptor.bindings = [];
	descriptor.renderBindings = [];
	const errors = validateMaterialComputeDescriptor( descriptor, { artifact: validOwner() } );

	assert.ok( errors.some( ( error ) => error.code === 'material-compute.mode.compute-binding' ) );

} );

test( 'material-compute metadata and access must match both compute and render plans', () => {

	const descriptor = validDescriptor();
	delete descriptor.reasons;
	descriptor.resources[ 0 ] = {
		...descriptor.resources[ 0 ],
		arrayType: '',
		count: - 1,
		itemSize: 0,
		byteLength: '16',
	};
	descriptor.bindings[ 0 ] = { ...descriptor.bindings[ 0 ], access: 'fabricated' };
	const owner = validOwner();
	owner.attributes[ 0 ].storage = false;
	const errors = validateMaterialComputeDescriptor( descriptor, { artifact: owner } );
	const codes = new Set( errors.map( ( error ) => error.code ) );

	for ( const code of [
		'material-compute.reasons',
		'material-compute.resource.array-type',
		'material-compute.resource.count',
		'material-compute.resource.item-size',
		'material-compute.resource.byte-length',
		'material-compute.binding.access',
		'material-compute.render-binding.attribute-storage',
	] ) assert.ok( codes.has( code ), `missing ${ code }` );

} );

test( 'material-compute rejects conflicting locations and non-unique schedule order', () => {

	const descriptor = validDescriptor();
	descriptor.resources.push( { ...descriptor.resources[ 0 ], id: 'resource:1' } );
	descriptor.kernels.push( { id: 'kernel:1', nodePath: [ 'colorNode' ], updates: [], artifact: { ...validKernel(), cacheKey: 2 } } );
	descriptor.bindings.push( { ...descriptor.bindings[ 0 ], resource: 'resource:1' } );
	descriptor.renderBindings.push( { resource: 'resource:1', kind: 'attribute', attribute: 0 } );
	descriptor.schedule.push( { ...descriptor.schedule[ 0 ], kernel: 'kernel:1' } );
	const codes = new Set( validateMaterialComputeDescriptor( descriptor, { artifact: validOwner() } ).map( ( error ) => error.code ) );

	assert.ok( codes.has( 'material-compute.binding.location-duplicate' ) );
	assert.ok( codes.has( 'material-compute.render-binding.location-duplicate' ) );
	assert.ok( codes.has( 'material-compute.schedule.duplicate' ) );
	assert.ok( codes.has( 'material-compute.schedule.order' ) );

} );

test( 'hybrid storage-texture evidence cannot point at an ordinary sampled binding', () => {

	const descriptor = validDescriptor();
	descriptor.mode = 'hybrid-required';
	descriptor.reasons = [ 'resource:0:storage-texture' ];
	descriptor.resources[ 0 ] = { id: 'resource:0', kind: 'storage-texture', textureType: '2d' };
	descriptor.kernels[ 0 ].artifact.bindings[ 0 ].bindings[ 0 ] = {
		...storageBindingDescriptor(),
		kind: 'sampled-texture',
		store: false,
	};
	descriptor.bindings[ 0 ].access = 'writeOnly';
	descriptor.renderBindings = [ { resource: 'resource:0', kind: 'storage-texture', group: 0, binding: 0 } ];
	const codes = new Set( validateMaterialComputeDescriptor( descriptor, {
		artifact: {
			bindings: [ { bindings: [ { kind: 'sampled-texture', store: false } ] } ],
			uniformPlan: [ { orderedBindings: [ { type: 'sampled-texture', ref: {} } ] } ],
		},
	} ).map( ( error ) => error.code ) );

	assert.ok( codes.has( 'material-compute.binding.kind' ) );
	assert.ok( codes.has( 'material-compute.render-binding.descriptor-kind' ) );

} );

test( 'storage-texture ownership requires exact nested access evidence', () => {

	for ( const access of [ 'readOnly', 'writeOnly', 'readWrite' ] ) {

		const { descriptor, owner } = validStorageTextureFixture( access );
		assert.deepEqual( validateMaterialComputeDescriptor( descriptor, { artifact: owner } ), [], `${ access } access is exact` );

	}

	const mismatched = validStorageTextureFixture( 'readOnly' );
	mismatched.descriptor.bindings[ 0 ].access = 'writeOnly';
	assert.ok( validateMaterialComputeDescriptor( mismatched.descriptor, { artifact: mismatched.owner } )
		.some( ( error ) => error.code === 'material-compute.binding.access-mismatch' ) );

	const missing = validStorageTextureFixture( 'writeOnly' );
	missing.descriptor.kernels[ 0 ].artifact.bindings[ 0 ].bindings[ 0 ].access = null;
	assert.ok( validateMaterialComputeDescriptor( missing.descriptor, { artifact: missing.owner } )
		.some( ( error ) => error.code === 'material-compute.binding.access-unproven' ) );

} );

test( 'precompiled mode requires serialized initial bytes and a complete update-before schedule', () => {

	const descriptor = validDescriptor();
	descriptor.schedule[ 0 ].order = 1;
	const owner = validOwner();
	delete owner.attributes[ 0 ].arraySnapshot;
	const codes = new Set( validateMaterialComputeDescriptor( descriptor, { artifact: owner } ).map( ( error ) => error.code ) );

	assert.ok( codes.has( 'material-compute.mode.initial-state' ) );
	assert.ok( codes.has( 'material-compute.mode.schedule-topology' ) );

} );

test( 'precompiled mode rejects unresolved dynamic compute uniforms', () => {

	const descriptor = validDescriptor();
	descriptor.kernels[ 0 ].artifact.uniformPlan[ 0 ].slots.push( {
		name: 'speed',
		source: { kind: 'uniform.live', liveNodeId: 0 },
	} );
	const errors = validateMaterialComputeDescriptor( descriptor, { artifact: validOwner() } );

	assert.ok( errors.some( ( error ) => error.code === 'material-compute.mode.live-uniform' ) );

} );

test( 'precompiled mode requires exact nested kernel lifecycle coverage', () => {

	const descriptor = validDescriptor();
	descriptor.kernels[ 0 ].artifact.meta.updateNodes = 1;
	const errors = validateMaterialComputeDescriptor( descriptor, { artifact: validOwner() } );

	assert.ok( errors.some( ( error ) => error.code === 'material-compute.mode.kernel-update-coverage' ) );

} );

test( 'material-compute family inspection requires uniform descriptors and initial state', () => {

	const variantA = { ...validOwner(), cacheKey: 'a', materialCompute: validDescriptor() };
	const variantB = JSON.parse( JSON.stringify( { ...validOwner(), cacheKey: 'b', materialCompute: validDescriptor() } ) );
	const family = { ...variantA, variants: { a: variantA, b: variantB } };
	const uniform = inspectMaterialComputeFamily( family );

	assert.equal( uniform.status, 'uniform' );
	assert.equal( uniform.descriptor.mode, 'precompiled' );
	assert.equal( typeof uniform.fingerprint, 'string' );

	variantB.attributes[ 0 ].arraySnapshot[ 0 ] = 99;
	const divergent = inspectMaterialComputeFamily( family );
	assert.equal( divergent.status, 'divergent' );
	assert.equal( divergent.reason, 'non-uniform-family' );

	variantB.attributes[ 0 ].arraySnapshot[ 0 ] = 1;
	variantB.attributes[ 0 ].instanced = true;
	const resourceMetadataDivergence = inspectMaterialComputeFamily( family );
	assert.equal( resourceMetadataDivergence.status, 'divergent' );
	assert.equal( resourceMetadataDivergence.reason, 'non-uniform-family' );

} );

test( 'material-compute family inspection rejects partial variant coverage', () => {

	const variantA = { ...validOwner(), cacheKey: 'a', materialCompute: validDescriptor() };
	const variantB = { ...validOwner(), cacheKey: 'b' };
	const inspection = inspectMaterialComputeFamily( { ...variantA, variants: { a: variantA, b: variantB } } );

	assert.equal( inspection.status, 'divergent' );
	assert.equal( inspection.reason, 'partial-family' );

} );
