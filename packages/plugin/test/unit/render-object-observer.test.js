import test from 'node:test';
import assert from 'node:assert/strict';

import {
	beginRenderObjectHarvest,
	observeRenderObjectRequests,
	observeRenderObjects,
	snapshotRenderObjectRequest,
} from '../../src/vendor/render-object-observer.js';
import { RENDER_BINDING_OWNER_KINDS } from '@tsl-precompile/contract/render-selector';
import { findMaterialComputeNodePath } from '@tsl-precompile/contract/material-compute';
import {
	isObservedVelocityProjectionSource,
	observeVelocityProjectionSources,
	observedVelocityProjectionSources,
} from '../../src/velocity-projection-observation.js';

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

test( 'render-object observers snapshot active VelocityNode projection identity', () => {

	const { manager, renderer, renderObjects, stateByObject } = fixture();
	const liveProjection = {};
	const cachedProjection = {};
	const liveVelocity = { constructor: { type: 'VelocityNode' }, projectionMatrix: liveProjection };
	const cachedVelocity = { constructor: { type: 'VelocityNode' }, projectionMatrix: cachedProjection };
	const renderObject = { cacheKey: 42 };
	const liveState = { updateNodes: [ liveVelocity ] };
	const cachedState = { updateNodes: [ cachedVelocity ] };
	stateByObject.set( renderObject, liveState );
	manager.nodeBuilderCache.set( renderObject.cacheKey, cachedState );

	const stopStates = observeRenderObjects( renderer, () => {} );
	manager.getForRender( renderObject );
	stopStates();
	const requestEvents = [];
	const stopRequests = observeRenderObjectRequests( renderer, ( event ) => requestEvents.push( event ) );
	renderObjects.get( renderObject );
	stopRequests();
	liveVelocity.projectionMatrix = null;
	cachedVelocity.projectionMatrix = null;

	assert.equal( isObservedVelocityProjectionSource( liveState, liveProjection ), true );
	assert.equal( isObservedVelocityProjectionSource( cachedState, cachedProjection ), true );
	assert.equal( isObservedVelocityProjectionSource( liveState, {} ), false );
	assert.deepEqual( observedVelocityProjectionSources( liveState ), [ liveProjection ] );
	assert.deepEqual( observedVelocityProjectionSources( cachedState ), [ cachedProjection ] );
	assert.deepEqual( requestEvents[ 0 ].requestSnapshot.velocityProjectionSources, [ cachedProjection ] );

} );

test( 'velocity projection observation preserves async states and fails closed', async () => {

	let resolveState;
	const promisedState = new Promise( ( resolve ) => { resolveState = resolve; } );
	const projection = {};
	const velocityNode = { constructor: { type: 'VelocityNode' }, projectionMatrix: projection };
	const state = { updateBeforeNodes: [ velocityNode ] };
	assert.equal( observeVelocityProjectionSources( promisedState ), promisedState );
	resolveState( state );
	await promisedState;
	await Promise.resolve();
	velocityNode.projectionMatrix = null;
	assert.equal( isObservedVelocityProjectionSource( state, projection ), true );
	assert.deepEqual( observedVelocityProjectionSources( state ), [ projection ] );

	const hostileState = new Proxy( {}, { get() { throw new Error( 'hostile getter' ); } } );
	assert.doesNotThrow( () => observeVelocityProjectionSources( hostileState ) );

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
	const projection = {};
	const state = {
		vertexShader: 'cached-vertex',
		fragmentShader: 'cached-fragment',
		updateNodes: [ { constructor: { type: 'VelocityNode' }, projectionMatrix: projection } ],
	};
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
	assert.deepEqual(
		family.variants[ 0 ].velocityProjectionSources,
		[ projection ],
		'request-time velocity identity survives the completed family boundary',
	);

} );

