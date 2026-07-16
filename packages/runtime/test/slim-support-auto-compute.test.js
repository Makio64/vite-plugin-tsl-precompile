import test from 'node:test';
import assert from 'node:assert/strict';

import {
	MATERIAL_COMPUTE_BINDINGS,
	applyMaterialComputeAttributeBindings,
	artifactHasUnwiredAnonymousComputeAttribute,
	collectMaterialComputeBindings,
	collectMaterialComputeOwners,
	collectWritableComputeStorageAttributes,
	createAutoComputeDispatcher,
	prepareMaterialComputeAttributes,
} from '../src/slim-support/auto-compute.js';
import { hydrateNodeBuilderState } from '../src/hydrator.js';
import { findMaterialComputeNodePath } from '@tsl-precompile/contract/material-compute';

function storageAttribute( { count = 4, itemSize = 3, ArrayType = Float32Array } = {} ) {

	return {
		isBufferAttribute: true,
		isStorageBufferAttribute: true,
		array: new ArrayType( count * itemSize ),
		count,
		itemSize,
	};

}

function computeNode( name = 'compute' ) {

	const node = {
		name,
		isNode: true,
		isComputeNode: true,
		traverse( visitor ) { visitor( node ); },
	};
	return node;

}

function nodeWithAttribute( attribute ) {

	const leaf = { isNode: true, value: attribute };
	return {
		isNode: true,
		traverse( visitor ) { visitor( this ); visitor( leaf ); },
	};

}

function artifactEntry( overrides = {} ) {

	return {
		name: 'nodeAttribute0',
		source: 'node',
		storage: true,
		count: 4,
		itemSize: 4,
		arrayType: 'Float32Array',
		...overrides,
	};

}

function precompiledMaterial( artifact, nodes = {} ) {

	return {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		disposeCalls: 0,
		dispose() { this.disposeCalls ++; },
		...nodes,
	};

}

function sceneWith( ...materials ) {

	const objects = materials.map( ( material ) => ( { material } ) );
	return { traverse( visitor ) { for ( const object of objects ) visitor( object ); } };

}

function fullRendererFor( bindingsOrFactory ) {

	return {
		_nodes: {
			getForCompute( node ) {

				const bindings = typeof bindingsOrFactory === 'function' ? bindingsOrFactory( node ) : bindingsOrFactory;
				return { bindings: [ { bindings } ] };

			},
		},
	};

}

function storageBinding( attribute, access = 'readWrite' ) {

	return { isStorageBuffer: true, attribute, access };

}

test( 'scene discovery keeps every precompiled owner but deduplicates each material/node pair', () => {

	const shared = computeNode( 'shared' );
	const precompiled = computeNode( 'baked' );
	precompiled.isPrecompiledCompute = true;
	const artifact = { attributes: [ artifactEntry() ] };
	const first = precompiledMaterial( artifact, { positionNode: shared, colorNode: shared } );
	const second = precompiledMaterial( artifact, { outputNode: shared, vertexNode: precompiled } );
	const live = { positionNode: shared };

	const records = collectMaterialComputeBindings( sceneWith( first, [ second, live ] ) );

	assert.equal( records.length, 2 );
	assert.deepEqual( records.map( ( record ) => record.material ), [ first, second ] );
	assert.deepEqual( records[ 0 ].properties.sort(), [ 'colorNode', 'positionNode' ] );
	assert.equal( records.every( ( record ) => record.computeNode === shared ), true );

} );

test( 'scene discovery adopts deferred geometry kernels at their captured private root path', () => {

	const deferred = computeNode( 'deferred-geometry' );
	const geometryNode = {
		isNode: true,
		isShaderCallNodeInternal: true,
		shaderNode: { jsFunc() {} },
		traverse( visitor ) { visitor( this ); },
	};
	const sourceMaterial = { geometryNode };
	const material = precompiledMaterial( { attributes: [] }, {
		__tslpSourceMaterial: sourceMaterial,
		__tslpDeferredGeometryUpdateBeforeNodes: [ deferred ],
	} );
	const records = collectMaterialComputeBindings( sceneWith( material ) );

	assert.equal( records.length, 1 );
	assert.equal( records[ 0 ].computeNode, deferred );
	assert.deepEqual( records[ 0 ].properties, [ 'geometryNode' ] );
	assert.deepEqual(
		findMaterialComputeNodePath( sourceMaterial, deferred ),
		[ 'geometryNode', '_tslpMaterialComputeNodes', '0' ],
	);

} );

