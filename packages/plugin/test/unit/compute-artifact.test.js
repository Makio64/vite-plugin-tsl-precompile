import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createArtifactVariantPayload } from '@tsl-precompile/contract/artifact-variants';
import { validateArtifact } from '@tsl-precompile/contract/kinds';
import { validateMaterialComputeDescriptor } from '@tsl-precompile/contract/material-compute';
import {
	compileTSL,
	extractArtifact,
	extractComputeArtifact,
	extractMaterialComputeDescriptor,
} from '../../src/vendor/compileTSL.js';

function fakeState() {

	return {
		computeShader: '@compute @workgroup_size( 1 ) fn main() {}',
		bindings: [],
		updateNodes: [],
		updateBeforeNodes: [],
		updateAfterNodes: [],
	};

}

function storageAttribute( values = [ 1, 2, 3, 4 ] ) {

	return {
		isBufferAttribute: true,
		isStorageBufferAttribute: true,
		array: new Float32Array( values ),
		count: 1,
		itemSize: 4,
	};

}

function paddingUniformBinding( name = 'paddingUniform' ) {

	return {
		name,
		isUniformBuffer: true,
		isNodeUniformBuffer: true,
		visibility: 4,
		byteLength: 4,
		nodeUniform: { value: new Float32Array( [ 0 ] ) },
	};

}

function storageBinding( attribute, name = 'positions' ) {

	return {
		name,
		isStorageBuffer: true,
		visibility: 4,
		access: 'readWrite',
		attribute,
	};

}

function storageTextureBinding( texture, access = 'writeOnly', name = 'positionsTexture' ) {

	return {
		name,
		isSampledTexture: true,
		store: true,
		visibility: 4,
		access,
		texture,
		textureNode: { value: texture },
	};

}

function computeState( attribute ) {

	return {
		computeShader: '@compute @workgroup_size( 1 ) fn main() {}',
		vertexShader: '',
		fragmentShader: '',
		nodeAttributes: [],
		bindings: [ { name: 'compute', bindings: [ paddingUniformBinding(), storageBinding( attribute ) ] } ],
		updateNodes: [],
		updateBeforeNodes: [],
		updateAfterNodes: [],
	};

}

function renderState( compute, attribute, renderBindingAttribute = attribute ) {

	return {
		computeShader: '',
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		nodeAttributes: [ {
			name: 'graphPosition',
			type: 'vec4',
			node: { attribute: renderBindingAttribute },
		} ],
		bindings: [ { name: 'render', bindings: [ paddingUniformBinding(), storageBinding( renderBindingAttribute ) ] } ],
		updateNodes: [],
		updateBeforeNodes: [ compute ],
		updateAfterNodes: [],
	};

}

function computeNode( overrides = {} ) {

	return {
		isNode: true,
		isComputeNode: true,
		isPrecompiledCompute: false,
		name: 'advance',
		count: 1,
		workgroupSize: [ 1 ],
		updateBeforeType: 'object',
		...overrides,
	};

}

function materialComputeOwner( node, overrides = {} ) {

	return { isMeshBasicNodeMaterial: true, positionNode: node, ...overrides };

}

test( 'extractComputeArtifact preserves numeric compute count and workgroup size', () => {

	const artifact = extractComputeArtifact( 1, fakeState(), {
		name: 'particles',
		count: 512,
		dispatchSize: null,
		workgroupSize: [ 128 ],
	} );

	assert.equal( artifact.kind, 'compute' );
	assert.equal( artifact.dispatchSize, 512 );
	assert.deepEqual( artifact.workgroupSize, [ 128, 1, 1 ] );

} );

test( 'extractComputeArtifact preserves explicit 3D dispatch size when count is null', () => {

	const artifact = extractComputeArtifact( 1, fakeState(), {
		name: 'volume',
		count: null,
		dispatchSize: [ 4, 8, 2 ],
		workgroupSize: [ 8, 4, 2 ],
	} );

	assert.deepEqual( artifact.dispatchSize, [ 4, 8, 2 ] );
	assert.deepEqual( artifact.workgroupSize, [ 8, 4, 2 ] );

} );

test( 'extractComputeArtifact preserves the storage-texture store qualifier only when enabled', () => {

	const storageTexture = { isTexture: true, isStorageTexture: true, uuid: 'storage-texture' };
	const sampledTexture = { isTexture: true, uuid: 'sampled-texture' };
	const state = {
		...fakeState(),
		bindings: [ { name: 'textures', bindings: [
			{
				name: 'storageTexture',
				isSampledTexture: true,
				store: true,
				visibility: 4,
				texture: storageTexture,
				textureNode: { value: storageTexture },
			},
			{
				name: 'sampledTexture',
				isSampledTexture: true,
				visibility: 4,
				texture: sampledTexture,
				textureNode: { value: sampledTexture },
			},
		] } ],
	};
	const artifact = extractComputeArtifact( 1, state, computeNode() );

	assert.equal( artifact.bindings[ 0 ].bindings[ 0 ].store, true );
	assert.equal( Object.hasOwn( artifact.bindings[ 0 ].bindings[ 1 ], 'store' ), false );

} );

