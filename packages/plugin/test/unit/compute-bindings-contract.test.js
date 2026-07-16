import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	COMPUTE_BINDINGS_VERSION,
	COMPUTE_BINDING_TARGETS,
	validateComputeBindingsDescriptor,
} from '@tsl-precompile/contract/compute-bindings';
import { COMPUTE_BINDINGS_VERSION as ROOT_COMPUTE_BINDINGS_VERSION } from '@tsl-precompile/contract';
import { validateArtifact } from '@tsl-precompile/contract/kinds';

function validArtifact() {

	const storage = {
		name: 'positions',
		access: 'readWrite',
		arrayType: 'Float32Array',
		count: 1,
		itemSize: 4,
	};
	const output = {
		name: 'output',
		bindingKind: 'sampled-texture',
		textureType: '2d',
		access: 'writeOnly',
	};
	const input = {
		name: 'input',
		bindingKind: 'sampled-texture',
		textureType: '2d',
	};
	const sampler = {
		name: 'inputSampler',
		bindingKind: 'sampler',
		textureType: 'unknown',
	};
	const threshold = {
		name: 'threshold',
		offset: 0,
		size: 4,
		dtype: 'number',
		source: { kind: 'uniform.live', nodePath: [ 'threshold' ] },
	};
	return {
		kind: 'compute',
		computeShader: '@compute @workgroup_size( 1 ) fn main() {}',
		bindings: [ {
			name: 'compute',
			bindings: [
				{ name: 'positions', kind: 'storage-buffer', access: 'readWrite', byteLength: 16 },
				{ name: 'output', kind: 'sampled-texture', store: true, access: 'writeOnly', textureType: '2d', byteLength: null },
				{ name: 'input', kind: 'sampled-texture', store: false, access: null, textureType: '2d', byteLength: null },
				{ name: 'inputSampler', kind: 'sampler', byteLength: null },
				{ name: 'compute', kind: 'uniform-buffer', byteLength: 16 },
			],
		} ],
		uniformPlan: [ {
			name: 'compute',
			slots: [ threshold ],
			textures: [ output, input, sampler ],
			storageBuffers: [ storage ],
			orderedBindings: [
				{ type: 'storage-buffer', ref: storage },
				{ type: 'sampled-texture', ref: output },
				{ type: 'sampled-texture', ref: input },
				{ type: 'sampler', ref: sampler },
				{ type: 'ubo', name: 'compute', slots: [ threshold ] },
			],
		} ],
	};

}

function validDescriptor() {

	return {
		version: 'compute-bindings@1',
		entries: [
			{ key: 'input', target: 'sampled-texture', group: 0, binding: 2, textureType: '2d' },
			{ key: 'input', target: 'sampler', group: 0, binding: 3 },
			{ key: 'output', target: 'storage-texture', group: 0, binding: 1, access: 'writeOnly', textureType: '2d' },
			{ key: 'positions', target: 'storage-buffer', group: 0, binding: 0, access: 'readWrite', arrayType: 'Float32Array', count: 1, itemSize: 4, byteLength: 16 },
			{ key: 'threshold', target: 'uniform-slot', group: 0, slot: 0, dtype: 'number' },
		],
	};

}

test( 'compute-bindings contract exports the versioned standalone input vocabulary', () => {

	assert.equal( COMPUTE_BINDINGS_VERSION, 'compute-bindings@1' );
	assert.equal( ROOT_COMPUTE_BINDINGS_VERSION, COMPUTE_BINDINGS_VERSION );
	assert.deepEqual( COMPUTE_BINDING_TARGETS, [
		'storage-buffer',
		'storage-texture',
		'sampled-texture',
		'sampler',
		'uniform-slot',
	] );

} );

test( 'compute-bindings accepts exact storage, texture, sampler, and uniform locations', () => {

	const artifact = validArtifact();
	artifact.computeBindings = validDescriptor();

	assert.deepEqual( validateComputeBindingsDescriptor( artifact.computeBindings, { artifact } ), [] );
	assert.equal( validateArtifact( artifact ).ok, true );

} );

test( 'compute-bindings rejects ambiguous keys, locations, and non-canonical order', () => {

	const descriptor = validDescriptor();
	descriptor.entries = [
		descriptor.entries[ 4 ],
		{ ...descriptor.entries[ 3 ], key: '__proto__' },
		{ ...descriptor.entries[ 3 ], key: 'positionsAgain' },
	];
	const codes = new Set( validateComputeBindingsDescriptor( descriptor ).map( ( error ) => error.code ) );

	assert.ok( codes.has( 'compute-bindings.entries.order' ) );
	assert.ok( codes.has( 'compute-bindings.entry.key' ) );
	assert.ok( codes.has( 'compute-bindings.entries.location-duplicate' ) );

} );

test( 'artifact validation rejects render ownership and mismatched compute locations', () => {

	const render = validArtifact();
	delete render.kind;
	delete render.computeShader;
	render.vertexShader = 'vertex';
	render.fragmentShader = 'fragment';
	render.computeBindings = validDescriptor();
	assert.ok( validateArtifact( render ).errors.some( ( error ) => error.code === 'compute-bindings.owner' ) );

	const compute = validArtifact();
	compute.computeBindings = validDescriptor();
	compute.computeBindings.entries[ 0 ].binding = 3;
	const error = validateArtifact( compute ).errors.find( ( item ) => item.code === 'compute-bindings.artifact.kind' );
	assert.equal( error.path, 'computeBindings.entries[0]' );

} );
