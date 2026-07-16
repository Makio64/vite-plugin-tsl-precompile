import * as THREE from 'three/webgpu';

const result = window.__TSLP_SITE_RESULT__ = {
	id: `compute-debug:${ window.location.pathname.split( '/' ).pop() }`,
	ready: false,
	runtimeMode: THREE.__TSLP_SLIM__ === true ? 'pure-slim' : 'capture',
	compilerFree: THREE.__TSLP_SLIM__ === true,
	computeReady: false,
	kernelNames: [],
	computeDispatches: 0,
	animationFrames: 0,
	canvasCount: 0,
	errors: [],
};

function publish() {

	window.parent.postMessage( { type: 'tslp-example-status', result: { ...result, kernelNames: [ ...result.kernelNames ] } }, window.location.origin );

}

function refreshReady() {

	result.canvasCount = document.querySelectorAll( 'canvas' ).length;
	result.ready = result.compilerFree
		&& result.computeReady
		&& result.kernelNames.length > 0
		&& result.computeDispatches > 0
		&& result.animationFrames > 0
		&& result.canvasCount > 0
		&& result.errors.length === 0;

}

export function markComputeReady( kernelNames ) {

	result.kernelNames = [ ...new Set( kernelNames ) ];
	result.computeReady = result.kernelNames.length > 0;
	refreshReady();
	publish();

}

export function recordComputeDispatch() {

	result.computeDispatches += 1;
	refreshReady();
	if ( result.computeDispatches === 1 ) publish();

}

export function recordLiveRouteFrame() {

	result.animationFrames += 1;
	const wasReady = result.ready;
	refreshReady();
	if ( wasReady !== result.ready || result.animationFrames === 1 || result.animationFrames % 120 === 0 ) publish();

}

export function recordLiveRouteError( error ) {

	const message = String( error?.message || error || 'unknown error' );
	if ( result.errors.length < 20 && ! result.errors.includes( message ) ) result.errors.push( message );
	result.ready = false;
	publish();

}

window.addEventListener( 'error', event => recordLiveRouteError( event.message || 'window error' ) );
window.addEventListener( 'unhandledrejection', event => recordLiveRouteError( event.reason || 'unhandled rejection' ) );
queueMicrotask( publish );
