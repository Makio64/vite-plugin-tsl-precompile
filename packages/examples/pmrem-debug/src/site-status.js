import * as THREE from 'three/webgpu';

const result = window.__TSLP_SITE_RESULT__ = {
	id: `pmrem-debug:${ window.location.pathname.split( '/' ).pop() }${ window.location.search }`,
	ready: false,
	runtimeMode: THREE.__TSLP_SLIM__ === true ? 'pure-slim' : 'capture',
	compilerFree: THREE.__TSLP_SLIM__ === true,
	animationFrames: 0,
	canvasCount: 0,
	errors: [],
	domain: null,
};

function publish() {

	window.parent.postMessage( {
		type: 'tslp-example-status',
		result: {
			...result,
			errors: [ ...result.errors ],
			domain: result.domain ? { ...result.domain } : null,
		},
	}, window.location.origin );

}

function recordError( message ) {

	if ( result.errors.length < 20 && ! result.errors.includes( message ) ) result.errors.push( message );
	publish();

}

window.addEventListener( 'error', event => {

	recordError( event.message || 'window error' );

} );

window.addEventListener( 'unhandledrejection', event => {

	recordError( String( event.reason?.message || event.reason || 'unhandled rejection' ) );

} );

function observe() {

	result.animationFrames += 1;
	result.canvasCount = document.querySelectorAll( 'canvas' ).length;
	result.domain = globalThis.__TSLP_SITE_DOMAIN__ ? { ...globalThis.__TSLP_SITE_DOMAIN__ } : null;
	const rendererReady = document.querySelector( '.hud-status' )?.textContent.includes( 'rendering' ) === true;
	const domainReady = result.domain?.type === 'pmrem' &&
		result.domain.generated === true &&
		result.domain.isPMREMTexture === true &&
		result.domain.outputBound === true &&
		result.domain.renderFrames > 0;
	const ready = result.compilerFree &&
		rendererReady &&
		domainReady &&
		result.canvasCount > 0 &&
		result.errors.length === 0;
	if ( ready !== result.ready || result.animationFrames === 1 || result.animationFrames % 120 === 0 ) {

		result.ready = ready;
		publish();

	}
	requestAnimationFrame( observe );

}

observe();
