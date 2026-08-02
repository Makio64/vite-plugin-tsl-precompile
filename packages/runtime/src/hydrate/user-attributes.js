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
 * the material has no matching node tree yet. The hydrator first calls
 * `createHydrationBindingArtifactView()` so their non-enumerable
 * `_liveAttribute` sidecars are always state-local rather than leaking from
 * one material/caster hydration into another.
 *
 * `hydrateNodeAttributes()` then materialises a fresh per-render array from
 * those entries: bound live attribute → reuse it; missing → allocate a fresh
 * empty `StorageBufferAttribute` of the right shape so pipeline-layout
 * validation still passes.
 *
 * @module Hydrate.UserAttributes
 */

import { BufferAttribute } from 'three/src/core/BufferAttribute.js';
import { InstancedBufferAttribute } from 'three/src/core/InstancedBufferAttribute.js';
import { InstancedInterleavedBuffer } from 'three/src/core/InstancedInterleavedBuffer.js';
import { InterleavedBufferAttribute } from 'three/src/core/InterleavedBufferAttribute.js';
import StorageBufferAttribute from 'three/src/renderers/common/StorageBufferAttribute.js';
import StorageInstancedBufferAttribute from 'three/src/renderers/common/StorageInstancedBufferAttribute.js';
import {
	GENERATED_ATTRIBUTE_FILL_SIDECAR,
	GENERATED_INSTANCE_MATRIX_COLUMN_SIDECAR,
} from '@tsl-precompile/contract/attribute-generators';

import {
	hasAnonymousStorageResourceIdentity,
	selectSignedAnonymousStorageAttribute,
	storageEntryAnonymousResourceIdentity,
} from './storage-buffer-identity.js';
import { resolveTypedArrayCtor } from './typed-arrays.js';
import { walkNodeGraphUnique } from '../slim-support/node-graph-walker.js';

/**
 * Clone only artifact records that acquire live graph-resource sidecars while
 * one NodeBuilderState is hydrated. Variant payloads are memoized and shared;
 * writing `_liveAttribute` on those records would make the first material (or
 * shadow caster) win every later hydration of the same artifact.
 *
 * Existing non-enumerable sidecars are preserved by default because compute
 * synchronisation can install them deliberately before hydration. Signed
 * owner-local views clear unproven attribute/live-node sidecars and rebind
 * them from the exact material instead. Attribute-list aliases and
 * storage-buffer `orderedBindings[].ref` aliases remain intact.
 *
 * @param {Object} artifact
 * @param {{ resetLiveNodeSidecars?: boolean }} [options]
 * @returns {Object}
 */
