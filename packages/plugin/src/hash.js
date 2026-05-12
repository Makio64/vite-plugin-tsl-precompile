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
 * The hash is sha256 over a stable string representation:
 *
 *     `${name}\n${threeVersion}\n${pluginVersion}\n${normalizedGraph}`
 *
 * `normalizedGraph` is produced by `normalizeMaterialGraph()` — a depth-first
 * walk of the material's node tree emitting a canonical tag per node. The walk
 * is deterministic: we sort object keys, inline uniform values, and stamp
 * every node with `constructor.type || constructor.name` so subclass renames
 * invalidate the hash.
 *
 * Intentionally NOT hashed:
 *   - memory addresses, instance uuids, or anything tied to a specific run;
 *   - live Texture pixel data (bind by uuid; pixel drift is out of scope);
 *   - scene state (lights / fog) — those are captured in the *artifact*, not
 *     the source hash. A new scene with the same material source is
 *     deliberately cache-compatible.
 *
 * @module Hash
 */

import { createHash } from 'node:crypto';
import { normalizeMaterialGraph, normalizeNode } from '@tsl-precompile/contract/graph-normalize';

function assertVersion( fn, threeVersion, pluginVersion ) {

	if ( typeof threeVersion !== 'string' || threeVersion.length === 0 ) {

		throw new Error( `${ fn }: "threeVersion" is required (>= 184)` );

	}
	if ( typeof pluginVersion !== 'string' || pluginVersion.length === 0 ) {

		throw new Error( `${ fn }: "pluginVersion" is required` );

	}

}

/**
 * Hash an already-extracted artifact by its RUNTIME content — WGSL strings,
 * binding shape, uniformPlan kinds, and captured value snapshots.
 *
 * Use this for auxiliary-pass artifacts (Background, PMREM, PostProcessing)
 * where the source material is internal to three.js and the author-facing
 * hash signal has to come from the extracted output, not from walking a
 * material that doesn't exist at the call site.
 *
 * Two artifacts with identical WGSL + identical uniformPlan + identical
 * snapshot values hash identically — which is exactly the runtime-lookup
 * semantic we want.
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

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const payload = [
		'artifact-v1',
		shape,
		threeVersion,
		pluginVersion,
		String( artifact.vertexShader || '' ),
		String( artifact.fragmentShader || '' ),
		normaliseUniformPlan( plan ),
	].join( '\n' );

	return createHash( 'sha256' ).update( payload ).digest( 'hex' );

}

function normaliseUniformPlan( plan ) {

	const parts = [];
	for ( const group of plan ) {

		parts.push( `group<${ group.name || '' }>byteLength=${ group.byteLength | 0 }` );
		for ( const slot of ( group.slots || [] ) ) {

			const src = slot.source || {};
			const snap = src.valueSnapshot;
			const snapStr = snap ? `${ snap.type }:[${ Array.isArray( snap.data ) ? snap.data.join( ',' ) : snap.data }]` : '';
			parts.push( `  slot ${ slot.name || '' } off=${ slot.offset | 0 } size=${ slot.size | 0 } dtype=${ slot.dtype || '' } kind=${ src.kind || '' } prop=${ src.property || '' } snap=${ snapStr }` );

		}
		for ( const tex of ( group.textures || [] ) ) {

			const src = tex.source || {};
			parts.push( `  tex ${ tex.name || '' } type=${ tex.textureType } kind=${ src.kind || '' } uuid=${ src.textureUuid || '' }` );

		}

	}
	return parts.join( '\n' );

}

/**
 * Compute the artifact hash for a given material at a given name.
 *
 * @param {Object} material - three.js NodeMaterial (or subclass).
 * @param {Object} opts
 * @param {string} opts.name
 * @param {string} opts.threeVersion
 * @param {string} opts.pluginVersion
 * @return {string} hex-encoded sha256, 64 chars
 */
export function computeArtifactHash( material, { name, threeVersion, pluginVersion } ) {

	if ( typeof name !== 'string' || name.length === 0 ) {

		throw new TypeError( `computeArtifactHash: "name" must be a non-empty string; got ${ typeof name }` );

	}
	assertVersion( 'computeArtifactHash', threeVersion, pluginVersion );

	const normalized = normalizeMaterialGraph( material );
	const payload = [
		'v1',
		name,
		threeVersion,
		pluginVersion,
		normalized,
	].join( '\n' );

	return createHash( 'sha256' ).update( payload ).digest( 'hex' );

}

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
