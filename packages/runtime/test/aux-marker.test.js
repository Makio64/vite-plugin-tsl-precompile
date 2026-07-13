import test from 'node:test';
import assert from 'node:assert/strict';

import { precompileAuxiliary } from '../src/aux-marker.js';
import { __resetAuxRegistryForTests } from '../src/aux-loader.js';

function silentInfo() {

	const original = console.info;
	console.info = () => {};
	return () => { console.info = original; };

}

function silentWarn() {

	const original = console.warn;
	console.warn = () => {};
	return () => { console.warn = original; };

}

test( 'precompileAuxiliary returns [] without endpoint instead of throwing', async () => {

	const restore = silentWarn();
	try {

		const result = await precompileAuxiliary( {}, { traverse: () => {} }, {}, {} );
		assert.deepEqual( result, [] );

	} finally { restore(); }

} );

test( 'precompileAuxiliary no-ops cleanly in production-like envs (compileTSL unresolvable)', async () => {

	// In the runtime test env, `vite-plugin-tsl-precompile` is not a peer dep,
	// so `lazyLoadCompileTSL`'s dynamic import fails — the same shape as a
	// production bundle that has stripped compileTSL. Adopters call
	// `precompileAuxiliary` unconditionally; the runtime must silently no-op
	// instead of bubbling the resolution failure into user code.
	const restore = silentInfo();
	try {

		const result = await precompileAuxiliary( {}, { traverse: () => {} }, {}, {
			devEndpoint: '/__tsl-precompile/capture',
			threeVersion: '184',
		} );
		assert.deepEqual( result, [], 'returns empty result list (no captures)' );

	} finally { restore(); }

} );

test( 'precompileAuxiliary prod no-op fires before fetch is attempted', async () => {

	// Locks the contract that the production short-circuit runs *before* any
	// network call. If a future refactor re-orders the checks, a missing dev
	// server would throw `JSON.parse('<')` from an HTML 404 page (P1.8 gap 1).
	const originalFetch = globalThis.fetch;
	let fetchCalled = false;
	globalThis.fetch = async () => { fetchCalled = true; return { ok: false, status: 404, text: async () => '' }; };
	const restore = silentInfo();
	try {

		await precompileAuxiliary(
			{ toneMapping: 0, toneMappingExposure: 1, outputColorSpace: 'srgb' },
			{ traverse: () => {}, backgroundNode: null, background: null },
			{},
			{ devEndpoint: '/__tsl-precompile/capture', threeVersion: '184' },
		);
		assert.equal( fetchCalled, false, 'no fetch attempted in prod-like env' );

	} finally {

		globalThis.fetch = originalFetch;
		restore();

	}

} );

test( 'precompileAuxiliary captures effects observed only through live update nodes', async () => {

	class NodeMaterial {

		constructor() {

			this.uuid = `material-${ NodeMaterial.nextId ++ }`;

		}

	}
	NodeMaterial.nextId = 1;
	class Scene {

		constructor() {

			this.children = [];
			this.userData = {};

		}
		add( object ) { this.children.push( object ); }
		traverse( callback ) { this.children.forEach( callback ); }

	}
	class QuadMesh {

		constructor( material ) { this.material = material; }

	}
	class RenderTarget {

		constructor( _width, _height, options ) { RenderTarget.options.push( options ); }
		dispose() {}

	}
	RenderTarget.options = [];

	const gtao = {
		updateBefore: () => {},
		_aoRenderTarget: { texture: { name: 'GTAONode.AO', format: 1028, type: 1009 } },
		_material: new NodeMaterial(),
		_textureNode: { isPassTextureNode: true },
		radius: { isUniformNode: true, value: 0.25 },
		resolution: { isUniformNode: true, value: { isVector2: true } },
	};
	const sss = {
		type: 'SSSNode',
		updateBefore: () => {},
		_sssRenderTarget: { texture: { name: 'SSS', format: 1028, type: 1009 } },
		_material: new NodeMaterial(),
		_textureNode: { isPassTextureNode: true },
		depthNode: { isTextureNode: true },
	};
	const outputNode = { isNode: true };
	const renderPipeline = {
		outputNode,
		outputColorTransform: true,
		renderer: { toneMapping: 4, outputColorSpace: 'srgb' },
		_quadMesh: { material: { uuid: 'render-pipeline-material' } },
	};
	let compileCalls = 0;
	const compileTSL = async ( _renderer, captureScene, _camera, options = {} ) => {

		compileCalls ++;
		if ( options.renderPipeline ) {

			const artifact = {
				materialUuid: options.renderPipeline._quadMesh.material.uuid,
				materialShape: 'render-pipeline',
				uniformPlan: [],
				vertexShader: '',
				fragmentShader: '',
			};
			Object.defineProperty( artifact, '_liveUpdateBeforeNodes', { value: [ gtao, sss ] } );
			return [ artifact ];

		}
		const material = captureScene.children && captureScene.children[ 0 ] && captureScene.children[ 0 ].material;
		if ( ! material ) {

			assert.equal( options.captureRendererOutput, true );
			const stale = {
				materialShape: 'output-transform',
				uniformPlan: [],
				vertexShader: '',
				fragmentShader: 'stale-output',
			};
			const active = {
				materialUuid: 'active-output-material',
				materialShape: 'output-transform',
				uniformPlan: [ { name: 'object', textures: [ {
					bindingKind: 'sampled-texture',
					textureType: '2d',
					source: { kind: 'artifact.texture', textureUuid: 'output', mapping: 300 },
				} ] } ],
				vertexShader: '',
				fragmentShader: 'active-output',
			};
			const artifacts = [ stale, active ];
			Object.defineProperty( artifacts, 'renderOutputCapture', { value: {
				artifact: active,
				replayConfig: {
					schema: 'renderer-output@1',
					toneMapping: 4,
					currentColorSpace: 'srgb',
					sampledTexture: '2d',
					multiview: false,
				},
			} } );
			return artifacts;

		}
		const artifact = {
			materialUuid: material.uuid,
			uniformPlan: [],
			vertexShader: '',
			fragmentShader: '',
		};
		return [ artifact ];

	};

	const originalFetch = globalThis.fetch;
	const payloads = [];
	globalThis.fetch = async ( _endpoint, request ) => {

		payloads.push( JSON.parse( request.body ) );
		return { ok: true };

	};
	try {

		const results = await precompileAuxiliary( {}, { traverse: () => {} }, {}, {
			devEndpoint: '/capture',
			threeVersion: '184',
			compileTSL,
			renderPipeline,
			three: { NodeMaterial, Scene, QuadMesh, RenderTarget },
		} );
		assert.equal( compileCalls, 4, 'captures the output, hidden GTAO/SSS, and renderer-output materials' );
		assert.deepEqual( results.map( ( result ) => result.shape ), [ 'post-process', 'gtao', 'sss', 'render-output' ] );
		assert.deepEqual( payloads.map( ( payload ) => payload.materialShape ), [ 'post-process', 'gtao', 'sss', 'render-output' ] );
		assert.equal( payloads[ 0 ].artifact.replayConfig.outputColorTransform, true );
		assert.equal( payloads[ 3 ].artifact.fragmentShader, 'active-output' );
		assert.equal( payloads[ 3 ].artifact.replayConfig.currentColorSpace, 'srgb' );
		assert.deepEqual( RenderTarget.options, [
			{ depthBuffer: false, count: 1, format: 1028, type: 1009 },
			{ depthBuffer: false, count: 1, format: 1028, type: 1009 },
		] );

	} finally {

		globalThis.fetch = originalFetch;

	}

} );

