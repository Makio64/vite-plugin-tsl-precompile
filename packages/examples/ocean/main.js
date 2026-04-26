import { Scene, PerspectiveCamera, Mesh, PlaneGeometry, Color, HemisphereLight, DirectionalLight } from 'three';
import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { uv, color, mix, sin, time, vec3, positionLocal, normalLocal, backgroundBlurriness, backgroundIntensity, backgroundRotation, normalWorld } from 'three/tsl';

import { installPrecompileMarker, setDevRenderer, precompileAuxiliary, listAux } from '@tsl-precompile/runtime';
import { Inspector } from 'three/addons/inspector/Inspector.js';
import { attachToInspector } from '@tsl-precompile/inspector-panel';
import * as THREE from 'three';

const status = document.getElementById( 'status' );
const setStatus = ( msg ) => { status.textContent = msg; console.info( '[ocean]', msg ); };

setStatus( 'creating renderer…' );

const renderer = new WebGPURenderer( { antialias: true } );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setPixelRatio( Math.min( 2, window.devicePixelRatio || 1 ) );
renderer.setClearColor( 0x001020 );
document.body.appendChild( renderer.domElement );

// --- three.js Inspector + Precompile panel ------------------------------
//
// MUST be assigned BEFORE `renderer.init()` — three.js calls
// `inspector.init()` as the last step of renderer.init(). Setting it
// after won't mount the inspector DOM.
renderer.inspector = new Inspector();
attachToInspector( renderer.inspector );

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

// Demonstrate the aux-pass precompile path: use a TSL node as the scene
// background. Three.js will create an internal `NodeMaterial` from it —
// precompileAuxiliary() captures that material so the slim runtime can
// load it precompiled instead of running the node builder.
scene.backgroundNode = mix( color( 0x001020 ), color( 0x204060 ), normalWorld.y.mul( 0.5 ).add( 0.5 ) );

const camera = new PerspectiveCamera( 50, window.innerWidth / window.innerHeight, 0.1, 100 );
camera.position.set( 0, 2, 4 );
camera.lookAt( 0, 0, 0 );

scene.add( new HemisphereLight( 0x88bbff, 0x001020, 1.2 ) );
const sun = new DirectionalLight( 0xffeecc, 2.0 );
sun.position.set( 3, 5, 2 );
scene.add( sun );

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

// Capture the Background aux-pass graph (the NodeMaterial three.js builds
// from scene.backgroundNode). In a production bundle with the plugin's
// Babel rewrite, this will have already been precompiled at build time; in
// dev mode this call POSTs the artifact to the capture endpoint so the
// next build can pick it up.
precompileAuxiliary( renderer, scene, camera, {
	devEndpoint: '/__tsl-precompile/capture',
	three: THREE,
	threeVersion: String( THREE.REVISION || 'unknown' ),
	pluginVersion: '0.0.0',
} ).then( ( results ) => {

	const summary = results.map( ( r ) => `${ r.shape }:${ r.ok ? 'ok' : 'err ' + r.error }` ).join( ', ' );
	console.info( '[ocean] aux capture →', summary );
	console.info( '[ocean] loaded aux artifacts:', listAux() );

} ).catch( ( err ) => {

	console.warn( '[ocean] precompileAuxiliary failed:', err );

} );

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
