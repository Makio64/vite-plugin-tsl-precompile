/**
 * Descriptor-driven orchestrator for the five per-frame rebinder factories.
 *
 * Built on top of (not replacing) the existing rebinder modules — each kind
 * still has its own implementation in `shadow-depth-rebinder.js`,
 * `texture-rebinders.js`, `viewport-texture-rebinder.js`, and
 * `reflector-texture-rebinder.js`. What changed: instead of the hydrator
 * inlining six `if (... > 0) createXxxRebinder(...)` branches, it now passes
 * the grouped bindings + dependency bag to `createDynamicBindingResolvers`
 * and gets back two ordered arrays — `earlyUpdateBefore` and
 * `lateUpdateBefore` — that flank the live-node sidecars in the final
 * `updateBefore` schedule.
 *
 * Pairs with the `dynamicBindings` descriptor section emitted into artifacts
 * by `@tsl-precompile/contract/dynamic-bindings`: the artifact now declares
 * which slots need per-frame resolution and from where; this module is the
 * runtime side that builds the rebinder pipeline matching those descriptors.
 *
 * @module Hydrate.Rebinders.DynamicBindingResolver
 */

import { createReflectorTextureRebinder } from './reflector-texture-rebinder.js';
import { createShadowDepthRebinder } from './shadow-depth-rebinder.js';
import { createArtifactTextureRebinder, createMaterialTextureRebinder } from './texture-rebinders.js';
import { createViewportTextureRebinder } from './viewport-texture-rebinder.js';

/**
 * @typedef {Object} RebinderBindingsBag
 * @property {Array<Object>} shadowDepthBindings   — depth.texture, owned by lights
 * @property {Array<Object>} materialDepthBindings — depth.texture, owned by the material's node graph (reflector depth etc.)
 * @property {Array<Object>} artifactTextureBindings — artifact.texture
 * @property {Array<Object>} materialTextureBindings — material.* texture slots
 * @property {Array<Object>} viewportTextureBindings — viewport.texture
 * @property {Array<Object>} reflectorTextureBindings — reflector.texture
 */

/**
 * @typedef {Object} RebinderDeps
 * @property {Function} resolveTextureBinding — used by texture rebinders
 * @property {Function} findLightBySource     — used by shadow-depth rebinder
 * @property {Function} recordShadowDiagnostic — `(event) => void`
 * @property {Function} describeLight         — light diagnostic shape helper
 */

/**
 * Build the ordered set of `updateBefore` rebinder nodes for an artifact.
 *
 * Returns `{ earlyUpdateBefore, lateUpdateBefore }`:
 *
 * - `earlyUpdateBefore` runs BEFORE the artifact's live-node sidecars and
 *   reflector-base nodes — these are the rebinders whose dependencies are
 *   already settled at hydration time (shadow map, artifact textures,
 *   material slot textures, viewport texture).
 * - `lateUpdateBefore` runs AFTER the live-node sidecars + reflector-base
 *   nodes — these are the rebinders that need the live nodes' own
 *   `updateBefore` to have run first (material-graph depth which includes
 *   reflector depth nodes; reflector texture which keys its per-camera RT
 *   inside `ReflectorBaseNode.updateBefore`).
 *
 * The hydrator splats both into its final `updateBefore` array with the
 * live-node sidecars sandwiched in between.
 *
 * @param {RebinderBindingsBag} bindings
 * @param {RebinderDeps} deps
 * @returns {{ earlyUpdateBefore: Array, lateUpdateBefore: Array }}
 */
export function createDynamicBindingResolvers( bindings, deps ) {

	const shadowRebinderDeps = {
		findLightBySource: deps.findLightBySource,
		recordDiagnostic: deps.recordShadowDiagnostic,
		describeLight: deps.describeLight,
	};

	const earlyUpdateBefore = [];
	const lateUpdateBefore = [];

	// Order matters: shadowDepth FIRST so SampledTexture bindings point at
	// the live `light.shadow.map.depthTexture` before the renderer reads
	// bind-group versions for the upcoming draw.
	if ( bindings.shadowDepthBindings && bindings.shadowDepthBindings.length > 0 ) {

		earlyUpdateBefore.push( createShadowDepthRebinder( bindings.shadowDepthBindings, shadowRebinderDeps ) );

	}

	if ( bindings.artifactTextureBindings && bindings.artifactTextureBindings.length > 0 ) {

		earlyUpdateBefore.push( createArtifactTextureRebinder( bindings.artifactTextureBindings, { resolveTextureBinding: deps.resolveTextureBinding } ) );

	}

	if ( bindings.materialTextureBindings && bindings.materialTextureBindings.length > 0 ) {

		earlyUpdateBefore.push( createMaterialTextureRebinder( bindings.materialTextureBindings, { resolveTextureBinding: deps.resolveTextureBinding } ) );

	}

	// `viewportTextureRebinder` runs alongside the other early rebinders so
	// transmissive materials sample a freshly-copied framebuffer instead of
	// the 1×1 fallback.
	if ( bindings.viewportTextureBindings && bindings.viewportTextureBindings.length > 0 ) {

		earlyUpdateBefore.push( createViewportTextureRebinder( bindings.viewportTextureBindings ) );

	}

	// Material-graph depth textures include reflector depth nodes. Those are
	// assigned by `ReflectorBaseNode.updateBefore`, so the depth rebinder
	// must run after live/material reflector update-before nodes.
	if ( bindings.materialDepthBindings && bindings.materialDepthBindings.length > 0 ) {

		lateUpdateBefore.push( createShadowDepthRebinder( bindings.materialDepthBindings, shadowRebinderDeps ) );

	}

	// `reflectorTextureRebinder` runs LAST: the live ReflectorBaseNode
	// sidecar keys its per-camera RenderTarget during its own `updateBefore`;
	// only afterwards can we swap the binding to the live
	// `renderTarget.texture`.
	if ( bindings.reflectorTextureBindings && bindings.reflectorTextureBindings.length > 0 ) {

		lateUpdateBefore.push( createReflectorTextureRebinder( bindings.reflectorTextureBindings ) );

	}

	return { earlyUpdateBefore, lateUpdateBefore };

}
