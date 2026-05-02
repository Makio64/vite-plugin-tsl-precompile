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
 * Viewport texture wiring (backdrop / viewportSharedTexture):
 *   Backdrop materials (MeshStandardNodeMaterial with backdropNode) sample the
 *   framebuffer via `viewportSharedTexture()`, which is captured as a
 *   `FramebufferTexture` binding (source.mapping === 300 in the uniformPlan).
 *   These UUIDs are dead on slim replay (captured at dev time, new instances on
 *   every reload). `wireViewportTextureRefs(artifact)` scans the uniformPlan for
 *   mapping=300 entries and pre-populates `artifact._textureRefs` with
 *   appropriate fallback textures:
 *     - `texture_depth_2d` bindings → plain `DepthTexture(1,1)` (NOT
 *       `isFramebufferTexture`, which would cause the WebGPU backend to
 *       silently override the texture format with the canvas color format
 *       — bgra8unorm — making the bind group fail depth-texture validation).
 *     - `texture_2d<f32>` bindings → `FramebufferTexture(1,1)` (backend
 *       assigns canvas bgra8unorm format, which is compatible with float
 *       sample type in the pipeline BGL).
 *   This prevents the "None of the supported sample types … match Depth"
 *   WebGPU validation error that otherwise invalidates the entire frame's
 *   command encoder and produces a fully black canvas.
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
	// Pre-wire viewport/framebuffer texture fallbacks on registration so
	// the artifact is ready for the hydrator before the first render frame.
	// wireViewportTextureRefs is idempotent and silently no-ops until
	// setupViewportTextureClasses() has been called.
	wireViewportTextureRefs( artifact );
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

/**
 * Injected three.js texture constructors + constants. Set by
 * `setupViewportTextureClasses()` before the first `wireViewportTextureRefs`
 * call. Kept as a separate indirection so `aux-loader.js` does NOT import
 * directly from `'three'` — an import of `'three'` resolves to the pre-built
 * `three/build/three.module.js` (per the package.json `exports` field) rather
 * than to the same source files that `slim-entry.js` uses
 * (`three/src/Three.Core.js`). That causes rollup to inline a duplicate copy
 * of the three.js bundle alongside the source-file tree, adding ~26 KB and
 * (critically) causing the aux-loader REGISTRY Map to be renamed in a way
 * that breaks the slim replay's `registerAuxArtifacts` / `loadAux` pairing.
 *
 * The PrecompiledMaterial constructor — which imports from `'three'` only via
 * `Material` which is already in the bundle — calls
 * `setupViewportTextureClasses(...)` on module load.
 */
let _DepthTextureCtor = null;
let _FramebufferTextureCtor = null;
const _DepthFormat = 1026; // three.js DepthFormat constant (stable across versions)
const _UnsignedIntType = 1014; // three.js UnsignedIntType constant (stable across versions)

/**
 * Register the three.js texture constructors needed by `wireViewportTextureRefs`.
 * Call this once from a module that already imports from `three` correctly
 * (e.g. `_vendor-PrecompiledMaterial.js`).
 *
 * @param {{ DepthTexture: Function, FramebufferTexture: Function }} classes
 */
export function setupViewportTextureClasses( classes ) {

	if ( classes && typeof classes.DepthTexture === 'function' ) _DepthTextureCtor = classes.DepthTexture;
	if ( classes && typeof classes.FramebufferTexture === 'function' ) _FramebufferTextureCtor = classes.FramebufferTexture;

}

/**
 * Pre-populate `artifact._textureRefs` with fallback textures for every
 * `viewportSharedTexture` binding in the artifact's uniformPlan.
 *
 * `viewportSharedTexture()` bindings are identified by `source.mapping === 300`
 * (three.js `FramebufferTextureMapping`). Their captured UUIDs are dead on replay
 * (fresh Texture instances every page load), so without pre-wiring the hydrator
 * falls through to the global fallback textures. The global depth fallback
 * (`hydrator.fallbackDepthTexture`) has `isFramebufferTexture = true` which
 * causes the WebGPU backend to assign the canvas colour format (bgra8unorm) at
 * GPU-texture-init time — making `texture_depth_2d` bind groups invalid and
 * invalidating the entire frame's command encoder (black canvas, no errors).
 *
 * Fix:
 *   - `texture_depth_2d` bindings: supply a plain `DepthTexture(1,1)` without
 *     `isFramebufferTexture`, so its `DepthFormat` is preserved by the backend.
 *   - `texture_2d<f32>` bindings: supply a `FramebufferTexture(1,1)` — the
 *     backend assigns bgra8unorm which is compatible with `sampleType: float`.
 *
 * Requires `setupViewportTextureClasses(...)` to have been called first with
 * the three.js texture constructors. Silently no-ops if the classes haven't
 * been registered yet (safe to call before setup; just won't wire anything).
 *
 * Idempotent: calling multiple times on the same artifact is harmless.
 *
 * @param {Object} artifact - A precompiled artifact (has `.uniformPlan` and
 *   `.fragmentShader`/`.vertexShader`).
 * @return {Object} The artifact (for chaining).
 */
export function wireViewportTextureRefs( artifact ) {

	if ( ! artifact || ! Array.isArray( artifact.uniformPlan ) ) return artifact;
	if ( ! _DepthTextureCtor || ! _FramebufferTextureCtor ) return artifact;

	const wgsl = [
		artifact.vertexShader || '',
		artifact.fragmentShader || '',
		artifact.computeShader || '',
	].join( '\n' );

	const refs = artifact._textureRefs instanceof Map
		? new Map( artifact._textureRefs )
		: new Map();

	let changed = false;

	for ( const group of artifact.uniformPlan ) {

		for ( const entry of group.textures || [] ) {

			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || source.mapping !== 300 ) continue;
			const uuid = source.textureUuid;
			if ( ! uuid || refs.has( uuid ) ) continue;

			// Determine WGSL type for this binding.
			const bindingName = entry.name || '';
			const escaped = bindingName.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
			const isDepth = new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_depth`, 'm' ).test( wgsl );

			let fallback;
			if ( isDepth ) {

				// Plain DepthTexture — NOT isFramebufferTexture to avoid the
				// backend overriding the format with the canvas colour format.
				fallback = new _DepthTextureCtor( 1, 1 );
				fallback.format = _DepthFormat;
				fallback.type = _UnsignedIntType;
				// Do NOT set isFramebufferTexture here.

			} else {

				// Color viewport texture (texture_2d<f32> or texture_2d).
				// FramebufferTexture: backend assigns bgra8unorm (canvas format)
				// which satisfies `sampleType: float` in the pipeline BGL.
				fallback = new _FramebufferTextureCtor( 1, 1 );

			}
			fallback.needsUpdate = true;
			refs.set( uuid, fallback );
			changed = true;

		}

	}

	if ( changed ) {

		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );

	}

	return artifact;

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
