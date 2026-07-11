/**
 * tsl-precompile · ocean demo
 *
 * Mirrors three.js' stock `webgpu_ocean.html` (WaterMesh + SkyMesh + PMREM
 * env + RenderPipeline-with-bloom + OrbitControls) and threads our
 * precompile pipeline through it:
 *
 *   • `water.material.precompile('ocean-water')` — user material capture.
 *   • `sky.material.precompile('ocean-sky')`     — second user material.
 *   • `precompileAuxiliary(...)`                  — aux-pass capture for
 *      background, post-processing (bloom), and PMREM convolution.
 *
 * This is the canonical hand-test for the dev capture endpoint and is also
 * spawned by `packages/examples/batch/run-capture-replay.mjs` and
 * `run-inspector-smoke.mjs` to validate the end-to-end loop.
 */

import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

import { Inspector } from 'three/addons/inspector/Inspector.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WaterMesh } from 'three/addons/objects/WaterMesh.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';

import { installPrecompileMarker, setDevRenderer, precompileAuxiliary, listAux } from '@tsl-precompile/runtime';
import { attachToInspector } from '@tsl-precompile/inspector-panel';

// --- status overlay (preserved from the old demo for the spawning harnesses
//     that scrape #status) --------------------------------------------------
const statusEl = document.getElementById( 'status' );
const setStatus = ( msg ) => { if ( statusEl ) statusEl.textContent = msg; console.info( '[ocean]', msg ); };

setStatus( 'creating renderer…' );

// --- renderer --------------------------------------------------------------
const renderer = new THREE.WebGPURenderer();
renderer.setPixelRatio( window.devicePixelRatio );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.1;

// Inspector MUST be assigned before renderer.init(); three.js calls
// `inspector.init()` as the final step inside the renderer's init().
renderer.inspector = new Inspector();
attachToInspector( renderer.inspector );

document.body.appendChild( renderer.domElement );

await renderer.init();
setStatus( 'renderer ready' );

// --- precompile marker (no-op in production: Babel rewrites the call) ------
installPrecompileMarker( THREE, { devEndpoint: '/__tsl-precompile/capture' } );
setDevRenderer( renderer );

// --- scene + camera --------------------------------------------------------
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera( 55, window.innerWidth / window.innerHeight, 1, 20000 );
camera.position.set( 30, 30, 100 );

// --- water -----------------------------------------------------------------
const waterGeometry = new THREE.PlaneGeometry( 10000, 10000 );
const waterNormals = new THREE.TextureLoader().load( 'textures/waternormals.jpg' );
waterNormals.wrapS = waterNormals.wrapT = THREE.RepeatWrapping;

const water = new WaterMesh(
	waterGeometry,
	{
		waterNormals,
		sunDirection: new THREE.Vector3(),
		sunColor: 0xffffff,
		waterColor: 0x001e0f,
		distortionScale: 3.7,
	},
);
water.rotation.x = - Math.PI / 2;
water.material.__tslpPrecompileObject = water;
water.material.__tslpPrecompileScene = scene;
water.material.precompile( 'ocean-water' );
scene.add( water );

// --- sky -------------------------------------------------------------------
const sky = new SkyMesh();
sky.scale.setScalar( 10000 );

sky.turbidity.value = 10;
sky.rayleigh.value = 2;
sky.mieCoefficient.value = 0.005;
sky.mieDirectionalG.value = 0.8;
sky.cloudCoverage.value = 0.4;
sky.cloudDensity.value = 0.5;
sky.cloudElevation.value = 0.5;

sky.material.__tslpPrecompileObject = sky;
sky.material.__tslpPrecompileScene = scene;
sky.material.precompile( 'ocean-sky' );
scene.add( sky );

// --- sun + PMREM env -------------------------------------------------------
const sun = new THREE.Vector3();
const parameters = { elevation: 2, azimuth: 180, exposure: 0.1 };
const pmremGenerator = new THREE.PMREMGenerator( renderer );
const sceneEnv = new THREE.Scene();
let renderTarget;

function updateSun() {

	const phi = THREE.MathUtils.degToRad( 90 - parameters.elevation );
	const theta = THREE.MathUtils.degToRad( parameters.azimuth );

	sun.setFromSphericalCoords( 1, phi, theta );
	sky.sunPosition.value.copy( sun );
	water.sunDirection.value.copy( sun ).normalize();

	if ( renderTarget !== undefined ) renderTarget.dispose();

	// Re-parent the sky into a throwaway scene for the PMREM bake, then put
	// it back into the visible scene afterwards.
	sceneEnv.add( sky );
	renderTarget = pmremGenerator.fromScene( sceneEnv );
	scene.add( sky );

	scene.environment = renderTarget.texture;

}

