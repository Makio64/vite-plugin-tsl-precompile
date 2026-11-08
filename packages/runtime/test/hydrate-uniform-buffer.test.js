import test from 'node:test';
import assert from 'node:assert/strict';

import { createUniformBufferBinding } from '../src/hydrate/kinds/uniform-buffer.js';

function createDeps( overrides = {} ) {

	return {
		attachLiveUniformBufferUpdater: () => {},
		createLiveUniformArrayResolver: () => null,
		findUniformGroupByteLength: () => 0,
		findUniformGroupRequiredByteLength: () => 0,
		resolvePlanBufferUniform: () => null,
		seedUniformBufferSnapshots: () => {},
		...overrides,
	};

}

test( 'uniform buffer kind creates grouped buffers and seeds slot snapshots', () => {

	const groupNode = { id: 'group' };
	let seedCall = null;
	let resolverCall = null;
	const binding = createUniformBufferBinding( {
		artifact: {},
		groupName: 'render',
		descriptor: { kind: 'uniform-buffer', name: 'render', visibility: 2, byteLength: 0 },
		name: 'render',
		material: { id: 'material' },
		groupNode,
		deps: createDeps( {
			findUniformGroupByteLength: () => 32,
			findUniformGroupRequiredByteLength: () => 16,
			seedUniformBufferSnapshots: ( artifact, groupName, bindingName, buffer ) => {

				seedCall = { artifact, groupName, bindingName, buffer };
				buffer[ 0 ] = 7;

			},
			createLiveUniformArrayResolver: ( bindingName, byteLength, material ) => {

				resolverCall = { bindingName, byteLength, material };
				return null;

			},
		} ),
	} );

	assert.equal( binding.isUniformBuffer, true );
	assert.equal( binding.name, 'render' );
	assert.equal( binding.visibility, 2 );
	assert.equal( binding.groupNode, groupNode );
	assert.equal( binding.buffer.length, 8 );
	assert.equal( binding.buffer[ 0 ], 7 );
	assert.equal( seedCall.groupName, 'render' );
	assert.equal( seedCall.bindingName, 'render' );
	assert.equal( resolverCall.bindingName, 'render' );
	assert.equal( resolverCall.byteLength, 32 );
	assert.deepEqual( resolverCall.material, { id: 'material' } );

} );

test( 'uniform buffer kind seeds flat NodeUniformBuffers from plan snapshots', () => {

	const liveResolver = () => null;
	let seedCalled = false;
	let attachedResolver = null;
	const binding = createUniformBufferBinding( {
		artifact: {},
		groupName: 'postprocess',
		descriptor: { kind: 'uniform-buffer', name: 'UniformBuffer_4', visibility: 4, byteLength: 16 },
		name: 'UniformBuffer_4',
		material: null,
		groupNode: null,
		deps: createDeps( {
			resolvePlanBufferUniform: () => ( {
				name: 'UniformBuffer_4',
				byteLength: 32,
				valueSnapshot: [ 1, 2, 3, 4, 5, 6, 7, 8 ],
			} ),
			seedUniformBufferSnapshots: () => {

				seedCalled = true;

			},
			createLiveUniformArrayResolver: ( bindingName, byteLength ) => {

				assert.equal( bindingName, 'UniformBuffer_4' );
				assert.equal( byteLength, 32 );
				return liveResolver;

			},
			attachLiveUniformBufferUpdater: ( uniformBuffer, resolver ) => {

				assert.equal( uniformBuffer.name, 'UniformBuffer_4' );
				attachedResolver = resolver;

			},
		} ),
	} );

	assert.equal( binding.isUniformBuffer, true );
	assert.equal( binding.visibility, 4 );
	assert.deepEqual( Array.from( binding.buffer ), [ 1, 2, 3, 4, 5, 6, 7, 8 ] );
	assert.equal( seedCalled, false );
	assert.equal( attachedResolver, liveResolver );

} );