test( 'scene owner discovery preserves every object that shares one material', () => {

	const material = precompiledMaterial( { attributes: [] } );
	const first = { material };
	const second = { material };
	const owners = collectMaterialComputeOwners( {
		traverse( visitor ) { visitor( first ); visitor( second ); },
	} );

	assert.equal( owners.length, 1 );
	assert.equal( owners[ 0 ].object, first );
	assert.deepEqual( owners[ 0 ].objects, [ first, second ] );

} );

test( 'writable compute storage collection excludes read-only and non-live bindings', () => {

	const writable = storageAttribute();
	const writeOnly = storageAttribute();
	const readOnly = storageAttribute();
	const unknownAccess = storageAttribute();
	const noArray = { isStorageBufferAttribute: true, count: 4, itemSize: 3 };
	const result = collectWritableComputeStorageAttributes( computeNode(), fullRendererFor( [
		storageBinding( readOnly, 'readOnly' ),
		storageBinding( writable ),
		storageBinding( writeOnly, 'writeOnly' ),
		{ isStorageBuffer: true, attribute: unknownAccess },
		storageBinding( writable ),
		storageBinding( noArray ),
	] ) );

	assert.equal( result.status, 'ready' );
	assert.deepEqual( result.attributes, [ writable, writeOnly ] );

} );

test( 'owner-local preparation excludes other render slots and applies after variant cloning', () => {

	const position = storageAttribute();
	const speed = storageAttribute();
	const compute = computeNode();
	const artifact = { attributes: [ artifactEntry() ] };
	const material = precompiledMaterial( artifact, {
		positionNode: compute,
		colorNode: nodeWithAttribute( speed ),
	} );
	const full = fullRendererFor( [ storageBinding( position ), storageBinding( speed ) ] );

	const result = prepareMaterialComputeAttributes( material, compute, full );

	assert.equal( result.status, 'ready' );
	assert.equal( result.prepared, 1 );
	assert.equal( artifact.attributes[ 0 ]._liveAttribute, undefined, 'serialized/shared artifact stays immutable' );
	assert.equal( Object.prototype.propertyIsEnumerable.call( material, MATERIAL_COMPUTE_BINDINGS ), false );

	const selectedView = { ...artifact, attributes: artifact.attributes.map( ( entry ) => ( { ...entry } ) ) };
	assert.equal( applyMaterialComputeAttributeBindings( selectedView, material ), 1 );
	assert.equal( selectedView.attributes[ 0 ]._liveAttribute, position );
	assert.equal( Object.prototype.propertyIsEnumerable.call( selectedView.attributes[ 0 ], '_liveAttribute' ), false );
	assert.equal( selectedView.attributes[ 0 ]._liveAttributeSource, 'material-compute' );

} );

