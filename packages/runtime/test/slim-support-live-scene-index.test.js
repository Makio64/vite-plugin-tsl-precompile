import test from 'node:test';
import assert from 'node:assert/strict';

import {
	collectMaterialNodeTextures,
	createLiveSceneIndex,
	healTextureImage,
	textureImageReady,
	textureImageSrc,
} from '../src/slim-support/live-scene-index.js';

function texture( extra = {} ) {

	return { isTexture: true, uuid: extra.uuid || Math.random().toString( 36 ).slice( 2 ), image: { width: 4, height: 4 }, ...extra };

}

test( 'live-scene-index registers scene, light, material, and node textures', () => {

	const registered = [];
	const materialMap = texture( { uuid: 'map-uuid', name: 'albedo', image: { src: 'https://cdn.test/textures/albedo.png', width: 32, height: 32 } } );
	const lightMap = texture( { uuid: 'light-uuid', name: 'spot-cookie' } );
	const nodeTexture = texture( { uuid: 'node-uuid', name: 'node-map' } );
	const sceneTexture = texture( { uuid: 'scene-uuid', name: 'studio.hdr' } );
	const material = {
		map: materialMap,
		colorNode: {
			isNode: true,
			value: nodeTexture,
		},
	};
	const scene = {
		background: sceneTexture,
		traverse( visit ) {

			visit( { isLight: true, map: lightMap } );
			visit( { material } );

		},
	};
	const index = createLiveSceneIndex( {
		registerLiveTexture: ( tex ) => registered.push( tex.uuid ),
	} );

	index.indexScene( scene );

	assert.equal( index.texturesByUuid.get( 'map-uuid' ), materialMap );
	assert.equal( index.texturesByName.get( 'albedo' ), materialMap );
	assert.equal( index.texturesByName.get( 'albedo.png' ), materialMap );
	assert.equal( index.texturesByUuid.get( 'light-uuid' ), lightMap );
	assert.equal( index.texturesByUuid.get( 'node-uuid' ), nodeTexture );
	assert.equal( index.texturesByUuid.get( 'scene-uuid' ), sceneTexture );
	assert.ok( registered.includes( 'map-uuid' ) );
	assert.ok( ! index.materialTextures.includes( sceneTexture ), 'environment-looking HDR textures stay out of material fallbacks' );

} );

test( 'live-scene-index heals null texture images with diagnostics', () => {

	const diagnostics = { healedNullTextureImages: 0 };
	const tex = texture( { image: null } );

	assert.equal( textureImageReady( tex ), false );
	assert.equal( healTextureImage( tex, diagnostics ), true );
	assert.equal( textureImageReady( tex ), true );
	assert.equal( diagnostics.healedNullTextureImages, 1 );

} );

test( 'collectMaterialNodeTextures walks nested node objects', () => {

	const tex = texture( { uuid: 'nested-uuid' } );
	const material = {
		colorNode: {
			isNode: true,
			child: {
				isNode: true,
				value: tex,
			},
		},
	};

	assert.deepEqual( collectMaterialNodeTextures( material ), [ tex ] );
	assert.equal( textureImageSrc( texture( { image: { currentSrc: 'https://cdn.test/a.webp', width: 4, height: 4 } } ) ), 'https://cdn.test/a.webp' );

} );
