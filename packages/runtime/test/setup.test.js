import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { setupPrecompile } from '../src/setup.js';
import {
	installPrecompileMarker,
	setDevRenderer,
	__cloneLightsIntoForTests,
	__resetForTests as resetMarkerForTests,
} from '../src/precompile-marker.js';
import { recordDevCaptureOutcome } from '../src/dev-capture-outcome.js';

const MARKER_METHOD = 'precompile';

function fakeThree() {

	const Material = function Material() {};
	Material.prototype = {};
	return { Material, REVISION: '185' };

}

function fakeRenderer( { initialised = false, withInit = false } = {} ) {

	const renderer = {
		// Real WebGPURenderer owns a backend before init() resolves.
		backend: {},
		_initialized: initialised,
		_frameBufferTarget: { texture: { isArrayTexture: false } },
		outputColorSpace: 'srgb',
		toneMapping: 0,
		get initialized() { return this._initialized; },
		_getFrameBufferTarget() { return this._frameBufferTarget; },
		render() {},
	};
	if ( withInit ) {
		renderer.init = async () => {
			await Promise.resolve();
			renderer._initialized = true;
			return renderer;
		};
	}
	return renderer;

}

function freshHarness() {

	resetMarkerForTests();
	// `installPrecompileMarker` skips re-install when the method already exists
	// on the prototype, so each test gets its own Material class.
	return { three: fakeThree() };

}

function createCaptureServer() {

	const posts = [];
	const server = createServer( ( req, res ) => {

		let body = '';
		req.setEncoding( 'utf8' );
		req.on( 'data', ( chunk ) => { body += chunk; } );
		req.on( 'end', () => {

			try { posts.push( JSON.parse( body ) ); } catch ( _ ) {}
			res.statusCode = 200;
			res.end( 'ok' );

		} );

	} );

	return new Promise( ( resolve ) => {

		server.listen( 0, '127.0.0.1', () => {

			const address = server.address();
			resolve( {
				posts,
				url: `http://127.0.0.1:${ address.port }/__tsl-precompile/capture`,
				close: () => new Promise( ( done ) => server.close( done ) ),
			} );

		} );

	} );

}

test( 'setupPrecompile installs marker and resolves ready after init', async () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer( { withInit: true } );

	const setup = setupPrecompile( { three, renderer } );

	// Marker installed synchronously, regardless of init() ordering.
	assert.equal( typeof three.Material.prototype[ MARKER_METHOD ], 'function' );
	assert.ok( setup && typeof setup.ready.then === 'function', 'returns { ready }' );
	assert.equal( typeof setup.captureAux, 'function' );
	assert.equal( typeof setup.captureStatus, 'function' );
	assert.equal( typeof setup.waitForCaptureSettled, 'function' );
	assert.equal( renderer.__tslpRenderWrapped, undefined, 'renderer is not registered before init resolves' );
	assert.ok( renderer.backend, 'backend may exist before init without resolving setup.ready' );

	await renderer.init();
	await setup.ready;
	assert.equal( renderer.__tslpRenderWrapped, true, 'setDevRenderer ran after ready' );

} );

test( 'setupPrecompile preserves an explicit null capture-settlement baseline', async () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer( { initialised: true } );
	const setup = setupPrecompile( { three, renderer } );
	await setup.ready;
	recordDevCaptureOutcome( true );
	await setup.waitForCaptureSettled( {
		timeoutMs: 1_000,
		settleMs: 0,
		rejectOnFailure: false,
	} );

	const fromProcessStart = await setup.waitForCaptureSettled( {
		since: null,
		timeoutMs: 100,
		settleMs: 0,
		rejectOnFailure: false,
	} );
	assert.ok( fromProcessStart.acceptedCaptures > 0 );

} );

test( 'setupPrecompile installs physical RangeNode capture without touching Math.random', async () => {

	const { three } = freshHarness();
	class RangeNode {

		constructor() {

			this.id = 21;
			this.minNode = { value: 0 };
			this.maxNode = { value: 1 };

		}

		getConstNode( node ) { return node; }
		getNodeType() { return 'float'; }
		setup( builder ) {

			const array = new Float32Array( builder.object.count * 4 );
			for ( let index = 0; index < array.length; index ++ ) array[ index ] = Math.random();
			return { array };

		}

	}
	class InstancedBufferAttribute {

		constructor( array, itemSize ) {

			this.array = array;
			this.itemSize = itemSize;
			this.count = array.length / itemSize;
			this.isBufferAttribute = true;
			this.isInstancedBufferAttribute = true;

		}

	}
	Object.assign( three, {
		RangeNode,
		InstancedBufferAttribute,
		TSL: { instancedBufferAttribute: ( attribute ) => ( { convert: () => ( { attribute } ) } ) },
	} );
	const renderer = fakeRenderer( { initialised: true } );
	const setup = setupPrecompile( { three, renderer } );
	await setup.ready;

	const geometry = {
		attribute: null,
		setAttribute( name, attribute ) { if ( name === '__range21' ) this.attribute = attribute; },
		getAttribute( name ) { return name === '__range21' ? this.attribute : null; },
	};
	const originalRandom = Math.random;
	let randomCalls = 0;
	Math.random = () => { randomCalls ++; return 0.5; };
	try {

		new RangeNode().setup( { object: { count: 3 }, geometry, getUniformBufferLimit: () => 0 } );

	} finally {

		Math.random = originalRandom;

	}
	assert.equal( randomCalls, 0 );
	assert.ok( geometry.attribute[ Symbol.for( '@tsl-precompile/range-attribute-generator@1' ) ] );

} );

