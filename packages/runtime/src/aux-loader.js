/**
 * Auxiliary-pass artifact registry (runtime side).
 *
 * Build-time flow:
 *   1. Vite plugin emits a virtual module `virtual:tsl-precompile/__aux`
 *      that imports each captured aux artifact and registers it via
 *      `registerAuxArtifact(shape, configHash, artifact)`.
 *   2. The Babel transform of three.js's `Background.js` / `PostProcessing.js` /
 *      etc. imports `virtual:tsl-precompile/__aux` for its side effects,
 *      then replaces `new NodeMaterial()` sites with
 *      `new PrecompiledMaterial(loadAux(shape, hashNodeGraphSync(input)))`.
 *
 * Runtime flow:
 *   - Lookup is O(1) on a `Map<string, artifact>` keyed by `<shape>:<configHash>`.
 *   - A miss throws with a clear message pointing the user at the dev capture
 *     flow for the missing config. This is the loud-failure gate — a silent
 *     fallback to the node builder would defeat the whole slim bundle.
 *
 * @module AuxLoader
 */

/** @type {Map<string, Object>} */
const REGISTRY = new Map();

/**
 * Register a precompiled aux artifact. Called from the generated virtual
 * module at build time; also safe to call at runtime if the host app
 * ships its own artifact loader.
 *
 * @param {string} shape - e.g. 'background', 'post-process', 'pmrem', 'lights'.
 * @param {string} configHash - 64-char hex produced by `hashNodeGraphSync` or `hashPlainConfigSync`.
 * @param {Object} artifact - The artifact object (uniformPlan + WGSL + bindings).
 */
export function registerAuxArtifact( shape, configHash, artifact ) {

	if ( typeof shape !== 'string' || shape.length === 0 ) {

		throw new TypeError( 'registerAuxArtifact: shape must be a non-empty string' );

	}
	if ( typeof configHash !== 'string' || configHash.length === 0 ) {

		throw new TypeError( 'registerAuxArtifact: configHash must be a non-empty string' );

	}
	REGISTRY.set( key( shape, configHash ), artifact );

}

/**
 * Bulk-register from a flat table. Generated virtual modules prefer this
 * over many individual calls.
 *
 * @param {Array<{ shape: string, configHash: string, artifact: Object }>} entries
 */
export function registerAuxArtifacts( entries ) {

	for ( const e of entries ) registerAuxArtifact( e.shape, e.configHash, e.artifact );

}

/**
 * Look up a precompiled aux artifact.
 *
 * Lookup order:
 *   1. Exact `<shape>:<configHash>` match — the happy path when the runtime
 *      hash agrees with the captured hash.
 *   2. Shape-compatible fallback — if the shape was captured at least once
 *      this build, return the FIRST registered artifact for that shape with
 *      a `console.warn`. This is the slim-replay safety net: TSL stub-proxy
 *      inputs (e.g. the e2e harness's `three/tsl` substitute) can't be
 *      hashed identically to the captured graph, so we'd otherwise miss on
 *      every frame. Returning the first registered shape match keeps the
 *      bg/post-process pass producing pixels instead of throwing or
 *      clearing the canvas. Shape-fallback warnings are deduped per
 *      `<shape>:<configHash>` so a render-hot caller doesn't spam the
 *      console every frame.
 *   3. Throws — only when NO artifact for this shape was ever registered.
 *      That's a build-config bug (the dev-capture pass didn't see this
 *      scene), not something fallback can paper over.
 *
 * Special case: the stub-sentinel hash `tslp-stub:<shape>:fallback`
 * (produced by `hashNodeGraphSync` when given a stub-proxy input) takes a
 * predictable path through (2) without polluting the warning channel —
 * we surface a one-shot info message naming the sentinel so debugging
 * doesn't require correlating an opaque hex hash with the registered
 * captures.
 *
 * @param {string} shape
 * @param {string} configHash
 * @return {Object}
 */