test( 'harvest keeps only the final one-way replacement RenderObject in one context', async () => {

	const { manager, renderer, renderObjects } = fixture();
	const staleCompute = { isNode: true, isComputeNode: true, isPrecompiledCompute: false };
	const currentCompute = { isNode: true, isComputeNode: true, isPrecompiledCompute: false };
	const geometryNode = {
		isNode: true,
		isShaderCallNodeInternal: true,
		shaderNode: { jsFunc() {} },
	};
	const material = { uuid: 'one-way-cache-churn', geometryNode };
	const object = { material };
	const scene = {};
	const camera = {};
	const lightsNode = {};
	const clippingContext = {};
	const context = { renderTarget: null, activeCubeFace: 0, activeMipmapLevel: 0, sampleCount: 1 };
	const sharedRenderObject = {
		material,
		object,
		scene,
		camera,
		lightsNode,
		clippingContext,
		context,
	};
	const staleRenderObject = {
		...sharedRenderObject,
		cacheKey: 'stale',
	};
	const currentRenderObject = { ...sharedRenderObject, cacheKey: 'current' };
	const staleState = { vertexShader: 'stale', updateBeforeNodes: [ staleCompute ] };
	const currentState = { vertexShader: 'current', updateBeforeNodes: [ currentCompute ] };
	manager.nodeBuilderCache.set( 'stale', staleState );
	manager.nodeBuilderCache.set( 'current', currentState );

	const session = beginRenderObjectHarvest( renderer );
	renderObjects.get( staleRenderObject );
	renderObjects.get( currentRenderObject );
	const harvest = await session.finish();
	const family = harvest.familiesByMaterial.get( material );

	assert.equal( harvest.requests.length, 2, 'raw request history remains intact' );
	assert.equal( family.complete, true );
	assert.equal( family.variants.length, 1 );
	assert.equal( family.variants[ 0 ].cacheKey, 'current' );
	assert.equal( family.variants[ 0 ].nodeBuilderState, currentState );
	assert.equal( family.variants[ 0 ].requestCount, 1 );
	assert.equal( findMaterialComputeNodePath( material, staleCompute ), null, 'superseded state has no deferred side effect' );
	assert.deepEqual(
		findMaterialComputeNodePath( material, currentCompute ),
		[ 'geometryNode', '_tslpMaterialComputeNodes', '0' ],
	);

} );

test( 'harvest preserves complete cached states with distinct raw selectors', async () => {

	const { manager, renderer, renderObjects } = fixture();
	const material = { uuid: 'selector-distinction' };
	const object = { material };
	const context = { renderTarget: null, activeCubeFace: 0, activeMipmapLevel: 0, sampleCount: 1 };
	const renderObject = { cacheKey: 'single-sample', material, object, context };
	manager.nodeBuilderCache.set( 'single-sample', { vertexShader: 'single-sample' } );
	manager.nodeBuilderCache.set( 'multisample', { vertexShader: 'multisample' } );

	const session = beginRenderObjectHarvest( renderer );
	renderObjects.get( renderObject );
	renderObject.cacheKey = 'multisample';
	context.sampleCount = 4;
	renderObjects.get( renderObject );
	const harvest = await session.finish();
	const family = harvest.familiesByMaterial.get( material );

	assert.equal( family.complete, true );
	assert.equal( family.variants.length, 2 );
	assert.equal(
		new Set( family.variants.flatMap( ( variant ) => variant.renderContextSelectors ) ).size,
		2,
		'sample topology remains an exact selector distinction',
	);

} );

test( 'harvest preserves identical selectors observed with different camera provenance', async () => {

	const { manager, renderer, renderObjects } = fixture();
	const material = { uuid: 'camera-provenance' };
	const object = { material };
	const renderObject = {
		cacheKey: 'first-camera',
		material,
		object,
		camera: {},
		context: { renderTarget: null, activeCubeFace: 0, activeMipmapLevel: 0, sampleCount: 1 },
	};
	manager.nodeBuilderCache.set( 'first-camera', { vertexShader: 'first-camera' } );
	manager.nodeBuilderCache.set( 'second-camera', { vertexShader: 'second-camera' } );

	const session = beginRenderObjectHarvest( renderer );
	renderObjects.get( renderObject );
	renderObject.cacheKey = 'second-camera';
	renderObject.camera = {};
	renderObjects.get( renderObject );
	const harvest = await session.finish();
	const family = harvest.familiesByMaterial.get( material );

	assert.equal( family.variants.length, 2 );
	assert.equal(
		family.variants[ 0 ].renderContextSelectors[ 0 ],
		family.variants[ 1 ].renderContextSelectors[ 0 ],
		'the provenance guard, not a selector difference, retains these states',
	);

} );

