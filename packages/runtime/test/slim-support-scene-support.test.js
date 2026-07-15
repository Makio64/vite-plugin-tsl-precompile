import test from 'node:test';
import assert from 'node:assert/strict';
import * as Three from 'three';
import NodeFrame from 'three/src/nodes/core/NodeFrame.js';

import { createSlimSceneSupport, pinClock, unpinClock } from '../src/slim-support/scene-support.js';
import { getSlimRenderFallback, setSlimRenderFallback } from '../src/slim-support/render-fallback-registry.js';
import { clearLiveTextureIndex, hydrateNodeBuilderState } from '../src/hydrator.js';
import { lookupLiveTextureByIdentity } from '../src/hydrate/live-texture-registry.js';
import ReplayNodeFrame from '../src/slim-replay-node-frame.js';
import { getTemporalFrameState, withTemporalFrame } from '../src/slim-support/temporal-frame.js';

function fakeDataMap() {

	const store = new WeakMap();
	return { store, get( key ) { let e = store.get( key ); if ( ! e ) { e = {}; store.set( key, e ); } return e; } };

}

function fakeRenderer( { device = { id: 'gpu-shared' } } = {} ) {

	const backend = fakeDataMap();
	const _textures = fakeDataMap();
	const _attributes = fakeDataMap();
	backend.device = device ? { ...device, queue: { submit() {} }, createCommandEncoder: () => ( { copyBufferToBuffer() {}, finish: () => ( {} ) } ) } : null;
	backend.generateMipmaps = () => {};
	return { backend, _textures, _attributes, _bindings: { getForCompute: () => [] } };

}

function fakePassFullRenderer() {

	const renderer = fakeRenderer();
	Object.assign( renderer, {
		autoClear: false,
		transparent: false,
		opaque: true,
		_target: null,
		_mrt: null,
		getRenderTarget() { return this._target; },
		setRenderTarget( target ) { this._target = target; },
		getMRT() { return this._mrt; },
		setMRT( mrt ) { this._mrt = mrt; },
		render( scene, camera ) {

			this._rendered = { scene, camera, mrt: this._mrt };

		},
	} );
	return renderer;

}

function contractComputeArtifact( mode = 'hybrid-required', { storageOutput = false, storageAccess = 'readWrite', updateType = 'object' } = {} ) {

	const storageRef = {
		name: 'positions',
		access: storageAccess,
		visibility: 4,
		arrayType: 'Float32Array',
		count: 1,
		itemSize: 4,
	};
	const storageBinding = {
		name: 'positions',
		kind: 'storage-buffer',
		visibility: 4,
		textureType: null,
		byteLength: 16,
		access: storageAccess,
	};

	return {
		version: 3,
		cacheKey: 'contract-compute',
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		computeShader: '',
		attributes: storageOutput ? [ {
			name: 'positions',
			type: 'vec4',
			source: 'node',
			storage: true,
			instanced: false,
			arrayType: 'Float32Array',
			count: 1,
			itemSize: 4,
			userPath: [ 'positionNode', 'storage', 'attribute' ],
		} ] : [],
		bindings: [],
		uniformPlan: [],
		defaults: {},
		meta: { updateNodes: 0, updateBeforeNodes: 1, updateAfterNodes: 0 },
		materialCompute: {
			version: 'material-compute@1',
			mode,
			reasons: mode === 'hybrid-required' ? [ 'kernel:0:on-init-function' ] : [],
			resources: storageOutput ? [ {
				id: 'resource:0',
				kind: 'storage-buffer',
				arrayType: 'Float32Array',
				count: 1,
				itemSize: 4,
				byteLength: 16,
			} ] : [],
			kernels: [ {
				id: 'kernel:0',
				nodePath: [ 'positionNode' ],
				updates: [],
				artifact: {
					version: 3,
					kind: 'compute',
					cacheKey: 1,
					name: 'contract-compute',
					computeShader: '@compute @workgroup_size( 1 ) fn main() {}',
					vertexShader: '',
					fragmentShader: '',
					attributes: [],
					bindings: storageOutput ? [ { name: 'compute', bindings: [ storageBinding ] } ] : [],
					uniformPlan: storageOutput ? [ {
						name: 'compute',
						slots: [],
						textures: [],
						storageBuffers: [ storageRef ],
						orderedBindings: [ { type: 'storage-buffer', ref: storageRef } ],
					} ] : [],
					defaults: {},
					dispatchSize: 1,
					workgroupSize: [ 1, 1, 1 ],
					meta: { updateNodes: 0, updateBeforeNodes: 0, updateAfterNodes: 0 },
				},
			} ],
			bindings: storageOutput ? [ {
				kernel: 'kernel:0',
				resource: 'resource:0',
				group: 0,
				binding: 0,
				access: storageAccess,
			} ] : [],
			renderBindings: storageOutput ? [ {
				resource: 'resource:0',
				kind: 'attribute',
				attribute: 0,
			} ] : [],
			schedule: [ {
				kernel: 'kernel:0',
				phase: 'update-before',
				order: 0,
				updateType,
			} ],
		},
	};

}

class FakeFullRenderer {

	constructor( options = {} ) {

		this.options = options;
		this.shadowMap = { enabled: false };
		this.initialised = false;

	}
	async init() { this.initialised = true; }
	dispose() { this.disposed = true; }

}

class DeferredShadowFullRenderer extends FakeFullRenderer {

	constructor( options = {} ) {

		super( options );
		this.backend = fakeDataMap();
		this.backend.device = options.device;
		if ( this.backend.device && this.backend.device.queue && typeof this.backend.device.queue.onSubmittedWorkDone !== 'function' ) {

			this.backend.device.queue.onSubmittedWorkDone = async () => {};

		}
		this._textures = fakeDataMap();
		this.shadowMap = { enabled: false, type: Three.PCFShadowMap, transmitted: false };
		this._target = null;
		this.renderCount = 0;
		this.events = [];
		this._pause = null;

	}

	pauseNextRender() {

		let release = null;
		let entered = null;
		const enteredPromise = new Promise( ( resolve ) => { entered = resolve; } );
		const gate = new Promise( ( resolve ) => { release = resolve; } );
		this._pause = { entered, gate };
		return { entered: enteredPromise, release };

	}

	getRenderTarget() { return this._target; }
	setRenderTarget( target ) { this._target = target; }

	async render( scene ) {

		this.renderCount ++;
		if ( this._pause ) {

			const pause = this._pause;
			this._pause = null;
			scene.traverse( ( object ) => {

				if ( object.isLight !== true || ! object.shadow || object.shadow.__trackedDispose ) return;
				object.shadow.__trackedDispose = true;
				const originalDispose = object.shadow.dispose.bind( object.shadow );
				object.shadow.dispose = () => { this.events.push( 'shadow' ); originalDispose(); };

			} );
			pause.entered();
			await pause.gate;

		}
		scene.traverse( ( light ) => {

			if ( light.isLight !== true || light.castShadow !== true || ! light.shadow || light.shadow.map ) return;
			const depthTexture = new Three.DepthTexture( 16, 16 );
			light.shadow.map = new Three.RenderTarget( 16, 16 );
			light.shadow.map.depthTexture = depthTexture;
			this.backend.get( depthTexture ).texture = { label: `deferred-shadow-${ this.renderCount }` };

		} );

	}

	dispose() {

		this.events.push( 'renderer' );
		super.dispose();

	}

}

function makeSupportShadowScene() {

	const scene = new Three.Scene();
	const mesh = new Three.Mesh( new Three.BoxGeometry( 1, 1, 1 ), new Three.MeshLambertMaterial() );
	mesh.castShadow = true;
	const light = new Three.DirectionalLight();
	light.castShadow = true;
	const camera = new Three.PerspectiveCamera( 50, 1, 0.1, 10 );
	scene.add( mesh, light, light.target, camera );
	return { scene, light, camera };

}

class FakeFullRendererWithPrivateNodes extends FakeFullRenderer {

	async init() {

		await super.init();
		this._nodes = {
			getForRender( renderObject ) {

				const state = {
					vertexShader: 'vertex',
					fragmentShader: 'fragment',
					computeShader: '',
					nodeAttributes: [ 'position' ],
					bindings: [ 'group' ],
					updateNodes: [ 'update' ],
					updateBeforeNodes: [ 'before' ],
					updateAfterNodes: [ 'after' ],
					observer: 'observer',
					transforms: [ 'transform' ],
					renderObject,
				};
				state.createBindings = () => [ { cloneFor: renderObject } ];
				return state;

			},
			delete( renderObject ) { this.released = renderObject; },
		};

	}

}

class FakeFullRendererWithCompute extends FakeFullRendererWithPrivateNodes {

	async init() {

		await super.init();
		this._bindings = { getForCompute: () => [] };

	}

	compute( computeNode, ...rest ) {

		this.computed = { computeNode, rest };

	}

}

class FakeFullRendererWithBuilderOnly extends FakeFullRenderer {

	async init() {

		await super.init();
		this._nodes = {
			_createNodeBuilder( renderObject ) {

				return {
					vertexShader: '', fragmentShader: '', computeShader: '',
					build() { this.vertexShader = 'built-vertex'; this.fragmentShader = 'built-fragment'; },
					getAttributesArray: () => [ 'position' ],
					getBindings: () => [],
					updateNodes: [],
					renderObject,
				};

			},
		};

	}

}

test( 'createSlimSceneSupport requires a renderer', () => {

	assert.throws( () => createSlimSceneSupport( {} ), /opts\.renderer is required/ );

} );

