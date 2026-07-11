import { PerspectiveCamera, Scene } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { installPrecompileMarker, precompileAuxiliary, setDevRenderer } from '@tsl-precompile/runtime';
import * as THREE_GPU from 'three/webgpu';

const CAPTURE_ENDPOINT = window.__TSLP_E2E?.captureEndpoint || '/__tsl-precompile/capture';

export const IS_E2E = !! window.__TSLP_E2E;
export const IS_E2E_REPLAY = window.__TSLP_E2E?.mode === 'replay';

const PAGES = [
	[ 'pass.html', 'PassNode MRT' ],
	[ 'mask.html', 'Material mask MRT' ],
	[ 'manual.html', 'Manual MRT' ],
];

export function setHud( title, status ) {

	const hud = document.getElementById( 'hud' );
	if ( ! hud ) return;
	const current = window.location.pathname.split( '/' ).pop();
	hud.innerHTML = `
		<div class="hud-title">${ title }</div>
		<div class="hud-status">${ status }</div>
		<nav class="hud-links" aria-label="MRT debug scenes">
			${ PAGES.map( ( [ href, label ] ) => `<a href="${ href }" ${ current === href ? 'aria-current="page"' : '' }>${ label }</a>` ).join( '' ) }
		</nav>
	`;

}

export async function createScene( { title, cameraPosition = [ 3.2, 2.0, 4.4 ], lookAt = [ 0, 0, 0 ], clearColor = 0x14171c } = {} ) {

	setHud( title, 'starting' );

	const renderer = new WebGPURenderer( { antialias: false } );
	renderer.setPixelRatio( Math.min( 2, window.devicePixelRatio || 1 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.setClearColor( clearColor );
	document.body.appendChild( renderer.domElement );

	await renderer.init();

	installPrecompileMarker( THREE_GPU, { devEndpoint: CAPTURE_ENDPOINT } );
	setDevRenderer( renderer );

	const scene = new Scene();
	const camera = new PerspectiveCamera( 45, window.innerWidth / window.innerHeight, 0.1, 50 );
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

export async function runAux( renderer, scene, camera, extra = {} ) {

	const auxResults = await precompileAuxiliary( renderer, scene, camera, {
		devEndpoint: CAPTURE_ENDPOINT,
		three: THREE_GPU,
		threeVersion: globalThis.__TSLP_THREE_PACKAGE_VERSION__ || String( THREE_GPU.REVISION ).match( /^\d+/ )[ 0 ],
		...extra,
	} ).catch( ( err ) => {

		console.warn( '[mrt-debug] auxiliary capture failed:', err );
		return [ { shape: 'aux', ok: false, error: err && err.message || String( err ) } ];

	} );

	return auxResults.map( ( r ) => `${ r.shape }:${ r.ok ? 'ok' : 'err' }` ).join( ', ' ) || 'no aux';

}
