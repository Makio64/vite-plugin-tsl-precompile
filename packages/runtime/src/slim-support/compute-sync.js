/**
 * Compute input/output synchronisation between two `WebGPURenderer` instances.
 *
 * The slim runtime ships no compute kernel compiler (the node builder is
 * tree-shaken). When a scene declares `material.positionNode = Fn(...)().compute(N)`
 * or runs `renderer.compute(node)`, the slim renderer can't generate the
 * `GPUComputePipeline` itself — it has to borrow a full renderer that does.
 * Before dispatch, the full renderer may need to sample render-target textures
 * the slim renderer just rendered. After dispatch, the slim renderer needs to
 * read the *same* `GPUBuffer` / `GPUTexture` so its draw call sees the compute
 * output rather than a fresh, zeroed stand-in.
 *
 * This module owns the cross-renderer copy. It does NOT:
 *   - bootstrap the full renderer (callers pass one in);
 *   - walk the scene (callers provide the compute node list);
 *   - know about precompile artifacts (the harness wires those via callbacks).
 *
 * The pairing with [`./gpu-texture-share.js`](./gpu-texture-share.js) is
 * deliberate: storage-texture sync delegates to `shareShadowGPUTextureIntoSlim`
 * because the version-bump + view-cache-clear + cross-renderer Textures-DataMap
 * write is the same pattern as a shadow depth map.
 *
 * @module SlimSupportComputeSync
 */

import { collectArtifactVariantCandidates } from '@tsl-precompile/contract/artifact-variants';
import { shareGPUTextureEntry, shareShadowGPUTextureIntoSlim, clearTextureViewCache } from './gpu-texture-share.js';

function asList( node ) { return Array.isArray( node ) ? node : [ node ]; }

function isStorageAttribute( value ) {

	return value && (
		value.isStorageBufferAttribute === true
		|| value.isStorageInstancedBufferAttribute === true
	);

}

function isLiveStorageAttribute( value ) {

	return isStorageAttribute( value )
		&& value.array
		&& ArrayBuffer.isView( value.array );

}

function storageBindingAttributeName( binding ) {

	const nodeUniform = binding && binding.nodeUniform;
	for ( const candidate of [
		nodeUniform && nodeUniform.name,
		nodeUniform && nodeUniform.node && nodeUniform.node.name,
	] ) {

		if ( typeof candidate === 'string' && candidate.trim().length > 0 ) return candidate.trim();

	}
	return null;

}

function storageCandidateRecords( values ) {

	const byAttribute = new Map();
	for ( const value of asList( values ) ) {

		const attribute = isStorageAttribute( value )
			? value
			: value && isStorageAttribute( value.attribute ) ? value.attribute : null;
		if ( ! attribute ) continue;
		let record = byAttribute.get( attribute );
		if ( ! record ) {

			record = { attribute, attributeNames: new Set() };
			byAttribute.set( attribute, record );

		}
		const explicitName = value && ! isStorageAttribute( value ) && typeof value.attributeName === 'string'
			? value.attributeName.trim()
			: '';
		const bindingName = value && ! isStorageAttribute( value ) ? storageBindingAttributeName( value.binding ) : null;
		const attributeName = typeof attribute.name === 'string' ? attribute.name.trim() : '';
		for ( const name of [ explicitName, bindingName, attributeName ] ) {

			if ( name ) record.attributeNames.add( name );

		}

	}
	return [ ...byAttribute.values() ];

}

function storageEntryAttributeName( entry ) {

	const source = entry && entry.source;
	if ( ! source || source.kind !== 'storage.buffer' || typeof source.attributeName !== 'string' ) return null;
	const name = source.attributeName.trim();
	return name || null;

}

function storageEntryAliasKey( entry, groupIndex ) {

	return [
		groupIndex,
		entry && entry.name || '',
		storageEntryAttributeName( entry ) || '',
		entry && entry.count || 0,
		entry && entry.itemSize || 0,
		entry && entry.arrayType || '',
	].join( ':' );

}

function storageShapeMatches( attribute, entry, allowVec3ToVec4 = true ) {

	if ( ! isStorageAttribute( attribute ) || ! entry ) return false;

	const wantSize = entry.itemSize || 0;
	const wantCount = entry.count || 0;
	const wantArray = entry.arrayType || '';

	if ( wantSize && attribute.itemSize !== wantSize
		&& ! ( allowVec3ToVec4 && attribute.itemSize === 3 && wantSize === 4 ) ) return false;
	if ( wantCount && attribute.count !== wantCount ) return false;
	if ( wantArray
		&& attribute.array
		&& attribute.array.constructor
		&& attribute.array.constructor.name !== wantArray ) return false;

	return true;

}

function defineLiveStorageAttribute( entry, attribute, bumpVersion ) {

	Object.defineProperty( entry, '_liveAttribute', {
		value: attribute,
		enumerable: false,
		configurable: true,
		writable: true,
	} );

	if ( bumpVersion && typeof attribute.version === 'number' ) attribute.version = attribute.version + 1;

}

