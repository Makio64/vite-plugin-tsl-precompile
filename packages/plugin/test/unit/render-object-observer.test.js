import test from 'node:test';
import assert from 'node:assert/strict';

import {
	beginRenderObjectHarvest,
	observeRenderObjectRequests,
	observeRenderObjects,
} from '../../src/vendor/render-object-observer.js';

function fixture() {

	const stateByObject = new Map();
	const manager = {
		nodeBuilderCache: new Map(),
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

test( 'render-object requests freeze cube face and mip before renderer getters can mutate context', () => {

	const { renderer, renderObjects } = fixture();
	const context = {
		renderTarget: undefined,
		activeCubeFace: 2,
		activeMipmapLevel: 3,
		sampleCount: 4,
		textures: [ { isCubeTexture: true, format: 1023 } ],
	};
	const target = { isCubeRenderTarget: true, texture: context.textures[ 0 ] };
	renderer.getRenderTarget = () => {

		context.activeCubeFace = 5;
		context.activeMipmapLevel = 8;
		context.sampleCount = 1;
		return target;

	};
	const events = [];
	const stop = observeRenderObjectRequests( renderer, ( event ) => events.push( event ) );
	renderObjects.get( {
		cacheKey: 14,
		context,
		material: { uuid: 'cube-material' },
		object: { material: null },
	} );
	stop();

	const snapshot = events[ 0 ].requestSnapshot;
	assert.equal( snapshot.renderContext.activeCubeFace, 2 );
	assert.equal( snapshot.renderContext.activeMipmapLevel, 3 );
	assert.equal( snapshot.renderContext.sampleCount, 4 );
	const selector = JSON.parse( snapshot.renderContextSelector );
	assert.equal( selector.target.surface, 'offscreen-cube' );
	assert.equal( selector.target.activeCubeFace, 2 );
	assert.equal( selector.target.activeMipmapLevel, 3 );
	assert.equal( selector.target.sampleCount, 4 );

} );

test( 'harvest includes repeated request-only cache hits as one complete material variant', async () => {

	const { manager, renderer, renderObjects } = fixture();
	const state = { vertexShader: 'cached-vertex', fragmentShader: 'cached-fragment' };
	manager.nodeBuilderCache.set( 91, state );
	const material = { uuid: 'cached-material' };
	const renderObject = {
		cacheKey: 91,
		material,
		object: { material },
		context: { renderTarget: null, activeCubeFace: 0, activeMipmapLevel: 0, sampleCount: 1 },
	};
	const session = beginRenderObjectHarvest( renderer );
	renderObjects.get( renderObject );
	renderObjects.get( renderObject );
	const harvest = await session.finish();
	const family = harvest.familiesByMaterial.get( material );

	assert.equal( harvest.requests.length, 2, 'every cached RenderObjects.get request is retained' );
	assert.equal( family.complete, true );
	assert.equal( family.variants.length, 1 );
	assert.equal( family.variants[ 0 ].requestCount, 2 );
	assert.equal( family.variants[ 0 ].nodeBuilderState, state );

} );

test( 'harvest correlates equal Three cache keys independently per material', async () => {

	const { manager, renderer, renderObjects, stateByObject } = fixture();
	const firstMaterial = { uuid: 'first-material' };
	const secondMaterial = { uuid: 'second-material' };
	const first = { cacheKey: 7, material: firstMaterial, object: { material: firstMaterial }, context: {} };
	const second = { cacheKey: 7, material: secondMaterial, object: { material: secondMaterial }, context: {} };
	const firstState = { vertexShader: 'first' };
	const secondState = { vertexShader: 'second' };
	stateByObject.set( first, firstState );
	stateByObject.set( second, secondState );
	const session = beginRenderObjectHarvest( renderer );
	renderObjects.get( first );
	manager.getForRender( first );
	renderObjects.get( second );
	manager.getForRender( second );
	const harvest = await session.finish();

	assert.equal( harvest.familiesByMaterial.get( firstMaterial ).variants[ 0 ].nodeBuilderState, firstState );
	assert.equal( harvest.familiesByMaterial.get( secondMaterial ).variants[ 0 ].nodeBuilderState, secondState );

} );

test( 'harvest resolves async NodeBuilderState without replacing Three\'s returned Promise', async () => {

	const { manager, renderer, renderObjects, stateByObject } = fixture();
	const material = { uuid: 'async-material' };
	const renderObject = { cacheKey: 33, material, object: { material }, context: {} };
	const state = { vertexShader: 'async-state' };
	const statePromise = Promise.resolve( state );
	stateByObject.set( renderObject, statePromise );
	const session = beginRenderObjectHarvest( renderer );
	renderObjects.get( renderObject );
	const returned = manager.getForRender( renderObject );
	assert.equal( returned, statePromise );
	const harvest = await session.finish();

	assert.equal( harvest.familiesByMaterial.get( material ).complete, true );
	assert.equal( harvest.familiesByMaterial.get( material ).variants[ 0 ].nodeBuilderState, state );

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
