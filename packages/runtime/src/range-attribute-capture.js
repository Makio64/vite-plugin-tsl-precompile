/**
 * Development-only RangeNode capture support.
 *
 * Three's RangeNode normally fills large anonymous instance attributes with
 * Math.random(). A captured shader artifact then has no reproducible source
 * for those values and must embed every Float32. For the version-checked r185
 * physical-attribute branch, dev capture builds the equivalent node with a
 * local deterministic stream and attaches a private recipe sidecar for the
 * extractor. Math.random is never read or replaced, so capture cannot consume
 * application randomness or perturb another subsystem's seeded harness.
 */

import {
	RANGE_ATTRIBUTE_GENERATOR_SIDECAR,
	createRangeAttributeGenerator,
	generateRangeAttributeArray,
} from '@tsl-precompile/contract/attribute-generators';

const PATCHED = Symbol.for( '@tsl-precompile/range-node-capture-patched@1' );
const SUPPORTED_THREE_REVISION = '185';
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function finite( value ) {

	const number = Number( value );
	return Number.isFinite( number ) ? number : null;

}

function rangeValueVec4( value ) {

	if ( typeof value === 'number' || typeof value === 'boolean' ) {

		const number = finite( value );
		return number === null ? null : [ number, number, number, number ];

	}
	if ( ! value || typeof value !== 'object' ) return null;
	if ( value.isColor === true ) {

		const r = finite( value.r );
		const g = finite( value.g );
		const b = finite( value.b );
		return r === null || g === null || b === null ? null : [ r, g, b, 1 ];

	}
	const x = finite( value.x );
	const y = finite( value.y );
	if ( x === null || y === null ) return null;
	if ( value.isVector2 === true ) return [ x, y, 0, 0 ];
	const z = finite( value.z || 0 );
	if ( z === null ) return null;
	if ( value.isVector3 === true ) return [ x, y, z, 0 ];
	const w = finite( value.w || 0 );
	return value.isVector4 === true && w !== null ? [ x, y, z, w ] : null;

}

function rangeBounds( node ) {

	if ( ! node || typeof node.getConstNode !== 'function' ) return null;
	try {

		const minNode = node.getConstNode( node.minNode );
		const maxNode = node.getConstNode( node.maxNode );
		const min = rangeValueVec4( minNode && minNode.value );
		const max = rangeValueVec4( maxNode && maxNode.value );
		return min && max ? { min, max } : null;

	} catch ( _ ) {

		return null;

	}

}

function arraysAreIdentical( left, right ) {

	if ( ! left || ! right || left.length !== right.length ) return false;
	for ( let index = 0; index < left.length; index ++ ) if ( ! Object.is( left[ index ], right[ index ] ) ) return false;
	return true;

}

function deterministicRecipeSeed( builder, bounds, ordinal ) {

	const object = builder && builder.object || {};
	const parts = [
		SUPPORTED_THREE_REVISION,
		// Node/Object ids and UUIDs are allocation-order identities. Capture
		// loads instrumentation modules that stock rendering does not, so the
		// same authored RangeNode can receive different identities in the two
		// passes. The per-object setup ordinal is semantic to this graph walk
		// and remains aligned while still separating equal-bound RangeNodes.
		ordinal,
		object.type ?? ( object.constructor && object.constructor.name ) ?? '',
		object.count ?? '',
		...bounds.min,
		...bounds.max,
	];
	let hash = FNV_OFFSET;
	const text = parts.join( '|' );
	for ( let index = 0; index < text.length; index ++ ) {

		hash ^= text.charCodeAt( index );
		hash = Math.imul( hash, FNV_PRIME );

	}
	return hash >>> 0;

}

function stampVerifiedRecipe( node, builder, recipe ) {

	const geometry = builder && builder.geometry;
	if ( ! geometry || typeof geometry.getAttribute !== 'function' ) return;
	const attribute = geometry.getAttribute( `__range${ node.id }` );
	const count = builder && builder.object && builder.object.count;
	if ( ! attribute
		|| attribute.itemSize !== 4
		|| attribute.count !== count
		|| ! ( attribute.array instanceof Float32Array ) ) return;

	const expected = generateRangeAttributeArray( recipe, count );
	if ( ! arraysAreIdentical( attribute.array, expected ) ) return;
	try {

		Object.defineProperty( attribute, RANGE_ATTRIBUTE_GENERATOR_SIDECAR, {
			value: recipe,
			configurable: true,
		} );

	} catch ( _ ) {

		// Non-extensible/custom attributes keep the ordinary snapshot path.

	}

}