function storageTextureFromBinding( binding ) {

	if ( ! binding || ! binding.isSampledTexture ) return null;
	const texture = binding.texture;
	return texture && texture.isStorageTexture === true ? texture : null;

}

function sampledInputTextureFromBinding( binding ) {

	if ( ! binding || binding.isSampledTexture !== true ) return null;
	if ( binding.store === true ) return null;
	const texture = binding.texture;
	if ( ! texture || texture.isStorageTexture === true ) return null;
	return texture;

}

function bindingFilterAllows( opts, binding, location, direction, kind ) {

	const filter = typeof opts.bindingFilter === 'function' ? opts.bindingFilter : null;
	if ( ! filter ) return true;
	return filter( binding, location, { direction, kind } ) === true;

}

function uninitializedComputeBindGroups( computeNode, fullRenderer ) {

	const manager = fullRenderer && ( fullRenderer._nodes || fullRenderer.nodes );
	if ( ! manager || typeof manager.getForCompute !== 'function' ) return null;
	const out = [];
	for ( const node of asList( computeNode ) ) {

		let state;
		try { state = manager.getForCompute( node ); } catch ( _ ) { return null; }
		if ( ! state || ! Array.isArray( state.bindings ) ) return null;
		out.push( ...state.bindings );

	}
	return out;

}

function hasInitializedComputeBindGroup( fullRenderer, bindGroup ) {

	const bindings = fullRenderer && fullRenderer._bindings;
	if ( ! bindings || typeof bindings.get !== 'function' ) return false;
	try {

		const data = bindings.get( bindGroup );
		return !! data && data.bindGroup !== undefined;

	} catch ( _ ) {

		return false;

	}

}

function invalidateComputeBindGroups( fullRenderer, computeNode ) {

	const bindings = fullRenderer && fullRenderer._bindings;
	if ( ! bindings || typeof bindings.deleteForCompute !== 'function' ) return false;
	try {

		for ( const node of asList( computeNode ) ) bindings.deleteForCompute( node );
		return true;

	} catch ( _ ) {

		return false;

	}

}

function shareStorageBufferEntry( fullRenderer, slimRenderer, attribute ) {

	if ( ! attribute || ! fullRenderer.backend || ! slimRenderer.backend ) return { shared: false, replaced: false };
	const sourceAttribute = attribute.isInterleavedBufferAttribute === true ? attribute.data : attribute;
	const slimData = slimRenderer.backend.get( sourceAttribute );
	const fullData = fullRenderer.backend.get( sourceAttribute );
	// An exact compute input with no slim GPU handle is full-compute-owned. Its
	// CPU attribute remains available to Three and the full renderer will create
	// the first GPUBuffer when it initializes the binding for dispatch. This is
	// the storage-buffer equivalent of a compute-owned sampled texture; there is
	// no slim resource to transfer and therefore no synchronization failure.
	if ( ! slimData || ! slimData.buffer ) return {
		shared: false,
		replaced: false,
		notSlimOwned: true,
		alreadyAvailable: !! ( fullData && fullData.buffer ),
	};
	if ( ! fullData ) return { shared: false, replaced: false };
	const previousBuffer = fullData.buffer;
	fullData.buffer = slimData.buffer;

	// Prevent Three's first full-renderer binding initialization from allocating
	// a replacement GPUBuffer over the exact slim-owned resource.
	const fullAttributes = fullRenderer._attributes;
	let fullAttributeData = null;
	let hadAttributeVersion = false;
	let previousAttributeVersion;
	if ( fullAttributes && typeof fullAttributes.get === 'function' ) {

		fullAttributeData = fullAttributes.get( sourceAttribute );
		hadAttributeVersion = !! fullAttributeData && Object.prototype.hasOwnProperty.call( fullAttributeData, 'version' );
		previousAttributeVersion = fullAttributeData && fullAttributeData.version;
		const slimAttributes = slimRenderer._attributes;
		const slimAttributeData = slimAttributes && typeof slimAttributes.get === 'function'
			? slimAttributes.get( sourceAttribute )
			: null;
		const version = slimAttributeData && slimAttributeData.version !== undefined
			? slimAttributeData.version
			: sourceAttribute.version;
		if ( fullAttributeData && version !== undefined ) fullAttributeData.version = version;

	}
	return {
		shared: fullData.buffer === slimData.buffer,
		replaced: previousBuffer !== undefined && previousBuffer !== slimData.buffer,
		fullData,
		previousBuffer,
		fullAttributeData,
		hadAttributeVersion,
		previousAttributeVersion,
	};

}

function callResourceHook( hook, resource, binding, location, detail ) {

	if ( typeof hook !== 'function' ) return;
	try { hook( resource, binding, location, detail ); } catch ( _ ) {}

}

/**
 * Pull the compute bind-groups for `computeNode` out of the full renderer's
 * `_bindings.getForCompute()`. Returns an empty array on any failure (the
 * full renderer may not have dispatched this node yet, or the API may not
 * be available in older three.js).
 */
