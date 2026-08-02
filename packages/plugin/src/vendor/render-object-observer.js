/**
 * Dev-only adapters around Three's private NodeManager.getForRender and
 * RenderObjects.get seams.
 *
 * All consumers subscribe through one Symbol-backed wrapper so live capture,
 * compileTSL, duplicate plugin copies, and HMR cannot stack competing method
 * replacements. The original return value is passed through unchanged.
 */

import { createRenderObjectContextSelector, resolveRenderObjectBindingOwner } from '@tsl-precompile/contract/render-selector';
import { attachDeferredMaterialComputeStatePaths } from '@tsl-precompile/contract/material-compute';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';
import { observeVelocityProjectionSources, observedVelocityProjectionSources } from '../velocity-projection-observation.js';

const OBSERVER_STATE = Symbol.for( '@tsl-precompile/plugin/render-object-observer@1' );
const REQUEST_OBSERVER_STATE = Symbol.for( '@tsl-precompile/plugin/render-object-request-observer@1' );
const RENDER_DISPATCH_STATE = Symbol.for( '@tsl-precompile/plugin/render-object-dispatch-observer@1' );
let nextHarvestEpoch = 1;

function observeRenderDispatches( renderer ) {

	if ( ! renderer || typeof renderer.renderObject !== 'function' ) return null;
	let state = renderer[ RENDER_DISPATCH_STATE ];
	if ( state && state.version === 1 && renderer.renderObject === state.wrapper ) {

		state.references ++;
		return state;

	}
	const original = renderer.renderObject;
	const hadOwnRenderObject = Object.prototype.hasOwnProperty.call( renderer, 'renderObject' );
	const originalDescriptor = hadOwnRenderObject ? Object.getOwnPropertyDescriptor( renderer, 'renderObject' ) : null;
	state = {
		version: 1,
		original,
		hadOwnRenderObject,
		originalDescriptor,
		wrapper: null,
		stack: [],
		references: 1,
	};
	state.wrapper = function observedRenderObjectDispatch( object, scene, camera, geometry, material, group, ...args ) {

		state.stack.push( { object, scene, camera, geometry, material, group: group || null } );
		try {

			return state.original.call( this, object, scene, camera, geometry, material, group, ...args );

		} finally {

			state.stack.pop();

		}

	};
	Object.defineProperty( renderer, RENDER_DISPATCH_STATE, {
		value: state,
		configurable: true,
	} );
	renderer.renderObject = state.wrapper;
	return state;

}

function releaseRenderDispatches( renderer, state ) {

	if ( ! state ) return;
	state.references --;
	if ( state.references > 0 ) return;
	if ( renderer.renderObject === state.wrapper ) {

		if ( state.hadOwnRenderObject && state.originalDescriptor ) Object.defineProperty( renderer, 'renderObject', state.originalDescriptor );
		else delete renderer.renderObject;

	}
	if ( renderer[ RENDER_DISPATCH_STATE ] === state ) {

		try { delete renderer[ RENDER_DISPATCH_STATE ]; } catch ( _ ) {}

	}

}

function currentRenderDispatch( state ) {

	return state && state.stack.length > 0 ? state.stack[ state.stack.length - 1 ] : null;

}

/**
 * @param {Object} renderer
 * @param {(event: { renderObject: Object, cacheKey: *, nodeBuilderState: * }) => void} listener
 * @returns {() => void}
 */
