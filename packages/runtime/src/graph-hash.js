/**
 * Runtime-side TSL graph hasher.
 *
 * Counterpart to `vite-plugin-tsl-precompile/src/hash.js:computeNodeGraphHash`.
 * Both implementations MUST produce identical hashes for identical input
 * graphs — the runtime uses this hash to look up precompiled aux-pass
 * artifacts (background, post-process, etc.) in the manifest at render
 * time, without running the TSL builder.
 *
 * Portability requirements:
 *   - No `node:crypto` import. We ship in the browser.
 *   - No three.js imports. The input nodes pass through as opaque graph objects.
 *   - No imports from the plugin side. Shared canonical graph traversal lives
 *     in @tsl-precompile/contract so plugin/runtime cannot drift.
 *
 * Hash algorithm: SHA-256 of the canonical string produced by the same
 * normaliser as the plugin side, keyed by shape + three version + plugin
 * version. Browser + Node 18+ expose Web Crypto via `crypto.subtle`; we
 * wrap it in an async `hashNodeGraph()` API.
 *
 * @module GraphHash
 */

import {
	createMaterialSourceHashPayload,
	normalizeMaterialGraph,
	normalizeNode,
} from '@tsl-precompile/contract/graph-normalize';
import { createArtifactContentHashPayload } from '@tsl-precompile/contract/artifact-content';

export { normalizeMaterialGraph, normalizeNode };

function assertVersion( fn, threeVersion, pluginVersion ) {

	if ( typeof threeVersion !== 'string' || threeVersion.length === 0 ) {

		throw new Error( `${ fn }: "threeVersion" is required (>= 184)` );

	}
	if ( typeof pluginVersion !== 'string' || pluginVersion.length === 0 ) {

		throw new Error( `${ fn }: "pluginVersion" is required` );

	}

}

/**
 * Stable sentinel hash returned by `hashNodeGraphSync` when the input looks
 * like a TSL stub-proxy rather than a real node graph. The slim replay
 * harness substitutes every `three/tsl` import with a chainable proxy whose
 * properties all reflect back as functions; hashing that proxy structurally
 * would yield an unstable string with no cryptographic relationship to the
 * captured graph's hash. By collapsing every stub-shaped input to the same
 * sentinel — broken out by `shape` — we guarantee a deterministic miss that
 * `loadAux`'s shape-fallback can resolve to a captured artifact, instead of
 * a hash that drifts with proxy traversal order.
 *
 * The sentinel is namespaced with the shape so `loadAux('background', X)`
 * and `loadAux('post-process', X)` can't accidentally collide on the same
 * key in `hasAux`.
 *
 * Format: `tslp-stub:<shape>:<8-char marker>` (deterministic, distinguishable
 * from real 64-char SHA-256 hex by the embedded prefix).
 *
 * @param {string} shape
 * @return {string}
 */
function stubSentinelHash( shape ) {

	return `tslp-stub:${ shape || 'unknown' }:fallback`;

}

/**
 * Detect whether `node` is a TSL stub-proxy (the slim replay harness's
 * `three/tsl` substitute) rather than a real three.js TSL node.
 *
 * Real TSL nodes carry primitive metadata: `constructor.type` is a string
 * (or `constructor.name`), `getCacheKey()` returns a number, and
 * inspectable properties like `nodeType` or attribute strings are
 * primitives. The harness's `__stub` Proxy returns a chainable function
 * for EVERY property access (so `stub.constructor.type` is itself a
 * function, not 'ColorNode'). That mismatch is unique enough to gate on:
 * if `isNode === true` but `constructor.type` and `constructor.name` are
 * both NOT strings, the input is a stub.
 *
 * Falsey/primitive inputs are not stubs (handled separately by
 * `normalizeNode`'s null/undefined branches).
 *
 * @param {*} node
 * @return {boolean}
 */
export function isStubLikeNode( node ) {

	if ( node === null || node === undefined ) return false;
	if ( typeof node !== 'object' && typeof node !== 'function' ) return false;
	// Real nodes have isNode === true; stubs do too. But stubs can't fake the
	// primitive shape of three.js's class metadata.
	let isNodeFlag;
	try { isNodeFlag = node.isNode; } catch ( _ ) { return false; }
	if ( isNodeFlag !== true ) return false;
	let ctor;
	try { ctor = node.constructor; } catch ( _ ) { return true; }
	// A real Node has a real Function constructor whose `.type` and `.name`
	// are strings. The stub-proxy returns ANOTHER stub function for both —
	// so neither yields a string.
	const ctorType = ctor && typeof ctor.type === 'string' ? ctor.type : null;
	const ctorName = ctor && typeof ctor.name === 'string' && ctor !== node ? ctor.name : null;
	if ( ctorType !== null || ctorName !== null ) {

		// Looks like a real node (or at least a real Function constructor).
		// Real proxies don't return strings here.
		return false;

	}
	return true;

}