test( 'setupPrecompile registers immediately when the renderer is already initialised', async () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer( { initialised: true } );

	const setup = setupPrecompile( { three, renderer } );

	// Already-initialised path: setDevRenderer ran synchronously, ready is a
	// resolved promise.
	assert.equal( renderer.__tslpRenderWrapped, true );
	await setup.ready; // does not hang

} );

test( 'setupPrecompile ready rejects when renderer initialization fails', async () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer();
	const failure = new Error( 'backend unavailable' );
	renderer.init = async () => { throw failure; };

	const setup = setupPrecompile( { three, renderer } );

	await assert.rejects( renderer.init(), failure );
	await assert.rejects( setup.ready, failure );

} );

test( 'setupPrecompile observes an initialization already in flight', async () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer();
	let finishInit;
	renderer._initPromise = new Promise( ( resolve ) => { finishInit = resolve; } );
	renderer.init = () => renderer._initPromise;

	const setup = setupPrecompile( { three, renderer } );
	renderer._initialized = true;
	finishInit( renderer );

	await setup.ready;
	assert.equal( renderer.__tslpRenderWrapped, true );

} );

test( 'setupPrecompile is idempotent under double-call', async () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer( { initialised: true } );

	const first = setupPrecompile( { three, renderer } );
	const second = setupPrecompile( { three, renderer } );

	await first.ready;
	await second.ready;
	assert.equal( renderer.__tslpRenderWrapped, true );
	// Marker method still single; calling install twice should not throw.
	assert.equal( typeof three.Material.prototype[ MARKER_METHOD ], 'function' );

} );

test( 'setupPrecompile can leave automatic renderer-output capture to named manual captures', async () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer( { initialised: true } );
	const autoCaptureState = Symbol.for( '@tsl-precompile/runtime/auto-output-capture-state' );
	const originalAutoCapture = globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__;
	globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__ = true;

	try {

		const setup = setupPrecompile( {
			three,
			renderer,
			captureRendererOutput: false,
		} );
		await setup.ready;

		assert.equal(
			renderer[ autoCaptureState ],
			undefined,
			'the manual-capture opt-out must not install automatic renderer-output state',
		);

	} finally {

		resetMarkerForTests();
		if ( originalAutoCapture === undefined ) delete globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__;
		else globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__ = originalAutoCapture;

	}

} );

