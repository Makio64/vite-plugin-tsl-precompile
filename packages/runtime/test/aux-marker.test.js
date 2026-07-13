import test from 'node:test';
import assert from 'node:assert/strict';

import { precompileAuxiliary } from '../src/aux-marker.js';

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
	let compileCalls = 0;
	const compileTSL = async ( _renderer, captureScene ) => {

		compileCalls ++;
		const material = captureScene.children[ 0 ].material;
		const artifact = {
			materialUuid: material.uuid,
			uniformPlan: [],
			vertexShader: '',
			fragmentShader: '',
		};
		if ( compileCalls === 1 ) Object.defineProperty( artifact, '_liveUpdateBeforeNodes', { value: [ gtao, sss ] } );
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
			postProcessing: { outputNode },
			three: { NodeMaterial, Scene, QuadMesh, RenderTarget },
		} );
		assert.equal( compileCalls, 4, 'captures the output, hidden GTAO/SSS, and renderer-output materials' );
		assert.deepEqual( results.map( ( result ) => result.shape ), [ 'post-process', 'gtao', 'sss', 'render-output' ] );
		assert.deepEqual( payloads.map( ( payload ) => payload.materialShape ), [ 'post-process', 'gtao', 'sss' ] );
		assert.deepEqual( RenderTarget.options, [
			{ depthBuffer: false, count: 1, format: 1028, type: 1009 },
			{ depthBuffer: false, count: 1, format: 1028, type: 1009 },
		] );

	} finally {

		globalThis.fetch = originalFetch;

	}

} );
