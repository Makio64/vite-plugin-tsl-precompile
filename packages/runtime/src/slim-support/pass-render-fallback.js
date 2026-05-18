/**
 * @module SlimSupport/PassRenderFallback
 *
 * Productized primitive for rendering a three.js `PassNode` through the
 * full-renderer fallback when the slim bundle cannot compile its WGSL on
 * the fly.
 *
 * The harness's `__renderPassNodeWithFullRenderer` in
 * `packages/examples/batch/run-e2e.mjs` does the full thing — including
 * harness-specific scene-material swap decisions and a `_sceneHasMultiOutputPrecompiledMaterial`
 * gate. This module exposes the *renderer state save/restore + render
 * primitive* without the harness-specific decisions, so adopters can:
 *
 *   1. Decide for themselves whether a given `PassNode` is one the full
 *      renderer should handle (we don't try to second-guess this).
 *   2. Call `renderPassWithFullRenderer({ passNode, slimRenderer,
 *      fullRenderer, camera })` to do the actual render.
 *   3. Get the resulting render-target textures shared back into the slim
 *      renderer via `sharePassRenderTargetTextures(...)` or the higher-level
 *      `createSlimSceneSupport().renderPassWithFallback(...)`.
 *
 * What this module *does not* do (deliberately):
 *   - Walk the scene to decide "should this pass go to full?"
 *   - Wrap user materials in source-material proxies
 *   - Manage `contextNode` per-pass overrides
 *
 * Those decisions are domain-specific (multi-output MRT detection, user
 * materials with backside pipelines, etc.) and belong in the caller until
 * the broader harness extraction lands.
 */

import { shareGPUTextureEntry } from './gpu-texture-share.js';

function readDrawingBufferSize( renderer ) {

	if ( ! renderer || typeof renderer.getDrawingBufferSize !== 'function' ) return null;

	const size = {
		width: 0,
		height: 0,
		set( width, height ) {

			this.width = width;
			this.height = height;
			return this;

		},
	};

	try {

		return renderer.getDrawingBufferSize( size ) || size;

	} catch ( _ ) {

		return null;

	}

}

/**
 * Render a `PassNode` using a full `WebGPURenderer`, with the slim renderer's
 * tone-mapping / color-space state forwarded and the full renderer's
 * drawing-buffer size / render-target / MRT / autoClear state forwarded or
 * saved and restored.
 *
 * Returns `true` when the render succeeded; `false` otherwise (caller can
 * fall back to whatever).
 *
 * @param {Object} args
 * @param {Object} args.passNode      - the live `PassNode` (must have `.scene` + `.renderTarget`)
 * @param {Object} args.slimRenderer  - the slim `WebGPURenderer`
 * @param {Object} args.fullRenderer  - the full `WebGPURenderer` from the fallback
 * @param {Object} [args.camera]      - camera (defaults to `passNode.camera`)
 * @param {Function} [args.beforeRender] - optional `() => void` run inside the saved state, before `fullRenderer.render`
 * @param {Function} [args.onError]   - `(err) => void` for fatal render failures (silently returns `false`)
 * @return {boolean} success
 */
export function renderPassWithFullRenderer( args ) {

	const { passNode, slimRenderer, fullRenderer, camera, beforeRender, onError } = args || {};
	if ( ! passNode || ! slimRenderer || ! fullRenderer ) return false;
	if ( ! passNode.scene || ! passNode.renderTarget ) return false;

	// Forward output-stage state from slim → full. Without these the full
	// renderer would tone-map / color-transform with whatever the user last
	// set on it (or its defaults), producing a visible mismatch.
	try {

		fullRenderer.toneMapping = slimRenderer.toneMapping;
		fullRenderer.toneMappingExposure = slimRenderer.toneMappingExposure;
		fullRenderer.outputColorSpace = slimRenderer.outputColorSpace;
		const size = readDrawingBufferSize( slimRenderer );
		if ( size && typeof fullRenderer.setSize === 'function' ) fullRenderer.setSize( size.width, size.height, false );

	} catch ( _ ) { /* harmless: full might be missing one of these props */ }

	// Save the full renderer's pipeline-affecting state so we can restore
	// it whether the render succeeds or throws. Order matches what
	// `__renderPassNodeWithFullRenderer` does in the harness.
	let currentRenderTarget = null;
	let currentMRT = null;
	let currentAutoClear;
	let currentTransparent;
	let currentOpaque;
	let currentContextNode;
	try {

		currentRenderTarget = typeof fullRenderer.getRenderTarget === 'function' ? fullRenderer.getRenderTarget() : null;
		currentMRT = typeof fullRenderer.getMRT === 'function' ? fullRenderer.getMRT() : null;
		currentAutoClear = fullRenderer.autoClear;
		currentTransparent = fullRenderer.transparent;
		currentOpaque = fullRenderer.opaque;
		currentContextNode = fullRenderer.contextNode;

	} catch ( err ) {

		if ( onError ) onError( err );
		return false;

	}

	try {

		fullRenderer.setRenderTarget( passNode.renderTarget );
		if ( typeof fullRenderer.setMRT === 'function' ) fullRenderer.setMRT( null );
		fullRenderer.autoClear = true;
		fullRenderer.transparent = !! passNode.transparent;
		fullRenderer.opaque = passNode.opaque !== false;
		if ( typeof beforeRender === 'function' ) beforeRender();
		fullRenderer.render( passNode.scene, camera || passNode.camera );
		return true;

	} catch ( err ) {

		if ( onError ) onError( err );
		return false;

	} finally {

		try { fullRenderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
		try { if ( typeof fullRenderer.setMRT === 'function' ) fullRenderer.setMRT( currentMRT ); } catch ( _ ) {}
		try { fullRenderer.autoClear = currentAutoClear; } catch ( _ ) {}
		try { fullRenderer.transparent = currentTransparent; } catch ( _ ) {}
		try { fullRenderer.opaque = currentOpaque; } catch ( _ ) {}
		try { fullRenderer.contextNode = currentContextNode; } catch ( _ ) {}

	}

}

/**
 * Share every texture produced by a pass render-target from the full renderer
 * back into the slim renderer's backend data map. Handles ordinary
 * `renderTarget.texture`, MRT `renderTarget.textures`, and optional
 * `renderTarget.depthTexture`.
 *
 * @param {Object} args
 * @param {Object} args.passNode
 * @param {Object} args.slimRenderer
 * @param {Object} args.fullRenderer
 * @param {boolean} [args.shareDepth=true]
 * @param {Object} [args.diagnostics]
 * @param {Function} [args.onError]
 * @return {{ texturesShared: number, depthShared: boolean }}
 */
export function sharePassRenderTargetTextures( args ) {

	const { passNode, slimRenderer, fullRenderer, shareDepth = true, diagnostics, onError } = args || {};
	const target = passNode && passNode.renderTarget;
	const stats = { texturesShared: 0, depthShared: false };
	if ( ! target || ! slimRenderer || ! fullRenderer ) return stats;

	const textures = Array.isArray( target.textures )
		? target.textures
		: target.texture ? [ target.texture ] : [];

	for ( const texture of textures ) {

		if ( shareGPUTextureEntry( slimRenderer, fullRenderer, texture, { diagnostics, onError } ) ) stats.texturesShared ++;

	}

	if ( shareDepth !== false && target.depthTexture ) {

		stats.depthShared = shareGPUTextureEntry( slimRenderer, fullRenderer, target.depthTexture, { diagnostics, onError } );

	}

	return stats;

}
