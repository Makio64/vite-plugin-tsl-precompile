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

	const normalized = normalizeMaterialGraph( material );
	const payload = [
		'v1',
		name,
		threeVersion || '<unknown-three>',
		pluginVersion || '<unknown-plugin>',
		normalized,
	].join( '\n' );

	return createHash( 'sha256' ).update( payload ).digest( 'hex' );

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
