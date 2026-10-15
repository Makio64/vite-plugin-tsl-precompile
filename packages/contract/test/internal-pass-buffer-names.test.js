import assert from 'node:assert/strict';
import test from 'node:test';
import { stabilizeInternalPassUniformBufferNames } from '../src/internal-pass.js';

function artifact( id ) {

	return {
		cacheKey: 'blur', vertexShader: 'unchanged vertex', fragmentShader: 'unchanged fragment',
		bindings: [ { name: 'object', bindings: [ { name: `UniformBuffer_${ id }`, kind: 'uniform-buffer' } ] } ],
		uniformPlan: [ { name: 'object', orderedBindings: [ { type: 'buffer-uniform', ref: { name: `UniformBuffer_${ id }`, byteLength: 320, value: [ 1, 2 ] } } ] } ],
	};

}

test( 'internal-pass UBO addresses survive allocation order in every family member', () => {

	const first = artifact( 12 ), second = artifact( 400 );
	first.variants = { blur: artifact( 12 ) };
	second.variants = { blur: artifact( 400 ) };
	stabilizeInternalPassUniformBufferNames( first );
	stabilizeInternalPassUniformBufferNames( second );
	assert.deepEqual( first, second );
	assert.equal( first.uniformPlan[ 0 ].orderedBindings[ 0 ].ref.name, first.bindings[ 0 ].bindings[ 0 ].name );
	assert.equal( first.vertexShader, 'unchanged vertex' );
	assert.deepEqual( first.uniformPlan[ 0 ].orderedBindings[ 0 ].ref.value, [ 1, 2 ] );
	stabilizeInternalPassUniformBufferNames( first );
	assert.deepEqual( first, second );

} );

test( 'internal-pass buffer naming rejects an unmatched descriptor', () => {

	const value = artifact( 12 );
	value.bindings[ 0 ].bindings = [];
	assert.throws( () => stabilizeInternalPassUniformBufferNames( value ), /no binding descriptor/ );

} );