export function getComputeBindGroups( computeNode, fullRenderer ) {

	const out = [];
	if ( ! fullRenderer || ! fullRenderer._bindings || typeof fullRenderer._bindings.getForCompute !== 'function' ) return out;
	for ( const node of asList( computeNode ) ) {

		try {

			const groups = fullRenderer._bindings.getForCompute( node );
			if ( groups ) for ( const g of groups ) out.push( g );

		} catch ( _ ) { /* tolerate */ }

	}
	return out;

}

/**
 * Does this compute node (or list) write to at least one `StorageTexture`?
 * Used by callers to decide whether to also share the texture's GPU handle
 * back to the slim renderer (a regular storage *buffer* sync is cheap and
 * always safe to run; a *texture* swap invalidates bind groups so callers
 * may want to gate it).
 */
export function computeNodeUsesStorageTexture( computeNode, fullRenderer ) {

	const bindGroups = getComputeBindGroups( computeNode, fullRenderer );
	for ( const bindGroup of bindGroups ) {

		if ( ! bindGroup || ! bindGroup.bindings ) continue;
		for ( const binding of bindGroup.bindings ) {

			if ( storageTextureFromBinding( binding ) ) return true;

		}

	}
	return false;

}

/**
 * Whether a delegated compute dispatch changed resources that a slim draw can
 * consume. Callers use this after `syncComputeStorageOutputs()` to decide if a
 * presentation render is required.
 *
 * `storageAttrs` is intentionally part of the decision even when neither
 * `buffersAdopted` nor `buffersCopied` changed. After the first dispatch both
 * renderers can already reference the same `GPUBuffer`; later dispatches mutate
 * that shared buffer in place, so the sync is a zero-copy no-op but the canvas
 * still needs another draw to present the new values.
 *
 * The texture and legacy copy/adopt counters keep this helper compatible with
 * callers that enrich or persist older compute-sync diagnostics.
 *
 * @param {Object|null|undefined} stats
 * @returns {boolean}
 */
export function computeSyncNeedsPresentation( stats ) {

	if ( ! stats || typeof stats !== 'object' ) return false;
	return [
		stats.storageAttrs,
		stats.storageTextures,
		stats.texturesShared,
		stats.buffersAdopted,
		stats.buffersCopied,
	].some( ( value ) => Number.isFinite( value ) && value > 0 );

}

/**
 * Share sampled texture inputs for a delegated compute dispatch from the slim
 * renderer into the full renderer before `fullRenderer.computeAsync()`.
 *
 * This covers kernels that sample render-target textures produced by an
 * immediately previous slim render pass (for example a collision/depth map).
 * Legacy calls share ordinary sampled textures and skip storage resources.
 * Contract-aware callers can provide `bindingFilter`; returning `true` for an
 * exact storage-texture or storage-buffer input opts that location into the
 * same slim-to-full sharing transaction.
 *
 * @param {Object|Array<Object>} computeNode   - Compute node (or list).
 * @param {Object}               fullRenderer  - Full WebGPURenderer that will dispatch compute.
 * @param {Object}               slimRenderer  - Slim WebGPURenderer that rendered the sampled inputs.
 * @param {Object}               [opts]
 * @param {Object}               [opts.diagnostics] - Optional shareGPUTextureEntry diagnostics bag.
 * @param {Function}             [opts.bindingFilter] - `(binding, location, { direction, kind }) => boolean`; when present, only exact accepted locations are shared.
 * @param {boolean}              [opts.initializeBindings=true] - Set false to inspect NodeBuilderState bindings without creating full-renderer GPU bindings first.
 * @param {Function}             [opts.onSampledTexture] - `(texture, binding, location) => void` invoked for each successfully shared ordinary texture location.
 * @param {Function}             [opts.onStorageTexture] - `(texture, binding, location) => void` invoked for each successfully shared storage-texture input location.
 * @param {Function}             [opts.onStorageAttr] - `(attribute, binding, location) => void` invoked for each successfully shared storage-buffer input location.
 * @param {Function}             [opts.onInputSynced] - `(resource, binding, location, { direction, kind }) => void` invoked for every successfully shared input location.
 * @param {Function}             [opts.onInputNotSlimOwned] - `(resource, binding, location, detail) => void` invoked for an exact sampled-texture or storage-buffer location whose GPU resource is not owned by slim and therefore does not require sharing.
 * @param {Function}             [opts.onError] - `(err, textureOrBinding) => void` error hook.
 * @returns {{ texturesShared: number, skippedStorageTextures: number, missingTextures: number }}
 */
