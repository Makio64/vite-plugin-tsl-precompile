/**
 * GPU-texture sharing across `WebGPURenderer` instances.
 *
 * The slim runtime composes two renderers in advanced scenarios: the user-
 * facing slim renderer (no node builder) plus an off-screen "fallback" full
 * renderer that handles PMREM generation, dynamic shadow scenes, or other
 * features that need a live node-graph compiler. Once the full renderer has
 * allocated a GPU texture, the slim renderer needs to bind to *the same*
 * `GPUTexture` rather than allocating its own — otherwise it samples a
 * stale or uninitialised 1×1 stand-in.
 *
 * Each WebGPURenderer carries a `backend` DataMap keyed by JS textures
 * (the GPUTexture itself, the format string, mip descriptors) and a
 * `_textures` DataMap on the Textures manager that tracks
 * `initialized` / `version` / `bindGroups`. To share a texture we must
 * copy the backend entry *and* mark the Textures manager entry as
 * initialised, otherwise `updateTexture()` calls
 * `backend.createTexture()` and throws "Texture already initialized."
 *
 * This module is harness-agnostic. The optional `diagnostics` object
 * lets callers tally calls/hits/misses for reporting. All errors are
 * caught and surfaced through `onError` (default: silent) so a missing
 * texture in one share call never breaks the whole render frame.
 *
 * @module SlimSupportGPUTextureShare
 */

const VIEW_KEY_PREFIX = 'view-';

// Per-backend sampler bookkeeping. `WebGPUTextureUtils.updateSampler` keys
// `samplerKey` into that backend's private `_samplerCache`; copying these
// fields across renderers leaves the target pointing at a key its own cache
// has never seen, and its next sampler transition crashes on
// `oldSamplerData.usedTimes--` (undefined). Samplers are cheap per-backend
// objects — let the target create its own.
const BACKEND_LOCAL_KEYS = new Set( [ 'sampler', 'samplerKey' ] );

function copySharedBackendData( targetData, sourceData ) {

	for ( const key of Object.keys( sourceData ) ) {

		if ( BACKEND_LOCAL_KEYS.has( key ) ) continue;
		targetData[ key ] = sourceData[ key ];

	}

}

function bump( diagnostics, key ) {

	if ( ! diagnostics || ! key ) return;
	diagnostics[ key ] = ( diagnostics[ key ] | 0 ) + 1;

}

/**
 * Strip cached `view-*` entries from a backend texture data record.
 * Called after the underlying `GPUTexture` is replaced so the next bind
 * group rebuild creates fresh `GPUTextureView`s against the new texture.
 */
export function clearTextureViewCache( textureData ) {

	if ( ! textureData ) return;
	for ( const key of Object.keys( textureData ) ) {

		if ( key.startsWith( VIEW_KEY_PREFIX ) ) delete textureData[ key ];

	}

}

/**
 * Mark a texture as initialised in the renderer's Textures DataMap. This
 * stops `Textures.updateTexture()` from calling `backend.createTexture()`
 * (which would throw "Texture already initialized" on a shared GPU texture).
 *
 * Idempotent.
 */
export function markTextureInitialized( renderer, texture ) {

	if ( ! renderer || ! texture ) return;
	const tx = renderer._textures;
	if ( ! tx || typeof tx.get !== 'function' ) return;
	const txData = tx.get( texture );
	if ( ! txData ) return;
	txData.initialized = true;
	txData.isDefaultTexture = false;
	txData.version = texture.version;
	txData.generation = texture.version;
	if ( ! txData.bindGroups ) txData.bindGroups = new Set();

}

function markSharedTextureVersion( renderer, texture, version ) {

	if ( ! renderer || ! texture ) return;
	if ( renderer.backend && typeof renderer.backend.get === 'function' ) {

		const backendData = renderer.backend.get( texture );
		if ( backendData ) {

			backendData.version = version;
			backendData.generation = version;
			backendData.initialized = true;
			backendData.isDefaultTexture = false;

		}

	}
	const textures = renderer._textures;
	if ( textures && typeof textures.get === 'function' ) {

		const textureData = textures.get( texture );
		if ( textureData ) {

			textureData.initialized = true;
			textureData.isDefaultTexture = false;
			textureData.version = version;
			textureData.generation = version;
			if ( ! textureData.bindGroups ) textureData.bindGroups = new Set();

		}

	}

}

function layeredDepth( texture, gpuTexture = null ) {

	const image = texture && texture.image || null;
	const depth = image && ( image.depth || image.depthOrArrayLayers )
		|| gpuTexture && gpuTexture.depthOrArrayLayers
		|| 0;
	const numericDepth = Number( depth );
	return Number.isFinite( numericDepth ) ? numericDepth : 0;

}

function markLayeredDepthTextureAsArray( texture, gpuTexture = null ) {

	if ( ! texture || texture.isDepthTexture !== true ) return false;
	const depth = layeredDepth( texture, gpuTexture );
	if ( depth <= 1 ) return false;

	texture.isArrayTexture = true;
	if ( texture.image ) texture.image.depth = depth;
	return true;

}

function invalidateTextureBindGroups( renderer, texture ) {

	const tx = renderer && renderer._textures;
	const txData = tx && typeof tx.get === 'function' ? tx.get( texture ) : null;
	if ( ! txData || ! txData.bindGroups ) return txData;

	for ( const bindGroup of txData.bindGroups ) {

		const bindingsData = renderer.backend && renderer.backend.get ? renderer.backend.get( bindGroup ) : null;
		if ( bindingsData ) {

			bindingsData.groups = undefined;
			bindingsData.versions = undefined;

		}

	}
	txData.bindGroups.clear();
	return txData;

}

