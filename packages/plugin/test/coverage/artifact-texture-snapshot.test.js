import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateForMaterial, assertNoUnknownKinds } from './_helpers.js';

test( 'artifact.texture sources carry bounded static DataTexture snapshots', async () => {

	const result = await generateForMaterial( ( { webgpu, tsl } ) => {

		const texture = new webgpu.DataTexture( new Uint8Array( [ 255, 0, 0, 255, 0, 255, 0, 255 ] ), 2, 1 );
		texture.needsUpdate = true;
		const material = new webgpu.MeshBasicNodeMaterial();
		material.colorNode = tsl.texture( texture, tsl.uv() ).rgb;
		return { material, name: 'coverage-artifact-texture-snapshot' };

	} );

	assert.deepEqual( assertNoUnknownKinds( result, 'artifact-texture-snapshot' ), [] );
	const textureEntry = result.artifact.uniformPlan
		.flatMap( ( group ) => group.textures || [] )
		.find( ( entry ) => entry.source && entry.source.kind === 'artifact.texture' );
	assert.ok( textureEntry, 'expected artifact.texture binding' );
	assert.equal( textureEntry.source.imageWidth, 2 );
	assert.equal( textureEntry.source.imageHeight, 1 );
	assert.equal( textureEntry.source.snapshot.width, 2 );
	assert.equal( textureEntry.source.snapshot.height, 1 );
	assert.deepEqual( textureEntry.source.snapshot.data.slice( 0, 8 ), [ 255, 0, 0, 255, 0, 255, 0, 255 ] );

} );
