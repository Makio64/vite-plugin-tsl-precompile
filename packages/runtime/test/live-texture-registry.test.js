import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
	clearLiveTextureIndex,
	installLiveTextureRegistryPatches,
	lookupLiveTextureByIdentity,
	registerLiveTexture,
} from '../src/hydrate/live-texture-registry.js';
import { __resetForTests, installPrecompileMarker } from '../src/precompile-marker.js';

function fakeTextureNamespace() {

	class FakeStorageTexture {}
	class FakeStorage3DTexture {}
	class FakeStorageArrayTexture {}
	class FakeDataTexture {}
	class FakeData3DTexture {}
	class FakeDataArrayTexture {}

	return {
		StorageTexture: FakeStorageTexture,
		Storage3DTexture: FakeStorage3DTexture,
		StorageArrayTexture: FakeStorageArrayTexture,
		DataTexture: FakeDataTexture,
		Data3DTexture: FakeData3DTexture,
		DataArrayTexture: FakeDataArrayTexture,
	};

}

test( 'live texture registry patches an explicitly injected Three namespace', () => {

	const namespace = fakeTextureNamespace();
	installLiveTextureRegistryPatches( namespace );

	for ( const key of [ 'StorageTexture', 'Storage3DTexture', 'StorageArrayTexture' ] ) {

		assert.equal( namespace[ key ].prototype.__tslpNamePatched, true, `${ key } name hook` );

	}
	for ( const key of [ 'DataTexture', 'Data3DTexture', 'DataArrayTexture' ] ) {

		assert.equal( namespace[ key ].prototype.__tslpDataTextureRegPatched, true, `${ key } update hook` );

	}

	// A second namespace can be injected after the runtime-owned constructors
	// were installed; this is how a lazily loaded full-renderer module joins a
	// slim scene support instance.
	const secondNamespace = fakeTextureNamespace();
	installLiveTextureRegistryPatches( secondNamespace );
	assert.equal( secondNamespace.StorageTexture.prototype.__tslpNamePatched, true );
	assert.equal( secondNamespace.DataTexture.prototype.__tslpDataTextureRegPatched, true );

} );

test( 'full-runtime marker patches the exact Three namespace supplied by the app', () => {

	const namespace = fakeTextureNamespace();
	namespace.Material = class Material {};
	try {

		installPrecompileMarker( namespace );
		assert.equal( namespace.Storage3DTexture.prototype.__tslpNamePatched, true );
		assert.equal( namespace.DataArrayTexture.prototype.__tslpDataTextureRegPatched, true );

	} finally {

		__resetForTests();

	}

} );

test( 'live texture registry does not dynamically import the bare Three barrel', async () => {

	const source = await readFile( new URL( '../src/hydrate/live-texture-registry.js', import.meta.url ), 'utf8' );
	assert.doesNotMatch( source, /import\s*\(\s*['"]three['"]\s*\)/ );

} );

test( 'live texture registry aliases same-origin absolute URLs by exact path without basename collisions', () => {

	const locationDescriptor = Object.getOwnPropertyDescriptor( globalThis, 'location' );
	Object.defineProperty( globalThis, 'location', {
		value: { href: 'http://localhost:5210/examples/ocean/' },
		configurable: true,
	} );
	try {

		clearLiveTextureIndex();
		const first = {
			isTexture: true,
			uuid: 'first',
			name: 'shared.png',
			image: { src: 'http://localhost:5210/textures/first/shared.png' },
		};
		const second = {
			isTexture: true,
			uuid: 'second',
			name: 'shared.png',
			image: { src: 'http://localhost:5210/textures/second/shared.png' },
		};
		registerLiveTexture( first );
		registerLiveTexture( second );

		assert.equal( lookupLiveTextureByIdentity( {
			imageSrc: '/textures/first/shared.png',
			textureName: 'shared.png',
		} ), first );
		assert.equal( lookupLiveTextureByIdentity( {
			imageSrc: '/textures/second/shared.png',
			textureName: 'shared.png',
		} ), second );
		assert.equal( lookupLiveTextureByIdentity( {
			imageSrc: '/textures/missing/shared.png',
			textureName: 'shared.png',
		} ), null, 'a failed exact path match cannot fall through to a different same-basename URL' );

	} finally {

		clearLiveTextureIndex();
		if ( locationDescriptor ) Object.defineProperty( globalThis, 'location', locationDescriptor );
		else delete globalThis.location;

	}

} );
