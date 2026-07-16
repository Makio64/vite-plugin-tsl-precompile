import test from 'node:test';
import assert from 'node:assert/strict';

import {
	RANGE_ATTRIBUTE_GENERATOR_SIDECAR,
	generateRangeAttributeArray,
} from '@tsl-precompile/contract/attribute-generators';
import { installRangeAttributeCapture } from '../src/range-attribute-capture.js';

function captureThree( RangeNode, Attribute = null ) {

	class InstancedBufferAttribute {

		constructor( array, itemSize ) {

			this.array = array;
			this.itemSize = itemSize;
			this.count = array.length / itemSize;
			this.isBufferAttribute = true;
			this.isInstancedBufferAttribute = true;

		}

	}
	return {
		REVISION: '184',
		RangeNode,
		InstancedBufferAttribute: Attribute || InstancedBufferAttribute,
		TSL: {
			instancedBufferAttribute: ( attribute ) => ( {
				convert: ( type ) => ( { attribute, type, isNode: true } ),
			} ),
		},
	};

}

test( 'development RangeNode capture stamps a byte-exact deterministic recipe', () => {

	class RangeNode {

		constructor() {

			this.id = 4;
			this.minNode = { value: - 1 };
			this.maxNode = { value: 2 };

		}

		getConstNode( node ) { return node; }
		getNodeType() { return 'float'; }

		setup( builder ) {

			const array = new Float32Array( builder.object.count * 4 );
			for ( let index = 0; index < array.length; index ++ ) {

				const t = Math.random();
				array[ index ] = ( 1 - t ) * - 1 + t * 2;

			}
			builder.geometry.attribute = { array, itemSize: 4, count: builder.object.count };
			return { isNode: true };

		}

	}
	const geometry = {
		attribute: null,
		setAttribute( name, attribute ) { if ( name === '__range4' ) this.attribute = attribute; },
		getAttribute( name ) { return name === '__range4' ? this.attribute : null; },
	};
	const before = Math.random;
	assert.equal( installRangeAttributeCapture( captureThree( RangeNode ) ), true );
	assert.equal( installRangeAttributeCapture( captureThree( RangeNode ) ), false, 'patch is idempotent' );

	const node = new RangeNode();
	let calls = 0;
	Math.random = () => { calls ++; return 0.25; };
	try {

		node.setup( { object: { count: 3 }, geometry, getUniformBufferLimit: () => 0 } );

	} finally {

		Math.random = before;

	}
	const recipe = geometry.attribute[ RANGE_ATTRIBUTE_GENERATOR_SIDECAR ];

	assert.ok( recipe );
	assert.equal( calls, 0, 'physical RangeNode capture never consumes ambient randomness' );
	assert.equal( Math.random, before, 'ambient randomness is never replaced' );
	assert.deepEqual( geometry.attribute.array, generateRangeAttributeArray( recipe, 3 ) );

} );

test( 'development RangeNode capture leaves an existing deterministic Math.random harness untouched', () => {

	class RangeNode {

		constructor() {

			this.id = 8;
			this.minNode = { value: 0 };
			this.maxNode = { value: 1 };

		}

		getConstNode( node ) { return node; }
		getNodeType() { return 'float'; }

		setup( builder ) {

			const array = new Float32Array( builder.object.count * 4 );
			for ( let index = 0; index < array.length; index ++ ) array[ index ] = Math.random();
			builder.geometry.attribute = { array, itemSize: 4, count: builder.object.count };

		}

	}
	const geometry = {
		attribute: null,
		setAttribute( name, attribute ) { if ( name === '__range8' ) this.attribute = attribute; },
		getAttribute( name ) { return name === '__range8' ? this.attribute : null; },
	};
	const nativeRandom = Math.random;
	let calls = 0;
	const harnessRandom = () => ( ++ calls ) / 10;
	Math.random = harnessRandom;
	try {

		installRangeAttributeCapture( captureThree( RangeNode ) );
		new RangeNode().setup( { object: { count: 2 }, geometry, getUniformBufferLimit: () => 0 } );
		assert.equal( calls, 0, 'the existing harness is not sampled for a seed or values' );
		assert.equal( Math.random, harnessRandom );
		assert.ok( geometry.attribute[ RANGE_ATTRIBUTE_GENERATOR_SIDECAR ] );

	} finally {

		Math.random = nativeRandom;

	}

} );

test( 'development RangeNode capture leaves scalar and uniform-buffer random streams untouched', () => {

	class RangeNode {

		constructor() {

			this.id = 12;
			this.minNode = { value: 0 };
			this.maxNode = { value: 1 };

		}

		getConstNode( node ) { return node; }

		setup( builder ) {

			if ( builder.object.count <= 1 ) return 0;
			for ( let index = 0; index < builder.object.count * 4; index ++ ) Math.random();
			return 1;

		}

	}
	installRangeAttributeCapture( captureThree( RangeNode ) );
	const nativeRandom = Math.random;
	let calls = 0;
	Math.random = () => { calls ++; return 0.25; };
	try {

		const node = new RangeNode();
		node.setup( { object: { count: 1 }, getUniformBufferLimit: () => 0 } );
		assert.equal( calls, 0, 'stock scalar RangeNode consumes no random values' );
		node.setup( { object: { count: 2 }, getUniformBufferLimit: () => 1024 } );
		assert.equal( calls, 8, 'uniform-buffer RangeNode keeps its stock random stream' );

	} finally {

		Math.random = nativeRandom;

	}

} );

test( 'development RangeNode capture fails closed for frozen prototypes and attributes', () => {

	class FrozenRangeNode { setup() {} }
	Object.freeze( FrozenRangeNode.prototype );
	assert.equal( installRangeAttributeCapture( captureThree( FrozenRangeNode ) ), false );
	assert.equal( installRangeAttributeCapture( { ...captureThree( class RangeNode { setup() {} } ), REVISION: '185' } ), false );

	class RangeNode {

		constructor() {

			this.id = 16;
			this.minNode = { value: 0 };
			this.maxNode = { value: 1 };

		}

		getConstNode( node ) { return node; }
		getNodeType() { return 'float'; }

		setup( builder ) {

			const array = new Float32Array( 8 );
			for ( let index = 0; index < array.length; index ++ ) array[ index ] = Math.random();
			builder.geometry.attribute = Object.preventExtensions( { array, itemSize: 4, count: 2 } );

		}

	}
	const geometry = {
		attribute: null,
		setAttribute( name, attribute ) { if ( name === '__range16' ) this.attribute = attribute; },
		getAttribute( name ) { return name === '__range16' ? this.attribute : null; },
	};
	class FrozenAttribute {

		constructor( array, itemSize ) {

			return Object.preventExtensions( {
				array,
				itemSize,
				count: array.length / itemSize,
				isBufferAttribute: true,
				isInstancedBufferAttribute: true,
			} );

		}

	}
	installRangeAttributeCapture( captureThree( RangeNode, FrozenAttribute ) );
	assert.doesNotThrow( () => new RangeNode().setup( {
		object: { count: 2 },
		geometry,
		getUniformBufferLimit: () => 0,
	} ) );
	assert.equal( geometry.attribute[ RANGE_ATTRIBUTE_GENERATOR_SIDECAR ], undefined );

} );