test( 'material compute capture uses exact identity and exact WGSL binding indices', () => {

	const attribute = storageAttribute();
	const node = computeNode();
	const rawComputeState = computeState( attribute );
	const rawRenderState = renderState( node, attribute );
	const renderArtifact = extractArtifact( 7, rawRenderState, { isMeshBasicNodeMaterial: true } );
	const computeArtifact = extractComputeArtifact( 3, rawComputeState, node );
	const descriptor = extractMaterialComputeDescriptor(
		renderArtifact,
		rawRenderState,
		new Map( [ [ node, computeArtifact ] ] ),
		new Map( [ [ node, rawComputeState ] ] ),
		null,
		materialComputeOwner( node ),
	);

	assert.equal( descriptor.version, 'material-compute@1' );
	assert.equal( descriptor.mode, 'precompiled' );
	assert.deepEqual( descriptor.reasons, [] );
	assert.deepEqual( descriptor.resources, [ {
		id: 'resource:0',
		kind: 'storage-buffer',
		arrayType: 'Float32Array',
		count: 1,
		itemSize: 4,
		byteLength: 16,
	} ] );
	assert.deepEqual( descriptor.bindings, [ {
		kernel: 'kernel:0',
		resource: 'resource:0',
		group: 0,
		binding: 1,
		access: 'readWrite',
	} ], 'raw bindings[0].bindings[1] is the exact WGSL @group/@binding index' );
	assert.equal( computeArtifact.bindings[ 0 ].bindings[ 1 ].name, 'positions' );
	assert.equal( computeArtifact.uniformPlan[ 0 ].orderedBindings[ 1 ].ref.name, 'positions' );
	assert.equal( renderArtifact.bindings[ 0 ].bindings[ 1 ].name, 'positions' );
	assert.equal( renderArtifact.uniformPlan[ 0 ].orderedBindings[ 1 ].ref.name, 'positions' );
	assert.deepEqual( descriptor.renderBindings, [
		{ resource: 'resource:0', kind: 'attribute', attribute: 0 },
		{ resource: 'resource:0', kind: 'storage-buffer', group: 0, binding: 1 },
	] );
	assert.deepEqual( descriptor.schedule, [ {
		kernel: 'kernel:0',
		phase: 'update-before',
		order: 0,
		updateType: 'object',
	} ] );
	assert.equal( descriptor.kernels[ 0 ].artifact.computeShader, computeArtifact.computeShader );
	assert.equal( descriptor.kernels[ 0 ].artifact.cacheKey, 1, 'nested routing is canonical per descriptor' );
	assert.deepEqual( validateMaterialComputeDescriptor( descriptor, { artifact: renderArtifact } ), [] );

	renderArtifact.materialCompute = descriptor;
	assert.equal( validateArtifact( renderArtifact ).ok, true );
	assert.equal( createArtifactVariantPayload( renderArtifact ).materialCompute, descriptor );
	const json = JSON.parse( JSON.stringify( descriptor ) );
	const nestedStorage = json.kernels[ 0 ].artifact.uniformPlan[ 0 ].storageBuffers[ 0 ];
	assert.equal( nestedStorage._liveArray, undefined );
	assert.equal( nestedStorage._liveAttribute, undefined );

} );

test( 'material compute capture serializes the exact storage leaf among same-shaped siblings', () => {

	const wrong = storageAttribute( [ 9, 9, 9, 9 ] );
	const expected = storageAttribute();
	const node = computeNode();
	const rawComputeState = computeState( expected );
	const rawRenderState = renderState( node, expected );
	const material = {
		isMeshBasicNodeMaterial: true,
		positionNode: {
			isNode: true,
			first: { isNode: true, value: wrong },
			second: { isNode: true, value: expected },
		},
	};
	const renderArtifact = extractArtifact( 11, rawRenderState, material );
	const computeArtifact = extractComputeArtifact( 6, rawComputeState, node );
	const descriptor = extractMaterialComputeDescriptor(
		renderArtifact,
		rawRenderState,
		new Map( [ [ node, computeArtifact ] ] ),
		new Map( [ [ node, rawComputeState ] ] ),
		null,
		materialComputeOwner( node ),
	);

	assert.deepEqual( renderArtifact.attributes[ 0 ].userPath, [ 'positionNode', 'second', 'value' ] );
	assert.deepEqual( renderArtifact.uniformPlan[ 0 ].storageBuffers[ 0 ].userPath, [ 'positionNode', 'second', 'value' ] );
	assert.equal( descriptor.mode, 'precompiled' );
	assert.deepEqual( descriptor.reasons, [] );
	assert.deepEqual( validateMaterialComputeDescriptor( descriptor, { artifact: renderArtifact } ), [] );

} );

test( 'material compute capture fails closed instead of matching same-shaped resources', () => {

	const computeAttribute = storageAttribute();
	const sameShapeRenderAttribute = storageAttribute( [ 9, 9, 9, 9 ] );
	const node = computeNode( { onInitFunction() {} } );
	const rawComputeState = computeState( computeAttribute );
	const rawRenderState = renderState( node, computeAttribute, sameShapeRenderAttribute );
	const renderArtifact = extractArtifact( 8, rawRenderState, { isMeshBasicNodeMaterial: true } );
	const computeArtifact = extractComputeArtifact( 4, rawComputeState, node );
	const descriptor = extractMaterialComputeDescriptor(
		renderArtifact,
		rawRenderState,
		new Map( [ [ node, computeArtifact ] ] ),
		new Map( [ [ node, rawComputeState ] ] ),
		null,
		materialComputeOwner( node ),
	);

	assert.equal( descriptor.mode, 'hybrid-required' );
	assert.deepEqual( descriptor.renderBindings, [] );
	assert.deepEqual( descriptor.reasons, [
		'kernel:0:on-init-function',
		'resource:0:initial-state-unavailable',
		'resource:0:render-binding-unavailable',
	] );
	assert.deepEqual( validateMaterialComputeDescriptor( descriptor, { artifact: renderArtifact } ), [] );

} );

