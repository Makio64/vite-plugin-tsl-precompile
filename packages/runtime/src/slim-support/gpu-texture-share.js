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
		const tx = targetRenderer._textures;
		const txData = tx && typeof tx.get === 'function' ? tx.get( texture ) : null;
		if ( txData && txData.bindGroups ) {

			for ( const bindGroup of txData.bindGroups ) {

				const bindingsData = targetRenderer.backend.get( bindGroup );
				if ( bindingsData ) {

					bindingsData.groups = undefined;
					bindingsData.versions = undefined;

				}

			}
			txData.bindGroups.clear();

		}

		const targetData = targetRenderer.backend.get( texture );
		for ( const key of Object.keys( sourceData ) ) targetData[ key ] = sourceData[ key ];
		markTextureInitialized( targetRenderer, texture );

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
		for ( const key of Object.keys( fullData ) ) slimData[ key ] = fullData[ key ];
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
	const slimData = slimRenderer.backend.get( tex );
	if ( ! fullData || ! fullData.texture || ! slimData ) return false;

	clearTextureViewCache( slimData );
	slimData.texture = fullData.texture;
	slimData.__tslpSharedShadowGPUTexture = fullData.texture;
	slimData.format = fullData.format;
	slimData.initialized = true;
	slimData.isDefaultTexture = false;

	const nextVersion = ( tex.version | 0 ) + 1;
	tex.version = nextVersion;
	slimData.version = nextVersion;
	slimData.generation = nextVersion;
	fullData.version = nextVersion;
	if ( ! slimData.bindGroups ) slimData.bindGroups = new Set();

	const stx = slimRenderer._textures;
	if ( stx && typeof stx.get === 'function' ) {

		const txData = stx.get( tex );
		if ( txData ) {

			txData.initialized = true;
			txData.isDefaultTexture = false;
			txData.version = nextVersion;
			txData.generation = nextVersion;
			if ( ! txData.bindGroups ) txData.bindGroups = new Set();

		}

	}

	const ftx = fullRenderer._textures;
	if ( ftx && typeof ftx.get === 'function' ) {

		const ftxData = ftx.get( tex );
		if ( ftxData ) {

			ftxData.initialized = true;
			ftxData.version = nextVersion;
			ftxData.generation = nextVersion;

		}

	}

	return true;

}
