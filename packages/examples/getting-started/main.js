/**
 * tsl-precompile / getting-started
 *
 * The minimal flow:
 *   1. `pnpm dev` — runs Vite with the plugin. `setupPrecompile()` wires the
 *      dev-capture endpoint; the first time `.precompile('getting-started')`
 *      runs, the live extractor walks the material and POSTs the artifact
 *      to `./artifacts/getting-started.<hash>.json`. Because this example
 *      enables slim source mode, setup also captures each renderer-output
 *      topology observed after a successful real render.
 *   2. Commit `./artifacts/` so other developers (and CI) can `build`
 *      without re-running dev capture.
 *   3. `pnpm build` — Vite + the plugin rewrite `.precompile('...')` into
 *      `__applyPrecompiled(...)` and ship the precompiled WGSL.
 */

import { Scene, PerspectiveCamera, Mesh, TorusKnotGeometry, DirectionalLight, HemisphereLight, WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { color, mix, uv } from 'three/tsl';
import { setupPrecompile } from '@tsl-precompile/runtime/setup';

const status = document.getElementById( 'status' );
const setStatus = ( msg ) => { status.textContent = msg; console.info( '[getting-started]', msg ); };

setStatus( 'creating renderer…' );

const renderer = new WebGPURenderer( { antialias: true } );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setPixelRatio( Math.min( 2, window.devicePixelRatio || 1 ) );
renderer.setClearColor( 0x101418 );
document.body.appendChild( renderer.domElement );

// One-call setup: installs the .precompile() marker and registers this
// renderer with the dev-capture flow once init() has resolved. In a prod
// build the babel transform has already replaced .precompile() calls and
// this helper becomes a harmless no-op. Slim mode also uses this same real
// render observation to capture only the renderer-output transform in dev.
const setup = setupPrecompile( { renderer } );
await renderer.init();
await setup.ready;
setStatus( 'renderer ready' );

// --- scene --------------------------------------------------------------
const scene = new Scene();
const camera = new PerspectiveCamera( 50, window.innerWidth / window.innerHeight, 0.1, 100 );
camera.position.set( 0, 0, 4 );
camera.lookAt( 0, 0, 0 );

scene.add( new HemisphereLight( 0xbbddff, 0x223344, 1.0 ) );
const sun = new DirectionalLight( 0xffffff, 2.0 );
sun.position.set( 3, 4, 2 );
scene.add( sun );

// --- material -----------------------------------------------------------
const material = new MeshStandardNodeMaterial();
material.roughness = 0.35;
material.metalness = 0.1;

// Keep the TSL trivial so the captured artifact stays small and stable —
// reordering or rewriting this line changes the hash and forces a fresh
// dev capture. That's by design: the artifact pins this exact graph.
material.colorNode = mix( color( 0x224488 ), color( 0x88ccff ), uv().y );

material.precompile( 'getting-started' );   // <-- the one line you add

const mesh = new Mesh( new TorusKnotGeometry( 1, 0.3, 128, 32 ), material );
scene.add( mesh );

// --- render loop --------------------------------------------------------
function tick() {

	requestAnimationFrame( tick );
	mesh.rotation.x += 0.005;
	mesh.rotation.y += 0.008;
	renderer.render( scene, camera );

}
tick();

window.addEventListener( 'resize', () => {

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );

} );
