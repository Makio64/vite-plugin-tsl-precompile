/**
 * Formalised slim-runtime diagnostics — the productized successor to the
 * ad-hoc `globalThis.__tslpHarnessDiagnostics` + `__TSLP_DEBUG_*` global
 * flags scattered across the harness and hydrator modules.
 *
 * The legacy pattern was:
 *
 * ```js
 * const root = typeof globalThis !== 'undefined' ? globalThis : null;
 * if ( ! root || root.__TSLP_DEBUG_LIGHT_LINKAGE !== true ) return;
 * const diag = root.__tslpHarnessDiagnostics
 *   || ( root.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
 * const list = diag.lightLinkage || ( diag.lightLinkage = [] );
 * if ( list.length < 120 ) list.push( event );
 * ```
 *
 * — three pieces of state (the flag, the bag, the channel array), all
 * implicit globals with no schema. This module wraps the same mechanics in
 * a documented API so adopters can read the channels without grovelling
 * through globals and tests can install their own bag.
 *
 * Channels currently in use across the codebase:
 *
 *   | Channel                  | Legacy flag                       | Limit | Use site |
 *   |--------------------------|-----------------------------------|-------|----------|
 *   | `lightLinkage`           | `__TSLP_DEBUG_LIGHT_LINKAGE=true`  | 120   | `hydrate/light-writers.js` |
 *   | `shadowBindings`         | `__TSLP_DEBUG_SHADOW_BINDINGS=true`| 500   | `hydrate/light-writers.js` |
 *   | `shadowCoverage`         | `__TSLP_DEBUG_SHADOW_COVERAGE=true`| —     | `run-e2e.mjs` |
 *   | `reflectorBindings`      | `__TSLP_DEBUG_REFLECTOR_BINDINGS=true` | 500 | `hydrate/rebinders/reflector-texture-rebinder.js` |
 *   | `colorTransferFallbacks` | always                             | obj   | `slim-support/live-scene-index.js` |
 *   | `healedNullTextureImages`| always                             | i32   | `slim-support/live-scene-index.js` |
 *   | `pmrem`                  | always                             | obj   | `slim-support/pmrem.js` |
 *   | `textureShare`           | always                             | obj   | `slim-support/scene-support.js` |
 *
 * Flagged channels are gated by a process-local flag; the rest are always-on
 * counters that consumers read after a run. `record()` is a no-op when the
 * corresponding flag is off, so gating remains zero-cost on the hot path.
 *
 * The existing inline helpers in `hydrate/light-writers.js` etc. still
 * write directly to `globalThis.__tslpHarnessDiagnostics` for backwards
 * compatibility; they will migrate to this module over time. New code
 * should prefer the API exported here.
 *
 * @module SlimSupportDiagnostics
 */

const DEFAULT_BAG = () => ( {
	colorTransferFallbacks: Object.create( null ),
	healedNullTextureImages: 0,
} );

const CHANNEL_LIMITS = Object.freeze( {
	lightLinkage: 120,
	shadowBindings: 500,
	shadowCoverage: 1000,
	reflectorBindings: 500,
} );

const CHANNEL_FLAGS = Object.freeze( {
	lightLinkage: '__TSLP_DEBUG_LIGHT_LINKAGE',
	shadowBindings: '__TSLP_DEBUG_SHADOW_BINDINGS',
	shadowCoverage: '__TSLP_DEBUG_SHADOW_COVERAGE',
	reflectorBindings: '__TSLP_DEBUG_REFLECTOR_BINDINGS',
} );

/**
 * Find or create the shared diagnostics bag on `globalThis`. The same bag
 * is the one the legacy inline helpers in `hydrate/light-writers.js` use,
 * so writing through `record()` and reading the global produce identical
 * results.
 */
export function getSlimDiagnosticsBag() {

	const root = typeof globalThis !== 'undefined' ? globalThis : null;
	if ( ! root ) return null;
	const existing = root.__tslpHarnessDiagnostics;
	if ( existing && typeof existing === 'object' ) return existing;
	const bag = DEFAULT_BAG();
	root.__tslpHarnessDiagnostics = bag;
	return bag;

}

/** Is the global flag for this channel currently enabled? */
export function isDiagnosticChannelEnabled( channel ) {

	const root = typeof globalThis !== 'undefined' ? globalThis : null;
	if ( ! root ) return false;
	const flagName = CHANNEL_FLAGS[ channel ];
	if ( ! flagName ) return true; // always-on channels (counters)
	return root[ flagName ] === true;

}

/**
 * Append an event to a diagnostic channel. No-op when the channel's flag
 * isn't enabled (zero cost on the hot path). Respects the channel's
 * `CHANNEL_LIMITS` cap so a long-running session can't OOM by recording
 * unbounded events.
 *
 * @param {string} channel  - one of `CHANNEL_LIMITS` keys.
 * @param {*}      event    - the event object/value to append.
 * @return {boolean} `true` if the event was recorded, `false` otherwise.
 */
export function recordDiagnostic( channel, event ) {

	if ( ! isDiagnosticChannelEnabled( channel ) ) return false;
	const bag = getSlimDiagnosticsBag();
	if ( ! bag ) return false;
	const list = bag[ channel ] || ( bag[ channel ] = [] );
	const limit = CHANNEL_LIMITS[ channel ] || Number.POSITIVE_INFINITY;
	if ( list.length >= limit ) return false;
	list.push( event );
	return true;

}

/**
 * Reset the shared diagnostics bag. Tests use this to isolate channel
 * state between cases. In production it's typically called only at
 * harness initialisation.
 */
export function resetSlimDiagnostics() {

	const root = typeof globalThis !== 'undefined' ? globalThis : null;
	if ( ! root ) return;
	root.__tslpHarnessDiagnostics = DEFAULT_BAG();

}

/** Snapshot the current bag (shallow copy). Useful for assertions. */
export function snapshotSlimDiagnostics() {

	const bag = getSlimDiagnosticsBag();
	if ( ! bag ) return null;
	const out = {};
	for ( const key of Object.keys( bag ) ) {

		const value = bag[ key ];
		out[ key ] = Array.isArray( value ) ? value.slice() : value;

	}
	return out;

}
