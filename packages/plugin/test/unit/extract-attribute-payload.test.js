import test from 'node:test';
import assert from 'node:assert/strict';

import {
	RANGE_ATTRIBUTE_GENERATOR_SIDECAR,
	createInstanceMatrixAttributeReference,
	createRangeAttributeGenerator,
	generateRangeAttributeArray,
} from '@tsl-precompile/contract/attribute-generators';
import { extractArtifact } from '../../src/vendor/compileTSL.js';

function emptyState( attributes ) {

	return {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		computeShader: '',
		nodeAttributes: attributes,
		bindings: [],
		updateNodes: [],
		updateBeforeNodes: [],
		updateAfterNodes: [],
	};

}

test( 'extractor serializes verified RangeNode recipes instead of Float32 snapshots', () => {

	const recipe = createRangeAttributeGenerator( 7, [ 0, 0, 0, 0 ], [ 1, 1, 1, 1 ] );
	const liveAttribute = {
		isBufferAttribute: true,
		isInstancedBufferAttribute: true,
		count: 2,
		itemSize: 4,
		array: generateRangeAttributeArray( recipe, 2 ),
	};
	Object.defineProperty( liveAttribute, RANGE_ATTRIBUTE_GENERATOR_SIDECAR, { value: recipe } );

	const artifact = extractArtifact( 1, emptyState( [ {
		name: 'nodeAttribute0',
		type: 'vec4',
		node: { attribute: liveAttribute },
	} ] ) );

	assert.deepEqual( artifact.attributes[ 0 ].arrayGenerator, recipe );
	assert.equal( artifact.attributes[ 0 ].arraySnapshot, undefined );

	liveAttribute.array[ 0 ] = 99;
	const stale = extractArtifact( 1, emptyState( [ {
		name: 'nodeAttribute0',
		type: 'vec4',
		node: { attribute: liveAttribute },
	} ] ) );
	assert.equal( stale.attributes[ 0 ].arrayGenerator, undefined );
	assert.equal( stale.attributes[ 0 ].arraySnapshot[ 0 ], 99 );

} );

test( 'extractor omits only identity-proven instanceMatrix columns', () => {

	const matrixArray = new Float32Array( 32 );
	const matrix = { array: matrixArray, count: 2 };
	const data = {
		array: matrixArray,
		stride: 16,
		isInstancedInterleavedBuffer: true,
		meshPerAttribute: 1,
	};
	const column = {
		isBufferAttribute: true,
		isInterleavedBufferAttribute: true,
		data,
		offset: 8,
		count: 2,
		itemSize: 4,
		array: matrixArray,
	};
	const object = { isInstancedMesh: true, count: 2, instanceMatrix: matrix };
	const artifact = extractArtifact( 1, emptyState( [ {
		name: 'nodeAttribute2',
		type: 'vec4',
		node: { attribute: column },
	} ] ), null, object );

	assert.deepEqual( artifact.attributes[ 0 ].objectAttribute, createInstanceMatrixAttributeReference( 2 ) );
	assert.equal( artifact.attributes[ 0 ].arraySnapshot, undefined );

	const lookalike = { ...column, data: { ...data, array: new Float32Array( 32 ) }, array: new Float32Array( 32 ) };
	const fallback = extractArtifact( 1, emptyState( [ {
		name: 'nodeAttribute2',
		type: 'vec4',
		node: { attribute: lookalike },
	} ] ), null, object );
	assert.equal( fallback.attributes[ 0 ].objectAttribute, undefined );
	assert.equal( fallback.attributes[ 0 ].arraySnapshot.length, 8 );

	const wrongStep = { ...column, data: { ...data, meshPerAttribute: 2 } };
	const wrongStepArtifact = extractArtifact( 1, emptyState( [ {
		name: 'nodeAttribute2',
		type: 'vec4',
		node: { attribute: wrongStep },
	} ] ), null, object );
	assert.equal( wrongStepArtifact.attributes[ 0 ].objectAttribute, undefined );
	assert.equal( wrongStepArtifact.attributes[ 0 ].arraySnapshot.length, 8 );

} );
