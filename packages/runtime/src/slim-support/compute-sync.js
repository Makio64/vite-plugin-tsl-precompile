/**
 * Compute-output synchronisation between two `WebGPURenderer` instances.
 *
 * The slim runtime ships no compute kernel compiler (the node builder is
 * tree-shaken). When a scene declares `material.positionNode = Fn(...)().compute(N)`
 * or runs `renderer.compute(node)`, the slim renderer can't generate the
 * `GPUComputePipeline` itself — it has to borrow a full renderer that does.
 * After the full renderer dispatches the kernel, the slim renderer needs to
 * read the *same* `GPUBuffer` / `GPUTexture` so its draw call sees the
 * compute output rather than a fresh, zeroed stand-in.
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

import { shareShadowGPUTextureIntoSlim, clearTextureViewCache } from './gpu-texture-share.js';

function asList( node ) { return Array.isArray( node ) ? node : [ node ]; }

function storageTextureFromBinding( binding ) {

	if ( ! binding || ! binding.isSampledTexture ) return null;
	const texture = binding.texture;
	return texture && texture.isStorageTexture === true ? texture : null;

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
 * resources that need re-wiring across dispatches.
 *
 * Errors are caught and surfaced through `opts.onError(err)`; one bad
 * binding never breaks the whole sync.
 *
 * @returns {{ texturesShared: number, buffersAdopted: number, buffersCopied: number }}
 */
export function syncComputeStorageOutputs( computeNode, fullRenderer, slimRenderer, opts = {} ) {

	const stats = { texturesShared: 0, buffersAdopted: 0, buffersCopied: 0 };
	if ( ! computeNode || ! fullRenderer || ! slimRenderer || ! slimRenderer.backend ) return stats;
	const device = slimRenderer.backend.device;
	if ( ! device ) return stats;

	const onStorageAttr = typeof opts.onStorageAttr === 'function' ? opts.onStorageAttr : null;
	const onStorageTexture = typeof opts.onStorageTexture === 'function' ? opts.onStorageTexture : null;
	const generateMipmaps = opts.generateMipmaps !== false;
	let commandEncoder = null;

	try {

		const bindGroups = getComputeBindGroups( computeNode, fullRenderer );
		for ( const bindGroup of bindGroups ) {

			if ( ! bindGroup || ! bindGroup.bindings ) continue;
			for ( const binding of bindGroup.bindings ) {

				if ( ! binding ) continue;

				// Storage texture (textureStore target): copy GPU handle and
				// bump version so slim's bind-group cache refreshes.
				const tex = storageTextureFromBinding( binding );
				if ( tex ) {

					if ( onStorageTexture ) {

						try { onStorageTexture( tex, binding ); } catch ( _ ) {}

					}
					const shared = shareShadowGPUTextureIntoSlim( tex, fullRenderer, slimRenderer );
					if ( ! shared ) continue;
					stats.texturesShared ++;
					if ( generateMipmaps && tex.generateMipmaps !== false && tex.mipmapsAutoUpdate !== false && typeof slimRenderer.backend.generateMipmaps === 'function' ) {

						try { slimRenderer.backend.generateMipmaps( tex ); } catch ( _ ) {}

					}
					continue;

				}

				// Storage buffer: adopt full's buffer if slim has none, else copy.
				if ( ! binding.isStorageBuffer ) continue;
				const attr = binding.attribute;
				if ( ! attr ) continue;
				if ( onStorageAttr ) {

					try { onStorageAttr( attr ); } catch ( _ ) {}

				}

				const fullBufData = fullRenderer.backend.get( attr );
				if ( ! fullBufData || ! fullBufData.buffer ) continue;
				const fullBuf = fullBufData.buffer;
				const slimBufData = slimRenderer.backend.get( attr );

				if ( ! slimBufData.buffer ) {

					slimBufData.buffer = fullBuf;
					const slimAttr = slimRenderer._attributes && typeof slimRenderer._attributes.get === 'function' ? slimRenderer._attributes.get( attr ) : null;
					if ( slimAttr && slimAttr.version === undefined ) slimAttr.version = 1;
					stats.buffersAdopted ++;

				} else if ( slimBufData.buffer !== fullBuf ) {

					const slimBuf = slimBufData.buffer;
					const copySize = Math.min( fullBuf.size, slimBuf.size );
					if ( copySize > 0 ) {

						if ( ! commandEncoder ) commandEncoder = device.createCommandEncoder();
						commandEncoder.copyBufferToBuffer( fullBuf, 0, slimBuf, 0, copySize );
						stats.buffersCopied ++;

					}

				}

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
 * @returns {{ texturesShared: number, buffersAdopted: number, buffersCopied: number, pass: number|null }}
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