test( 'harvest preserves identical-selector siblings from distinct source render contexts', async () => {

	const { manager, renderer, renderObjects } = fixture();
	const material = { uuid: 'render-object-siblings' };
	const object = { material };
	const makeContext = () => ( { renderTarget: null, activeCubeFace: 0, activeMipmapLevel: 0, sampleCount: 1 } );
	const first = { cacheKey: 'sibling-a', material, object, context: makeContext() };
	const second = { cacheKey: 'sibling-b', material, object, context: makeContext() };
	manager.nodeBuilderCache.set( 'sibling-a', { vertexShader: 'sibling-a' } );
	manager.nodeBuilderCache.set( 'sibling-b', { vertexShader: 'sibling-b' } );

	const session = beginRenderObjectHarvest( renderer );
	renderObjects.get( first );
	renderObjects.get( second );
	const harvest = await session.finish();
	const family = harvest.familiesByMaterial.get( material );

	assert.equal( family.complete, true );
	assert.equal( family.variants.length, 2 );
	assert.equal(
		family.variants[ 0 ].renderContextSelectors[ 0 ],
		family.variants[ 1 ].renderContextSelectors[ 0 ],
	);

} );

test( 'harvest lets a final exact dispatch supersede compile-only context evidence', async () => {

	const { manager, renderer, renderObjects } = fixture();
	const material = { uuid: 'exact-warmup-owner' };
	const geometry = { attributes: {}, morphAttributes: {} };
	const object = { material, geometry };
	const scene = {};
	const camera = {};
	const lightsNode = {};
	const first = {
		cacheKey: 'compile-only',
		material,
		object,
		scene,
		camera,
		lightsNode,
		clippingContext: {},
		context: { renderTarget: null, activeCubeFace: 0, activeMipmapLevel: 0, sampleCount: 1 },
	};
	const second = {
		...first,
		cacheKey: 'exact-warmup',
		clippingContext: {},
		context: { renderTarget: null, activeCubeFace: 0, activeMipmapLevel: 0, sampleCount: 1 },
	};
	manager.nodeBuilderCache.set( 'compile-only', { vertexShader: 'compile-only' } );
	manager.nodeBuilderCache.set( 'exact-warmup', { vertexShader: 'exact-warmup' } );
	renderer.renderObject = function () { return renderObjects.get( second ); };
	const ownerEvidence = [];

	const session = beginRenderObjectHarvest( renderer, {
		onRequest: ( event ) => ownerEvidence.push( event.requestSnapshot.bindingOwnerExact ),
	} );
	renderObjects.get( first );
	renderer.renderObject( object, scene, camera, geometry, material, null, lightsNode, second.clippingContext );
	const family = ( await session.finish() ).familiesByMaterial.get( material );

	assert.deepEqual( ownerEvidence, [ false, true ] );
	assert.equal( family.complete, true );
	assert.equal( family.variants.length, 1 );
	assert.equal( family.variants[ 0 ].cacheKey, 'exact-warmup' );

} );

test( 'harvest preserves replacement-looking siblings without exact source context identity', async () => {

	const { manager, renderer, renderObjects } = fixture();
	const material = { uuid: 'missing-render-context' };
	const object = { material };
	const first = { cacheKey: 'unknown-context-a', material, object };
	const second = { cacheKey: 'unknown-context-b', material, object };
	manager.nodeBuilderCache.set( 'unknown-context-a', { vertexShader: 'unknown-context-a' } );
	manager.nodeBuilderCache.set( 'unknown-context-b', { vertexShader: 'unknown-context-b' } );

	const session = beginRenderObjectHarvest( renderer );
	renderObjects.get( first );
	renderObjects.get( second );
	const family = ( await session.finish() ).familiesByMaterial.get( material );

	assert.equal( family.complete, true );
	assert.equal( family.variants.length, 2 );

} );