test( 'material compute capture marks non-compute update-before interleaving as hybrid-required', () => {

	const attribute = storageAttribute();
	const node = computeNode();
	const rawComputeState = computeState( attribute );
	const rawRenderState = renderState( node, attribute );
	rawRenderState.updateBeforeNodes = [ { isNode: true, updateBeforeType: 'frame' }, node ];
	const renderArtifact = extractArtifact( 11, rawRenderState, { isMeshBasicNodeMaterial: true } );
	const computeArtifact = extractComputeArtifact( 6, rawComputeState, node );
	const descriptor = extractMaterialComputeDescriptor(
		renderArtifact,
		rawRenderState,
		new Map( [ [ node, computeArtifact ] ] ),
		new Map( [ [ node, rawComputeState ] ] ),
		null,
		materialComputeOwner( node ),
	);

	assert.equal( descriptor.mode, 'hybrid-required' );
	assert.deepEqual( descriptor.reasons, [ 'schedule:non-compute-update-before' ] );
	assert.deepEqual( descriptor.schedule, [ {
		kernel: 'kernel:0',
		phase: 'update-before',
		order: 1,
		updateType: 'object',
	} ] );
	assert.deepEqual( validateMaterialComputeDescriptor( descriptor, { artifact: renderArtifact } ), [] );

} );

test( 'material compute capture requires serialized render-side initial storage state', () => {

	const attribute = storageAttribute();
	const node = computeNode();
	const rawComputeState = computeState( attribute );
	const rawRenderState = renderState( node, attribute );
	const renderArtifact = extractArtifact( 12, rawRenderState, { isMeshBasicNodeMaterial: true } );
	delete renderArtifact.attributes[ 0 ].arraySnapshot;
	const computeArtifact = extractComputeArtifact( 7, rawComputeState, node );
	const descriptor = extractMaterialComputeDescriptor(
		renderArtifact,
		rawRenderState,
		new Map( [ [ node, computeArtifact ] ] ),
		new Map( [ [ node, rawComputeState ] ] ),
		null,
		materialComputeOwner( node ),
	);

	assert.equal( descriptor.mode, 'hybrid-required' );
	assert.deepEqual( descriptor.reasons, [ 'resource:0:initial-state-unavailable' ] );
	assert.deepEqual( validateMaterialComputeDescriptor( descriptor, { artifact: renderArtifact } ), [] );

} );

test( 'material compute capture rejects an unresolved dynamic compute uniform', () => {

	const attribute = storageAttribute();
	const node = computeNode();
	const rawComputeState = computeState( attribute );
	const rawRenderState = renderState( node, attribute );
	const renderArtifact = extractArtifact( 13, rawRenderState, { isMeshBasicNodeMaterial: true } );
	const computeArtifact = extractComputeArtifact( 8, rawComputeState, node );
	computeArtifact.uniformPlan[ 0 ].slots.push( {
		name: 'dynamic',
		offset: 0,
		size: 4,
		dtype: 'number',
		source: { kind: 'uniform.live', valueSnapshot: 1 },
	} );
	const descriptor = extractMaterialComputeDescriptor(
		renderArtifact,
		rawRenderState,
		new Map( [ [ node, computeArtifact ] ] ),
		new Map( [ [ node, rawComputeState ] ] ),
		null,
		materialComputeOwner( node ),
	);

	assert.equal( descriptor.mode, 'hybrid-required' );
	assert.deepEqual( descriptor.reasons, [ 'kernel:0:live-uniform-unresolved' ] );
	assert.deepEqual( validateMaterialComputeDescriptor( descriptor, { artifact: renderArtifact } ), [] );

} );

test( 'material compute capture serializes exact kernel lifecycle ownership', () => {

	const attribute = storageAttribute();
	const node = computeNode();
	const liveNode = {
		isNode: true,
		getUpdateType: () => 'frame',
		updateReference() { return this; },
		update() {},
	};
	const rawComputeState = computeState( attribute );
	rawComputeState.updateNodes = [ liveNode ];
	const rawRenderState = renderState( node, attribute );
	const renderArtifact = extractArtifact( 16, rawRenderState, { isMeshBasicNodeMaterial: true } );
	const computeArtifact = extractComputeArtifact( 11, rawComputeState, node );
	const slot = {
		name: 'dynamic',
		offset: 0,
		size: 4,
		dtype: 'number',
		source: { kind: 'uniform.live', valueSnapshot: 1 },
	};
	Object.defineProperty( slot, '_liveNode', { value: liveNode, enumerable: false } );
	computeArtifact.uniformPlan[ 0 ].slots.push( slot );
	const owner = {
		isMeshBasicNodeMaterial: true,
		positionNode: { isNode: true, kernel: node, speed: liveNode },
	};
	const descriptor = extractMaterialComputeDescriptor(
		renderArtifact,
		rawRenderState,
		new Map( [ [ node, computeArtifact ] ] ),
		new Map( [ [ node, rawComputeState ] ] ),
		null,
		owner,
	);

	assert.equal( descriptor.mode, 'precompiled' );
	assert.deepEqual( descriptor.kernels[ 0 ].nodePath, [ 'positionNode', 'kernel' ] );
	assert.deepEqual( descriptor.kernels[ 0 ].updates, [ {
		phase: 'update',
		order: 0,
		nodePath: [ 'positionNode', 'speed' ],
		updateType: 'frame',
	} ] );
	assert.deepEqual( descriptor.kernels[ 0 ].artifact.uniformPlan[ 0 ].slots.at( - 1 ).source.nodePath, [ 'positionNode', 'speed' ] );
	assert.deepEqual( validateMaterialComputeDescriptor( descriptor, { artifact: renderArtifact } ), [] );

} );