export function shareComputeSampledInputs( computeNode, fullRenderer, slimRenderer, opts = {} ) {

	const stats = { texturesShared: 0, skippedStorageTextures: 0, missingTextures: 0 };
	if ( ! computeNode || ! fullRenderer || ! slimRenderer || ! fullRenderer.backend || ! slimRenderer.backend ) return stats;

	const sharedTextures = new Map();
	const sharedStorageAttrs = new Map();
	const onSampledTexture = typeof opts.onSampledTexture === 'function' ? opts.onSampledTexture : null;
	const onStorageTexture = typeof opts.onStorageTexture === 'function' ? opts.onStorageTexture : null;
	const onStorageAttr = typeof opts.onStorageAttr === 'function' ? opts.onStorageAttr : null;
	const onInputSynced = typeof opts.onInputSynced === 'function' ? opts.onInputSynced : null;
	const onInputNotSlimOwned = typeof opts.onInputNotSlimOwned === 'function' ? opts.onInputNotSlimOwned : null;
	const exactFilter = typeof opts.bindingFilter === 'function';

	try {

		const bindGroups = opts.initializeBindings === false
			? uninitializedComputeBindGroups( computeNode, fullRenderer ) || []
			: getComputeBindGroups( computeNode, fullRenderer );
		const initializedComputeBindings = exactFilter && bindGroups.some( ( bindGroup ) => hasInitializedComputeBindGroup( fullRenderer, bindGroup ) );
		let computeBindingsInvalidated = false;
		for ( let groupIndex = 0; groupIndex < bindGroups.length; groupIndex ++ ) {

			const bindGroup = bindGroups[ groupIndex ];
			if ( ! bindGroup || ! bindGroup.bindings ) continue;
			for ( let bindingIndex = 0; bindingIndex < bindGroup.bindings.length; bindingIndex ++ ) {

				const binding = bindGroup.bindings[ bindingIndex ];
				const location = { group: groupIndex, binding: bindingIndex };
				if ( binding && binding.isStorageBuffer === true ) {

					if ( ! exactFilter || ! bindingFilterAllows( opts, binding, location, 'input', 'storage-buffer' ) ) continue;
					const attribute = binding.attribute;
					if ( ! attribute ) continue;
					let result = sharedStorageAttrs.get( attribute );
					if ( result === undefined ) {

						result = shareStorageBufferEntry( fullRenderer, slimRenderer, attribute );
						sharedStorageAttrs.set( attribute, result );

					}
					if ( result.notSlimOwned ) {

						const detail = {
							direction: 'input',
							kind: 'storage-buffer',
							shared: false,
							notSlimOwned: true,
							alreadyAvailable: result.alreadyAvailable,
						};
						callResourceHook( onInputNotSlimOwned, attribute, binding, location, detail );
						continue;

					}
					if ( result.replaced && initializedComputeBindings && ! computeBindingsInvalidated ) {

						if ( ! invalidateComputeBindGroups( fullRenderer, computeNode ) ) {

							result.fullData.buffer = result.previousBuffer;
							if ( result.fullAttributeData ) {

								if ( result.hadAttributeVersion ) result.fullAttributeData.version = result.previousAttributeVersion;
								else delete result.fullAttributeData.version;

							}
							result.shared = false;
							if ( typeof opts.onError === 'function' ) opts.onError(
								new Error( 'shareComputeSampledInputs: could not invalidate initialized full-renderer compute bindings after replacing a storage input buffer.' ),
								attribute,
							);
							continue;

						}
						computeBindingsInvalidated = true;

					}
					if ( ! result.shared ) continue;
					const detail = { direction: 'input', kind: 'storage-buffer' };
					callResourceHook( onStorageAttr, attribute, binding, location, detail );
					callResourceHook( onInputSynced, attribute, binding, location, detail );
					continue;

				}
				if ( ! binding || binding.isSampledTexture !== true ) continue;
				const storageTexture = binding.store === true || binding.texture && binding.texture.isStorageTexture === true;
				const kind = storageTexture ? 'storage-texture' : 'sampled-texture';
				if ( exactFilter && ! bindingFilterAllows( opts, binding, location, 'input', kind ) ) {

					if ( storageTexture ) stats.skippedStorageTextures ++;
					continue;

				}
				if ( storageTexture && ! exactFilter ) {

					stats.skippedStorageTextures ++;
					continue;

				}

				const texture = storageTexture ? binding.texture : sampledInputTextureFromBinding( binding );
				if ( ! texture ) {

					stats.missingTextures ++;
					continue;

				}
				// Preserve the unfiltered API exactly: ordinary sampled textures are
				// deduplicated, attempted once, and callbacks only report a transfer.
				// Contract-aware callers need per-location outcomes, handled below.
				if ( ! exactFilter ) {

					if ( sharedTextures.has( texture ) ) continue;
					sharedTextures.set( texture, null );
					const transferred = shareGPUTextureEntry( fullRenderer, slimRenderer, texture, {
						diagnostics: opts.diagnostics,
						onError: opts.onError,
						bumpVersion: opts.bumpVersion,
					} );
					if ( ! transferred ) continue;
					stats.texturesShared ++;
					callResourceHook( onSampledTexture, texture, binding, location, { direction: 'input', kind } );
					continue;

				}
				let result = sharedTextures.get( texture );
				if ( result === undefined ) {

					const slimTextureData = slimRenderer.backend.get( texture );
					const fullTextureData = fullRenderer.backend.get( texture );
					const slimOwnsTexture = !! ( slimTextureData && slimTextureData.texture );
					const notSlimOwned = ! storageTexture && ! slimOwnsTexture;
					const transferred = ! notSlimOwned && shareGPUTextureEntry( fullRenderer, slimRenderer, texture, {
						diagnostics: opts.diagnostics,
						onError: opts.onError,
						bumpVersion: opts.bumpVersion,
					} );
					result = {
						transferred: transferred === true,
						notSlimOwned,
						alreadyAvailable: notSlimOwned && !! ( fullTextureData && fullTextureData.texture ),
					};
					sharedTextures.set( texture, result );
					if ( result.transferred ) stats.texturesShared ++;

				}
				const detail = {
					direction: 'input',
					kind,
					shared: result.transferred,
					notSlimOwned: result.notSlimOwned,
					alreadyAvailable: result.alreadyAvailable,
				};
				if ( result.notSlimOwned ) {

					callResourceHook( onInputNotSlimOwned, texture, binding, location, detail );
					continue;

				}
				if ( ! result.transferred ) {

					stats.missingTextures ++;
					continue;

				}
				callResourceHook( storageTexture ? onStorageTexture : onSampledTexture, texture, binding, location, detail );
				callResourceHook( onInputSynced, texture, binding, location, detail );

			}

		}

	} catch ( err ) {

		if ( typeof opts.onError === 'function' ) opts.onError( err, computeNode );

	}

	return stats;

}

