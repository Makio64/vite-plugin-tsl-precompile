import { PerspectiveCamera, Scene } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { installPrecompileMarker, precompileAuxiliary, setDevRenderer } from '@tsl-precompile/runtime';
import * as THREE from 'three';

const CAPTURE_ENDPOINT = window.__TSLP_E2E?.captureEndpoint || '/__tsl-precompile/capture';
export const IS_E2E = !! window.__TSLP_E2E;
export const IS_E2E_REPLAY = window.__TSLP_E2E?.mode === 'replay';

const PAGES = [
	[ 'particles.html', 'Particles' ],
	[ 'instanced.html', 'Instanced' ],
	[ 'texture.html', 'Texture' ],
	[ 'dispatch2d.html', '2D Dispatch' ],
	[ 'uniform.html', 'Uniform' ],
	[ 'pipeline.html', 'Pipeline' ],
	[ 'reduce.html', 'Reduce' ],
];

export function setHud( title, status ) {
	const hud = document.getElementById( 'hud' );
	if ( ! hud ) return;
	const current = window.location.pathname.split( '/' ).pop();
	hud.innerHTML = `
		<div class="hud-title">${ title }</div>
		<div class="hud-status">${ status }</div>
		<nav class="hud-links" aria-label="Compute scenes">
			${ PAGES.map( ( [ href, label ] ) => `<a href="${ href }" ${ current === href ? 'aria-current="page"' : '' }>${ label }</a>` ).join( '' ) }
		</nav>
	`;
}

/**
 * Boilerplate shared by every compute-debug page: a WebGPURenderer wired to the
 * dev-capture marker, an empty Scene, a PerspectiveCamera looking at the origin,
 * a resize handler, and a `setStatus()` HUD updater. Each page builds its own
 * scene contents — compute scenes vary too much to share construction.
 */
export async function createScene( { title, cameraPosition = [ 0, 0, 3.2 ], lookAt = [ 0, 0, 0 ], clearColor = 0x14171c } = {} ) {
	setHud( title, 'starting' );

	const renderer = new WebGPURenderer( { antialias: true } );
	renderer.setPixelRatio( Math.min( 2, window.devicePixelRatio || 1 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.setClearColor( clearColor );
	document.body.appendChild( renderer.domElement );

	await renderer.init();

	installPrecompileMarker( THREE, { devEndpoint: CAPTURE_ENDPOINT } );
	setDevRenderer( renderer );

	const scene = new Scene();
	const camera = new PerspectiveCamera( 50, window.innerWidth / window.innerHeight, 0.1, 100 );
	camera.position.set( ...cameraPosition );
	camera.lookAt( ...lookAt );

	window.addEventListener( 'resize', () => {
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( window.innerWidth, window.innerHeight );
	} );

	return {
		renderer,
		scene,
		camera,
		setStatus: ( status ) => setHud( title, status ),
	};
}

/**
 * Run the auxiliary-pass capture (background / post / lights / PMREM) the same
 * way the other example apps do. Returns a short summary string for the HUD.
 */
export async function runAux( renderer, scene, camera ) {
	const auxResults = await precompileAuxiliary( renderer, scene, camera, {
		devEndpoint: CAPTURE_ENDPOINT,
		three: THREE,
		threeVersion: String( THREE.REVISION ).match( /^\d+/ )[ 0 ],
		pluginVersion: '0.0.0',
	} ).catch( ( err ) => {
		console.warn( '[compute-debug] auxiliary capture failed:', err );
		return [ { shape: 'aux', ok: false, error: err && err.message || String( err ) } ];
	} );
	return auxResults.map( ( r ) => `${ r.shape }:${ r.ok ? 'ok' : 'err' }` ).join( ', ' ) || 'no aux';
}
