import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateMaterialComputeDescriptor } from '@tsl-precompile/contract/material-compute';

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
		kernels: [ { id: 'kernel:0', artifact: validKernel() } ],
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
	descriptor.kernels.push( { id: 'kernel:1', artifact: { ...validKernel(), cacheKey: 2 } } );
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