export function observeRenderObjects( renderer, listener ) {

	if ( typeof listener !== 'function' ) throw new TypeError( 'observeRenderObjects: listener must be a function.' );
	const manager = renderer && renderer._nodes;
	if ( ! manager || typeof manager.getForRender !== 'function' ) return () => {};

	let state = manager[ OBSERVER_STATE ];
	if ( ! state || state.version !== 1 || manager.getForRender !== state.wrapper ) {

		const original = manager.getForRender;
		state = {
			version: 1,
			original,
			listeners: new Set(),
			wrapper: null,
		};
		state.wrapper = function observedGetForRender( renderObject, ...args ) {

			let cacheKey = null;
			if ( typeof this.getForRenderCacheKey === 'function' ) {

				try { cacheKey = this.getForRenderCacheKey( renderObject ); } catch ( _ ) {}

			}
			const nodeBuilderState = state.original.call( this, renderObject, ...args );
			observeVelocityProjectionSources( nodeBuilderState );
			const event = { kind: 'node-builder-state', renderObject, cacheKey, nodeBuilderState };
			for ( const subscriber of [ ...state.listeners ] ) {

				// Instrumentation must never turn a successful Three render into a
				// failure. Capture consumers surface their own diagnostics later.
				try { subscriber( event ); } catch ( _ ) {}

			}
			return nodeBuilderState;

		};
		Object.defineProperty( manager, OBSERVER_STATE, {
			value: state,
			configurable: true,
		} );
		manager.getForRender = state.wrapper;

	}

	state.listeners.add( listener );
	let active = true;
	return () => {

		if ( ! active ) return;
		active = false;
		state.listeners.delete( listener );
		if ( state.listeners.size > 0 ) return;
		if ( manager.getForRender === state.wrapper ) manager.getForRender = state.original;
		if ( manager[ OBSERVER_STATE ] === state ) {

			try { delete manager[ OBSERVER_STATE ]; } catch ( _ ) {}

		}

	};

}

/**
 * Observe every renderer request for a RenderObject, including an object whose
 * NodeBuilderState is already cached and therefore no longer flows through
 * NodeManager.getForRender. This is needed to correlate Three's private output
 * quad with its exact accumulated cache entry without invalidating pipelines.
 *
 * @param {Object} renderer
 * @param {(event: { renderObject: Object, cacheKey: *, nodeBuilderState: * }) => void} listener
 * @returns {() => void}
 */
export function observeRenderObjectRequests( renderer, listener ) {

	if ( typeof listener !== 'function' ) throw new TypeError( 'observeRenderObjectRequests: listener must be a function.' );
	const renderObjects = renderer && renderer._objects;
	const manager = renderer && renderer._nodes;
	if ( ! renderObjects || typeof renderObjects.get !== 'function' ||
		! manager || typeof manager.getForRenderCacheKey !== 'function' ) return () => {};

	let state = renderObjects[ REQUEST_OBSERVER_STATE ];
	if ( ! state || ( state.version !== 1 && state.version !== 2 ) || renderObjects.get !== state.wrapper ) {

		const original = renderObjects.get;
		const dispatchState = observeRenderDispatches( renderer );
		state = {
			version: 2,
			original,
			dispatchState,
			listeners: new Set(),
			wrapper: null,
		};
		state.wrapper = function observedRenderObjectRequest( ...args ) {

			const renderObject = state.original.apply( this, args );
			let cacheKey = null;
			try { cacheKey = manager.getForRenderCacheKey( renderObject ); } catch ( _ ) {}
			let nodeBuilderState = renderObject && renderObject._nodeBuilderState || null;
			if ( ! nodeBuilderState && cacheKey !== null && cacheKey !== undefined &&
				manager.nodeBuilderCache && typeof manager.nodeBuilderCache.get === 'function' ) {

				try { nodeBuilderState = manager.nodeBuilderCache.get( cacheKey ) || null; } catch ( _ ) {}

			}
			observeVelocityProjectionSources( nodeBuilderState );
			const requestSnapshot = snapshotRenderObjectRequest(
				renderObject,
				renderer,
				cacheKey,
				currentRenderDispatch( state.dispatchState ),
				nodeBuilderState,
			);
			const event = {
				kind: 'render-object-request',
				renderObject,
				cacheKey,
				nodeBuilderState,
				requestSnapshot,
			};
			for ( const subscriber of [ ...state.listeners ] ) {

				try { subscriber( event ); } catch ( _ ) {}

			}
			return renderObject;

		};
		Object.defineProperty( renderObjects, REQUEST_OBSERVER_STATE, {
			value: state,
			configurable: true,
		} );
		renderObjects.get = state.wrapper;

	}

	state.listeners.add( listener );
	let active = true;
	return () => {

		if ( ! active ) return;
		active = false;
		state.listeners.delete( listener );
		if ( state.listeners.size > 0 ) return;
		if ( renderObjects.get === state.wrapper ) renderObjects.get = state.original;
		releaseRenderDispatches( renderer, state.dispatchState );
		if ( renderObjects[ REQUEST_OBSERVER_STATE ] === state ) {

			try { delete renderObjects[ REQUEST_OBSERVER_STATE ]; } catch ( _ ) {}

		}

	};

}

