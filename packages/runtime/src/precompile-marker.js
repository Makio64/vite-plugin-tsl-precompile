/**
 * `material.precompile(name)` — the only author-facing API.
 *
 * Dev-mode behaviour:
 *   - Borrows the active WebGPURenderer (registered via `setDevRenderer`)
 *     and runs the extractor on this material against a synthetic minimal
 *     scene.
 *   - POSTs the artifact JSON to the dev-capture endpoint.
 *   - Returns the material itself (chainable).
 *   - If the dev endpoint is unreachable, logs once and becomes a no-op for
 *     the rest of the session (so prod-like non-plugin runs still work).
 *
 * Prod-mode behaviour:
 *   - The Vite/Babel transform replaces `.precompile(name)` call sites with
 *     `__applyPrecompiled(material, import('virtual:tsl-precompile/<name>'), '<hash>')`
 *     at build time. This marker method is then never called.
 *
 * If the marker IS called in a prod build (user mounted the runtime without
 * the plugin), it logs a clear warning and no-ops — the full three.js node
 * builder handles rendering, slightly defeating the point but never breaking
 * the app.
 *
 * @module PrecompileMarker
 */

import { MARKER_METHOD_NAME } from './_constants.js';

let installed = false;
let devEndpoint = null;
let devEndpointDead = false;
let threeModule = null;
let devRenderer = null;
let extractor = null;
let hasher = null;

const inflight = new Set();   // names currently being captured (suppresses dup POSTs)
const sessionDone = new Set();   // names captured this session (suppresses needless re-POST)

/**
 * Install `.precompile(name)` on the three.js Material prototype. Safe to call
 * multiple times; subsequent calls update the dev endpoint.
 *
 * @param {Object} three - A `three` or `three/webgpu` module, providing `Material`.
 * @param {Object} [opts]
 * @param {?string} [opts.devEndpoint] - e.g. 'http://localhost:5173/__tsl-precompile/capture'.
 * @param {?Function} [opts.extractor] - `(renderer, scene, camera, options) => Promise<artifacts>`.
 *   Defaults to a dynamic import of `@tsl-precompile/plugin/src/vendor/compileTSL.js`.
 * @param {?Function} [opts.hasher] - `(material, { name, threeVersion, pluginVersion }) => string`.
 *   Defaults to a dynamic import of `@tsl-precompile/plugin/src/hash.js`.
 */
export function installPrecompileMarker( three, opts = {} ) {

	threeModule = three;
	devEndpoint = opts.devEndpoint || null;
	devEndpointDead = false;
	extractor = opts.extractor || null;
	hasher = opts.hasher || null;

	if ( installed ) return;
	installed = true;

	const Material = three.Material;
	if ( ! Material || ! Material.prototype ) {

		throw new Error( '[tsl-precompile] installPrecompileMarker requires the three.Material class on the passed module.' );

	}

	if ( typeof Material.prototype[ MARKER_METHOD_NAME ] === 'function' ) return; // already installed (e.g. duplicate bundle)

	Material.prototype[ MARKER_METHOD_NAME ] = function precompile( name ) {

		if ( typeof name !== 'string' || name.length === 0 ) {

			throw new TypeError( `[tsl-precompile] material.precompile(name): "name" must be a non-empty string; got ${ typeof name }` );

		}

		// Prod fallback path — transform should have replaced this call.
		if ( typeof window === 'undefined' || ! devEndpoint ) {

			logOnce( 'no-endpoint:' + name, () => console.warn( `[tsl-precompile] .precompile(${ JSON.stringify( name ) }) was called but no dev endpoint is configured. If this is production, the Babel transform did not run — check your Vite config.` ) );
			return this;

		}

		if ( devEndpointDead ) return this;
		if ( sessionDone.has( name ) || inflight.has( name ) ) return this;

		inflight.add( name );
		// Defer to microtask so the user's first render isn't blocked on the
		// extractor — the marker must always return synchronously.
		Promise.resolve().then( () => captureMaterialInDev( this, name ) ).finally( () => inflight.delete( name ) );

		return this;

	};

}

/**
 * Register the active WebGPURenderer so the marker can borrow it for
 * extraction. Call once after `renderer.init()`. The marker no-ops until
 * this is called.
 *
 * @param {Object} renderer
 */
export function setDevRenderer( renderer ) {

	devRenderer = renderer || null;

}