test( 'material compute capture keeps mixed lifecycle evidence contract-valid in hybrid mode', () => {

	const attribute = storageAttribute();
	const node = computeNode();
	const unresolvedNode = {
		isNode: true,
		getUpdateType: () => 'frame',
		updateReference() { return this; },
		update() {},
	};
	const resolvedNode = {
		isNode: true,
		getUpdateType: () => 'frame',
		updateReference() { return this; },
		update() {},
	};
	const rawComputeState = computeState( attribute );
	rawComputeState.updateNodes = [ unresolvedNode, resolvedNode ];
	const rawRenderState = renderState( node, attribute );
	const renderArtifact = extractArtifact( 17, rawRenderState, { isMeshBasicNodeMaterial: true } );
	const computeArtifact = extractComputeArtifact( 12, rawComputeState, node );
	const owner = {
		isMeshBasicNodeMaterial: true,
		positionNode: { isNode: true, kernel: node, speed: resolvedNode },
	};
	const descriptor = extractMaterialComputeDescriptor(
		renderArtifact,
		rawRenderState,
		new Map( [ [ node, computeArtifact ] ] ),
		new Map( [ [ node, rawComputeState ] ] ),
		null,
		owner,
	);

	assert.equal( descriptor.mode, 'hybrid-required' );
	assert.deepEqual( descriptor.reasons, [ 'kernel:0:update-update:0:unresolved' ] );
	assert.deepEqual( descriptor.kernels[ 0 ].updates, [ {
		phase: 'update',
		order: 0,
		nodePath: [ 'positionNode', 'speed' ],
		updateType: 'frame',
	} ] );
	assert.deepEqual( validateMaterialComputeDescriptor( descriptor, { artifact: renderArtifact } ), [] );

} );

test( 'material compute capture rejects a sampled texture without a serializable source', () => {

	const attribute = storageAttribute();
	const node = computeNode();
	const rawComputeState = computeState( attribute );
	const texture = { isTexture: true, uuid: 'process-local-texture', image: null };
	rawComputeState.bindings[ 0 ].bindings.splice( 1, 0, {
		name: 'lookupTexture',
		isSampledTexture: true,
		visibility: 4,
		texture,
		textureNode: { value: texture },
	} );
	const rawRenderState = renderState( node, attribute );
	const renderArtifact = extractArtifact( 14, rawRenderState, { isMeshBasicNodeMaterial: true } );
	const computeArtifact = extractComputeArtifact( 9, rawComputeState, node );
	const descriptor = extractMaterialComputeDescriptor(
		renderArtifact,
		rawRenderState,
		new Map( [ [ node, computeArtifact ] ] ),
		new Map( [ [ node, rawComputeState ] ] ),
		null,
		materialComputeOwner( node ),
	);

	assert.equal( descriptor.mode, 'hybrid-required' );
	assert.deepEqual( descriptor.reasons, [
		'kernel:0:texture-source-unresolved',
	] );
	assert.deepEqual( validateMaterialComputeDescriptor( descriptor, { artifact: renderArtifact } ), [] );
	const falselyPrecompiled = { ...descriptor, mode: 'precompiled', reasons: [] };
	assert.ok( validateMaterialComputeDescriptor( falselyPrecompiled, { artifact: renderArtifact } )
		.some( ( error ) => error.code === 'material-compute.mode.texture-source' ) );

} );

test( 'material compute capture requires exact storage access evidence', () => {

	const attribute = storageAttribute();
	const node = computeNode();
	const rawComputeState = computeState( attribute );
	rawComputeState.bindings[ 0 ].bindings[ 1 ].access = null;
	const rawRenderState = renderState( node, attribute );
	const renderArtifact = extractArtifact( 15, rawRenderState, { isMeshBasicNodeMaterial: true } );
	const computeArtifact = extractComputeArtifact( 10, rawComputeState, node );
	const descriptor = extractMaterialComputeDescriptor(
		renderArtifact,
		rawRenderState,
		new Map( [ [ node, computeArtifact ] ] ),
		new Map( [ [ node, rawComputeState ] ] ),
		null,
		materialComputeOwner( node ),
	);

	assert.equal( descriptor.mode, 'hybrid-required' );
	assert.deepEqual( descriptor.reasons, [ 'kernel:0:binding:0:1:access-unavailable' ] );
	assert.deepEqual( validateMaterialComputeDescriptor( descriptor, { artifact: renderArtifact } ), [] );
	const falselyPrecompiled = { ...descriptor, mode: 'precompiled', reasons: [] };
	assert.ok( validateMaterialComputeDescriptor( falselyPrecompiled, { artifact: renderArtifact } )
		.some( ( error ) => error.code === 'material-compute.binding.access-unproven' ) );

} );

test( 'material compute capture proves exact storage-texture access', () => {

	for ( const access of [ 'readOnly', 'writeOnly', 'readWrite' ] ) {

		const texture = { isTexture: true, isStorageTexture: true, uuid: `storage-texture-${ access }` };
		const node = computeNode();
		const rawComputeState = {
			...fakeState(),
			bindings: [ { name: 'compute', bindings: [ storageTextureBinding( texture, access ) ] } ],
		};
		const rawRenderState = {
			computeShader: '',
			vertexShader: 'vertex',
			fragmentShader: 'fragment',
			nodeAttributes: [],
			bindings: [ { name: 'render', bindings: [ storageTextureBinding( texture, access ) ] } ],
			updateNodes: [],
			updateBeforeNodes: [ node ],
			updateAfterNodes: [],
		};
		const renderArtifact = extractArtifact( 21, rawRenderState, { isMeshBasicNodeMaterial: true } );
		const computeArtifact = extractComputeArtifact( 16, rawComputeState, node );
		const descriptor = extractMaterialComputeDescriptor(
			renderArtifact,
			rawRenderState,
			new Map( [ [ node, computeArtifact ] ] ),
			new Map( [ [ node, rawComputeState ] ] ),
			null,
			materialComputeOwner( node ),
		);

		assert.equal( descriptor.mode, 'hybrid-required' );
		assert.deepEqual( descriptor.reasons, [ 'resource:0:storage-texture' ] );
		assert.equal( descriptor.bindings[ 0 ].access, access );
		assert.equal( descriptor.kernels[ 0 ].artifact.bindings[ 0 ].bindings[ 0 ].access, access );
		assert.deepEqual( validateMaterialComputeDescriptor( descriptor, { artifact: renderArtifact } ), [] );

	}

} );