/**
 * Copy the mutable part of a Three RenderObject at `_objects.get()` return
 * time. RenderContext instances are reused and relabelled for every cube face
 * and mip, so keeping the RenderObject reference and describing it after the
 * render silently assigns every observation the final face/mip.
 *
 * Object, material, scene, camera, and texture identities intentionally remain
 * live references: extraction needs them to classify uniforms. The canonical
 * selector and scalar target topology are immutable request-time evidence.
 *
 * @param {?Object} renderObject
 * @param {?Object} renderer
 * @param {*} cacheKey
 * @param {?{object: Object, scene: Object, camera: Object, geometry: Object, material: Object, group: Object}} renderDispatch
 * @param {?Object} nodeBuilderState
 * @returns {Object|null}
 */
export function snapshotRenderObjectRequest( renderObject, renderer, cacheKey = null, renderDispatch = null, nodeBuilderState = null ) {

	if ( ! renderObject ) return null;
	const context = safeRead( renderObject, 'context' ) || null;
	const snapshotRenderer = safeRead( renderObject, 'renderer' ) || renderer || null;
	const renderObjectObject = safeRead( renderObject, 'object' ) || null;
	const matchingDispatch = renderDispatch && ( ! renderObjectObject || renderObjectObject === renderDispatch.object ) ? renderDispatch : null;
	const snapshotObject = matchingDispatch && matchingDispatch.object || renderObjectObject;
	const snapshotMaterial = safeRead( renderObject, 'material' ) || null;
	const snapshotScene = matchingDispatch && matchingDispatch.scene || safeRead( renderObject, 'scene' ) || null;
	const snapshotCamera = matchingDispatch && matchingDispatch.camera || safeRead( renderObject, 'camera' ) || null;
	const snapshotLightsNode = safeRead( renderObject, 'lightsNode' ) || null;
	const snapshotClippingContext = safeRead( renderObject, 'clippingContext' ) || null;
	const liveGroup = matchingDispatch ? matchingDispatch.group : safeRead( renderObject, 'group' ) || null;
	const snapshotGroup = copyRenderGroup( liveGroup );
	const sourceMaterialSet = safeRead( snapshotObject, 'material' ) || null;
	const fallbackMaterialIndex = safeRead( snapshotGroup, 'materialIndex' );
	const fallbackSourceMaterial = Array.isArray( sourceMaterialSet )
		? Number.isInteger( fallbackMaterialIndex ) && fallbackMaterialIndex >= 0 ? sourceMaterialSet[ fallbackMaterialIndex ] || null : null
		: sourceMaterialSet;
	const isShadowPass = safeRead( snapshotMaterial, 'isShadowPassMaterial' ) === true;
	const sourceMaterial = matchingDispatch && matchingDispatch.material || fallbackSourceMaterial || ( isShadowPass ? null : snapshotMaterial );
	const sourceGeometry = matchingDispatch && matchingDispatch.geometry || safeRead( snapshotObject, 'geometry' ) || null;
	// Read reused RenderContext primitives before *any* renderer callback. A
	// custom getter is allowed to trigger nested work and mutate this context.
	const observedRenderTarget = safeRead( context, 'renderTarget' );
	const observedActiveCubeFace = safeRead( context, 'activeCubeFace' );
	const observedActiveMipmapLevel = safeRead( context, 'activeMipmapLevel' );
	const observedMRT = safeRead( context, 'mrt' );
	const observedSampleCount = safeRead( context, 'sampleCount' );
	const observedTextures = safeRead( context, 'textures' );
	const observedDepthTexture = safeRead( context, 'depthTexture' );
	const observedColor = safeRead( context, 'color' );
	const observedDepth = safeRead( context, 'depth' );
	const observedStencil = safeRead( context, 'stencil' );
	const observedMultiview = safeRead( context, 'multiview' );
	const nodeFrame = renderer && safeRead( safeRead( renderer, '_nodes' ), 'nodeFrame' );
	const captureClock = Number.isFinite( safeRead( nodeFrame, 'time' ) ) ? nodeFrame.time : null;
	const renderTarget = observedRenderTarget === undefined ? safeCall( renderer, 'getRenderTarget' ) : observedRenderTarget;
	const activeCubeFace = firstFinite( [
		observedActiveCubeFace,
		safeRead( renderer, '_activeCubeFace' ),
		safeCall( renderer, 'getActiveCubeFace' ),
	], 0 );
	const activeMipmapLevel = firstFinite( [
		observedActiveMipmapLevel,
		safeRead( renderer, '_activeMipmapLevel' ),
		safeCall( renderer, 'getActiveMipmapLevel' ),
	], 0 );
	const textures = Array.isArray( observedTextures ) ? Object.freeze( observedTextures.slice() ) : observedTextures || null;
	const renderContext = Object.freeze( {
		renderTarget,
		activeCubeFace,
		activeMipmapLevel,
		sampleCount: observedSampleCount,
		mrt: observedMRT === undefined ? safeCall( renderer, 'getMRT' ) : observedMRT,
		textures,
		depthTexture: observedDepthTexture || null,
		color: observedColor,
		depth: observedDepth,
		stencil: observedStencil,
		multiview: observedMultiview,
	} );
	const snapshotRenderObject = {
		renderer: snapshotRenderer,
		object: snapshotObject,
		material: snapshotMaterial,
		scene: snapshotScene,
		camera: snapshotCamera,
		lightsNode: snapshotLightsNode,
		clippingContext: snapshotClippingContext,
		group: snapshotGroup,
		sourceMaterial,
		sourceGeometry,
		context: renderContext,
	};
	const bindingOwner = resolveRenderObjectBindingOwner( snapshotRenderObject, sourceMaterial );
	let renderContextSelector = '';
	try { renderContextSelector = createRenderObjectContextSelector( snapshotRenderObject, renderer ); } catch ( _ ) {}

	const object = snapshotRenderObject.object;
	return Object.freeze( {
		cacheKey,
		renderObject,
		object,
		material: snapshotRenderObject.material,
		sourceObject: snapshotObject,
		sourceMaterial: bindingOwner.material,
		sourceMaterialSet,
		sourceGeometry,
		sourceGroup: liveGroup,
		bindingOwnerKind: bindingOwner.kind,
		bindingOwnerExact: !! ( matchingDispatch && matchingDispatch.material ),
		// Backward-compatible harvest alias. Unlike the old value this is the
		// exact selected material and never the full object.material array.
		userMaterial: bindingOwner.material,
		scene: snapshotRenderObject.scene,
		camera: snapshotRenderObject.camera,
		lightsNode: snapshotRenderObject.lightsNode,
		clippingContext: snapshotRenderObject.clippingContext,
		group: snapshotRenderObject.group,
		renderContext,
		renderContextSelector,
		captureClock,
		velocityProjectionSources: Object.freeze( observedVelocityProjectionSources( nodeBuilderState ) ),
	} );

}