test( 'createSlimSceneSupport exposes the four sub-helpers by default (no fallback)', () => {

	const support = createSlimSceneSupport( { renderer: fakeRenderer() } );
	assert.ok( support.liveSceneIndex );
	assert.ok( support.pmrem );
	assert.equal( support.fallback, null );
	assert.ok( support.materialCompute );
	assert.equal( typeof support.indexScene, 'function' );
	assert.equal( typeof support.syncComputeOutputs, 'function' );
	assert.equal( typeof support.dispatchMaterialComputes, 'function' );
	assert.equal( typeof support.shareComputeInputs, 'function' );
	assert.equal( typeof support.shareTexture, 'function' );
	assert.equal( typeof support.shareShadowTexture, 'function' );
	assert.equal( typeof support.populateShadowMaps, 'function' );
	assert.equal( typeof support.updateRendererLighting, 'function' );
	assert.equal( typeof support.renderOffscreenOverrideWithFallback, 'function' );

} );

test( 'createSlimSceneSupport reports missing shadow fallback configuration without throwing', async () => {

	const errors = [];
	const support = createSlimSceneSupport( {
		renderer: fakeRenderer(),
		onError: ( error, detail ) => errors.push( { error, detail } ),
	} );
	const result = await support.populateShadowMaps( {}, {} );

	assert.equal( result.rendered, false );
	assert.equal( result.complete, false );
	assert.equal( errors.length, 1 );
	assert.equal( errors[ 0 ].detail.where, 'populateShadowMaps' );
	assert.equal( support.diagnostics.shadow.calls, 1 );

} );

test( 'createSlimSceneSupport maps a retained source material into the shadow fallback by default', async () => {

	const slim = fakeRenderer();
	slim.shadowMap = { enabled: true, type: Three.PCFShadowMap, transmitted: false };
	const full = fakeRenderer();
	full.backend.device = slim.backend.device;
	Object.assign( full, {
		shadowMap: { enabled: false, type: Three.PCFShadowMap, transmitted: false },
		_target: null,
		getRenderTarget() { return this._target; },
		setRenderTarget( target ) { this._target = target; },
		async render( scene ) {

			this.renderedScene = scene;
			scene.traverse( ( light ) => {

				if ( light.isLight !== true || light.castShadow !== true || light.shadow.map ) return;
				const depthTexture = new Three.DepthTexture( 16, 16 );
				light.shadow.map = { depthTexture };
				this.backend.get( depthTexture ).texture = { label: 'retained-source-shadow-depth' };

			} );

		},
	} );

	const sourceMaterial = new Three.MeshLambertMaterial();
	sourceMaterial.positionNode = { isNode: true, label: 'retained-position-node' };
	const replayMaterial = { isPrecompiledMaterial: true, __tslpSourceMaterial: sourceMaterial };
	const scene = new Three.Scene();
	const mesh = new Three.Mesh( new Three.BoxGeometry( 1, 1, 1 ), replayMaterial );
	mesh.castShadow = true;
	const light = new Three.DirectionalLight();
	light.castShadow = true;
	scene.add( mesh, light, light.target );
	const camera = new Three.PerspectiveCamera( 50, 1, 0.1, 10 );
	scene.add( camera );

	const support = createSlimSceneSupport( { renderer: slim, threeFullModule: Three, fullRendererFallback: false } );
	const result = await support.populateShadowMaps( scene, camera, { fullRenderer: full, threeFullModule: Three, cache: new WeakMap() } );

	assert.equal( result.complete, true );
	let proxyMaterial = null;
	full.renderedScene.traverse( ( object ) => {

		if ( object.isMesh === true && object.castShadow === true ) proxyMaterial = object.material;

	} );
	assert.equal( proxyMaterial, sourceMaterial );
	assert.equal( support.diagnostics.shadow.complete, 1 );
	assert.equal( slim.backend.get( light.shadow.map.depthTexture ).texture.label, 'retained-source-shadow-depth' );

} );

test( 'createSlimSceneSupport boots the fallback renderer on demand', async () => {

	const slim = fakeRenderer();
	const support = createSlimSceneSupport( {
		renderer: slim,
		fullRendererFallback: true,
		threeFullModule: { WebGPURenderer: FakeFullRenderer },
	} );

	assert.ok( support.fallback );
	const full = await support.getFullRenderer();
	assert.ok( full instanceof FakeFullRenderer );
	assert.equal( full.options.device, slim.backend.device, 'fallback shares the GPU device' );
	assert.equal( full.initialised, true );

} );

test( 'createSlimSceneSupport ensureFallback registers private _nodes as a slim builder fallback', async () => {

	setSlimRenderFallback( null );
	const renderObject = { material: { type: 'NodeMaterial' } };
	const support = createSlimSceneSupport( {
		renderer: fakeRenderer(),
		fullRendererFallback: true,
		threeFullModule: { WebGPURenderer: FakeFullRendererWithPrivateNodes },
	} );

	try {

		await support.ensureFallback();
		const fallback = getSlimRenderFallback();
		assert.equal( typeof fallback, 'function' );
		const builder = fallback( renderObject );
		assert.equal( builder.vertexShader, 'vertex' );
		assert.deepEqual( builder.getAttributesArray(), [ 'position' ] );
		assert.deepEqual( builder.getBindings(), [ 'group' ] );
		assert.deepEqual( builder.createBindings(), [ { cloneFor: renderObject } ] );
		assert.equal( typeof builder.build, 'function' );
		assert.equal( typeof builder.buildAsync, 'function' );
		fallback.release( renderObject );
		assert.equal( ( await support.getFullRenderer() )._nodes.released, renderObject );

	} finally {

		support.dispose();
		setSlimRenderFallback( null );

	}

} );

test( 'createSlimSceneSupport builds legacy private node builders before fallback replay', async () => {

	setSlimRenderFallback( null );
	const support = createSlimSceneSupport( {
		renderer: fakeRenderer(),
		fullRendererFallback: true,
		threeFullModule: { WebGPURenderer: FakeFullRendererWithBuilderOnly },
	} );
	try {

		await support.ensureFallback();
		const state = getSlimRenderFallback()( { material: { type: 'LegacyNodeMaterial' } } );
		assert.equal( state.vertexShader, 'built-vertex' );
		assert.equal( state.fragmentShader, 'built-fragment' );
		assert.deepEqual( state.getAttributesArray(), [ 'position' ] );
		assert.deepEqual( state.createBindings(), [] );

	} finally {

		support.dispose();
		setSlimRenderFallback( null );

	}

} );

test( 'createSlimSceneSupport ensureFallback installs raw compute fallback on the slim renderer', async () => {

	const slim = fakeRenderer();
	let originalComputeNode = null;
	slim.compute = ( node ) => { originalComputeNode = node; return 'original'; };
	const support = createSlimSceneSupport( {
		renderer: slim,
		fullRendererFallback: true,
		threeFullModule: { WebGPURenderer: FakeFullRendererWithCompute },
	} );

	try {

		await support.ensureFallback();
		const full = await support.getFullRenderer();
		const rawCompute = { isComputeNode: true };
		const precompiledCompute = { isComputeNode: true, isPrecompiledCompute: true };

		const stats = slim.compute( rawCompute, 12 );
		assert.equal( full.computed.computeNode, rawCompute );
		assert.deepEqual( full.computed.rest, [ 12 ] );
		assert.equal( stats.pass, 0 );
		assert.equal( full._nodes.nodeFrame, undefined, 'fallback renderers without a NodeFrame seam remain compatible' );

		assert.equal( slim.compute( precompiledCompute ), 'original' );
		assert.equal( originalComputeNode, precompiledCompute );

		support.dispose();
		assert.equal( slim.compute( precompiledCompute ), 'original' );

	} finally {

		support.dispose();
		setSlimRenderFallback( null );

	}

} );

