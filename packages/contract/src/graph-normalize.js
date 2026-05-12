export const MAX_GRAPH_DEPTH = 128;

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
export function normalizeNode( node, seen = new Set(), depth = 0 ) {

	if ( node === null || node === undefined ) return 'null';
	if ( typeof node !== 'object' ) return JSON.stringify( node );
	if ( depth > MAX_GRAPH_DEPTH ) return '<depth-cut>';
	if ( seen.has( node ) ) return '<cycle>';
	seen.add( node );

	const tag = ( node.constructor && ( node.constructor.type || node.constructor.name ) ) || 'Node';

	const leaf = leafRepr( node );
	if ( leaf !== null ) return `${ tag }(${ leaf })`;

	if ( node.isMRTNode ) {

		const outputMap = node.outputNodes || node.nodes || {};
		const names = Object.keys( outputMap ).sort();
		const slots = names.map( ( name ) => `${ name }=${ normalizeNode( outputMap[ name ], seen, depth + 1 ) }` );
		return `${ tag }{outputs=[${ slots.join( ',' ) }]}`;

	}

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

	if ( node.isUniformNode && 'value' in node ) return `uniform:${ stringifyValue( node.value ) }`;
	if ( node.isConstNode && 'value' in node ) return `const:${ stringifyValue( node.value ) }`;
	if ( node.isAttributeNode ) return `attr:${ node.attributeName || '?' }:${ node.nodeType || '?' }`;
	if ( node.isTextureNode && node.value ) return `texture:${ node.value.uuid || '?' }`;
	return null;

}

function isPotentialChild( key, val ) {

	if ( val === null || val === undefined ) return false;
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
