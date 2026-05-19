/**
 * Module-level registry for the slim-mode render fallback.
 *
 * The slim three.js bundle's rewritten `Nodes.js:getForRender` rejects any
 * material that isn't a `PrecompiledMaterial` (no node-graph compiler is
 * shipped). Adopters who run non-precompiled materials (Inspector helpers,
 * upstream addon meshes, code paths the user doesn't own) need a way to
 * delegate those calls to a *full* `WebGPURenderer` running on the same
 * GPU device — the §P1.6 "slim + full-renderer fallback" mode.
 *
 * The contract: a single sync handler `(renderObject) => nodeBuilderLike`.
 * Returning `null` (or throwing) signals the original loud-failure path
 * should fire. Setting `null` clears the registration.
 *
 * Wiring is one-way: `createSlimSceneSupport({ fullRendererFallback: true })`
 * (in `scene-support.js`) eagerly boots the full renderer and registers a
 * handler that proxies to the full renderer's node manager and adapts the
 * returned state into the node-builder shape the slim rewrite expects.
 * The slim `Nodes.js:getForRender` rewrite calls `getSlimRenderFallback()`
 * before throwing.
 *
 * @module SlimSupport.RenderFallbackRegistry
 */

let _handler = null;

/**
 * Register the fallback handler. Subsequent calls overwrite. Pass `null` to
 * clear (e.g. when disposing the scene-support orchestrator).
 *
 * @param {?function(Object): Object} handler
 *   `(renderObject) => nodeBuilderLike`. Return `null` to skip the fallback
 *   for this material and let slim's loud-failure throw.
 */
export function setSlimRenderFallback( handler ) {

	_handler = typeof handler === 'function' ? handler : null;

}

/**
 * Look up the current fallback handler, or `null` if none is registered.
 * Imported into the slim-rewritten `Nodes.js:getForRender` so the rewrite
 * can attempt the fallback before throwing.
 *
 * @returns {?function(Object): Object}
 */
export function getSlimRenderFallback() {

	return _handler;

}