updateSun();

// --- chrome cube -----------------------------------------------------------
const cube = new THREE.Mesh(
	new THREE.BoxGeometry( 30, 30, 30 ),
	new THREE.MeshStandardMaterial( { roughness: 0 } ),
);
scene.add( cube );

// --- orbit controls --------------------------------------------------------
const controls = new OrbitControls( camera, renderer.domElement );
controls.maxPolarAngle = Math.PI * 0.495;
controls.target.set( 0, 10, 0 );
controls.minDistance = 40.0;
controls.maxDistance = 200.0;
controls.update();

// --- post-processing: scene + bloom ----------------------------------------
const renderPipeline = new THREE.RenderPipeline( renderer );

const scenePass = pass( scene, camera );
const scenePassColor = scenePass.getTextureNode( 'output' );

const bloomPass = bloom( scenePassColor );
bloomPass.threshold.value = 0;
bloomPass.strength.value = 0.1;
bloomPass.radius.value = 0;

renderPipeline.outputNode = scenePassColor.add( bloomPass );

// --- GUI (via three.js Inspector's lil-gui-compatible parameter panel) -----
const gui = renderer.inspector.createParameters( 'Settings' );

const folderSky = gui.addFolder( 'Sky' );
folderSky.add( parameters, 'elevation', 0, 90, 0.1 ).onChange( updateSun );
folderSky.add( parameters, 'azimuth', - 180, 180, 0.1 ).onChange( updateSun );
folderSky.add( parameters, 'exposure', 0, 1, 0.0001 ).onChange( ( value ) => { renderer.toneMappingExposure = value; } );

const folderWater = gui.addFolder( 'Water' );
folderWater.add( water.distortionScale, 'value', 0, 8, 0.1 ).name( 'distortionScale' );
folderWater.add( water.size, 'value', 0.1, 10, 0.1 ).name( 'size' );

const folderBloom = gui.addFolder( 'Bloom' );
folderBloom.add( bloomPass.strength, 'value', 0, 3, 0.01 ).name( 'strength' );
folderBloom.add( bloomPass.radius, 'value', 0, 1, 0.01 ).name( 'radius' );

const folderClouds = gui.addFolder( 'Clouds' );
folderClouds.add( sky.cloudCoverage, 'value', 0, 1, 0.01 ).name( 'coverage' );
folderClouds.add( sky.cloudDensity, 'value', 0, 1, 0.01 ).name( 'density' );
folderClouds.add( sky.cloudElevation, 'value', 0, 1, 0.01 ).name( 'elevation' );

// --- aux capture -----------------------------------------------------------
// Capture the auxiliary NodeMaterials three.js builds internally — the
// scene background (from `scene.environment`), the bloom post-pass, and the
// PMREM convolution. The dev endpoint persists the JSON for the next build
// to pick up. The runtime auto-detects production builds (where compileTSL
// isn't bundled) and silently no-ops, so this call is safe in any mode.
precompileAuxiliary( renderer, scene, camera, {
	devEndpoint: '/__tsl-precompile/capture',
	three: THREE,
	threeVersion: globalThis.__TSLP_THREE_PACKAGE_VERSION__ || String( THREE.REVISION ).match( /^\d+/ )[ 0 ],
} ).then( ( results ) => {

	const summary = results.map( ( r ) => `${ r.shape }:${ r.ok ? 'ok' : 'err ' + r.error }` ).join( ', ' );
	console.info( '[ocean] aux capture →', summary );
	console.info( '[ocean] loaded aux artifacts:', listAux() );

} ).catch( ( err ) => {

	console.warn( '[ocean] precompileAuxiliary failed:', err );

} );

// --- animation loop --------------------------------------------------------
renderer.setAnimationLoop( () => {

	const t = performance.now() * 0.001;

	cube.position.y = Math.sin( t ) * 20 + 5;
	cube.rotation.x = t * 0.5;
	cube.rotation.z = t * 0.51;

	renderPipeline.render();

} );

setStatus( 'rendering — open dev tools, watch for capture log' );

// --- resize ----------------------------------------------------------------
window.addEventListener( 'resize', () => {

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );

} );
