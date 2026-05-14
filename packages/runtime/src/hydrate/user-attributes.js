/**
 * Bind live `BufferAttribute` / `StorageBufferAttribute` instances from the
 * user's `*Node` material props (e.g. `material.positionNode = instancedBufferAttribute(buf)`)
 * onto the precompiled artifact's node-attribute and storage-buffer entries
 * before the hydrator walks them.
 *
 * Two related operations live here:
 *
 *   1. `bindUserNodeAttributesToArtifact()` — for vertex/instance attribute
 *      bindings reached through `BufferAttributeNode`. Walks `material.*Node`
 *      properties looking for nodes whose `.attribute` or `.value` matches
 *      the artifact entry's shape (item size, count, typed-array kind).
 *      Includes a special-case for `InstancedMesh.instanceMatrix` (split into
 *      4× vec4 columns) and `instanceColor`.
 *   2. `bindUserStorageBuffersToArtifact()` — same shape, but matches
 *      `StorageBufferNode.value` for compute-kernel-written buffers the
 *      render side reads via `material.colorNode = colors.element( i )`.
 *
 * Both are idempotent and a no-op when capture didn't record `userPath` or
 * the material has no matching node tree yet. They mutate the artifact's
 * `attributes[i]._liveAttribute` / `storageBuffers[i]._liveAttribute` via
 * non-enumerable `Object.defineProperty` so JSON serialisation doesn't pick
 * them up.
 *
 * `hydrateNodeAttributes()` then materialises a fresh per-render array from
 * those entries: bound live attribute → reuse it; missing → allocate a fresh
 * empty `StorageBufferAttribute` of the right shape so pipeline-layout
 * validation still passes.
 *
 * @module Hydrate.UserAttributes
 */

import { BufferAttribute, InstancedBufferAttribute } from 'three';
import StorageBufferAttribute from 'three/src/renderers/common/StorageBufferAttribute.js';
import StorageInstancedBufferAttribute from 'three/src/renderers/common/StorageInstancedBufferAttribute.js';

import { resolveTypedArrayCtor } from './typed-arrays.js';

/**
 * Walk every `attributes[]` / `nodeAttributes[]` entry in the artifact and
 * seed `entry._liveAttribute` from the user material's TSL node graph.
 *
 * @param {Object} artifact
 * @param {?Object} sourceMaterial
 */
export function bindUserNodeAttributesToArtifact( artifact, sourceMaterial ) {

	if ( ! sourceMaterial ) return;
	const entries = Array.isArray( artifact.attributes )
		? artifact.attributes
		: Array.isArray( artifact.nodeAttributes ) ? artifact.nodeAttributes : null;
	if ( ! entries || entries.length === 0 ) return;

	let nodeRoots = null;
	const collectNodeRoots = () => {

		if ( nodeRoots ) return nodeRoots;
		nodeRoots = [];
		for ( const key in sourceMaterial ) {

			const v = sourceMaterial[ key ];
			if ( v && v.isNode === true ) nodeRoots.push( v );

		}
		return nodeRoots;

	};

	const sourceObject = sourceMaterial.__tslpPrecompileObject || null;

	for ( const entry of entries ) {

		if ( ! entry || entry.source !== 'node' ) continue;
		if ( entry._liveAttribute && entry._liveAttribute.isBufferAttribute === true ) continue;
		if ( ! entry.userPath && entry.arraySnapshot ) continue;

		let live = null;
		const path = entry.userPath;
		if ( Array.isArray( path ) && path.length > 0 ) {

			const root = sourceMaterial[ path[ 0 ] ];
			if ( root && root.isNode === true ) live = findFirstAttributeMatchingEntry( root, entry );

		}

		if ( ! live ) {

			for ( const root of collectNodeRoots() ) {

				live = findFirstAttributeMatchingEntry( root, entry );
				if ( live ) break;

			}

		}

		if ( ! live ) live = findInstancedObjectAttributeMatchingEntry( sourceObject, entry, entries );
		if ( ! live ) continue;

		Object.defineProperty( entry, '_liveAttribute', {
			value: live,
			enumerable: false,
			configurable: true,
			writable: true,
		} );

	}

}

