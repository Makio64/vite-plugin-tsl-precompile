import test from 'node:test';
import assert from 'node:assert/strict';

import { precompileAuxiliary, precompileRendererOutput } from '../src/aux-marker.js';
import { hashPlainConfigSync } from '../src/graph-hash.js';
import { __resetAuxRegistryForTests, hasAux } from '../src/aux-loader.js';
import {
	__resetRenderObjectHarvestHandoffForTests,
	publishRenderObjectHarvest,
	takeRenderObjectHarvest,
} from '../src/auxiliary/render-object-harvest-handoff.js';
import { createCubeRenderTargetAuxConfig } from '@tsl-precompile/contract/cube-render-target';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';

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

function cubeSourceTexture( uuid, overrides = {} ) {

	return {
		isTexture: true,
		uuid,
		type: 1009,
		format: 1023,
		internalFormat: null,
		colorSpace: 'srgb-linear',
		mapping: 300,
		minFilter: 1006,
		magFilter: 1006,
		wrapS: 1001,
		wrapT: 1001,
		anisotropy: 1,
		compareFunction: null,
		generateMipmaps: false,
		disposeCalls: 0,
		dispose() { this.disposeCalls ++; },
		...overrides,
	};

}

function cubeCaptureFixture( { failTexture = null, bindingUuids = ( source ) => [ source.uuid ] } = {} ) {

	const state = {
		cubeCalls: [],
		geometries: [],
		materials: [],
		renderTargets: [],
		cubeCameras: [],
		tslTextureCalls: [],
		uvCalls: [],
	};
	class Scene {

		constructor() {

			this.children = [];
			this.userData = {};

		}
		add( object ) { this.children.push( object ); }
		remove( object ) { this.children = this.children.filter( ( child ) => child !== object ); }
		traverse( callback ) { this.children.forEach( callback ); }

	}
	class NodeMaterial {

		constructor() {

			this.uuid = `cube-material-${ state.materials.length + 1 }`;
			this.disposed = false;
			state.materials.push( this );

		}
		dispose() { this.disposed = true; }

	}
	class BoxGeometry {

		constructor( width, height, depth ) {

			this.dimensions = [ width, height, depth ];
			this.disposed = false;
			state.geometries.push( this );

		}
		dispose() { this.disposed = true; }

	}
	class Mesh {

		constructor( geometry, material ) {

			this.geometry = geometry;
			this.material = material;

		}

	}
	class CubeRenderTarget {

		constructor( size, options = {} ) {

			this.size = size;
			this.isCubeRenderTarget = true;
			this.texture = {
				format: options.format ?? 1023,
				internalFormat: options.internalFormat ?? null,
			};
			this.textures = [ this.texture ];
			this.samples = options.samples ?? 0;
			this.depthBuffer = options.depthBuffer ?? true;
			this.stencilBuffer = options.stencilBuffer ?? false;
			this.resolveDepthBuffer = options.resolveDepthBuffer ?? true;
			this.resolveStencilBuffer = options.resolveStencilBuffer ?? true;
			this.multiview = options.multiview ?? false;
			this.depthTexture = options.depthTexture ?? null;
			this.options = options;
			this.disposed = false;
			state.renderTargets.push( this );

		}
		dispose() { this.disposed = true; }

	}
	class CubeCamera {

		constructor( near, far, renderTarget ) {

			this.near = near;
			this.far = far;
			this.renderTarget = renderTarget;
			this.coordinateSystem = null;
			this.children = Array.from( { length: 6 }, ( _, face ) => ( {
				isPerspectiveCamera: true,
				fov: - 90,
				aspect: 1,
				near,
				far,
				face,
			} ) );
			this.updateCoordinateSystemCalls = 0;
			state.cubeCameras.push( this );

		}
		updateCoordinateSystem() { this.updateCoordinateSystemCalls ++; }

	}

	const positionWorldDirection = { isNode: true, name: 'positionWorldDirection' };
	const tsl = {
		positionWorldDirection,
		equirectUV( direction ) {

			const node = { isNode: true, kind: 'equirectUV', direction };
			state.uvCalls.push( { direction, node } );
			return node;

		},
		texture( source, uvNode, level ) {

			const node = { isNode: true, kind: 'texture', source, uvNode, level };
			state.tslTextureCalls.push( { source, uvNode, level, node } );
			return node;

		},
	};
	const three = {
		BackSide: 1,
		LinearFilter: 1006,
		LinearMipmapLinearFilter: 1008,
		NoBlending: 0,
		BoxGeometry,
		CubeCamera,
		CubeRenderTarget,
		Mesh,
		NodeMaterial,
		Scene,
	};
	const compileTSL = async ( _renderer, captureScene, camera, options = {} ) => {

		if ( options.renderTargetOverride ) {

			const mesh = captureScene.children[ 0 ];
			const source = mesh.material.colorNode.source;
			state.cubeCalls.push( {
				captureScene,
				camera,
				options,
				mesh,
				source,
				sourceState: { generateMipmaps: source.generateMipmaps, minFilter: source.minFilter },
			} );
			if ( source === failTexture ) throw new Error( `compile failed for ${ source.uuid }` );
			const textureUuids = bindingUuids( source );
			return [ {
				materialUuid: mesh.material.uuid,
				uniformPlan: textureUuids.length > 0 ? [ {
					textures: textureUuids.map( ( textureUuid ) => ( {
						source: { kind: 'artifact.texture', textureUuid },
					} ) ),
				} ] : [],
				vertexShader: `vertex:${ source.uuid }`,
				fragmentShader: `fragment:${ source.uuid }`,
			} ];

		}
		if ( options.captureRendererOutput ) throw new Error( 'no renderer output in cube fixture' );
		if ( captureScene.background ) {

			return [ {
				materialShape: 'background',
				uniformPlan: [],
				vertexShader: '',
				fragmentShader: 'background',
			} ];

		}
		return [];

	};

	return { state, three, tsl, compileTSL, Scene };

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

test( 'precompileRendererOutput captures exactly the active output transform without traversing auxiliary inputs', async () => {

	__resetAuxRegistryForTests();
	const originalFetch = globalThis.fetch;
	const posts = [];
	const replayConfig = {
		schema: 'renderer-output@1',
		toneMapping: 4,
		currentColorSpace: 'srgb',
		sampledTexture: '2d',
		multiview: false,
	};
	const artifact = {
		materialShape: 'output-transform',
		__hash: 'extractor-envelope-hash',
		__name: 'renderer-output',
		_liveArray: [ 1, 2, 3 ],
		vertexShader: 'output-vertex',
		fragmentShader: 'output-fragment',
		uniformPlan: [ { name: 'object', textures: [ {
			bindingKind: 'sampled-texture',
			textureType: '2d',
			source: {
				kind: 'artifact.texture',
				textureUuid: 'output-texture',
				mapping: 300,
				_liveAttribute: { array: [ 4, 5, 6 ] },
			},
		} ] } ],
	};
	const observedScene = {
		traverse() { throw new Error( 'narrow output capture must not traverse the scene' ); },
	};
	const observedCamera = { name: 'observed-camera' };
	let compileCalls = 0;
	const compileTSL = async ( renderer, scene, camera, options ) => {

		compileCalls ++;
		assert.equal( renderer.name, 'renderer' );
		assert.equal( scene, observedScene );
		assert.equal( camera, observedCamera );
		assert.deepEqual( options, { noGlobalMRT: true, captureRendererOutput: true } );
		const artifacts = [ artifact ];
		Object.defineProperty( artifacts, 'renderOutputCapture', {
			value: { artifact, replayConfig },
		} );
		return artifacts;

	};
	globalThis.fetch = async ( endpoint, request ) => {

		posts.push( { endpoint, payload: JSON.parse( request.body ) } );
		return { ok: true, text: async () => '' };

	};

	try {

		const results = await precompileRendererOutput( { name: 'renderer' }, observedScene, observedCamera, {
			devEndpoint: '/capture',
			threeVersion: '0.184.0',
			compileTSL,
		} );
		const configHash = hashPlainConfigSync( replayConfig, {
			shape: 'render-output',
			threeVersion: '0.184.0',
			pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
		} );

		assert.equal( compileCalls, 1 );
		assert.deepEqual( results, [ { shape: 'render-output', configHash, ok: true } ] );
		assert.equal( posts.length, 1 );
		assert.equal( posts[ 0 ].endpoint, '/capture' );
		assert.equal( posts[ 0 ].payload.materialShape, 'render-output' );
		assert.equal( posts[ 0 ].payload.configHash, configHash );
		assert.equal( posts[ 0 ].payload.artifact.fragmentShader, 'output-fragment' );
		assert.equal( posts[ 0 ].payload.artifact.__hash, 'extractor-envelope-hash' );
		assert.equal( posts[ 0 ].payload.artifact.__name, 'renderer-output' );
		assert.equal( posts[ 0 ].payload.artifact._liveArray, undefined );
		assert.equal( posts[ 0 ].payload.artifact.uniformPlan[ 0 ].textures[ 0 ].source._liveAttribute, undefined );
		assert.deepEqual( posts[ 0 ].payload.artifact.replayConfig, replayConfig );
		assert.deepEqual( artifact._liveArray, [ 1, 2, 3 ], 'aux serialization leaves the captured artifact untouched' );
		assert.deepEqual( artifact.uniformPlan[ 0 ].textures[ 0 ].source._liveAttribute, { array: [ 4, 5, 6 ] } );
		assert.equal( hasAux( 'render-output', configHash ), true );

	} finally {

		globalThis.fetch = originalFetch;
		__resetAuxRegistryForTests();

	}

} );

test( 'precompileAuxiliary captures a PassNode background against a disposable target clone', async () => {

	let targetClone = null;
	const liveTarget = {
		depth: 3,
		depthTexture: { image: { width: 640, height: 480 } },
		disposed: false,
		cloneCalls: 0,
		clone() {

			this.cloneCalls ++;
			targetClone = {
				depth: this.depth,
				depthTexture: { image: { ...this.depthTexture.image } },
				disposed: false,
				setSizeCalls: [],
				setSize( width, height, depth ) {

					this.setSizeCalls.push( [ width, height, depth ] );

				},
				dispose() { this.disposed = true; },
			};
			return targetClone;

		},
		dispose() { this.disposed = true; },
	};
	const background = { __tslpAuxConfigHash: 'background-pass-target' };
	const scene = {
		background,
		backgroundNode: null,
		userData: {},
		traverse() {},
	};
	const passNode = { isPassNode: true, scene, renderTarget: liveTarget };
	let backgroundCompile = null;
	const compileTSL = async ( _renderer, captureScene, _camera, options = {} ) => {

		if ( options.captureRendererOutput ) {

			const artifact = {
				materialShape: 'output-transform',
				uniformPlan: [ { textures: [ {
					bindingKind: 'sampled-texture',
					textureType: '2d',
					source: { kind: 'artifact.texture', mapping: 300 },
				} ] } ],
				vertexShader: '',
				fragmentShader: 'output',
			};
			const artifacts = [ artifact ];
			Object.defineProperty( artifacts, 'renderOutputCapture', { value: {
				artifact,
				replayConfig: {
					schema: 'renderer-output@1',
					toneMapping: 0,
					currentColorSpace: 'srgb',
					sampledTexture: '2d',
					multiview: false,
				},
			} } );
			return artifacts;

		}
		backgroundCompile = { captureScene, options, cloneDisposedDuringCompile: targetClone && targetClone.disposed };
		return [ {
			materialShape: 'background',
			uniformPlan: [],
			vertexShader: '',
			fragmentShader: 'background',
		} ];

	};
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => ( { ok: true } );
	__resetAuxRegistryForTests();
	try {

		const results = await precompileAuxiliary( {}, scene, {}, {
			devEndpoint: '/capture',
			threeVersion: '184',
			compileTSL,
			passNode,
		} );
		assert.equal( results.find( ( result ) => result.shape === 'background' ).ok, true );
		assert.equal( liveTarget.cloneCalls, 1 );
		assert.equal( backgroundCompile.options.noGlobalMRT, true );
		assert.equal( backgroundCompile.options.renderTargetOverride, targetClone );
		assert.equal( backgroundCompile.cloneDisposedDuringCompile, false );
		assert.deepEqual( targetClone.setSizeCalls, [ [ 1, 1, 3 ] ] );
		assert.deepEqual( targetClone.depthTexture.image, { width: 1, height: 1 } );
		assert.equal( targetClone.disposed, true, 'capture clone is released' );
		assert.equal( liveTarget.disposed, false, 'live pass target remains caller-owned' );

	} finally {

		__resetAuxRegistryForTests();
		globalThis.fetch = originalFetch;

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
	const targetClones = [];
	const renderPipelineTarget = {
		disposed: false,
		cloneCalls: 0,
		clone() {

			this.cloneCalls ++;
			const clone = {
				disposed: false,
				setSizeCalls: [],
				setSize( ...args ) { this.setSizeCalls.push( args ); },
				dispose() { this.disposed = true; },
			};
			targetClones.push( clone );
			return clone;

		},
	};
	let compileCalls = 0;
	const pipelineCompileTargets = [];
	const compileTSL = async ( _renderer, captureScene, _camera, options = {} ) => {

		compileCalls ++;
		if ( options.renderPipeline ) {

			assert.equal( options.noGlobalMRT, true );
			pipelineCompileTargets.push( options.renderTargetOverride || null );

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
			renderPipelineName: 'effects-pipeline-a',
			renderPipelineTarget,
			three: { NodeMaterial, Scene, QuadMesh, RenderTarget },
		} );
		assert.equal( compileCalls, 4, 'captures the output, hidden GTAO/SSS, and renderer-output materials' );
		assert.deepEqual( results.map( ( result ) => result.shape ), [ 'post-process', 'gtao', 'sss', 'render-output' ] );
		assert.deepEqual( payloads.map( ( payload ) => payload.materialShape ), [ 'post-process', 'gtao', 'sss', 'render-output' ] );
		assert.equal( payloads[ 0 ].name, 'effects-pipeline-a' );
		assert.equal( payloads[ 0 ].artifact.replayConfig.outputColorTransform, true );
		assert.equal( renderPipelineTarget.cloneCalls, 1 );
		assert.equal( pipelineCompileTargets[ 0 ], targetClones[ 0 ] );
		assert.deepEqual( targetClones[ 0 ].setSizeCalls, [ [ 1, 1 ] ] );
		assert.equal( targetClones[ 0 ].disposed, true, 'capture clone is released' );
		assert.equal( renderPipelineTarget.disposed, false, 'live pipeline target remains caller-owned' );
		assert.equal( payloads[ 3 ].artifact.fragmentShader, 'active-output' );
		assert.equal( payloads[ 3 ].artifact.replayConfig.currentColorSpace, 'srgb' );
		assert.deepEqual( RenderTarget.options, [
			{ depthBuffer: false, count: 1, format: 1028, type: 1009 },
			{ depthBuffer: false, count: 1, format: 1028, type: 1009 },
		] );

		await precompileAuxiliary( {}, { traverse: () => {} }, {}, {
			devEndpoint: '/capture',
			threeVersion: '184',
			compileTSL,
			renderPipeline,
			renderPipelineName: 'effects-pipeline-b',
			renderPipelineTarget,
			three: { NodeMaterial, Scene, QuadMesh, RenderTarget },
		} );
		assert.equal( payloads[ 4 ].name, 'effects-pipeline-b' );
		assert.equal( pipelineCompileTargets[ 1 ], targetClones[ 1 ] );
		assert.equal( targetClones[ 1 ].disposed, true );
		assert.notEqual(
			payloads[ 0 ].configHash,
			payloads[ 4 ].configHash,
			'semantically named pipelines remain distinct when their normalized graphs match',
		);

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

	let receivedHarvest = null;
	const compileTSL = async ( _renderer, _scene, _camera, options = {} ) => {

		if ( options.captureRendererOutput ) throw new Error( 'no renderer output in focused shadow fixture' );
		receivedHarvest = options.renderObjectHarvest;
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
	const renderer = {};
	const resolvedRenderObjectHarvest = { supported: true, familiesByMaterial: new Map() };
	const renderObjectHarvest = Promise.resolve( resolvedRenderObjectHarvest );
	globalThis.fetch = async ( _endpoint, request ) => {

		payloads.push( JSON.parse( request.body ) );
		return { ok: true };

	};
	__resetAuxRegistryForTests();
	__resetRenderObjectHarvestHandoffForTests();
	publishRenderObjectHarvest( renderer, scene, renderObjectHarvest );
	try {

		await precompileAuxiliary( renderer, scene, {}, {
			devEndpoint: '/capture',
			threeVersion: '184',
			compileTSL,
		} );
		assert.equal( receivedHarvest, resolvedRenderObjectHarvest, 'shadow capture consumes the resolved staged real-render harvest' );
		assert.equal( takeRenderObjectHarvest( renderer, scene ), null, 'the staged harvest is one-shot' );
		const payload = payloads.find( ( candidate ) => candidate.materialShape === 'shadow-depth' );
		assert.ok( payload, 'expected one aggregate shadow-depth POST' );
		assert.deepEqual( Object.keys( payload.artifact.variants ).sort(), [ 'directional-key', 'point-key', 'shared-key' ] );
		assert.deepEqual( payload.artifact.variants[ 'shared-key' ].renderContextSelectors, [ directionalSelector, pointSelector ].sort() );
		assert.equal( payload.artifact.variants[ 'directional-key' ].fragmentShader, 'directional-shadow' );
		assert.equal( payload.artifact.variants[ 'point-key' ].fragmentShader, 'point-shadow' );

	} finally {

		__resetAuxRegistryForTests();
		__resetRenderObjectHarvestHandoffForTests();
		globalThis.fetch = originalFetch;

	}

} );

test( 'precompileAuxiliary discovers, deduplicates, captures, registers, and POSTs cube render target sources with an exact face camera', async () => {

	const background = cubeSourceTexture( 'cube-background', { type: 1009, minFilter: 1008 } );
	const environment = cubeSourceTexture( 'cube-environment', { type: 1010 } );
	const singular = cubeSourceTexture( 'cube-singular', { type: 1011 } );
	const plural = cubeSourceTexture( 'cube-plural', { type: 1012 } );
	const { state, three, tsl, compileTSL } = cubeCaptureFixture();
	const scene = {
		background,
		backgroundNode: null,
		environment,
		userData: {},
		traverse() {},
	};
	const camera = { uuid: 'caller-camera', isOrthographicCamera: true };
	const renderer = { coordinateSystem: 'webgpu' };
	const originalFetch = globalThis.fetch;
	const payloads = [];
	globalThis.fetch = async ( _endpoint, request ) => {

		payloads.push( JSON.parse( request.body ) );
		return { ok: true };

	};
	__resetAuxRegistryForTests();
	try {

		const results = await precompileAuxiliary( renderer, scene, camera, {
			devEndpoint: '/capture',
			threeVersion: '184',
			compileTSL,
			three,
			tsl,
			cubeRenderTargetTexture: singular,
			cubeRenderTargetTextures: [ background, environment, singular, plural, plural ],
		} );
		const cubeResults = results.filter( ( result ) => result.shape === 'cube-render-target' );
		const cubePayloads = payloads.filter( ( payload ) => payload.materialShape === 'cube-render-target' );
		assert.equal( cubeResults.length, 4, 'each unique Texture identity produces one visible result' );
		assert.equal( cubeResults.every( ( result ) => result.ok ), true );
		assert.equal( cubePayloads.length, 4, 'each unique Texture identity is POSTed separately' );
		assert.deepEqual(
			state.cubeCalls.map( ( call ) => call.source ),
			[ singular, background, environment, plural ],
			'explicit inputs keep order and scene discovery appends unseen identities',
		);

		for ( let index = 0; index < state.cubeCalls.length; index ++ ) {

			const call = state.cubeCalls[ index ];
			const source = call.source;
			const payload = cubePayloads.find( ( candidate ) => candidate.artifact.fragmentShader === `fragment:${ source.uuid }` );
			const replayConfig = createCubeRenderTargetAuxConfig( source );
			const expectedHash = hashPlainConfigSync( replayConfig, {
				shape: 'cube-render-target',
				threeVersion: '184',
				pluginVersion: '0.1.0',
			} );
			assert.ok( payload, `POST payload exists for ${ source.uuid }` );
			assert.equal( payload.configHash, expectedHash );
			assert.deepEqual( payload.artifact.replayConfig, replayConfig );
			assert.equal( payload.artifact.materialShape, 'cube-render-target' );
			assert.equal( hasAux( 'cube-render-target', expectedHash ), true, 'capture is registered locally' );
			const cubeCamera = state.cubeCameras[ index ];
			assert.notEqual( call.camera, camera, 'caller camera topology is not inherited' );
			assert.equal( call.camera, cubeCamera.children[ 0 ], 'capture uses CubeCamera positive-X face camera' );
			assert.equal( call.camera.isPerspectiveCamera, true );
			assert.equal( call.camera.fov, - 90 );
			assert.equal( call.camera.aspect, 1 );
			assert.equal( call.camera.near, 1 );
			assert.equal( call.camera.far, 10 );
			assert.equal( cubeCamera.renderTarget, call.options.renderTargetOverride );
			assert.equal( cubeCamera.coordinateSystem, renderer.coordinateSystem );
			assert.equal( cubeCamera.updateCoordinateSystemCalls, 1 );
			assert.equal( call.options.noGlobalMRT, true );
			assert.equal( call.options.renderTargetOverride.isCubeRenderTarget, true );
			assert.equal( call.options.renderTargetOverride.size, 1 );
			assert.equal( call.options.renderTargetOverride.texture.type, source.type );
			assert.equal( call.options.renderTargetOverride.texture.colorSpace, source.colorSpace );
			assert.equal( call.options.renderTargetOverride.texture.generateMipmaps, true );
			assert.equal( call.options.renderTargetOverride.texture.minFilter, source.minFilter );
			assert.equal( call.options.renderTargetOverride.texture.magFilter, source.magFilter );
			assert.equal( call.sourceState.generateMipmaps, true, 'compile observes r184 temporary mip generation' );
			assert.equal(
				call.sourceState.minFilter,
				source === background ? three.LinearFilter : source.minFilter,
				'compile observes r184 pole-safe minification filter',
			);
			assert.deepEqual( call.mesh.geometry.dimensions, [ 5, 5, 5 ] );
			assert.equal( call.mesh.material.__tslpAuxShape, 'cube-render-target' );
			assert.equal( call.mesh.material.side, three.BackSide );
			assert.equal( call.mesh.material.blending, three.NoBlending );
			assert.equal( call.mesh.material.colorNode.source, source );
			assert.equal( call.mesh.material.colorNode.uvNode.direction, tsl.positionWorldDirection );
			assert.equal( call.mesh.material.colorNode.level, 0 );

		}
		assert.equal( state.uvCalls.length, 4 );
		assert.equal( state.tslTextureCalls.length, 4 );
		assert.equal( state.cubeCameras.length, 4 );
		assert.equal( state.geometries.every( ( geometry ) => geometry.disposed ), true );
		assert.equal( state.materials.every( ( material ) => material.disposed ), true );
		assert.equal( state.renderTargets.every( ( target ) => target.disposed ), true );
		assert.equal( [ background, environment, singular, plural ].every( ( texture ) => texture.disposeCalls === 0 ), true, 'live source textures remain caller-owned' );
		assert.equal( background.minFilter, 1008, 'source minFilter is restored after capture' );
		assert.equal( background.generateMipmaps, false, 'source generateMipmaps is restored after capture' );

	} finally {

		__resetAuxRegistryForTests();
		globalThis.fetch = originalFetch;

	}

} );

test( 'precompileAuxiliary leaves a cube source untouched while waiting for the renderer compile lock', async () => {

	const source = cubeSourceTexture( 'cube-queued', { minFilter: 1008 } );
	const { state, three, tsl, compileTSL } = cubeCaptureFixture();
	let releaseLock;
	let releaseQueuedLock;
	const firstLock = new Promise( ( resolve ) => { releaseLock = resolve; } );
	const queuedLockGate = new Promise( ( resolve ) => { releaseQueuedLock = resolve; } );
	const renderer = {
		coordinateSystem: 'webgpu',
		__tslpCompileLock: firstLock,
	};
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => ( { ok: true } );
	__resetAuxRegistryForTests();
	try {

		const pendingCapture = precompileAuxiliary( renderer, { background: null, environment: null, traverse() {} }, {}, {
			devEndpoint: '/capture',
			threeVersion: '184',
			compileTSL,
			three,
			tsl,
			cubeRenderTargetTexture: source,
		} );
		for ( let turn = 0; turn < 20 && state.cubeCameras.length === 0; turn ++ ) await Promise.resolve();
		assert.equal( state.cubeCameras.length, 1, 'capture reaches the renderer-lock boundary' );
		assert.equal( state.cubeCalls.length, 0, 'compile has not started while the lock is held' );
		assert.equal( source.generateMipmaps, false, 'temporary mip generation is not visible while queued' );
		assert.equal( source.minFilter, 1008, 'temporary pole filter is not visible while queued' );

		// Model another compile that joined the renderer queue after this
		// capture started waiting. The marker must observe the changed tail and
		// wait again rather than mutating as soon as its original lock resolves.
		renderer.__tslpCompileLock = firstLock.then( () => queuedLockGate );
		releaseLock();
		for ( let turn = 0; turn < 5; turn ++ ) await Promise.resolve();
		assert.equal( state.cubeCalls.length, 0, 'a newly queued compile remains ahead of cube capture' );
		assert.equal( source.generateMipmaps, false, 'mip state remains untouched across a moving lock tail' );
		assert.equal( source.minFilter, 1008, 'filter remains untouched across a moving lock tail' );
		releaseQueuedLock();
		const results = await pendingCapture;
		const cubeResult = results.find( ( result ) => result.shape === 'cube-render-target' );
		assert.equal( cubeResult.ok, true );
		assert.equal( state.cubeCalls.length, 1 );
		assert.equal( source.generateMipmaps, false, 'mip generation is restored after capture' );
		assert.equal( source.minFilter, 1008, 'minification filter is restored after capture' );

	} finally {

		__resetAuxRegistryForTests();
		globalThis.fetch = originalFetch;

	}

} );

test( 'precompileAuxiliary keys cube capture by custom destination topology', async () => {

	const source = cubeSourceTexture( 'cube-custom-target' );
	const { state, three, tsl, compileTSL } = cubeCaptureFixture();
	const targetOptions = {
		format: 1022,
		internalFormat: 'rgba16float',
		samples: 4,
		depthBuffer: false,
		stencilBuffer: true,
	};
	const originalFetch = globalThis.fetch;
	let payload = null;
	globalThis.fetch = async ( _endpoint, request ) => {

		const candidate = JSON.parse( request.body );
		if ( candidate.materialShape === 'cube-render-target' ) payload = candidate;
		return { ok: true };

	};
	__resetAuxRegistryForTests();
	try {

		const results = await precompileAuxiliary( {}, { background: null, environment: null, traverse() {} }, {}, {
			devEndpoint: '/capture',
			threeVersion: '184',
			compileTSL,
			three,
			tsl,
			cubeRenderTargetTexture: source,
			cubeRenderTargetOptions: targetOptions,
		} );
		const target = state.renderTargets[ 0 ];
		const config = createCubeRenderTargetAuxConfig( source, target );
		const expectedHash = hashPlainConfigSync( config, {
			shape: 'cube-render-target',
			threeVersion: '184',
			pluginVersion: '0.1.0',
		} );
		assert.equal( results.find( ( result ) => result.shape === 'cube-render-target' ).ok, true );
		assert.deepEqual( target.options, targetOptions );
		assert.deepEqual( payload.artifact.replayConfig, config );
		assert.equal( payload.configHash, expectedHash );
		assert.equal( config.target.format, 1022 );
		assert.equal( config.target.sampleCount, 4 );
		assert.equal( config.target.depth, false );
		assert.equal( config.target.stencil, true );

	} finally {

		__resetAuxRegistryForTests();
		globalThis.fetch = originalFetch;

	}

} );

test( 'precompileAuxiliary rejects missing and unrelated cube source binding evidence', async () => {

	const missing = cubeSourceTexture( 'cube-binding-missing', { minFilter: 1008 } );
	const unrelated = cubeSourceTexture( 'cube-binding-unrelated' );
	const valid = cubeSourceTexture( 'cube-binding-valid' );
	const { state, three, tsl, compileTSL } = cubeCaptureFixture( {
		bindingUuids: ( source ) => {

			if ( source === missing ) return [];
			if ( source === unrelated ) return [ 'different-texture-uuid' ];
			return [ source.uuid ];

		},
	} );
	const originalFetch = globalThis.fetch;
	const payloads = [];
	globalThis.fetch = async ( _endpoint, request ) => {

		payloads.push( JSON.parse( request.body ) );
		return { ok: true };

	};
	__resetAuxRegistryForTests();
	try {

		const results = await precompileAuxiliary( {}, { background: null, environment: null, traverse() {} }, {}, {
			devEndpoint: '/capture',
			threeVersion: '184',
			compileTSL,
			three,
			tsl,
			cubeRenderTargetTextures: [ missing, unrelated, valid ],
		} );
		const cubeResults = results.filter( ( result ) => result.shape === 'cube-render-target' );
		assert.deepEqual( cubeResults.map( ( result ) => result.ok ), [ false, false, true ] );
		assert.match( cubeResults[ 0 ].error, /artifact\.texture UUID domain \[\] does not exactly match source "cube-binding-missing"/ );
		assert.match( cubeResults[ 1 ].error, /artifact\.texture UUID domain \["different-texture-uuid"\] does not exactly match source "cube-binding-unrelated"/ );
		assert.equal( payloads.filter( ( payload ) => payload.materialShape === 'cube-render-target' ).length, 1 );
		assert.deepEqual( state.cubeCalls.map( ( call ) => call.source ), [ missing, unrelated, valid ] );
		assert.equal( state.geometries.every( ( geometry ) => geometry.disposed ), true );
		assert.equal( state.materials.every( ( material ) => material.disposed ), true );
		assert.equal( state.renderTargets.every( ( target ) => target.disposed ), true );
		assert.equal( missing.generateMipmaps, false, 'validation failure restores mip generation' );
		assert.equal( missing.minFilter, 1008, 'validation failure restores the minification filter' );

	} finally {

		__resetAuxRegistryForTests();
		globalThis.fetch = originalFetch;

	}

} );

test( 'precompileAuxiliary isolates cube capture failures and disposes each owned capture graph', async () => {

	const failed = cubeSourceTexture( 'cube-failed', { type: 1013, minFilter: 1008 } );
	const captured = cubeSourceTexture( 'cube-captured', { type: 1014 } );
	const { state, three, tsl, compileTSL } = cubeCaptureFixture( { failTexture: failed } );
	const originalFetch = globalThis.fetch;
	const payloads = [];
	globalThis.fetch = async ( _endpoint, request ) => {

		payloads.push( JSON.parse( request.body ) );
		return { ok: true };

	};
	__resetAuxRegistryForTests();
	try {

		const results = await precompileAuxiliary( {}, { background: null, environment: null, traverse() {} }, {}, {
			devEndpoint: '/capture',
			threeVersion: '184',
			compileTSL,
			three,
			tsl,
			cubeRenderTargetTextures: [ failed, captured ],
		} );
		const cubeResults = results.filter( ( result ) => result.shape === 'cube-render-target' );
		assert.equal( cubeResults.length, 2 );
		assert.equal( cubeResults[ 0 ].ok, false );
		assert.match( cubeResults[ 0 ].error, /compile failed for cube-failed/ );
		assert.equal( typeof cubeResults[ 0 ].configHash, 'string', 'known failed config keeps its hash for diagnosis' );
		assert.equal( cubeResults[ 1 ].ok, true, 'a failed sibling does not block the next capture' );
		assert.deepEqual( state.cubeCalls.map( ( call ) => call.source ), [ failed, captured ] );
		assert.equal( payloads.filter( ( payload ) => payload.materialShape === 'cube-render-target' ).length, 1 );
		assert.equal( state.geometries.length, 2 );
		assert.equal( state.geometries.every( ( geometry ) => geometry.disposed ), true );
		assert.equal( state.materials.every( ( material ) => material.disposed ), true );
		assert.equal( state.renderTargets.every( ( target ) => target.disposed ), true );
		assert.equal( failed.disposeCalls, 0 );
		assert.equal( captured.disposeCalls, 0 );
		assert.equal( failed.minFilter, 1008, 'throwing compile restores the temporary pole-safe filter' );
		assert.equal( failed.generateMipmaps, false, 'throwing compile restores mip generation' );

	} finally {

		__resetAuxRegistryForTests();
		globalThis.fetch = originalFetch;

	}

} );

test( 'precompileAuxiliary reports every unsupported explicit cube source without hiding valid siblings', async () => {

	const cube = cubeSourceTexture( 'already-cube', { isCubeTexture: true } );
	const video = cubeSourceTexture( 'external-video', { isVideoTexture: true } );
	const valid = cubeSourceTexture( 'valid-2d', { type: 1015 } );
	const { state, three, tsl, compileTSL } = cubeCaptureFixture();
	const originalFetch = globalThis.fetch;
	const payloads = [];
	globalThis.fetch = async ( _endpoint, request ) => {

		payloads.push( JSON.parse( request.body ) );
		return { ok: true };

	};
	__resetAuxRegistryForTests();
	try {

		const results = await precompileAuxiliary( {}, { background: null, environment: null, traverse() {} }, {}, {
			devEndpoint: '/capture',
			threeVersion: '184',
			compileTSL,
			three,
			tsl,
			cubeRenderTargetTextures: [ cube, video, valid ],
		} );
		const cubeResults = results.filter( ( result ) => result.shape === 'cube-render-target' );
		assert.equal( cubeResults.length, 3, 'no explicit candidate silently disappears' );
		assert.deepEqual( cubeResults.map( ( result ) => result.ok ), [ false, false, true ] );
		assert.match( cubeResults[ 0 ].error, /cube textures are not supported/ );
		assert.match( cubeResults[ 1 ].error, /isVideoTexture sources are not supported/ );
		assert.deepEqual( state.cubeCalls.map( ( call ) => call.source ), [ valid ], 'unsupported candidates fail before allocating a capture graph' );
		assert.equal( payloads.filter( ( payload ) => payload.materialShape === 'cube-render-target' ).length, 1 );

	} finally {

		__resetAuxRegistryForTests();
		globalThis.fetch = originalFetch;

	}

} );
