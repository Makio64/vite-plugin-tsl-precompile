import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneBindingRecordFromDescriptors } from '../src/hydrate/binding-record-clone.js';
import { createHydrationBindingArtifactView } from '../src/hydrate/user-attributes.js';

test( 'record cloning preserves symbols, inherited names and property descriptors without reading getters', () => {

	const symbol = Symbol( 'binding' );
	const record = { name: 'buffer', [ symbol ]: 7 };
	Object.defineProperty( record, '__proto__', { value: { authored: true }, enumerable: true, configurable: true, writable: true } );
	const ordinary = cloneBindingRecordFromDescriptors( Object.getPrototypeOf( record ), Object.getOwnPropertyDescriptors( record ) );
	assert.deepEqual( Object.getOwnPropertyDescriptors( ordinary ), Object.getOwnPropertyDescriptors( record ) );
	assert.equal( Object.getPrototypeOf( ordinary ), Object.prototype );
	let reads = 0;
	const lazy = Object.create( null );
	Object.defineProperty( lazy, 'snapshot', { get() { reads ++; return [ 1, 2 ]; }, enumerable: true } );
	Object.defineProperty( lazy, symbol, { value: 'hidden', writable: false } );
	const clone = cloneBindingRecordFromDescriptors( null, Object.getOwnPropertyDescriptors( Object.freeze( lazy ) ) );
	assert.equal( reads, 0 );
	assert.deepEqual( Object.getOwnPropertyDescriptors( clone ), Object.getOwnPropertyDescriptors( lazy ) );
	assert.equal( Object.getPrototypeOf( clone ), null );
	assert.deepEqual( clone.snapshot, [ 1, 2 ] );
	assert.equal( reads, 1 );

} );

test( 'ordinary record cloning bypasses inherited setters without changing the prototype', () => {

	const key = '__tslpCloneInheritedSetter';
	let writes = 0;
	Object.defineProperty( Object.prototype, key, { set() { writes ++; }, configurable: true } );
	try {

		const record = {};
		Object.defineProperty( record, key, { value: 9, enumerable: true, configurable: true, writable: true } );
		const clone = cloneBindingRecordFromDescriptors( Object.prototype, Object.getOwnPropertyDescriptors( record ) );
		assert.equal( writes, 0 );
		assert.equal( clone[ key ], 9 );
		assert.deepEqual( Object.getOwnPropertyDescriptors( clone ), Object.getOwnPropertyDescriptors( record ) );

	} finally { delete Object.prototype[ key ]; }

} );

test( 'hydration views preserve lazy frozen records, within-view aliases and independent live sidecar owners', () => {

	let snapshotReads = 0;
	const liveAttribute = { array: new Float32Array( [ 1, 2, 3, 4 ] ), itemSize: 4, count: 1, isStorageBufferAttribute: true };
	const record = { name: 'values', count: 1, itemSize: 4, arrayType: 'Float32Array' };
	Object.defineProperty( record, 'arraySnapshot', { get() { snapshotReads ++; return [ 1, 2, 3, 4 ]; }, enumerable: true } );
	Object.defineProperty( record, '_liveAttribute', { value: liveAttribute } );
	Object.freeze( record );
	const source = Object.freeze( { kind: 'uniform.live', property: 'gain' } );
	const slot = { name: 'gain', source };
	Object.defineProperty( slot, '_liveNode', { value: { value: 0.25 } } );
	Object.freeze( slot );
	const artifact = { attributes: [ record ], nodeAttributes: [ record ], uniformPlan: [ {
		name: 'object', storageBuffers: [ record ], slots: [ slot, slot ],
		orderedBindings: [ { type: 'storage-buffer', ref: record } ],
	} ] };
	Object.defineProperty( artifact, '_textureRefs', { value: new Map(), configurable: true, writable: true } );
	const a = createHydrationBindingArtifactView( artifact );
	const b = createHydrationBindingArtifactView( artifact );
	assert.equal( snapshotReads, 0 );
	assert.equal( a.attributes[ 0 ], a.nodeAttributes[ 0 ] );
	assert.equal( a.attributes[ 0 ], a.uniformPlan[ 0 ].storageBuffers[ 0 ] );
	assert.equal( a.attributes[ 0 ], a.uniformPlan[ 0 ].orderedBindings[ 0 ].ref );
	assert.equal( a.uniformPlan[ 0 ].slots[ 0 ], a.uniformPlan[ 0 ].slots[ 1 ] );
	assert.notEqual( a.attributes[ 0 ], b.attributes[ 0 ] );
	assert.notEqual( a.uniformPlan[ 0 ].slots[ 0 ], b.uniformPlan[ 0 ].slots[ 0 ] );
	assert.notEqual( a.uniformPlan[ 0 ].slots[ 0 ].source, b.uniformPlan[ 0 ].slots[ 0 ].source );
	a.attributes[ 0 ]._liveAttribute = { owner: 'a' };
	a.uniformPlan[ 0 ].slots[ 0 ]._liveNode = { value: 0.75 };
	assert.equal( b.attributes[ 0 ]._liveAttribute, liveAttribute );
	assert.equal( b.uniformPlan[ 0 ].slots[ 0 ]._liveNode.value, 0.25 );
	assert.equal( record._liveAttribute, liveAttribute );
	assert.equal( slot._liveNode.value, 0.25 );
	assert.equal( Object.getOwnPropertyDescriptor( a.attributes[ 0 ], 'arraySnapshot' ).get, Object.getOwnPropertyDescriptor( record, 'arraySnapshot' ).get );
	assert.deepEqual( a.attributes[ 0 ].arraySnapshot, [ 1, 2, 3, 4 ] );
	assert.equal( snapshotReads, 1 );
	const refs = new Map( [ [ 'late', {} ] ] );
	a._textureRefs = refs;
	assert.equal( artifact._textureRefs, refs );
	assert.equal( b._textureRefs, refs );
	const reset = createHydrationBindingArtifactView( artifact, { resetLiveNodeSidecars: true } );
	assert.equal( reset.attributes[ 0 ]._liveAttribute, undefined );
	assert.equal( reset.uniformPlan[ 0 ].slots[ 0 ]._liveNode, undefined );
	assert.equal( slot._liveNode.value, 0.25 );

} );
