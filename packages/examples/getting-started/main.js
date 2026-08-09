/**
 * tsl-precompile / getting-started
 *
 * The minimal flow:
 *   1. `pnpm dev` — runs Vite with the plugin. `setupPrecompile()` wires the
 *      dev-capture endpoint; the first time `.precompile('getting-started')`
 *      runs, the live extractor walks the material and POSTs the artifact
 *      to `./artifacts/getting-started.<hash>.json` after a successful real
 *      render.
 *   2. Commit `./artifacts/` so other developers (and CI) can `build`
 *      without re-running dev capture.
 *   3. `pnpm build` — Vite + the plugin rewrite `.precompile('...')` into
 *      `__applyPrecompiled(...)` and use the generated artifact while stock
 *      Three remains available. Slim mode is a separate, optional proof.
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
// this helper becomes a harmless no-op. If slim is enabled later, the same
// real render observation captures its renderer-output transform in dev.
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

material.precompile( 'getting-started' );   // optional stable-name override

const mesh = new Mesh( new TorusKnotGeometry( 1, 0.3, 128, 32 ), material );
scene.add( mesh );

// The production dual-backend canary samples this small receipt alongside
// canvas pixels. It distinguishes a stopped application loop from a backend
// that receives changing CPU transforms but presents a stale GPU frame.
const renderEvidence = window.__TSLP_CANARY_RENDER_EVIDENCE__ = {
	renderFrames: 0,
	naturalRenderFrames: 0,
	controlledRenderFrames: 0,
	controlled: false,
	rotation: [ mesh.rotation.x, mesh.rotation.y ],
	worldMatrix: Array.from( mesh.matrixWorld.elements ),
};

function renderCanaryFrame( mode ) {

	renderer.render( scene, camera );
	renderEvidence.renderFrames ++;
	if ( mode === 'controlled' ) renderEvidence.controlledRenderFrames ++;
	else renderEvidence.naturalRenderFrames ++;
	renderEvidence.rotation = [ mesh.rotation.x, mesh.rotation.y ];
	renderEvidence.worldMatrix = Array.from( mesh.matrixWorld.elements );

}

// Production verification takes deterministic control only after the normal
// animation loop has rendered. Each call pauses natural GPU submissions, sets
// an exact pose, renders it once, and fences the renderer's real backend. The
// harness then gives the browser compositor two submission-free RAFs before
// taking the screenshot.
window.__TSLP_CANARY_RENDER_AT__ = async ( capture ) => {

	if ( renderEvidence.naturalRenderFrames < 1 ) {

		throw new Error( 'Canary deterministic render ran before the natural animation loop.' );

	}
	const rotation = Array.isArray( capture?.rotation ) ? capture.rotation : [];
	if ( rotation.length !== 2 || rotation.some( ( value ) => ! Number.isFinite( value ) ) ) {

		throw new Error( 'Canary deterministic render requires two finite rotation values.' );

	}
	renderEvidence.controlled = true;
	mesh.rotation.x = rotation[ 0 ];
	mesh.rotation.y = rotation[ 1 ];
	renderCanaryFrame( 'controlled' );
	const submittedRenderFrames = renderEvidence.renderFrames;
	const backend = renderer.backend;
	let backendEvidence;
	if ( backend?.isWebGPUBackend === true ) {

		const queue = backend.device?.queue;
		if ( ! queue || typeof queue.onSubmittedWorkDone !== 'function' ) {

			throw new Error( 'Canary WebGPU backend does not expose GPUQueue.onSubmittedWorkDone().' );

		}
		await queue.onSubmittedWorkDone();
		backendEvidence = {
			backend: 'webgpu',
			method: 'GPUQueue.onSubmittedWorkDone',
		};

	} else if ( backend?.isWebGLBackend === true ) {

		const context = backend.gl;
		if ( ! context || typeof context.finish !== 'function' ) {

			throw new Error( 'Canary WebGL backend does not expose WebGL2RenderingContext.finish().' );

		}
		context.finish();
		backendEvidence = {
			backend: 'webgl',
			method: 'WebGL2RenderingContext.finish',
		};

	} else {

		throw new Error( 'Canary renderer backend is unavailable for the deterministic render.' );

	}
	return {
		...backendEvidence,
		captureId: typeof capture?.id === 'string' ? capture.id : null,
		pausedNaturalRendering: renderEvidence.controlled === true,
		fenceCompleted: true,
		requestedRotation: rotation.slice(),
		rotation: renderEvidence.rotation.slice(),
		naturalRenderFrames: renderEvidence.naturalRenderFrames,
		controlledRenderFrames: renderEvidence.controlledRenderFrames,
		submittedRenderFrames,
		completedRenderFrames: renderEvidence.renderFrames,
	};

};

// --- render loop --------------------------------------------------------
function tick() {

	requestAnimationFrame( tick );
	if ( renderEvidence.controlled ) return;
	// Keep the visual canary obvious even on software WebGPU, where presentation
	// can be slower than the browser's requestAnimationFrame cadence.
	mesh.rotation.x += 0.04;
	mesh.rotation.y += 0.06;
	renderCanaryFrame( 'natural' );

}
tick();

window.addEventListener( 'resize', () => {

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );

} );
