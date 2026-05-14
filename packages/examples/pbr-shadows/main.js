/**
 * tsl-precompile / pbr-shadows
 *
 * One step beyond getting-started: a PBR sphere on a ground plane with a
 * shadow-casting directional light. Demonstrates the recommended "ordinary
 * three.js app" shape — `MeshStandardNodeMaterial` + direct lights + shadows —
 * and shows that markers compose cleanly across multiple materials.
 *
 * Workflow is the same as getting-started:
 *   1. `pnpm dev` — Vite captures both `sphere` and `ground` artifacts.
 *   2. Commit `./artifacts/`.
 *   3. `pnpm build` — both materials ship as precompiled WGSL + UBO updaters.
 */

import * as THREE from 'three/webgpu';
import {
	Scene, PerspectiveCamera, Mesh, SphereGeometry, PlaneGeometry,
	DirectionalLight, HemisphereLight, WebGPURenderer, MeshStandardNodeMaterial,
} from 'three/webgpu';
import { setupPrecompile } from '@tsl-precompile/runtime';

const status = document.getElementById( 'status' );
const setStatus = ( msg ) => { status.textContent = msg; console.info( '[pbr-shadows]', msg ); };

setStatus( 'creating renderer…' );

const renderer = new WebGPURenderer( { antialias: true } );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setPixelRatio( Math.min( 2, window.devicePixelRatio || 1 ) );
renderer.setClearColor( 0x0a0d10 );
renderer.shadowMap.enabled = true;
document.body.appendChild( renderer.domElement );

const setup = setupPrecompile( { three: THREE, renderer } );
await renderer.init();
await setup.ready;
setStatus( 'renderer ready' );

// --- scene ----------------------------------------------------------------
const scene = new Scene();
const camera = new PerspectiveCamera( 50, window.innerWidth / window.innerHeight, 0.1, 100 );
camera.position.set( 2.4, 1.6, 3.4 );
camera.lookAt( 0, 0.4, 0 );

scene.add( new HemisphereLight( 0xbbddff, 0x223344, 0.6 ) );

const sun = new DirectionalLight( 0xffffff, 2.5 );
sun.position.set( 3, 5, 2 );
sun.castShadow = true;
sun.shadow.mapSize.set( 1024, 1024 );
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 20;
sun.shadow.camera.left = -3;
sun.shadow.camera.right = 3;
sun.shadow.camera.top = 3;
sun.shadow.camera.bottom = -3;
scene.add( sun );

// --- sphere material ------------------------------------------------------
const sphereMaterial = new MeshStandardNodeMaterial( {
	color: 0xc77b50,
	roughness: 0.32,
	metalness: 0.05,
} );
sphereMaterial.precompile( 'sphere' );

const sphere = new Mesh( new SphereGeometry( 0.7, 64, 32 ), sphereMaterial );
sphere.position.y = 0.7;
sphere.castShadow = true;
sphere.receiveShadow = true;
scene.add( sphere );

// --- ground material ------------------------------------------------------
const groundMaterial = new MeshStandardNodeMaterial( {
	color: 0x445560,
	roughness: 0.9,
	metalness: 0.0,
} );
groundMaterial.precompile( 'ground' );

const ground = new Mesh( new PlaneGeometry( 12, 12 ), groundMaterial );
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add( ground );

// --- render loop ----------------------------------------------------------
function tick() {

	requestAnimationFrame( tick );
	sphere.rotation.y += 0.005;
	renderer.render( scene, camera );

}
tick();

window.addEventListener( 'resize', () => {

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );

} );