/**
 * Observe one bounded render epoch and join every RenderObjects.get request to
 * its NodeBuilderState by active material identity plus Three's cache key.
 * Cached requests are included even when NodeManager.getForRender is skipped;
 * asynchronous states are resolved without changing Three's returned Promise.
 *
 * A material family is complete only when every requested sibling has an
 * exact cache key, one unambiguous builder state, and request-time selector.
 * Consumers must use a complete family atomically or fall back atomically.
 *
 * @param {Object} renderer
 * @param {{onRequest?: Function, onState?: Function}} [callbacks]
 * @returns {{epoch: number, supported: boolean, finish: () => Promise<Object>}}
 */
export function beginRenderObjectHarvest( renderer, callbacks = {} ) {

	const epoch = nextHarvestEpoch ++;
	const requests = [];
	const requestOrdinals = new WeakMap();
	// r185 replaces a RenderObject when its immutable initialCacheKey changes.
	// Retain the live context-chain identity privately so replacement siblings
	// can be distinguished from equal-looking requests in separate contexts.
	const requestRenderContexts = new WeakMap();
	const pairsByMaterial = new Map();
	const pending = new Set();
	const supported = !! (
		renderer && renderer._objects && typeof renderer._objects.get === 'function' &&
		renderer._nodes && typeof renderer._nodes.getForRender === 'function' &&
		typeof renderer._nodes.getForRenderCacheKey === 'function'
	);
	let active = true;
	let finished = null;

	const getPair = ( material, cacheKey, create ) => {

		let pairs = pairsByMaterial.get( material );
		if ( ! pairs && create ) {

			pairs = new Map();
			pairsByMaterial.set( material, pairs );

		}
		if ( ! pairs ) return null;
		const pairKey = cacheKey === null || cacheKey === undefined ? Symbol( 'missing-cache-key' ) : cacheKey;
		let pair = pairs.get( pairKey );
		if ( ! pair && create ) {

			pair = {
				cacheKey,
				requests: [],
				nodeBuilderState: null,
				ambiguousState: false,
				stateErrors: [],
			};
			pairs.set( pairKey, pair );

		}
		return pair;

	};

	const storeResolvedState = ( pair, nodeBuilderState ) => {

		if ( ! nodeBuilderState ) return;
		if ( pair.nodeBuilderState === null ) pair.nodeBuilderState = nodeBuilderState;
		else if ( pair.nodeBuilderState !== nodeBuilderState ) pair.ambiguousState = true;

	};

	const correlateState = ( pair, nodeBuilderState ) => {

		if ( ! pair || ! nodeBuilderState ) return;
		if ( typeof nodeBuilderState.then !== 'function' ) {

			storeResolvedState( pair, nodeBuilderState );
			return;

		}
		const resolution = Promise.resolve( nodeBuilderState ).then(
			( state ) => storeResolvedState( pair, state ),
			( error ) => { pair.stateErrors.push( error ); },
		);
		pending.add( resolution );
		resolution.finally( () => pending.delete( resolution ) );

	};

	const onRequest = ( event ) => {

		const snapshot = event.requestSnapshot || snapshotRenderObjectRequest( event.renderObject, renderer, event.cacheKey );
		if ( ! snapshot ) return;
		requestOrdinals.set( snapshot, requests.length );
		requestRenderContexts.set( snapshot, safeRead( event.renderObject, 'context' ) || null );
		requests.push( snapshot );
		const pair = getPair( snapshot.material, snapshot.cacheKey, true );
		pair.requests.push( snapshot );
		correlateState( pair, event.nodeBuilderState );
		if ( typeof callbacks.onRequest === 'function' ) {

			try { callbacks.onRequest( event ); } catch ( _ ) {}

		}

	};

	const onState = ( event ) => {

		const renderObject = event.renderObject;
		const material = renderObject && safeRead( renderObject, 'material' ) || null;
		const pair = getPair( material, event.cacheKey, true );
		correlateState( pair, event.nodeBuilderState );
		if ( typeof callbacks.onState === 'function' ) {

			try { callbacks.onState( event ); } catch ( _ ) {}

		}

	};

	const stopRequests = observeRenderObjectRequests( renderer, onRequest );
	const stopStates = observeRenderObjects( renderer, onState );

	const finish = () => {

		if ( finished ) return finished;
		active = false;
		stopRequests();
		stopStates();
		finished = Promise.allSettled( [ ...pending ] ).then( () => (
			buildHarvestResult( epoch, supported, renderer, requests, requestOrdinals, requestRenderContexts, pairsByMaterial )
		) );
		return finished;

	};

	return Object.freeze( {
		epoch,
		supported,
		renderer,
		get active() { return active; },
		finish,
	} );

}