function usesPhysicalRangeAttribute( builder ) {

	const count = builder && builder.object && builder.object.count;
	if ( ! Number.isSafeInteger( count ) || count <= 1 || typeof builder.getUniformBufferLimit !== 'function' ) return false;
	let limit;
	try { limit = builder.getUniformBufferLimit(); } catch ( _ ) { return false; }
	return Number.isFinite( limit ) && count * 16 > limit;

}

function createPhysicalRangeOutput( three, node, builder, bounds, ordinal ) {

	const geometry = builder && builder.geometry;
	const object = builder && builder.object;
	const createAttributeNode = three && three.TSL && three.TSL.instancedBufferAttribute;
	if ( ! geometry
		|| typeof geometry.setAttribute !== 'function'
		|| ! object
		|| ! Number.isSafeInteger( object.count )
		|| object.count <= 1
		|| typeof three.InstancedBufferAttribute !== 'function'
		|| typeof createAttributeNode !== 'function'
		|| typeof node.getNodeType !== 'function' ) return null;

	const recipe = createRangeAttributeGenerator(
		deterministicRecipeSeed( builder, bounds, ordinal ),
		bounds.min,
		bounds.max,
	);
	const attribute = new three.InstancedBufferAttribute(
		generateRangeAttributeArray( recipe, object.count ),
		4,
	);
	geometry.setAttribute( `__range${ node.id }`, attribute );
	const attributeNode = createAttributeNode( attribute );
	if ( ! attributeNode || typeof attributeNode.convert !== 'function' ) {

		if ( typeof geometry.deleteAttribute === 'function' ) geometry.deleteAttribute( `__range${ node.id }` );
		return null;

	}
	stampVerifiedRecipe( node, builder, recipe );
	return { output: attributeNode.convert( node.getNodeType( builder ) ) };

}

/** Patch the active Three RangeNode class once for development capture. */
export function installRangeAttributeCapture( three ) {

	const RangeNode = three && three.RangeNode;
	const prototype = RangeNode && RangeNode.prototype;
	if ( String( three && three.REVISION ) !== SUPPORTED_THREE_REVISION ) return false;
	if ( typeof three.InstancedBufferAttribute !== 'function'
		|| ! three.TSL
		|| typeof three.TSL.instancedBufferAttribute !== 'function' ) return false;
	if ( ! prototype || prototype[ PATCHED ] === true || typeof prototype.setup !== 'function' ) return false;
	if ( ! Object.isExtensible( prototype ) ) return false;
	const originalSetup = prototype.setup;
	const originalDescriptor = Object.getOwnPropertyDescriptor( prototype, 'setup' );
	const rangeOrdinalsByObject = new WeakMap();
	const rangeOrdinalsWithoutObject = new WeakMap();
	let nextOrdinalWithoutObject = 0;
	const recipeOrdinal = ( node, builder ) => {

		const object = builder && builder.object;
		if ( object && ( typeof object === 'object' || typeof object === 'function' ) ) {

			let state = rangeOrdinalsByObject.get( object );
			if ( ! state ) {

				state = { next: 0, byNode: new WeakMap() };
				rangeOrdinalsByObject.set( object, state );

			}
			if ( ! state.byNode.has( node ) ) state.byNode.set( node, state.next ++ );
			return state.byNode.get( node );

		}
		if ( ! rangeOrdinalsWithoutObject.has( node ) ) rangeOrdinalsWithoutObject.set( node, nextOrdinalWithoutObject ++ );
		return rangeOrdinalsWithoutObject.get( node );

	};
	try {

		Object.defineProperty( prototype, 'setup', {
			configurable: true,
			writable: true,
			value: function setupWithRangeRecipe( builder, ...args ) {

				if ( ! usesPhysicalRangeAttribute( builder ) ) return originalSetup.call( this, builder, ...args );
				const bounds = rangeBounds( this );
				if ( ! bounds ) return originalSetup.call( this, builder, ...args );
				const generated = createPhysicalRangeOutput( three, this, builder, bounds, recipeOrdinal( this, builder ) );
				return generated ? generated.output : originalSetup.call( this, builder, ...args );

			},
		} );
		Object.defineProperty( prototype, PATCHED, { value: true, configurable: true } );
		return true;

	} catch ( _ ) {

		try {

			if ( originalDescriptor ) Object.defineProperty( prototype, 'setup', originalDescriptor );
			else prototype.setup = originalSetup;
			delete prototype[ PATCHED ];

		} catch ( _restoreError ) {}
		return false;

	}

}