test( 'slim-mode setup captures renderer output once per successful real-render topology', async () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer( { initialised: true } );
	let renderFailure = true;
	renderer.render = () => {

		if ( renderFailure ) throw new Error( 'render failed' );

	};
	const setupScene = { name: 'setup-scene', traverse() {} };
	const setupCamera = { name: 'setup-camera' };
	const observedScene = { name: 'observed-scene', isScene: true };
	const observedCamera = { name: 'observed-camera' };
	const baseReplayConfig = {
		schema: 'renderer-output@1',
		currentColorSpace: 'srgb',
		logarithmicDepthBuffer: false,
		sampledTexture: '2d',
		multiview: false,
	};
	const outputArtifact = {
		materialShape: 'output-transform',
		vertexShader: 'output-vertex',
		fragmentShader: 'output-fragment',
		uniformPlan: [ { name: 'object', textures: [ {
			bindingKind: 'sampled-texture',
			textureType: '2d',
			source: { kind: 'artifact.texture', textureUuid: 'output-texture', mapping: 300 },
		} ] } ],
	};
	const compileCalls = [];
	const compileTSL = async ( activeRenderer, scene, camera, options ) => {

		compileCalls.push( { activeRenderer, scene, camera, options } );
		const artifacts = [ outputArtifact ];
		Object.defineProperty( artifacts, 'renderOutputCapture', {
			value: {
				artifact: outputArtifact,
				replayConfig: {
					...baseReplayConfig,
					toneMapping: activeRenderer.toneMapping,
					currentColorSpace: activeRenderer.outputColorSpace,
				},
			},
		} );
		return artifacts;

	};
	const originalFetch = globalThis.fetch;
	const originalAutoCapture = globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__;
	const originalThreeVersion = globalThis.__TSLP_THREE_PACKAGE_VERSION__;
	const originalSynthetic = globalThis.__tslpSyntheticRenderActive;
	const posts = [];
	globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__ = true;
	globalThis.__TSLP_THREE_PACKAGE_VERSION__ = '0.184.0';
	globalThis.fetch = async ( endpoint, request ) => {

		posts.push( { endpoint, payload: JSON.parse( request.body ) } );
		return { ok: true, text: async () => '' };

	};

	try {

		const opts = {
			three,
			renderer,
			scene: setupScene,
			camera: setupCamera,
			devEndpoint: '/capture',
			aux: { compileTSL },
		};
		const first = setupPrecompile( opts );
		const second = setupPrecompile( opts );
		await Promise.all( [ first.ready, second.ready ] );

		globalThis.__tslpSyntheticRenderActive = 1;
		assert.throws( () => renderer.render( observedScene, observedCamera ), /render failed/ );
		globalThis.__tslpSyntheticRenderActive = 0;
		assert.throws( () => renderer.render( observedScene, observedCamera ), /render failed/ );
		assert.equal( compileCalls.length, 0, 'synthetic and failed renders do not trigger output capture' );

		renderFailure = false;
		renderer.render( observedScene, observedCamera );
		renderer.render( observedScene, observedCamera );
		for ( let i = 0; i < 20 && posts.length === 0; i ++ ) await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

		assert.equal( compileCalls.length, 1 );
		assert.equal( compileCalls[ 0 ].activeRenderer, renderer );
		assert.equal( compileCalls[ 0 ].scene, observedScene );
		assert.equal( compileCalls[ 0 ].camera, observedCamera );
		assert.deepEqual( compileCalls[ 0 ].options, {
			noGlobalMRT: true,
			captureRendererOutput: true,
			rendererOutputConfig: {
				schema: 'renderer-output@1',
				toneMapping: 0,
				currentColorSpace: 'srgb',
				logarithmicDepthBuffer: false,
				sampledTexture: '2d',
				multiview: false,
			},
		} );
		assert.equal( posts.length, 1, 'double setup and later renders reuse the first output capture' );
		assert.equal( posts[ 0 ].endpoint, '/capture' );
		assert.equal( posts[ 0 ].payload.materialShape, 'render-output' );

		renderer.render( observedScene, observedCamera );
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		assert.equal( compileCalls.length, 1, 'an already captured topology is ignored' );

		renderer.toneMapping = 4;
		renderer.render( observedScene, observedCamera );
		for ( let i = 0; i < 20 && posts.length < 2; i ++ ) await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		assert.equal( compileCalls.length, 2, 'a new output topology is captured independently' );
		assert.equal( posts.length, 2 );
		assert.notEqual( posts[ 0 ].payload.configHash, posts[ 1 ].payload.configHash );

	} finally {

		resetMarkerForTests();
		globalThis.fetch = originalFetch;
		if ( originalAutoCapture === undefined ) delete globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__;
		else globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__ = originalAutoCapture;
		if ( originalThreeVersion === undefined ) delete globalThis.__TSLP_THREE_PACKAGE_VERSION__;
		else globalThis.__TSLP_THREE_PACKAGE_VERSION__ = originalThreeVersion;
		if ( originalSynthetic === undefined ) delete globalThis.__tslpSyntheticRenderActive;
		else globalThis.__tslpSyntheticRenderActive = originalSynthetic;

	}

} );