export function createHydrationBindingArtifactView( artifact, options = {} ) {

	if ( ! artifact || typeof artifact !== 'object' || ! hasLocalBindingRecords( artifact, options.resetLiveNodeSidecars === true ) ) return artifact;

	const clonedRecords = new WeakMap();
	const clonedSources = new WeakMap();
	const clonedLists = new WeakMap();
	const resetOwnerLocalSidecars = options.resetLiveNodeSidecars === true;
	const cloneList = ( list ) => {

		if ( ! Array.isArray( list ) ) return list;
		let clone = clonedLists.get( list );
		if ( clone ) return clone;
		clone = list.map( ( entry ) => {

			const record = cloneRecordOnce( entry, clonedRecords );
			if ( resetOwnerLocalSidecars ) clearOwnerLocalBindingSidecars( record );
			return record;

		} );
		clonedLists.set( list, clone );
		return clone;

	};
	const cloneSlotList = ( list ) => {

		if ( ! Array.isArray( list ) ) return list;
		let clone = clonedLists.get( list );
		if ( clone ) return clone;
		clone = list.map( ( slot ) => {

			if ( ! slot || typeof slot !== 'object' ) return slot;
			let slotClone = clonedRecords.get( slot );
			if ( slotClone ) return slotClone;
			const source = slot.source && typeof slot.source === 'object'
				? cloneRecordOnce( slot.source, clonedSources )
				: slot.source;
			slotClone = cloneRecord( slot, source === slot.source ? null : { source }, true );
			clonedRecords.set( slot, slotClone );
			return slotClone;

		} );
		clonedLists.set( list, clone );
		return clone;

	};
	const replacements = {};
	if ( Array.isArray( artifact.attributes ) ) replacements.attributes = cloneList( artifact.attributes );
	if ( Array.isArray( artifact.nodeAttributes ) ) replacements.nodeAttributes = cloneList( artifact.nodeAttributes );

	if ( Array.isArray( artifact.uniformPlan ) ) {

		replacements.uniformPlan = artifact.uniformPlan.map( ( group ) => {

			if ( ! group || typeof group !== 'object' ) return group;
			const groupReplacements = {};
			if ( Array.isArray( group.slots ) ) {

				const slots = cloneSlotList( group.slots );
				if ( resetOwnerLocalSidecars ) for ( const slot of slots ) {

					if ( ! slot || typeof slot !== 'object' ) continue;
					delete slot._liveNode;
					delete slot.__tslpLiveSidecarOverlay;

				}
				groupReplacements.slots = slots;

			}
			const storageBuffers = Array.isArray( group.storageBuffers )
				? cloneList( group.storageBuffers )
				: group.storageBuffers;
			if ( Array.isArray( group.storageBuffers ) ) groupReplacements.storageBuffers = storageBuffers;

			if ( Array.isArray( group.orderedBindings ) ) {

				groupReplacements.orderedBindings = group.orderedBindings.map( ( binding ) => {

					if ( ! binding || typeof binding !== 'object' ) return binding;
					if ( binding.type === 'storage-buffer' && binding.ref && typeof binding.ref === 'object' ) {

						const ref = cloneRecordOnce( binding.ref, clonedRecords );
						if ( resetOwnerLocalSidecars ) clearOwnerLocalBindingSidecars( ref );
						return cloneRecord( binding, { ref } );

					}
					return cloneRecord( binding );

				} );

			}
			return cloneRecord( group, groupReplacements );

		} );

	}
	for ( const sidecar of [ '_liveUpdateNodes', '_liveUpdateBeforeNodes', '_liveUpdateAfterNodes' ] ) {

		const current = Array.isArray( artifact[ sidecar ] ) ? artifact[ sidecar ] : [];
		replacements[ sidecar ] = resetOwnerLocalSidecars ? [] : current.slice();

	}
	// Texture refs can arrive after the NodeBuilderState is hydrated (PMREM,
	// compute outputs, async loaders). Keep state-local record clones isolated,
	// but forward this mutable resource sidecar to the selected/root artifact so
	// the existing per-frame texture rebinder observes map replacement.
	return cloneRecord( artifact, replacements, false, [ '_textureRefs' ] );

}

function clearOwnerLocalBindingSidecars( record ) {

	if ( ! record || typeof record !== 'object' ) return;
	delete record._liveAttribute;
	delete record._liveAttributeSource;

}

function hasLocalBindingRecords( artifact, force = false ) {

	if ( force ) return true;
	if ( Array.isArray( artifact.attributes ) && artifact.attributes.length > 0 ) return true;
	if ( Array.isArray( artifact.nodeAttributes ) && artifact.nodeAttributes.length > 0 ) return true;
	for ( const group of Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [] ) {

		if ( group && Array.isArray( group.storageBuffers ) && group.storageBuffers.length > 0 ) return true;
		if ( group && Array.isArray( group.orderedBindings ) && group.orderedBindings.some( ( binding ) => binding && binding.type === 'storage-buffer' && binding.ref ) ) return true;
		if ( group && Array.isArray( group.slots ) && group.slots.some( ( slot ) => slot && slot.source && slot.source.kind === 'uniform.live' ) ) return true;

	}
	return false;

}