/**
 * Sync every storage output (texture + buffer) produced by `computeNode`
 * from `fullRenderer` to `slimRenderer`.
 *
 * - **Storage textures**: shared via `shareShadowGPUTextureIntoSlim` and
 *   regenerated mip levels if `texture.generateMipmaps !== false`.
 * - **Storage buffers**: if slim has no buffer yet, adopt full's reference
 *   (zero-copy); otherwise enqueue a `copyBufferToBuffer` on slim's device.
 *   When `slimRenderer._attributes.get(attr).version === undefined` the
 *   stub gets a starting version so slim's pipeline cache treats the new
 *   buffer as live.
 *
 * `opts.onStorageTexture(tex, binding)` and `opts.onStorageAttr(attr)` fire
 * for each storage resource encountered — adopters can use these to remember
 * resources that need re-wiring across dispatches. The corresponding
 * `onStorageTextureSynced` / `onStorageAttrSynced` hooks fire only after the
 * exact group/binding location was successfully shared, adopted, or copied.
 *
 * Errors are caught and surfaced through `opts.onError(err)`; one bad
 * binding never breaks the whole sync.
 * `opts.bindingFilter(binding, location, { direction: 'output', kind })` may
 * restrict synchronization to exact contracted output locations. Omitting it
 * preserves the legacy behavior of synchronizing every discovered storage
 * binding.
 *
 * @returns {{ texturesShared: number, storageAttrs: number, buffersAdopted: number, buffersCopied: number }}
 */
