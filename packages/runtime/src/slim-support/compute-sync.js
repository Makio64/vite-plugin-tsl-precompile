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

import { shareShadowGPUTextureIntoSlim } from './gpu-texture-share.js';

function asList( node ) { return Array.isArray( node ) ? node : [ node ]; }

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

			if ( binding && binding.isSampledTexture && binding.texture && binding.texture.isStorageTexture === true ) return true;

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
 * `opts.onStorageAttr(attr)` fires for each storage attribute encountered —
 * adopters can use this to remember attributes that need re-wiring across
 * dispatches (see the harness's `__computeStorageAttrFallbacks`).
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
				if ( binding.isSampledTexture && binding.texture && binding.texture.isStorageTexture === true ) {

					const tex = binding.texture;
					const shared = shareShadowGPUTextureIntoSlim( tex, fullRenderer, slimRenderer );
					if ( ! shared ) continue;
					stats.texturesShared ++;
					if ( generateMipmaps && tex.generateMipmaps !== false && typeof slimRenderer.backend.generateMipmaps === 'function' ) {

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