/**
 * Anonymous captured instanced attributes are self-contained artifact data.
 * If a fresh replay page procedurally rebuilds a different object.count, the
 * renderer will draw the right buffers with the wrong instance count. Restore
 * the captured count when every captured anonymous instanced attribute agrees.
 *
 * @param {Object} artifact
 * @param {?Object} object
 * @returns {boolean} true when a count was applied
 */
export function applyCapturedInstancedDrawCount( artifact, object ) {

	if ( ! object ) return false;
	const count = capturedAnonymousInstancedCount( artifact );
	if ( count === null ) return false;

	const geometry = object.geometry || null;
	if ( geometry && geometry.isInstancedBufferGeometry === true ) {

		if ( geometry.instanceCount !== count ) geometry.instanceCount = count;
		return true;

	}

	if ( object.count !== count ) object.count = count;
	return true;

}

function capturedAnonymousInstancedCount( artifact ) {

	const entries = Array.isArray( artifact && artifact.attributes )
		? artifact.attributes
		: Array.isArray( artifact && artifact.nodeAttributes ) ? artifact.nodeAttributes : null;
	if ( ! entries || entries.length === 0 ) return null;

	let count = null;
	for ( const entry of entries ) {

		if ( ! entry || entry.source !== 'node' || entry.instanced !== true ) continue;
		if ( entry.userPath ) continue;
		if ( ! entry.arraySnapshot && ! entry._liveArray ) continue;
		if ( ! Number.isFinite( entry.count ) || entry.count <= 0 ) continue;
		if ( count === null ) count = entry.count;
		else if ( count !== entry.count ) return null;

	}
	return count;

}

function findInstancedObjectAttributeMatchingEntry( object, entry, entries ) {

	if ( ! object || object.isInstancedMesh !== true ) return null;
	const count = object.count || 0;
	if ( ! count || entry.count !== count ) return null;
	const itemSize = entry.itemSize || itemSizeFromAttributeType( entry.type );

	if ( object.instanceColor && object.instanceColor.isBufferAttribute === true ) {

		const color = object.instanceColor;
		if ( itemSize === color.itemSize ) return color;

	}

	if ( itemSize !== 4 || ! object.instanceMatrix || ! object.instanceMatrix.array ) return null;

	const matrixEntries = entries.filter( ( candidate ) => {

		if ( ! candidate || candidate.source !== 'node' ) return false;
		if ( candidate.count !== count ) return false;
		const size = candidate.itemSize || itemSizeFromAttributeType( candidate.type );
		return size === 4;

	} );
	const column = matrixEntries.indexOf( entry );
	if ( column < 0 || column > 3 ) return null;

	return getInstancedMatrixColumnAttribute( object, column );

}

function getInstancedMatrixColumnAttribute( object, column ) {

	const source = object && object.instanceMatrix;
	const sourceArray = source && source.array;
	const count = object && object.count || 0;
	if ( ! sourceArray || ! count ) return null;

	const cacheKey = '__tslpMatrixColumnAttributes';
	let cache = object[ cacheKey ];
	if ( ! cache || cache.sourceArray !== sourceArray || cache.count !== count ) {

		cache = {
			sourceArray,
			count,
			attributes: [
				new InstancedBufferAttribute( new Float32Array( count * 4 ), 4 ),
				new InstancedBufferAttribute( new Float32Array( count * 4 ), 4 ),
				new InstancedBufferAttribute( new Float32Array( count * 4 ), 4 ),
				new InstancedBufferAttribute( new Float32Array( count * 4 ), 4 ),
			],
		};
		for ( const attribute of cache.attributes ) attribute.needsUpdate = true;
		try { Object.defineProperty( object, cacheKey, { value: cache, configurable: true } ); } catch ( _ ) { object[ cacheKey ] = cache; }

	}

	const attribute = cache.attributes[ column ];
	const dst = attribute && attribute.array;
	if ( ! dst ) return null;
	for ( let i = 0; i < count; i ++ ) {

		const srcOffset = i * 16 + column * 4;
		const dstOffset = i * 4;
		dst[ dstOffset + 0 ] = sourceArray[ srcOffset + 0 ];
		dst[ dstOffset + 1 ] = sourceArray[ srcOffset + 1 ];
		dst[ dstOffset + 2 ] = sourceArray[ srcOffset + 2 ];
		dst[ dstOffset + 3 ] = sourceArray[ srcOffset + 3 ];

	}
	attribute.needsUpdate = true;
	return attribute;

}

