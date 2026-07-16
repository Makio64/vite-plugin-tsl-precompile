import * as THREE from 'three/webgpu';

const result = window.__TSLP_SITE_RESULT__ = {
	id: `postprocessing-debug:${ window.location.pathname.split( '/' ).pop() }`,
	ready: false,
	runtimeMode: THREE.__TSLP_SLIM__ === true ? 'pure-slim' : 'capture',
	compilerFree: THREE.__TSLP_SLIM__ === true,
	animationFrames: 0,
	canvasCount: 0,
	errors: [],
};

function publish() {

	window.parent.postMessage( { type: 'tslp-example-status', result: { ...result } }, window.location.origin );

}

export function recordLiveRouteError( error ) {

	const message = String( error?.message || error || 'unknown error' );
	if ( result.errors.length < 20 && ! result.errors.includes( message ) ) result.errors.push( message );
	result.ready = false;
	publish();

}

export function recordLiveRouteFrame() {

	result.animationFrames += 1;
	result.canvasCount = document.querySelectorAll( 'canvas' ).length;
	const rendererReady = document.querySelector( '.hud-status' )?.textContent.includes( 'rendering' ) === true;
	const ready = result.compilerFree && rendererReady && result.canvasCount > 0 && result.errors.length === 0;
	if ( ready !== result.ready || result.animationFrames === 1 || result.animationFrames % 120 === 0 ) {

		result.ready = ready;
		publish();

	}

}

window.addEventListener( 'error', ( event ) => {

	recordLiveRouteError( event.message || 'window error' );

} );

window.addEventListener( 'unhandledrejection', ( event ) => {

	recordLiveRouteError( event.reason || 'unhandled rejection' );

} );

queueMicrotask( publish );