test( 'harvest preserves an identical-selector family when any cached state is incomplete', async () => {

	const { manager, renderer, renderObjects } = fixture();
	const material = { uuid: 'incomplete-cache-churn' };
	const object = { material };
	const renderObject = {
		cacheKey: 'complete',
		material,
		object,
		context: { renderTarget: null, activeCubeFace: 0, activeMipmapLevel: 0, sampleCount: 1 },
	};
	manager.nodeBuilderCache.set( 'complete', { vertexShader: 'complete' } );

	const session = beginRenderObjectHarvest( renderer );
	renderObjects.get( renderObject );
	renderObject.cacheKey = 'incomplete';
	renderObjects.get( renderObject );
	const harvest = await session.finish();
	const family = harvest.familiesByMaterial.get( material );

	assert.equal( harvest.requests.length, 2 );
	assert.equal( family.complete, false );
	assert.equal( family.variants.length, 2 );
	assert.equal( family.variants.find( ( variant ) => variant.cacheKey === 'complete' ).complete, true );
	assert.equal( family.variants.find( ( variant ) => variant.cacheKey === 'incomplete' ).complete, false );

} );

test( 'harvest preserves oscillating identical-selector cache states', async () => {

	const { manager, renderer, renderObjects } = fixture();
	const material = { uuid: 'oscillating-cache-churn' };
	const object = { material };
	const renderObject = {
		cacheKey: 'state-a',
		material,
		object,
		context: { renderTarget: null, activeCubeFace: 0, activeMipmapLevel: 0, sampleCount: 1 },
	};
	manager.nodeBuilderCache.set( 'state-a', { vertexShader: 'state-a' } );
	manager.nodeBuilderCache.set( 'state-b', { vertexShader: 'state-b' } );

	const session = beginRenderObjectHarvest( renderer );
	renderObjects.get( renderObject );
	renderObject.cacheKey = 'state-b';
	renderObjects.get( renderObject );
	renderObject.cacheKey = 'state-a';
	renderObjects.get( renderObject );
	const harvest = await session.finish();
	const family = harvest.familiesByMaterial.get( material );

	assert.equal( harvest.requests.length, 3 );
	assert.equal( family.complete, true );
	assert.equal( family.variants.length, 2, 'A-B-A is not a one-way supersession' );
	assert.equal( family.variants.find( ( variant ) => variant.cacheKey === 'state-a' ).requestCount, 2 );

} );

test( 'complete cube-target state publishes canonical aliases for all faces without relaxing mip or format', async () => {

	const { manager, renderer, renderObjects } = fixture();
	const state = { vertexShader: 'cube-vertex', fragmentShader: 'cube-fragment' };
	const texture = { isCubeTexture: true, format: 1023, type: 1016, colorSpace: 'srgb-linear' };
	const renderTarget = {
		isCubeRenderTarget: true,
		texture,
		textures: [ texture ],
		depthBuffer: true,
		stencilBuffer: false,
	};
	const material = { uuid: 'verified-cube-material' };
	const renderObject = {
		cacheKey: 94,
		material,
		object: { material },
		context: {
			renderTarget,
			textures: [ texture ],
			activeCubeFace: 3,
			activeMipmapLevel: 2,
			sampleCount: 1,
		},
	};
	manager.nodeBuilderCache.set( renderObject.cacheKey, state );
	const session = beginRenderObjectHarvest( renderer );
	renderObjects.get( renderObject );
	const harvest = await session.finish();
	const variant = harvest.familiesByMaterial.get( material ).variants[ 0 ];
	const selectors = variant.renderContextSelectors.map( ( selector ) => JSON.parse( selector ) );

	assert.equal( variant.complete, true );
	assert.equal( variant.nodeBuilderState, state, 'every alias belongs to the one proven complete builder state' );
	assert.deepEqual( selectors.map( ( selector ) => selector.target.activeCubeFace ), [ 0, 1, 2, 3, 4, 5 ] );
	assert.ok( selectors.every( ( selector ) => selector.target.activeMipmapLevel === 2 ) );
	assert.ok( selectors.every( ( selector ) => selector.target.colors[ 0 ].format === 1023 ) );
	assert.equal( new Set( variant.renderContextSelectors ).size, 6, 'aliases remain canonical and unique' );

} );

