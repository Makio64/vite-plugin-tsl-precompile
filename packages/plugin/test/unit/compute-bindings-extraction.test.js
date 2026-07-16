import test from 'node:test';
import assert from 'node:assert/strict';

import StorageBuffer from 'three/src/renderers/common/StorageBuffer.js';
import StorageBufferAttribute from 'three/src/renderers/common/StorageBufferAttribute.js';
import WebGPUAttributeUtils from 'three/src/renderers/webgpu/utils/WebGPUAttributeUtils.js';
import { createArtifactVariantPayload } from '@tsl-precompile/contract/artifact-variants';
import { validateArtifact } from '@tsl-precompile/contract/kinds';
import { deriveComputeBindingsDescriptor } from '../../src/compute-bindings.js';
import {
	compileTSL,
	deriveComputeBindingsDescriptor as deriveComputeBindingsFromExtractor,
	extractComputeArtifact,
} from '../../src/vendor/compileTSL.js';

function uniformBinding( node ) {

	return {
		name: 'compute',
		isUniformBuffer: true,
		isUniformsGroup: true,
		byteLength: 16,
		visibility: 4,
		groupNode: { shared: false },
		uniforms: [ {
			isNumberUniform: true,
			name: 'nodeUniform0',
			offset: 0,
			itemSize: 1,
			nodeUniform: { node },
			getType() { return 'float'; },
			getValue() { return node.value; },
		} ],
	};

}

function fixture( { sharedTexture = false, duplicateSampled = false } = {} ) {

	const positions = {
		isBufferAttribute: true,
		isStorageBufferAttribute: true,
		array: new Float32Array( [ 1, 2, 3, 4 ] ),
		count: 1,
		itemSize: 4,
	};
	const positionsNode = { isNode: true, value: positions, access: 'readWrite' };
	const threshold = {
		isNode: true,
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'float',
		value: 0.5,
	};
	const output = { isTexture: true, isStorageTexture: true, uuid: 'output-texture' };
	const input = sharedTexture ? output : { isTexture: true, uuid: 'input-texture' };
	const outputNode = { isNode: true, value: output };
	const inputNode = { isNode: true, value: input };
	const groupNode = { shared: false };
	const bindings = [
		{
			name: 'positions',
			isStorageBuffer: true,
			visibility: 4,
			access: 'readWrite',
			attribute: positions,
			nodeUniform: positionsNode,
			groupNode,
		},
		{
			name: 'output',
			isSampledTexture: true,
			store: true,
			visibility: 4,
			access: 'writeOnly',
			texture: output,
			textureNode: outputNode,
			groupNode,
		},
		{
			name: 'input_sampler',
			isSampler: true,
			visibility: 4,
			texture: input,
			textureNode: inputNode,
			groupNode,
		},
		{
			name: 'input',
			isSampledTexture: true,
			visibility: 4,
			texture: input,
			textureNode: inputNode,
			groupNode,
		},
	];
	if ( duplicateSampled ) bindings.push( {
		name: 'input_duplicate',
		isSampledTexture: true,
		visibility: 4,
		texture: input,
		textureNode: { isNode: true, value: input },
		groupNode,
	} );
	bindings.push( uniformBinding( threshold ) );

	const state = {
		computeShader: '@compute @workgroup_size( 1 ) fn main() {}',
		vertexShader: '',
		fragmentShader: '',
		nodeAttributes: [],
		bindings: [ { name: 'compute', bindings } ],
		updateNodes: [],
		updateBeforeNodes: [],
		updateAfterNodes: [],
	};
	const node = {
		isNode: true,
		isComputeNode: true,
		name: 'advance',
		count: 1,
		workgroupSize: [ 1 ],
	};
	return {
		state,
		node,
		positions,
		positionsNode,
		threshold,
		output,
		outputNode,
		input,
		inputNode,
	};

}

test( 'extractComputeArtifact derives exact public entries from live resource identities', () => {

	const values = fixture();
	const publicResources = {
		positions: values.positions,
		threshold: values.threshold,
		output: values.output,
		input: values.input,
	};
	const artifact = extractComputeArtifact( 1, values.state, values.node, publicResources );

	assert.deepEqual( artifact.computeBindings, {
		version: 'compute-bindings@1',
		entries: [
			{ key: 'input', target: 'sampled-texture', group: 0, binding: 3, textureType: '2d' },
			{ key: 'input', target: 'sampler', group: 0, binding: 2 },
			{ key: 'output', target: 'storage-texture', group: 0, binding: 1, access: 'writeOnly', textureType: '2d' },
			{ key: 'positions', target: 'storage-buffer', group: 0, binding: 0, access: 'readWrite', arrayType: 'Float32Array', count: 1, itemSize: 4, byteLength: 16 },
			{ key: 'threshold', target: 'uniform-slot', group: 0, slot: 0, dtype: 'number' },
		],
	} );
	assert.equal( artifact.bindings[ 0 ].bindings[ 0 ].byteLength, 16 );
	assert.equal( validateArtifact( artifact ).ok, true );
	assert.equal( createArtifactVariantPayload( artifact ).computeBindings, artifact.computeBindings );
	assert.equal( deriveComputeBindingsFromExtractor, deriveComputeBindingsDescriptor );

} );

