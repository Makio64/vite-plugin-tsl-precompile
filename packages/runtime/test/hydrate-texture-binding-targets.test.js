import test from 'node:test';
import assert from 'node:assert/strict';

import {
	invalidateOnTextureResourceChange,
	invalidateTextureBindingTarget,
	rebindTextureBindingTargets,
	textureBindingResourceSignature,
	textureBindingTargets,
} from '../src/hydrate/rebinders/texture-binding-targets.js';

function createBinding( texture ) {

	return {
		texture,
		groupNode: { version: 0 },
		version: 3,
		generation: 5,
	};

}

test( 'texture binding targets include clone-tracked source bindings once', () => {

	const texture = { uuid: 'a' };
	const source = createBinding( texture );
	const clone = createBinding( texture );
	Object.defineProperty( source, '__tslpRebindClones', {
		value: new Set( [ clone, clone, null ] ),
	} );
	Object.defineProperty( clone, '__tslpRebindSource', {
		value: source,
	} );

	assert.deepEqual( textureBindingTargets( clone ), [ source, clone ] );

} );

test( 'texture binding targets rebind clones and invalidate changed targets', () => {

	const textureA = { uuid: 'a' };
	const textureB = { uuid: 'b' };
	const source = createBinding( textureA );
	const clone = createBinding( textureA );
	Object.defineProperty( source, '__tslpRebindClones', {
		value: new Set( [ clone ] ),
	} );

	assert.equal( rebindTextureBindingTargets( source, textureB ), true );
	assert.equal( source.texture, textureB );
	assert.equal( clone.texture, textureB );
	assert.equal( source.groupNode.version, 1 );
	assert.equal( clone.groupNode.version, 1 );
	assert.equal( source.version, -1 );
	assert.equal( clone.version, -1 );
	assert.equal( source.generation, null );
	assert.equal( clone.generation, null );

	assert.equal( rebindTextureBindingTargets( source, textureB ), false );

} );

test( 'texture binding target invalidation can be called directly', () => {

	const target = createBinding( { uuid: 'a' } );

	invalidateTextureBindingTarget( target );

	assert.equal( target.groupNode.version, 1 );
	assert.equal( target.version, -1 );
	assert.equal( target.generation, null );

} );

test( 'texture binding resource signatures track texture, gpu texture, and version', () => {

	const texture = { uuid: 'a', version: 4 };
	const gpuTexture = { label: 'gpu-a' };
	const target = createBinding( texture );
	const renderer = {
		backend: {
			get: ( receivedTexture ) => {

				assert.equal( receivedTexture, texture );
				return { texture: gpuTexture };

			},
		},
	};

	assert.deepEqual(
		textureBindingResourceSignature( target, renderer ),
		{ texture, gpuTexture, version: 4 }
	);

} );

test( 'texture binding resource tracking invalidates after the first observed change', () => {

	const texture = { uuid: 'a', version: 1 };
	const target = createBinding( texture );
	let gpuTexture = { label: 'gpu-a' };
	const renderer = {
		backend: {
			get: () => ( { texture: gpuTexture } ),
		},
	};
	const lastSeen = new WeakMap();

	invalidateOnTextureResourceChange( target, renderer, lastSeen );
	assert.equal( target.groupNode.version, 0 );

	invalidateOnTextureResourceChange( target, renderer, lastSeen );
	assert.equal( target.groupNode.version, 0 );

	texture.version = 2;
	invalidateOnTextureResourceChange( target, renderer, lastSeen );
	assert.equal( target.groupNode.version, 1 );
	assert.equal( target.version, -1 );
	assert.equal( target.generation, null );

	gpuTexture = { label: 'gpu-b' };
	invalidateOnTextureResourceChange( target, renderer, lastSeen );
	assert.equal( target.groupNode.version, 2 );

} );