test( 'slim-mode renderer-output capture retries a failed publish on a later real render', async () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer( { initialised: true } );
	const scene = { isScene: true };
	const camera = {};
	const artifact = {
		materialShape: 'output-transform',
		vertexShader: 'output-vertex',
		fragmentShader: 'output-fragment',
		uniformPlan: [ { name: 'object', textures: [ {
			bindingKind: 'sampled-texture',
			textureType: '2d',
			source: { kind: 'artifact.texture', textureUuid: 'output-texture', mapping: 300 },
		} ] } ],
	};
	let compileCalls = 0;
	const compileTSL = async () => {

		compileCalls ++;
		const artifacts = [ artifact ];
		Object.defineProperty( artifacts, 'renderOutputCapture', {
			value: {
				artifact,
				replayConfig: {
					schema: 'renderer-output@1',
					toneMapping: renderer.toneMapping,
					currentColorSpace: renderer.outputColorSpace,
					logarithmicDepthBuffer: renderer.logarithmicDepthBuffer === true,
					sampledTexture: '2d',
					multiview: false,
				},
			},
		} );
		return artifacts;

	};
	const originalFetch = globalThis.fetch;
	const originalAutoCapture = globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__;
	const originalThreeVersion = globalThis.__TSLP_THREE_PACKAGE_VERSION__;
	const originalConsoleError = console.error;
	let posts = 0;
	const errors = [];
	globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__ = true;
	globalThis.__TSLP_THREE_PACKAGE_VERSION__ = '0.184.0';
	globalThis.fetch = async () => {

		posts ++;
		return posts === 1
			? { ok: false, status: 503, text: async () => 'try again' }
			: { ok: true, text: async () => '' };

	};
	console.error = ( ...args ) => errors.push( args.join( ' ' ) );

	try {

		const setup = setupPrecompile( { three, renderer, aux: { compileTSL }, scene, camera } );
		await setup.ready;
		renderer.render( scene, camera );
		for ( let i = 0; i < 20 && posts < 1; i ++ ) await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		assert.equal( posts, 1 );
		assert.match( errors.join( '\n' ), /retrying on the next real render/ );

		renderer.render( scene, camera );
		for ( let i = 0; i < 20 && posts < 2; i ++ ) await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		assert.equal( posts, 2 );
		assert.equal( compileCalls, 2 );

		renderer.render( scene, camera );
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		assert.equal( posts, 2, 'successful retry terminally dedupes the topology' );

	} finally {

		resetMarkerForTests();
		globalThis.fetch = originalFetch;
		console.error = originalConsoleError;
		if ( originalAutoCapture === undefined ) delete globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__;
		else globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__ = originalAutoCapture;
		if ( originalThreeVersion === undefined ) delete globalThis.__TSLP_THREE_PACKAGE_VERSION__;
		else globalThis.__TSLP_THREE_PACKAGE_VERSION__ = originalThreeVersion;

	}

} );

test( 'slim-mode output capture keys nested offscreen waves after canvas state is restored', async () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer( { initialised: true } );
	const outputTarget = { texture: { isArrayTexture: false } };
	const outerScene = { isScene: true, name: 'outer' };
	const offscreenScene = { isScene: true, name: 'offscreen' };
	const camera = {};
	let insideOffscreen = false;
	Object.defineProperty( renderer, 'currentColorSpace', {
		configurable: true,
		get() { return insideOffscreen ? 'srgb-linear' : renderer.outputColorSpace; },
	} );
	renderer._getFrameBufferTarget = () => insideOffscreen ? null : outputTarget;
	renderer.render = () => {

		if ( insideOffscreen ) return;
		insideOffscreen = true;
		renderer.render( offscreenScene, camera );
		insideOffscreen = false;

	};
	const artifact = {
		materialShape: 'output-transform',
		vertexShader: 'output-vertex',
		fragmentShader: 'output-fragment',
		uniformPlan: [ { name: 'object', textures: [ {
			bindingKind: 'sampled-texture',
			textureType: '2d',
			source: { kind: 'artifact.texture', textureUuid: 'output-texture', mapping: 300 },
		} ] } ],
	};
	let compileCalls = 0;
	const compileTSL = async () => {

		compileCalls ++;
		const artifacts = [ artifact ];
		Object.defineProperty( artifacts, 'renderOutputCapture', {
			value: {
				artifact,
				replayConfig: {
					schema: 'renderer-output@1',
					toneMapping: renderer.toneMapping,
					currentColorSpace: renderer.outputColorSpace,
					logarithmicDepthBuffer: renderer.logarithmicDepthBuffer === true,
					sampledTexture: '2d',
					multiview: false,
				},
			},
		} );
		return artifacts;

	};
	const originalFetch = globalThis.fetch;
	const originalAutoCapture = globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__;
	const originalThreeVersion = globalThis.__TSLP_THREE_PACKAGE_VERSION__;
	let posts = 0;
	globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__ = true;
	globalThis.__TSLP_THREE_PACKAGE_VERSION__ = '0.184.0';
	globalThis.fetch = async () => {

		posts ++;
		return { ok: true, text: async () => '' };

	};

	try {

		const setup = setupPrecompile( { three, renderer, aux: { compileTSL }, scene: outerScene, camera } );
		await setup.ready;
		renderer.render( outerScene, camera );
		for ( let i = 0; i < 20 && posts < 1; i ++ ) await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		renderer.render( outerScene, camera );
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		assert.equal( compileCalls, 1, 'offscreen and outer renders share the restored canvas topology' );

		renderer.outputColorSpace = 'display-p3';
		renderer.render( outerScene, camera );
		for ( let i = 0; i < 20 && posts < 2; i ++ ) await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		assert.equal( compileCalls, 2, 'a later canvas output-color topology remains observable' );
		assert.equal( posts, 2 );

	} finally {

		resetMarkerForTests();
		globalThis.fetch = originalFetch;
		if ( originalAutoCapture === undefined ) delete globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__;
		else globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__ = originalAutoCapture;
		if ( originalThreeVersion === undefined ) delete globalThis.__TSLP_THREE_PACKAGE_VERSION__;
		else globalThis.__TSLP_THREE_PACKAGE_VERSION__ = originalThreeVersion;

	}

} );

