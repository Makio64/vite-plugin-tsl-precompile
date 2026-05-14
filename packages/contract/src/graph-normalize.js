export const MAX_GRAPH_DEPTH = 128;

/**
 * User-registered material identity overrides. Keys are material constructors;
 * values are the stable identity string the hasher should use instead of
 * `constructor.type || constructor.name`.
 *
 * Why: when an adopter writes `class MyMaterial extends MeshStandardNodeMaterial {}`
 * without setting `static type`, the default identity is the class name. After
 * production minification the class name may change (e.g. `MyMaterial` → `m`),
 * which silently shifts the artifact hash between dev and prod. Adopters can
 * call `registerMaterial(MyMaterial, { type: 'MyMaterial' })` once at module
 * load to pin the identity across builds.
 *
 * @type {Map<Function, string>}
 */
const USER_MATERIAL_IDENTITIES = new Map();

/**
 * Register a stable identity for a material constructor so the hasher uses it
 * instead of `constructor.type || constructor.name`. Pin once per class at
 * module load:
 *
 * ```js
 * import { registerMaterial } from '@tsl-precompile/contract/graph-normalize';
 *
 * class MyMaterial extends THREE.MeshStandardNodeMaterial {}
 * registerMaterial( MyMaterial, { type: 'MyMaterial' } );
 * ```
 *
 * Idempotent: re-registering the same class with the same identity is a
 * no-op. Registering with a *different* identity throws — one identity per
 * class is the invariant the staleness gate relies on.
 *
 * @param {Function} MaterialCtor - the material constructor (the class itself)
 * @param {{ type: string }} descriptor
 * @return {string} the registered identity
 */
export function registerMaterial( MaterialCtor, descriptor ) {

	if ( typeof MaterialCtor !== 'function' ) {

		throw new TypeError( 'registerMaterial: first arg must be the material constructor (class).' );

	}
	if ( ! descriptor || typeof descriptor !== 'object' ) {

		throw new TypeError( 'registerMaterial: second arg must be a descriptor with a `type` field.' );

	}
	const type = descriptor.type;
	if ( typeof type !== 'string' || type.length === 0 ) {

		throw new TypeError( 'registerMaterial: descriptor.type must be a non-empty string.' );

	}
	const existing = USER_MATERIAL_IDENTITIES.get( MaterialCtor );
	if ( existing !== undefined ) {

		if ( existing === type ) return existing;
		throw new Error( `registerMaterial: class is already registered with identity ${ JSON.stringify( existing ) }; cannot change to ${ JSON.stringify( type ) }.` );

	}
	USER_MATERIAL_IDENTITIES.set( MaterialCtor, type );
	return type;

}

/**
 * Test helper / explicit teardown. Returns `true` when an entry was removed.
 *
 * @param {Function} MaterialCtor
 * @return {boolean}
 */
export function unregisterMaterial( MaterialCtor ) {

	return USER_MATERIAL_IDENTITIES.delete( MaterialCtor );

}

/**
 * Resolve a material's stable identity. Checks the user registry first, then
 * falls back to `constructor.type || constructor.name`.
 *
 * Exported so the runtime + plugin can use the same resolution path (e.g. for
 * diagnostics or inspector views) — the hash itself uses this via
 * `normalizeMaterialGraph` and `normalizeNode`.
 *
 * @param {?Object} material
 * @return {string}
 */
export function materialIdentity( material ) {

	if ( ! material ) return 'UnknownMaterial';
	const ctor = material.constructor;
	if ( ! ctor ) return 'UnknownMaterial';
	const registered = USER_MATERIAL_IDENTITIES.get( ctor );
	if ( registered !== undefined ) return registered;
	return ctor.type || ctor.name || 'UnknownMaterial';

}

/**
 * Deterministic string representation of a material's TSL graph.
 *
 * @param {Object} material
 * @return {string}
 */
export function normalizeMaterialGraph( material ) {

	if ( ! material ) return '(null-material)';

	const typeTag = materialIdentity( material );
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
