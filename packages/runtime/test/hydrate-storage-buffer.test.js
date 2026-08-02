import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageBufferSnapshotHash } from '@tsl-precompile/contract/dynamic-bindings';

import {
	createStorageBufferBinding,
	resolveStorageBufferAttribute,
} from '../src/hydrate/kinds/storage-buffer.js';

test( 'storage buffer kind reuses live attributes with typed-array backing', () => {

	const liveArray = new Float32Array( [ 1, 2, 3, 4, 5, 6 ] );
	const liveAttribute = { array: liveArray, count: 2, itemSize: 3, isStorageBufferAttribute: true };
	const entry = { name: 'particles', arrayType: 'Float32Array', count: 2, itemSize: 3 };
	Object.defineProperty( entry, '_liveAttribute', { value: liveAttribute } );
	const groupNode = { id: 'group' };
	let resolverCall = null;

	const binding = createStorageBufferBinding( {
		artifact: { id: 'artifact' },
		groupName: 'compute',
		descriptor: { kind: 'storage-buffer', name: 'particles', visibility: 4, access: 'read' },
		name: 'particles',
		groupNode,
		deps: {
			resolvePlanStorageBuffer: ( artifact, groupName, bindingName ) => {

				resolverCall = { artifact, groupName, bindingName };
				return entry;

			},
		},
	} );

	assert.equal( binding.isStorageBuffer, true );
	assert.equal( binding.name, 'particles' );
	assert.equal( binding.attribute, liveAttribute );
	assert.equal( binding.access, 'read' );
	assert.equal( binding.visibility, 4 );
	assert.equal( binding.groupNode, groupNode );
	assert.deepEqual( resolverCall, {
		artifact: { id: 'artifact' },
		groupName: 'compute',
		bindingName: 'particles',
	} );

} );

test( 'storage buffer kind allocates and seeds from JSON object live arrays', () => {

	const entry = {
		name: 'verts',
		arrayType: 'Uint16Array',
		count: 2,
		itemSize: 3,
	};
	Object.defineProperty( entry, '_liveArray', {
		value: { 0: 10, 1: 11, 2: 12, 3: 13, 10: 99 },
	} );

	const attribute = resolveStorageBufferAttribute( entry );

	assert.equal( attribute.isStorageBufferAttribute, true );
	assert.equal( attribute.count, 2 );
	assert.equal( attribute.itemSize, 3 );
	assert.equal( attribute.array.constructor, Uint16Array );
	assert.deepEqual( Array.from( attribute.array ), [ 10, 11, 12, 13, 0, 0 ] );

} );

test( 'storage buffer kind seeds allocated attributes from typed live arrays', () => {

	const entry = {
		name: 'values',
		arrayType: 'Float32Array',
		count: 1,
		itemSize: 4,
	};
	Object.defineProperty( entry, '_liveAttribute', {
		value: { array: [ 1, 2, 3, 4 ], count: 1, itemSize: 4, isStorageBufferAttribute: true },
	} );
	Object.defineProperty( entry, '_liveArray', {
		value: new Float32Array( [ 5, 6, 7, 8, 9 ] ),
	} );

	const attribute = resolveStorageBufferAttribute( entry );

	assert.equal( attribute.array.constructor, Float32Array );
	assert.deepEqual( Array.from( attribute.array ), [ 5, 6, 7, 8 ] );

} );

test( 'storage buffer kind seeds exact persisted initial snapshots after JSON roundtrip', () => {

	const entry = {
		name: 'meshletIds',
		arrayType: 'Uint32Array',
		count: 4,
		itemSize: 1,
		arraySnapshot: [ 0, 12, 7, 99 ],
	};
	entry.arraySnapshotHash = createStorageBufferSnapshotHash( entry );
	const persisted = JSON.parse( JSON.stringify( entry ) );

	const attribute = resolveStorageBufferAttribute( persisted );

	assert.equal( attribute.array.constructor, Uint32Array );
	assert.deepEqual( Array.from( attribute.array ), [ 0, 12, 7, 99 ] );

} );

test( 'storage buffer kind rejects tampered persisted snapshots before allocation is used', () => {

	const entry = {
		name: 'uvs',
		arrayType: 'Float32Array',
		count: 2,
		itemSize: 2,
		arraySnapshot: [ 0, 0.25, 0.5, 1 ],
	};
	entry.arraySnapshotHash = createStorageBufferSnapshotHash( entry );
	entry.arraySnapshot[ 1 ] = 0.75;

	assert.throws(
		() => resolveStorageBufferAttribute( entry ),
		/Invalid storage-buffer initial snapshot.*does not match/,
	);

} );
