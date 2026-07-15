import assert from 'node:assert/strict';
import test from 'node:test';

import StorageBufferAttribute from 'three/src/renderers/common/StorageBufferAttribute.js';

import { hydrateNodeBuilderState } from '../src/hydrator.js';
import ReplayNodeFrame from '../src/slim-replay-node-frame.js';
import {
	claimMaterialComputeDelegation,
	releaseMaterialComputeDelegation,
} from '../src/hydrate/material-compute-ownership.js';

function storageAttribute( values ) {

	return new StorageBufferAttribute( new Float32Array( values ), 4 );

}

function resource( index ) {

	return {
		id: `resource:${ index }`,
		kind: 'storage-buffer',
		arrayType: 'Float32Array',
		count: 1,
		itemSize: 4,
		byteLength: 16,
	};

}

function storageDescriptor( name, visibility = 4 ) {

	return {
		name,
		kind: 'storage-buffer',
		visibility,
		textureType: null,
		byteLength: 16,
		access: 'readWrite',
	};

}

function storageRef( name ) {

	return {
		name,
		access: 'readWrite',
		visibility: 4,
		arrayType: 'Float32Array',
		count: 1,
		itemSize: 4,
	};

}

function kernelArtifact( index, resourceCount ) {

	const refs = Array.from( { length: resourceCount }, ( _, resourceIndex ) => storageRef( `storage${ resourceIndex }` ) );
	return {
		version: 3,
		kind: 'compute',
		cacheKey: index + 1,
		name: `kernel-${ index }`,
		computeShader: `compute-${ index }`,
		vertexShader: '',
		fragmentShader: '',
		attributes: [],
		bindings: [ {
			name: 'compute',
			bindings: refs.map( ( ref ) => storageDescriptor( ref.name ) ),
		} ],
		uniformPlan: [ {
			name: 'compute',
			slots: [],
			textures: [],
			storageBuffers: refs,
			orderedBindings: refs.map( ( ref ) => ( { type: 'storage-buffer', ref } ) ),
		} ],
		defaults: {},
		dispatchSize: 1,
		workgroupSize: [ 1, 1, 1 ],
		meta: { updateNodes: 0, updateBeforeNodes: 0, updateAfterNodes: 0 },
	};

}

function ownerArtifact( {
	resourceCount = 1,
	kernelCount = 1,
	updateType = 'object',
	paths = null,
	snapshots = null,
} = {} ) {

	const resources = Array.from( { length: resourceCount }, ( _, index ) => resource( index ) );
	const attributes = resources.map( ( _, index ) => ( {
		name: `storage${ index }`,
		type: 'vec4',
		source: 'node',
		storage: true,
		instanced: false,
		arrayType: 'Float32Array',
		count: 1,
		itemSize: 4,
		...( paths && paths[ index ] ? { userPath: paths[ index ] } : {} ),
		...( snapshots && snapshots[ index ] ? { arraySnapshot: snapshots[ index ] } : {} ),
	} ) );
	const renderRefs = resources.map( ( _, index ) => storageRef( `storage${ index }` ) );
	const kernels = Array.from( { length: kernelCount }, ( _, index ) => ( {
		id: `kernel:${ index }`,
		nodePath: [ `kernel${ index }Node` ],
		updates: [],
		artifact: kernelArtifact( index, resourceCount ),
	} ) );
	const bindings = kernels.flatMap( ( kernel ) => resources.map( ( item, binding ) => ( {
		kernel: kernel.id,
		resource: item.id,
		group: 0,
		binding,
		access: 'readWrite',
	} ) ) );
	const renderBindings = resources.flatMap( ( item, index ) => [
		{ resource: item.id, kind: 'attribute', attribute: index },
		{ resource: item.id, kind: 'storage-buffer', group: 0, binding: index },
	] );
	return {
		version: 3,
		cacheKey: 'owner',
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		computeShader: '',
		attributes,
		bindings: [ {
			name: 'render',
			bindings: renderRefs.map( ( ref ) => storageDescriptor( ref.name, 3 ) ),
		} ],
		uniformPlan: [ {
			name: 'render',
			slots: [],
			textures: [],
			storageBuffers: renderRefs,
			orderedBindings: renderRefs.map( ( ref ) => ( { type: 'storage-buffer', ref } ) ),
		} ],
		defaults: {},
		meta: { updateNodes: 0, updateBeforeNodes: kernelCount, updateAfterNodes: 0 },
		materialCompute: {
			version: 'material-compute@1',
			mode: 'precompiled',
			reasons: [],
			resources,
			kernels,
			bindings,
			renderBindings,
			schedule: kernels.map( ( kernel, order ) => ( {
				kernel: kernel.id,
				phase: 'update-before',
				order,
				updateType,
			} ) ),
		},
	};

}