test( 'one exact texture identity may expose storage, sampled, and sampler targets', () => {

	const values = fixture( { sharedTexture: true } );
	const artifact = extractComputeArtifact( 1, values.state, values.node );
	const descriptor = deriveComputeBindingsDescriptor( artifact, values.state, new Map( [ [ 'shared', values.output ] ] ) );

	assert.deepEqual( descriptor.entries.map( ( entry ) => [ entry.target, entry.binding ] ), [
		[ 'storage-texture', 1 ],
		[ 'sampled-texture', 3 ],
		[ 'sampler', 2 ],
	] );

} );

test( 'storage byte length prefers Three WebGPU\'s live padded attribute allocation', () => {

	const values = fixture();
	const attribute = new StorageBufferAttribute( new Float32Array( 512 * 3 ), 3 );
	const binding = new StorageBuffer( 'positions', attribute );
	binding.visibility = 4;
	binding.access = 'readWrite';
	binding.nodeUniform = { isNode: true, value: attribute, access: 'readWrite' };
	binding.groupNode = { shared: false };
	values.state.bindings[ 0 ].bindings[ 0 ] = binding;

	const backendData = new WeakMap();
	const attributeUtils = new WebGPUAttributeUtils( {
		device: {
			createBuffer( { size } ) {

				const mapped = new ArrayBuffer( size );
				return { getMappedRange: () => mapped, unmap() {} };

			},
		},
		get( object ) {

			let data = backendData.get( object );
			if ( ! data ) backendData.set( object, data = {} );
			return data;

		},
	} );
	attributeUtils.createAttribute( attribute, 0 );

	assert.equal( binding.byteLength, 6144, 'Three binding retains its pre-padding buffer' );
	assert.equal( attribute.array.byteLength, 8192, 'WebGPUAttributeUtils pads vec3 storage to vec4' );
	const artifact = extractComputeArtifact( 1, values.state, values.node, { positions: attribute } );
	assert.equal( artifact.bindings[ 0 ].bindings[ 0 ].byteLength, 8192 );
	assert.equal( artifact.computeBindings.entries[ 0 ].byteLength, 8192 );

} );

test( 'compute binding derivation fails closed on unmatched and ambiguous public keys', () => {

	const values = fixture();
	const artifact = extractComputeArtifact( 1, values.state, values.node );
	assert.throws(
		() => deriveComputeBindingsDescriptor( artifact, values.state, { missing: {} } ),
		/public key "missing" did not match/,
	);

	const ambiguous = fixture( { duplicateSampled: true } );
	const ambiguousArtifact = extractComputeArtifact( 1, ambiguous.state, ambiguous.node );
	assert.throws(
		() => deriveComputeBindingsDescriptor( ambiguousArtifact, ambiguous.state, { input: ambiguous.input } ),
		/public key "input" ambiguously matches sampled-texture/,
	);

	assert.throws(
		() => deriveComputeBindingsDescriptor( artifact, values.state, { invalid: 1 } ),
		/resource "invalid" must be an object identity/,
	);

} );

test( 'compileTSL routes each compute node to its explicit public resource map', async () => {

	const values = fixture();
	const manager = {
		nodeBuilderCache: new Map(),
		getForRenderCacheKey() { return 'unused'; },
		getForRender() { return null; },
		get( node ) { return node === values.node ? { nodeBuilderState: values.state } : {}; },
	};
	let renderTarget = null;
	const renderer = {
		_nodes: manager,
		_objects: { get( object ) { return object; } },
		getRenderTarget() { return renderTarget; },
		setRenderTarget( target ) { renderTarget = target; },
		getMRT() { return null; },
		setMRT() {},
		async compileAsync() {},
		async computeAsync() {},
		render() {},
	};
	const artifacts = await compileTSL( renderer, { userData: {}, traverse() {} }, {}, {
		computeNodes: [ values.node ],
		computeBindingResources: new Map( [ [ values.node, { positions: values.positions } ] ] ),
		noGlobalMRT: true,
		skipWarmupRender: true,
	} );

	assert.deepEqual( artifacts.byComputeNode.get( values.node ).computeBindings.entries, [ {
		key: 'positions',
		target: 'storage-buffer',
		group: 0,
		binding: 0,
		access: 'readWrite',
		arrayType: 'Float32Array',
		count: 1,
		itemSize: 4,
		byteLength: 16,
	} ] );

} );