test( 'material compute capture marks missing storage-texture access as unproven', () => {

	const texture = { isTexture: true, isStorageTexture: true, uuid: 'storage-texture-missing-access' };
	const node = computeNode();
	const computeBinding = storageTextureBinding( texture );
	delete computeBinding.access;
	const rawComputeState = {
		...fakeState(),
		bindings: [ { name: 'compute', bindings: [ computeBinding ] } ],
	};
	const rawRenderState = {
		computeShader: '',
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		nodeAttributes: [],
		bindings: [ { name: 'render', bindings: [ storageTextureBinding( texture ) ] } ],
		updateNodes: [],
		updateBeforeNodes: [ node ],
		updateAfterNodes: [],
	};
	const renderArtifact = extractArtifact( 22, rawRenderState, { isMeshBasicNodeMaterial: true } );
	const computeArtifact = extractComputeArtifact( 17, rawComputeState, node );
	const descriptor = extractMaterialComputeDescriptor(
		renderArtifact,
		rawRenderState,
		new Map( [ [ node, computeArtifact ] ] ),
		new Map( [ [ node, rawComputeState ] ] ),
		null,
		materialComputeOwner( node ),
	);

	assert.equal( descriptor.mode, 'hybrid-required' );
	assert.deepEqual( descriptor.reasons, [
		'kernel:0:binding:0:0:access-unavailable',
		'resource:0:storage-texture',
	] );
	assert.ok( validateMaterialComputeDescriptor( descriptor, { artifact: renderArtifact } )
		.some( ( error ) => error.code === 'material-compute.binding.access-unproven' ) );

} );

test( 'material compute capture preserves exact scheduling when kernel extraction is unavailable', () => {

	const attribute = storageAttribute();
	const node = computeNode();
	const rawRenderState = renderState( node, attribute );
	const renderArtifact = extractArtifact( 10, rawRenderState, { isMeshBasicNodeMaterial: true } );
	const descriptor = extractMaterialComputeDescriptor( renderArtifact, rawRenderState, new Map(), new Map(), null, materialComputeOwner( node ) );

	assert.equal( descriptor.mode, 'hybrid-required' );
	assert.deepEqual( descriptor.kernels, [ { id: 'kernel:0', nodePath: [ 'positionNode' ], updates: [], artifact: null } ] );
	assert.deepEqual( descriptor.resources, [] );
	assert.deepEqual( descriptor.reasons, [
		'kernel:0:artifact-unavailable',
		'kernel:0:state-unavailable',
	] );
	assert.deepEqual( descriptor.schedule, [ {
		kernel: 'kernel:0',
		phase: 'update-before',
		order: 0,
		updateType: 'object',
	} ] );
	assert.deepEqual( validateMaterialComputeDescriptor( descriptor, { artifact: renderArtifact } ), [] );

} );

test( 'material compute contract rejects non-canonical reasons and fabricated binding locations', () => {

	const attribute = storageAttribute();
	const node = computeNode();
	const rawComputeState = computeState( attribute );
	const rawRenderState = renderState( node, attribute );
	const renderArtifact = extractArtifact( 9, rawRenderState, { isMeshBasicNodeMaterial: true } );
	const computeArtifact = extractComputeArtifact( 5, rawComputeState, node );
	const valid = extractMaterialComputeDescriptor(
		renderArtifact,
		rawRenderState,
		new Map( [ [ node, computeArtifact ] ] ),
		new Map( [ [ node, rawComputeState ] ] ),
		null,
		materialComputeOwner( node ),
	);
	const invalid = {
		...valid,
		mode: 'hybrid-required',
		reasons: [ 'z-last', 'a-first' ],
		bindings: valid.bindings.map( ( entry ) => ( { ...entry, binding: 7 } ) ),
	};
	renderArtifact.materialCompute = invalid;
	const result = validateArtifact( renderArtifact );

	assert.equal( result.ok, false );
	assert.ok( result.errors.some( ( error ) => error.code === 'material-compute.reason.order' ) );
	assert.ok( result.errors.some( ( error ) => error.code === 'material-compute.binding.location' ) );

} );