/**
 * @param {Object} node
 * @param {{ shape: string, threeVersion: string, pluginVersion: string }} opts
 * @return {Promise<string>} hex-encoded sha256, 64 chars
 */
export async function hashNodeGraph( node, { shape, threeVersion, pluginVersion } ) {

	if ( typeof shape !== 'string' || shape.length === 0 ) {

		throw new TypeError( 'hashNodeGraph: "shape" must be a non-empty string' );

	}
	assertVersion( 'hashNodeGraph', threeVersion, pluginVersion );
	if ( node && typeof node.__tslpAuxConfigHash === 'string' && node.__tslpAuxConfigHash.length > 0 ) return node.__tslpAuxConfigHash;

	if ( isStubLikeNode( node ) ) return stubSentinelHash( shape );

	const normalized = normalizeNode( node, new Set(), 0 );
	const payload = [ 'node-v1', shape, threeVersion, pluginVersion, normalized ].join( '\n' );
	return sha256Hex( payload );

}

/**
 * Synchronous variant. Callers in a render-hot path can't await — they
 * use the sync hasher which falls back to a JS-side sha256 implementation.
 * Same algorithm, same output, just slower on long inputs.
 *
 * Stub-proxy guard: when the input is a TSL stub-proxy (e.g. the e2e
 * harness's `three/tsl` substitute) rather than a real node graph, the
 * structural traversal degenerates — every property is a function that
 * returns another proxy, so `Object.keys` returns nothing useful and the
 * "hash" we'd compute is divorced from the captured graph's hash. Detect
 * that case up-front and return a stable per-shape sentinel instead, so
 * `loadAux`'s shape-fallback can route to a captured artifact via a
 * predictable miss.
 *
 * @param {Object} node
 * @param {{ shape: string, threeVersion: string, pluginVersion: string }} opts
 * @return {string} hex-encoded sha256 (real input) or `tslp-stub:<shape>:fallback` sentinel (stub input)
 */
export function hashNodeGraphSync( node, { shape, threeVersion, pluginVersion } ) {

	assertVersion( 'hashNodeGraphSync', threeVersion, pluginVersion );
	if ( node && typeof node.__tslpAuxConfigHash === 'string' && node.__tslpAuxConfigHash.length > 0 ) return node.__tslpAuxConfigHash;

	if ( isStubLikeNode( node ) ) return stubSentinelHash( shape );

	const normalized = normalizeNode( node, new Set(), 0 );
	const payload = [ 'node-v1', shape, threeVersion, pluginVersion, normalized ].join( '\n' );
	return sha256HexSync( payload );

}

/**
 * Hash a plain-object config (non-TSL). Mirrors `computePlainConfigHash`
 * on the plugin side — used for aux shapes whose config is a descriptor
 * (PMREM: { kind, width, height }; Lighting: { signature }).
 *
 * @param {Object} config
 * @param {{ shape, threeVersion, pluginVersion }} opts
 * @return {string}
 */
export function hashPlainConfigSync( config, { shape, threeVersion, pluginVersion } ) {

	if ( typeof shape !== 'string' || shape.length === 0 ) {

		throw new TypeError( 'hashPlainConfigSync: "shape" must be a non-empty string' );

	}
	assertVersion( 'hashPlainConfigSync', threeVersion, pluginVersion );
	const payload = [
		'plain-v1',
		shape,
		threeVersion,
		pluginVersion,
		stableStringify( config ),
	].join( '\n' );
	return sha256HexSync( payload );

}

function stableStringify( v ) {

	if ( v === null || typeof v !== 'object' ) return JSON.stringify( v );
	if ( Array.isArray( v ) ) return '[' + v.map( stableStringify ).join( ',' ) + ']';
	const keys = Object.keys( v ).sort();
	return '{' + keys.map( ( k ) => JSON.stringify( k ) + ':' + stableStringify( v[ k ] ) ).join( ',' ) + '}';

}

/**
 * Browser-safe counterpart to `packages/plugin/src/hash.js::computeArtifactHash`.
 * The runtime's dev-capture marker uses this to compute material hashes
 * WITHOUT dynamically importing plugin/hash.js (which pulls `node:crypto`,
 * externalised by Vite in browser builds).
 *
 * @param {Object} material
 * @param {{ name: string, threeVersion: string, pluginVersion?: string, toolchainVersion?: string, renderContextSignature?: string|Object }} opts - renderContextSignature is accepted for compatibility but not source-hashed.
 * @return {string} hex-encoded sha256, 64 chars
 */
export function hashMaterialSync( material, opts = {} ) {

	const payload = createMaterialSourceHashPayload( material, opts );

	return sha256HexSync( payload );

}

// Explicit metadata-facing spelling; retained alias keeps current public API.
export const hashMaterialSourceSync = hashMaterialSync;

/**
 * Browser-safe counterpart to `packages/plugin/src/hash.js::computeArtifactContentHash`.
 * Hashes an extracted artifact's canonical runtime content.
 *
 * @param {Object} artifact
 * @param {{ shape: string, threeVersion: string, pluginVersion: string }} opts
 * @return {string} hex-encoded sha256, 64 chars
 */
