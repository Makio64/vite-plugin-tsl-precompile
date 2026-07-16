import test from 'node:test';
import assert from 'node:assert/strict';
import { DataTexture } from 'three';

import {
	createRuntimeBindingFromKind,
	RUNTIME_BINDING_KIND_NAMES,
} from '../src/hydrate/kinds/runtime-binding-dispatcher.js';

test( 'runtime binding dispatcher advertises the extracted binding kinds', () => {

	assert.deepEqual(
		RUNTIME_BINDING_KIND_NAMES,
		[ 'uniform-buffer', 'sampled-texture', 'sampler', 'storage-buffer' ]
	);

} );

test( 'runtime binding dispatcher creates sampled texture bindings through injected resolvers', () => {

	const artifact = {};
	const material = { id: 'material' };
	const groupNode = { id: 'group' };
	const texture = new DataTexture();
	let resolverCall = null;
	const binding = createRuntimeBindingFromKind( {
		artifact,
		group: { name: 'render' },
		descriptor: { kind: 'sampled-texture', name: 'nodeTexture0', visibility: 2, store: true, access: 'readWrite', mipLevel: 3 },
		material,
		groupNode,
		deps: {
			resolveTextureBinding: ( receivedArtifact, groupName, bindingName, receivedMaterial ) => {

				resolverCall = { receivedArtifact, groupName, bindingName, receivedMaterial };
				return texture;

			},
			inferTextureTypeFromShader: () => '3d',
		},
	} );

	assert.equal( binding.name, 'nodeTexture0' );
	assert.equal( binding.texture, texture );
	assert.equal( binding.isSampledTexture3D, true );
	assert.equal( binding.visibility, 2 );
	assert.equal( binding.store, true );
	assert.equal( binding.access, 'readWrite' );
	assert.equal( binding.mipLevel, 3 );
	assert.equal( binding.groupNode, groupNode );
	assert.deepEqual( resolverCall, {
		receivedArtifact: artifact,
		groupName: 'render',
		bindingName: 'nodeTexture0',
		receivedMaterial: material,
	} );

} );

test( 'runtime binding dispatcher returns null for unknown descriptor kinds', () => {

	const binding = createRuntimeBindingFromKind( {
		artifact: {},
		group: { name: 'render' },
		descriptor: { kind: 'future-kind', name: 'x' },
		material: null,
		deps: {},
	} );

	assert.equal( binding, null );

} );