test( 'precompileAuxiliary preserves every shadow material family and unions equivalent cache-key selectors', async () => {

	const shadowArtifact = ( cacheKey, selector, fragmentShader ) => ( {
		materialShape: 'shadow-depth',
		bindingOwner: 'shadow-caster',
		cacheKey,
		renderContextSelectors: [ selector ],
		vertexShader: `vertex:${ fragmentShader }`,
		fragmentShader,
		bindings: [],
		uniformPlan: [],
	} );
	const directionalSelector = '{"target":{"surface":"offscreen-2d"}}';
	const pointSelector = '{"target":{"surface":"offscreen-cube"}}';
	const directionalOnly = '{"shadowCaster":{"customDepth":true}}';
	const pointOnly = '{"shadowCaster":{"map":true},"target":{"surface":"offscreen-cube"}}';
	const sharedDirectional = shadowArtifact( 'shared-key', directionalSelector, 'shared-shadow' );
	const sharedPoint = shadowArtifact( 'shared-key', pointSelector, 'shared-shadow' );
	const directional = shadowArtifact( 'directional-key', directionalOnly, 'directional-shadow' );
	const point = shadowArtifact( 'point-key', pointOnly, 'point-shadow' );
	sharedDirectional.variants = {
		'shared-key': { ...sharedDirectional },
		'directional-key': { ...directional },
	};
	sharedPoint.variants = {
		'shared-key': { ...sharedPoint },
		'point-key': { ...point },
	};

	const compileTSL = async ( _renderer, _scene, _camera, options = {} ) => {

		if ( options.captureRendererOutput ) throw new Error( 'no renderer output in focused shadow fixture' );
		return [ sharedDirectional, directional, sharedPoint, point ];

	};
	const lights = [
		{ isLight: true, type: 'DirectionalLight', castShadow: true, shadow: { mapSize: { width: 512, height: 512 } } },
		{ isLight: true, type: 'PointLight', castShadow: true, shadow: { mapSize: { width: 256, height: 256 } } },
	];
	const scene = {
		background: null,
		backgroundNode: null,
		userData: {},
		traverse( callback ) { lights.forEach( callback ); },
	};
	const originalFetch = globalThis.fetch;
	const payloads = [];
	globalThis.fetch = async ( _endpoint, request ) => {

		payloads.push( JSON.parse( request.body ) );
		return { ok: true };

	};
	__resetAuxRegistryForTests();
	try {

		await precompileAuxiliary( {}, scene, {}, {
			devEndpoint: '/capture',
			threeVersion: '184',
			compileTSL,
		} );
		const payload = payloads.find( ( candidate ) => candidate.materialShape === 'shadow-depth' );
		assert.ok( payload, 'expected one aggregate shadow-depth POST' );
		assert.deepEqual( Object.keys( payload.artifact.variants ).sort(), [ 'directional-key', 'point-key', 'shared-key' ] );
		assert.deepEqual( payload.artifact.variants[ 'shared-key' ].renderContextSelectors, [ directionalSelector, pointSelector ].sort() );
		assert.equal( payload.artifact.variants[ 'directional-key' ].fragmentShader, 'directional-shadow' );
		assert.equal( payload.artifact.variants[ 'point-key' ].fragmentShader, 'point-shadow' );

	} finally {

		__resetAuxRegistryForTests();
		globalThis.fetch = originalFetch;

	}

} );