function cloneRecordOnce( record, clones ) {

	if ( ! record || typeof record !== 'object' ) return record;
	let clone = clones.get( record );
	if ( clone ) return clone;
	clone = cloneRecord( record, null, true );
	clones.set( record, clone );
	return clone;

}

function cloneRecord( record, replacements = null, mutableLiveSidecars = false, forwardedSidecars = [] ) {

	const descriptors = Object.getOwnPropertyDescriptors( record );
	for ( const property of forwardedSidecars ) {

		descriptors[ property ] = {
			get() {

				return record[ property ];

			},
			set( value ) {

				const sourceDescriptor = Object.getOwnPropertyDescriptor( record, property );
				if ( sourceDescriptor && typeof sourceDescriptor.set === 'function' ) {

					sourceDescriptor.set.call( record, value );
					return;

				}
				if ( sourceDescriptor && 'value' in sourceDescriptor && sourceDescriptor.writable === true ) {

					record[ property ] = value;
					return;

				}
				Object.defineProperty( record, property, {
					value,
					enumerable: false,
					configurable: true,
					writable: true,
				} );

			},
			enumerable: false,
			configurable: true,
		};

	}
	if ( mutableLiveSidecars ) {

		for ( const property of [ '_liveAttribute', '_liveAttributeSource', '_liveNode', '__tslpLiveSidecarOverlay' ] ) {

			const descriptor = descriptors[ property ];
			if ( descriptor && 'value' in descriptor ) descriptors[ property ] = { ...descriptor, configurable: true, writable: true };

		}

	}
	for ( const [ property, value ] of Object.entries( replacements || {} ) ) {

		const descriptor = descriptors[ property ];
		descriptors[ property ] = descriptor && 'value' in descriptor
			? { ...descriptor, value, ...( property.startsWith( '_liveUpdate' ) ? { configurable: true, writable: true } : {} ) }
			: { value, enumerable: true, configurable: true, writable: true };

	}
	return Object.create( Object.getPrototypeOf( record ), descriptors );

}

function resolveExactMaterialAttributePath( sourceMaterial, path, entry ) {

	if ( ! sourceMaterial || ! Array.isArray( path ) || path.length <= 1 ) return null;
	let current = sourceMaterial;
	for ( const segment of path ) {

		if ( typeof segment !== 'string' || segment.length === 0 ) return null;
		if ( ! current || ( typeof current !== 'object' && typeof current !== 'function' ) ) return null;
		if ( ! Object.prototype.hasOwnProperty.call( current, segment ) ) return null;
		try { current = current[ segment ]; } catch ( _ ) { return null; }

	}
	return attributeMatchesEntry( current, entry ) ? current : null;

}

function resolveUniqueSlimCarrierAttribute( root, entry ) {

	if ( ! root || ! Object.prototype.hasOwnProperty.call( root, '_children' ) || ! Array.isArray( root._children ) ) return null;
	let cacheKey = null;
	try { cacheKey = typeof root.getCacheKey === 'function' ? root.getCacheKey() : null; } catch ( _ ) { return null; }
	if ( cacheKey !== 'slim-inert-node' ) return null;
	const matches = collectAttributesMatchingEntry( root, entry );
	return matches.length === 1 ? matches[ 0 ] : null;

}

function bindExactMaterialAttributePath( sourceMaterial, path, entry ) {

	let live = resolveExactMaterialAttributePath( sourceMaterial, path, entry );
	let source = 'userPath-exact';
	if ( ! live ) {

		live = resolveUniqueSlimCarrierAttribute( sourceMaterial && sourceMaterial[ path[ 0 ] ], entry );
		source = 'userPath-slim-unique';

	}
	if ( live ) setLiveAttributeBinding( entry, live, source );

}