export function hashArtifactContentSync( artifact, { shape, threeVersion, pluginVersion } ) {

	if ( typeof shape !== 'string' || shape.length === 0 ) {

		throw new TypeError( 'hashArtifactContentSync: "shape" must be a non-empty string' );

	}
	assertVersion( 'hashArtifactContentSync', threeVersion, pluginVersion );

	const payload = createArtifactContentHashPayload( artifact, {
		shape,
		threeVersion,
		toolchainVersion: pluginVersion,
	} );

	return sha256HexSync( payload );

}

// -------------------------------------------------------------------------
// sha256 — async (Web Crypto) preferred; sync JS fallback for render-hot callers
// -------------------------------------------------------------------------

async function sha256Hex( str ) {

	const enc = new TextEncoder().encode( str );
	const subtle = ( typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle ) || null;
	if ( subtle ) {

		const buf = await subtle.digest( 'SHA-256', enc );
		return hex( new Uint8Array( buf ) );

	}
	return sha256HexSync( str );

}

function hex( bytes ) {

	let out = '';
	for ( let i = 0; i < bytes.length; i ++ ) out += bytes[ i ].toString( 16 ).padStart( 2, '0' );
	return out;

}

// ---- SHA-256 pure-JS (based on RFC 6234). Short, dependency-free, suitable
// for the small input sizes our graph-hasher produces.

function sha256HexSync( str ) {

	const enc = new TextEncoder().encode( str );
	const H = new Uint32Array( [
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
		0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	] );
	const K = new Uint32Array( [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	] );

	// pre-processing
	const bits = enc.length * 8;
	const padLen = ( ( enc.length + 9 + 63 ) >>> 6 ) * 64;
	const msg = new Uint8Array( padLen );
	msg.set( enc );
	msg[ enc.length ] = 0x80;
	// length as 64-bit big-endian (we treat high 32 as zero)
	const dv = new DataView( msg.buffer );
	dv.setUint32( padLen - 4, bits >>> 0, false );
	dv.setUint32( padLen - 8, Math.floor( bits / 0x100000000 ) >>> 0, false );

	const W = new Uint32Array( 64 );
	for ( let i = 0; i < padLen; i += 64 ) {

		for ( let t = 0; t < 16; t ++ ) W[ t ] = dv.getUint32( i + t * 4, false );
		for ( let t = 16; t < 64; t ++ ) {

			const s0 = rotr( W[ t - 15 ], 7 ) ^ rotr( W[ t - 15 ], 18 ) ^ ( W[ t - 15 ] >>> 3 );
			const s1 = rotr( W[ t - 2 ], 17 ) ^ rotr( W[ t - 2 ], 19 ) ^ ( W[ t - 2 ] >>> 10 );
			W[ t ] = ( W[ t - 16 ] + s0 + W[ t - 7 ] + s1 ) >>> 0;

		}

		let a = H[ 0 ], b = H[ 1 ], c = H[ 2 ], d = H[ 3 ], e = H[ 4 ], f = H[ 5 ], g = H[ 6 ], h = H[ 7 ];
		for ( let t = 0; t < 64; t ++ ) {

			const S1 = rotr( e, 6 ) ^ rotr( e, 11 ) ^ rotr( e, 25 );
			const ch = ( e & f ) ^ ( ( ~ e ) & g );
			const temp1 = ( h + S1 + ch + K[ t ] + W[ t ] ) >>> 0;
			const S0 = rotr( a, 2 ) ^ rotr( a, 13 ) ^ rotr( a, 22 );
			const mj = ( a & b ) ^ ( a & c ) ^ ( b & c );
			const temp2 = ( S0 + mj ) >>> 0;
			h = g; g = f; f = e;
			e = ( d + temp1 ) >>> 0;
			d = c; c = b; b = a;
			a = ( temp1 + temp2 ) >>> 0;

		}

		H[ 0 ] = ( H[ 0 ] + a ) >>> 0;
		H[ 1 ] = ( H[ 1 ] + b ) >>> 0;
		H[ 2 ] = ( H[ 2 ] + c ) >>> 0;
		H[ 3 ] = ( H[ 3 ] + d ) >>> 0;
		H[ 4 ] = ( H[ 4 ] + e ) >>> 0;
		H[ 5 ] = ( H[ 5 ] + f ) >>> 0;
		H[ 6 ] = ( H[ 6 ] + g ) >>> 0;
		H[ 7 ] = ( H[ 7 ] + h ) >>> 0;

	}

	let out = '';
	for ( let i = 0; i < 8; i ++ ) out += H[ i ].toString( 16 ).padStart( 8, '0' );
	return out;

}

function rotr( x, n ) {

	return ( ( x >>> n ) | ( x << ( 32 - n ) ) ) >>> 0;

}