export function loadAux( shape, configHash ) {

	const k = key( shape, configHash );
	const artifact = REGISTRY.get( k );
	if ( artifact ) return artifact;

	const known = Array.from( REGISTRY.keys() ).filter( ( x ) => x.startsWith( shape + ':' ) );
	if ( known.length >= 1 ) {

		if ( ! WARNED_FALLBACKS.has( k ) ) {

			WARNED_FALLBACKS.add( k );
			const isStubInput = typeof configHash === 'string' && configHash.startsWith( STUB_SENTINEL_PREFIX );
			const reason = isStubInput
				? `runtime input was a TSL stub-proxy (no real graph to hash)`
				: `runtime hash differs from any captured hash for this shape`;
			console.warn(
				`[tsl-precompile/aux] no exact artifact for ${ JSON.stringify( k ) }; ` +
				`${ reason }. ` +
				`Using ${ JSON.stringify( known[ 0 ] ) } as a shape-compatible fallback. ` +
				`Known ${ shape } captures: ${ known.length }.`
			);

		}
		return REGISTRY.get( known[ 0 ] );

	}

	throw new Error(
		`[tsl-precompile/aux] no artifact for ${ JSON.stringify( k ) }. ` +
		`Known ${ shape } configHashes in this bundle: ${ known.length === 0 ? '(none)' : known.map( ( x ) => x.slice( shape.length + 1 ) ).join( ', ' ) }. ` +
		`Run dev mode on this scene so precompileAuxiliary() captures this config, then rebuild.`
	);

}

/**
 * Hash prefix produced by `graph-hash.js::stubSentinelHash` when the input
 * to `hashNodeGraphSync` looks like a TSL stub-proxy. We recognise it here
 * so the shape-fallback warning can name the actual cause ("stub-proxy
 * input") instead of "hash mismatch", which is misleading — there's no
 * real graph to hash at all.
 *
 * Kept in lockstep with the producer: see `packages/runtime/src/graph-hash.js`.
 */
const STUB_SENTINEL_PREFIX = 'tslp-stub:';

/**
 * Per-key dedupe set so the shape-fallback warning fires AT MOST ONCE per
 * unique `<shape>:<configHash>` pair. The patched `Background.js` /
 * `PostProcessing.js` call `loadAux(...)` from the render hot path; without
 * dedupe the console floods at 60 fps.
 *
 * @type {Set<string>}
 */
const WARNED_FALLBACKS = new Set();

/**
 * @param {string} shape
 * @param {string} configHash
 * @return {boolean}
 */
export function hasAux( shape, configHash ) {

	return REGISTRY.has( key( shape, configHash ) );

}

/**
 * Enumerate registered entries — useful for diagnostics / dev overlays.
 *
 * @return {Array<{ shape: string, configHash: string }>}
 */
export function listAux() {

	const out = [];
	for ( const k of REGISTRY.keys() ) {

		const i = k.indexOf( ':' );
		out.push( { shape: k.slice( 0, i ), configHash: k.slice( i + 1 ) } );

	}
	return out;

}

export function attachArtifactTextureRefs( artifact, texture ) {

	if ( ! artifact || ! texture || ! texture.isTexture ) return artifact;

	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	for ( const group of artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			const source = entry && entry.source || {};
			if ( source.kind === 'artifact.texture' && source.textureUuid ) refs.set( source.textureUuid, texture );

		}

	}

	Object.defineProperty( artifact, '_textureRefs', {
		value: refs,
		enumerable: false,
		configurable: true,
		writable: true,
	} );

	return artifact;

}

/**
 * Test-only: reset the registry. Never call this from app code.
 */
export function __resetAuxRegistryForTests() {

	REGISTRY.clear();
	WARNED_FALLBACKS.clear();

}

function key( shape, configHash ) {

	return `${ shape }:${ configHash }`;

}