function buildHarvestResult( epoch, supported, renderer, requests, requestOrdinals, requestRenderContexts, pairsByMaterial ) {

	const familiesByMaterial = new Map();
	const familiesByMaterialUuid = new Map();
	for ( const [ material, pairs ] of pairsByMaterial ) {

		const requestedPairs = [ ...pairs.values() ].filter( ( pair ) => pair.requests.length > 0 );
		if ( requestedPairs.length === 0 ) continue;
		const records = requestedPairs.map( ( pair ) => {

			const exactRequests = pair.requests.filter( ( request ) => request.bindingOwnerExact );
			const authoritativeRequests = exactRequests.length > 0 ? exactRequests : pair.requests;
			const objects = [ ...new Set( authoritativeRequests.map( ( request ) => request.object ).filter( Boolean ) ) ];
			const sourceOwnerRequests = authoritativeRequests.filter( ( request ) => request.sourceMaterial || request.userMaterial );
			const sourceMaterials = [ ...new Set( sourceOwnerRequests.map( ( request ) =>
				request.sourceMaterial || ( ! Array.isArray( request.userMaterial ) ? request.userMaterial : null )
			).filter( Boolean ) ) ];
			const captureClocks = [ ...new Set( authoritativeRequests.map( ( request ) => request.captureClock ).filter( Number.isFinite ) ) ];
			const velocityProjectionSources = [ ...new Set( authoritativeRequests.flatMap( ( request ) =>
				Array.isArray( request.velocityProjectionSources ) ? request.velocityProjectionSources : []
			) ) ];
			const missingSelector = authoritativeRequests.some( ( request ) => ! request.renderContextSelector );
			const complete = pair.cacheKey !== null && pair.cacheKey !== undefined &&
				pair.nodeBuilderState !== null && pair.ambiguousState === false &&
				pair.stateErrors.length === 0 && missingSelector === false;
			const selectors = [ ...new Set( authoritativeRequests.flatMap( ( request ) =>
				complete ? renderContextSelectorAliases( request ) : request.renderContextSelector ? [ request.renderContextSelector ] : []
			) ) ].sort();
			const ordinals = authoritativeRequests.map( ( request ) => requestOrdinals.get( request ) );
			return {
				cacheKey: pair.cacheKey,
				nodeBuilderState: pair.nodeBuilderState,
				complete,
				requestCount: pair.requests.length,
				renderObjects: [ ...new Set( authoritativeRequests.map( ( request ) => request.renderObject ).filter( Boolean ) ) ],
				objects,
				sourceMaterials,
				sourceOwnerRequests: sourceOwnerRequests.slice(),
				captureClocks,
				velocityProjectionSources,
				renderContextSelectors: selectors,
				requests: pair.requests.slice(),
				firstRequestOrdinal: ordinals.reduce( ( first, ordinal ) => Math.min( first, ordinal ), Infinity ),
				lastRequestOrdinal: ordinals.reduce( ( last, ordinal ) => Math.max( last, ordinal ), - Infinity ),
				provenance: {
					renderContexts: uniqueHarvestValues( authoritativeRequests, ( request ) => requestRenderContexts.get( request ) ),
					objects: uniqueHarvestValues( authoritativeRequests, ( request ) => request.object ),
					sourceMaterials: uniqueHarvestValues( authoritativeRequests, harvestRequestSourceMaterial ),
					scenes: uniqueHarvestValues( authoritativeRequests, ( request ) => request.scene ),
					cameras: uniqueHarvestValues( authoritativeRequests, ( request ) => request.camera ),
					lightsNodes: uniqueHarvestValues( authoritativeRequests, ( request ) => request.lightsNode ),
					clippingContexts: uniqueHarvestValues( authoritativeRequests, ( request ) => request.clippingContext ),
					bindingOwnerKinds: uniqueHarvestValues( authoritativeRequests, ( request ) => request.bindingOwnerKind ),
					bindingOwnerExact: uniqueHarvestValues( authoritativeRequests, ( request ) => request.bindingOwnerExact ),
					captureClocks: uniqueHarvestValues( authoritativeRequests, ( request ) => request.captureClock ),
				},
			};

		} );
		const retainedRecords = retainTemporallyCurrentHarvestRecords( records );
		const variants = retainedRecords.map( ( record ) => {

			// A deferred Fn() material root can create its ComputeNode only while
			// NodeBuilder executes the closure. Publish evidence only for variants
			// that survived temporal supersession so stale builder identities cannot
			// leak into the material property-path contract.
			const graphMaterials = record.sourceMaterials.length > 0 ? record.sourceMaterials : [ material ];
			for ( const graphMaterial of graphMaterials ) {

				attachDeferredMaterialComputeStatePaths( graphMaterial, record.nodeBuilderState );

			}
			return Object.freeze( {
				cacheKey: record.cacheKey,
				nodeBuilderState: record.nodeBuilderState,
				complete: record.complete,
				requestCount: record.requestCount,
				renderObjects: Object.freeze( record.renderObjects ),
				objects: Object.freeze( record.objects ),
				sourceMaterials: Object.freeze( record.sourceMaterials ),
				sourceOwnerRequests: Object.freeze( record.sourceOwnerRequests ),
				userMaterials: Object.freeze( record.sourceMaterials ),
				captureClocks: Object.freeze( record.captureClocks ),
				velocityProjectionSources: Object.freeze( record.velocityProjectionSources ),
				renderContextSelectors: Object.freeze( record.renderContextSelectors ),
				requests: Object.freeze( record.requests ),
			} );

		} );
		variants.sort( compareHarvestVariants );
		const family = Object.freeze( {
			epoch,
			material,
			complete: variants.length > 0 && variants.every( ( variant ) => variant.complete ),
			variants: Object.freeze( variants ),
		} );
		familiesByMaterial.set( material, family );
		const uuid = material && safeRead( material, 'uuid' );
		if ( uuid && ! familiesByMaterialUuid.has( uuid ) ) familiesByMaterialUuid.set( uuid, family );

	}
	return Object.freeze( {
		epoch,
		supported,
		renderer,
		requests: Object.freeze( requests.slice() ),
		familiesByMaterial,
		familiesByMaterialUuid,
	} );

}

