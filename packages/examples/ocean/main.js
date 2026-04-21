import { Scene, PerspectiveCamera, Mesh, PlaneGeometry, Color } from 'three';
import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { uv, color, mix, sin, time, vec3, positionLocal, normalLocal } from 'three/tsl';

import { installPrecompileMarker, setDevRenderer } from '@tsl-precompile/runtime';
import * as THREE from 'three';

const status = document.getElementById( 'status' );
const setStatus = ( msg ) => { status.textContent = msg; console.info( '[ocean]', msg ); };

setStatus( 'creating renderer…' );

const renderer = new WebGPURenderer( { antialias: true } );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setPixelRatio( Math.min( 2, window.devicePixelRatio || 1 ) );
renderer.setClearColor( 0x001020 );
document.body.appendChild( renderer.domElement );

await renderer.init();
setStatus( 'renderer ready' );

// --- precompile marker setup -----------------------------------------------
//
// Install once, give it the active renderer for in-browser extraction in dev.
// In a production build, the Babel transform replaces .precompile() calls
// before the bundle ever loads — these two lines are a no-op there.
installPrecompileMarker( THREE, {
	devEndpoint: '/__tsl-precompile/capture',
} );
setDevRenderer( renderer );

// --- scene ---------------------------------------------------------------
const scene = new Scene();
scene.background = new Color( 0x001020 );

const camera = new PerspectiveCamera( 50, window.innerWidth / window.innerHeight, 0.1, 100 );
camera.position.set( 0, 2, 4 );
camera.lookAt( 0, 0, 0 );

// --- water material -------------------------------------------------------
const water = new MeshStandardNodeMaterial();
water.color = new Color( 0x002244 );
water.roughness = 0.4;
water.metalness = 0.1;

// Animated normal-warp via TSL. Trivial demo shader — the point is to
// exercise the .precompile() path, not to look photorealistic.
const wave = sin( positionLocal.x.mul( 6 ).add( time.mul( 2 ) ) )
	.mul( 0.05 )
	.add( sin( positionLocal.y.mul( 8 ).add( time ) ).mul( 0.05 ) );
water.colorNode = mix( color( 0x002a55 ), color( 0x6fb4ff ), wave.add( 0.5 ) );

water.precompile( 'ocean-water' );

const geom = new PlaneGeometry( 8, 8, 64, 64 );
geom.rotateX( - Math.PI / 2 );
const mesh = new Mesh( geom, water );
scene.add( mesh );

// --- render loop ----------------------------------------------------------
let frame = 0;
function tick() {

	requestAnimationFrame( tick );
	frame ++;
	mesh.rotation.y = frame * 0.001;
	renderer.render( scene, camera );

}
tick();
setStatus( 'rendering — open dev tools, watch for capture log' );

// Resize
window.addEventListener( 'resize', () => {

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );

} );
