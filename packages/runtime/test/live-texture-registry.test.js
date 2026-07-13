import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { installLiveTextureRegistryPatches } from '../src/hydrate/live-texture-registry.js';
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