function precompiledMaterial( artifact, graph = {} ) {

	return {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		...graph,
	};

}

function renderStorageAttributes( state ) {

	return state.bindings[ 0 ].bindings.map( ( binding ) => binding.attribute );

}

test( 'material compute shares exact same-shaped resources across render and nested compute', () => {

	const first = storageAttribute( [ 1, 2, 3, 4 ] );
	const second = storageAttribute( [ 5, 6, 7, 8 ] );
	const artifact = ownerArtifact( {
		resourceCount: 2,
		paths: [
			[ 'positionNode', 'first', 'value' ],
			[ 'positionNode', 'second', 'value' ],
		],
	} );
	artifact._liveUpdateBeforeNodes = [ { isComputeNode: true, isPrecompiledCompute: false } ];
	const material = precompiledMaterial( artifact, {
		positionNode: {
			isNode: true,
			first: { isNode: true, value: first },
			second: { isNode: true, value: second },
		},
	} );
	const state = hydrateNodeBuilderState( artifact, material );
	const renderStorage = renderStorageAttributes( state );

	assert.equal( state.nodeAttributes[ 0 ].node.attribute, first );
	assert.equal( state.nodeAttributes[ 1 ].node.attribute, second );
	assert.deepEqual( renderStorage, [ first, second ] );
	assert.equal( state.updateBeforeNodes.length, 1, 'the raw ComputeNode sidecar is replaced by one precompiled adapter' );

	let nestedStorage = null;
	state.updateBeforeNodes[ 0 ].updateBefore( {
		renderer: {
			compute( node ) {

				const computeState = hydrateNodeBuilderState( node.precompiledArtifact, node.__tslpMaterialComputeOwner );
				nestedStorage = computeState.bindings[ 0 ].bindings.map( ( binding ) => binding.attribute );

			},
		},
		material,
	} );
	assert.deepEqual( nestedStorage, [ first, second ] );

} );

test( 'material compute snapshot allocation is seeded and owner-local', () => {

	const artifact = ownerArtifact( { snapshots: [ [ 1, 2, 3, 4 ] ] } );
	const materialA = precompiledMaterial( artifact );
	const materialB = precompiledMaterial( artifact );
	const stateA = hydrateNodeBuilderState( artifact, materialA );
	const stateB = hydrateNodeBuilderState( artifact, materialB );
	const attributeA = stateA.nodeAttributes[ 0 ].node.attribute;
	const attributeB = stateB.nodeAttributes[ 0 ].node.attribute;

	assert.deepEqual( Array.from( attributeA.array ), [ 1, 2, 3, 4 ] );
	assert.equal( renderStorageAttributes( stateA )[ 0 ], attributeA );
	assert.notEqual( attributeA, attributeB );

} );

test( 'material compute frame scheduling preserves order and dedupes each kernel independently', () => {

	const artifact = ownerArtifact( {
		kernelCount: 2,
		updateType: 'frame',
		snapshots: [ [ 1, 2, 3, 4 ] ],
	} );
	const material = precompiledMaterial( artifact );
	const state = hydrateNodeBuilderState( artifact, material );
	const frame = new ReplayNodeFrame();
	const dispatches = [];
	frame.renderer = { compute( node ) { dispatches.push( node.name ); } };
	frame.material = material;

	frame.frameId = 1;
	for ( const node of state.updateBeforeNodes ) frame.updateBeforeNode( node );
	for ( const node of state.updateBeforeNodes ) frame.updateBeforeNode( node );
	frame.frameId = 2;
	for ( const node of state.updateBeforeNodes ) frame.updateBeforeNode( node );

	assert.deepEqual( dispatches, [ 'kernel-0', 'kernel-1', 'kernel-0', 'kernel-1' ] );

} );