test( 'createSlimSceneSupport aligns material compute with logical FRAME cadence without advancing the full NodeFrame', async () => {

	const slim = fakeRenderer();
	const slimFrame = new ReplayNodeFrame();
	Object.assign( slimFrame, { renderer: slim, frameId: 60, time: 12, deltaTime: 0.125 } );
	slim._nodes = { nodeFrame: slimFrame };

	const full = fakeRenderer();
	full.backend.device = slim.backend.device;
	full._initialized = true;
	const fullFrame = new NodeFrame();
	Object.assign( fullFrame, { renderer: full, frameId: 41, time: 9, deltaTime: 0.75, renderId: 44 } );
	let frameAdvanceCalls = 0;
	fullFrame.update = () => { frameAdvanceCalls ++; };
	full._nodes = { nodeFrame: fullFrame, getForCompute: () => ( { bindings: [] } ) };
	full._bindings = { getForCompute: () => [] };

	const frameReference = {};
	const observations = [];
	const frameUpdateNode = {
		getUpdateType: () => 'frame',
		updateReference: () => frameReference,
		update( frame ) {

			const temporal = getTemporalFrameState( frame );
			observations.push( {
				frameId: frame.frameId,
				renderId: frame.renderId,
				time: frame.time,
				deltaTime: frame.deltaTime,
				temporal: temporal && { ...temporal },
			} );

		},
	};
	let physicalComputes = 0;
	full.computeAsync = () => {

		fullFrame.renderId = ++ physicalComputes;
		fullFrame.updateNode( frameUpdateNode );
		return Promise.resolve();

	};

	const raw = { isNode: true, isComputeNode: true, traverse( visitor ) { visitor( this ); } };
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: contractComputeArtifact( 'hybrid-required', { updateType: 'frame' } ),
		positionNode: raw,
	};
	const scene = { traverse( visitor ) { visitor( { material } ); } };
	const support = createSlimSceneSupport( { renderer: slim, fullRendererFallback: false } );
	const fullSnapshot = { frameId: 41, time: 9, deltaTime: 0.75, renderId: 44 };
	const dispatchAt = ( frameId, renderId, time ) => withTemporalFrame(
		slim,
		{ frameId, renderId, time },
		() => support.dispatchMaterialComputes( scene, { fullRenderer: full } ),
	);

	try {

		assert.equal( ( await dispatchAt( 7, 'visible-a', 3.25 ) ).errors, 0 );
		assert.deepEqual( {
			frameId: fullFrame.frameId,
			time: fullFrame.time,
			deltaTime: fullFrame.deltaTime,
			renderId: fullFrame.renderId,
		}, fullSnapshot );
		assert.equal( getTemporalFrameState( full ), null, 'a caller-passed renderer is only scoped during its native lifecycle' );

		assert.equal( ( await dispatchAt( 7, 'visible-b', 3.5 ) ).errors, 0 );
		assert.equal( ( await dispatchAt( 8, 'visible-c', 4.25 ) ).errors, 0 );

		assert.equal( physicalComputes, 3 );
		assert.equal( observations.length, 2, 'FRAME work runs once at frame 7 and once at frame 8' );
		assert.deepEqual( observations, [
			{
				frameId: 7,
				renderId: 1,
				time: 3.25,
				deltaTime: 0.125,
				temporal: { frameId: 7, renderId: 'visible-a', time: 3.25, advance: true },
			},
			{
				frameId: 8,
				renderId: 3,
				time: 4.25,
				deltaTime: 0.125,
				temporal: { frameId: 8, renderId: 'visible-c', time: 4.25, advance: true },
			},
		] );
		assert.equal( frameAdvanceCalls, 0, 'alignment does not advance the full renderer clock' );
		assert.deepEqual( {
			frameId: fullFrame.frameId,
			time: fullFrame.time,
			deltaTime: fullFrame.deltaTime,
			renderId: fullFrame.renderId,
		}, fullSnapshot );
		assert.equal( getTemporalFrameState( full ), null );

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport keeps raw sync fallback synchronous and preserves FRAME and RENDER cadence', () => {

	const slim = fakeRenderer();
	const slimFrame = new ReplayNodeFrame();
	Object.assign( slimFrame, { renderer: slim, frameId: 30, time: 6, deltaTime: 0.25 } );
	slim._nodes = { nodeFrame: slimFrame };

	const full = fakeRenderer();
	full._initialized = true;
	const fullFrame = new NodeFrame();
	Object.assign( fullFrame, { renderer: full, frameId: 31, time: 7, deltaTime: 0.5, renderId: 40 } );
	full._nodes = { nodeFrame: fullFrame, getForCompute: () => ( { bindings: [] } ) };
	full._bindings = { getForCompute: () => [] };
	const frameReference = {};
	const renderReference = {};
	const frameUpdates = [];
	const renderUpdates = [];
	const makeUpdateNode = ( updateType, reference, target ) => ( {
		getUpdateType: () => updateType,
		updateReference: () => reference,
		update( frame ) {

			const temporal = getTemporalFrameState( frame );
			target.push( {
				frameId: frame.frameId,
				renderId: frame.renderId,
				time: frame.time,
				deltaTime: frame.deltaTime,
				temporal: temporal && { ...temporal },
			} );

		},
	} );
	const frameUpdateNode = makeUpdateNode( 'frame', frameReference, frameUpdates );
	const renderUpdateNode = makeUpdateNode( 'render', renderReference, renderUpdates );
	let nativeRenderId = 0;
	full.compute = () => {

		fullFrame.renderId = ++ nativeRenderId;
		fullFrame.updateNode( frameUpdateNode );
		fullFrame.updateNode( renderUpdateNode );

	};
	const raw = { isComputeNode: true };
	const support = createSlimSceneSupport( { renderer: slim, fullRendererFallback: false } );
	support.installComputeFallback( full );
	const fullSnapshot = { frameId: 31, time: 7, deltaTime: 0.5, renderId: 40 };

	try {

		withTemporalFrame( full, { frameId: 'caller', renderId: 'caller-pass', time: 99 }, ( callerState ) => {

			withTemporalFrame( slim, { frameId: 5, renderId: 'application-pass', time: 2 }, () => {

				const first = slim.compute( raw );
				assert.equal( typeof first.then, 'undefined', 'an initialized full renderer keeps compute() synchronous' );
				assert.equal( getTemporalFrameState( full ), callerState );
				const second = slim.compute( raw );
				assert.equal( typeof second.then, 'undefined' );
				assert.equal( getTemporalFrameState( full ), callerState );

			} );
			assert.equal( getTemporalFrameState( full ), callerState );

		} );

		assert.equal( frameUpdates.length, 1, 'FRAME work is deduplicated within one logical frame' );
		assert.equal( renderUpdates.length, 2, 'RENDER work follows the two native physical compute calls' );
		assert.deepEqual( frameUpdates[ 0 ], {
			frameId: 5,
			renderId: 1,
			time: 2,
			deltaTime: 0.25,
			temporal: { frameId: 5, renderId: 'application-pass', time: 2, advance: true },
		} );
		assert.deepEqual( renderUpdates.map( ( entry ) => entry.renderId ), [ 1, 2 ] );
		assert.ok( renderUpdates.every( ( entry ) => entry.frameId === 5 && entry.time === 2 && entry.deltaTime === 0.25 ) );
		assert.ok( renderUpdates.every( ( entry ) => entry.temporal.frameId === 5 && entry.temporal.renderId === 'application-pass' ) );
		assert.deepEqual( {
			frameId: fullFrame.frameId,
			time: fullFrame.time,
			deltaTime: fullFrame.deltaTime,
			renderId: fullFrame.renderId,
		}, fullSnapshot );
		assert.equal( getTemporalFrameState( slim ), null );
		assert.equal( getTemporalFrameState( full ), null );

		full.compute = () => {

			Object.assign( fullFrame, { frameId: - 1, time: - 1, deltaTime: - 1, renderId: - 1 } );
			throw new Error( 'native sync compute failed' );

		};
		withTemporalFrame( full, { frameId: 'caller-throw', renderId: 'caller-throw-pass', time: 100 }, ( callerState ) => {

			assert.throws(
				() => withTemporalFrame( slim, { frameId: 6, renderId: 'throw-pass', time: 3 }, () => slim.compute( raw ) ),
				/native sync compute failed/,
			);
			assert.equal( getTemporalFrameState( full ), callerState, 'throw restores the caller\'s existing full-renderer scope' );
			assert.deepEqual( {
				frameId: fullFrame.frameId,
				time: fullFrame.time,
				deltaTime: fullFrame.deltaTime,
				renderId: fullFrame.renderId,
			}, fullSnapshot );

		} );
		assert.equal( getTemporalFrameState( slim ), null );
		assert.equal( getTemporalFrameState( full ), null );

	} finally {

		support.dispose();

	}

} );

