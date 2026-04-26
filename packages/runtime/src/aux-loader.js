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
 * Look up a precompiled aux artifact. Throws if not found — the build is
 * expected to have captured every aux-pass config the app will exercise.
 *
 * @param {string} shape
 * @param {string} configHash
 * @return {Object}
 */
export function loadAux( shape, configHash ) {

	const k = key( shape, configHash );
	const artifact = REGISTRY.get( k );
	if ( ! artifact ) {

		const known = Array.from( REGISTRY.keys() ).filter( ( x ) => x.startsWith( shape + ':' ) );
		throw new Error(
			`[tsl-precompile/aux] no artifact for ${ JSON.stringify( k ) }. ` +
			`Known ${ shape } configHashes in this bundle: ${ known.length === 0 ? '(none)' : known.map( ( x ) => x.slice( shape.length + 1 ) ).join( ', ' ) }. ` +
			`Run dev mode on this scene so precompileAuxiliary() captures this config, then rebuild.`
		);

	}
	return artifact;

}

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
 * Test-only: reset the registry. Never call this from app code.
 */
export function __resetAuxRegistryForTests() {

	REGISTRY.clear();

}

function key( shape, configHash ) {

	return `${ shape }:${ configHash }`;

}
