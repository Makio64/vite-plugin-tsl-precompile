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

const MAX_GRAPH_DEPTH = 128;

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

// Public export — the runtime mirror uses the same algorithm.
export { normalizeNode };

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

/**
 * Deterministic string representation of a material's TSL graph.
 *
 * @param {Object} material
 * @return {string}
 */
export function normalizeMaterialGraph( material ) {

	if ( ! material ) return '(null-material)';

	const typeTag = material.constructor && ( material.constructor.type || material.constructor.name ) || 'UnknownMaterial';
	const slots = collectNodeSlots( material );

	const parts = [ `material<${ typeTag }>` ];
	for ( const { key, node } of slots ) {

		parts.push( `${ key }=${ normalizeNode( node, new Set(), 0 ) }` );

	}

	return parts.join( '\n' );

}

/**
 * Enumerate the `*Node` slots on a material in a stable order.
 * We don't use `Object.keys` directly because three.js stores a mix of
 * plain properties and class fields; instead we look for every own property
 * whose name ends in `Node` and whose value looks like a node (has `.isNode`
 * or `.type`).
 *
 * @param {Object} material
 * @return {Array<{ key: string, node: ?Object }>}
 */
function collectNodeSlots( material ) {

	const keys = Object.keys( material ).filter( ( k ) => k.endsWith( 'Node' ) );
	keys.sort();
	return keys.map( ( key ) => ( { key, node: material[ key ] } ) );

}

/**
 * Walk a node tree and emit a stable canonical string.
 * Cycle-safe via the `seen` set; depth-capped to avoid runaway recursion
 * on pathological graphs.
 *
 * @param {?Object} node
 * @param {Set<Object>} seen
 * @param {number} depth
 * @return {string}
 */
function normalizeNode( node, seen, depth ) {

	if ( node === null || node === undefined ) return 'null';
	if ( typeof node !== 'object' ) return JSON.stringify( node );
	if ( depth > MAX_GRAPH_DEPTH ) return '<depth-cut>';
	if ( seen.has( node ) ) return '<cycle>';
	seen.add( node );

	const tag = ( node.constructor && ( node.constructor.type || node.constructor.name ) ) || 'Node';

	// Primitive-ish leaf nodes (UniformNode, ConstNode, AttributeNode, etc.)
	// get their `value` inlined so hash differentiates color(#f00) vs color(#00f).
	const leaf = leafRepr( node );
	if ( leaf !== null ) return `${ tag }(${ leaf })`;

	// MRTNode: the captured fragment shader's `@location(N)` count and output
	// struct field names are entirely driven by `mrtNode.outputNodes` keys.
	// `isPotentialChild` doesn't whitelist `outputNodes` (plural, not ending
	// in `Node`), so without this special case two materials that differ only
	// in their MRT shape (`mrt({ a, b })` vs `mrt({ a, b, c })`) collapse to
	// the same artifact hash and the runtime hands back a fragment shader
	// with the wrong attachment count.
	if ( node.isMRTNode ) {

		const outputMap = node.outputNodes || node.nodes || {};
		const names = Object.keys( outputMap ).sort();
		const slots = names.map( ( name ) => `${ name }=${ normalizeNode( outputMap[ name ], seen, depth + 1 ) }` );
		return `${ tag }{outputs=[${ slots.join( ',' ) }]}`;

	}

	// Otherwise walk structural children. We hit the common TSL fields first;
	// anything else ending in Node, node, or fn is a plausible child.
	const kids = [];
	for ( const key of Object.keys( node ).sort() ) {

		const val = node[ key ];
		if ( val === node ) continue;
		if ( ! isPotentialChild( key, val ) ) continue;

		if ( Array.isArray( val ) ) {

			const arr = val.map( ( v ) => normalizeNode( v, seen, depth + 1 ) );
			kids.push( `${ key }=[${ arr.join( ',' ) }]` );

		} else if ( val && typeof val === 'object' ) {

			kids.push( `${ key }=${ normalizeNode( val, seen, depth + 1 ) }` );

		} else if ( val !== undefined ) {

			kids.push( `${ key }=${ JSON.stringify( val ) }` );

		}

	}

	return `${ tag }{${ kids.join( ',' ) }}`;

}

function leafRepr( node ) {

	// UniformNode: { value, nodeType }
	if ( node.isUniformNode && 'value' in node ) return `uniform:${ stringifyValue( node.value ) }`;
	// ConstNode / SplitNode literal
	if ( node.isConstNode && 'value' in node ) return `const:${ stringifyValue( node.value ) }`;
	// AttributeNode: { attributeName, nodeType }
	if ( node.isAttributeNode ) return `attr:${ node.attributeName || '?' }:${ node.nodeType || '?' }`;
	// TextureNode: { value (texture), uvNode, referenceNode } — hash by uuid + sampling
	if ( node.isTextureNode && node.value ) return `texture:${ node.value.uuid || '?' }`;
	return null;

}

function isPotentialChild( key, val ) {

	if ( val === null || val === undefined ) return false;
	// Whitelist node-like keys to avoid dragging in backrefs / caches / etc.
	// Common TSL conventions: *Node, fn, aNode, bNode, scope, nodes[], params[].
	if ( key.endsWith( 'Node' ) ) return true;
	if ( key === 'node' || key === 'fn' || key === 'scope' || key === 'params' ) return true;
	if ( key === 'a' || key === 'b' || key === 'c' ) return typeof val === 'object';
	if ( key === 'nodes' && Array.isArray( val ) ) return true;
	return false;

}

function stringifyValue( v ) {

	if ( v === null || v === undefined ) return String( v );
	if ( typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ) return JSON.stringify( v );
	if ( v.isColor ) return `col(${ v.r },${ v.g },${ v.b })`;
	if ( v.isVector2 ) return `v2(${ v.x },${ v.y })`;
	if ( v.isVector3 ) return `v3(${ v.x },${ v.y },${ v.z })`;
	if ( v.isVector4 ) return `v4(${ v.x },${ v.y },${ v.z },${ v.w })`;
	if ( v.isMatrix3 || v.isMatrix4 ) return `mat(${ Array.from( v.elements ).join( ',' ) })`;
	if ( v.uuid ) return `uuid:${ v.uuid }`;
	return '<obj>';

}
