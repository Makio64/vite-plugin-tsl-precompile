import { PerspectiveCamera, Scene } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { bindAuxByName } from '@tsl-precompile/runtime';
import 'virtual:tsl-precompile/__aux';

const CAPTURE_ENDPOINT = window.__TSLP_E2E?.captureEndpoint || '/__tsl-precompile/capture';

let captureRuntime = null;
let captureThree = null;

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

	// Capture needs the full node/compiler namespace, replay does not. Vite
	// folds this branch out of production slim-source builds.
	if ( import.meta.env?.PROD !== true ) {

		[ captureRuntime, captureThree ] = await Promise.all( [
			import( '@tsl-precompile/runtime' ),
			import( 'three/webgpu' ),
		] );
		captureRuntime.installPrecompileMarker( captureThree, { devEndpoint: CAPTURE_ENDPOINT } );
		captureRuntime.setDevRenderer( renderer );

	}

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

	const renderPipeline = extra.renderPipeline || extra.postProcessing || null;
	const captureName = extra.renderPipelineName || extra.postProcessingName || null;
	if ( renderPipeline?.outputNode && captureName ) {

		try {

			bindAuxByName( renderPipeline.outputNode, 'post-process', captureName );
			if ( ! captureRuntime ) return `${ captureName }:bound`;

		} catch ( error ) {

			if ( ! captureRuntime ) throw error;

		}

	}

	if ( ! captureRuntime || ! captureThree ) return 'no aux';

	const auxResults = await captureRuntime.precompileAuxiliary( renderer, scene, camera, {
		devEndpoint: CAPTURE_ENDPOINT,
		three: captureThree,
		threeVersion: globalThis.__TSLP_THREE_PACKAGE_VERSION__ || String( captureThree.REVISION ).match( /^\d+/ )[ 0 ],
		...extra,
	} ).catch( ( err ) => {

		console.warn( '[mrt-debug] auxiliary capture failed:', err );
		return [ { shape: 'aux', ok: false, error: err && err.message || String( err ) } ];

	} );

	if ( renderPipeline?.outputNode && captureName ) {

		try {

			bindAuxByName( renderPipeline.outputNode, 'post-process', captureName );

		} catch ( error ) {

			console.warn( `[mrt-debug] could not bind ${ captureName }:`, error );

		}

	}

	return auxResults.map( ( r ) => `${ r.shape }:${ r.ok ? 'ok' : 'err' }` ).join( ', ' ) || 'no aux';

}
