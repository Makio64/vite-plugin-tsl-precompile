/**
 * Content-hashing for precompile artifacts.
 *
 * A precompile artifact is stale if ANY of these change:
 *   - the TSL node graph the material carries (user's shader logic);
 *   - the three.js version (node builder's WGSL emitter may change);
 *   - the plugin version (extractor or codegen may change output);
 *   - the author-facing name (collision between two `.precompile(name)` calls).
 *
 * Any mismatch stops the build — see ARCHITECTURE.md "Staleness gates".
 *
 * `normalizedGraph` is produced by `normalizeMaterialGraph()` — a canonical
 * walk of the node tree plus topology-forming material state. Object keys are
 * sorted and nodes are stamped with stable type tags.
 *
 * Intentionally NOT hashed:
 *   - memory addresses, instance/node/texture UUIDs, clocks, and cache ids;
 *   - live uniform values or Texture pixel data;
 *   - continuous material inputs such as color, opacity, and roughness.
 *
 * Render-context topology is deliberately stored separately on the artifact;
 * it selects runtime variants and is not source identity.
 *
 * @module Hash
 */

import { createHash } from 'node:crypto';
import {
	createMaterialSourceHashPayload,
	normalizeMaterialGraph,
	normalizeNode,
} from '@tsl-precompile/contract/graph-normalize';
import { createArtifactContentHashPayload } from '@tsl-precompile/contract/artifact-content';

function assertVersion( fn, threeVersion, pluginVersion ) {

	if ( typeof threeVersion !== 'string' || threeVersion.length === 0 ) {

		throw new Error( `${ fn }: "threeVersion" is required (>= 184)` );

	}
	if ( typeof pluginVersion !== 'string' || pluginVersion.length === 0 ) {

		throw new Error( `${ fn }: "pluginVersion" is required` );

	}

}

/**
 * Hash an already-extracted artifact by its canonical RUNTIME content — WGSL,
 * bindings, uniform plans, render state, attributes, and captured variants.
 *
 * Use this for auxiliary-pass artifacts (Background, PMREM, PostProcessing)
 * where the source material is internal to three.js and the author-facing
 * hash signal has to come from the extracted output, not from walking a
 * material that doesn't exist at the call site.
 *
 * Capture-only provenance is excluded by the shared contract payload builder.
 *
 * @param {Object} artifact - Output of `compileTSL` / `extractArtifact`.
 * @param {Object} opts
 * @param {string} opts.shape - e.g. 'background', 'pmrem', 'post-process'.
 * @param {string} opts.threeVersion
 * @param {string} opts.pluginVersion
 * @return {string} hex-encoded sha256, 64 chars
 */
export function computeArtifactContentHash( artifact, { shape, threeVersion, pluginVersion } ) {

	if ( typeof shape !== 'string' || shape.length === 0 ) {

		throw new TypeError( 'computeArtifactContentHash: "shape" must be a non-empty string' );

	}
	assertVersion( 'computeArtifactContentHash', threeVersion, pluginVersion );

	const payload = createArtifactContentHashPayload( artifact, {
		shape,
		threeVersion,
		toolchainVersion: pluginVersion,
	} );

	return createHash( 'sha256' ).update( payload ).digest( 'hex' );

}

/**
 * Compute the artifact hash for a given material at a given name.
 *
 * @param {Object} material - three.js NodeMaterial (or subclass).
 * @param {Object} opts
 * @param {string} opts.name
 * @param {string} opts.threeVersion
 * @param {string} [opts.pluginVersion] - Compatibility spelling for toolchainVersion.
 * @param {string} [opts.toolchainVersion]
 * @param {string|Object} [opts.renderContextSignature] - Compatibility-only; context is stored separately and not source-hashed.
 * @return {string} hex-encoded sha256, 64 chars
 */
export function computeArtifactHash( material, opts = {} ) {

	const payload = createMaterialSourceHashPayload( material, opts );

	return createHash( 'sha256' ).update( payload ).digest( 'hex' );

}

// Explicit name for metadata stampers. `computeArtifactHash` remains the
// backwards-compatible public API used by existing capture code.
export const computeSourceGraphHash = computeArtifactHash;

/**
 * Hash an INPUT TSL node graph — the structural fingerprint of a node tree
 * that drives an aux-pass (scene.backgroundNode, postProcessing.outputNode,
 * PMREM input node, LightsNode over a scene's light set).
 *
 * Unlike `computeArtifactContentHash` (which hashes the extracted output)
 * this function hashes the INPUT. Critical property: it can be run at
 * BUILD time (in Node, where we have the extractor) AND at RUNTIME (in the
 * browser, where we don't) — both produce the same hash. The runtime uses
 * it to look up an aux-pass artifact in the manifest without re-running
 * extraction.
 *
 * @param {Object} node - A TSL node or plain config object.
 * @param {Object} opts
 * @param {string} opts.shape - e.g. 'background', 'pmrem', 'post-process', 'lights'.
 * @param {string} opts.threeVersion
 * @param {string} opts.pluginVersion
 * @return {string} hex-encoded sha256, 64 chars
 */
export function computeNodeGraphHash( node, { shape, threeVersion, pluginVersion } ) {

	if ( typeof shape !== 'string' || shape.length === 0 ) {

		throw new TypeError( 'computeNodeGraphHash: "shape" must be a non-empty string' );

	}
	assertVersion( 'computeNodeGraphHash', threeVersion, pluginVersion );

	const normalized = normalizeNode( node, new Set(), 0 );
	const payload = [ 'node-v1', shape, threeVersion, pluginVersion, normalized ].join( '\n' );
	return createHash( 'sha256' ).update( payload ).digest( 'hex' );

}

// Public export — plugin/runtime both use the shared contract implementation.
export { normalizeMaterialGraph, normalizeNode };

/**
 * Hash a plain-object config (no TSL walking). For aux shapes whose config
 * signature is a JSON-safe object: {kind, width, height, format} for PMREM,
 * {signature: ['DirectionalLight','PointLight:shadow']} for Lighting, etc.
 *
 * @param {Object} config
 * @param {{ shape: string, threeVersion: string, pluginVersion: string }} opts
 * @return {string} hex-encoded sha256, 64 chars
 */
export function computePlainConfigHash( config, { shape, threeVersion, pluginVersion } ) {

	if ( typeof shape !== 'string' || shape.length === 0 ) {

		throw new TypeError( 'computePlainConfigHash: "shape" must be a non-empty string' );

	}
	assertVersion( 'computePlainConfigHash', threeVersion, pluginVersion );
	const payload = [
		'plain-v1',
		shape,
		threeVersion,
		pluginVersion,
		stableStringify( config ),
	].join( '\n' );
	return createHash( 'sha256' ).update( payload ).digest( 'hex' );

}

function stableStringify( v ) {

	if ( v === null || typeof v !== 'object' ) return JSON.stringify( v );
	if ( Array.isArray( v ) ) return '[' + v.map( stableStringify ).join( ',' ) + ']';
	const keys = Object.keys( v ).sort();
	return '{' + keys.map( ( k ) => JSON.stringify( k ) + ':' + stableStringify( v[ k ] ) ).join( ',' ) + '}';

}