test( 'slim-mode output capture queues a distinct topology observed during a slow capture', async () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer( { initialised: true } );
	const scene = { isScene: true };
	const camera = {};
	const artifact = {
		materialShape: 'output-transform',
		vertexShader: 'output-vertex',
		fragmentShader: 'output-fragment',
		uniformPlan: [ { name: 'object', textures: [ {
			bindingKind: 'sampled-texture',
			textureType: '2d',
			source: { kind: 'artifact.texture', textureUuid: 'output-texture', mapping: 300 },
		} ] } ],
	};
	let releaseFirst;
	const firstCaptureGate = new Promise( ( resolve ) => { releaseFirst = resolve; } );
	const capturedConfigs = [];
	const compileTSL = async ( _renderer, _scene, _camera, options ) => {

		const index = capturedConfigs.length;
		capturedConfigs.push( options.rendererOutputConfig );
		if ( index === 0 ) await firstCaptureGate;
		const artifacts = [ artifact ];
		Object.defineProperty( artifacts, 'renderOutputCapture', {
			value: { artifact, replayConfig: options.rendererOutputConfig },
		} );
		return artifacts;

	};
	const originalFetch = globalThis.fetch;
	const originalAutoCapture = globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__;
	const originalThreeVersion = globalThis.__TSLP_THREE_PACKAGE_VERSION__;
	const posts = [];
	globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__ = true;
	globalThis.__TSLP_THREE_PACKAGE_VERSION__ = '0.184.0';
	globalThis.fetch = async ( _endpoint, request ) => {

		posts.push( JSON.parse( request.body ) );
		return { ok: true, text: async () => '' };

	};

	try {

		const setup = setupPrecompile( { three, renderer, aux: { compileTSL }, scene, camera } );
		await setup.ready;
		renderer.render( scene, camera );
		for ( let i = 0; i < 20 && capturedConfigs.length < 1; i ++ ) await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

		renderer.toneMapping = 4;
		renderer.render( scene, camera );
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		renderer.toneMapping = 0;
		releaseFirst();
		for ( let i = 0; i < 20 && posts.length < 2; i ++ ) await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

		assert.equal( capturedConfigs.length, 2 );
		assert.deepEqual( capturedConfigs.map( ( config ) => config.toneMapping ), [ 0, 4 ] );
		assert.equal( posts.length, 2 );
		assert.notEqual( posts[ 0 ].configHash, posts[ 1 ].configHash );

	} finally {

		releaseFirst();
		resetMarkerForTests();
		globalThis.fetch = originalFetch;
		if ( originalAutoCapture === undefined ) delete globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__;
		else globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__ = originalAutoCapture;
		if ( originalThreeVersion === undefined ) delete globalThis.__TSLP_THREE_PACKAGE_VERSION__;
		else globalThis.__TSLP_THREE_PACKAGE_VERSION__ = originalThreeVersion;

	}

} );

test( 'setupPrecompile short-circuits in slim mode via __TSLP_SLIM__ sentinel', async () => {

	resetMarkerForTests();
	const slimThree = { __TSLP_SLIM__: true };
	const renderer = fakeRenderer( { initialised: true } );

	const setup = setupPrecompile( { three: slimThree, renderer } );

	await setup.ready;
	// No marker install, no render wrap — slim does not need either.
	assert.equal( renderer.__tslpRenderWrapped, undefined );
	const aux = await setup.captureAux();
	assert.deepEqual( aux, [] );

} );

test( 'setupPrecompile short-circuits when the renderer comes from the slim bundle', async () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer( { initialised: true } );
	renderer.constructor = { __TSLP_SLIM__: true };

	const setup = setupPrecompile( { three, renderer } );

	await setup.ready;
	assert.equal( renderer.__tslpRenderWrapped, undefined );
	assert.equal( three.Material.prototype[ MARKER_METHOD ], undefined );

} );

