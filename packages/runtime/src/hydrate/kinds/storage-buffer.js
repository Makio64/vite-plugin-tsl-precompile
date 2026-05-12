import StorageBuffer from 'three/src/renderers/common/StorageBuffer.js';
import StorageBufferAttribute from 'three/src/renderers/common/StorageBufferAttribute.js';

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
	seedStorageBufferAttribute( attribute, entry && entry._liveArray );
	return attribute;

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