/**
 * Drop the dev-renderer reference. Useful when the user replaces the renderer
 * mid-session.
 */
export function clearDevRenderer() {

	devRenderer = null;

}

async function captureMaterialInDev( material, name ) {

	try {

		if ( ! devRenderer ) {

			logOnce( 'no-renderer:' + name, () => console.warn( `[tsl-precompile] .precompile(${ JSON.stringify( name ) }): no dev renderer registered. Call setDevRenderer(renderer) once after renderer.init() so the marker can borrow it for extraction.` ) );
			return;

		}

		if ( ! extractor ) {

			const mod = await import( /* @vite-ignore */ '@tsl-precompile/plugin/src/vendor/compileTSL.js' );
			extractor = mod.compileTSL;

		}

		if ( ! hasher ) {

			const mod = await import( /* @vite-ignore */ '@tsl-precompile/plugin/src/hash.js' );
			hasher = mod.computeArtifactHash;

		}

		// Build a minimal synthetic scene that drives this single material.
		const { Scene, Mesh, BoxGeometry, PerspectiveCamera, REVISION } = threeModule;
		const scene = new Scene();
		const camera = new PerspectiveCamera( 45, 1, 0.1, 100 );
		camera.position.set( 0, 0, 3 );
		camera.lookAt( 0, 0, 0 );
		const mesh = new Mesh( new BoxGeometry( 1, 1, 1 ), material );
		scene.add( mesh );

		const artifacts = await extractor( devRenderer, scene, camera );

		let artifact = artifacts.byMaterialUuid && artifacts.byMaterialUuid.get( material.uuid );
		if ( ! artifact ) {

			for ( const a of artifacts ) {

				if ( a.materialUuid === material.uuid ) { artifact = a; break; }

			}

		}

		if ( ! artifact ) {

			console.error( `[tsl-precompile] .precompile(${ JSON.stringify( name ) }): extraction returned no artifact for material uuid=${ material.uuid }. The material may not have produced a NodeBuilderState.` );
			return;

		}

		const hash = hasher( material, {
			name,
			threeVersion: REVISION ? String( REVISION ) : 'unknown',
			pluginVersion: '0.0.0',
		} );

		// Strip non-serialisable side-cars before POST; dev capture only needs
		// the JSON-safe portion of the artifact.
		const sanitized = jsonSafeArtifact( artifact );

		const response = await fetch( devEndpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify( { name, hash, artifact: sanitized } ),
		} );

		if ( ! response.ok ) {

			const txt = await response.text();
			console.error( `[tsl-precompile] dev capture failed for ${ JSON.stringify( name ) }: ${ response.status } ${ txt }` );
			return;

		}

		sessionDone.add( name );
		console.info( `[tsl-precompile] captured "${ name }" (hash ${ hash.slice( 0, 12 ) })` );

	} catch ( err ) {

		// Connection refused → mark dead so we don't flood the console on HMR.
		const msg = err && err.message ? err.message : String( err );
		if ( /fetch|ECONN|NetworkError|Failed to fetch/i.test( msg ) ) {

			devEndpointDead = true;
			console.warn( `[tsl-precompile] dev capture endpoint ${ devEndpoint } unreachable (${ msg }). Further .precompile() calls in this session will be silent.` );

		} else {

			console.error( `[tsl-precompile] .precompile(${ JSON.stringify( name ) }) threw during capture:`, err );

		}

	}

}

/**
 * Strip non-enumerable / non-JSON-serialisable side-cars from an artifact.
 * The vendored `extractArtifact` attaches Maps and live node references via
 * `Object.defineProperty(... { enumerable: false })`; JSON.stringify drops
 * those automatically, but we also clean up known mutable fields.
 *
 * @param {Object} artifact
 * @return {Object}
 */
function jsonSafeArtifact( artifact ) {

	// JSON.stringify already drops non-enumerable properties; the round-trip
	// is enough to guarantee a clean payload.
	return JSON.parse( JSON.stringify( artifact ) );

}

const logged = new Set();
function logOnce( key, fn ) {

	if ( logged.has( key ) ) return;
	logged.add( key );
	fn();

}

/**
 * Reset internal state — test-only helper.
 */
export function __resetForTests() {

	installed = false;
	devEndpoint = null;
	devEndpointDead = false;
	threeModule = null;
	devRenderer = null;
	extractor = null;
	hasher = null;
	logged.clear();
	sessionDone.clear();
	inflight.clear();

}
