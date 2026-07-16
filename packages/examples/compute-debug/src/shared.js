import { PerspectiveCamera, Scene } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { createPrecompiledComputeRunner } from '@tsl-precompile/runtime/compute';
import 'virtual:tsl-precompile/__aux';

import {
	markComputeReady,
	recordComputeDispatch,
	recordLiveRouteFrame,
} from './site-status.js';

const CAPTURE_ENDPOINT = window.__TSLP_E2E?.captureEndpoint || '/__tsl-precompile/capture';
const IS_PRODUCTION_BUILD = import.meta.env?.PROD === true;

export const IS_E2E = !! window.__TSLP_E2E;
export const IS_E2E_REPLAY = window.__TSLP_E2E?.mode === 'replay';
export { IS_PRODUCTION_BUILD };

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

/** Create one renderer and keep capture/compiler dependencies dev-only. */
export async function createScene( { title, cameraPosition = [ 0, 0, 3.2 ], lookAt = [ 0, 0, 0 ], clearColor = 0x14171c } = {} ) {

	setHud( title, 'starting' );

	const renderer = new WebGPURenderer( { antialias: true } );
	renderer.setPixelRatio( Math.min( 2, window.devicePixelRatio || 1 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.setClearColor( clearColor );
	document.body.appendChild( renderer.domElement );

	await renderer.init();

	let capture = null;
	if ( ! IS_PRODUCTION_BUILD && ! IS_E2E_REPLAY ) {

		const { setupCaptureRuntime } = await import( './capture-runtime.js' );
		capture = await setupCaptureRuntime( renderer, CAPTURE_ENDPOINT );

	}

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
		capture,
		setStatus: ( status ) => setHud( title, status ),
		markComputeReady,
		recordFrame: recordLiveRouteFrame,
	};

}

/** Capture a route's kernels in one compile transaction during development. */
export async function captureComputeStages( renderer, scene, camera, capture, stages ) {

	if ( ! capture || IS_E2E_REPLAY ) return [];
	return capture.runtime.precompileComputes( renderer, stages, {
		scene,
		camera,
		devEndpoint: CAPTURE_ENDPOINT,
		three: capture.three,
		threeVersion: globalThis.__TSLP_THREE_PACKAGE_VERSION__ || String( capture.three.REVISION ).match( /^\d+/ )?.[ 0 ],
	} );

}

/** Give raw dev nodes and compiled production nodes the same small interface. */
export function createRawComputeRunner( renderer, node ) {

	return {
		node,
		dispatch: ( ...args ) => renderer.compute( node, ...args ),
		dispatchAsync: ( ...args ) => renderer.computeAsync( node, ...args ),
		dispose: () => {},
	};

}

export function createCompiledComputeRunner( renderer, compiled, resources ) {

	return createPrecompiledComputeRunner( renderer, compiled, resources );

}

/**
 * Load raw graph factories only from Vite's development server. The computed,
 * ignored specifier is intentional: production must not even resolve these
 * modules against the slim TSL export surface before tree-shaking.
 */
export function loadDevComputeModule( name ) {

	if ( IS_PRODUCTION_BUILD ) throw new Error( '[compute-debug] raw compute graphs are unavailable in production.' );
	return import( /* @vite-ignore */ `./compute-dev/${ name }.js` );

}

/** Count only dispatches that returned successfully. */
export function trackComputeRunner( runner ) {

	return {
		...runner,
		dispatch( ...args ) {

			const value = runner.dispatch( ...args );
			recordComputeDispatch();
			return value;

		},
		async dispatchAsync( ...args ) {

			const value = await runner.dispatchAsync( ...args );
			recordComputeDispatch();
			return value;

		},
		dispose: () => runner.dispose(),
	};

}

export async function runAux( renderer, scene, camera, capture ) {

	if ( ! capture ) return 'compiled aux';
	const auxResults = await capture.runtime.precompileAuxiliary( renderer, scene, camera, {
		devEndpoint: CAPTURE_ENDPOINT,
		three: capture.three,
		threeVersion: globalThis.__TSLP_THREE_PACKAGE_VERSION__ || String( capture.three.REVISION ).match( /^\d+/ )?.[ 0 ],
	} ).catch( ( error ) => {

		console.warn( '[compute-debug] auxiliary capture failed:', error );
		return [ { shape: 'aux', ok: false, error: error?.message || String( error ) } ];

	} );
	return auxResults.map( result => `${ result.shape }:${ result.ok ? 'ok' : 'err' }` ).join( ', ' ) || 'no aux';

}
