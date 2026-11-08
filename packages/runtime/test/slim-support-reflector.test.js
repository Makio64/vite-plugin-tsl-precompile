import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera } from 'three/src/cameras/PerspectiveCamera.js';
import { Scene } from 'three/src/scenes/Scene.js';
import { HalfFloatType, WebGPUCoordinateSystem } from 'three/src/constants.js';
import { reflector } from '../src/slim-stubs.js';
import { collectReflectorBaseNodes } from '../src/apply-precompiled.js';

function fixture() {

	const mirror = reflector( { depth: true, generateMipmaps: true, resolutionScale: 0.5, bounces: false } );
	const camera = new PerspectiveCamera();
	camera.position.z = 4;
	camera.updateMatrixWorld();
	const scene = new Scene();
	scene.name = 'room';
	scene.add( mirror.target );
	scene.updateMatrixWorld();
	const material = { visible: true };
	let target = null;
	let mrt = { name: 'original MRT' };
	const renderer = {
		coordinateSystem: WebGPUCoordinateSystem,
		autoClear: false,
		getDrawingBufferSize: ( size ) => size.set( 640, 360 ),
		getRenderTarget: () => target,
		setRenderTarget: ( next ) => { target = next; },
		getMRT: () => mrt,
		setMRT: ( next ) => { mrt = next; },
	};
	return { mirror, frame: { camera, scene, material, renderer } };

}

test( 'slim reflector renders a mirrored camera and updates separate color/depth resources', () => {

	const { mirror, frame } = fixture();
	const base = mirror.reflector;
	assert.deepEqual( collectReflectorBaseNodes( { colorNode: mirror.rgb.mul( 0.5 ) } ), [ base ] );
	assert.equal( mirror.clone().reflector, base );
	let draws = 0;
	frame.renderer.render = ( scene, camera ) => {

		draws ++;
		assert.equal( scene, frame.scene );
		assert.equal( camera.position.z, - 4 );
		assert.equal( frame.material.visible, false );
		assert.equal( frame.renderer.getMRT(), null );
		assert.equal( base.updateBefore( frame ), false, 'no recursive bounce' );

	};
	base.updateBefore( frame );
	const target = base.getRenderTarget( base.getVirtualCamera( frame.camera ) );
	assert.equal( draws, 1 );
	assert.deepEqual( [ target.width, target.height ], [ 320, 180 ] );
	assert.equal( target.texture.type, HalfFloatType );
	assert.equal( target.texture.generateMipmaps, true );
	assert.equal( mirror.value, target.texture );
	assert.equal( mirror.getDepthNode().value, target.depthTexture );
	assert.notEqual( mirror.value, mirror.getDepthNode().value );
	assert.equal( frame.renderer.getRenderTarget(), null );
	assert.equal( frame.material.visible, true );
	assert.equal( frame.scene.name, 'room' );
	mirror.dispose();

} );

test( 'slim reflector restores renderer state and recursion guard after a failed nested draw', () => {

	const { mirror, frame } = fixture();
	const originalMRT = frame.renderer.getMRT();
	frame.renderer.render = () => { throw new Error( 'missing capture' ); };
	assert.throws( () => mirror.reflector.updateBefore( frame ), /missing capture/ );
	assert.equal( frame.renderer.getMRT(), originalMRT );
	assert.equal( frame.renderer.getRenderTarget(), null );
	assert.equal( frame.renderer.autoClear, false );
	assert.equal( frame.material.visible, true );
	assert.equal( frame.scene.name, 'room' );
	let recovered = false;
	frame.renderer.render = () => { recovered = true; };
	mirror.reflector.updateBefore( frame );
	assert.equal( recovered, true );
	mirror.dispose();

} );
