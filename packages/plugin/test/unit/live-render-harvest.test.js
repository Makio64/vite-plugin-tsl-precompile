import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockWebGPU, createMockGPUCanvasContext } from '../../src/mock-webgpu.js';
import { compileTSL, extractArtifact } from '../../src/vendor/compileTSL.js';
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

test( 'a real r185 VSM render preserves exact WGSL and captures a live internal-pass contract', async () => {

	const THREE = await import( 'three/webgpu' );
	const renderer = new THREE.WebGPURenderer( { canvas: makeFakeCanvas(), antialias: false } );
	await renderer.init();
	try {

		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.VSMShadowMap;

		const material = new THREE.MeshStandardNodeMaterial();
		const mesh = new THREE.Mesh( new THREE.BoxGeometry(), material );
		mesh.castShadow = true;
		mesh.receiveShadow = true;

		const light = new THREE.DirectionalLight( 0xffffff, 2 );
		light.name = 'vsm-harvest-light';
		light.userData.tslPrecompileId = 'vsm:harvest';
		light.castShadow = true;
		light.shadow.blurSamples = 7;
		light.shadow.radius = 3;
		light.shadow.mapSize.set( 32, 32 );

		const scene = new THREE.Scene();
		scene.add( mesh, light, light.target );
		const camera = new THREE.PerspectiveCamera( 45, 1, 0.1, 100 );
		camera.position.z = 3;

		const session = beginRenderObjectHarvest( renderer );
		renderer.render( scene, camera );
		renderer.render( scene, camera );
		const harvest = await session.finish();
		const vsmFamilies = [ ...new Set( harvest.familiesByMaterial.values() ) ]
			.filter( ( family ) => family && ( family.material.name === 'VSMVertical' || family.material.name === 'VSMHorizontal' ) );
		assert.equal( vsmFamilies.length, 2, 'the real render must harvest both private VSM passes' );
		assert.ok( vsmFamilies.every( ( family ) => family.complete === true ) );

		const artifacts = await compileTSL( renderer, scene, camera, {
			noGlobalMRT: true,
			renderObjectHarvest: harvest,
			skipWarmupRender: true,
		} );
		const expectedShapes = new Map( [
			[ 'VSMVertical', 'shadow-vsm-vertical' ],
			[ 'VSMHorizontal', 'shadow-vsm-horizontal' ],
		] );
		const expectedUniformKinds = [
			'light.shadowBlurSamples',
			'light.shadowMapSize',
			'light.shadowRadius',
		];

		for ( const family of vsmFamilies ) {

			const variant = family.variants[ 0 ];
			const shape = expectedShapes.get( family.material.name );
			const artifact = artifacts.find( ( candidate ) =>
				candidate.materialUuid === family.material.uuid
				&& candidate.cacheKey === variant.cacheKey
			);
			assert.ok( artifact, `compileTSL must retain ${ family.material.name } as a flat artifact` );
			assert.equal( artifact.materialShape, shape );
			assert.equal(
				artifact.vertexShader,
				variant.nodeBuilderState.vertexShader,
				`${ family.material.name } vertex WGSL must remain byte-exact`,
			);
			assert.equal(
				artifact.fragmentShader,
				variant.nodeBuilderState.fragmentShader,
				`${ family.material.name } fragment WGSL must remain byte-exact`,
			);

			const shadowSlots = artifact.uniformPlan
				.flatMap( ( group ) => group.slots || [] )
				.filter( ( slot ) => slot.source && expectedUniformKinds.includes( slot.source.kind ) );
			assert.deepEqual(
				shadowSlots.map( ( slot ) => slot.source.kind ).sort(),
				expectedUniformKinds,
				`${ family.material.name } must bind every VSM scalar to the live LightShadow`,
			);
			for ( const slot of shadowSlots ) {

				assert.equal( slot.source.lightUuid, light.uuid );
				assert.equal(
					artifact.lightIdentities[ slot.source.lightIdentity ].captureUuid,
					light.uuid,
				);
				assert.notEqual( slot.source.kind, 'uniform.live' );

			}

			assert.equal( artifact.internalPass.schema, 'internal-pass@1' );
			assert.equal( artifact.internalPass.family, 'shadow-vsm' );
			assert.equal( artifact.internalPass.shape, shape );
			assert.equal(
				artifact.internalPass.stage,
				family.material.name === 'VSMVertical' ? 'vertical' : 'horizontal',
			);
			assert.deepEqual(
				artifact.internalPass.uniforms.map( ( uniform ) => uniform.role ).sort(),
				[ 'blur-samples', 'map-size', 'radius' ],
			);
			assert.ok( artifact.internalPass.uniforms.every( ( uniform ) => uniform.group === 'render' ) );
			assert.equal( artifact.internalPass.inputs.length, 1 );
			assert.equal( artifact.internalPass.inputs[ 0 ].kind, 'texture' );
			assert.equal( artifact.internalPass.inputs[ 0 ].group, 'object' );
			assert.equal( artifact.internalPass.inputs[ 0 ].binding, 'nodeUniform1' );
			assert.equal( artifact.internalPass.inputs[ 0 ].topology.dimension, '2d' );
			assert.equal( artifact.internalPass.output.topology.dimension, '2d' );
			assert.equal( artifact.internalPass.output.topology.format, THREE.RGFormat );
			assert.equal( artifact.internalPass.output.topology.type, THREE.HalfFloatType );
			assert.equal( artifact.internalPass.output.topology.depth, false );

		}

		const horizontal = artifacts.find( ( artifact ) => artifact.materialShape === 'shadow-vsm-horizontal' );
		const horizontalInput = horizontal.internalPass.inputs[ 0 ];
		assert.equal( horizontalInput.role, 'vsm-vertical' );
		assert.equal( horizontalInput.topology.format, THREE.RGFormat );
		assert.equal( horizontalInput.topology.type, THREE.HalfFloatType );
		const horizontalTexture = horizontal.uniformPlan
			.find( ( group ) => group.name === horizontalInput.group )
			.textures.find( ( texture ) => texture.name === horizontalInput.binding );
		assert.equal( horizontalTexture.source.kind, 'artifact.texture' );
		assert.equal( typeof horizontalTexture.source.textureUuid, 'string',
			'the process-local texture sidecar may retain its capture identity' );
		assert.equal(
			JSON.stringify( horizontal.internalPass ).includes( horizontalTexture.source.textureUuid ),
			false,
			'the durable pass schedule must address the vertical moments by role, never by temporary UUID',
		);

		const vertical = artifacts.find( ( artifact ) => artifact.materialShape === 'shadow-vsm-vertical' );
		assert.equal( vertical.internalPass.inputs[ 0 ].role, 'shadow-depth' );
		const verticalDepth = vertical.uniformPlan
			.find( ( group ) => group.name === vertical.internalPass.inputs[ 0 ].group )
			.textures.find( ( texture ) => texture.name === vertical.internalPass.inputs[ 0 ].binding );
		assert.equal( verticalDepth.source.kind, 'depth.texture' );
		assert.equal( verticalDepth.source.lightUuid, light.uuid );

	} finally {

		renderer.dispose();

	}

} );