test( 'proven compute ownership replaces an earlier same-shape heuristic binding', async () => {

	const position = storageAttribute();
	const speed = storageAttribute();
	const compute = computeNode();
	const entry = artifactEntry( { arraySnapshot: new Array( 16 ).fill( 0 ) } );
	Object.defineProperty( entry, '_liveAttribute', {
		value: speed,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	Object.defineProperty( entry, '_liveAttributeSource', {
		value: 'heuristic',
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	const artifact = {
		vertexShader: '',
		fragmentShader: '',
		bindings: [],
		uniformPlan: [],
		attributes: [ entry ],
	};
	const material = precompiledMaterial( artifact, {
		positionNode: compute,
		colorNode: nodeWithAttribute( speed ),
	} );

	assert.equal( artifactHasUnwiredAnonymousComputeAttribute( artifact ), false, 'the public unwired predicate keeps its literal semantics' );
	let dispatches = 0;
	const dispatcher = createAutoComputeDispatcher();
	const dispatchNode = () => { dispatches ++; };
	const bootstrap = await dispatcher.dispatch( sceneWith( material ), { dispatchNode } );
	assert.equal( bootstrap.pending, 1 );
	assert.equal( bootstrap.dispatched, 1, 'anonymous ownership is bootstrapped despite a provisional live sidecar' );
	const options = {
		fullRenderer: fullRendererFor( [ storageBinding( position ), storageBinding( speed ) ] ),
		dispatchNode,
	};
	const prepared = await dispatcher.dispatch( sceneWith( material ), options );
	assert.equal( prepared.attributesPrepared, 1 );
	assert.equal( prepared.invalidated, 1 );
	const repeated = await dispatcher.dispatch( sceneWith( material ), options );
	assert.equal( repeated.attributesPrepared, 0 );
	assert.equal( repeated.invalidated, 0 );
	assert.equal( dispatches, 3 );
	const hydrated = hydrateNodeBuilderState( artifact, material );

	assert.equal( artifact.attributes[ 0 ]._liveAttribute, speed, 'shared artifact retains the legacy sidecar without owner leakage' );
	assert.equal( hydrated.nodeAttributes[ 0 ].node.attribute, position, 'authoritative compute output replaces the heuristic in the state-local view' );

} );

test( 'attribute matching accepts live vec3 to captured vec4 and rejects unsafe entries', () => {

	const compute = computeNode();
	const live = storageAttribute( { count: 4, itemSize: 3 } );
	const full = fullRendererFor( [ storageBinding( live ) ] );
	const artifact = {
		attributes: [
			artifactEntry( { storage: false } ),
			artifactEntry( { userPath: [ 'positionNode' ] } ),
			artifactEntry( { arrayType: 'Uint32Array' } ),
		],
	};
	const material = precompiledMaterial( artifact, { positionNode: compute } );

	assert.equal( artifactHasUnwiredAnonymousComputeAttribute( artifact ), true, 'typed-array mismatch is still an anonymous entry requiring evidence' );
	const result = prepareMaterialComputeAttributes( material, compute, full );
	assert.equal( result.status, 'incomplete' );
	assert.equal( result.prepared, 0 );
	assert.equal( artifact.attributes.every( ( entry ) => entry._liveAttribute === undefined ), true );

	const safeArtifact = { attributes: [ artifactEntry() ] };
	const safe = precompiledMaterial( safeArtifact, { positionNode: compute } );
	assert.equal( prepareMaterialComputeAttributes( safe, compute, full ).status, 'ready' );

} );

test( 'same-shape writable outputs fail closed when no semantic evidence disambiguates them', () => {

	const compute = computeNode();
	const first = storageAttribute();
	const second = storageAttribute();
	const artifact = { attributes: [ artifactEntry() ] };
	const material = precompiledMaterial( artifact, { positionNode: compute } );

	const result = prepareMaterialComputeAttributes(
		material,
		compute,
		fullRendererFor( [ storageBinding( first ), storageBinding( second ) ] ),
	);

	assert.equal( result.status, 'ambiguous' );
	assert.equal( result.prepared, 0 );
	assert.equal( material[ MATERIAL_COMPUTE_BINDINGS ], undefined );

} );

test( 'material-local sidecars isolate shared artifact owners and variant-local attributes', () => {

	const sharedArtifact = {
		cacheKey: 'root',
		vertexShader: 'root vertex',
		fragmentShader: 'root fragment',
		bindings: [],
		uniformPlan: [],
		attributes: [ artifactEntry() ],
		variants: {
			root: { cacheKey: 'root', vertexShader: 'root vertex', fragmentShader: 'root fragment', bindings: [], uniformPlan: [], attributes: [ artifactEntry() ] },
			other: { cacheKey: 'other', vertexShader: 'other vertex', fragmentShader: 'other fragment', bindings: [], uniformPlan: [], attributes: [ artifactEntry() ] },
		},
	};
	const nodeA = computeNode( 'A' );
	const nodeB = computeNode( 'B' );
	const attrA = storageAttribute();
	const attrB = storageAttribute();
	const materialA = precompiledMaterial( sharedArtifact, { positionNode: nodeA, colorNode: nodeWithAttribute( attrB ) } );
	const materialB = precompiledMaterial( sharedArtifact, { positionNode: nodeB } );
	const full = fullRendererFor( ( node ) => [ storageBinding( node === nodeA ? attrA : attrB ) ] );

	assert.equal( prepareMaterialComputeAttributes( materialA, nodeA, full ).status, 'ready' );
	assert.equal( prepareMaterialComputeAttributes( materialB, nodeB, full ).status, 'ready' );
	const viewA = { ...sharedArtifact.variants.other, attributes: sharedArtifact.variants.other.attributes.map( ( entry ) => ( { ...entry } ) ) };
	const viewB = { ...sharedArtifact.variants.other, attributes: sharedArtifact.variants.other.attributes.map( ( entry ) => ( { ...entry } ) ) };
	applyMaterialComputeAttributeBindings( viewA, materialA );
	applyMaterialComputeAttributeBindings( viewB, materialB );

	assert.equal( viewA.attributes[ 0 ]._liveAttribute, attrA );
	assert.equal( viewB.attributes[ 0 ]._liveAttribute, attrB );
	assert.equal( sharedArtifact.attributes[ 0 ]._liveAttribute, undefined );
	assert.equal( sharedArtifact.variants.other.attributes[ 0 ]._liveAttribute, undefined );
	const hydrated = hydrateNodeBuilderState( sharedArtifact, materialA, null, { cacheKey: 'other' } );
	assert.equal( hydrated.vertexShader, 'other vertex' );
	assert.equal( hydrated.nodeAttributes[ 0 ].node.attribute, attrA, 'hydrator applies the owner sidecar after selecting and cloning the variant' );

} );

test( 'dispatcher reports a missing dispatch implementation without claiming success', async () => {

	const node = computeNode();
	const attr = storageAttribute();
	const material = precompiledMaterial( { attributes: [ artifactEntry() ] }, { positionNode: node } );
	const errors = [];
	const dispatcher = createAutoComputeDispatcher( { onError: ( error ) => errors.push( error ) } );
	const stats = await dispatcher.dispatch( sceneWith( material ), {
		fullRenderer: fullRendererFor( [ storageBinding( attr ) ] ),
	} );

	assert.equal( stats.dispatched, 0 );
	assert.equal( stats.skipped, 1 );
	assert.equal( stats.errors, 1 );
	assert.equal( errors[ 0 ].code, 'TSLP_AUTO_COMPUTE_DISPATCH_UNAVAILABLE' );

} );

test( 'contract-owned hybrid compute can force dispatch without anonymous attributes', async () => {

	const node = computeNode();
	const material = precompiledMaterial( { attributes: [] }, { positionNode: node } );
	let dispatches = 0;
	const dispatcher = createAutoComputeDispatcher();
	const stats = await dispatcher.dispatch( sceneWith( material ), {
		forceDispatch: true,
		dispatchNode() { dispatches ++; },
	} );

	assert.equal( dispatches, 1 );
	assert.equal( stats.dispatched, 1 );

} );

test( 'a resolver can recover a previously cached ambiguous owner', async () => {

	const node = computeNode();
	const first = storageAttribute();
	const second = storageAttribute();
	const material = precompiledMaterial( { attributes: [ artifactEntry() ] }, { positionNode: node } );
	const dispatcher = createAutoComputeDispatcher();
	const options = {
		fullRenderer: fullRendererFor( [ storageBinding( first ), storageBinding( second ) ] ),
		dispatchNode() {},
	};

	assert.equal( ( await dispatcher.dispatch( sceneWith( material ), options ) ).ambiguous, 1 );
	const recovered = await dispatcher.dispatch( sceneWith( material ), {
		...options,
		resolveCandidate: () => second,
	} );
	assert.equal( recovered.dispatched, 1 );
	assert.equal( recovered.attributesPrepared, 1 );
	const view = { attributes: [ { ...material.precompiledArtifact.attributes[ 0 ] } ] };
	applyMaterialComputeAttributeBindings( view, material );
	assert.equal( view.attributes[ 0 ]._liveAttribute, second );

} );

test( 'in-place artifact family growth invalidates a ready pair layout', async () => {

	const node = computeNode();
	const attr = storageAttribute();
	const artifact = { attributes: [ artifactEntry() ] };
	const material = precompiledMaterial( artifact, { positionNode: node } );
	const dispatcher = createAutoComputeDispatcher();
	const options = {
		fullRenderer: fullRendererFor( [ storageBinding( attr ) ] ),
		dispatchNode() {},
	};

	assert.equal( ( await dispatcher.dispatch( sceneWith( material ), options ) ).dispatched, 1 );
	artifact.variants = {
		late: { attributes: [ artifactEntry( { count: 5 } ) ] },
	};
	const changed = await dispatcher.dispatch( sceneWith( material ), options );
	assert.equal( changed.incomplete, 1 );
	assert.equal( changed.dispatched, 0 );

} );

test( 'resolver exceptions are contained and reported once', async () => {

	const node = computeNode();
	const attr = storageAttribute();
	const material = precompiledMaterial( { attributes: [ artifactEntry() ] }, { positionNode: node } );
	const errors = [];
	const stats = await createAutoComputeDispatcher( { onError: ( error ) => errors.push( error ) } ).dispatch( sceneWith( material ), {
		fullRenderer: fullRendererFor( [ storageBinding( attr ) ] ),
		resolveCandidate() { throw new Error( 'resolver failed' ); },
		dispatchNode() {},
	} );

	assert.equal( stats.dispatched, 0 );
	assert.equal( stats.errors, 1 );
	assert.equal( errors.length, 1 );
	assert.match( errors[ 0 ].message, /resolver failed/ );

} );

test( 'dispatcher wires every shared-node owner, dispatches once, and invalidates only once', async () => {

	const shared = computeNode();
	const attr = storageAttribute();
	const first = precompiledMaterial( { attributes: [ artifactEntry() ] }, { positionNode: shared } );
	const second = precompiledMaterial( { attributes: [ artifactEntry() ] }, { positionNode: shared } );
	let dispatches = 0;
	const dispatcher = createAutoComputeDispatcher();
	const options = {
		fullRenderer: fullRendererFor( [ storageBinding( attr ) ] ),
		dispatchNode() { dispatches ++; return { storageAttrs: 1 }; },
	};

	const firstStats = await dispatcher.dispatch( sceneWith( first, second ), options );
	const secondStats = await dispatcher.dispatch( sceneWith( first, second ), options );

	assert.equal( firstStats.owners, 2 );
	assert.equal( firstStats.nodes, 1 );
	assert.equal( firstStats.attributesPrepared, 2 );
	assert.equal( firstStats.invalidated, 2 );
	assert.equal( firstStats.dispatched, 1 );
	assert.equal( secondStats.attributesPrepared, 0 );
	assert.equal( secondStats.invalidated, 0 );
	assert.equal( secondStats.dispatched, 1 );
	assert.equal( dispatches, 2 );
	assert.equal( first.disposeCalls, 1 );
	assert.equal( second.disposeCalls, 1 );

	const replacement = storageAttribute();
	options.fullRenderer = fullRendererFor( [ storageBinding( replacement ) ] );
	const replaced = await dispatcher.dispatch( sceneWith( first, second ), options );
	assert.equal( replaced.attributesPrepared, 2 );
	assert.equal( replaced.invalidated, 2, 'same-layout buffer replacement refreshes both owner sidecars' );
	const firstView = { attributes: [ { ...first.precompiledArtifact.attributes[ 0 ] } ] };
	applyMaterialComputeAttributeBindings( firstView, first );
	assert.equal( firstView.attributes[ 0 ]._liveAttribute, replacement );

} );

test( 'transient compute-state failure remains retryable and prepares after bootstrap dispatch', async () => {

	const compute = computeNode();
	const attr = storageAttribute();
	const material = precompiledMaterial( { attributes: [ artifactEntry() ] }, { positionNode: compute } );
	let probes = 0;
	const full = {
		_nodes: {
			getForCompute() {

				probes ++;
				if ( probes === 1 ) throw new Error( 'not initialized' );
				return { bindings: [ { bindings: [ storageBinding( attr ) ] } ] };

			},
		},
	};
	let dispatches = 0;
	const dispatcher = createAutoComputeDispatcher();
	const stats = await dispatcher.dispatch( sceneWith( material ), {
		fullRenderer: full,
		dispatchNode() { dispatches ++; },
	} );

	assert.equal( stats.pending, 1 );
	assert.equal( stats.dispatched, 1 );
	assert.equal( stats.attributesPrepared, 1 );
	assert.equal( stats.invalidated, 1 );
	assert.equal( dispatches, 1 );
	assert.equal( material.disposeCalls, 1 );

} );

test( 'resetMaterial restores an exhausted bootstrap allowance', async () => {

	const node = computeNode();
	const material = precompiledMaterial( { attributes: [ artifactEntry() ] }, { positionNode: node } );
	const full = { _nodes: { getForCompute() { throw new Error( 'not ready' ); } } };
	let dispatches = 0;
	const dispatcher = createAutoComputeDispatcher( { maxBootstrapAttempts: 1 } );
	const options = { fullRenderer: full, dispatchNode() { dispatches ++; } };

	await dispatcher.dispatch( sceneWith( material ), options );
	await dispatcher.dispatch( sceneWith( material ), options );
	assert.equal( dispatches, 1 );
	dispatcher.resetMaterial( material );
	await dispatcher.dispatch( sceneWith( material ), options );
	assert.equal( dispatches, 2 );

} );

test( 'dispatcher does not dispatch an ambiguous owner and supports caller-owned once-only policy', async () => {

	const node = computeNode();
	const first = storageAttribute();
	const second = storageAttribute();
	const ambiguous = precompiledMaterial( { attributes: [ artifactEntry() ] }, { positionNode: node } );
	const errors = [];
	let dispatches = 0;
	const dispatcher = createAutoComputeDispatcher( { onError: ( error ) => errors.push( error ) } );
	const fullRenderer = fullRendererFor( [ storageBinding( first ), storageBinding( second ) ] );

	const rejected = await dispatcher.dispatch( sceneWith( ambiguous ), {
		fullRenderer,
		dispatchNode() { dispatches ++; },
	} );
	assert.equal( rejected.ambiguous, 1 );
	assert.equal( rejected.dispatched, 0 );
	assert.equal( errors[ 0 ].code, 'TSLP_AUTO_COMPUTE_AMBIGUOUS_OUTPUT' );

	const uniqueNode = computeNode( 'unique' );
	const unique = precompiledMaterial( { attributes: [ artifactEntry() ] }, { positionNode: uniqueNode } );
	const once = new Set();
	await dispatcher.dispatch( sceneWith( unique ), {
		fullRenderer: fullRendererFor( [ storageBinding( first ) ] ),
		dispatchOnce: once,
		dispatchNode() { dispatches ++; },
	} );
	const frozen = await dispatcher.dispatch( sceneWith( unique ), {
		fullRenderer: fullRendererFor( [ storageBinding( first ) ] ),
		dispatchOnce: once,
		dispatchNode() { dispatches ++; },
	} );
	assert.equal( dispatches, 1 );
	assert.equal( frozen.skipped, 1 );

} );

test( 'multiple raw compute owners fail with an explicit ownership-contract diagnostic', async () => {

	const firstNode = computeNode( 'first' );
	const secondNode = computeNode( 'second' );
	const first = storageAttribute();
	const second = storageAttribute( { count: 2 } );
	const material = precompiledMaterial( {
		attributes: [ artifactEntry(), artifactEntry( { name: 'nodeAttribute1', count: 2 } ) ],
	}, { positionNode: firstNode, vertexNode: secondNode } );
	const errors = [];
	const stats = await createAutoComputeDispatcher( { onError: ( error ) => errors.push( error ) } ).dispatch( sceneWith( material ), {
		fullRenderer: fullRendererFor( ( node ) => [ storageBinding( node === firstNode ? first : second ) ] ),
		dispatchNode() {},
	} );

	assert.equal( stats.incomplete, 2 );
	assert.equal( stats.dispatched, 0 );
	assert.equal( errors.length, 2 );
	assert.equal( errors.every( ( error ) => error.code === 'TSLP_AUTO_COMPUTE_MULTIPLE_OWNERS_UNSUPPORTED' ), true );

} );