test( 'setupPrecompile captureAux merges per-call MRT pass options', async () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer( { initialised: true } );
	const scene = {
		uuid: 'scene-mrt',
		userData: {},
		traverse( visitor ) { visitor( this ); },
	};
	const camera = { uuid: 'camera-mrt' };
	const captureTarget = {
		width: 320,
		height: 240,
		textures: [ { name: 'normal' }, { name: 'output' } ],
		disposed: false,
		setSize( width, height ) {

			this.width = width;
			this.height = height;

		},
		dispose() { this.disposed = true; },
	};
	const passNode = {
		isPassNode: true,
		_mrt: { outputNodes: { output: {}, normal: {} } },
		renderTarget: {
			textures: [ { name: 'normal' }, { name: 'output' } ],
			clone: () => captureTarget,
		},
	};
	const compileCalls = [];
	const compileTSL = async ( ...args ) => {

		compileCalls.push( args );
		return [
			{ materialShape: 'post-process', vertexShader: '', fragmentShader: '', uniformPlan: [] },
			{ materialShape: 'output-transform', vertexShader: '', fragmentShader: '', uniformPlan: [] },
		];

	};
	const capture = await createCaptureServer();

	try {

		const setup = setupPrecompile( {
			three,
			renderer,
			scene,
			camera,
			devEndpoint: capture.url,
			aux: { compileTSL },
		} );

		await setup.ready;
		const results = await setup.captureAux( { passNode } );

		assert.equal( scene.userData.__tslp_mrtNode, passNode._mrt );
		assert.equal( compileCalls.some( ( call ) => call[ 3 ] && call[ 3 ].mrtNode === passNode._mrt ), true );
		assert.equal( compileCalls.some( ( call ) => call[ 3 ] && call[ 3 ].renderTargetOverride === captureTarget ), true );
		assert.deepEqual( [ captureTarget.width, captureTarget.height ], [ 1, 1 ] );
		assert.equal( captureTarget.disposed, true );
		assert.equal( results.some( ( result ) => result.shape === 'mrt' && result.ok === true ), true );
		const postedMRT = capture.posts.find( ( post ) => post.materialShape === 'mrt' );
		assert.ok( postedMRT );
		assert.deepEqual( postedMRT.artifact.mrt.outputNames, [ 'normal', 'output' ], 'MRT metadata retains attachment-index order' );

	} finally {

		await capture.close();

	}

} );

test( 'precompile marker captures a non-MRT material variant for pass-level MRT scenes', async () => {

	resetMarkerForTests();

	class Material {

		constructor() {

			this.uuid = 'mat-pass-mrt';

		}

	}
	class Scene {

		constructor() {

			this.isScene = true;
			this.userData = {};
			this.children = [];

		}

		add( object ) {

			this.children.push( object );
			object.parent = this;

		}

		traverse( visitor ) {

			visitor( this );
			for ( const child of this.children ) visitor( child );

		}

	}
	class Mesh {

		constructor( geometry, material ) {

			this.geometry = geometry;
			this.material = material;
			this.layers = { mask: 1, test: () => true };

		}

	}
	class PerspectiveCamera {

		constructor() {

			this.position = { set() {} };
			this.layers = { mask: 1, test: () => true };

		}

		lookAt() {}

	}
	class BoxGeometry {}
	class Color {}

	const mrtNode = { outputNodes: { output: {}, velocity: {} } };
	const sourceScene = new Scene();
	sourceScene.userData.__tslp_mrtNode = mrtNode;
	const clonedRenderTarget = {
		width: 640,
		height: 480,
		depthTexture: { image: { width: 640, height: 480 } },
		disposed: false,
		setSize( width, height ) {

			this.width = width;
			this.height = height;

		},
		dispose() { this.disposed = true; },
	};
	const liveRenderTarget = {
		cloneCalls: 0,
		textures: [ { name: 'output' }, { name: 'velocity' } ],
		clone() {

			this.cloneCalls ++;
			return clonedRenderTarget;

		},
	};
	const emptyOutputShader = `
struct OutputType {
};
var<private> output : OutputType;
@fragment
fn main( @location( 0 ) uv : vec2<f32> ) -> OutputType {
	return output;
}
`;
	const colorShader = `
struct OutputStruct {
	@location( 0 ) color : vec4<f32>
};
var<private> output : OutputStruct;
@fragment
fn main( @location( 0 ) uv : vec2<f32> ) -> OutputStruct {
	output.color = vec4<f32>( uv, 0.0, 1.0 );
	return output;
}
`;
	const calls = [];
	const extractor = async ( renderer, scene, camera, opts = {} ) => {

		calls.push( opts );
		const isColor = opts && opts.noGlobalMRT === true;
		const artifact = {
			version: 3,
			cacheKey: isColor ? 'color-key' : 'mrt-key',
			materialUuid: 'mat-pass-mrt',
			materialShape: 'mesh-standard',
			vertexShader: 'vertex',
			fragmentShader: isColor ? colorShader : emptyOutputShader,
			bindings: [],
			uniformPlan: [],
			attributes: [],
			nodeAttributes: [],
		};
		if ( ! isColor ) {

			artifact.mrtOutputCount = 2;
			artifact.mrtOutputNames = [ 'output', 'velocity' ];

		}
		const artifacts = [ artifact ];
		artifacts.byMaterialUuid = new Map( [ [ 'mat-pass-mrt', artifact ] ] );
		artifacts.byMaterialVariants = new Map( [ [ 'mat-pass-mrt', [ artifact ] ] ] );
		return artifacts;

	};
	const posts = [];
	const oldWindow = globalThis.window;
	const oldFetch = globalThis.fetch;
	globalThis.window = globalThis;
	globalThis.fetch = async ( url, init ) => {

		posts.push( JSON.parse( init.body ) );
		return { ok: true, text: async () => 'ok' };

	};

	try {

		const three = { Material, Scene, Mesh, BoxGeometry, PerspectiveCamera, Color, REVISION: '184' };
		const renderer = {
			render() {},
			getMRT: () => mrtNode,
			getRenderTarget: () => liveRenderTarget,
		};
		installPrecompileMarker( three, {
			devEndpoint: 'http://example.test/capture',
			extractor,
			codegen: () => ( { unsupportedKinds: [] } ),
		} );
		setDevRenderer( renderer );

		const material = new Material();
		sourceScene.add( new Mesh( new BoxGeometry(), material ) );
		material.precompile( 'pass-mrt-material' );
		renderer.render( sourceScene, new PerspectiveCamera() );

		for ( let i = 0; i < 20 && ( globalThis.__tslpPrecompilePending | 0 ) > 0; i ++ ) {

			await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

		}

		assert.equal( calls.length, 2 );
		assert.equal( calls[ 0 ].mrtNode, mrtNode );
		assert.equal( calls[ 0 ].renderTargetOverride, clonedRenderTarget );
		assert.equal( calls[ 0 ].skipWarmupRender, true );
		assert.equal( calls[ 1 ].noGlobalMRT, true );
		assert.equal( calls[ 1 ].renderTargetOverride, undefined );
		assert.equal( liveRenderTarget.cloneCalls, 1 );
		assert.deepEqual( [ clonedRenderTarget.width, clonedRenderTarget.height ], [ 1, 1 ] );
		assert.deepEqual( clonedRenderTarget.depthTexture.image, { width: 1, height: 1 } );
		assert.equal( clonedRenderTarget.disposed, true );
		assert.equal( posts.length, 1 );
		assert.equal( posts[ 0 ].artifact.cacheKey, 'color-key' );
		assert.equal( Object.keys( posts[ 0 ].artifact.variants ).sort().join( ',' ), 'color-key,mrt-key' );

	} finally {

		resetMarkerForTests();
		if ( oldWindow === undefined ) delete globalThis.window;
		else globalThis.window = oldWindow;
		if ( oldFetch === undefined ) delete globalThis.fetch;
		else globalThis.fetch = oldFetch;
		delete globalThis.__tslpPrecompilePending;

	}

} );