test( 'compileTSL auto-captures material compute from a supplied exact render state', async () => {

	const attribute = storageAttribute();
	const node = computeNode();
	const rawComputeState = computeState( attribute );
	const rawRenderState = renderState( node, attribute );
	const material = { uuid: 'material-with-compute', isMeshBasicNodeMaterial: true, positionNode: node };
	const object = { material };
	const computeData = new Map();
	const manager = {
		nodeBuilderCache: new Map(),
		getForRenderCacheKey( renderObject ) { return renderObject.cacheKey; },
		getForRender() { return null; },
		get( compute ) {

			let data = computeData.get( compute );
			if ( ! data ) computeData.set( compute, data = {} );
			return data;

		},
		getForCompute( compute ) {

			const data = this.get( compute );
			data.nodeBuilderState = rawComputeState;
			return rawComputeState;

		},
	};
	let renderTarget = null;
	const renderer = {
		_nodes: manager,
		_objects: { get( renderObject ) { return renderObject; } },
		getRenderTarget() { return renderTarget; },
		setRenderTarget( target ) { renderTarget = target; },
		getMRT() { return null; },
		setMRT() {},
		async compileAsync() {},
		render() {},
	};
	const request = Object.freeze( { cacheKey: 'render-compute', material, object, renderContext: null } );
	const family = Object.freeze( {
		material,
		complete: true,
		variants: Object.freeze( [ Object.freeze( {
			cacheKey: 'render-compute',
			nodeBuilderState: rawRenderState,
			objects: Object.freeze( [ object ] ),
			sourceMaterials: Object.freeze( [ material ] ),
			sourceOwnerRequests: Object.freeze( [] ),
			userMaterials: Object.freeze( [ material ] ),
			captureClocks: Object.freeze( [] ),
			renderContextSelectors: Object.freeze( [] ),
			requests: Object.freeze( [ request ] ),
		} ) ] ),
	} );
	const artifacts = await compileTSL( renderer, { userData: {}, traverse() {} }, {}, {
		noGlobalMRT: true,
		skipWarmupRender: true,
		renderObjectHarvest: Object.freeze( {
			renderer,
			familiesByMaterial: new Map( [ [ material, family ] ] ),
		} ),
	} );
	const renderArtifact = artifacts.byMaterialUuid.get( material.uuid );

	assert.ok( renderArtifact.materialCompute );
	assert.equal( renderArtifact.materialCompute.mode, 'precompiled' );
	assert.equal( artifacts.byComputeNode.get( node ).kind, 'compute' );
	assert.equal( artifacts.filter( ( artifact ) => artifact.kind === 'compute' ).length, 1 );
	assert.equal( validateArtifact( renderArtifact ).ok, true );

} );

test( 'compileTSL fails shared frame kernels closed across material owners', async () => {

	const attribute = storageAttribute();
	const node = computeNode( { updateBeforeType: 'frame' } );
	const rawComputeState = computeState( attribute );
	const materialA = { uuid: 'shared-compute-a', isMeshBasicNodeMaterial: true, positionNode: node };
	const materialB = { uuid: 'shared-compute-b', isMeshBasicNodeMaterial: true, positionNode: node };
	const objectA = { material: materialA };
	const objectB = { material: materialB };
	const computeData = new Map();
	const manager = {
		nodeBuilderCache: new Map(),
		getForRenderCacheKey( renderObject ) { return renderObject.cacheKey; },
		getForRender() { return null; },
		get( compute ) {

			let data = computeData.get( compute );
			if ( ! data ) computeData.set( compute, data = {} );
			return data;

		},
		getForCompute( compute ) {

			const data = this.get( compute );
			data.nodeBuilderState = rawComputeState;
			return rawComputeState;

		},
	};
	let renderTarget = null;
	const renderer = {
		_nodes: manager,
		_objects: { get( renderObject ) { return renderObject; } },
		getRenderTarget() { return renderTarget; },
		setRenderTarget( target ) { renderTarget = target; },
		getMRT() { return null; },
		setMRT() {},
		async compileAsync() {},
		render() {},
	};
	const family = ( material, object, cacheKey ) => Object.freeze( {
		material,
		complete: true,
		variants: Object.freeze( [ Object.freeze( {
			cacheKey,
			nodeBuilderState: renderState( node, attribute ),
			objects: Object.freeze( [ object ] ),
			sourceMaterials: Object.freeze( [ material ] ),
			sourceOwnerRequests: Object.freeze( [] ),
			userMaterials: Object.freeze( [ material ] ),
			captureClocks: Object.freeze( [] ),
			renderContextSelectors: Object.freeze( [] ),
			requests: Object.freeze( [] ),
		} ) ] ),
	} );
	const artifacts = await compileTSL( renderer, { userData: {}, traverse() {} }, {}, {
		noGlobalMRT: true,
		skipWarmupRender: true,
		renderObjectHarvest: Object.freeze( {
			renderer,
			familiesByMaterial: new Map( [
				[ materialA, family( materialA, objectA, 'shared-a' ) ],
				[ materialB, family( materialB, objectB, 'shared-b' ) ],
			] ),
		} ),
	} );

	for ( const material of [ materialA, materialB ] ) {

		const artifact = artifacts.byMaterialUuid.get( material.uuid );
		assert.equal( artifact.materialCompute.mode, 'hybrid-required' );
		assert.deepEqual( artifact.materialCompute.reasons, [ 'kernel:0:shared-frame-schedule' ] );
		assert.equal( validateArtifact( artifact ).ok, true );

	}

} );

