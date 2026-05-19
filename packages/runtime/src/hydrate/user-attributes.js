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

import { BufferAttribute, InstancedBufferAttribute, InstancedInterleavedBuffer, InterleavedBufferAttribute } from 'three';
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
	const pathShapeSlots = new Map();

	// Wave 5 Phase B2 — anonymous storage attribute live binding.
	// Before the snapshot-fallback skip below, also try to find a LIVE
	// storage/instanced-storage attribute in the source material's node
	// graph via DFS-encounter-order. This catches compute-driven
	// attributes (webgpu_compute_birds + compute_particles family) where:
	//   - `userPath` is absent (compute output flows through Fn closures)
	//   - `arraySnapshot` is present (extractor's fallback)
	//   - the LIVE source material's node tree DOES expose a
	//     StorageInstancedBufferAttribute or StorageBufferAttribute
	//
	// When found, set `_liveAttribute` so the snapshot fallback in
	// `hydrateNodeAttributes` defers to the live data (compute kernel
	// keeps writing each frame). Bump the attribute's `version` so slim's
	// bind-group cache rebuilds against the live GPU buffer.
	const anonStorageCandidates = new Map();
	let anonStorageDfsIndex = 0;
	const collectStorageFromRoots = () => {

		if ( anonStorageCandidates.size > 0 ) return; // memoise
		for ( const root of collectNodeRoots() ) {

			collectStorageAttributesInOrder( root, anonStorageCandidates, { dfsIndex: () => anonStorageDfsIndex ++ } );

		}

	};
	let anonStorageShapeIndex = new Map();

	for ( const entry of entries ) {

		if ( ! entry || entry.source !== 'node' ) continue;
		if ( entry._liveAttribute && entry._liveAttribute.isBufferAttribute === true ) continue;

		// Anonymous + snapshot path: prefer object-owned instancing attributes
		// (InstancedMesh.instanceMatrix columns) when the entry was captured as
		// a non-storage instanced attribute; otherwise try the live storage
		// lookup. webgpu_compute_birds is the canary — its 4 anonymous vec4
		// entries are the 4 columns of instanceMatrix and shape-match
		// positionStorage/velocityStorage by accident. Without the storage-flag
		// gate the bird mesh gets smeared by storage values.
		if ( ! entry.userPath && entry.arraySnapshot ) {

			if ( entry.storage === false ) {

				const instancedObjectAttribute = findInstancedObjectAttributeMatchingEntry( sourceObject, entry, entries );
				if ( instancedObjectAttribute ) {

					Object.defineProperty( entry, '_liveAttribute', {
						value: instancedObjectAttribute,
						enumerable: false,
						configurable: true,
						writable: true,
					} );
					Object.defineProperty( entry, '_liveAttributeSource', {
						value: 'instancedObject',
						enumerable: false,
						configurable: true,
						writable: true,
					} );

				}

			} else {

				collectStorageFromRoots();
				const shapeKey = entry.itemSize + ':' + entry.count + ':' + ( entry.arrayType || '' );
				const slotIdx = anonStorageShapeIndex.get( shapeKey ) || 0;
				anonStorageShapeIndex.set( shapeKey, slotIdx + 1 );
				const matchingStorage = findNthStorageMatchingShape( anonStorageCandidates, entry, slotIdx );
				if ( matchingStorage ) {

					Object.defineProperty( entry, '_liveAttribute', {
						value: matchingStorage,
						enumerable: false,
						configurable: true,
						writable: true,
					} );
					// Force bind-group rebuild: slim's `Bindings._update` only
					// rebuilds when `binding.version !== attribute.version`. The
					// compute kernel doesn't bump `version` on its own — bump
					// here so the bind group picks up the live buffer on the
					// first hydrate.
					if ( typeof matchingStorage.version === 'number' ) matchingStorage.version = matchingStorage.version + 1;

				}

			}

			if ( ! entry._liveAttribute ) {

				const instancedObjectAttribute = findInstancedObjectAttributeMatchingEntry( sourceObject, entry, entries );
				if ( instancedObjectAttribute ) {

					Object.defineProperty( entry, '_liveAttribute', {
						value: instancedObjectAttribute,
						enumerable: false,
						configurable: true,
						writable: true,
					} );
					Object.defineProperty( entry, '_liveAttributeSource', {
						value: 'instancedObject',
						enumerable: false,
						configurable: true,
						writable: true,
					} );

				}

			}
			continue;

		}

		let live = null;
		const path = entry.userPath;
		if ( Array.isArray( path ) && path.length > 0 ) {

			const slotIdx = nextAttributeShapeSlot( pathShapeSlots, path, entry );
			const root = sourceMaterial[ path[ 0 ] ];
			if ( root && root.isNode === true ) live = findNthAttributeMatchingEntry( root, entry, slotIdx );

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
 * Storage-backed attributes are different: their entry count is buffer
 * capacity, not necessarily draw count. Compute particle examples often keep
 * 50k slots but draw a live subset with object.count, so those must preserve
 * the rebuilt object's count.
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
		if ( entry.storage === true ) continue;
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
	if ( matrixEntries.length !== 4 ) return null;
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

	return findNthAttributeMatchingEntry( node, entry, 0 );

}

function findNthAttributeMatchingEntry( node, entry, slotIdx = 0 ) {

	const matching = collectAttributesMatchingEntry( node, entry );
	if ( matching.length === 0 ) return null;
	if ( slotIdx >= matching.length ) return matching[ matching.length - 1 ];
	return matching[ slotIdx ];

}

function collectAttributesMatchingEntry( node, entry ) {

	const wantSize = entry.itemSize || 0;
	const wantCount = entry.count || 0;
	const wantArray = entry.arrayType || '';

	const matching = [];
	const seen = new Set();
	const probe = ( n ) => {

		if ( ! n ) return;
		const cands = [ n.attribute, n.value ];
		for ( const cand of cands ) {

			if ( ! cand || cand.isBufferAttribute !== true ) continue;
			if ( seen.has( cand ) ) continue;
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
			seen.add( cand );
			matching.push( cand );

		}

	};

	probe( node );
	if ( typeof node.traverse === 'function' ) node.traverse( probe );
	return matching;

}

function nextAttributeShapeSlot( slots, path, entry ) {

	const key = `${ JSON.stringify( path ) }|${ attributeShapeKey( entry ) }`;
	const slot = slots.get( key ) || 0;
	slots.set( key, slot + 1 );
	return slot;

}

function attributeShapeKey( entry ) {

	const itemSize = entry.itemSize || itemSizeFromAttributeType( entry.type );
	return [
		itemSize || 0,
		entry.count || 0,
		entry.arrayType || '',
		entry.instanced === true ? 'i' : 'a',
		entry.storage === true ? 's' : 'b',
	].join( ':' );

}

/**
 * Wave 5 Phase B2 — DFS-walk a node tree collecting StorageBufferAttribute /
 * StorageInstancedBufferAttribute candidates in encounter order. Used to
 * disambiguate multiple same-shape compute-driven attributes (e.g.
 * webgpu_compute_birds: 4 anonymous vec4 entries — position, velocity, …
 * — each backed by a distinct compute storage buffer).
 *
 * @param {?Object} node - The TSL node tree root (e.g. material.colorNode)
 * @param {Map<Object, { index: number }>} candidates - accumulator, keyed by
 *   live attribute reference to dedupe across passes
 * @param {{ dfsIndex: () => number }} ctx - shared encounter-index counter
 */
function collectStorageAttributesInOrder( node, candidates, ctx ) {

	const visit = ( n ) => {

		if ( ! n ) return;
		const cands = [ n.attribute, n.value ];
		for ( const cand of cands ) {

			if ( ! cand || cand.isBufferAttribute !== true ) continue;
			if ( cand.isStorageBufferAttribute !== true && cand.isStorageInstancedBufferAttribute !== true ) continue;
			if ( candidates.has( cand ) ) continue;
			candidates.set( cand, { index: ctx.dfsIndex() } );

		}

	};

	visit( node );
	if ( node && typeof node.traverse === 'function' ) {

		try { node.traverse( visit ); } catch ( _ ) { /* tolerate broken traverse */ }

	}

}

/**
 * Wave 5 Phase B2 — pick the Nth storage candidate whose shape matches the
 * artifact entry. The Nth-of-same-shape disambiguates encounter-order
 * collisions when a material exposes multiple same-shape storage attrs.
 *
 * @param {Map<Object, { index: number }>} candidates - from `collectStorageAttributesInOrder`
 * @param {Object} entry - the artifact attribute entry to match
 * @param {number} slotIdx - 0-based index among same-shape entries
 * @returns {?Object} matched live storage attribute or null
 */
function findNthStorageMatchingShape( candidates, entry, slotIdx ) {

	const wantSize = entry.itemSize || 0;
	const wantCount = entry.count || 0;
	const wantArray = entry.arrayType || '';

	const matching = [];
	for ( const [ cand ] of candidates ) {

		if ( wantSize && cand.itemSize !== wantSize
			&& ! ( cand.itemSize === 3 && wantSize === 4 ) ) continue;
		if ( wantCount && cand.count !== wantCount ) continue;
		if ( wantArray
			&& cand.array
			&& cand.array.constructor
			&& cand.array.constructor.name !== wantArray ) continue;
		matching.push( cand );

	}

	if ( matching.length === 0 ) return null;
	if ( slotIdx >= matching.length ) return matching[ matching.length - 1 ];
	return matching[ slotIdx ];

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

	const fallbackGroups = collectInterleavedFallbackGroups( attributes );
	const interleavedFallbacks = createInterleavedFallbacks( fallbackGroups );

	return attributes.map( ( attribute ) => {

		if ( ! attribute || attribute.source !== 'node' ) return attribute;

		// Wave 5 Phase B2 — when the snapshot fallback would normally fire
		// (no userPath, has arraySnapshot) but `bindUserNodeAttributesToArtifact`
		// already wired a trusted live attribute, prefer it. Storage attributes
		// cover compute-driven cases (the compute kernel keeps writing them);
		// `instancedObject` covers InstancedMesh.instanceMatrix columns, where
		// the source object is more authoritative than an anonymous JSON snapshot.
		const isLiveStorageAttribute = attribute._liveAttribute && (
			attribute._liveAttribute.isStorageBufferAttribute === true
			|| attribute._liveAttribute.isStorageInstancedBufferAttribute === true
		);
		const isLiveInstancedObjectAttribute = attribute._liveAttributeSource === 'instancedObject';
		const hasCapturedAnonymousSnapshot = ! attribute.userPath && ( attribute.arraySnapshot || attribute._liveArray );
		const liveAttribute = ( hasCapturedAnonymousSnapshot && ! isLiveStorageAttribute && ! isLiveInstancedObjectAttribute )
			? null
			: attribute._liveAttribute || ( attribute.node && attribute.node.attribute );
		if ( liveAttribute ) return { ...attribute, node: { attribute: liveAttribute } };
		const interleavedAttribute = interleavedFallbacks.get( attribute );
		if ( interleavedAttribute ) return { ...attribute, node: { attribute: interleavedAttribute } };

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

function collectInterleavedFallbackGroups( attributes ) {

	const groups = new Map();
	for ( const attribute of attributes ) {

		if ( ! isInterleavableFallbackAttribute( attribute ) ) continue;
		const itemSize = attribute.itemSize || itemSizeFromAttributeType( attribute.type );
		const count = Math.max( 1, attribute.count || 1 );
		const key = [
			count,
			attribute.arrayType || 'Float32Array',
			attribute.normalized === true ? 'n' : 'u',
			attribute.meshPerAttribute || 1,
			typeof attribute.usage === 'number' ? attribute.usage : '',
		].join( ':' );
		const group = groups.get( key ) || [];
		group.push( { attribute, itemSize, count } );
		groups.set( key, group );

	}
	return [ ...groups.values() ].filter( ( group ) => group.length > 1 );

}

function isInterleavableFallbackAttribute( attribute ) {

	if ( ! attribute || attribute.source !== 'node' ) return false;
	if ( attribute.instanced !== true || attribute.storage === true ) return false;
	if ( attribute._liveAttribute || attribute.node && attribute.node.attribute ) return false;
	if ( ! Number.isFinite( attribute.count ) || attribute.count <= 0 ) return false;
	return true;

}

function createInterleavedFallbacks( groups ) {

	const fallbacks = new WeakMap();
	for ( const group of groups ) {

		const first = group[ 0 ];
		const count = first.count;
		const stride = group.reduce( ( total, entry ) => total + entry.itemSize, 0 );
		if ( stride <= 0 ) continue;
		const TypeArray = resolveTypedArrayCtor( first.attribute.arrayType );
		const data = new InstancedInterleavedBuffer( new TypeArray( count * stride ), stride, first.attribute.meshPerAttribute || 1 );
		if ( typeof first.attribute.usage === 'number' && typeof data.setUsage === 'function' ) data.setUsage( first.attribute.usage );

		let offset = 0;
		for ( const entry of group ) {

			copyIntoInterleavedArray( data.array, stride, offset, entry.itemSize, count, entry.attribute.arraySnapshot || entry.attribute._liveArray );
			const attr = new InterleavedBufferAttribute( data, entry.itemSize, offset, entry.attribute.normalized === true );
			fallbacks.set( entry.attribute, attr );
			offset += entry.itemSize;

		}
		data.needsUpdate = true;

	}
	return fallbacks;

}

function copyIntoInterleavedArray( target, stride, offset, itemSize, count, sourceArray ) {

	if ( ! target || ! sourceArray ) return;
	const getValue = ArrayBuffer.isView( sourceArray ) || Array.isArray( sourceArray )
		? ( index ) => sourceArray[ index ]
		: ( index ) => sourceArray[ index ];
	for ( let i = 0; i < count; i ++ ) {

		const srcOffset = i * itemSize;
		const dstOffset = i * stride + offset;
		for ( let c = 0; c < itemSize; c ++ ) {

			const value = getValue( srcOffset + c );
			if ( value !== undefined ) target[ dstOffset + c ] = value;

		}

	}

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
