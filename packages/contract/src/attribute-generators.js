/**
 * Compact, synchronous generators for artifact-owned attribute arrays.
 *
 * These descriptors are reserved for data whose capture path was made
 * deterministic before Three created the live BufferAttribute. They are not
 * inferred from observed values: doing so would silently turn arbitrary scene
 * data into a lossy approximation.
 *
 * @module Contract.AttributeGenerators
 */

export const RANGE_ATTRIBUTE_GENERATOR_KIND = 'range@1';
export const INSTANCE_MATRIX_ATTRIBUTE_KIND = 'instance-matrix@1';

/**
 * Process-local sidecar used by development capture to relate a generated
 * Three BufferAttribute to its serializable recipe. Symbol.for() keeps the
 * identity stable when Vite loads runtime and extractor modules through
 * separate package graphs in the same browser realm.
 */
export const RANGE_ATTRIBUTE_GENERATOR_SIDECAR = Symbol.for( '@tsl-precompile/range-attribute-generator@1' );

const UINT32_SCALE = 0x100000000;
const NON_ZERO_SEED = 0x9e3779b9;

function exactVec4( value ) {

	if ( ! Array.isArray( value ) || value.length !== 4 ) return null;
	const result = value.map( ( component ) => {

		const number = Number( component );
		return Object.is( number, - 0 ) ? 0 : number;

	} );
	return result.every( Number.isFinite ) ? result : null;

}

function hasExactKeys( value, expected ) {

	if ( ! value || typeof value !== 'object' || Array.isArray( value ) ) return false;
	const keys = Object.keys( value ).sort();
	return keys.length === expected.length && keys.every( ( key, index ) => key === expected[ index ] );

}

/** Create the canonical serializable RangeNode recipe. */
export function createRangeAttributeGenerator( seed, min, max ) {

	if ( ! Number.isInteger( seed ) || seed < 0 || seed > 0xffffffff ) {

		throw new TypeError( 'range attribute generator seed must be an unsigned 32-bit integer' );

	}
	const min4 = exactVec4( min );
	const max4 = exactVec4( max );
	if ( ! min4 || ! max4 ) throw new TypeError( 'range attribute generator bounds must be finite vec4 arrays' );
	return Object.freeze( {
		kind: RANGE_ATTRIBUTE_GENERATOR_KIND,
		seed,
		min: Object.freeze( min4 ),
		max: Object.freeze( max4 ),
	} );

}

/** Fail-closed shape guard shared by extractor and runtime. */
export function isRangeAttributeGenerator( value ) {

	const min = exactVec4( value && value.min );
	const max = exactVec4( value && value.max );
	return hasExactKeys( value, [ 'kind', 'max', 'min', 'seed' ] )
		&& value.kind === RANGE_ATTRIBUTE_GENERATOR_KIND
		&& Number.isInteger( value.seed )
		&& value.seed >= 0
		&& value.seed <= 0xffffffff
		&& min !== null
		&& max !== null
		&& value.min.every( ( component, index ) => Object.is( component, min[ index ] ) )
		&& value.max.every( ( component, index ) => Object.is( component, max[ index ] ) );

}

/** Create an exact reference to one physical instanceMatrix vec4 column. */
export function createInstanceMatrixAttributeReference( column ) {

	if ( ! Number.isInteger( column ) || column < 0 || column > 3 ) {

		throw new TypeError( 'instance matrix attribute column must be an integer from 0 to 3' );

	}
	return Object.freeze( { kind: INSTANCE_MATRIX_ATTRIBUTE_KIND, column } );

}

/** Validate the serializable instanceMatrix reference itself. */
export function isInstanceMatrixAttributeReference( value ) {

	return hasExactKeys( value, [ 'column', 'kind' ] )
		&& value.kind === INSTANCE_MATRIX_ATTRIBUTE_KIND
		&& Number.isInteger( value.column )
		&& value.column >= 0
		&& value.column <= 3;

}

