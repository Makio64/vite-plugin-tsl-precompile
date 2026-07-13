import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRenderContextSignature, describeRenderContext } from '@tsl-precompile/contract/render-context';

test( 'render-context signature ignores identities and live scalar values', () => {

	const a = fixture();
	const b = fixture();
	b.light.uuid = 'another-random-uuid';
	b.light.intensity = 99;
	b.light.color = { r: 0, g: 1, b: 0 };
	b.object.position = { x: 100, y: 200, z: 300 };
	b.camera.projectionMatrix = { elements: Array( 16 ).fill( 9 ) };
	b.renderer.pixelRatio = 3;

	assert.equal( createRenderContextSignature( a ), createRenderContextSignature( b ) );

} );

test( 'render-context signature covers light/shadow, object, geometry, clipping, and MRT topology', () => {

	const base = fixture();
	const signature = createRenderContextSignature( base );

	const shadowed = fixture();
	shadowed.light.castShadow = true;
	assert.notEqual( signature, createRenderContextSignature( shadowed ) );

	const skinned = fixture();
	skinned.object.isSkinnedMesh = true;
	assert.notEqual( signature, createRenderContextSignature( skinned ) );

	const vertexColor = fixture();
	vertexColor.object.geometry.attributes.color = { itemSize: 3, array: new Uint8Array( 12 ), normalized: true };
	assert.notEqual( signature, createRenderContextSignature( vertexColor ) );

	const clipped = fixture();
	clipped.material.clippingPlanes.push( { normal: { x: 1, y: 0, z: 0 }, constant: 20 } );
	assert.notEqual( signature, createRenderContextSignature( clipped ) );

	const changedMrt = fixture();
	changedMrt.mrt.outputNodes.normal = { isNode: true, isConstNode: true, value: 1 };
	assert.notEqual( signature, createRenderContextSignature( changedMrt ) );

} );

test( 'render-context signature signs enabled renderer high precision only', () => {

	const base = fixture();
	const signature = createRenderContextSignature( base );
	base.renderer.highPrecision = false;
	assert.equal( createRenderContextSignature( base ), signature );
	base.renderer.highPrecision = true;
	assert.notEqual( createRenderContextSignature( base ), signature );

} );

test( 'render-context descriptor is JSON-safe and deterministic', () => {

	const descriptor = describeRenderContext( fixture() );
	assert.doesNotThrow( () => JSON.stringify( descriptor ) );
	assert.match( descriptor.version, /^render-context@0\.1\.0$/ );
	assert.deepEqual( descriptor.scene.lights.map( ( light ) => light.type ), [ 'DirectionalLight' ] );

} );

function fixture() {

	const light = {
		isLight: true,
		type: 'DirectionalLight',
		uuid: crypto.randomUUID(),
		visible: true,
		castShadow: false,
		intensity: Math.random(),
		layers: { mask: 1 },
		shadow: { type: 'DirectionalLightShadow', camera: { type: 'OrthographicCamera' }, map: null },
	};
	const scene = {
		type: 'Scene',
		fog: { type: 'FogExp2', isFogExp2: true, density: Math.random() },
		environment: { isTexture: true, type: 1009, format: 1023, uuid: crypto.randomUUID() },
		children: [ light ],
		traverse( callback ) {

			callback( this );
			for ( const child of this.children ) callback( child );

		},
	};
	const camera = {
		type: 'PerspectiveCamera',
		isPerspectiveCamera: true,
		layers: { mask: 1 },
		projectionMatrix: { elements: Array( 16 ).fill( Math.random() ) },
	};
	const material = { clippingPlanes: [], clipIntersection: false, clipShadows: false };
	const object = {
		type: 'Mesh',
		material,
		visible: true,
		castShadow: false,
		receiveShadow: true,
		geometry: {
			type: 'BufferGeometry',
			attributes: { position: { itemSize: 3, array: new Float32Array( 9 ), normalized: false } },
			morphAttributes: {},
			morphTargetsRelative: false,
		},
	};
	const renderer = {
		type: 'WebGPURenderer',
		depth: true,
		outputColorSpace: 'srgb',
		toneMapping: 4,
		pixelRatio: Math.random(),
		shadowMap: { enabled: true, type: 1 },
	};
	const mrt = {
		isNode: true,
		isMRTNode: true,
		outputNodes: { color: { isNode: true, isConstNode: true, value: 0 } },
	};
	return { renderer, scene, camera, object, material, mrt, light };

}