function findFirstAttributeMatchingEntry( node, entry ) {

	const wantSize = entry.itemSize || 0;
	const wantCount = entry.count || 0;
	const wantArray = entry.arrayType || '';

	let found = null;
	const probe = ( n ) => {

		if ( found || ! n ) return;
		const cands = [ n.attribute, n.value ];
		for ( const cand of cands ) {

			if ( ! cand || cand.isBufferAttribute !== true ) continue;
			// vec3 storage attributes get padded to itemSize=4 when WebGPU
			// touches them. Accept (3 → 4) so a freshly-built live attribute
			// matches an artifact entry recorded after the pad fired.
			if ( wantSize && cand.itemSize !== wantSize
				&& ! ( cand.itemSize === 3 && wantSize === 4 ) ) continue;
			if ( wantCount && cand.count !== wantCount ) continue;
			if ( wantArray
				&& cand.array
				&& cand.array.constructor
				&& cand.array.constructor.name !== wantArray ) continue;
			found = cand;
			return;

		}

	};

	probe( node );
	if ( ! found && typeof node.traverse === 'function' ) node.traverse( probe );
	return found;

}

/**
 * Walk every `storageBuffers[]` entry in `artifact.uniformPlan` and seed
 * `entry._liveAttribute` from the user material's TSL node graph.
 *
 * Compute kernels write into `instancedArray(...)` storage buffers; the
 * render side reads them via `material.colorNode = colors.element( i )`
 * (etc.) — same node-tree walk pattern as `bindUserNodeAttributesToArtifact`,
 * but matching against `StorageBufferNode.value` instead of
 * `BufferAttributeNode.attribute/value`. Without this the hydrator's
 * storage-buffer wiring at `createBindingFromDescriptor` allocates a fresh
 * empty `StorageBufferAttribute` and the compute output is invisible to
 * the render path.
 *
 * @param {Object} artifact
 * @param {?Object} sourceMaterial
 */
export function bindUserStorageBuffersToArtifact( artifact, sourceMaterial ) {

	if ( ! sourceMaterial ) return;
	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : null;
	if ( ! plan || plan.length === 0 ) return;

	let nodeRoots = null;
	const collectNodeRoots = () => {

		if ( nodeRoots ) return nodeRoots;
		nodeRoots = [];
		for ( const key in sourceMaterial ) {

			const v = sourceMaterial[ key ];
			if ( v && v.isNode === true ) nodeRoots.push( v );

		}
		return nodeRoots;

	};

	for ( const group of plan ) {

		const entries = group && Array.isArray( group.storageBuffers ) ? group.storageBuffers : null;
		if ( ! entries || entries.length === 0 ) continue;
		for ( const entry of entries ) {

			if ( ! entry ) continue;
			if ( entry._liveAttribute
				&& entry._liveAttribute.array
				&& ArrayBuffer.isView( entry._liveAttribute.array ) ) continue;

			let live = null;
			const path = entry.userPath;
			if ( Array.isArray( path ) && path.length > 0 ) {

				const root = sourceMaterial[ path[ 0 ] ];
				if ( root && root.isNode === true ) {

					live = findFirstAttributeMatchingEntry( root, entry );

				}

			}

			if ( ! live ) {

				for ( const root of collectNodeRoots() ) {

					live = findFirstAttributeMatchingEntry( root, entry );
					if ( live ) break;

				}

			}

			if ( ! live ) continue;

			Object.defineProperty( entry, '_liveAttribute', {
				value: live,
				enumerable: false,
				configurable: true,
				writable: true,
			} );

		}

	}

}

