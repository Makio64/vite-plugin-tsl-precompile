import StorageBuffer from 'three/src/renderers/common/StorageBuffer.js';
import StorageBufferAttribute from 'three/src/renderers/common/StorageBufferAttribute.js';
import { validateStorageBufferSnapshot } from '@tsl-precompile/contract/dynamic-bindings';

import { resolveTypedArrayCtor } from '../typed-arrays.js';

export function createStorageBufferBinding( {
	artifact,
	groupName,
	descriptor,
	name,
	groupNode = null,
	deps,
} ) {

	const { resolvePlanStorageBuffer } = deps;
	const entry = resolvePlanStorageBuffer( artifact, groupName, name );
	const attribute = resolveStorageBufferAttribute( entry );
	const storageBuffer = new StorageBuffer( name, attribute );
	storageBuffer.access = descriptor.access || 'read_write';
	storageBuffer.visibility = descriptor.visibility | 0;
	storageBuffer.groupNode = groupNode;
	return storageBuffer;

}

export function resolveStorageBufferAttribute( entry ) {

	const liveAttribute = entry && entry._liveAttribute;
	if ( isLiveStorageBufferAttribute( liveAttribute ) ) return liveAttribute;

	const count = entry ? ( entry.count || 1 ) : 1;
	const itemSize = entry ? ( entry.itemSize || 1 ) : 1;
	const TypedArray = resolveTypedArrayCtor( entry ? entry.arrayType : null );
	const attribute = new StorageBufferAttribute( count, itemSize, TypedArray );
	seedStorageBufferAttribute( attribute, storageBufferInitialArray( entry ) );
	return attribute;

}

function storageBufferInitialArray( entry ) {

	if ( ! entry ) return null;
	if ( entry._liveArray ) return entry._liveArray;
	if ( entry.arraySnapshot === undefined && entry.arraySnapshotHash === undefined ) return null;
	const errors = validateStorageBufferSnapshot( entry );
	if ( errors.length > 0 ) throw new Error(
		`[tsl-precompile/slim] Invalid storage-buffer initial snapshot: ${ errors.map( ( error ) => error.message ).join( '; ' ) }.`,
	);
	return entry.arraySnapshot;

}

export function isLiveStorageBufferAttribute( attribute ) {

	return !! ( attribute && attribute.array && ArrayBuffer.isView( attribute.array ) );

}

export function seedStorageBufferAttribute( attribute, sourceArray ) {

	if ( ! attribute || ! attribute.array || ! sourceArray ) return attribute;

	if ( ArrayBuffer.isView( sourceArray ) ) {

		attribute.array.set( sourceArray.subarray( 0, attribute.array.length ) );
		return attribute;

	}

	if ( typeof sourceArray === 'object' ) {

		for ( const key of Object.keys( sourceArray ) ) {

			const index = + key;
			if ( index >= 0 && index < attribute.array.length ) attribute.array[ index ] = sourceArray[ key ];

		}

	}

	return attribute;

}
