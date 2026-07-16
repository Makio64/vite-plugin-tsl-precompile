import { WebGPURenderer } from 'three/webgpu';

const result = window.__TSLP_SITE_RESULT__ = {
	id: `mrt-debug:${ window.location.pathname.split( '/' ).pop() }`,
	ready: false,
	runtimeMode: WebGPURenderer.__TSLP_SLIM__ === true ? 'pure-slim' : 'capture',
	compilerFree: WebGPURenderer.__TSLP_SLIM__ === true,
	animationFrames: 0,
	canvasCount: 0,
	errors: [],
};

function publish() {

	window.parent.postMessage( { type: 'tslp-example-status', result: { ...result } }, window.location.origin );

}

function recordError( message ) {

	if ( result.errors.length < 20 && ! result.errors.includes( message ) ) result.errors.push( message );
	publish();

}

window.addEventListener( 'error', event => recordError( event.message || 'window error' ) );
window.addEventListener( 'unhandledrejection', event => recordError( String( event.reason?.message || event.reason || 'unhandled rejection' ) ) );

function observe() {

	result.animationFrames += 1;
	result.canvasCount = document.querySelectorAll( 'canvas' ).length;
	const rendererReady = document.querySelector( '.hud-status' )?.textContent.includes( 'rendering' ) === true;
	const ready = result.compilerFree && rendererReady && result.canvasCount > 0 && result.errors.length === 0;
	if ( result.animationFrames === 1 || ready !== result.ready || result.animationFrames % 120 === 0 ) {

		result.ready = ready;
		publish();

	}
	requestAnimationFrame( observe );

}

observe();