test( 'material compute reconstructs nested lifecycle nodes from exact paths', () => {

	const artifact = ownerArtifact( { snapshots: [ [ 1, 2, 3, 4 ] ] } );
	const liveNode = {
		isNode: true,
		getUpdateType: () => 'frame',
		updateReference() { return this; },
		update() {},
	};
	const kernel = artifact.materialCompute.kernels[ 0 ];
	kernel.updates = [ {
		phase: 'update',
		order: 0,
		nodePath: [ 'lifecycleNode' ],
		updateType: 'frame',
	} ];
	kernel.artifact.meta.updateNodes = 1;
	kernel.artifact.uniformPlan[ 0 ].slots.push( {
		name: 'speed',
		source: { kind: 'uniform.live', nodePath: [ 'lifecycleNode' ], valueSnapshot: 1 },
	} );
	const material = precompiledMaterial( artifact, { lifecycleNode: liveNode } );
	const state = hydrateNodeBuilderState( artifact, material );
	let nestedState = null;
	state.updateBeforeNodes[ 0 ].updateBefore( {
		renderer: {
			compute( node ) {

				nestedState = hydrateNodeBuilderState( node.precompiledArtifact, node.__tslpMaterialComputeOwner );

			},
		},
		material,
	} );

	assert.deepEqual( nestedState.updateNodes, [ liveNode ] );
	assert.equal( nestedState.bindings[ 0 ].bindings[ 0 ].attribute, state.bindings[ 0 ].bindings[ 0 ].attribute );

} );

test( 'material compute fails closed when a retained lifecycle changes type', () => {

	const artifact = ownerArtifact( { snapshots: [ [ 1, 2, 3, 4 ] ] } );
	const liveNode = {
		isNode: true,
		getUpdateType: () => 'render',
		updateReference() { return this; },
		update() {},
	};
	artifact.materialCompute.kernels[ 0 ].updates = [ {
		phase: 'update',
		order: 0,
		nodePath: [ 'lifecycleNode' ],
		updateType: 'frame',
	} ];
	artifact.materialCompute.kernels[ 0 ].artifact.meta.updateNodes = 1;
	const material = precompiledMaterial( artifact, { lifecycleNode: liveNode } );

	assert.throws(
		() => hydrateNodeBuilderState( artifact, material ),
		( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_LIFECYCLE_MISS',
	);

} );

test( 'material compute exact paths fail closed when the leaf is missing', () => {

	const artifact = ownerArtifact( { paths: [ [ 'positionNode', 'missing', 'value' ] ] } );
	const material = precompiledMaterial( artifact, {
		positionNode: { isNode: true, other: { isNode: true, value: storageAttribute( [ 9, 9, 9, 9 ] ) } },
	} );

	assert.throws(
		() => hydrateNodeBuilderState( artifact, material ),
		( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_EXACT_PATH_MISS',
	);

} );

test( 'hybrid material compute requires an exact delegation claim', () => {

	const artifact = ownerArtifact( { snapshots: [ [ 1, 2, 3, 4 ] ] } );
	artifact.materialCompute = {
		...artifact.materialCompute,
		mode: 'hybrid-required',
		reasons: [ 'kernel:0:on-init-function' ],
	};
	const material = precompiledMaterial( artifact );

	assert.throws(
		() => hydrateNodeBuilderState( artifact, material ),
		( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED' && /on-init-function/.test( error.message ),
	);
	const owner = {};
	claimMaterialComputeDelegation( material, owner, artifact );
	const state = hydrateNodeBuilderState( artifact, material );
	assert.equal( state.updateBeforeNodes.length, 1 );
	assert.doesNotThrow( () => state.updateBeforeNodes[ 0 ].updateBefore( {} ) );
	assert.equal( releaseMaterialComputeDelegation( material, owner ), true );
	assert.throws(
		() => state.updateBeforeNodes[ 0 ].updateBefore( {} ),
		( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
	);

} );

test( 'material compute rejects divergent variant ownership before controller creation', () => {

	const variantA = ownerArtifact( { snapshots: [ [ 1, 2, 3, 4 ] ] } );
	variantA.cacheKey = 'a';
	const variantB = ownerArtifact( { snapshots: [ [ 5, 6, 7, 8 ] ] } );
	variantB.cacheKey = 'b';
	variantB.materialCompute.kernels[ 0 ].artifact.name = 'different-kernel';
	const artifact = {
		...variantA,
		variants: { a: variantA, b: variantB },
	};
	const material = precompiledMaterial( artifact );

	assert.throws(
		() => hydrateNodeBuilderState( artifact, material, null, { cacheKey: 'a' } ),
		( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_VARIANT_DIVERGENCE',
	);

} );

test( 'material compute rejects asynchronous update-before dispatch', () => {

	const artifact = ownerArtifact( { snapshots: [ [ 1, 2, 3, 4 ] ] } );
	const material = precompiledMaterial( artifact );
	const state = hydrateNodeBuilderState( artifact, material );

	assert.throws(
		() => state.updateBeforeNodes[ 0 ].updateBefore( { renderer: { compute: async () => {} }, material } ),
		( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_ASYNC_DISPATCH',
	);

} );