test( 'createSlimSceneSupport lazily initializes explicit async fallback before alignment and restores before settlement', async () => {

	const slim = fakeRenderer();
	const slimFrame = new ReplayNodeFrame();
	Object.assign( slimFrame, { renderer: slim, frameId: 80, time: 18, deltaTime: 0.375 } );
	slim._nodes = { nodeFrame: slimFrame };

	const full = fakeRenderer();
	full.backend.device = slim.backend.device;
	full._initialized = false;
	let initCalls = 0;
	let fullFrame = null;
	full.init = async () => {

		initCalls ++;
		await Promise.resolve();
		fullFrame = new NodeFrame();
		Object.assign( fullFrame, { renderer: full, frameId: 21, time: 11, deltaTime: 0.9, renderId: 12 } );
		full._nodes = { nodeFrame: fullFrame, getForCompute: () => ( { bindings: [] } ) };
		full._bindings = { getForCompute: () => [] };
		full._initialized = true;

	};
	let resolveEntered;
	const entered = new Promise( ( resolve ) => { resolveEntered = resolve; } );
	let rejectCompute;
	const deferred = new Promise( ( resolve, reject ) => { rejectCompute = reject; } );
	let observation = null;
	full.computeAsync = () => {

		const temporal = getTemporalFrameState( full );
		observation = {
			frameId: fullFrame.frameId,
			renderId: fullFrame.renderId,
			time: fullFrame.time,
			deltaTime: fullFrame.deltaTime,
			temporal: temporal && { ...temporal },
		};
		fullFrame.renderId = 99;
		resolveEntered();
		return deferred;

	};
	const raw = { isComputeNode: true };
	const support = createSlimSceneSupport( { renderer: slim, fullRendererFallback: false } );
	support.installComputeFallback( full );

	try {

		const run = withTemporalFrame(
			slim,
			{ frameId: 9, renderId: 'async-pass', time: 6 },
			() => slim.compute( raw ),
		);
		assert.equal( typeof run.then, 'function', 'lazy init promotes only this compute call to async' );
		await entered;

		assert.equal( initCalls, 1 );
		assert.deepEqual( observation, {
			frameId: 9,
			renderId: 12,
			time: 6,
			deltaTime: 0.375,
			temporal: { frameId: 9, renderId: 'async-pass', time: 6, advance: true },
		} );
		assert.deepEqual( {
			frameId: fullFrame.frameId,
			time: fullFrame.time,
			deltaTime: fullFrame.deltaTime,
			renderId: fullFrame.renderId,
		}, { frameId: 21, time: 11, deltaTime: 0.9, renderId: 12 }, 'full NodeFrame scalars restore while GPU completion is still pending' );
		assert.equal( getTemporalFrameState( full ), null, 'full temporal scope restores before the deferred compute settles' );
		assert.equal( getTemporalFrameState( slim ).frameId, 9, 'the caller-owned async scope remains active until settlement' );

		const rejection = assert.rejects( run, /deferred native compute failed/ );
		rejectCompute( new Error( 'deferred native compute failed' ) );
		await rejection;
		assert.equal( getTemporalFrameState( slim ), null );
		assert.equal( getTemporalFrameState( full ), null );
		assert.deepEqual( {
			frameId: fullFrame.frameId,
			time: fullFrame.time,
			deltaTime: fullFrame.deltaTime,
			renderId: fullFrame.renderId,
		}, { frameId: 21, time: 11, deltaTime: 0.9, renderId: 12 } );

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport dispatches retained material compute and presents shared storage', async () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	full.backend.device = slim.backend.device;
	const attribute = {
		isBufferAttribute: true,
		isStorageBufferAttribute: true,
		array: new Float32Array( 12 ),
		count: 4,
		itemSize: 3,
	};
	const binding = { isStorageBuffer: true, access: 'readWrite', attribute };
	const computeNode = {
		isNode: true,
		isComputeNode: true,
		traverse( visitor ) { visitor( this ); },
	};
	const initComputeNode = { isComputeNode: true };
	computeNode.onInitFunction = async ( { renderer } ) => {

		assert.equal( renderer, slim, 'material compute initialization keeps the app renderer identity' );
		await renderer.computeAsync( initComputeNode );

	};
	full._nodes = { getForCompute: () => ( { bindings: [ { bindings: [ binding ] } ] } ) };
	full._bindings = { getForCompute: () => [ { bindings: [ binding ] } ] };
	full.backend.get( attribute ).buffer = { size: attribute.array.byteLength };
	const dispatchedNodes = [];
	full.computeAsync = async ( node ) => {

		dispatchedNodes.push( node );

	};
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: {
			attributes: [ {
				name: 'nodeAttribute0',
				source: 'node',
				storage: true,
				count: 4,
				itemSize: 4,
				arrayType: 'Float32Array',
			} ],
		},
		positionNode: computeNode,
		disposeCalls: 0,
		dispose() { this.disposeCalls ++; },
	};
	const scene = { traverse( visitor ) { visitor( { material } ); } };
	const support = createSlimSceneSupport( { renderer: slim, fullRendererFallback: false } );

	try {

		const stats = await support.dispatchMaterialComputes( scene, { fullRenderer: full } );
		assert.equal( stats.owners, 1 );
		assert.equal( stats.dispatched, 1 );
		assert.equal( stats.attributesPrepared, 1 );
		assert.equal( stats.storageAttrs, 1 );
		assert.equal( stats.buffersAdopted, 0, 'the awaited initialization kernel already adopted the shared buffer' );
		assert.equal( stats.presentationNeeded, true );
		assert.deepEqual( dispatchedNodes, [ initComputeNode, computeNode ], 'async nested initialization completes before the owner kernel' );
		assert.equal( material.disposeCalls, 1 );
		assert.equal( slim.backend.get( attribute ).buffer, full.backend.get( attribute ).buffer );

		const nested = { isComputeNode: true };
		await slim.computeAsync( nested );
		assert.deepEqual( dispatchedNodes, [ initComputeNode, computeNode, nested ], 'an installed caller-owned renderer handles nested async kernels' );

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport skips raw graphs owned by a precompiled compute contract', async () => {

	const slim = fakeRenderer();
	const raw = { isNode: true, isComputeNode: true, traverse( visitor ) { visitor( this ); } };
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: contractComputeArtifact( 'precompiled' ),
		positionNode: raw,
	};
	const scene = { traverse( visitor ) { visitor( { material } ); } };
	let fullRendererRequests = 0;
	const support = createSlimSceneSupport( {
		renderer: slim,
		loadThreeFullModule: async () => { fullRendererRequests ++; return {}; },
	} );

	try {

		const stats = await support.dispatchMaterialComputes( scene );
		assert.equal( stats.dispatched, 0 );
		assert.equal( stats.owners, 0 );
		assert.equal( fullRendererRequests, 0 );

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport rejects a hybrid contract with no retained raw kernel', async () => {

	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: contractComputeArtifact(),
	};
	const scene = { traverse( visitor ) { visitor( { material } ); } };
	const support = createSlimSceneSupport( { renderer: fakeRenderer(), fullRendererFallback: false } );

	try {

		const stats = await support.dispatchMaterialComputes( scene );
		assert.equal( stats.errors, 1 );
		assert.equal( stats.dispatched, 0 );

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport rejects an unrelated raw kernel at the contracted count', async () => {

	const unrelated = { isNode: true, isComputeNode: true, traverse( visitor ) { visitor( this ); } };
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: contractComputeArtifact(),
		positionNode: { isNode: true, traverse( visitor ) { visitor( this ); } },
		colorNode: unrelated,
	};
	const scene = { traverse( visitor ) { visitor( { material } ); } };
	const support = createSlimSceneSupport( { renderer: fakeRenderer(), fullRendererFallback: false } );

	try {

		const stats = await support.dispatchMaterialComputes( scene );
		assert.equal( stats.errors, 1 );
		assert.equal( stats.nodes, 1, 'the wrong raw node cannot satisfy a one-kernel contract by count' );
		assert.equal( stats.dispatched, 0 );

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport rejects extra raw kernels beside an exact contract path', async () => {

	const expected = { isNode: true, isComputeNode: true, traverse( visitor ) { visitor( this ); } };
	const extra = { isNode: true, isComputeNode: true, traverse( visitor ) { visitor( this ); } };
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: contractComputeArtifact(),
		positionNode: expected,
		colorNode: extra,
	};
	const scene = { traverse( visitor ) { visitor( { material } ); } };
	const support = createSlimSceneSupport( { renderer: fakeRenderer(), fullRendererFallback: false } );

	try {

		const stats = await support.dispatchMaterialComputes( scene );
		assert.equal( stats.errors, 1 );
		assert.equal( stats.nodes, 2 );
		assert.equal( stats.dispatched, 0 );

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport claims hybrid compute only after forced full dispatch and releases it', async () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	full.backend.device = slim.backend.device;
	const raw = { isNode: true, isComputeNode: true, traverse( visitor ) { visitor( this ); } };
	const artifact = contractComputeArtifact();
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		positionNode: raw,
	};
	const scene = { traverse( visitor ) { visitor( { material } ); } };
	full._nodes = { getForCompute: () => ( { bindings: [] } ) };
	full._bindings = { getForCompute: () => [] };
	const dispatched = [];
	full.computeAsync = async ( node ) => { dispatched.push( node ); };
	const support = createSlimSceneSupport( { renderer: slim, fullRendererFallback: false } );

	assert.throws(
		() => hydrateNodeBuilderState( artifact, material ),
		( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
	);
	const stats = await support.dispatchMaterialComputes( scene, { fullRenderer: full } );
	assert.equal( stats.errors, 0 );
	assert.equal( stats.dispatched, 1 );
	assert.deepEqual( dispatched, [ raw ] );
	assert.equal( hydrateNodeBuilderState( artifact, material ).updateBeforeNodes.length, 1 );

	await support.dispose();
	assert.throws(
		() => hydrateNodeBuilderState( artifact, material ),
		( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
	);

} );

test( 'createSlimSceneSupport revokes a removed scene material hybrid lease on an empty dispatch', async () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	full.backend.device = slim.backend.device;
	const raw = { isNode: true, isComputeNode: true, traverse( visitor ) { visitor( this ); } };
	const artifact = contractComputeArtifact();
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		positionNode: raw,
	};
	const sceneA = { traverse( visitor ) { visitor( { material } ); } };
	const emptyScene = { traverse() {} };
	full._nodes = { getForCompute: () => ( { bindings: [] } ) };
	full._bindings = { getForCompute: () => [] };
	full.computeAsync = async () => {};
	const support = createSlimSceneSupport( { renderer: slim, fullRendererFallback: false } );

	try {

		assert.equal( ( await support.dispatchMaterialComputes( sceneA, { fullRenderer: full } ) ).errors, 0 );
		const state = hydrateNodeBuilderState( artifact, material );
		const emptyStats = await support.dispatchMaterialComputes( emptyScene );
		assert.equal( emptyStats.errors, 0 );
		assert.equal( emptyStats.owners, 0 );
		assert.throws(
			() => state.updateBeforeNodes[ 0 ].updateBefore( {} ),
			( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
		);
		assert.throws(
			() => hydrateNodeBuilderState( artifact, material ),
			( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
		);

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport consumes one hybrid lease per frame and recovers on redispatch', async () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	full.backend.device = slim.backend.device;
	const raw = { isNode: true, isComputeNode: true, traverse( visitor ) { visitor( this ); } };
	const artifact = contractComputeArtifact( 'hybrid-required', { updateType: 'frame' } );
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		positionNode: raw,
	};
	const scene = { traverse( visitor ) { visitor( { material } ); } };
	full._nodes = { getForCompute: () => ( { bindings: [] } ) };
	full._bindings = { getForCompute: () => [] };
	let dispatches = 0;
	full.computeAsync = async () => { dispatches ++; };
	const support = createSlimSceneSupport( { renderer: slim, fullRendererFallback: false } );

	try {

		assert.equal( ( await support.dispatchMaterialComputes( scene, { fullRenderer: full } ) ).errors, 0 );
		const state = hydrateNodeBuilderState( artifact, material );
		const guard = state.updateBeforeNodes[ 0 ];
		const frame = new ReplayNodeFrame();
		frame.frameId = 1;
		assert.doesNotThrow( () => frame.updateBeforeNode( guard ) );
		assert.doesNotThrow( () => frame.updateBeforeNode( guard ), 'same-frame reuse is scheduler-deduplicated' );
		const secondFrame = new ReplayNodeFrame();
		secondFrame.frameId = 1;
		assert.throws(
			() => secondFrame.updateBeforeNode( guard ),
			( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
		);
		assert.throws(
			() => secondFrame.updateBeforeNode( guard ),
			( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
			'a second scheduler cannot reuse or stamp another scheduler\'s generation',
		);
		frame.frameId = 2;
		assert.throws(
			() => frame.updateBeforeNode( guard ),
			( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
		);
		assert.throws(
			() => frame.updateBeforeNode( guard ),
			( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
			'a caught stale-lease error cannot stamp a retry as valid',
		);
		assert.equal( hydrateNodeBuilderState( artifact, material ).updateBeforeNodes[ 0 ], guard, 'consumed transactions retain one shared cached guard' );

		assert.equal( ( await support.dispatchMaterialComputes( scene, { fullRenderer: full } ) ).errors, 0 );
		assert.doesNotThrow( () => frame.updateBeforeNode( guard ), 'a new generation can retry the same logical frame after an aborted render' );
		assert.equal( dispatches, 2 );

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport retries failed material compute initialization before building or dispatching', async () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	full.backend.device = slim.backend.device;
	let initCalls = 0;
	let stateRequests = 0;
	let dispatches = 0;
	const raw = {
		isNode: true,
		isComputeNode: true,
		traverse( visitor ) { visitor( this ); },
		async onInitFunction() {

			initCalls ++;
			if ( initCalls === 1 ) throw new Error( 'transient init failure' );

		},
	};
	const artifact = contractComputeArtifact();
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		positionNode: raw,
	};
	const scene = { traverse( visitor ) { visitor( { material } ); } };
	full._nodes = { getForCompute: () => { stateRequests ++; return { bindings: [] }; } };
	full._bindings = { getForCompute: () => [] };
	full.computeAsync = async () => { dispatches ++; };
	const support = createSlimSceneSupport( { renderer: slim, fullRendererFallback: false } );

	try {

		const failed = await support.dispatchMaterialComputes( scene, { fullRenderer: full } );
		assert.equal( failed.errors, 1 );
		assert.equal( initCalls, 1 );
		assert.equal( stateRequests, 0, 'a failed graph-mutating initializer cannot be built early' );
		assert.equal( dispatches, 0 );
		assert.equal( typeof raw.onInitFunction, 'function', 'the original callback remains retryable' );
		assert.throws(
			() => hydrateNodeBuilderState( artifact, material ),
			( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
		);

		const recovered = await support.dispatchMaterialComputes( scene, { fullRenderer: full } );
		assert.equal( recovered.errors, 0 );
		assert.equal( initCalls, 2 );
		assert.equal( stateRequests > 0, true );
		assert.equal( dispatches, 1 );
		assert.equal( typeof raw.onInitFunction, 'function', 'successful initialization retains the callback for another full renderer' );
		assert.equal( hydrateNodeBuilderState( artifact, material ).updateBeforeNodes.length, 1 );

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport initializes material compute once per full renderer and backend device generation without a stock duplicate', async () => {

	const slim = fakeRenderer();
	const firstFull = fakeRenderer();
	const secondFull = fakeRenderer();
	firstFull.backend.device = slim.backend.device;
	secondFull.backend.device = slim.backend.device;
	const events = [];
	let initializingRenderer = 'first';
	const originalOnInit = async ( { renderer } ) => {

		assert.equal( renderer, slim, 'initialization keeps the application renderer identity' );
		events.push( `init:${ initializingRenderer }` );
		await Promise.resolve();
		events.push( `init-complete:${ initializingRenderer }` );

	};
	const raw = {
		isNode: true,
		isComputeNode: true,
		traverse( visitor ) { visitor( this ); },
		onInitFunction: originalOnInit,
	};
	const artifact = contractComputeArtifact();
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		positionNode: raw,
	};
	const scene = { traverse( visitor ) { visitor( { material } ); } };
	const configureFullRenderer = ( fullRenderer, label ) => {

		fullRenderer._nodes = {
			getForCompute() {

				events.push( `build:${ label }` );
				return { bindings: [] };

			},
		};
		fullRenderer._bindings = { getForCompute: () => [] };
		fullRenderer.computeAsync = async ( computeNode ) => {

			if ( typeof computeNode.onInitFunction === 'function' ) {

				events.push( `stock-init:${ label }` );
				await computeNode.onInitFunction.call( computeNode, { renderer: fullRenderer } );

			}
			events.push( `dispatch:${ label }` );

		};

	};
	configureFullRenderer( firstFull, 'first' );
	configureFullRenderer( secondFull, 'second' );
	const support = createSlimSceneSupport( { renderer: slim, fullRendererFallback: false } );

	try {

		assert.equal( ( await support.dispatchMaterialComputes( scene, { fullRenderer: firstFull } ) ).errors, 0 );
		assert.equal( raw.onInitFunction, originalOnInit, 'the callback is restored after dispatch' );
		assert.equal( events.indexOf( 'init-complete:first' ) < events.indexOf( 'build:first' ), true, 'initialization completes before the first renderer builds bindings' );
		assert.equal( events.indexOf( 'init-complete:first' ) < events.indexOf( 'dispatch:first' ), true );

		assert.equal( ( await support.dispatchMaterialComputes( scene, { fullRenderer: firstFull } ) ).errors, 0 );
		assert.equal( events.filter( ( event ) => event === 'init:first' ).length, 1, 'the same full renderer does not initialize twice' );

		initializingRenderer = 'second';
		assert.equal( ( await support.dispatchMaterialComputes( scene, { fullRenderer: secondFull } ) ).errors, 0 );
		assert.equal( events.filter( ( event ) => event === 'init:second' ).length, 1, 'a different full renderer owns a distinct initialization' );
		assert.equal( events.indexOf( 'init-complete:second' ) < events.indexOf( 'build:second' ), true, 'the second renderer also waits before building bindings' );
		assert.equal( events.indexOf( 'init-complete:second' ) < events.indexOf( 'dispatch:second' ), true );
		assert.equal( events.some( ( event ) => event.startsWith( 'stock-init:' ) ), false, 'the physical full-renderer dispatch sees a suppressed callback' );
		assert.equal( raw.onInitFunction, originalOnInit, 'the original callback remains available after every renderer transaction' );

		const replacementDevice = fakeRenderer( { device: { id: 'gpu-replacement' } } ).backend.device;
		slim.backend.device = replacementDevice;
		firstFull.backend.device = replacementDevice;
		initializingRenderer = 'first-replacement';
		assert.equal( ( await support.dispatchMaterialComputes( scene, { fullRenderer: firstFull } ) ).errors, 0 );
		assert.equal( events.filter( ( event ) => event === 'init:first-replacement' ).length, 1, 'a replacement backend device starts a new initialization generation' );
		assert.equal( ( await support.dispatchMaterialComputes( scene, { fullRenderer: firstFull } ) ).errors, 0 );
		assert.equal( events.filter( ( event ) => event === 'init:first-replacement' ).length, 1, 'the replacement device generation still initializes only once' );
		assert.equal( raw.onInitFunction, originalOnInit );

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport aborts before dispatch and claim when a slim-owned sampled input cannot be shared', async () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	full.backend.device = slim.backend.device;
	const texture = { isTexture: true, name: 'slim-owned-compute-input', version: 0 };
	const runtimeBinding = { isSampledTexture: true, texture };
	const runtimeGroup = { bindings: [ runtimeBinding ] };
	const raw = { isNode: true, isComputeNode: true, traverse( visitor ) { visitor( this ); } };
	const artifact = contractComputeArtifact();
	artifact.materialCompute.kernels[ 0 ].artifact.bindings = [ {
		name: 'compute',
		bindings: [ { name: 'input', kind: 'sampled-texture', store: false } ],
	} ];
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		positionNode: raw,
	};
	const scene = { traverse( visitor ) { visitor( { material } ); } };
	full._nodes = { getForCompute: () => ( { bindings: [ runtimeGroup ] } ) };
	full._bindings = { getForCompute: () => [ runtimeGroup ] };
	slim.backend.get( texture ).texture = { id: 'slim-input' };
	full.backend.store.set( texture, Object.freeze( {} ) );
	let physicalDispatches = 0;
	full.computeAsync = async () => { physicalDispatches ++; };
	const dispatchOnce = new Set();
	const errors = [];
	const support = createSlimSceneSupport( { renderer: slim, fullRendererFallback: false } );

	try {

		const failed = await support.dispatchMaterialComputes( scene, {
			fullRenderer: full,
			dispatchOnce,
			onError: ( error ) => errors.push( error ),
		} );
		assert.equal( failed.dispatched, 0 );
		assert.equal( failed.errors > 0, true );
		assert.equal( physicalDispatches, 0, 'required inputs are audited before physical compute' );
		assert.equal( dispatchOnce.has( raw ), false, 'a failed input transaction never publishes a caller claim' );
		assert.equal( errors.some( ( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_INPUT_SYNC_MISS' ), true );
		assert.throws(
			() => hydrateNodeBuilderState( artifact, material ),
			( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
		);

		// Without a slim GPU resource this is a compute-owned input. The full
		// renderer may initialize it during dispatch, so it is not a share miss.
		slim.backend.store.set( texture, {} );
		full.backend.store.set( texture, {} );
		const recovered = await support.dispatchMaterialComputes( scene, { fullRenderer: full, dispatchOnce } );
		assert.equal( recovered.errors, 0 );
		assert.equal( recovered.dispatched, 1 );
		assert.equal( physicalDispatches, 1 );
		assert.equal( dispatchOnce.has( raw ), true );
		assert.equal( hydrateNodeBuilderState( artifact, material ).updateBeforeNodes.length, 1 );

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport rejects an unproven hybrid binding layout before dispatch', async () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	full.backend.device = slim.backend.device;
	const raw = { isNode: true, isComputeNode: true, traverse( visitor ) { visitor( this ); } };
	const artifact = contractComputeArtifact();
	artifact.materialCompute.reasons = [ 'kernel:0:binding-layout-unavailable' ];
	const material = { isPrecompiledMaterial: true, precompiledArtifact: artifact, positionNode: raw };
	const scene = { traverse( visitor ) { visitor( { material } ); } };
	full._nodes = { getForCompute: () => ( { bindings: [] } ) };
	full._bindings = { getForCompute: () => [] };
	let physicalDispatches = 0;
	full.computeAsync = async () => { physicalDispatches ++; };
	const dispatchOnce = new Set();
	const errors = [];
	const support = createSlimSceneSupport( { renderer: slim, fullRendererFallback: false } );

	try {

		const stats = await support.dispatchMaterialComputes( scene, {
			fullRenderer: full,
			dispatchOnce,
			onError: ( error ) => errors.push( error ),
		} );
		assert.equal( stats.dispatched, 0 );
		assert.equal( physicalDispatches, 0 );
		assert.equal( dispatchOnce.has( raw ), false );
		assert.equal( errors.some( ( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_BINDING_LAYOUT_UNAVAILABLE' ), true );

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport pre-shares read-only storage inputs without post-syncing them or decoys', async () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	full.backend.device = slim.backend.device;
	const inputAttribute = {
		isBufferAttribute: true,
		isStorageBufferAttribute: true,
		array: new Float32Array( 4 ),
		count: 1,
		itemSize: 4,
		version: 2,
	};
	const decoyAttribute = {
		isBufferAttribute: true,
		isStorageBufferAttribute: true,
		array: new Float32Array( 4 ),
		count: 1,
		itemSize: 4,
		version: 1,
	};
	const runtimeGroup = { bindings: [
		{ isStorageBuffer: true, access: 'readOnly', attribute: inputAttribute },
		{ isStorageBuffer: true, access: 'readOnly', attribute: decoyAttribute },
	] };
	const raw = {
		isNode: true,
		isComputeNode: true,
		storage: { attribute: inputAttribute },
		traverse( visitor ) { visitor( this ); },
	};
	const artifact = contractComputeArtifact( 'hybrid-required', { storageOutput: true, storageAccess: 'readOnly' } );
	artifact.attributes = [];
	artifact.materialCompute.renderBindings = [];
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		positionNode: raw,
	};
	const scene = { traverse( visitor ) { visitor( { material } ); } };
	full._nodes = { getForCompute: () => ( { bindings: [ runtimeGroup ] } ) };
	full._bindings = { getForCompute: () => [ runtimeGroup ] };
	const slimInputBuffer = { id: 'slim-input', size: 16 };
	const slimDecoyBuffer = { id: 'slim-decoy', size: 16 };
	const fullInputPlaceholder = { id: 'full-input-placeholder', size: 16 };
	const fullDecoyPlaceholder = { id: 'full-decoy-placeholder', size: 16 };
	slim.backend.get( inputAttribute ).buffer = slimInputBuffer;
	slim.backend.get( decoyAttribute ).buffer = slimDecoyBuffer;
	full.backend.get( inputAttribute ).buffer = fullInputPlaceholder;
	full.backend.get( decoyAttribute ).buffer = fullDecoyPlaceholder;
	const inputLocations = [];
	const outputLocations = [];
	let physicalDispatches = 0;
	full.computeAsync = async () => {

		physicalDispatches ++;
		assert.equal( full.backend.get( inputAttribute ).buffer, slimInputBuffer, 'contracted read input is shared before compute' );
		assert.equal( full.backend.get( decoyAttribute ).buffer, fullDecoyPlaceholder, 'uncontracted input decoy is not shared' );
		full.backend.get( inputAttribute ).buffer = { id: 'full-post-dispatch-input', size: 16 };
		full.backend.get( decoyAttribute ).buffer = { id: 'full-post-dispatch-decoy', size: 16 };

	};
	const support = createSlimSceneSupport( { renderer: slim, fullRendererFallback: false } );

	try {

		const stats = await support.dispatchMaterialComputes( scene, {
			fullRenderer: full,
			shareOptions: {
				onInputSynced: ( resource, binding, location, detail ) => inputLocations.push( `${ detail.kind }:${ location.group }:${ location.binding }` ),
			},
			syncOptions: {
				onOutputSynced: ( resource, binding, location, detail ) => outputLocations.push( `${ detail.kind }:${ location.group }:${ location.binding }` ),
			},
		} );
		assert.equal( stats.errors, 0 );
		assert.equal( stats.dispatched, 1 );
		assert.equal( physicalDispatches, 1 );
		assert.deepEqual( inputLocations, [ 'storage-buffer:0:0' ] );
		assert.deepEqual( outputLocations, [] );
		assert.equal( slim.backend.get( inputAttribute ).buffer, slimInputBuffer, 'read-only input is not reverse-synchronized as an output' );
		assert.equal( slim.backend.get( decoyAttribute ).buffer, slimDecoyBuffer, 'uncontracted decoy is untouched in both directions' );

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport keeps hybrid hydration closed when a contracted output was not synchronized', async () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	full.backend.device = slim.backend.device;
	const attribute = {
		isBufferAttribute: true,
		isStorageBufferAttribute: true,
		array: new Float32Array( 4 ),
		count: 1,
		itemSize: 4,
	};
	const raw = {
		isNode: true,
		isComputeNode: true,
		storage: { attribute },
		traverse( visitor ) { visitor( this ); },
	};
	const artifact = contractComputeArtifact( 'hybrid-required', { storageOutput: true, storageAccess: 'writeOnly' } );
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		positionNode: raw,
	};
	const scene = { traverse( visitor ) { visitor( { material } ); } };
	full._nodes = { getForCompute: () => ( { bindings: [] } ) };
	full._bindings = { getForCompute: () => [] };
	full.computeAsync = async () => {};
	const errors = [];
	const support = createSlimSceneSupport( { renderer: slim, fullRendererFallback: false } );

	try {

		const stats = await support.dispatchMaterialComputes( scene, {
			fullRenderer: full,
			onError: ( error ) => errors.push( error ),
		} );
		assert.equal( stats.errors, 1 );
		assert.equal( stats.dispatched, 0, 'a physical dispatch is not committed until every contracted output is synchronized' );
		assert.equal( errors.some( ( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_OUTPUT_SYNC_MISS' ), true );
		assert.throws(
			() => hydrateNodeBuilderState( artifact, material ),
			( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
		);

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport rejects hybrid object cadence for one material shared by multiple objects', async () => {

	const raw = { isNode: true, isComputeNode: true, traverse( visitor ) { visitor( this ); } };
	const artifact = contractComputeArtifact();
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		positionNode: raw,
	};
	const first = { material };
	const second = { material };
	const scene = { traverse( visitor ) { visitor( first ); visitor( second ); } };
	const errors = [];
	const support = createSlimSceneSupport( { renderer: fakeRenderer(), fullRendererFallback: false } );

	try {

		const stats = await support.dispatchMaterialComputes( scene, { onError: ( error ) => errors.push( error ) } );
		assert.equal( stats.errors, 1 );
		assert.equal( stats.dispatched, 0 );
		assert.equal( errors.some( ( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_OBJECT_CADENCE_UNSUPPORTED' ), true );
		assert.throws(
			() => hydrateNodeBuilderState( artifact, material ),
			( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
		);

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport rejects mixed hybrid kernel cadences before dispatch', async () => {

	const first = { isNode: true, isComputeNode: true, traverse( visitor ) { visitor( this ); } };
	const second = { isNode: true, isComputeNode: true, traverse( visitor ) { visitor( this ); } };
	const artifact = contractComputeArtifact( 'hybrid-required', { updateType: 'frame' } );
	const secondKernel = JSON.parse( JSON.stringify( artifact.materialCompute.kernels[ 0 ] ) );
	secondKernel.id = 'kernel:1';
	secondKernel.nodePath = [ 'colorNode' ];
	secondKernel.artifact.cacheKey = 2;
	secondKernel.artifact.name = 'contract-compute-2';
	artifact.meta.updateBeforeNodes = 2;
	artifact.materialCompute.kernels.push( secondKernel );
	artifact.materialCompute.schedule.push( {
		kernel: 'kernel:1',
		phase: 'update-before',
		order: 1,
		updateType: 'render',
	} );
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		positionNode: first,
		colorNode: second,
	};
	const scene = { traverse( visitor ) { visitor( { material } ); } };
	const errors = [];
	const support = createSlimSceneSupport( { renderer: fakeRenderer(), fullRendererFallback: false } );

	try {

		const stats = await support.dispatchMaterialComputes( scene, { onError: ( error ) => errors.push( error ) } );
		assert.equal( stats.errors, 1 );
		assert.equal( stats.dispatched, 0 );
		assert.equal( errors.some( ( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_MIXED_CADENCE_UNSUPPORTED' ), true );

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport rejects one hybrid object-cadence node shared across material owners', async () => {

	const raw = { isNode: true, isComputeNode: true, traverse( visitor ) { visitor( this ); } };
	const artifact = contractComputeArtifact();
	const firstMaterial = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		positionNode: raw,
	};
	const secondMaterial = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		positionNode: raw,
	};
	const scene = {
		traverse( visitor ) { visitor( { material: firstMaterial } ); visitor( { material: secondMaterial } ); },
	};
	const errors = [];
	const support = createSlimSceneSupport( { renderer: fakeRenderer(), fullRendererFallback: false } );

	try {

		const stats = await support.dispatchMaterialComputes( scene, { onError: ( error ) => errors.push( error ) } );
		assert.equal( stats.errors, 1 );
		assert.equal( stats.dispatched, 0 );
		assert.equal( errors.some( ( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_OBJECT_CADENCE_UNSUPPORTED' ), true );

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport serializes hybrid transactions so a later failure revokes an earlier claim', async () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	full.backend.device = slim.backend.device;
	const raw = { isNode: true, isComputeNode: true, traverse( visitor ) { visitor( this ); } };
	const artifact = contractComputeArtifact();
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		positionNode: raw,
	};
	const scene = { traverse( visitor ) { visitor( { material } ); } };
	full._nodes = { getForCompute: () => ( { bindings: [] } ) };
	full._bindings = { getForCompute: () => [] };
	let enterFirst;
	let releaseFirst;
	const firstEntered = new Promise( ( resolve ) => { enterFirst = resolve; } );
	const firstGate = new Promise( ( resolve ) => { releaseFirst = resolve; } );
	let calls = 0;
	full.computeAsync = async () => {

		calls ++;
		if ( calls === 1 ) {

			enterFirst();
			await firstGate;
			return;

		}
		throw new Error( 'later transaction failed' );

	};
	const support = createSlimSceneSupport( { renderer: slim, fullRendererFallback: false } );

	try {

		const first = support.dispatchMaterialComputes( scene, { fullRenderer: full } );
		await firstEntered;
		const second = support.dispatchMaterialComputes( scene, { fullRenderer: full } );
		await Promise.resolve();
		assert.equal( calls, 1, 'the second transaction waits behind the first' );
		releaseFirst();
		const [ firstStats, secondStats ] = await Promise.all( [ first, second ] );
		assert.equal( firstStats.errors, 0 );
		assert.equal( secondStats.errors, 1 );
		assert.equal( calls, 2 );
		assert.throws(
			() => hydrateNodeBuilderState( artifact, material ),
			( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
		);

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport revokes an earlier hybrid claim when the next dispatch fails', async () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	full.backend.device = slim.backend.device;
	const raw = { isNode: true, isComputeNode: true, traverse( visitor ) { visitor( this ); } };
	const artifact = contractComputeArtifact();
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		positionNode: raw,
	};
	const scene = { traverse( visitor ) { visitor( { material } ); } };
	full._nodes = { getForCompute: () => ( { bindings: [] } ) };
	full._bindings = { getForCompute: () => [] };
	full.computeAsync = async () => {};
	const support = createSlimSceneSupport( { renderer: slim, fullRendererFallback: false } );

	try {

		assert.equal( ( await support.dispatchMaterialComputes( scene, { fullRenderer: full } ) ).errors, 0 );
		const cachedState = hydrateNodeBuilderState( artifact, material );
		assert.doesNotThrow( () => cachedState.updateBeforeNodes[ 0 ].updateBefore( {} ) );
		full.computeAsync = async () => { throw new Error( 'dispatch failed' ); };
		const failed = await support.dispatchMaterialComputes( scene, { fullRenderer: full } );
		assert.equal( failed.errors, 1 );
		assert.throws(
			() => cachedState.updateBeforeNodes[ 0 ].updateBefore( {} ),
			( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
		);
		assert.throws(
			() => hydrateNodeBuilderState( artifact, material ),
			( error ) => error.code === 'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
		);

	} finally {

		await support.dispose();

	}

} );

test( 'createSlimSceneSupport normalizes empty material-compute stats', async () => {

	const support = createSlimSceneSupport( { renderer: fakeRenderer() } );
	const stats = await support.dispatchMaterialComputes( { traverse() {} } );
	assert.deepEqual( stats, {
		owners: 0,
		nodes: 0,
		dispatched: 0,
		attributesPrepared: 0,
		invalidated: 0,
		pending: 0,
		ambiguous: 0,
		incomplete: 0,
		irrelevant: 0,
		skipped: 0,
		errors: 0,
		dispatchResults: [],
		inputTexturesShared: 0,
		texturesShared: 0,
		storageAttrs: 0,
		buffersAdopted: 0,
		buffersCopied: 0,
		presentationNeeded: false,
	} );
	await support.dispose();

} );

test( 'createSlimSceneSupport syncComputeOutputs no-ops without throwing on an empty bind-group list', () => {

	const slim = fakeRenderer();
	const fullSrc = fakeRenderer();
	const support = createSlimSceneSupport( { renderer: slim } );
	const stats = support.syncComputeOutputs( 'compute-node', fullSrc );
	assert.deepEqual( stats, { texturesShared: 0, storageAttrs: 0, buffersAdopted: 0, buffersCopied: 0 } );

} );

test( 'createSlimSceneSupport dispose() tears the fallback renderer down', async () => {

	const support = createSlimSceneSupport( {
		renderer: fakeRenderer(),
		fullRendererFallback: true,
		threeFullModule: { WebGPURenderer: FakeFullRenderer },
	} );
	const full = await support.getFullRenderer();
	support.dispose();
	assert.equal( full.disposed, true );
	assert.equal( support.fallback.isInitialised(), false );

} );

test( 'createSlimSceneSupport owns an iterable shadow cache and can dispose one scene or all scenes', async () => {

	const slim = fakeRenderer();
	slim.shadowMap = { enabled: true, type: Three.PCFShadowMap, transmitted: false };
	const full = new DeferredShadowFullRenderer( { device: slim.backend.device } );
	await full.init();
	const Full = { ...Three, WebGPURenderer: DeferredShadowFullRenderer };
	const first = makeSupportShadowScene();
	const second = makeSupportShadowScene();
	const firstOriginalCamera = first.light.shadow.camera;
	const secondOriginalCamera = second.light.shadow.camera;
	const support = createSlimSceneSupport( { renderer: slim, fullRendererFallback: false } );

	assert.equal( ( await support.populateShadowMaps( first.scene, first.camera, { fullRenderer: full, threeFullModule: Full } ) ).complete, true );
	assert.equal( ( await support.populateShadowMaps( second.scene, second.camera, { fullRenderer: full, threeFullModule: Full } ) ).complete, true );
	assert.notEqual( first.light.shadow.camera, firstOriginalCamera );
	assert.notEqual( second.light.shadow.camera, secondOriginalCamera );
	assert.equal( await support.disposeShadowMaps( first.scene ), 1 );
	assert.equal( first.light.shadow.camera, firstOriginalCamera );
	assert.equal( await support.disposeShadowMaps( first.scene ), 0 );
	assert.equal( await support.disposeShadowMaps(), 1 );
	assert.equal( second.light.shadow.camera, secondOriginalCamera );
	await support.dispose();

} );

test( 'createSlimSceneSupport waits for in-flight shadow cleanup before disposing its fallback renderer', async () => {

	const slim = fakeRenderer();
	slim.shadowMap = { enabled: true, type: Three.PCFShadowMap, transmitted: false };
	const Full = { ...Three, WebGPURenderer: DeferredShadowFullRenderer };
	const support = createSlimSceneSupport( {
		renderer: slim,
		fullRendererFallback: true,
		threeFullModule: Full,
	} );
	const full = await support.getFullRenderer();
	const pause = full.pauseNextRender();
	const { scene, camera } = makeSupportShadowScene();
	const populate = support.populateShadowMaps( scene, camera );
	await pause.entered;
	const disposal = support.dispose();

	assert.equal( full.disposed, undefined, 'fallback renderer remains alive while its shadow render owns proxy resources' );
	pause.release();
	const [ result ] = await Promise.all( [ populate, disposal ] );
	assert.equal( result.complete, false );
	assert.equal( full.disposed, true );
	assert.deepEqual( full.events.slice( -2 ), [ 'shadow', 'renderer' ] );

} );

test( 'createSlimSceneSupport shareTexture forwards diagnostics into the shared bag', () => {

	const slim = fakeRenderer();
	const sourceRenderer = fakeRenderer();
	const tex = { isTexture: true, name: 'shared' };
	sourceRenderer.backend.get( tex ).texture = { __gpu: 'shared-tex' };
	const support = createSlimSceneSupport( { renderer: slim } );

	const ok = support.shareTexture( sourceRenderer, tex );
	assert.equal( ok, true );
	assert.equal( support.diagnostics.textureShare.calls, 1 );
	assert.equal( support.diagnostics.textureShare.success, 1 );

} );

test( 'createSlimSceneSupport indexScene walks scene.traverse + registers textures', () => {

	clearLiveTextureIndex();
	const support = createSlimSceneSupport( { renderer: fakeRenderer() } );
	const tex = { isTexture: true, uuid: 'scene-tex', name: 'scene-color.png', image: { width: 1, height: 1 } };
	const scene = {
		background: tex,
		traverse( visit ) { visit( { material: {} } ); },
	};
	support.indexScene( scene );
	const found = support.liveSceneIndex.texturesByUuid.get( 'scene-tex' );
	assert.equal( found, tex );
	assert.equal( lookupLiveTextureByIdentity( { textureName: 'scene-color.png' } ), tex );
	clearLiveTextureIndex();

} );

test( 'createSlimSceneSupport patches provided TextureLoader classes for artifact relinking', () => {

	clearLiveTextureIndex();
	class FakeTextureLoader {

		load( url, onLoad ) {

			const texture = { isTexture: true, uuid: 'loaded-tex', name: '', userData: {}, image: null };
			if ( typeof onLoad === 'function' ) onLoad( texture );
			return texture;

		}

	}

	const support = createSlimSceneSupport( {
		renderer: fakeRenderer(),
		threeModule: { TextureLoader: FakeTextureLoader },
	} );
	assert.equal( support.diagnostics.loader.patchedClasses, 1 );

	const texture = new FakeTextureLoader().load( 'textures/Caustic_Free.jpg' );
	assert.equal( texture.userData.__tslpLoaderUrl, 'textures/Caustic_Free.jpg' );
	assert.equal( texture.name, 'Caustic_Free.jpg' );
	assert.equal( lookupLiveTextureByIdentity( { imageSrc: 'textures/Caustic_Free.jpg' } ), texture );
	clearLiveTextureIndex();

} );

test( 'createSlimSceneSupport patches lazy full-module TextureLoader classes after boot', async () => {

	clearLiveTextureIndex();
	class FakeTextureLoader {

		load( url ) {

			return { isTexture: true, uuid: 'lazy-loaded-tex', name: '', userData: {}, image: null };

		}

	}
	const support = createSlimSceneSupport( {
		renderer: fakeRenderer(),
		fullRendererFallback: true,
		loadThreeFullModule: async () => ( {
			WebGPURenderer: FakeFullRenderer,
			TextureLoader: FakeTextureLoader,
		} ),
	} );

	await support.getFullRenderer();
	const texture = new FakeTextureLoader().load( 'textures/lazy-caustic.jpg' );
	assert.equal( texture.userData.__tslpLoaderUrl, 'textures/lazy-caustic.jpg' );
	assert.equal( lookupLiveTextureByIdentity( { textureName: 'lazy-caustic.jpg' } ), texture );
	clearLiveTextureIndex();

} );

test( 'createSlimSceneSupport generatePMREMAsync demands an explicit generator function', async () => {

	const support = createSlimSceneSupport( { renderer: fakeRenderer() } );
	await assert.rejects(
		() => support.generatePMREMAsync( { isTexture: true } ),
		/needs a `\(renderer, sourceTexture\) => Promise/,
	);

} );

test( 'createSlimSceneSupport generatePMREMAsync routes through the PMREM cache on first call', async () => {

	const support = createSlimSceneSupport( { renderer: fakeRenderer() } );
	// `image` is required so the PMREM cache's textureImageReady() returns true.
	const source = { isTexture: true, name: 'env.hdr', image: { width: 256, height: 256 } };
	const pmremResult = { isTexture: true, name: 'PMREM.cubeUv' };
	const generator = async ( _, src ) => {

		assert.equal( src, source );
		return pmremResult;

	};
	const out = await support.generatePMREMAsync( source, generator );
	assert.equal( out, pmremResult );
	// Cache hit on the second call → does not re-invoke the generator.
	let secondCalled = false;
	const cached = await support.generatePMREMAsync( source, async () => { secondCalled = true; return pmremResult; } );
	assert.equal( cached, pmremResult );
	assert.equal( secondCalled, false );

} );

test( 'pinClock(t) stores a finite number on globalThis.__tslpPinnedClock', () => {

	try {

		pinClock( 1.25 );
		assert.equal( globalThis.__tslpPinnedClock, 1.25 );
		pinClock( 0 );
		assert.equal( globalThis.__tslpPinnedClock, 0 );

	} finally {

		unpinClock();

	}

} );

test( 'pinClock with a non-finite value clears the pin', () => {

	try {

		pinClock( 7 );
		assert.equal( globalThis.__tslpPinnedClock, 7 );
		pinClock( NaN );
		assert.equal( globalThis.__tslpPinnedClock, null );
		pinClock( 9 );
		pinClock( Infinity );
		assert.equal( globalThis.__tslpPinnedClock, null );
		pinClock( 3 );
		pinClock( 'oops' );
		assert.equal( globalThis.__tslpPinnedClock, null );

	} finally {

		unpinClock();

	}

} );

test( 'unpinClock() clears the pin', () => {

	pinClock( 42 );
	assert.equal( globalThis.__tslpPinnedClock, 42 );
	unpinClock();
	assert.equal( globalThis.__tslpPinnedClock, null );

} );

test( 'createSlimSceneSupport exposes clock and logical-frame scopes', () => {

	const renderer = fakeRenderer();
	const support = createSlimSceneSupport( { renderer } );
	try {

		assert.equal( typeof support.pinClock, 'function' );
		assert.equal( typeof support.unpinClock, 'function' );
		support.pinClock( 0.5 );
		assert.equal( globalThis.__tslpPinnedClock, 0.5 );
		support.unpinClock();
		assert.equal( globalThis.__tslpPinnedClock, null );
		assert.equal( typeof support.withTemporalFrame, 'function' );
		support.withTemporalFrame( { frameId: 4, advance: false }, () => {

			assert.deepEqual( getTemporalFrameState( renderer ), { frameId: 4, renderId: 4, time: null, advance: false } );

		} );
		assert.equal( getTemporalFrameState( renderer ), null );

	} finally {

		unpinClock();

	}

} );

test( 'createSlimSceneSupport renderPassWithFallback renders through a full renderer and shares pass textures', async () => {

	const slim = fakeRenderer();
	const full = fakePassFullRenderer();
	const support = createSlimSceneSupport( { renderer: slim } );
	const texture = { isTexture: true, name: 'pass-color', version: 5 };
	const depthTexture = { isTexture: true, name: 'pass-depth', version: 6 };
	full.backend.get( texture ).texture = { gpu: 'color' };
	full.backend.get( depthTexture ).texture = { gpu: 'depth' };
	const passNode = {
		scene: { isScene: true },
		camera: { isCamera: true },
		renderTarget: { texture, depthTexture },
	};

	const stats = await support.renderPassWithFallback( passNode, { fullRenderer: full } );

	assert.deepEqual( stats, { rendered: true, texturesShared: 1, depthShared: true } );
	assert.equal( full._rendered.scene, passNode.scene );
	assert.equal( slim.backend.get( texture ).texture, full.backend.get( texture ).texture );
	assert.equal( slim.backend.get( depthTexture ).texture, full.backend.get( depthTexture ).texture );

} );

test( 'createSlimSceneSupport renderOffscreenOverrideWithFallback renders current override target and shares textures', async () => {

	const slim = fakeRenderer();
	const full = fakePassFullRenderer();
	const support = createSlimSceneSupport( { renderer: slim } );
	const texture = { isTexture: true, name: 'override-color', version: 9 };
	const depthTexture = { isTexture: true, name: 'override-depth', version: 10 };
	const renderTarget = { texture, depthTexture };
	const scene = { isScene: true, overrideMaterial: { name: 'depth-override' } };
	const camera = { isCamera: true };
	full.backend.get( texture ).texture = { gpu: 'override-color' };
	full.backend.get( depthTexture ).texture = { gpu: 'override-depth' };

	const stats = await support.renderOffscreenOverrideWithFallback( scene, camera, {
		fullRenderer: full,
		renderTarget,
	} );

	assert.deepEqual( stats, { rendered: true, texturesShared: 1, depthShared: true } );
	assert.equal( full._rendered.scene, scene );
	assert.equal( full._rendered.camera, camera );
	assert.equal( slim.backend.get( texture ).texture, full.backend.get( texture ).texture );
	assert.equal( slim.backend.get( depthTexture ).texture, full.backend.get( depthTexture ).texture );

} );

test( 'createSlimSceneSupport renderPassWithFallback shares MRT color attachments', async () => {

	const slim = fakeRenderer();
	const full = fakePassFullRenderer();
	const support = createSlimSceneSupport( { renderer: slim } );
	const colorA = { isTexture: true, name: 'mrt-output', version: 7 };
	const colorB = { isTexture: true, name: 'mrt-normal', version: 8 };
	full.backend.get( colorA ).texture = { gpu: 'mrt-output' };
	full.backend.get( colorB ).texture = { gpu: 'mrt-normal' };
	const passNode = {
		scene: { isScene: true },
		camera: { isCamera: true },
		renderTarget: { textures: [ colorA, colorB ] },
		_mrt: { outputNodes: { output: {}, normal: {} } },
	};

	const stats = await support.renderPassWithFallback( passNode, { fullRenderer: full } );

	assert.deepEqual( stats, { rendered: true, texturesShared: 2, depthShared: false } );
	assert.equal( full._rendered.mrt, passNode._mrt );
	assert.equal( slim.backend.get( colorA ).texture, full.backend.get( colorA ).texture );
	assert.equal( slim.backend.get( colorB ).texture, full.backend.get( colorB ).texture );

} );

test( 'createSlimSceneSupport renderPassWithFallback reports a missing fallback without throwing', async () => {

	const support = createSlimSceneSupport( { renderer: fakeRenderer(), fullRendererFallback: false } );
	let message = '';
	const stats = await support.renderPassWithFallback( { scene: {}, renderTarget: {} }, {
		onError: ( err ) => { message = err.message; },
	} );

	assert.deepEqual( stats, { rendered: false, texturesShared: 0, depthShared: false } );
	assert.match( message, /fullRendererFallback: true/ );

} );