/**
 * Three may replace a RenderObject and its cached NodeBuilderState within one
 * render-context chain even though every observable render input and exact
 * selector remains unchanged. Treat the later state as authoritative only when
 * the observations prove a one-way, non-overlapping transition. A final exact
 * render dispatch may supersede compile-only evidence from an equivalent
 * context; other context or provenance differences remain fail closed.
 */
function retainTemporallyCurrentHarvestRecords( records ) {

	const retained = new Set( records );
	const groups = new Map();
	for ( const record of records ) {

		if ( record.renderContextSelectors.length === 0 ) continue;
		const selectorSetKey = stableJsonStringify(
			record.renderContextSelectors,
			'renderObjectHarvestSelectorSet',
		);
		let group = groups.get( selectorSetKey );
		if ( ! group ) {

			group = [];
			groups.set( selectorSetKey, group );

		}
		group.push( record );

	}
	for ( const group of groups.values() ) {

		if ( group.length < 2 || group.some( ( record ) => (
			! record.complete ||
			record.provenance.renderContexts.length === 0 ||
			record.provenance.renderContexts.some( ( context ) => ! context )
		) ) ) continue;
		const baseline = group[ 0 ];
		if ( group.some( ( record ) => (
			! equalHarvestValueArrays( baseline.renderContextSelectors, record.renderContextSelectors ) ||
			! equalHarvestProvenance( baseline.provenance, record.provenance )
		) ) ) continue;
		const chronological = group.slice().sort( ( left, right ) => left.firstRequestOrdinal - right.firstRequestOrdinal );
		if ( chronological.some( ( record ) => (
			! Number.isSafeInteger( record.firstRequestOrdinal ) ||
			! Number.isSafeInteger( record.lastRequestOrdinal )
		) ) ) continue;
		const sameContextChain = group.every( ( record ) => (
			equalHarvestValueSets( baseline.provenance.renderContexts, record.provenance.renderContexts ) &&
			equalHarvestValueSets( baseline.provenance.clippingContexts, record.provenance.clippingContexts )
		) );
		const current = chronological[ chronological.length - 1 ];
		const currentHasExactOwner = current.provenance.bindingOwnerExact.length === 1 &&
			current.provenance.bindingOwnerExact[ 0 ] === true;
		if ( ! sameContextChain && ! currentHasExactOwner ) continue;
		let oneWay = true;
		for ( let index = 1; index < chronological.length; index ++ ) {

			if ( chronological[ index - 1 ].lastRequestOrdinal >= chronological[ index ].firstRequestOrdinal ) {

				oneWay = false;
				break;

			}

		}
		if ( ! oneWay ) continue;
		for ( const stale of chronological.slice( 0, - 1 ) ) retained.delete( stale );

	}
	return records.filter( ( record ) => retained.has( record ) );

}