function hasExclusiveCapturedSource( entry, selected ) {

	for ( const key of [ 'arrayGenerator', 'objectAttribute', 'arraySnapshot', 'userPath' ] ) {

		if ( key !== selected && entry[ key ] !== undefined ) return false;

	}
	return true;

}

function isPhysicalFloatVec4AttributeDescriptor( entry ) {

	return !! entry
		&& typeof entry === 'object'
		&& ! Array.isArray( entry )
		&& entry.source === 'node'
		&& entry.arrayType === 'Float32Array'
		&& entry.itemSize === 4
		&& entry.instanced === true
		&& entry.storage === false
		&& Number.isSafeInteger( entry.count )
		&& entry.count > 0
		&& entry.count <= 0x1fffffff;

}

/** Validate a complete captured RangeNode attribute descriptor. */
export function isRangeAttributeDescriptor( entry ) {

	return isPhysicalFloatVec4AttributeDescriptor( entry )
		&& isRangeAttributeGenerator( entry.arrayGenerator )
		&& hasExclusiveCapturedSource( entry, 'arrayGenerator' );

}

/** Validate a complete captured instanceMatrix-column descriptor. */
export function isInstanceMatrixAttributeDescriptor( entry ) {

	return isPhysicalFloatVec4AttributeDescriptor( entry )
		&& isInstanceMatrixAttributeReference( entry.objectAttribute )
		&& hasExclusiveCapturedSource( entry, 'objectAttribute' );

}

/**
 * Small deterministic PRNG used only for visual RangeNode data. The capture
 * wrapper and runtime replay call this exact implementation, so generated
 * Float32 values are byte-identical without shipping the values themselves.
 */
export function createRangeAttributeRandom( seed ) {

	let state = ( seed >>> 0 ) || NON_ZERO_SEED;
	return () => {

		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return ( state >>> 0 ) / UINT32_SCALE;

	};

}

function assertRangeCount( count ) {

	if ( ! Number.isSafeInteger( count ) || count < 0 || count > 0x1fffffff ) {

		throw new TypeError( 'range attribute generator count must be a bounded non-negative integer' );

	}

}

/**
 * Fill a physical vec4 RangeNode stream, optionally directly into an
 * interleaved destination. This avoids allocating and then copying a temporary
 * snapshot during hydration.
 */
export function fillRangeAttributeArray( target, recipe, count, stride = 4, offset = 0 ) {

	if ( ! isRangeAttributeGenerator( recipe ) ) throw new TypeError( 'invalid range attribute generator' );
	assertRangeCount( count );
	if ( ! ArrayBuffer.isView( target ) || target instanceof DataView ) throw new TypeError( 'range attribute target must be a typed array' );
	if ( ! Number.isSafeInteger( stride ) || stride < 4 || ! Number.isSafeInteger( offset ) || offset < 0 ) {

		throw new TypeError( 'range attribute target stride/offset is invalid' );

	}
	if ( count > 0 && ( count - 1 ) * stride + offset + 4 > target.length ) throw new RangeError( 'range attribute target is too small' );

	const min = recipe.min;
	const max = recipe.max;
	let state = ( recipe.seed >>> 0 ) || NON_ZERO_SEED;
	for ( let instance = 0; instance < count; instance ++ ) {

		const base = instance * stride + offset;
		for ( let component = 0; component < 4; component ++ ) {

			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			const t = ( state >>> 0 ) / UINT32_SCALE;
			target[ base + component ] = ( 1 - t ) * min[ component ] + t * max[ component ];

		}

	}
	return target;

}

/** Materialize the physical vec4 array emitted by Three's RangeNode. */
export function generateRangeAttributeArray( recipe, count ) {

	assertRangeCount( count );
	const array = new Float32Array( count * 4 );
	fillRangeAttributeArray( array, recipe, count );
	return array;

}