export function syncComputeStorageOutputs( computeNode, fullRenderer, slimRenderer, opts = {} ) {

	const stats = { texturesShared: 0, storageAttrs: 0, buffersAdopted: 0, buffersCopied: 0 };
	if ( ! computeNode || ! fullRenderer || ! slimRenderer || ! slimRenderer.backend ) return stats;
	const device = slimRenderer.backend.device;
	if ( ! device ) return stats;

	const onStorageAttr = typeof opts.onStorageAttr === 'function' ? opts.onStorageAttr : null;
	const onStorageTexture = typeof opts.onStorageTexture === 'function' ? opts.onStorageTexture : null;
	const onStorageAttrSynced = typeof opts.onStorageAttrSynced === 'function' ? opts.onStorageAttrSynced : null;
	const onStorageTextureSynced = typeof opts.onStorageTextureSynced === 'function' ? opts.onStorageTextureSynced : null;
	const onOutputSynced = typeof opts.onOutputSynced === 'function' ? opts.onOutputSynced : null;
	const generateMipmaps = opts.generateMipmaps !== false;
	const sharedTextures = new Map();
	let commandEncoder = null;

	try {

		const bindGroups = getComputeBindGroups( computeNode, fullRenderer );
		for ( let groupIndex = 0; groupIndex < bindGroups.length; groupIndex ++ ) {

			const bindGroup = bindGroups[ groupIndex ];
			if ( ! bindGroup || ! bindGroup.bindings ) continue;
			for ( let bindingIndex = 0; bindingIndex < bindGroup.bindings.length; bindingIndex ++ ) {

				const binding = bindGroup.bindings[ bindingIndex ];
				if ( ! binding ) continue;
				const location = { group: groupIndex, binding: bindingIndex };

				// Storage texture (textureStore target): copy GPU handle and
				// bump version so slim's bind-group cache refreshes.
				const tex = storageTextureFromBinding( binding );
				if ( tex ) {

					if ( ! bindingFilterAllows( opts, binding, location, 'output', 'storage-texture' ) ) continue;

					if ( onStorageTexture ) {

						try { onStorageTexture( tex, binding, location ); } catch ( _ ) {}

					}
					const firstTextureLocation = ! sharedTextures.has( tex );
					let shared = sharedTextures.get( tex );
					if ( firstTextureLocation ) {

						shared = shareShadowGPUTextureIntoSlim( tex, fullRenderer, slimRenderer );
						sharedTextures.set( tex, shared );
						if ( shared ) stats.texturesShared ++;

					}
					if ( ! shared ) continue;
					if ( onStorageTextureSynced ) {

						try { onStorageTextureSynced( tex, binding, location ); } catch ( _ ) {}

					}
					callResourceHook( onOutputSynced, tex, binding, location, { direction: 'output', kind: 'storage-texture' } );
					if ( firstTextureLocation && generateMipmaps && tex.generateMipmaps !== false && tex.mipmapsAutoUpdate !== false && typeof slimRenderer.backend.generateMipmaps === 'function' ) {

						try { slimRenderer.backend.generateMipmaps( tex ); } catch ( _ ) {}

					}
					continue;

				}

				// Storage buffer: adopt full's buffer if slim has none, else copy.
				if ( ! binding.isStorageBuffer ) continue;
				if ( ! bindingFilterAllows( opts, binding, location, 'output', 'storage-buffer' ) ) continue;
				const attr = binding.attribute;
				if ( ! attr ) continue;
				if ( onStorageAttr ) {

					try { onStorageAttr( attr, binding, location ); } catch ( _ ) {}

				}

				const fullBufData = fullRenderer.backend.get( attr );
				if ( ! fullBufData || ! fullBufData.buffer ) continue;
				const fullBuf = fullBufData.buffer;
				const slimBufData = slimRenderer.backend.get( attr );

				let synced = false;
				if ( ! slimBufData.buffer ) {

					slimBufData.buffer = fullBuf;
					const slimAttr = slimRenderer._attributes && typeof slimRenderer._attributes.get === 'function' ? slimRenderer._attributes.get( attr ) : null;
					if ( slimAttr && slimAttr.version === undefined ) slimAttr.version = 1;
					stats.storageAttrs ++;
					stats.buffersAdopted ++;
					synced = true;

				} else if ( slimBufData.buffer !== fullBuf ) {

					const slimBuf = slimBufData.buffer;
					const copySize = Math.min( fullBuf.size, slimBuf.size );
					if ( copySize > 0 ) {

						if ( ! commandEncoder ) commandEncoder = device.createCommandEncoder();
						commandEncoder.copyBufferToBuffer( fullBuf, 0, slimBuf, 0, copySize );
						stats.storageAttrs ++;
						stats.buffersCopied ++;
						synced = true;

					}

				} else {

					// Both renderers already use the same GPUBuffer. The dispatch still
					// mutated its contents, so callers must present another draw even
					// though no adopt/copy work was necessary.
					stats.storageAttrs ++;
					synced = true;

				}
				if ( synced && onStorageAttrSynced ) {

					try { onStorageAttrSynced( attr, binding, location ); } catch ( _ ) {}

				}
				if ( synced ) callResourceHook( onOutputSynced, attr, binding, location, { direction: 'output', kind: 'storage-buffer' } );

			}

		}

		if ( commandEncoder ) device.queue.submit( [ commandEncoder.finish() ] );

	} catch ( err ) {

		if ( typeof opts.onError === 'function' ) opts.onError( err );

	}

	return stats;

}

/**
 * Multi-pass storage sync. Bitonic sort, reductions, and other compute graphs
 * dispatch the *same* `GPUBuffer` as both the input and output across N passes.
 * Between passes, the full renderer's bind-group cache still references the
 * up-to-date `GPUBuffer`, but if the slim renderer has captured an old buffer
 * reference (from a previous pass's adopt) the cache won't refresh on its own.
 *
 * Call this after each pass that may have mutated a storage resource. When
 * `passIndex` is undefined, this behaves identically to the legacy single-call
 * `syncComputeStorageOutputs`. When `passIndex` is set, the same sync runs
 * unconditionally and `opts.onPass(passIndex, stats)` is invoked so adopters
 * can record per-pass diagnostics. Buffer adoption is idempotent: if the slim
 * renderer already holds the same `GPUBuffer` (from a prior pass), this is a
 * no-op for that binding.
 *
 * @param {Object|Array<Object>} computeNode   - Compute node (or list of nodes for this pass).
 * @param {Object}               fullRenderer  - Full WebGPURenderer that dispatched the pass.
 * @param {Object}               slimRenderer  - Slim WebGPURenderer (the draw target).
 * @param {number|undefined}     passIndex     - Zero-based pass index, or `undefined` for legacy single-call semantics.
 * @param {Object}               [opts]
 * @param {Function}             [opts.onPass] - `(passIndex, stats) => void` invoked after the per-pass sync.
 * @returns {{ texturesShared: number, storageAttrs: number, buffersAdopted: number, buffersCopied: number, pass: number|null }}
 */