test( 'precompile marker records the source material name', async () => {

	resetMarkerForTests();

	class Material {

		constructor() {

			this.uuid = 'named-material-uuid';
			this.name = 'mat_transmission_only_test';
			this.type = 'MeshPhysicalNodeMaterial';

		}

	}
	class Scene {

		constructor() {

			this.isScene = true;
			this.userData = {};
			this.children = [];

		}

		add( object ) {

			this.children.push( object );
			object.parent = this;

		}

	}
	class Mesh {

		constructor( geometry, material ) {

			this.geometry = geometry;
			this.material = material;
			this.layers = { mask: 1, test: () => true };

		}

	}
	class PerspectiveCamera {

		constructor() {

			this.position = { set() {} };
			this.layers = { mask: 1, test: () => true };

		}

		lookAt() {}

	}
	class BoxGeometry {}
	class Color {}

	const artifact = {
		version: 3,
		cacheKey: 'named-material-key',
		materialUuid: 'named-material-uuid',
		materialShape: 'mesh-physical',
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		bindings: [],
		uniformPlan: [],
		attributes: [],
		nodeAttributes: [],
	};
	const extractor = async () => {

		const artifacts = [ artifact ];
		artifacts.byMaterialUuid = new Map( [ [ 'named-material-uuid', artifact ] ] );
		artifacts.byMaterialVariants = new Map( [ [ 'named-material-uuid', [ artifact ] ] ] );
		return artifacts;

	};
	const posts = [];
	const oldWindow = globalThis.window;
	const oldFetch = globalThis.fetch;
	globalThis.window = globalThis;
	globalThis.fetch = async ( url, init ) => {

		posts.push( JSON.parse( init.body ) );
		return { ok: true, text: async () => 'ok' };

	};

	try {

		const three = { Material, Scene, Mesh, BoxGeometry, PerspectiveCamera, Color, REVISION: '184' };
		installPrecompileMarker( three, {
			devEndpoint: 'http://example.test/capture',
			extractor,
			codegen: () => ( { unsupportedKinds: [] } ),
		} );
		const renderer = { render() {} };
		setDevRenderer( renderer );

		const material = new Material();
		const sourceScene = new Scene();
		const sourceObject = new Mesh( new BoxGeometry(), material );
		sourceScene.add( sourceObject );
		material.precompile( 'named-material' );
		assert.equal( posts.length, 0, 'capture waits for the real render context' );
		renderer.render( sourceScene, new PerspectiveCamera() );

		for ( let i = 0; i < 20 && ( globalThis.__tslpPrecompilePending | 0 ) > 0; i ++ ) {

			await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

		}

		assert.equal( posts.length, 1 );
		assert.equal( posts[ 0 ].artifact.sourceMaterial.name, 'mat_transmission_only_test' );
		assert.equal( posts[ 0 ].artifact.sourceMaterial.type, 'MeshPhysicalNodeMaterial' );
		assert.equal( posts[ 0 ].artifact.sourceMaterial.object.type, 'Mesh' );

		material.precompile( 'named-material' );
		renderer.render( sourceScene, new PerspectiveCamera() );
		for ( let i = 0; i < 20 && ( globalThis.__tslpPrecompilePending | 0 ) > 0; i ++ ) {

			await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

		}
		assert.equal( posts.length, 2, 'a later HMR-style marker call may refresh the same capture' );

	} finally {

		resetMarkerForTests();
		if ( oldWindow === undefined ) delete globalThis.window;
		else globalThis.window = oldWindow;
		if ( oldFetch === undefined ) delete globalThis.fetch;
		else globalThis.fetch = oldFetch;
		delete globalThis.__tslpPrecompilePending;

	}

} );