/**
 * Walk every `attributes[]` / `nodeAttributes[]` entry in the artifact and
 * seed `entry._liveAttribute` from the user material's TSL node graph.
 *
 * @param {Object} artifact
 * @param {?Object} sourceMaterial
 * @param {?Object} [sourceObjectOverride]
 */
export function bindUserNodeAttributesToArtifact( artifact, sourceMaterial, sourceObjectOverride = null ) {

	if ( ! sourceMaterial && ! sourceObjectOverride ) return;
	const entries = Array.isArray( artifact.attributes )
		? artifact.attributes
		: Array.isArray( artifact.nodeAttributes ) ? artifact.nodeAttributes : null;
	if ( ! entries || entries.length === 0 ) return;

	let nodeRoots = null;
	const collectNodeRoots = () => {

		if ( nodeRoots ) return nodeRoots;
		nodeRoots = [];
		for ( const key in sourceMaterial || {} ) {

			const v = sourceMaterial[ key ];
			if ( v && v.isNode === true ) nodeRoots.push( v );

		}
		return nodeRoots;

	};

	const sourceObject = sourceObjectOverride || sourceMaterial && sourceMaterial.__tslpPrecompileObject || null;
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
		if ( entry.objectAttribute ) {

			// Explicit provenance is stronger than every material-graph shape
			// heuristic. Resolve it from the active render object only, so an
			// unrelated same-shaped material attribute can never steal the slot.
			const objectAttribute = findInstancedObjectAttributeMatchingEntry( sourceObject, entry, entries );
			setLiveAttributeBinding( entry, objectAttribute, objectAttribute ? 'instancedObject' : null );
			continue;

		}
		if ( entry._liveAttribute && entry._liveAttribute.isBufferAttribute === true
			&& ! ( Array.isArray( entry.userPath ) && entry.userPath.length > 0 ) ) continue;

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
				if ( instancedObjectAttribute ) setLiveAttributeBinding( entry, instancedObjectAttribute, 'instancedObject' );

			} else {

				collectStorageFromRoots();
				const shapeKey = entry.itemSize + ':' + entry.count + ':' + ( entry.arrayType || '' );
				const slotIdx = anonStorageShapeIndex.get( shapeKey ) || 0;
				anonStorageShapeIndex.set( shapeKey, slotIdx + 1 );
				const matchingStorage = findNthStorageMatchingShape( anonStorageCandidates, entry, slotIdx );
				if ( matchingStorage ) {

					setLiveAttributeBinding( entry, matchingStorage );
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
				if ( instancedObjectAttribute ) setLiveAttributeBinding( entry, instancedObjectAttribute, 'instancedObject' );

			}
			continue;

		}

		let live = null;
		const path = entry.userPath;
		const exactPath = Array.isArray( path ) && path.length > 1;
		if ( Array.isArray( path ) && path.length > 0 ) {

			if ( exactPath ) {

				bindExactMaterialAttributePath( sourceMaterial, path, entry );
				continue;

			} else {

				const slotIdx = nextAttributeShapeSlot( pathShapeSlots, path, entry );
				const root = sourceMaterial && sourceMaterial[ path[ 0 ] ];
				if ( root && root.isNode === true ) live = findNthAttributeMatchingEntry( root, entry, slotIdx );

			}

		}

		if ( ! live ) {

			for ( const root of collectNodeRoots() ) {

				live = findFirstAttributeMatchingEntry( root, entry );
				if ( live ) break;

			}

		}

		if ( ! live ) live = findInstancedObjectAttributeMatchingEntry( sourceObject, entry, entries );
		if ( ! live ) continue;
		setLiveAttributeBinding( entry, live );

	}

}

