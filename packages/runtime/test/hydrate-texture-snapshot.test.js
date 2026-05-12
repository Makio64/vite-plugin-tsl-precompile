import test from 'node:test';
import assert from 'node:assert/strict';

import { LinearMipmapLinearFilter, NearestFilter } from 'three';

import { isTrivialSnapshot, textureFromSnapshot } from '../src/hydrate/texture-snapshot.js';

test( 'texture snapshot hydrator classifies trivial snapshots', () => {

	assert.equal( isTrivialSnapshot( { data: [ 0, 0, 0, 0 ] } ), true );
	assert.equal( isTrivialSnapshot( { data: [ 0, 1, 0, 2 ] } ), false );
	assert.equal( isTrivialSnapshot( { data: new Uint8Array( [ 0, 0, 0, 0 ] ) } ), false );

} );

test( 'texture snapshot hydrator infers and caches array texture snapshots', () => {

	const artifact = {
		fragmentShader: 'var nodeTexture0: texture_2d_array<f32>;',
	};
	const snapshot = {
		width: 1,
		height: 1,
		data: [
			255, 0, 0, 255,
			0, 255, 0, 255,
		],
		arrayType: 'Uint8Array',
	};

	const texture = textureFromSnapshot( artifact, 'array-snapshot', snapshot, 'nodeTexture0' );
	const cached = textureFromSnapshot( artifact, 'array-snapshot', snapshot, 'nodeTexture0' );

	assert.equal( texture.isDataArrayTexture, true );
	assert.equal( texture.image.depth, 2 );
	assert.equal( cached, texture );
	assert.equal( Object.prototype.propertyIsEnumerable.call( artifact, '_textureSnapshotCache' ), false );

} );

test( 'texture snapshot hydrator disables generated mipmaps when the captured filter needs them', () => {

	const artifact = {
		fragmentShader: 'var nodeTexture0: texture_2d<f32>;',
	};
	const texture = textureFromSnapshot( artifact, 'mip-snapshot', {
		width: 1,
		height: 1,
		data: [ 255, 255, 255, 255 ],
		magFilter: NearestFilter,
		minFilter: LinearMipmapLinearFilter,
	}, 'nodeTexture0' );

	assert.equal( texture.minFilter, NearestFilter );
	assert.equal( texture.generateMipmaps, false );

} );

test( 'texture snapshot hydrator delegates invalid snapshots to injected fallbacks', () => {

	const artifact = {};
	const bindingFallback = { id: 'binding-fallback' };
	const globalFallback = { id: 'global-fallback' };

	assert.equal(
		textureFromSnapshot( artifact, 'invalid', { width: 1 }, 'nodeTexture0', null, {
			fallbackTextureForBinding() {

				return bindingFallback;

			},
			fallbackTexture: globalFallback,
		} ),
		bindingFallback
	);
	assert.equal(
		textureFromSnapshot( null, 'invalid', null, null, null, {
			fallbackTexture: globalFallback,
		} ),
		globalFallback
	);

} );
