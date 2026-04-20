/**
 * `material.precompile(name)` — the only author-facing API.
 *
 * Dev-mode behaviour:
 *   - Runs the real extractor on this material right now.
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

/**
 * Install `.precompile(name)` on the three.js Material prototype. Safe to call
 * multiple times; subsequent calls update the dev endpoint.
 *
 * @param {Object} three - A `three` or `three/webgpu` module, providing `Material`.
 * @param {Object} [opts]
 * @param {?string} [opts.devEndpoint] - e.g. 'http://localhost:5173/__tsl-precompile/capture'.
 */
export function installPrecompileMarker( three, opts = {} ) {

	threeModule = three;
	devEndpoint = opts.devEndpoint || null;
	devEndpointDead = false;

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

			console.warn( `[tsl-precompile] .precompile(${ JSON.stringify( name ) }) was called at runtime, but no dev endpoint is configured. If this is production, the Babel transform did not run — check your Vite config.` );
			return this;

		}

		if ( devEndpointDead ) return this;

		captureMaterialInDev( this, name );

		return this;

	};

}

/**
 * Dev-mode capture: extract the artifact from this live material + POST to
 * the plugin's capture endpoint. Runs synchronously on the user's first call,
 * but the network write is deferred to microtask so it doesn't stall the
 * first render.
 *
 * @param {Object} material
 * @param {string} name
 */
function captureMaterialInDev( material, name ) {

	// TODO: Phase 2b wiring.
	// 1. Extract: reuse the harness's extractMaterial() in-browser (we can't
	//    spin up an entire mock WebGPU in-browser, but we CAN run the real
	//    WebGPURenderer that the user already has in dev — keep a weak ref
	//    to it via a `setDevRenderer(renderer)` hook so the extractor uses
	//    the same device that's already rendering).
	// 2. Hash: import computeArtifactHash from '../hash.js' (cross-package).
	// 3. POST: fetch(devEndpoint, { method: 'POST', body: JSON.stringify({ name, hash, artifact }) }).
	// 4. If fetch throws ConnectionRefused, set devEndpointDead = true and
	//    log ONCE so the console isn't flooded on hot reload.

	// Stub for the initial commit — the Phase-2b implementation lives in a
	// follow-up PR. Calling this today only logs that it would have captured.
	// Suppress after the first call per name to keep the console readable.
	const key = 'precompileCaptureStub:' + name;
	if ( ! globalThis[ key ] ) {

		globalThis[ key ] = true;
		console.info( `[tsl-precompile] stub-capture: would capture material.precompile(${ JSON.stringify( name ) }) to ${ devEndpoint } (Phase 2b wiring pending).` );

	}

}

/**
 * Reset internal state — test-only helper.
 */
export function __resetForTests() {

	installed = false;
	devEndpoint = null;
	devEndpointDead = false;
	threeModule = null;

}
