import test from 'node:test';
import assert from 'node:assert/strict';

import {
	createArtifactTextureRebinder,
	createMaterialTextureRebinder,
} from '../src/hydrate/rebinders/texture-rebinders.js';

function createBinding( texture ) {

	return {
		texture,
		groupNode: { version: 0 },
		version: 0,
		generation: 1,
	};

}

test( 'material texture rebinder re-resolves material texture bindings', () => {

	const textureA = { uuid: 'a', version: 1 };
	const textureB = { uuid: 'b', version: 1 };
	const binding = createBinding( textureA );
	const artifact = {};
	const material = {};
	let call = null;
	const rebinder = createMaterialTextureRebinder( [ {
		binding,
		artifact,
		groupName: 'render',
		bindingName: 'nodeTexture0',
		material,
	} ], {
		resolveTextureBinding: ( receivedArtifact, groupName, bindingName, receivedMaterial ) => {

			call = { receivedArtifact, groupName, bindingName, receivedMaterial };
			return textureB;

		},
	} );

	assert.equal( rebinder.getUpdateBeforeType(), 'render' );
	assert.equal( rebinder.updateReference(), rebinder );

	rebinder.updateBefore( {
		renderer: {
			backend: {
				get: ( texture ) => ( { texture: { label: texture.uuid } } ),
			},
		},
	} );

	assert.deepEqual( call, {
		receivedArtifact: artifact,
		groupName: 'render',
		bindingName: 'nodeTexture0',
		receivedMaterial: material,
	} );
	assert.equal( binding.texture, textureB );
	assert.equal( binding.groupNode.version, 1 );
	assert.equal( binding.version, -1 );
	assert.equal( binding.generation, null );

} );

test( 'artifact texture rebinder passes the current render-target texture as an avoid hint', () => {

	const textureA = { uuid: 'a', version: 1 };
	const textureB = { uuid: 'b', version: 1 };
	const avoidTexture = { uuid: 'avoid' };
	const binding = createBinding( textureA );
	let optionsSeen = null;
	const rebinder = createArtifactTextureRebinder( [ {
		binding,
		artifact: {},
		groupName: 'render',
		bindingName: 'nodeTexture0',
		material: {},
	} ], {
		resolveTextureBinding: ( artifact, groupName, bindingName, material, options ) => {

			optionsSeen = options;
			return textureB;

		},
	} );

	const frame = {
		renderer: {
			getRenderTarget: () => ( { texture: avoidTexture } ),
			backend: {
				get: ( texture ) => ( { texture: { label: texture.uuid } } ),
			},
		},
	};
	rebinder.updateBefore( frame );

	assert.deepEqual( optionsSeen, { avoidTexture, frame } );
	assert.equal( binding.texture, textureB );

} );

test( 'artifact texture rebinder invalidates when the backend GPU texture changes after first observation', () => {

	const texture = { uuid: 'a', version: 1 };
	const binding = createBinding( texture );
	let gpuTexture = { label: 'gpu-a' };
	const rebinder = createArtifactTextureRebinder( [ {
		binding,
		artifact: {},
		groupName: 'render',
		bindingName: 'nodeTexture0',
		material: {},
	} ], {
		resolveTextureBinding: () => null,
	} );
	const frame = {
		renderer: {
			backend: {
				get: () => ( { texture: gpuTexture } ),
			},
		},
	};

	rebinder.updateBefore( frame );
	assert.equal( binding.groupNode.version, 0 );

	rebinder.updateBefore( frame );
	assert.equal( binding.groupNode.version, 0 );

	gpuTexture = { label: 'gpu-b' };
	rebinder.updateBefore( frame );
	assert.equal( binding.groupNode.version, 1 );
	assert.equal( binding.version, -1 );
	assert.equal( binding.generation, null );

} );