export function syncComputeStorageOutputsPerPass( computeNode, fullRenderer, slimRenderer, passIndex, opts = {} ) {

	const stats = syncComputeStorageOutputs( computeNode, fullRenderer, slimRenderer, opts );
	const pass = typeof passIndex === 'number' && isFinite( passIndex ) ? passIndex : null;
	const out = { ...stats, pass };
	if ( pass !== null && typeof opts.onPass === 'function' ) {

		try { opts.onPass( pass, stats ); } catch ( _ ) {}

	}
	return out;

}

/**
 * Seed every authoritative precompiled render-artifact variant's storage-buffer
 * entries from compute outputs discovered by
 * `syncComputeStorageOutputs(..., { onStorageAttr })`.
 *
 * Material-local storage buffers are usually recoverable by walking
 * `material.colorNode`, `material.vertexNode`, etc. Renderer-owned systems
 * such as tiled lighting are different: compute writes the live buffer from a
 * lighting node, while the material shader only sees the final storage binding.
 * This helper bridges that gap by matching signed storage-buffer identities
 * (`source.attributeName`) plus shape. Legacy unsigned entries fall back to
 * shape only when exactly one candidate is possible, so two same-shaped
 * renderer resources can never silently exchange ownership.
 *
 * @param {Object} artifact
 * @param {Object|Object[]} attributes - Storage attributes or evidence records
 *   shaped as `{ attribute, binding?, attributeName? }`.
 * @param {Object} [opts]
 * @param {boolean} [opts.bumpVersion=true] - Bump the live attribute version so cached bind groups rebuild.
 * @param {boolean} [opts.allowVec3ToVec4=true] - Accept WebGPU vec3 storage padding captured as vec4.
 * @returns {number} number of artifact entries wired
 */
export function wireArtifactStorageBuffersFromAttributes( artifact, attributes, opts = {} ) {

	const artifacts = collectArtifactVariantCandidates( artifact );
	if ( artifacts.length === 0 ) return 0;

	const candidates = storageCandidateRecords( attributes );
	if ( candidates.length === 0 ) return 0;

	const bumpVersion = opts.bumpVersion !== false;
	const allowVec3ToVec4 = opts.allowVec3ToVec4 !== false;
	const bumpedAttributes = new Set();
	let wired = 0;

	for ( const candidateArtifact of artifacts ) {

		const plan = candidateArtifact && Array.isArray( candidateArtifact.uniformPlan ) ? candidateArtifact.uniformPlan : null;
		if ( ! plan || plan.length === 0 ) continue;
		const consumed = new Set();
		const seenEntries = new Set();
		const aliasMatches = new Map();
		const wireEntry = ( entry, groupIndex ) => {

			if ( ! entry || seenEntries.has( entry ) ) return;
			seenEntries.add( entry );
			if ( isLiveStorageAttribute( entry._liveAttribute ) ) return;
			const aliasKey = storageEntryAliasKey( entry, groupIndex );
			const aliasMatch = aliasMatches.get( aliasKey );
			if ( aliasMatch ) {

				defineLiveStorageAttribute( entry, aliasMatch, false );
				return;

			}

			const attributeName = storageEntryAttributeName( entry );
			const compatible = candidates.filter( ( candidate ) =>
				storageShapeMatches( candidate.attribute, entry, allowVec3ToVec4 )
			);
			let matches;
			if ( attributeName ) {

				matches = compatible.filter( ( candidate ) => candidate.attributeNames.has( attributeName ) );

			} else {

				matches = compatible.filter( ( candidate ) => ! consumed.has( candidate.attribute ) );

			}
			const uniqueAttributes = [ ...new Set( matches.map( ( candidate ) => candidate.attribute ) ) ];
			if ( uniqueAttributes.length !== 1 ) return;
			const match = uniqueAttributes[ 0 ];
			const shouldBump = bumpVersion && ! bumpedAttributes.has( match );

			defineLiveStorageAttribute( entry, match, shouldBump );
			if ( shouldBump ) bumpedAttributes.add( match );
			consumed.add( match );
			aliasMatches.set( aliasKey, match );
			wired ++;

		};

		for ( let groupIndex = 0; groupIndex < plan.length; groupIndex ++ ) {

			const group = plan[ groupIndex ];

			for ( const entry of group && group.storageBuffers || [] ) wireEntry( entry, groupIndex );
			for ( const binding of group && group.orderedBindings || [] ) {

				if ( ! binding || binding.type !== 'storage-buffer' || ! binding.ref ) continue;
				wireEntry( binding.ref, groupIndex );

			}

		}

	}

	return wired;

}

