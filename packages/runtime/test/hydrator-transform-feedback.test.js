import test from 'node:test';
import assert from 'node:assert/strict';

import StorageBufferAttribute from 'three/src/renderers/common/StorageBufferAttribute.js';
import { hydrateNodeBuilderState } from '../src/hydrator.js';

function artifactWithAttribute( attributeEntry ) {

	return {
		kind: 'compute',
		computeShader: '#version 300 es\nvoid main() {}',
		vertexShader: '',
		fragmentShader: '',
		attributes: [ attributeEntry ],
		transforms: [ { varyingName: 'nodeVarying0', attribute: 0 } ],
		bindings: [],
		uniformPlan: [],
	};

}

function attributeDescriptor() {

	return {
		name: 'nodeAttribute0',
		type: 'vec4',
		source: 'node',
		count: 2,
		itemSize: 4,
		arrayType: 'Float32Array',
		storage: true,
		instanced: false,
		arraySnapshot: [ 1, 2, 3, 4, 5, 6, 7, 8 ],
	};

}

test( 'hydrator reconstructs transform attributeNodes from the exact hydrated node attribute', () => {

	const artifact = artifactWithAttribute( attributeDescriptor() );
	const serializedDescriptor = JSON.parse( JSON.stringify( artifact.transforms ) );
	const state = hydrateNodeBuilderState( artifact );

	assert.deepEqual( artifact.transforms, serializedDescriptor, 'hydration does not mutate the serial descriptor' );
	assert.equal( state.transforms[ 0 ].varyingName, 'nodeVarying0' );
	assert.equal( state.transforms[ 0 ].attributeNode, state.nodeAttributes[ 0 ].node );
	assert.equal( state.transforms[ 0 ].attributeNode.attribute, state.nodeAttributes[ 0 ].node.attribute );
	assert.equal( state.transforms[ 0 ].attributeNode.attribute.isStorageBufferAttribute, true );
	assert.deepEqual( Array.from( state.transforms[ 0 ].attributeNode.attribute.array ), [ 1, 2, 3, 4, 5, 6, 7, 8 ] );

} );

test( 'hydrator preserves a proven live transform-feedback resource identity', () => {

	const descriptor = attributeDescriptor();
	const liveAttribute = new StorageBufferAttribute( new Float32Array( descriptor.arraySnapshot ), 4 );
	Object.defineProperty( descriptor, '_liveAttribute', {
		value: liveAttribute,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	const state = hydrateNodeBuilderState( artifactWithAttribute( descriptor ) );

	assert.equal( state.nodeAttributes[ 0 ].node.attribute, liveAttribute );
	assert.equal( state.transforms[ 0 ].attributeNode, state.nodeAttributes[ 0 ].node );
	assert.equal( state.transforms[ 0 ].attributeNode.attribute, liveAttribute );

} );

test( 'hydrator fails closed on an out-of-range transform attribute descriptor', () => {

	const artifact = artifactWithAttribute( attributeDescriptor() );
	artifact.transforms[ 0 ].attribute = 1;

	assert.throws(
		() => hydrateNodeBuilderState( artifact ),
		( error ) => {

			assert.equal( error.code, 'TSLP_COMPUTE_TRANSFORM_ATTRIBUTE_INVALID' );
			assert.match( error.message, /out-of-range node attribute 1/ );
			assert.match( error.message, /no public-resource identity is fabricated/ );
			return true;

		},
	);

} );