test( 'compileTSL discovers warm-up material compute without scanning stale render cache states', async () => {

	const staleAttribute = storageAttribute( [ 9, 9, 9, 9 ] );
	const currentAttribute = storageAttribute();
	const staleNode = computeNode( { name: 'stale' } );
	const currentNode = computeNode( { name: 'current' } );
	const staleRenderState = renderState( staleNode, staleAttribute );
	const currentRenderState = renderState( currentNode, currentAttribute );
	const computeStates = new Map( [
		[ staleNode, computeState( staleAttribute ) ],
		[ currentNode, computeState( currentAttribute ) ],
	] );
	const material = { uuid: 'warmup-compute-material', isMeshBasicNodeMaterial: true, positionNode: currentNode };
	const object = { material };
	const renderObject = {
		cacheKey: 'warmup-render-compute',
		material,
		object,
		context: { renderTarget: null, activeCubeFace: 0, activeMipmapLevel: 0, sampleCount: 1 },
		_nodeBuilderState: currentRenderState,
	};
	const computeData = new Map();
	const getForComputeCalls = [];
	const manager = {
		nodeBuilderCache: new Map( [ [ 'stale-render-compute', staleRenderState ] ] ),
		getForRenderCacheKey( value ) { return value.cacheKey; },
		getForRender( value ) { return value._nodeBuilderState; },
		get( compute ) {

			let data = computeData.get( compute );
			if ( ! data ) computeData.set( compute, data = {} );
			return data;

		},
		getForCompute( compute ) {

			getForComputeCalls.push( compute );
			const state = computeStates.get( compute );
			if ( state ) this.get( compute ).nodeBuilderState = state;
			return state || null;

		},
	};
	let renderTarget = null;
	const renderer = {
		_nodes: manager,
		_objects: { get( value ) { return value; } },
		getRenderTarget() { return renderTarget; },
		setRenderTarget( target ) { renderTarget = target; },
		getMRT() { return null; },
		setMRT() {},
		async compileAsync() {},
		async computeAsync() { assert.fail( 'auto-discovered kernels must not dispatch during capture' ); },
		render() {

			const observed = this._objects.get( renderObject );
			this._nodes.getForRender( observed );

		},
	};
	const artifacts = await compileTSL( renderer, { userData: {}, traverse() {} }, {}, { noGlobalMRT: true } );
	const renderArtifact = artifacts.byMaterialUuid.get( material.uuid );

	assert.deepEqual( getForComputeCalls, [ currentNode ], 'only the completed current harvest owns an auto kernel' );
	assert.equal( artifacts.byComputeNode.has( staleNode ), false );
	assert.equal( artifacts.byComputeNode.get( currentNode ).kind, 'compute' );
	assert.equal( artifacts.filter( ( artifact ) => artifact.kind === 'compute' ).length, 1 );
	assert.equal( renderArtifact.materialCompute.mode, 'precompiled' );
	assert.equal( renderArtifact.materialCompute.kernels[ 0 ].artifact.name, 'current' );
	assert.equal( validateArtifact( renderArtifact ).ok, true );

} );

test( 'compileTSL leaves uncached onInit material compute unbuilt and marks it hybrid-required', async () => {

	const attribute = storageAttribute();
	const node = computeNode( { onInitFunction() {} } );
	const rawRenderState = renderState( node, attribute );
	const material = { uuid: 'on-init-compute-material', isMeshBasicNodeMaterial: true, positionNode: node };
	const object = { material };
	const computeData = new Map();
	let getCalls = 0;
	let getForComputeCalls = 0;
	let computeDispatchCalls = 0;
	const manager = {
		nodeBuilderCache: new Map(),
		getForRenderCacheKey( renderObject ) { return renderObject.cacheKey; },
		getForRender() { return null; },
		has( compute ) { return computeData.has( compute ); },
		get( compute ) {

			getCalls ++;
			let data = computeData.get( compute );
			if ( ! data ) computeData.set( compute, data = {} );
			return data;

		},
		getForCompute() {

			getForComputeCalls ++;
			assert.fail( 'an uncached auto-discovered onInit kernel must not be built' );

		},
	};
	let renderTarget = null;
	const renderer = {
		_nodes: manager,
		_objects: { get( renderObject ) { return renderObject; } },
		getRenderTarget() { return renderTarget; },
		setRenderTarget( target ) { renderTarget = target; },
		getMRT() { return null; },
		setMRT() {},
		async compileAsync() {},
		async computeAsync() {

			computeDispatchCalls ++;
			assert.fail( 'an auto-discovered kernel must not dispatch during capture' );

		},
		render() {},
	};
	const family = Object.freeze( {
		material,
		complete: true,
		variants: Object.freeze( [ Object.freeze( {
			cacheKey: 'on-init-render-compute',
			nodeBuilderState: rawRenderState,
			objects: Object.freeze( [ object ] ),
			sourceMaterials: Object.freeze( [ material ] ),
			sourceOwnerRequests: Object.freeze( [] ),
			userMaterials: Object.freeze( [ material ] ),
			captureClocks: Object.freeze( [] ),
			renderContextSelectors: Object.freeze( [] ),
			requests: Object.freeze( [] ),
		} ) ] ),
	} );
	const artifacts = await compileTSL( renderer, { userData: {}, traverse() {} }, {}, {
		noGlobalMRT: true,
		skipWarmupRender: true,
		renderObjectHarvest: Object.freeze( {
			renderer,
			familiesByMaterial: new Map( [ [ material, family ] ] ),
		} ),
	} );
	const renderArtifact = artifacts.byMaterialUuid.get( material.uuid );

	assert.equal( getCalls, 0, 'the side-effecting DataMap.get path stays untouched' );
	assert.equal( getForComputeCalls, 0 );
	assert.equal( computeDispatchCalls, 0 );
	assert.equal( computeData.size, 0, 'capture must not manufacture an empty compute cache row' );
	assert.equal( artifacts.byComputeNode.has( node ), false );
	assert.equal( artifacts.filter( ( artifact ) => artifact.kind === 'compute' ).length, 0 );
	assert.equal( renderArtifact.materialCompute.mode, 'hybrid-required' );
	assert.deepEqual( renderArtifact.materialCompute.reasons, [
		'kernel:0:artifact-unavailable',
		'kernel:0:on-init-function',
		'kernel:0:state-unavailable',
	] );
	assert.equal( validateArtifact( renderArtifact ).ok, true );

} );