test( 'replay UBOs upload changed bytes and keep upload state private to each clone', async () => {

	const { ReplayUniformBuffer } = await import( '../src/hydrate/kinds/uniform-buffer.js' );
	const buffer = new Float32Array( 4 );
	const binding = new ReplayUniformBuffer( 'object', buffer );
	assert.equal( binding.update(), true );
	assert.equal( binding.update(), false );
	buffer[ 1 ] = -0;
	assert.equal( binding.update(), true, 'signed zero changes bytes' );
	const words = new Uint32Array( buffer.buffer );
	words[ 2 ] = 0x7fc00001;
	assert.equal( binding.update(), true );
	assert.equal( binding.update(), false, 'unchanged NaN payload does not upload forever' );
	words[ 2 ] = 0x7fc00002;
	assert.equal( binding.update(), true, 'different NaN payload changes bytes' );
	const clone = binding.clone();
	assert.equal( clone.update(), true, 'new GPU binding needs its initial upload' );
	buffer[ 0 ] = 12;
	assert.equal( binding.update(), true );
	assert.equal( clone.update(), true, 'clone must not inherit another binding\'s upload history' );
	binding._buffer = new Float32Array( buffer );
	assert.equal( binding.update(), true, 'replacement allocation needs uploading' );

} );

test( 'shared UBO writes honor render/frame cadence and invalidate every render context owner', async () => {

	const { ReplayUniformBuffer } = await import( '../src/hydrate/kinds/uniform-buffer.js' );
	const binding = new ReplayUniformBuffer( 'render', new Float32Array( 4 ) );
	binding.groupNode = { shared: true, updateType: 'render', version: 0 };
	const frame = { frameId: 1, renderId: 1, renderer: {}, scene: {}, camera: {}, lightsNode: {} };
	assert.equal( binding.needsWrite( frame ), true );
	binding.didWrite( frame );
	assert.equal( binding.needsWrite( { ...frame, object: {} } ), false );
	for ( const key of [ 'renderer', 'scene', 'camera', 'lightsNode' ] ) {

		frame[ key ] = {};
		assert.equal( binding.needsWrite( frame ), true, key );
		binding.didWrite( frame );

	}
	frame.renderId ++;
	assert.equal( binding.needsWrite( frame ), true );
	binding.didWrite( frame );
	binding.groupNode.updateType = 'frame';
	frame.renderId ++;
	assert.equal( binding.needsWrite( frame ), false );
	frame.frameId ++;
	assert.equal( binding.needsWrite( frame ), true );
	binding.didWrite( frame );
	binding.groupNode.shared = false;
	assert.equal( binding.needsWrite( frame ), true, 'object UBOs still write on every draw' );
	binding.groupNode.shared = true;
	assert.equal( binding.needsWrite( {} ), true, 'unstamped standalone callers never reuse stale values' );

} );

// Exercise every word, including non-vec4 tails and views inside larger buffers.
test( 'replay UBO upload comparison detects every byte lane and leaves adjacent storage untouched', async () => {

	const { ReplayUniformBuffer } = await import( '../src/hydrate/kinds/uniform-buffer.js' );
	for ( const length of [ 1, 2, 3, 4, 5, 7, 8, 9, 36, 73 ] ) {

		const storage = new Uint32Array( length + 8 ).fill( 0x12345678 );
		const words = storage.subarray( 4, 4 + length );
		const binding = new ReplayUniformBuffer( 'object', new Float32Array( words.buffer, words.byteOffset, length ) );
		assert.equal( binding.update(), true );
		assert.equal( binding.update(), false );
		for ( let i = 0; i < length; i ++ ) {

			for ( const mask of [ 1, 0x100, 0x10000, 0x80000000 ] ) {

				words[ i ] ^= mask;
				assert.equal( binding.update(), true, `${ length } words, index ${ i }, mask ${ mask }` );
				assert.equal( binding.update(), false );

			}

		}
		assert.deepEqual( Array.from( storage.subarray( 0, 4 ) ), Array( 4 ).fill( 0x12345678 ) );
		assert.deepEqual( Array.from( storage.subarray( 4 + length ) ), Array( 4 ).fill( 0x12345678 ) );
		binding.release();
		assert.equal( binding.update(), false );

	}

} );