/**
 * Materialise a fresh per-render array of attribute descriptors from the
 * artifact's `attributes[]`. Bound live attributes pass through directly;
 * missing ones get a fresh empty `StorageBufferAttribute` of the correct
 * shape so pipeline-layout validation passes (the kernel/compute path
 * later writes into it).
 *
 * @param {?Array<Object>} attributes
 * @returns {Array<Object>}
 */
export function hydrateNodeAttributes( attributes ) {

	if ( ! Array.isArray( attributes ) ) return [];

	return attributes.map( ( attribute ) => {

		if ( ! attribute || attribute.source !== 'node' ) return attribute;

		const hasCapturedAnonymousSnapshot = ! attribute.userPath && ( attribute.arraySnapshot || attribute._liveArray );
		const liveAttribute = hasCapturedAnonymousSnapshot
			? null
			: attribute._liveAttribute || ( attribute.node && attribute.node.attribute );
		if ( liveAttribute ) return { ...attribute, node: { attribute: liveAttribute } };

		const itemSize = attribute.itemSize || itemSizeFromAttributeType( attribute.type );
		const count = Math.max( 1, attribute.count || 1 );
		const TypeArray = resolveTypedArrayCtor( attribute.arrayType );
		const fallbackAttribute = createFallbackNodeAttribute( attribute, count, itemSize, TypeArray );
		seedAttributeArray( fallbackAttribute, attribute.arraySnapshot || attribute._liveArray );

		return {
			...attribute,
			node: {
				attribute: fallbackAttribute,
			},
		};

	} );

}

function createFallbackNodeAttribute( entry, count, itemSize, TypeArray ) {

	let attribute;
	const normalized = entry.normalized === true;
	if ( entry.storage === true && entry.instanced === true ) {

		attribute = new StorageInstancedBufferAttribute( count, itemSize, TypeArray );

	} else if ( entry.storage === true || ( entry.instanced !== true && entry.storage !== false ) ) {

		attribute = new StorageBufferAttribute( count, itemSize, TypeArray );

	} else if ( entry.instanced === true ) {

		attribute = new InstancedBufferAttribute( new TypeArray( count * itemSize ), itemSize, normalized, entry.meshPerAttribute || 1 );

	} else {

		attribute = new BufferAttribute( new TypeArray( count * itemSize ), itemSize, normalized );

	}

	if ( typeof entry.usage === 'number' && typeof attribute.setUsage === 'function' ) attribute.setUsage( entry.usage );
	return attribute;

}

function seedAttributeArray( attribute, sourceArray ) {

	if ( ! attribute || ! attribute.array || ! sourceArray ) return attribute;

	if ( ArrayBuffer.isView( sourceArray ) || Array.isArray( sourceArray ) ) {

		attribute.array.set( sourceArray.slice ? sourceArray.slice( 0, attribute.array.length ) : sourceArray.subarray( 0, attribute.array.length ) );
		attribute.needsUpdate = true;
		return attribute;

	}

	if ( typeof sourceArray === 'object' ) {

		for ( const key of Object.keys( sourceArray ) ) {

			const index = + key;
			if ( index >= 0 && index < attribute.array.length ) attribute.array[ index ] = sourceArray[ key ];

		}
		attribute.needsUpdate = true;

	}

	return attribute;

}

/**
 * Map a TSL attribute type string (`vec2` / `vec3` / `vec4` / `int` / ...)
 * to its WebGPU item count.
 *
 * @param {string} type
 * @returns {number}
 */
export function itemSizeFromAttributeType( type ) {

	switch ( type ) {

		case 'float':
		case 'number':
		case 'int':
		case 'uint':
			return 1;
		case 'vec2':
		case 'ivec2':
		case 'uvec2':
			return 2;
		case 'vec4':
		case 'ivec4':
		case 'uvec4':
			return 4;
		case 'vec3':
		case 'ivec3':
		case 'uvec3':
		default:
			return 3;

	}

}