function harvestRequestSourceMaterial( request ) {

	return request.sourceMaterial || ( ! Array.isArray( request.userMaterial ) ? request.userMaterial : null );

}

function uniqueHarvestValues( requests, select ) {

	return [ ...new Set( requests.map( select ) ) ];

}

function equalHarvestProvenance( left, right ) {

	return equalHarvestValueSets( left.objects, right.objects ) &&
		equalHarvestValueSets( left.sourceMaterials, right.sourceMaterials ) &&
		equalHarvestValueSets( left.scenes, right.scenes ) &&
		equalHarvestValueSets( left.cameras, right.cameras ) &&
		equalHarvestValueSets( left.lightsNodes, right.lightsNodes ) &&
		equalHarvestValueSets( left.bindingOwnerKinds, right.bindingOwnerKinds ) &&
		equalHarvestValueSets( left.captureClocks, right.captureClocks );

}

function equalHarvestValueArrays( left, right ) {

	return left.length === right.length && left.every( ( value, index ) => value === right[ index ] );

}

function equalHarvestValueSets( left, right ) {

	return left.length === right.length && left.every( ( value ) => right.includes( value ) );

}

/**
 * A CubeRenderTarget draw always binds one two-dimensional face view. Face
 * identity selects the attachment layer but cannot change the material WGSL,
 * so one complete builder state is valid for all six faces. Persist explicit
 * aliases instead of weakening ordinary runtime selector matching.
 *
 * Require the target object itself to identify as a cube render target and
 * require the canonical selector to agree. A cube-looking texture attached to
 * an ordinary target is not sufficient evidence for alias expansion.
 */