function bumpTextureVersion( renderer, texture, nextVersion ) {

	if ( ! renderer || ! renderer.backend || ! texture ) return false;
	const backendData = renderer.backend.get( texture );
	if ( backendData ) {

		clearTextureViewCache( backendData );
		backendData.version = nextVersion;
		backendData.generation = nextVersion;

	}
	const tx = renderer._textures;
	const txData = tx && typeof tx.get === 'function' ? tx.get( texture ) : null;
	if ( txData ) {

		txData.version = nextVersion;
		txData.generation = nextVersion;
		if ( txData.bindGroups && typeof txData.bindGroups.clear === 'function' ) {

			for ( const bindGroup of txData.bindGroups ) {

				const bindingsData = renderer.backend.get( bindGroup );
				if ( bindingsData ) {

					bindingsData.groups = undefined;
					bindingsData.versions = undefined;

				}

			}
			txData.bindGroups.clear();

		}

	}
	return true;

}

/**
 * Ping-pong storage-texture invalidation.
 *
 * When a compute kernel alternates which texture it reads from / writes to
 * across frames (textureA → textureB on even frames, B → A on odd frames),
 * the slim renderer's bind-group cache still references whichever texture
 * was bound on the previous frame. Bumping each texture's `version` /
 * `generation` and clearing the cached `GPUTextureView`s forces Bindings._update
 * to rebuild against the freshly-swapped GPU resource.
 *
 * Both renderer instances should call this on swap: typically the slim
 * renderer (where the draw call samples the read-side texture), and any
 * full renderer that may have stale views from the prior dispatch.
 *
 * Pass a single renderer or an array — passing both renderers is the common case.
 *
 * @param {Object} textureA - First storage texture in the ping-pong pair.
 * @param {Object} textureB - Second storage texture in the ping-pong pair.
 * @param {Object|Object[]} renderers - One renderer or list of renderers whose caches should be invalidated.
 * @returns {boolean} true if invalidation was applied to at least one renderer.
 */
export function pingPongInvalidate( textureA, textureB, renderers ) {

	if ( ! textureA || ! textureB ) return false;
	const list = Array.isArray( renderers ) ? renderers.filter( Boolean ) : ( renderers ? [ renderers ] : [] );
	if ( list.length === 0 ) return false;

	const nextA = ( textureA.version | 0 ) + 1;
	const nextB = ( textureB.version | 0 ) + 1;
	textureA.version = nextA;
	textureB.version = nextB;

	let any = false;
	for ( const renderer of list ) {

		try {

			if ( bumpTextureVersion( renderer, textureA, nextA ) ) any = true;
			if ( bumpTextureVersion( renderer, textureB, nextB ) ) any = true;

		} catch ( _ ) { /* tolerate */ }

	}
	return any;

}

/**
 * Adopt a `GPUBuffer` allocated by the full renderer into the slim renderer for
 * a vertex-pulled `BufferAttribute` (typically `InstancedBufferAttribute` whose
 * storage is the output of a compute kernel).
 *
 * Mirrors `shareShadowGPUTextureIntoSlim` but for the `_attributes` /
 * `backend._buffers` data path. If the slim renderer already holds a buffer
 * for the attribute (from a previous render), the call is a no-op for that
 * binding and returns `false` — adopters should `pingPongInvalidate` or copy
 * separately in that case.
 *
 * Returns `true` on a successful adopt — the slim renderer now sees the same
 * `GPUBuffer` the compute kernel wrote into.
 *
 * @param {Object} attribute    - The `BufferAttribute` / `InstancedBufferAttribute` being read.
 * @param {Object} fullRenderer - Full WebGPURenderer that dispatched the compute.
 * @param {Object} slimRenderer - Slim WebGPURenderer whose draw call reads `attribute`.
 * @returns {boolean} true if the buffer was adopted.
 */
export function shareInstancedAttributeBufferIntoSlim( attribute, fullRenderer, slimRenderer ) {

	if ( ! attribute || ! fullRenderer || ! fullRenderer.backend || ! slimRenderer || ! slimRenderer.backend ) return false;

	const fullData = fullRenderer.backend.get( attribute );
	if ( ! fullData || ! fullData.buffer ) return false;

	const slimData = slimRenderer.backend.get( attribute );
	if ( ! slimData ) return false;

	// Skip if slim already references the exact same GPU buffer.
	if ( slimData.buffer === fullData.buffer ) return false;

	// If slim already has its own (different) buffer, the caller is expected
	// to perform a buffer-to-buffer copy (or to invalidate before adopting).
	// We refuse to silently swap an existing distinct buffer because the
	// slim renderer's bind-group cache may already reference it.
	if ( slimData.buffer ) return false;

	slimData.buffer = fullData.buffer;

	const slimAttrs = slimRenderer._attributes;
	if ( slimAttrs && typeof slimAttrs.get === 'function' ) {

		const slimAttr = slimAttrs.get( attribute );
		if ( slimAttr ) {

			if ( slimAttr.version === undefined ) slimAttr.version = 1;
			else slimAttr.version = ( slimAttr.version | 0 ) + 1;

		}

	}

	return true;

}