test( 'a real r185 QuadMesh harvest keeps array and 3D layer siblings in one shader family', async () => {

	const THREE = await import( 'three/webgpu' );
	const { vec4 } = await import( 'three/tsl' );
	const renderer = new THREE.WebGPURenderer( { canvas: makeFakeCanvas(), antialias: false } );
	await renderer.init();

	const material = new THREE.NodeMaterial();
	material.outputNode = vec4( 1, 0, 0, 1 );
	const quad = new THREE.QuadMesh( material );
	const arrayTarget = new THREE.RenderTarget( 16, 16, {
		depth: 2,
		depthBuffer: false,
	} );
	const target3D = new THREE.RenderTarget3D( 16, 16, 2, {
		depthBuffer: false,
	} );

	try {

		const session = beginRenderObjectHarvest( renderer );
		for ( const target of [ arrayTarget, target3D ] ) {

			for ( const layer of [ 0, 1 ] ) {

				renderer.setRenderTarget( target, layer );
				quad.render( renderer );

			}

		}
		renderer.setRenderTarget( null );
		const harvest = await session.finish();
		const family = harvest.familiesByMaterial.get( material );

		assert.ok( family );
		assert.equal( family.complete, true );
		assert.equal( family.variants.length, 1, 'r185 reuses one NodeBuilderState across attachment layers and target kinds' );
		const variant = family.variants[ 0 ];
		assert.equal( variant.requestCount, 4 );
		assert.equal( variant.renderContextSelectors.length, 4, 'raw capture retains both target kinds and both layer views' );
		const topologies = variant.renderContextSelectors.map( ( selector ) => JSON.parse( selector ).target );
		assert.deepEqual( new Set( topologies.map( ( target ) => target.surface ) ), new Set( [ 'offscreen-array', 'offscreen-3d' ] ) );
		for ( const surface of [ 'offscreen-array', 'offscreen-3d' ] ) {

			assert.deepEqual(
				topologies.filter( ( target ) => target.surface === surface ).map( ( target ) => target.activeCubeFace ).sort(),
				[ 0, 1 ],
			);

		}
		assert.ok( topologies.every( ( target ) => target.depth === false ) );

	} finally {

		arrayTarget.dispose();
		target3D.dispose();
		renderer.dispose();

	}

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