test( 'setupPrecompile throws on missing renderer', () => {

	const { three } = freshHarness();
	assert.throws( () => setupPrecompile( { three } ), /opts\.renderer is required/ );

} );

test( 'setupPrecompile throws on missing three in non-slim mode', () => {

	resetMarkerForTests();
	const renderer = fakeRenderer();
	assert.throws( () => setupPrecompile( { renderer } ), /opts\.three is required/ );

} );

test( 'setupPrecompile throws when aux is requested without scene/camera', () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer();
	assert.throws(
		() => setupPrecompile( { three, renderer, aux: true } ),
		/aux capture needs/,
	);

} );

test( 'precompile light cloning strips helper children from synthetic lights', () => {

	class FakeObject3D {

		constructor() {

			this.children = [];
			this.parent = null;
			this.isObject3D = true;
			this.matrixWorld = null;

		}

		add( child ) {

			this.children.push( child );
			child.parent = this;

		}

		remove( child ) {

			this.children = this.children.filter( ( item ) => item !== child );
			child.parent = null;

		}

		traverse( visitor ) {

			visitor( this );
			for ( const child of this.children ) child.traverse ? child.traverse( visitor ) : visitor( child );

		}

		clone() {

			const cloned = new FakeObject3D();
			cloned.isLight = this.isLight;
			cloned.target = this.target;
			for ( const child of this.children ) cloned.add( child.clone ? child.clone() : { ...child } );
			return cloned;

		}

	}

	const scene = new FakeObject3D();
	scene.isScene = true;
	scene.updateMatrixWorld = () => {};
	const light = new FakeObject3D();
	light.isLight = true;
	const helper = new FakeObject3D();
	helper.isHelper = true;
	light.add( helper );
	scene.add( light );
	const dest = new FakeObject3D();

	__cloneLightsIntoForTests( scene, dest );

	assert.equal( dest.children.length, 1 );
	assert.equal( dest.children[ 0 ].isLight, true );
	assert.equal( dest.children[ 0 ].children.length, 0 );

} );

test( 'precompile light cloning preserves projector color node graphs', () => {

	class FakeObject3D {

		constructor() {

			this.children = [];
			this.parent = null;
			this.isObject3D = true;
			this.matrixWorld = null;

		}

		add( child ) {

			this.children.push( child );
			child.parent = this;

		}

		traverse( visitor ) {

			visitor( this );
			for ( const child of this.children ) child.traverse ? child.traverse( visitor ) : visitor( child );

		}

		clone() {

			const cloned = new FakeObject3D();
			cloned.isLight = this.isLight;
			return cloned;

		}

	}

	const scene = new FakeObject3D();
	scene.isScene = true;
	scene.updateMatrixWorld = () => {};
	const colorNode = { isNode: true, label: 'projector-caustic' };
	const light = new FakeObject3D();
	light.isLight = true;
	light.colorNode = colorNode;
	scene.add( light );
	const dest = new FakeObject3D();

	__cloneLightsIntoForTests( scene, dest );

	assert.equal( dest.children.length, 1 );
	assert.equal( dest.children[ 0 ].colorNode, colorNode );

} );
