import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockWebGPU, createMockGPUCanvasContext } from '../../src/mock-webgpu.js';
import { extractArtifact } from '../../src/vendor/compileTSL.js';
import { beginRenderObjectHarvest } from '../../src/vendor/render-object-observer.js';

installMockWebGPU();

test( 'a real render exposes a directly harvestable material artifact', async () => {

	const THREE = await import( 'three/webgpu' );
	const renderer = new THREE.WebGPURenderer( { canvas: makeFakeCanvas(), antialias: false } );
	await renderer.init();
	renderer.shadowMap.enabled = true;

	const material = new THREE.MeshStandardNodeMaterial();
	const mesh = new THREE.Mesh( new THREE.BoxGeometry(), material );
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	const scene = new THREE.Scene();
	scene.fog = new THREE.Fog( 0x000000, 1, 10 );
	scene.add( mesh );
	const light = new THREE.DirectionalLight( 0xffffff, 2 );
	light.name = 'harvest-key-light';
	light.userData.tslPrecompileId = 'harvest:key';
	light.castShadow = true;
	light.position.set( 2, 3, 4 );
	scene.add( light );
	scene.add( light.target );
	const camera = new THREE.PerspectiveCamera( 45, 1, 0.1, 100 );
	camera.position.z = 3;

	const session = beginRenderObjectHarvest( renderer );
	renderer.render( scene, camera );
	const harvest = await session.finish();

	const family = harvest.familiesByMaterial.get( material );
	assert.ok( family, 'the visible material flowed through the direct render-object harvest' );
	assert.equal( family.complete, true );
	const variant = family.variants.find( ( candidate ) => candidate.objects.includes( mesh ) );
	assert.ok( variant );
	const artifact = extractArtifact( variant.cacheKey, variant.nodeBuilderState, material, mesh );
	const kinds = new Set( artifact.uniformPlan.flatMap( ( group ) => [
		...( group.slots || [] ),
		...( group.textures || [] ),
	] ).map( ( entry ) => entry.source && entry.source.kind ).filter( Boolean ) );

	assert.ok( artifact.vertexShader.length > 0 );
	assert.ok( artifact.fragmentShader.length > 0 );
	assert.ok( kinds.has( 'light.colorScaled' ) );
	assert.ok( kinds.has( 'light.shadowMatrix' ) );
	assert.ok( kinds.has( 'depth.texture' ) );
	assert.ok( kinds.has( 'scene.fog.color' ) );
	const lightIdentity = artifact.lightIdentities.find( ( identity ) => identity.explicitKey === 'harvest:key' );
	assert.ok( lightIdentity, 'directly harvested plans aggregate the live light identity sidecar' );
	assert.equal( lightIdentity.name, 'harvest-key-light' );
	assert.deepEqual( lightIdentity.snapshot.position, [ 2, 3, 4 ] );
	for ( const group of artifact.uniformPlan ) for ( const entry of [ ...( group.slots || [] ), ...( group.textures || [] ) ] ) {

		if ( entry.source && ( entry.source.kind.startsWith( 'light.' ) || entry.source.kind === 'depth.texture' ) ) assert.equal(
			artifact.lightIdentities[ entry.source.lightIdentity ],
			lightIdentity,
		);

	}

	renderer.dispose();

} );

function makeFakeCanvas( width = 64, height = 64 ) {

	let context = null;
	return {
		width,
		height,
		clientWidth: width,
		clientHeight: height,
		style: {},
		getContext( kind ) {

			if ( kind !== 'webgpu' ) return null;
			context ||= createMockGPUCanvasContext();
			return context;

		},
		addEventListener() {},
		removeEventListener() {},
		getBoundingClientRect: () => ( { left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 } ),
	};

}