/**
 * Copy the backend data record for `texture` from `sourceRenderer` to
 * `targetRenderer`, then mark the target's Textures manager entry as
 * initialised. Used to bind the slim renderer to a `GPUTexture` the full
 * renderer already allocated (e.g. a PMREM output, a shadow depth map).
 *
 * @param {Object} targetRenderer - The renderer that should adopt the shared GPU texture.
 * @param {Object} sourceRenderer - The renderer that owns the source backend entry.
 * @param {Object} texture        - The JS `Texture` instance both renderers reference.
 * @param {Object} [opts]
 * @param {Object} [opts.diagnostics] - Optional counter object: `{ calls, noSourceData, noSourceTexture, success, names, missingNames }`.
 * @param {Function} [opts.onError]   - Optional `(err, texture) => void` for catching share failures.
 * @returns {boolean} true if the share succeeded.
 */
export function shareGPUTextureEntry( targetRenderer, sourceRenderer, texture, opts = {} ) {

	if ( ! targetRenderer || ! sourceRenderer || ! texture ) return false;
	if ( ! targetRenderer.backend || ! sourceRenderer.backend ) return false;

	const diagnostics = opts.diagnostics || null;
	bump( diagnostics, 'calls' );

	try {

		let sourceData = sourceRenderer.backend.get( texture );
		if ( ( ! sourceData || ! sourceData.texture ) && texture.renderTarget && typeof sourceRenderer.initRenderTarget === 'function' ) {

			try {

				sourceRenderer.initRenderTarget( texture.renderTarget );
				sourceData = sourceRenderer.backend.get( texture );

			} catch ( _ ) {}

		}
		if ( ! sourceData ) {

			bump( diagnostics, 'noSourceData' );
			return false;

		}
		if ( ! sourceData.texture ) {

			bump( diagnostics, 'noSourceTexture' );
			if ( diagnostics && Array.isArray( diagnostics.missingNames ) && diagnostics.missingNames.length < 20 ) {

				diagnostics.missingNames.push( texture.name || 'unnamed' );

			}
			return false;

		}

		// Invalidate any bind groups the target had built against the
		// previous (stand-in) texture so the next render rebuilds them
		// against the shared GPU resource.
		invalidateTextureBindGroups( targetRenderer, texture );

		const targetData = targetRenderer.backend.get( texture );
		copySharedBackendData( targetData, sourceData );
		clearTextureViewCache( targetData );

		if ( opts.bumpVersion !== false ) {

			const nextVersion = ( texture.version | 0 ) + 1;
			texture.version = nextVersion;
			markSharedTextureVersion( sourceRenderer, texture, nextVersion );
			markSharedTextureVersion( targetRenderer, texture, nextVersion );

		} else {

			markTextureInitialized( targetRenderer, texture );

		}

		bump( diagnostics, 'success' );
		if ( diagnostics && Array.isArray( diagnostics.names ) && diagnostics.names.length < 20 ) {

			diagnostics.names.push( texture.name || 'unnamed' );

		}
		return true;

	} catch ( err ) {

		if ( typeof opts.onError === 'function' ) opts.onError( err, texture );
		return false;

	}

}

/**
 * Bind a PMREM texture from the full renderer into the slim renderer. Same
 * mechanism as `shareGPUTextureEntry` but with PMREM-specific diagnostics
 * keys (`shareCalls`, `shareMissingTexture`, `shareSuccess`) so a single
 * counter object can sit alongside `kickGenerate`/`wireArtifact` counters.
 *
 * @returns {boolean} true if the share succeeded.
 */
export function sharePMREMGPUTexture( slimRenderer, fullRenderer, pmrem, opts = {} ) {

	if ( ! slimRenderer || ! fullRenderer || ! pmrem ) return false;
	if ( ! slimRenderer.backend || ! fullRenderer.backend ) return false;

	const diagnostics = opts.diagnostics || null;
	bump( diagnostics, 'shareCalls' );

	try {

		const fullData = fullRenderer.backend.get( pmrem );
		if ( ! fullData || ! fullData.texture ) {

			bump( diagnostics, 'shareMissingTexture' );
			return false;

		}

		const slimData = slimRenderer.backend.get( pmrem );
		copySharedBackendData( slimData, fullData );
		markTextureInitialized( slimRenderer, pmrem );
		bump( diagnostics, 'shareSuccess' );
		return true;

	} catch ( err ) {

		if ( typeof opts.onError === 'function' ) opts.onError( err, pmrem );
		return false;

	}

}

/**
 * Bind a shadow / VSM blur render-target texture allocated by the full
 * renderer into slim. Unlike `shareGPUTextureEntry`, this bumps the JS
 * texture's `version` so the slim renderer's `Bindings._update` rebuilds
 * its bind group cache — otherwise a previously-cached group built against
 * a fresh 1×1 stand-in would be reused and shadow sampling returns 0
 * (no shadow / overdark shadow).
 *
 * Mirrors the backend version on both renderers so neither side later
 * recreates the shared `GPUTexture` on its next pass.
 *
 * @returns {boolean} true if the share succeeded.
 */
export function shareShadowGPUTextureIntoSlim( tex, fullRenderer, slimRenderer ) {

	if ( ! tex || ! fullRenderer || ! fullRenderer.backend || ! slimRenderer || ! slimRenderer.backend ) return false;
	const fullData = fullRenderer.backend.get( tex );
	if ( ! fullData || ! fullData.texture ) return false;

	markLayeredDepthTextureAsArray( tex, fullData.texture );

	if ( ! shareGPUTextureEntry( slimRenderer, fullRenderer, tex ) ) return false;
	const slimData = slimRenderer.backend.get( tex );
	slimData.__tslpSharedShadowGPUTexture = fullData.texture;
	return true;

}