test( 'ordinary 2d targets and cube-texture flags without a cube target do not gain face aliases', async () => {

	for ( const [ label, texture ] of [
		[ 'ordinary-2d', { isRenderTargetTexture: true, format: 1023 } ],
		[ 'cube-texture-only', { isCubeTexture: true, format: 1023 } ],
	] ) {

		const { manager, renderer, renderObjects } = fixture();
		const state = { vertexShader: `${ label }-vertex`, fragmentShader: `${ label }-fragment` };
		const renderTarget = { isRenderTarget: true, texture, textures: [ texture ] };
		const material = { uuid: `${ label }-material` };
		const renderObject = {
			cacheKey: label,
			material,
			object: { material },
			context: {
				renderTarget,
				textures: [ texture ],
				activeCubeFace: 4,
				activeMipmapLevel: 1,
				sampleCount: 1,
			},
		};
		manager.nodeBuilderCache.set( renderObject.cacheKey, state );
		const session = beginRenderObjectHarvest( renderer );
		renderObjects.get( renderObject );
		const harvest = await session.finish();
		const variant = harvest.familiesByMaterial.get( material ).variants[ 0 ];

		assert.equal( variant.complete, true );
		assert.equal( variant.renderContextSelectors.length, 1, label );
		assert.equal( JSON.parse( variant.renderContextSelectors[ 0 ] ).target.activeCubeFace, 4, label );

	}

} );

test( 'harvest publishes a closure-hidden compute kernel under one exact deferred material path', async () => {

	const { manager, renderer, renderObjects } = fixture();
	const computeNode = { isNode: true, isComputeNode: true, isPrecompiledCompute: false };
	const geometryNode = {
		isNode: true,
		isShaderCallNodeInternal: true,
		shaderNode: { jsFunc() {} },
	};
	const material = { uuid: 'deferred-compute-material', geometryNode };
	const state = { updateBeforeNodes: [ computeNode ] };
	manager.nodeBuilderCache.set( 92, state );
	const renderObject = {
		cacheKey: 92,
		material,
		object: { material },
		context: { renderTarget: null, activeCubeFace: 0, activeMipmapLevel: 0, sampleCount: 1 },
	};
	const session = beginRenderObjectHarvest( renderer );
	renderObjects.get( renderObject );
	await session.finish();

	assert.deepEqual(
		findMaterialComputeNodePath( material, computeNode ),
		[ 'geometryNode', '_tslpMaterialComputeNodes', '0' ],
	);
	assert.equal( Object.prototype.propertyIsEnumerable.call( geometryNode, '_tslpMaterialComputeNodes' ), false );

} );

