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
	const stopRequests = observeRenderObjectRequests( renderer, () => {} );
	renderObjects.get( renderObject );
	stopRequests();
	liveVelocity.projectionMatrix = null;
	cachedVelocity.projectionMatrix = null;

	assert.equal( isObservedVelocityProjectionSource( liveState, liveProjection ), true );
	assert.equal( isObservedVelocityProjectionSource( cachedState, cachedProjection ), true );
	assert.equal( isObservedVelocityProjectionSource( liveState, {} ), false );

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