test( 'compileTSL discovers material compute only from the selected supplied family on local overlap', async () => {

	const suppliedAttribute = storageAttribute();
	const localAttribute = storageAttribute( [ 5, 6, 7, 8 ] );
	const suppliedNode = computeNode( { name: 'supplied' } );
	const localNode = computeNode( { name: 'discarded-local' } );
	const suppliedRenderState = renderState( suppliedNode, suppliedAttribute );
	const localRenderState = renderState( localNode, localAttribute );
	const computeStates = new Map( [
		[ suppliedNode, computeState( suppliedAttribute ) ],
		[ localNode, computeState( localAttribute ) ],
	] );
	const material = { uuid: 'overlap-compute-material', isMeshBasicNodeMaterial: true, positionNode: suppliedNode };
	const object = { material };
	const localRenderObject = {
		cacheKey: 'discarded-local-render-compute',
		material,
		object,
		context: { renderTarget: null, activeCubeFace: 0, activeMipmapLevel: 0, sampleCount: 1 },
		_nodeBuilderState: localRenderState,
	};
	const computeData = new Map();
	const getForComputeCalls = [];
	const manager = {
		nodeBuilderCache: new Map( [ [ localRenderObject.cacheKey, localRenderState ] ] ),
		getForRenderCacheKey( value ) { return value.cacheKey; },
		getForRender( value ) { return value._nodeBuilderState; },
		has( compute ) { return computeData.has( compute ); },
		get( compute ) {

			let data = computeData.get( compute );
			if ( ! data ) computeData.set( compute, data = {} );
			return data;

		},
		getForCompute( compute ) {

			getForComputeCalls.push( compute );
			const state = computeStates.get( compute );
			if ( state ) this.get( compute ).nodeBuilderState = state;
			return state || null;

		},
	};
	let renderTarget = null;
	const renderer = {
		_nodes: manager,
		_objects: { get( value ) { return value; } },
		getRenderTarget() { return renderTarget; },
		setRenderTarget( target ) { renderTarget = target; },
		getMRT() { return null; },
		setMRT() {},
		async compileAsync() {},
		async computeAsync() { assert.fail( 'auto-discovered kernels must not dispatch during capture' ); },
		render() {

			const observed = this._objects.get( localRenderObject );
			this._nodes.getForRender( observed );

		},
	};
	const suppliedFamily = Object.freeze( {
		material,
		complete: true,
		variants: Object.freeze( [ Object.freeze( {
			cacheKey: 'supplied-render-compute',
			nodeBuilderState: suppliedRenderState,
			objects: Object.freeze( [ object ] ),
			sourceMaterials: Object.freeze( [ material ] ),
			sourceOwnerRequests: Object.freeze( [] ),
			userMaterials: Object.freeze( [ material ] ),
			captureClocks: Object.freeze( [] ),
			renderContextSelectors: Object.freeze( [] ),
			requests: Object.freeze( [] ),
		} ) ] ),
	} );
	const artifacts = await compileTSL( renderer, { userData: {}, traverse() {} }, {}, {
		noGlobalMRT: true,
		renderObjectHarvest: Object.freeze( {
			renderer,
			familiesByMaterial: new Map( [ [ material, suppliedFamily ] ] ),
		} ),
	} );
	const renderArtifact = artifacts.byMaterialUuid.get( material.uuid );

	assert.deepEqual( getForComputeCalls, [ suppliedNode ] );
	assert.equal( artifacts.byComputeNode.has( localNode ), false );
	assert.equal( artifacts.byComputeNode.get( suppliedNode ).name, 'supplied' );
	assert.equal( renderArtifact.cacheKey, 'supplied-render-compute' );
	assert.equal( renderArtifact.materialCompute.kernels[ 0 ].artifact.name, 'supplied' );
	assert.equal( validateArtifact( renderArtifact ).ok, true );

} );

test( 'compileTSL includes material compute from a selected synthetic family fallback state', async () => {

	const attribute = storageAttribute();
	const node = computeNode( { name: 'synthetic-fallback' } );
	const fallbackRenderState = renderState( node, attribute );
	const rawComputeState = computeState( attribute );
	const material = { uuid: 'synthetic-fallback-compute-material', isMeshBasicNodeMaterial: true, positionNode: node };
	const object = { material };
	const renderObject = {
		cacheKey: 'synthetic-fallback-render-compute',
		material,
		object,
		context: { renderTarget: null, activeCubeFace: 0, activeMipmapLevel: 0, sampleCount: 1 },
		_nodeBuilderState: null,
	};
	const computeData = new Map();
	const getForComputeCalls = [];
	const manager = {
		nodeBuilderCache: new Map(),
		getForRenderCacheKey( value ) { return value.cacheKey; },
		getForRender() { return null; },
		has( compute ) { return computeData.has( compute ); },
		get( compute ) {

			let data = computeData.get( compute );
			if ( ! data ) computeData.set( compute, data = {} );
			return data;

		},
		getForCompute( compute ) {

			getForComputeCalls.push( compute );
			this.get( compute ).nodeBuilderState = rawComputeState;
			return rawComputeState;

		},
	};
	let renderTarget = null;
	const renderer = {
		_nodes: manager,
		_objects: { get( value ) { return value; } },
		getRenderTarget() { return renderTarget; },
		setRenderTarget( target ) { renderTarget = target; },
		getMRT() { return null; },
		setMRT() {},
		async compileAsync() {},
		async computeAsync() { assert.fail( 'auto-discovered kernels must not dispatch during capture' ); },
		render() {

			const observed = this._objects.get( renderObject );
			this._nodes.getForRender( observed );
			this._nodes.nodeBuilderCache.set( renderObject.cacheKey, fallbackRenderState );

		},
	};
	const artifacts = await compileTSL( renderer, { userData: {}, traverse() {} }, {}, { noGlobalMRT: true } );
	const renderArtifact = artifacts.byMaterialUuid.get( material.uuid );

	assert.deepEqual( getForComputeCalls, [ node ] );
	assert.equal( artifacts.byComputeNode.get( node ).name, 'synthetic-fallback' );
	assert.equal( renderArtifact.materialCompute.mode, 'precompiled' );
	assert.equal( renderArtifact.materialCompute.kernels[ 0 ].artifact.name, 'synthetic-fallback' );
	assert.equal( validateArtifact( renderArtifact ).ok, true );

} );
