/**
 * Realm-wide registry for the slim-mode render fallback.
 *
 * The slim three.js bundle's rewritten `Nodes.js:getForRender` rejects any
 * material that isn't a `PrecompiledMaterial` (no node-graph compiler is
 * shipped). Adopters who run non-precompiled materials (Inspector helpers,
 * upstream addon meshes, code paths the user doesn't own) need a way to
 * delegate those calls to a *full* `WebGPURenderer` running on the same
 * GPU device — the §P1.6 "slim + full-renderer fallback" mode.
 *
 * The contract: one sync handler `(renderObject) => nodeBuilderStateLike` per
 * renderer/owner. The legacy owner-less registration remains as a process-wide
 * default for direct callers, but a scoped registration always wins for its
 * owner.
 * Returning `null` signals the original loud-failure path should fire;
 * thrown errors propagate. A handler may expose `release(renderObject)` so
 * the replay manager can release full-renderer state when its RenderObject is
 * deleted. Setting `null` clears the registration.
 *
 * Wiring is one-way: `createSlimSceneSupport({ fullRendererFallback: true })`
 * (in `scene-support.js`) eagerly boots the full renderer and registers a
 * handler that proxies to the full renderer's node manager and exposes both
 * state (`createBindings`) and legacy builder (`getBindings`/`build`) methods.
 * The replay-native NodeManager calls `getSlimRenderFallback()` before
 * throwing.
 *
 * @module SlimSupport.RenderFallbackRegistry
 */

const REGISTRY_STATE_KEY = Symbol.for( '@tsl-precompile/runtime/render-fallback-registry@1' );

function createRegistryState() {

	return {
		legacyHandler: null,
		handlersByOwner: new WeakMap(),
		scopedCount: 0,
	};

}

function sharedRegistryState() {

	const root = typeof globalThis !== 'undefined' ? globalThis : null;
	if ( ! root ) return createRegistryState();
	const existing = root[ REGISTRY_STATE_KEY ];
	if ( existing && existing.handlersByOwner instanceof WeakMap ) return existing;
	const state = createRegistryState();
	Object.defineProperty( root, REGISTRY_STATE_KEY, {
		value: state,
		configurable: true,
	} );
	return state;

}

const _state = sharedRegistryState();

function handlerForOwner( owner ) {

	return owner && _state.handlersByOwner.get( owner ) || _state.legacyHandler;

}

// Prebuilt slim and source runtime modules can be separate ESM instances.
// Owner-less rewritten Three seams therefore receive one dispatcher that
// resolves the exact renderer from the live RenderObject at call/release time.
const _ownerDispatcher = ( renderObject ) => {

	const handler = handlerForOwner( renderObject && renderObject.renderer );
	return handler ? handler( renderObject ) : null;

};
_ownerDispatcher.release = ( renderObject ) => {

	const handler = handlerForOwner( renderObject && renderObject.renderer );
	if ( handler && typeof handler.release === 'function' ) handler.release( renderObject );

};

function assertOwner( owner ) {

	if ( owner !== null && owner !== undefined && ( typeof owner !== 'object' && typeof owner !== 'function' ) ) {

		throw new TypeError( 'render fallback owner must be an object or function' );

	}

}

/**
 * Register the fallback handler. Subsequent calls for the same owner overwrite.
 * Pass `null` to clear. Omitting `owner` preserves the original process-wide
 * registration API; renderer integrations should always pass their renderer.
 *
 * @param {?function(Object): Object} handler
 *   `(renderObject) => nodeBuilderStateLike`. Return `null` to skip the fallback
 *   for this material and let slim's loud-failure throw.
 * @param {?Object} [owner]
 */
export function setSlimRenderFallback( handler, owner = null ) {

	assertOwner( owner );
	const normalized = typeof handler === 'function' ? handler : null;
	if ( owner !== null && owner !== undefined ) {

		const hadHandler = _state.handlersByOwner.has( owner );
		if ( normalized ) {

			_state.handlersByOwner.set( owner, normalized );
			if ( ! hadHandler ) _state.scopedCount ++;

		} else if ( hadHandler ) {

			_state.handlersByOwner.delete( owner );
			_state.scopedCount --;

		}
		return;

	}
	_state.legacyHandler = normalized;

}

/**
 * Look up the current fallback handler, or `null` if none is registered. A
 * renderer-scoped handler takes precedence over the legacy process-wide
 * default. Owner-less callers receive a renderer-dispatching adapter whenever
 * scoped registrations exist; this keeps rewritten Three seams compatible
 * across separate prebuilt/runtime ESM instances.
 * Imported into the slim-rewritten `Nodes.js:getForRender` so the rewrite
 * can attempt the fallback before throwing.
 *
 * @param {?Object} [owner]
 * @returns {?function(Object): Object}
 */
export function getSlimRenderFallback( owner = null ) {

	assertOwner( owner );
	if ( owner !== null && owner !== undefined ) {

		const scoped = _state.handlersByOwner.get( owner );
		return scoped || _state.legacyHandler;

	}
	return _state.scopedCount > 0 ? _ownerDispatcher : _state.legacyHandler;

}
