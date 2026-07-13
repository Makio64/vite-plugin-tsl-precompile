import test from 'node:test';
import assert from 'node:assert/strict';

import { observeRenderObjectRequests, observeRenderObjects } from '../../src/vendor/render-object-observer.js';

function fixture() {

	const stateByObject = new Map();
	const manager = {
		getForRenderCacheKey: ( renderObject ) => renderObject.cacheKey,
		getForRender( renderObject ) {

			return stateByObject.get( renderObject );

		},
	};
	const renderObjects = {
		get( renderObject ) { return renderObject; },
	};
	return { manager, renderObjects, renderer: { _nodes: manager, _objects: renderObjects }, stateByObject };

}

test( 'render-object observer shares one wrapper and preserves the original result', () => {

	const { manager, renderer, stateByObject } = fixture();
	const original = manager.getForRender;
	const renderObject = { cacheKey: 42 };
	const state = { vertexShader: 'vertex' };
	stateByObject.set( renderObject, state );
	const first = [];
	const second = [];

	const stopFirst = observeRenderObjects( renderer, ( event ) => first.push( event ) );
	const wrapper = manager.getForRender;
	const stopSecond = observeRenderObjects( renderer, ( event ) => second.push( event ) );
	assert.equal( manager.getForRender, wrapper, 'second subscriber reuses the branded wrapper' );
	assert.equal( manager.getForRender( renderObject ), state );
	assert.equal( first[ 0 ].cacheKey, 42 );
	assert.equal( first[ 0 ].nodeBuilderState, state );
	assert.equal( second[ 0 ].renderObject, renderObject );

	stopFirst();
	assert.equal( manager.getForRender, wrapper, 'remaining subscriber keeps observation active' );
	stopSecond();
	assert.equal( manager.getForRender, original, 'last subscriber restores the original method' );

} );

test( 'render-object request observer sees cached state and shares one wrapper', () => {

	const { renderObjects, renderer } = fixture();
	const original = renderObjects.get;
	const renderObject = { cacheKey: 91, _nodeBuilderState: { fragmentShader: 'cached' } };
	const first = [];
	const second = [];
	const stopFirst = observeRenderObjectRequests( renderer, ( event ) => first.push( event ) );
	const wrapper = renderObjects.get;
	const stopSecond = observeRenderObjectRequests( renderer, ( event ) => second.push( event ) );

	assert.equal( renderObjects.get, wrapper );
	assert.equal( renderObjects.get( renderObject ), renderObject );
	assert.equal( first[ 0 ].cacheKey, 91 );
	assert.equal( first[ 0 ].nodeBuilderState, renderObject._nodeBuilderState );
	assert.equal( second[ 0 ].renderObject, renderObject );
	stopFirst();
	assert.equal( renderObjects.get, wrapper );
	stopSecond();
	assert.equal( renderObjects.get, original );

} );

test( 'render-object request observer deactivates inside an external wrapper', () => {

	const { renderObjects, renderer } = fixture();
	const calls = [];
	const stop = observeRenderObjectRequests( renderer, ( event ) => calls.push( event ) );
	const observed = renderObjects.get;
	const replacement = function ( ...args ) { return observed.apply( this, args ); };
	renderObjects.get = replacement;

	renderObjects.get( { cacheKey: 1 } );
	assert.equal( calls.length, 1 );
	stop();
	renderObjects.get( { cacheKey: 2 } );
	assert.equal( calls.length, 1, 'the retained wrapper no longer owns the completed capture listener' );
	assert.equal( renderObjects.get, replacement, 'cleanup preserves the external replacement' );

} );

test( 'duplicate adapter modules share the cached-request observer registry', async () => {

	const { renderObjects, renderer } = fixture();
	const stopFirst = observeRenderObjectRequests( renderer, () => {} );
	const wrapper = renderObjects.get;
	const duplicate = await import( `../../src/vendor/render-object-observer.js?request-duplicate=${ Date.now() }` );
	const stopSecond = duplicate.observeRenderObjectRequests( renderer, () => {} );
	assert.equal( renderObjects.get, wrapper );
	stopFirst();
	assert.equal( renderObjects.get, wrapper );
	stopSecond();

} );

test( 'render-object observer isolates subscriber errors and has a no-op unsupported path', () => {

	const { manager, renderer } = fixture();
	const renderObject = { cacheKey: 7 };
	let called = false;
	const stopThrowing = observeRenderObjects( renderer, () => { throw new Error( 'observer-only' ); } );
	const stopHealthy = observeRenderObjects( renderer, () => { called = true; } );
	assert.doesNotThrow( () => manager.getForRender( renderObject ) );
	assert.equal( called, true );
	stopThrowing();
	stopHealthy();

	const stopUnsupported = observeRenderObjects( {}, () => {} );
	assert.doesNotThrow( stopUnsupported );

} );

test( 'render-object observer does not overwrite an external replacement on dispose', () => {

	const { manager, renderer } = fixture();
	const stop = observeRenderObjects( renderer, () => {} );
	const replacement = () => 'external';
	manager.getForRender = replacement;
	stop();
	assert.equal( manager.getForRender, replacement );

} );

test( 'duplicate adapter modules share the branded observer registry', async () => {

	const { manager, renderer } = fixture();
	const stopFirst = observeRenderObjects( renderer, () => {} );
	const wrapper = manager.getForRender;
	const duplicate = await import( `../../src/vendor/render-object-observer.js?duplicate=${ Date.now() }` );
	const stopSecond = duplicate.observeRenderObjects( renderer, () => {} );
	assert.equal( manager.getForRender, wrapper );
	stopFirst();
	assert.equal( manager.getForRender, wrapper );
	stopSecond();

} );
