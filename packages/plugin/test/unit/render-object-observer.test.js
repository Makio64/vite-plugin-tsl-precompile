import test from 'node:test';
import assert from 'node:assert/strict';

import { observeRenderObjects } from '../../src/vendor/render-object-observer.js';

function fixture() {

	const stateByObject = new Map();
	const manager = {
		getForRenderCacheKey: ( renderObject ) => renderObject.cacheKey,
		getForRender( renderObject ) {

			return stateByObject.get( renderObject );

		},
	};
	return { manager, renderer: { _nodes: manager }, stateByObject };

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