test( 'harvest leaves multiple deferred roots unresolved instead of guessing ownership', async () => {

	const { manager, renderer, renderObjects } = fixture();
	const computeNode = { isNode: true, isComputeNode: true, isPrecompiledCompute: false };
	const deferredRoot = () => ( {
		isNode: true,
		isShaderCallNodeInternal: true,
		shaderNode: { jsFunc() {} },
	} );
	const material = { uuid: 'ambiguous-deferred-compute', geometryNode: deferredRoot(), colorNode: deferredRoot() };
	manager.nodeBuilderCache.set( 93, { updateBeforeNodes: [ computeNode ] } );
	const renderObject = {
		cacheKey: 93,
		material,
		object: { material },
		context: { renderTarget: null, activeCubeFace: 0, activeMipmapLevel: 0, sampleCount: 1 },
	};
	const session = beginRenderObjectHarvest( renderer );
	renderObjects.get( renderObject );
	await session.finish();

	assert.equal( findMaterialComputeNodePath( material, computeNode ), null );

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

test( 'render dispatch captures the exact pre-shadow material, geometry, and group', async () => {

	const { renderer, renderObjects } = fixture();
	const firstMaterial = { uuid: 'first-caster' };
	const selectedMaterial = { uuid: 'selected-caster', castShadowNode: { isNode: true } };
	const materialSet = [ firstMaterial, selectedMaterial ];
	const staleGeometry = { attributes: { position: { itemSize: 3 } }, morphAttributes: {} };
	const selectedGeometry = {
		attributes: {
			position: { itemSize: 3 },
			color: { itemSize: 4 },
		},
		morphAttributes: {},
	};
	const object = { material: materialSet, geometry: staleGeometry };
	const staleGroup = { start: 90, count: 3, materialIndex: 0 };
	const selectedGroup = { start: 6, count: 12, materialIndex: 1 };
	const shadowMaterial = { uuid: 'shadow-pass', isShadowPassMaterial: true };
	const renderObject = {
		cacheKey: 71,
		material: shadowMaterial,
		object,
		group: staleGroup,
		context: {},
		_nodeBuilderState: { vertexShader: 'shadow' },
	};
	const originalRenderObject = function () { return renderObjects.get( renderObject ); };
	renderer.renderObject = originalRenderObject;
	const requestEvents = [];
	const session = beginRenderObjectHarvest( renderer, {
		onRequest: ( event ) => requestEvents.push( event ),
	} );
	assert.equal(
		renderer.renderObject( object, { uuid: 'scene' }, { uuid: 'camera' }, selectedGeometry, selectedMaterial, selectedGroup ),
		renderObject,
	);
	selectedGroup.start = 999;
	selectedGroup.materialIndex = 0;
	const harvest = await session.finish();

	assert.equal( renderer.renderObject, originalRenderObject, 'last observer restores the renderer entry point' );
	const snapshot = requestEvents[ 0 ].requestSnapshot;
	assert.equal( snapshot.sourceObject, object );
	assert.equal( snapshot.sourceMaterial, selectedMaterial );
	assert.equal( snapshot.userMaterial, selectedMaterial );
	assert.equal( snapshot.sourceMaterialSet, materialSet );
	assert.equal( Array.isArray( snapshot.sourceMaterial ), false, 'selected owner is never the material array' );
	assert.equal( snapshot.sourceGeometry, selectedGeometry );
	assert.equal( snapshot.sourceGroup, selectedGroup, 'live group remains harvest-only evidence' );
	assert.notEqual( snapshot.group, selectedGroup );
	assert.deepEqual( snapshot.group, { start: 6, count: 12, materialIndex: 1 }, 'selector uses copied request-time scalars' );
	assert.equal( snapshot.bindingOwnerKind, RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER );
	assert.equal( snapshot.bindingOwnerExact, true );
	const selector = JSON.parse( snapshot.renderContextSelector );
	assert.equal( selector.shadowCaster.color.castShadowNode, true );
	assert.deepEqual( selector.object.geometry.attributes.map( ( entry ) => entry[ 0 ] ), [ 'color', 'position' ] );

	const variant = harvest.familiesByMaterial.get( shadowMaterial ).variants[ 0 ];
	assert.deepEqual( variant.sourceMaterials, [ selectedMaterial ] );
	assert.deepEqual( variant.userMaterials, [ selectedMaterial ] );
	assert.equal( variant.sourceOwnerRequests.length, 1 );
	assert.equal( variant.sourceOwnerRequests[ 0 ], snapshot );

} );

test( 'nested render dispatches keep exact ownership scoped to the innermost call', () => {

	const { renderer, renderObjects } = fixture();
	const outerMaterial = { uuid: 'outer' };
	const innerMaterial = { uuid: 'inner' };
	const outerObject = { material: outerMaterial };
	const innerObject = { material: innerMaterial };
	const shadowMaterial = { uuid: 'shared-shadow', isShadowPassMaterial: true };
	const renderObjectBySource = new Map( [
		[ outerObject, { cacheKey: 1, material: shadowMaterial, object: outerObject, context: {} } ],
		[ innerObject, { cacheKey: 2, material: shadowMaterial, object: innerObject, context: {} } ],
	] );
	renderer.renderObject = function ( object, scene, camera, geometry, material, group ) {

		if ( object === outerObject ) renderer.renderObject( innerObject, scene, camera, geometry, innerMaterial, group );
		return renderObjects.get( renderObjectBySource.get( object ) );

	};
	const events = [];
	const stop = observeRenderObjectRequests( renderer, ( event ) => events.push( event ) );
	renderer.renderObject( outerObject, {}, {}, {}, outerMaterial, null );
	stop();

	assert.deepEqual( events.map( ( event ) => event.requestSnapshot.sourceMaterial ), [ innerMaterial, outerMaterial ] );
	assert.deepEqual( events.map( ( event ) => event.requestSnapshot.sourceObject ), [ innerObject, outerObject ] );

} );

test( 'shadow snapshots reject mismatched dispatches and never treat the override as caster fallback', () => {

	const shadowMaterial = { uuid: 'shadow-pass', isShadowPassMaterial: true };
	const sourceObject = { material: null };
	const wrongMaterial = { uuid: 'wrong-caster' };
	const wrongObject = { material: wrongMaterial };
	const renderObject = { material: shadowMaterial, object: sourceObject, group: null, context: {} };
	const mismatched = snapshotRenderObjectRequest( renderObject, {}, 4, {
		object: wrongObject,
		scene: {},
		camera: {},
		geometry: {},
		material: wrongMaterial,
		group: { materialIndex: 0 },
	} );

	assert.equal( mismatched.sourceObject, sourceObject );
	assert.equal( mismatched.sourceMaterial, null );
	assert.equal( mismatched.userMaterial, null );
	assert.equal( mismatched.bindingOwnerExact, false );
	assert.equal( mismatched.bindingOwnerKind, RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER );

	const missingCaster = snapshotRenderObjectRequest( renderObject, {}, 4 );
	assert.equal( missingCaster.sourceMaterial, null, 'active renderer-owned shadow material is not a caster binding owner' );
	assert.equal( missingCaster.bindingOwnerExact, false );

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

test( 'render dispatch observer preserves an external replacement and stays single-delivery on resubscribe', () => {

	const { renderObjects, renderer } = fixture();
	const material = { uuid: 'dispatch-material' };
	const object = { material };
	const renderObject = { cacheKey: 3, material, object, context: {} };
	const originalRenderObject = function () { return renderObjects.get( renderObject ); };
	renderer.renderObject = originalRenderObject;
	const firstEvents = [];
	const stopFirst = observeRenderObjectRequests( renderer, ( event ) => firstEvents.push( event ) );
	const observedDispatch = renderer.renderObject;
	const external = function ( ...args ) { return observedDispatch.apply( this, args ); };
	renderer.renderObject = external;
	renderer.renderObject( object, {}, {}, {}, material, null );
	assert.equal( firstEvents.length, 1 );
	stopFirst();
	assert.equal( renderer.renderObject, external, 'cleanup never overwrites the external replacement' );
	renderer.renderObject( object, {}, {}, {}, material, null );
	assert.equal( firstEvents.length, 1, 'the retained inner wrapper is inert after cleanup' );

	const secondEvents = [];
	const stopSecond = observeRenderObjectRequests( renderer, ( event ) => secondEvents.push( event ) );
	renderer.renderObject( object, {}, {}, {}, material, null );
	assert.equal( secondEvents.length, 1, 'a later capture still receives one request' );
	assert.equal( secondEvents[ 0 ].requestSnapshot.bindingOwnerExact, true );
	stopSecond();
	assert.equal( renderer.renderObject, external );

} );

test( 'request observer reuses an active legacy HMR wrapper in fail-closed mode', () => {

	const { renderObjects, renderer } = fixture();
	const registry = Symbol.for( '@tsl-precompile/plugin/render-object-request-observer@1' );
	const original = renderObjects.get;
	let legacyCalls = 0;
	const legacyState = {
		version: 1,
		original,
		listeners: new Set( [ () => { legacyCalls ++; } ] ),
		wrapper: null,
	};
	legacyState.wrapper = function ( ...args ) {

		const renderObject = legacyState.original.apply( this, args );
		const event = { renderObject, cacheKey: renderObject.cacheKey, nodeBuilderState: null, requestSnapshot: null };
		for ( const listener of [ ...legacyState.listeners ] ) listener( event );
		return renderObject;

	};
	Object.defineProperty( renderObjects, registry, { value: legacyState, configurable: true } );
	renderObjects.get = legacyState.wrapper;
	const events = [];
	const stop = observeRenderObjectRequests( renderer, ( event ) => events.push( event ) );
	assert.equal( renderObjects.get, legacyState.wrapper, 'HMR handoff does not stack another private-method wrapper' );
	renderObjects.get( { cacheKey: 8 } );
	assert.equal( legacyCalls, 1 );
	assert.equal( events.length, 1 );
	stop();
	assert.equal( renderObjects.get, legacyState.wrapper, 'the active legacy listener still owns its wrapper' );
	legacyState.listeners.clear();
	renderObjects.get = original;
	delete renderObjects[ registry ];

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
