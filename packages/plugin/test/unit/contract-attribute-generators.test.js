import test from 'node:test';
import assert from 'node:assert/strict';

import {
	GENERATED_ATTRIBUTE_FILL_SIDECAR,
	GENERATED_INSTANCE_MATRIX_COLUMN_SIDECAR,
	createInstanceMatrixAttributeReference,
	createRangeAttributeGenerator,
	createRangeAttributeRandom,
	generateRangeAttributeArray,
	isInstanceMatrixAttributeDescriptor,
	isRangeAttributeDescriptor,
	isRangeAttributeGenerator,
	materializeArtifactAttributeDescriptors,
} from '@tsl-precompile/contract/attribute-generators';
import { validateArtifact } from '@tsl-precompile/contract/kinds';

test( 'range attribute recipes reproduce the capture random stream exactly', () => {

	const recipe = createRangeAttributeGenerator( 0x12345678, [ 0, - 1, 2, 4 ], [ 1, 1, 6, 8 ] );
	const random = createRangeAttributeRandom( recipe.seed );
	const expected = new Float32Array( 8 );
	for ( let index = 0; index < expected.length; index ++ ) {

		const component = index & 3;
		const t = random();
		expected[ index ] = ( 1 - t ) * recipe.min[ component ] + t * recipe.max[ component ];

	}

	assert.equal( isRangeAttributeGenerator( recipe ), true );
	assert.deepEqual( generateRangeAttributeArray( recipe, 2 ), expected );

} );

test( 'generated artifact modules materialize range and instance descriptors once across variants', () => {

	const base = {
		name: 'nodeAttribute0',
		type: 'vec4',
		source: 'node',
		count: 2,
		itemSize: 4,
		arrayType: 'Float32Array',
		instanced: true,
		storage: false,
	};
	const recipe = createRangeAttributeGenerator( 7, [ 0, 1, 2, 3 ], [ 4, 5, 6, 7 ] );
	const range = { ...base, arrayGenerator: recipe };
	const matrix = { ...base, objectAttribute: createInstanceMatrixAttributeReference( 3 ) };
	const artifact = {
		attributes: [ range ],
		nodeAttributes: [ range ],
		variants: { shadow: { attributes: [ matrix ] } },
	};

	assert.equal( materializeArtifactAttributeDescriptors( artifact ), artifact );
	assert.equal( typeof range[ GENERATED_ATTRIBUTE_FILL_SIDECAR ], 'function' );
	assert.equal( matrix[ GENERATED_INSTANCE_MATRIX_COLUMN_SIDECAR ], 3 );
	assert.equal( Object.getOwnPropertyDescriptor( range, GENERATED_ATTRIBUTE_FILL_SIDECAR ).enumerable, false );
	const target = new Float32Array( 10 );
	range[ GENERATED_ATTRIBUTE_FILL_SIDECAR ]( target, 5, 1 );
	const expected = generateRangeAttributeArray( recipe, 2 );
	assert.deepEqual(
		Array.from( target ),
		[ 0, ...Array.from( expected.slice( 0, 4 ) ), 0, ...Array.from( expected.slice( 4, 8 ) ) ],
	);

	assert.throws( () => materializeArtifactAttributeDescriptors( {
		attributes: [ { ...range, itemSize: 3 } ],
	} ), /invalid generated range/ );

} );

test( 'range attribute recipes reject malformed bounds and unbounded counts', () => {

	assert.throws( () => createRangeAttributeGenerator( - 1, [ 0, 0, 0, 0 ], [ 1, 1, 1, 1 ] ), /unsigned 32-bit/ );
	assert.throws( () => createRangeAttributeGenerator( 1, [ 0, 0, 0 ], [ 1, 1, 1, 1 ] ), /finite vec4/ );
	const recipe = createRangeAttributeGenerator( 1, [ 0, 0, 0, 0 ], [ 1, 1, 1, 1 ] );
	assert.throws( () => generateRangeAttributeArray( recipe, Number.MAX_SAFE_INTEGER ), /bounded/ );
	const canonical = createRangeAttributeGenerator( 2, [ - 0, 0, 0, 0 ], [ 1, 1, 1, 1 ] );
	assert.equal( Object.is( canonical.min[ 0 ], - 0 ), false, 'recipes stay stable through JSON -0 normalization' );
	assert.equal( isRangeAttributeGenerator( { ...canonical, min: [ - 0, 0, 0, 0 ] } ), false );

} );

test( 'captured attribute descriptors are canonical, exclusive, and contract-validated', () => {

	const recipe = createRangeAttributeGenerator( 1, [ 0, 0, 0, 0 ], [ 1, 1, 1, 1 ] );
	const base = {
		name: 'nodeAttribute0',
		type: 'vec4',
		source: 'node',
		count: 2,
		itemSize: 4,
		arrayType: 'Float32Array',
		instanced: true,
		storage: false,
	};
	const rangeDescriptor = { ...base, arrayGenerator: recipe };
	const matrixDescriptor = { ...base, objectAttribute: createInstanceMatrixAttributeReference( 2 ) };
	assert.equal( isRangeAttributeDescriptor( rangeDescriptor ), true );
	assert.equal( isInstanceMatrixAttributeDescriptor( matrixDescriptor ), true );
	assert.equal( validateArtifact( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [ rangeDescriptor, matrixDescriptor ],
		uniformPlan: [],
	} ).ok, true );

	for ( const invalid of [
		{ ...rangeDescriptor, arrayType: 'Uint16Array' },
		{ ...rangeDescriptor, itemSize: 3 },
		{ ...rangeDescriptor, arraySnapshot: [] },
		{ ...rangeDescriptor, arrayGenerator: { kind: 'range@1', seed: - 1, min: [ 0, 0, 0 ], max: [ 1, 1, 1 ] } },
		{ ...matrixDescriptor, objectAttribute: { kind: 'instance-matrix@1', column: 4 } },
		{ ...matrixDescriptor, userPath: [ 'positionNode' ] },
	] ) {

		const result = validateArtifact( {
			vertexShader: 'vertex',
			fragmentShader: 'fragment',
			attributes: [ invalid ],
			uniformPlan: [],
		} );
		assert.equal( result.ok, false, JSON.stringify( invalid ) );

	}

} );
