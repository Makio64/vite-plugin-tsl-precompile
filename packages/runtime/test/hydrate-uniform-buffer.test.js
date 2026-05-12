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