function renderContextSelectorAliases( request ) {

	const selector = request && request.renderContextSelector;
	if ( ! selector ) return [];
	const renderTarget = request && request.renderContext && request.renderContext.renderTarget;
	const verifiedCubeTarget = safeRead( renderTarget, 'isCubeRenderTarget' ) === true ||
		safeRead( renderTarget, 'isWebGLCubeRenderTarget' ) === true;
	if ( ! verifiedCubeTarget ) return [ selector ];
	let descriptor;
	try {

		descriptor = JSON.parse( selector );

	} catch ( _ ) {

		return [ selector ];

	}
	if ( ! descriptor || descriptor.version !== 'render-object-selector@1' ||
		! descriptor.target || descriptor.target.surface !== 'offscreen-cube' ) return [ selector ];
	const aliases = [];
	for ( let activeCubeFace = 0; activeCubeFace < 6; activeCubeFace ++ ) {

		aliases.push( stableJsonStringify( {
			...descriptor,
			target: { ...descriptor.target, activeCubeFace },
		}, 'renderObjectSelector' ) );

	}
	return aliases;

}

function copyRenderGroup( group ) {

	if ( ! group || typeof group !== 'object' ) return null;
	return Object.freeze( {
		start: safeRead( group, 'start' ),
		count: safeRead( group, 'count' ),
		materialIndex: safeRead( group, 'materialIndex' ),
	} );

}

function compareHarvestVariants( a, b ) {

	const left = String( a.cacheKey );
	const right = String( b.cacheKey );
	return left < right ? - 1 : left > right ? 1 : 0;

}

function firstFinite( values, fallback ) {

	for ( const value of values ) if ( typeof value === 'number' && Number.isFinite( value ) ) return value;
	return fallback;

}

function safeCall( object, method ) {

	try { return object && typeof object[ method ] === 'function' ? object[ method ]() : undefined; } catch ( _ ) { return undefined; }

}

function safeRead( object, key ) {

	try { return object && object[ key ]; } catch ( _ ) { return undefined; }

}