function setLiveAttributeBinding( entry, attribute, source = undefined ) {

	if ( Object.prototype.hasOwnProperty.call( entry, '_liveAttribute' ) ) entry._liveAttribute = attribute;
	else Object.defineProperty( entry, '_liveAttribute', {
		value: attribute,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	if ( source !== undefined ) {

		if ( Object.prototype.hasOwnProperty.call( entry, '_liveAttributeSource' ) ) entry._liveAttributeSource = source;
		else Object.defineProperty( entry, '_liveAttributeSource', {
			value: source,
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
		if ( ! entry.arraySnapshot && ! entry._liveArray && ! entry.arrayGenerator ) continue;
		if ( ! Number.isFinite( entry.count ) || entry.count <= 0 ) continue;
		if ( count === null ) count = entry.count;
		else if ( count !== entry.count ) return null;

	}
	return count;

}

function findInstancedObjectAttributeMatchingEntry( object, entry, entries ) {

	if ( ! object || object.isInstancedMesh !== true ) return null;
	const itemSize = entry.itemSize || itemSizeFromAttributeType( entry.type );
	if ( entry.objectAttribute ) {

		const column = entry[ GENERATED_INSTANCE_MATRIX_COLUMN_SIDECAR ];
		if ( ! Number.isInteger( column ) || column < 0 || column > 3 ) throw new Error(
			'[tsl-precompile/slim] Generated instance matrix descriptor was not materialized by its artifact module.',
		);
		const matrix = object.instanceMatrix;
		if ( ! matrix
			|| ! ( matrix.array instanceof Float32Array )
			|| matrix.array.length % 16 !== 0
			|| matrix.itemSize !== undefined && matrix.itemSize !== 16
			|| matrix.meshPerAttribute !== undefined && matrix.meshPerAttribute !== 1 ) return null;
		const matrixCount = matrix && Number.isFinite( matrix.count )
			? matrix.count
			: matrix && matrix.array ? matrix.array.length / 16 : 0;
		if ( ! Number.isInteger( matrixCount ) || matrixCount <= 0 || entry.count !== matrixCount ) return null;
		return getInstancedMatrixColumnAttribute( object, column, matrixCount );

	}
	const count = object.count || 0;
	if ( ! count || entry.count !== count ) return null;

	if ( object.instanceColor && object.instanceColor.isBufferAttribute === true ) {

		const color = object.instanceColor;
		if ( itemSize === color.itemSize ) return color;

	}

	if ( itemSize !== 4 || ! object.instanceMatrix || ! object.instanceMatrix.array ) return null;

	const matrixEntries = entries.filter( ( candidate ) => {

		if ( ! candidate || candidate.source !== 'node' ) return false;
		if ( candidate.count !== count ) return false;
		if ( candidate.storage === true || candidate.userPath ) return false;
		const size = candidate.itemSize || itemSizeFromAttributeType( candidate.type );
		return size === 4;

	} );
	if ( matrixEntries.length !== 4 ) return null;
	const column = matrixEntries.indexOf( entry );
	if ( column < 0 || column > 3 ) return null;

	return getInstancedMatrixColumnAttribute( object, column );

}

function getInstancedMatrixColumnAttribute( object, column, expectedCount = null ) {

	const source = object && object.instanceMatrix;
	const sourceArray = source && source.array;
	const count = expectedCount || object && object.count || 0;
	if ( ! sourceArray || ! count ) return null;

	const cacheKey = '__tslpMatrixColumnAttributes';
	let cache = object[ cacheKey ];
	if ( ! cache || cache.source !== source || cache.sourceArray !== sourceArray || cache.count !== count ) {

		cache = {
			source,
			sourceArray,
			count,
			data: createLiveInstanceMatrixInterleavedBuffer( source ),
		};
		cache.attributes = [ 0, 1, 2, 3 ].map( ( offset ) => new InterleavedBufferAttribute( cache.data, 4, offset * 4 ) );
		try { Object.defineProperty( object, cacheKey, { value: cache, configurable: true } ); } catch ( _ ) { object[ cacheKey ] = cache; }

	}

	return cache.attributes[ column ] || null;

}

function createLiveInstanceMatrixInterleavedBuffer( source ) {

	const data = new InstancedInterleavedBuffer( source.array, 16, source.meshPerAttribute || 1 );
	if ( typeof source.usage === 'number' ) data.usage = source.usage;
	if ( Array.isArray( source.updateRanges ) ) data.updateRanges = source.updateRanges;
	Object.defineProperty( data, 'version', {
		configurable: true,
		get: () => source.version || 0,
		set: ( value ) => { source.version = value; },
	} );
	return data;

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

	const matching = [];
	const seen = new Set();
	const probe = ( n ) => {

		if ( ! n ) return;
		const cands = [ n.attribute, n.value ];
		for ( const cand of cands ) {

			if ( seen.has( cand ) ) continue;
			if ( ! attributeMatchesEntry( cand, entry ) ) continue;
			seen.add( cand );
			matching.push( cand );

		}

	};

	walkNodeGraphUnique( node, probe );
	return matching;

}

function attributeMatchesEntry( candidate, entry ) {

	if ( ! candidate || candidate.isBufferAttribute !== true || ! entry ) return false;
	const wantSize = entry.itemSize || itemSizeFromAttributeType( entry.type ) || 0;
	const wantCount = entry.count || 0;
	const wantArray = entry.arrayType || '';
	// vec3 storage attributes get padded to itemSize=4 when WebGPU touches
	// them. Accept (3 → 4) while keeping every other field exact.
	if ( wantSize && candidate.itemSize !== wantSize
		&& ! ( candidate.itemSize === 3 && wantSize === 4 ) ) return false;
	if ( wantCount && candidate.count !== wantCount ) return false;
	if ( wantArray
		&& candidate.array
		&& candidate.array.constructor
		&& candidate.array.constructor.name !== wantArray ) return false;
	if ( typeof entry.storage === 'boolean' ) {

		const candidateStorage = candidate.isStorageBufferAttribute === true || candidate.isStorageInstancedBufferAttribute === true;
		if ( candidateStorage !== entry.storage ) return false;

	}
	return true;

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

	walkNodeGraphUnique( node, visit );

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
	let signedStorageCandidates = null;
	const collectSignedStorageCandidates = () => {

		if ( signedStorageCandidates ) return signedStorageCandidates;
		signedStorageCandidates = new Map();
		let dfsIndex = 0;
		for ( const root of collectNodeRoots() ) {

			collectStorageAttributesInOrder( root, signedStorageCandidates, { dfsIndex: () => dfsIndex ++ } );

		}
		return signedStorageCandidates;

	};

	for ( const group of plan ) {

		const entries = collectStorageBufferEntries( group );
		if ( entries.length === 0 ) continue;
		for ( const entry of entries ) {

			if ( ! entry ) continue;
			const path = entry.userPath;
			const exactPath = Array.isArray( path ) && path.length > 1;
			if ( exactPath ) {

				bindExactMaterialAttributePath( sourceMaterial, path, entry );
				continue;

			}

			// Anonymous storage identities are signed as a complete family. Rank
			// the exact compatible live attributes by BufferAttribute ID, matching
			// capture independently of graph/discovery order. If the signature is
			// malformed or the family is incomplete/ambiguous, do not fall through
			// to the legacy first-shape match.
			if ( hasAnonymousStorageResourceIdentity( entry ) ) {

				if ( ! storageEntryAnonymousResourceIdentity( entry ) ) continue;
				const compatible = [ ...collectSignedStorageCandidates().keys() ]
					.filter( ( candidate ) => attributeMatchesEntry( candidate, entry ) );
				const signedLive = selectSignedAnonymousStorageAttribute( entry, compatible );
				if ( signedLive ) setLiveAttributeBinding( entry, signedLive, 'anonymous-resource-id' );
				continue;

			}

			if ( entry._liveAttribute
				&& entry._liveAttribute.array
				&& ArrayBuffer.isView( entry._liveAttribute.array )
				&& ! ( Array.isArray( path ) && path.length > 0 ) ) continue;

			let live = null;
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

			if ( ! live ) continue;
			setLiveAttributeBinding( entry, live );

		}

	}

}

function collectStorageBufferEntries( group ) {

	if ( ! group || typeof group !== 'object' ) return [];
	const entries = [];
	const seen = new Set();
	const add = ( entry ) => {

		if ( ! entry || seen.has( entry ) ) return;
		seen.add( entry );
		entries.push( entry );

	};
	for ( const entry of Array.isArray( group.storageBuffers ) ? group.storageBuffers : [] ) add( entry );
	for ( const binding of Array.isArray( group.orderedBindings ) ? group.orderedBindings : [] ) {

		if ( binding && binding.type === 'storage-buffer' ) add( binding.ref );

	}
	return entries;

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
	for ( const attribute of attributes ) assertGeneratedAttributeMaterialized( attribute );

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
		const hasCapturedAnonymousSnapshot = ! attribute.userPath && (
			attribute.arraySnapshot || attribute._liveArray || attribute.arrayGenerator
		);
		const liveAttribute = ( hasCapturedAnonymousSnapshot && ! isLiveStorageAttribute && ! isLiveInstancedObjectAttribute )
			? null
			: attribute._liveAttribute || ( attribute.node && attribute.node.attribute );
		if ( liveAttribute ) return { ...attribute, node: { attribute: liveAttribute } };
		if ( attribute.objectAttribute ) throw new Error(
			`[tsl-precompile/slim] Could not resolve captured object attribute ${ attribute.objectAttribute.kind || '<unknown>' }.`,
		);
		const interleavedAttribute = interleavedFallbacks.get( attribute );
		if ( interleavedAttribute ) return { ...attribute, node: { attribute: interleavedAttribute } };

		const itemSize = attribute.itemSize || itemSizeFromAttributeType( attribute.type );
		const count = Math.max( 1, attribute.count || 1 );
		const TypeArray = resolveTypedArrayCtor( attribute.arrayType );
		const fallbackAttribute = createFallbackNodeAttribute( attribute, count, itemSize, TypeArray );
		const fillGeneratedArray = attribute[ GENERATED_ATTRIBUTE_FILL_SIDECAR ];
		if ( typeof fillGeneratedArray === 'function' ) {

			fillGeneratedArray( fallbackAttribute.array );
			fallbackAttribute.needsUpdate = true;

		} else {

			seedAttributeArray( fallbackAttribute, attributeArraySource( attribute ) );

		}

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

			const fillGeneratedArray = entry.attribute[ GENERATED_ATTRIBUTE_FILL_SIDECAR ];
			if ( typeof fillGeneratedArray === 'function' ) {

				fillGeneratedArray( data.array, stride, offset );

			} else {

				copyIntoInterleavedArray( data.array, stride, offset, entry.itemSize, count, attributeArraySource( entry.attribute ) );

			}
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

function attributeArraySource( attribute ) {

	if ( ! attribute ) return null;
	if ( attribute.arraySnapshot ) return attribute.arraySnapshot;
	if ( attribute._liveArray ) return attribute._liveArray;
	return null;

}

function assertGeneratedAttributeMaterialized( attribute ) {

	if ( ! attribute || typeof attribute !== 'object' ) return;
	if ( attribute.arrayGenerator !== undefined && typeof attribute[ GENERATED_ATTRIBUTE_FILL_SIDECAR ] !== 'function' ) {

		throw new Error( '[tsl-precompile/slim] Generated range descriptor was not materialized by its artifact module.' );

	}
	if ( attribute.objectAttribute !== undefined && ! Number.isInteger( attribute[ GENERATED_INSTANCE_MATRIX_COLUMN_SIDECAR ] ) ) {

		throw new Error( '[tsl-precompile/slim] Generated instance matrix descriptor was not materialized by its artifact module.' );

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
