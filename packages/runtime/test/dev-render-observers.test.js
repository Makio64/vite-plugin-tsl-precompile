import test from 'node:test';
import assert from 'node:assert/strict';

test( 'dev render observers survive runtime module copies used by HMR', async () => {

	const first = await import( `../src/dev-render-observers.js?copy=first-${ Date.now() }` );
	const second = await import( `../src/dev-render-observers.js?copy=second-${ Date.now() }` );
	const renderer = { render() {} };
	const scene = {};
	const camera = {};
	let calls = 0;
	const unsubscribe = second.observeDevRendererRenders( renderer, ( context ) => {

		calls ++;
		assert.deepEqual( context, { renderer, scene, camera } );

	} );

	first.notifyDevRendererObservers( renderer, scene, camera );
	assert.equal( calls, 1 );
	unsubscribe();
	first.notifyDevRendererObservers( renderer, scene, camera );
	assert.equal( calls, 1 );

} );
