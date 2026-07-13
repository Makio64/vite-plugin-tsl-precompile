import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installMockWebGPU, createMockGPUCanvasContext } from '../../src/mock-webgpu.js';
import { compileTSL } from '../../src/vendor/compileTSL.js';

let initialized = false;

function ensureWebGPU() {

	if ( initialized ) return;
	installMockWebGPU();
	initialized = true;

}

function makeFakeCanvas( width = 256, height = 256 ) {

	let gpuContext = null;
	return {
		width,
		height,
		clientWidth: width,
		clientHeight: height,
		style: {},
		getContext: ( kind ) => {

			if ( kind === 'webgpu' ) {

				if ( ! gpuContext ) gpuContext = createMockGPUCanvasContext();
				return gpuContext;

			}
			return null;

		},
		addEventListener: () => {},
		removeEventListener: () => {},
		getBoundingClientRect: () => ( { left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 } ),
	};

}

function artifactTextureSources( artifact ) {

	const out = [];
	for ( const group of artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			if ( entry && entry.source && entry.source.kind === 'artifact.texture' ) out.push( entry.source );

		}

	}
	return out;

}

test( 'compileTSL: shadow-depth aux artifacts retain custom shadow variants', async () => {

	ensureWebGPU();
	const webgpu = await import( 'three/webgpu' );
	const core = await import( 'three' );
	const tsl = await import( 'three/tsl' );

	const renderer = new webgpu.WebGPURenderer( { canvas: makeFakeCanvas(), antialias: false } );
	await renderer.init();
	try {

		renderer.shadowMap.enabled = true;
		renderer.shadowMap.transmitted = true;

		const scene = new core.Scene();
		const camera = new core.PerspectiveCamera( 45, 1, 0.1, 100 );
		camera.position.set( 0, 3, 6 );
		camera.lookAt( 0, 0, 0 );

		const light = new core.DirectionalLight( 0xffffff, 2 );
		light.castShadow = true;
		light.position.set( 4, 6, 3 );
		scene.add( light );

		const textureData = new Uint8Array( [ 255, 128, 64, 255 ] );
		const causticMap = new core.DataTexture( textureData, 1, 1 );
		causticMap.needsUpdate = true;

		const customMaterial = new webgpu.MeshStandardNodeMaterial();
		customMaterial.castShadowNode = tsl.texture( causticMap, tsl.uv() ).rgb;
		customMaterial.castShadowPositionNode = tsl.positionLocal.add( tsl.vec3( 0.05, 0, 0 ) );

		const customCaster = new core.Mesh( new core.BoxGeometry( 1, 1, 1 ), customMaterial );
		customCaster.castShadow = true;
		customCaster.position.x = - 0.75;
		scene.add( customCaster );

		const plainCaster = new core.Mesh( new core.BoxGeometry( 1, 1, 1 ), new webgpu.MeshStandardNodeMaterial() );
		plainCaster.castShadow = true;
		plainCaster.position.x = 0.75;
		scene.add( plainCaster );

		const receiver = new core.Mesh( new core.PlaneGeometry( 6, 6 ), new webgpu.MeshStandardNodeMaterial() );
		receiver.rotation.x = - Math.PI / 2;
		receiver.position.y = - 1;
		receiver.receiveShadow = true;
		scene.add( receiver );

		const artifacts = await compileTSL( renderer, scene, camera, { noGlobalMRT: true } );
		const shadowArtifacts = artifacts.filter( ( artifact ) => artifact.materialShape === 'shadow-depth' );
		const family = shadowArtifacts.find( ( artifact ) => artifact.variants && Object.keys( artifact.variants ).length > 1 );
		assert.ok( family, `expected a shadow-depth variant family; saw ${ shadowArtifacts.length } shadow artifact(s)` );

		const variants = Object.values( family.variants );
		assert.ok( variants.every( ( variant ) => Array.isArray( variant.renderContextSelectors ) && variant.renderContextSelectors.length > 0 ), 'expected every shadow variant to carry one or more semantic render-context selectors' );
		const customVariant = variants.find( ( variant ) => String( variant.fragmentShader || '' ).includes( 'texture' ) );
		assert.ok( customVariant, 'expected a custom shadow variant that samples the castShadowNode texture' );
		assert.ok( artifactTextureSources( customVariant ).length > 0, 'expected custom shadow variant to carry its texture binding source' );

	} finally {

		if ( typeof renderer.dispose === 'function' ) renderer.dispose();

	}

} );
