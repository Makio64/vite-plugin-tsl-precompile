import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { precompileAuxiliary, precompileRendererOutput } from '../src/aux-marker.js';
import { hashArtifactContentSync, hashPlainConfigSync } from '../src/graph-hash.js';
import { __resetAuxRegistryForTests, hasAux } from '../src/aux-loader.js';
import {
	__resetRenderObjectHarvestHandoffForTests,
	publishRenderObjectHarvest,
	takeRenderObjectHarvest,
} from '../src/auxiliary/render-object-harvest-handoff.js';
import { rememberBackgroundCaptureRenderTarget } from '../src/capture-render-target.js';
import { getDevCaptureStatus } from '../src/dev-capture-outcome.js';
import { collectArtifactVariantCandidates } from '@tsl-precompile/contract/artifact-variants';
import { createCubeRenderTargetAuxConfig } from '@tsl-precompile/contract/cube-render-target';
import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { assertInternalPassArtifact } from '@tsl-precompile/contract/internal-pass';
import {
	createVSMSupportConfig,
	vsmMomentsTopology,
	vsmSourceInputTopology,
} from '@tsl-precompile/contract/vsm-config';
import { createMockGPUCanvasContext, installMockWebGPU } from '../../plugin/src/mock-webgpu.js';
import { compileTSL as compileRealTSL } from '../../plugin/src/vendor/compileTSL.js';
import { beginRenderObjectHarvest } from '../../plugin/src/vendor/render-object-observer.js';

const auxMarkerSource = readFileSync( new URL( '../src/aux-marker.js', import.meta.url ), 'utf8' );

test( 'postprocess capture prepares effect resources before isolated pipeline update', () => {

	const captureStart = auxMarkerSource.indexOf( 'async function capturePostProcessingLive(' );
	const captureEnd = auxMarkerSource.indexOf( 'function snapshotEffectSetupState(', captureStart );
	assert.ok( captureStart >= 0 && captureEnd > captureStart, 'expected postprocess capture implementation' );
	const capture = auxMarkerSource.slice( captureStart, captureEnd );
	const prepareIndex = capture.indexOf( 'handler.prepareCapture( node, { renderer } )' );
	const updateIndex = capture.indexOf( 'isolatedPipeline._update();' );

	assert.ok( prepareIndex >= 0, 'expected registered effect capture preparation' );
	assert.ok( updateIndex > prepareIndex, 'effect resources must be prepared before isolated pipeline update' );

} );

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

test( 'precompileAuxiliary no-ops cleanly when the production compiler is unavailable', async () => {

	// The workspace intentionally links the plugin as a build dependency, so
	// model the production bundle's stripped compiler explicitly. Adopters call
	// `precompileAuxiliary` unconditionally; the runtime must silently no-op.
	const restore = silentInfo();
	try {

		const baseline = getDevCaptureStatus();
		const result = await precompileAuxiliary( {}, { traverse: () => {} }, {}, {
			devEndpoint: '/__tsl-precompile/capture',
			threeVersion: '184',
			compileTSL: null,
		} );
		assert.deepEqual( result, [], 'returns empty result list (no captures)' );
		assert.equal(
			getDevCaptureStatus().failedCaptures,
			baseline.failedCaptures + 1,
			'the settlement signal records that the requested dev capture could not load its compiler',
		);

	} finally { restore(); }

} );

test( 'precompileRendererOutput records an unavailable dev compiler for settlement', async () => {

	const baseline = getDevCaptureStatus();
	const result = await precompileRendererOutput( {}, {}, {}, {
		devEndpoint: '/__tsl-precompile/capture',
		threeVersion: '184',
		compileTSL: null,
	} );
	assert.deepEqual( result, [] );
	assert.equal( getDevCaptureStatus().failedCaptures, baseline.failedCaptures + 1 );

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
			{ devEndpoint: '/__tsl-precompile/capture', threeVersion: '184', compileTSL: null },
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
		assert.equal( posts[ 0 ].payload.threeVersion, '0.184.0' );
		assert.equal( posts[ 0 ].payload.pluginVersion, ARTIFACT_TOOLCHAIN_VERSION );
		assert.equal( posts[ 0 ].payload.artifact.artifactContentHashVersion, ARTIFACT_CONTENT_HASH_VERSION );
		assert.equal( posts[ 0 ].payload.artifact.sourceThreeVersion, '0.184.0' );
		assert.equal( posts[ 0 ].payload.artifact.sourceHashVersion, ARTIFACT_TOOLCHAIN_VERSION );
		assert.equal( posts[ 0 ].payload.hash, hashArtifactContentSync( posts[ 0 ].payload.artifact, {
			shape: 'render-output',
			threeVersion: '0.184.0',
			pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
		} ) );
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

test( 'precompileAuxiliary skips plain Color backgrounds while capturing renderer output', async () => {

	__resetAuxRegistryForTests();
	const originalFetch = globalThis.fetch;
	const posts = [];
	const background = { isColor: true, r: 0.1, g: 0.2, b: 0.3 };
	const scene = {
		background,
		backgroundNode: null,
		environment: null,
		environmentNode: null,
		userData: {},
		traverse() {},
	};
	const replayConfig = {
		schema: 'renderer-output@1',
		toneMapping: 0,
		currentColorSpace: 'srgb',
		sampledTexture: '2d',
		multiview: false,
	};
	const outputArtifact = {
		vertexShader: 'output-vertex',
		fragmentShader: 'output-fragment',
		uniformPlan: [ { textures: [ {
			bindingKind: 'sampled-texture',
			textureType: '2d',
			source: {
				kind: 'artifact.texture',
				textureUuid: 'output-texture',
				mapping: 300,
			},
		} ] } ],
	};
	let compileCalls = 0;
	const compileTSL = async ( renderer, captureScene, camera, options ) => {

		compileCalls ++;
		assert.equal( captureScene, scene );
		assert.equal( options.captureRendererOutput, true, 'plain Color must not enter background material capture' );
		const artifacts = [ outputArtifact ];
		Object.defineProperty( artifacts, 'renderOutputCapture', {
			value: { artifact: outputArtifact, replayConfig },
		} );
		return artifacts;

	};
	globalThis.fetch = async ( endpoint, request ) => {

		posts.push( { endpoint, payload: JSON.parse( request.body ) } );
		return { ok: true, text: async () => '' };

	};

	try {

		const results = await precompileAuxiliary( {}, scene, {}, {
			devEndpoint: '/capture',
			threeVersion: '0.185.1',
			compileTSL,
		} );

		assert.equal( compileCalls, 1, 'only the independent renderer-output material is compiled' );
		assert.equal( results.some( ( result ) => result.shape === 'background' ), false );
		assert.deepEqual( results.map( ( result ) => result.shape ), [ 'render-output' ] );
		assert.equal( results[ 0 ].ok, true );
		assert.equal( posts.length, 1 );
		assert.equal( posts[ 0 ].payload.materialShape, 'render-output' );
		assert.equal( scene.background, background, 'the live clear color remains caller-owned' );

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
	const posts = [];
	globalThis.fetch = async ( _url, init ) => {

		posts.push( JSON.parse( init.body ) );
		return { ok: true };

	};
	__resetAuxRegistryForTests();
	try {

		const results = await precompileAuxiliary( {}, scene, {}, {
			devEndpoint: '/capture',
			threeVersion: '184',
			compileTSL,
			passNode,
			backgroundName: 'pass-background',
		} );
		assert.equal( results.find( ( result ) => result.shape === 'background' ).ok, true );
		const backgroundPost = posts.find( ( post ) => post.materialShape === 'background' );
		assert.equal( backgroundPost.name, 'pass-background' );
		assert.equal( backgroundPost.configHash.length, 64 );
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

test( 'precompileAuxiliary preserves Float-depth and default background target variants transactionally', async () => {

	const clones = [];
	const floatDepthTarget = {
		depthTexture: { type: 1015, image: { width: 640, height: 480 } },
		disposed: false,
		clone() {

			const clone = {
				depthTexture: { type: this.depthTexture.type, image: { ...this.depthTexture.image } },
				disposed: false,
				setSize() {},
				dispose() { this.disposed = true; },
			};
			clones.push( clone );
			return clone;

		},
		dispose() { this.disposed = true; },
	};
	const hostTarget = { label: 'host-target' };
	let activeTarget = hostTarget;
	const renderer = {
		getRenderTarget: () => activeTarget,
		setRenderTarget: ( target ) => { activeTarget = target; },
	};
	const scene = {
		background: { __tslpAuxConfigHash: 'background-target-family' },
		backgroundNode: null,
		userData: {},
		traverse() {},
	};
	rememberBackgroundCaptureRenderTarget( scene, renderer, floatDepthTarget );
	rememberBackgroundCaptureRenderTarget( scene, renderer, null );

	const capturedDepthTypes = [];
	const compileTSL = async ( _renderer, _captureScene, _camera, options = {} ) => {

		if ( options.captureRendererOutput ) {

			const artifact = {
				cacheKey: 'output',
				materialShape: 'output-transform',
				uniformPlan: [],
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

		const previousTarget = renderer.getRenderTarget();
		const captureTarget = options.renderTargetOverride || null;
		renderer.setRenderTarget( captureTarget );
		try {

			const depthType = captureTarget ? captureTarget.depthTexture.type : 1014;
			capturedDepthTypes.push( depthType );
			return [ {
				version: 3,
				cacheKey: `background-depth-${ depthType }`,
				renderContextSelectors: [ JSON.stringify( {
					target: { depthTexture: { dataType: depthType } },
				} ) ],
				materialShape: 'background',
				bindings: [],
				uniformPlan: [],
				attributes: [],
				nodeAttributes: [],
				vertexShader: 'background-vertex',
				fragmentShader: 'background-fragment',
			} ];

		} finally {

			renderer.setRenderTarget( previousTarget );

		}

	};
	const originalFetch = globalThis.fetch;
	const posts = [];
	globalThis.fetch = async ( _url, init ) => {

		posts.push( JSON.parse( init.body ) );
		return { ok: true };

	};
	__resetAuxRegistryForTests();
	try {

		const results = await precompileAuxiliary( renderer, scene, {}, {
			devEndpoint: '/capture',
			threeVersion: '0.185.1',
			compileTSL,
		} );
		assert.equal( results.find( ( result ) => result.shape === 'background' ).ok, true );
		assert.deepEqual( [ ...capturedDepthTypes ].sort(), [ 1014, 1015 ] );
		const postedBackground = posts.find( ( post ) => post.materialShape === 'background' );
		const selectorDepthTypes = collectArtifactVariantCandidates( postedBackground.artifact )
			.flatMap( ( candidate ) => candidate.renderContextSelectors || [] )
			.map( ( selector ) => JSON.parse( selector ).target.depthTexture.dataType )
			.sort();
		assert.deepEqual( selectorDepthTypes, [ 1014, 1015 ] );
		assert.equal( activeTarget, hostTarget, 'each target-specific compile restores the caller target' );
		assert.equal( clones.length, 1 );
		assert.equal( clones[ 0 ].disposed, true, 'private Float-depth clone is released' );
		assert.equal( floatDepthTarget.disposed, false, 'live Float-depth target remains caller-owned' );

	} finally {

		__resetAuxRegistryForTests();
		globalThis.fetch = originalFetch;

	}

} );

test( 'precompileAuxiliary captures effects observed only through live update nodes', async () => {

	class NodeMaterial {

		constructor() {

			this.uuid = `material-${ NodeMaterial.nextId ++ }`;
			this.fragmentNode = { owner: this.uuid };
			this.version = 1;
			this.disposed = false;

		}
		clone() {

			const clone = new NodeMaterial();
			clone.fragmentNode = this.fragmentNode;
			clone.version = this.version;
			clone.sourceMaterial = this;
			NodeMaterial.clones.push( clone );
			return clone;

		}
		dispose() { this.disposed = true; }

	}
	NodeMaterial.nextId = 1;
	NodeMaterial.clones = [];
	class Scene {

		constructor() {

			this.children = [];
			this.userData = {};

		}
		add( object ) { this.children.push( object ); }
		traverse( callback ) { this.children.forEach( callback ); }

	}
	class QuadMesh {

		constructor( material ) {

			if ( QuadMesh.throwNext ) {

				QuadMesh.throwNext = false;
				throw new Error( 'synthetic QuadMesh construction failed' );

			}
			this.material = material;

		}

	}
	QuadMesh.throwNext = false;
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
	const bloomBlur0 = new NodeMaterial();
	bloomBlur0.colorTexture = { value: { name: 'live-bloom-blur-0' } };
	const bloomBlur1 = new NodeMaterial();
	bloomBlur1.colorTexture = { value: { name: 'live-bloom-blur-1' } };
	const bloom = {
		updateBefore: () => {},
		_nMips: 2,
		_renderTargetBright: { texture: { name: 'Bloom.Bright', format: 1028, type: 1009 } },
		_renderTargetsHorizontal: [
			{ texture: { name: 'Bloom.H0', format: 1023, type: 1016 } },
			{ texture: { name: 'Bloom.H1', format: 1026, type: 1009 } },
		],
		_renderTargetsVertical: [ {}, {} ],
		_highPassFilterMaterial: new NodeMaterial(),
		_separableBlurMaterials: [ bloomBlur0, bloomBlur1 ],
		_compositeMaterial: new NodeMaterial(),
	};
	const lazySetupMaterials = [];
	let trackLazySetups = false;
	bloom.setup = () => {

		bloom._highPassFilterMaterial = bloom._highPassFilterMaterial || new NodeMaterial();
		bloom._compositeMaterial = bloom._compositeMaterial || new NodeMaterial();
		while ( bloom._separableBlurMaterials.length < bloom._nMips ) {

			bloom._separableBlurMaterials.push( new NodeMaterial() );

		}
		if ( trackLazySetups ) {

			lazySetupMaterials.push(
				bloom._highPassFilterMaterial,
				...bloom._separableBlurMaterials,
				bloom._compositeMaterial,
			);

		}

	};
	const originalBloomBlurArray = bloom._separableBlurMaterials;
	const originalBloomBlurContents = bloom._separableBlurMaterials.slice();
	const originalBloomHighFragment = bloom._highPassFilterMaterial.fragmentNode;
	const originalBloomCompositeFragment = bloom._compositeMaterial.fragmentNode;
	const originalBloomHighVersion = bloom._highPassFilterMaterial.version;
	const originalBloomCompositeVersion = bloom._compositeMaterial.version;
	const originalGtaoFragment = gtao._material.fragmentNode;
	const originalSssFragment = sss._material.fragmentNode;
	const outputNode = { isNode: true, bloom, gtao, sss };
	const livePipelineContext = { label: 'live-context' };
	const liveFragmentNode = { label: 'live-fragment-node' };
	const pipelineMaterial = {
		uuid: 'render-pipeline-material',
		fragmentNode: liveFragmentNode,
		version: 7,
	};
	const isolatedPipelines = [];
	class TestRenderPipeline {

		constructor( renderer, isolatedOutputNode ) {

			this.renderer = renderer;
			this.outputNode = isolatedOutputNode;
			this.outputColorTransform = true;
			this.needsUpdate = true;
			this._toneMapping = renderer.toneMapping;
			this._outputColorSpace = renderer.outputColorSpace;
			this._context = null;
			this._quadMesh = {
				camera: { isOrthographicCamera: true },
				material: {
					uuid: `isolated-pipeline-material-${ isolatedPipelines.length + 1 }`,
					fragmentNode: null,
					version: 0,
					disposed: false,
					dispose() { this.disposed = true; },
				},
			};
			isolatedPipelines.push( this );

		}
		_update() {

			this._context = { renderPipeline: this };
			this._quadMesh.material.fragmentNode = this.outputNode;
			this._quadMesh.material.version ++;
			this.needsUpdate = false;

		}
		dispose() { this._quadMesh.material.dispose(); }

	}
	const renderPipeline = {
		constructor: TestRenderPipeline,
		outputNode,
		outputColorTransform: true,
		renderer: { toneMapping: 4, outputColorSpace: 'srgb', logarithmicDepthBuffer: true },
		needsUpdate: false,
		_context: livePipelineContext,
		_toneMapping: 4,
		_outputColorSpace: 'srgb',
		_quadMesh: { material: pipelineMaterial },
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
	const syntheticSetupMaterials = [];
	let releaseEffectCapture;
	const effectCaptureRelease = new Promise( ( resolve ) => { releaseEffectCapture = resolve; } );
	let notifyEffectCaptureStarted;
	const effectCaptureStarted = new Promise( ( resolve ) => { notifyEffectCaptureStarted = resolve; } );
	let pausedEffectCapture = false;
	let releasePriorBlurCompile;
	const priorBlurCompile = new Promise( ( resolve ) => { releasePriorBlurCompile = resolve; } );
	let notifyPriorBlurCompileInstalled;
	const priorBlurCompileInstalled = new Promise( ( resolve ) => { notifyPriorBlurCompileInstalled = resolve; } );
	let priorBlurObservedTexture = null;
	let releaseMovingBlurCompile;
	const movingBlurCompile = new Promise( ( resolve ) => { releaseMovingBlurCompile = resolve; } );
	let movingBlurObservedTexture = null;
	let installedPriorBlurCompile = false;
	const captureRenderer = {};
	const compileTSL = async ( activeRenderer, captureScene, _camera, options = {} ) => {

		compileCalls ++;
		const material = captureScene.children && captureScene.children[ 0 ] && captureScene.children[ 0 ].material;
		if ( Array.isArray( options.skipNodeUpdatesForMaterials ) ) {

			assert.equal( options.noGlobalMRT, true );
			assert.equal( options.skipWarmupRender, true );
			assert.deepEqual( options.skipNodeUpdatesForMaterials, [ material ] );
			assert.deepEqual( options.rendererStateOverride, {
				toneMapping: 0,
				currentColorSpace: 'working',
			} );
			assert.notEqual( material, pipelineMaterial, 'final pipeline artifact uses a private material identity' );
			assert.match( material.customProgramCacheKey(), /tslp-isolated-capture:post-process:/ );
			pipelineCompileTargets.push( options.renderTargetOverride || null );
			if (
				! bloom._highPassFilterMaterial
				|| ! bloom._compositeMaterial
				|| bloom._separableBlurMaterials.length < bloom._nMips
			) bloom.setup();
			bloom._highPassFilterMaterial.fragmentNode = { label: 'synthetic-bloom-high' };
			bloom._highPassFilterMaterial.version ++;
			bloom._compositeMaterial.fragmentNode = { label: 'synthetic-bloom-composite' };
			bloom._compositeMaterial.version ++;
			for ( let i = 0; i < bloom._nMips; i ++ ) {

				const appended = new NodeMaterial();
				appended.syntheticSetupMaterial = true;
				syntheticSetupMaterials.push( appended );
				bloom._separableBlurMaterials.push( appended );

			}
			gtao._material.fragmentNode = { label: 'synthetic-gtao' };
			gtao._material.version ++;
			sss._material.fragmentNode = { label: 'synthetic-sss' };
			sss._material.version ++;

			const artifact = {
				materialUuid: material.uuid,
				materialShape: 'render-pipeline',
				uniformPlan: [],
				vertexShader: '',
				fragmentShader: '',
			};
			Object.defineProperty( artifact, '_liveUpdateBeforeNodes', { value: [ bloom, gtao, sss ] } );
			return [ artifact ];

		}
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
		assert.equal( renderPipeline.needsUpdate, false, 'pipeline state is restored before isolated effect capture starts' );
		assert.equal( renderPipeline._context, livePipelineContext );
		assert.equal( pipelineMaterial.fragmentNode, liveFragmentNode );
		assert.notEqual( material, material.sourceMaterial, 'synthetic effect capture compiles a clone' );
		assert.notEqual( material.uuid, material.sourceMaterial.uuid, 'effect clone has a private cache identity' );
		assert.match( material.customProgramCacheKey(), /tslp-isolated-capture:/ );
		if ( ! pausedEffectCapture ) {

			pausedEffectCapture = true;
			notifyEffectCaptureStarted();
			await effectCaptureRelease;

		}
		if ( material.sourceMaterial === bloom._highPassFilterMaterial && ! installedPriorBlurCompile ) {

			installedPriorBlurCompile = true;
			activeRenderer.__tslpCompileLock = priorBlurCompile.then( () => {

				priorBlurObservedTexture = bloomBlur0.colorTexture.value;

			} );
			notifyPriorBlurCompileInstalled();

		}
		if ( material.sourceMaterial === bloomBlur0 || material.sourceMaterial === bloomBlur1 ) {

			assert.equal(
				material.colorTexture.value,
				bloom._renderTargetBright.texture,
				'Bloom override is applied only inside the isolated compile turn',
			);

		}
		material.fragmentNode = { label: 'synthetic-effect-fragment' };
		material.version = 99;
		const artifact = {
			materialUuid: material.uuid,
			uniformPlan: [],
			vertexShader: '',
			fragmentShader: '',
		};
		return [ artifact ];

	};
	const three = {
		NodeMaterial,
		Scene,
		QuadMesh,
		RenderTarget,
		NoToneMapping: 0,
		ColorManagement: { workingColorSpace: 'working' },
	};

	const originalFetch = globalThis.fetch;
	const payloads = [];
	globalThis.fetch = async ( _endpoint, request ) => {

		payloads.push( JSON.parse( request.body ) );
		return { ok: true };

	};
	try {

		const pendingResults = precompileAuxiliary( captureRenderer, { traverse: () => {} }, {}, {
			devEndpoint: '/capture',
			threeVersion: '184',
			compileTSL,
			renderPipeline,
			renderPipelineName: 'effects-pipeline-a',
			renderPipelineTarget,
			three,
		} );
		await effectCaptureStarted;
		assert.equal( renderPipeline.needsUpdate, false, 'live pipeline is restored while an async effect compile is pending' );
		assert.equal( renderPipeline._context, livePipelineContext );
		assert.equal( pipelineMaterial.fragmentNode, liveFragmentNode );
		releaseEffectCapture();
		await priorBlurCompileInstalled;
		assert.equal( bloomBlur0.colorTexture.value.name, 'live-bloom-blur-0', 'queued capture does not expose its override' );
		const observedPriorTail = captureRenderer.__tslpCompileLock;
		captureRenderer.__tslpCompileLock = observedPriorTail
			.then( () => movingBlurCompile )
			.then( () => {

				movingBlurObservedTexture = bloomBlur0.colorTexture.value;

			} );
		releasePriorBlurCompile();
		for ( let turn = 0; turn < 5; turn ++ ) await Promise.resolve();
		assert.equal(
			bloomBlur0.colorTexture.value.name,
			'live-bloom-blur-0',
			'a moving renderer queue tail remains ahead of the Bloom override',
		);
		releaseMovingBlurCompile();
		const results = await pendingResults;
		assert.equal(
			priorBlurObservedTexture.name,
			'live-bloom-blur-0',
			'the prior renderer compile observes the untouched live Bloom texture',
		);
		assert.equal(
			movingBlurObservedTexture.name,
			'live-bloom-blur-0',
			'a compile appended to the renderer queue also observes the untouched live texture',
		);
		assert.equal( bloomBlur0.colorTexture.value.name, 'live-bloom-blur-0', 'Bloom override is restored after compile' );
		assert.equal( compileCalls, 8, 'captures the output, Bloom/GTAO/SSS effects, and renderer-output material' );
		assert.deepEqual( results.map( ( result ) => result.shape ), [
			'post-process',
			'bloom-high-pass',
			'bloom-blur-0',
			'bloom-blur-1',
			'bloom-composite',
			'gtao',
			'sss',
			'render-output',
		] );
		assert.deepEqual( payloads.map( ( payload ) => payload.materialShape ), results.map( ( result ) => result.shape ) );
		assert.equal( payloads[ 0 ].name, 'effects-pipeline-a' );
		assert.equal( payloads[ 0 ].artifact.replayConfig.outputColorTransform, true );
		assert.equal( payloads[ 0 ].artifact.replayConfig.logarithmicDepthBuffer, true );
		assert.equal( Object.hasOwn( payloads[ 0 ].artifact.replayConfig, 'reversedDepthBuffer' ), false );
		assert.equal( renderPipelineTarget.cloneCalls, 1 );
		assert.equal( pipelineCompileTargets[ 0 ], targetClones[ 0 ] );
		assert.deepEqual( targetClones[ 0 ].setSizeCalls, [ [ 1, 1 ] ] );
		assert.equal( targetClones[ 0 ].disposed, true, 'capture clone is released' );
		assert.equal( renderPipelineTarget.disposed, false, 'live pipeline target remains caller-owned' );
		assert.equal( renderPipeline.needsUpdate, false, 'live pipeline update state is restored' );
		assert.equal( renderPipeline._context, livePipelineContext, 'live pipeline context identity is restored' );
		assert.equal( renderPipeline._toneMapping, 4 );
		assert.equal( renderPipeline._outputColorSpace, 'srgb' );
		assert.equal( renderPipeline._quadMesh.material, pipelineMaterial, 'live quad material identity is preserved' );
		assert.equal( pipelineMaterial.fragmentNode, liveFragmentNode, 'live fragment graph identity is restored' );
		assert.equal( pipelineMaterial.version, 7, 'synthetic material invalidation does not leak' );
		assert.equal( gtao._material.version, 1, 'synthetic GTAO material invalidation does not leak' );
		assert.equal( sss._material.version, 1, 'synthetic SSS material invalidation does not leak' );
		assert.equal( NodeMaterial.clones.length, 6 );
		assert.equal( NodeMaterial.clones.every( ( clone ) => clone.disposed ), true, 'isolated effect clones are released' );
		assert.equal( bloom._separableBlurMaterials, originalBloomBlurArray, 'Bloom blur array identity survives capture' );
		assert.deepEqual( bloom._separableBlurMaterials, originalBloomBlurContents, 'Bloom blur contents do not grow during capture' );
		assert.equal( bloom._highPassFilterMaterial.fragmentNode, originalBloomHighFragment );
		assert.equal( bloom._highPassFilterMaterial.version, originalBloomHighVersion );
		assert.equal( bloom._compositeMaterial.fragmentNode, originalBloomCompositeFragment );
		assert.equal( bloom._compositeMaterial.version, originalBloomCompositeVersion );
		assert.equal( gtao._material.fragmentNode, originalGtaoFragment );
		assert.equal( sss._material.fragmentNode, originalSssFragment );
		assert.equal( syntheticSetupMaterials.length, 2 );
		assert.equal( syntheticSetupMaterials.every( ( material ) => material.disposed ), true, 'only appended setup materials are disposed' );
		assert.equal( originalBloomBlurContents.some( ( material ) => material.disposed ), false, 'caller-owned Bloom materials remain live' );
		assert.equal( payloads[ 7 ].artifact.fragmentShader, 'active-output' );
		assert.equal( payloads[ 7 ].artifact.replayConfig.currentColorSpace, 'srgb' );
		assert.deepEqual( RenderTarget.options, [
			{ depthBuffer: false, count: 1, format: 1028, type: 1009 },
			{ depthBuffer: false, count: 1, format: 1023, type: 1016 },
			{ depthBuffer: false, count: 1, format: 1026, type: 1009 },
			{ depthBuffer: false, count: 1, format: 1023, type: 1016 },
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
			three,
		} );
		assert.equal( payloads[ 8 ].name, 'effects-pipeline-b' );
		assert.equal( pipelineCompileTargets[ 1 ], targetClones[ 1 ] );
		assert.equal( targetClones[ 1 ].disposed, true );
		assert.equal( renderPipeline._context, livePipelineContext );
		assert.equal( pipelineMaterial.fragmentNode, liveFragmentNode );
		assert.equal( pipelineMaterial.version, 7 );
		assert.equal( NodeMaterial.clones.length, 12 );
		assert.equal( NodeMaterial.clones.every( ( clone ) => clone.disposed ), true );
		assert.equal( bloom._separableBlurMaterials, originalBloomBlurArray );
		assert.deepEqual( bloom._separableBlurMaterials, originalBloomBlurContents, 'repeat capture does not accumulate Bloom materials' );
		assert.equal( bloom._highPassFilterMaterial.fragmentNode, originalBloomHighFragment );
		assert.equal( bloom._highPassFilterMaterial.version, originalBloomHighVersion );
		assert.equal( bloom._compositeMaterial.fragmentNode, originalBloomCompositeFragment );
		assert.equal( bloom._compositeMaterial.version, originalBloomCompositeVersion );
		assert.equal( gtao._material.fragmentNode, originalGtaoFragment );
		assert.equal( gtao._material.version, 1 );
		assert.equal( sss._material.fragmentNode, originalSssFragment );
		assert.equal( sss._material.version, 1 );
		assert.equal( syntheticSetupMaterials.length, 4 );
		assert.equal( syntheticSetupMaterials.every( ( material ) => material.disposed ), true );
		assert.notEqual(
			payloads[ 0 ].configHash,
			payloads[ 8 ].configHash,
			'semantically named pipelines remain distinct when their normalized graphs match',
		);

		const lazyBloomArray = [];
		bloom._highPassFilterMaterial = null;
		bloom._separableBlurMaterials = lazyBloomArray;
		bloom._compositeMaterial = null;
		trackLazySetups = true;
		for ( const name of [ 'effects-pipeline-lazy-a', 'effects-pipeline-lazy-b' ] ) {

			const lazyResults = await precompileAuxiliary( {}, { traverse: () => {} }, {}, {
				devEndpoint: '/capture',
				threeVersion: '184',
				compileTSL,
				renderPipeline,
				renderPipelineName: name,
				renderPipelineTarget,
				three,
			} );
			assert.equal( lazyResults.find( ( result ) => result.shape === 'post-process' ).ok, true );
			assert.equal( bloom._highPassFilterMaterial, null, 'uninitialized high-pass field remains uninitialized after capture' );
			assert.equal( bloom._separableBlurMaterials, lazyBloomArray, 'uninitialized blur array identity survives capture' );
			assert.deepEqual( bloom._separableBlurMaterials, [], 'uninitialized blur array does not accumulate setup materials' );
			assert.equal( bloom._compositeMaterial, null, 'uninitialized composite field remains uninitialized after capture' );

		}
		assert.equal( lazySetupMaterials.length, 16, 'pipeline and forceSetup each materialize one private set per lazy capture' );
		assert.equal( lazySetupMaterials.every( ( material ) => material.disposed ), true, 'all lazily-created setup materials are released' );
		assert.equal( NodeMaterial.clones.length, 24 );
		assert.equal( NodeMaterial.clones.every( ( clone ) => clone.disposed ), true );

		const cloneMethod = NodeMaterial.prototype.clone;
		const invalidIdentityClones = [];
		NodeMaterial.prototype.clone = function cloneWithReusedUuid() {

			const clone = new NodeMaterial();
			clone.uuid = this.uuid;
			invalidIdentityClones.push( clone );
			return clone;

		};
		let invalidIdentityResults;
		try {

			invalidIdentityResults = await precompileAuxiliary( {}, { traverse: () => {} }, {}, {
				devEndpoint: '/capture',
				threeVersion: '184',
				compileTSL,
				renderPipeline,
				renderPipelineName: 'effects-pipeline-invalid-clone',
				renderPipelineTarget,
				three,
			} );

		} finally {

			NodeMaterial.prototype.clone = cloneMethod;

		}
		assert.equal( invalidIdentityResults.find( ( result ) => result.shape === 'post-process' ).ok, false );
		assert.match(
			invalidIdentityResults.find( ( result ) => result.shape === 'post-process' ).error,
			/distinct identity and UUID/,
		);
		assert.equal( invalidIdentityClones.length, 1 );
		assert.equal( invalidIdentityClones[ 0 ].disposed, true, 'an invalid distinct clone is still released' );

		const clonesBeforeConstructionFailure = NodeMaterial.clones.length;
		QuadMesh.throwNext = true;
		const constructionFailureResults = await precompileAuxiliary( {}, { traverse: () => {} }, {}, {
			devEndpoint: '/capture',
			threeVersion: '184',
			compileTSL,
			renderPipeline,
			renderPipelineName: 'effects-pipeline-construction-failure',
			renderPipelineTarget,
			three,
		} );
		const constructionFailure = constructionFailureResults.find( ( result ) => result.shape === 'post-process' );
		assert.equal( constructionFailure.ok, false );
		assert.match( constructionFailure.error, /synthetic QuadMesh construction failed/ );
		const constructionFailureClones = NodeMaterial.clones.slice( clonesBeforeConstructionFailure );
		assert.equal( constructionFailureClones.length, 4 );
		assert.equal(
			constructionFailureClones.every( ( clone ) => clone.disposed ),
			true,
			'started and queued effect clones are all released when capture setup throws',
		);

		const payloadCountBeforeIsolationFailure = payloads.length;
		delete NodeMaterial.prototype.clone;
		let failedIsolationResults;
		try {

			failedIsolationResults = await precompileAuxiliary( {}, { traverse: () => {} }, {}, {
				devEndpoint: '/capture',
				threeVersion: '184',
				compileTSL,
				renderPipeline,
				renderPipelineName: 'effects-pipeline-clone-failure',
				renderPipelineTarget,
				three,
			} );

		} finally {

			NodeMaterial.prototype.clone = cloneMethod;

		}
		const failedPostProcess = failedIsolationResults.find( ( result ) => result.shape === 'post-process' );
		assert.equal( failedPostProcess.ok, false, 'a recognized effect isolation failure fails the parent capture' );
		assert.match( failedPostProcess.error, /bloom-high-pass material must expose clone\(\)/ );
		assert.equal(
			payloads.length,
			payloadCountBeforeIsolationFailure + 1,
			'failed parent/effect artifacts are not published; only the independent renderer-output artifact remains',
		);
		assert.equal( payloads.at( -1 ).materialShape, 'render-output' );

	} finally {

		globalThis.fetch = originalFetch;

	}

} );

test( 'precompileAuxiliary preserves shadow families, unions equivalent keys, and disambiguates signed r185 target collisions', async () => {

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
	const reusedDirectionalSelector = '{"material":{"transparent":true},"target":{"surface":"offscreen-2d"}}';
	const reusedPointSelector = '{"material":{"transparent":false},"target":{"surface":"offscreen-cube"}}';
	const directionalOnly = '{"shadowCaster":{"customDepth":true}}';
	const pointOnly = '{"shadowCaster":{"map":true},"target":{"surface":"offscreen-cube"}}';
	const sharedDirectional = shadowArtifact( 'shared-key', directionalSelector, 'shared-shadow' );
	const sharedPoint = shadowArtifact( 'shared-key', pointSelector, 'shared-shadow' );
	const directional = shadowArtifact( 'directional-key', directionalOnly, 'directional-shadow' );
	const point = shadowArtifact( 'point-key', pointOnly, 'point-shadow' );
	const reused2D = shadowArtifact( 'r185-reused-key', reusedDirectionalSelector, 'r185-shadow' );
	const reusedCube = shadowArtifact( 'r185-reused-key', reusedPointSelector, 'r185-shadow' );
	const vsmSupportConfig = createVSMSupportConfig();
	const vsmArtifact = ( stage ) => {

		const shape = `shadow-vsm-${ stage }`;
		const textureRole = stage === 'vertical' ? 'shadow-depth' : 'vsm-vertical';
		return {
			materialShape: shape,
			cacheKey: `vsm-${ stage }`,
			vertexShader: `vsm-${ stage }-vertex`,
			fragmentShader: `vsm-${ stage }-fragment`,
			bindings: [],
			uniformPlan: [
				{
					name: 'render',
					slots: [
						{ name: 'nodeUniform0', source: { kind: 'light.shadowBlurSamples' } },
						{ name: 'nodeUniform3', source: { kind: 'light.shadowRadius' } },
						{ name: 'nodeUniform4', source: { kind: 'light.shadowMapSize' } },
					],
					textures: [],
				},
				{
					name: 'object',
					slots: [],
					textures: [ {
						name: 'nodeUniform1',
						bindingKind: 'sampled-texture',
						textureType: '2d',
						source: {
							kind: stage === 'vertical' ? 'depth.texture' : 'artifact.texture',
							textureUuid: `captured-vsm-${ stage }`,
						},
					} ],
				},
			],
			internalPass: {
				schema: 'internal-pass@1',
				family: 'shadow-vsm',
				stage,
				shape,
				config: vsmSupportConfig,
				uniforms: [
					{ role: 'blur-samples', group: 'render', binding: 'nodeUniform0', valueType: 'float' },
					{ role: 'radius', group: 'render', binding: 'nodeUniform3', valueType: 'float' },
					{ role: 'map-size', group: 'render', binding: 'nodeUniform4', valueType: 'vec2' },
				],
				inputs: [ {
					role: textureRole,
					kind: 'texture',
					group: 'object',
					binding: 'nodeUniform1',
					topology: stage === 'vertical'
						? vsmSourceInputTopology( vsmSupportConfig )
						: vsmMomentsTopology( vsmSupportConfig ),
				} ],
				output: {
					topology: vsmMomentsTopology( vsmSupportConfig ),
				},
			},
		};

	};
	const vsmVertical = vsmArtifact( 'vertical' );
	const vsmHorizontal = vsmArtifact( 'horizontal' );
	reused2D.renderState = { depthWrite: true, transparent: true };
	reusedCube.renderState = { depthWrite: true };
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
		return [ sharedDirectional, directional, sharedPoint, point, reused2D, reusedCube, vsmVertical, vsmHorizontal ];

	};
	const lights = [
		{ isLight: true, type: 'DirectionalLight', castShadow: true, shadow: { mapSize: { width: 512, height: 512 } } },
		{ isLight: true, isPointLight: true, type: 'PointLight', castShadow: true, shadow: { mapSize: { width: 256, height: 256 } } },
	];
	const scene = {
		background: null,
		backgroundNode: null,
		userData: {},
		traverse( callback ) { lights.forEach( callback ); },
	};
	const originalFetch = globalThis.fetch;
	const payloads = [];
	const familyTransactions = [];
	const renderer = {};
	const resolvedRenderObjectHarvest = { supported: true, familiesByMaterial: new Map() };
	const renderObjectHarvest = Promise.resolve( resolvedRenderObjectHarvest );
	globalThis.fetch = async ( _endpoint, request ) => {

		const body = JSON.parse( request.body );
		if ( Array.isArray( body.members ) ) {

			familyTransactions.push( body );
			payloads.push( ...body.members );

		} else payloads.push( body );
		return { ok: true };

	};
	__resetAuxRegistryForTests();
	__resetRenderObjectHarvestHandoffForTests();
	publishRenderObjectHarvest( renderer, scene, renderObjectHarvest );
	try {

		await precompileAuxiliary( renderer, scene, {}, {
			devEndpoint: '/capture',
			threeVersion: '0.185.1',
			compileTSL,
		} );
		assert.equal( receivedHarvest, resolvedRenderObjectHarvest, 'shadow capture consumes the resolved staged real-render harvest' );
		assert.equal( takeRenderObjectHarvest( renderer, scene ), null, 'the staged harvest is one-shot' );
		assert.equal( familyTransactions.length, 1 );
		assert.equal( familyTransactions[ 0 ].auxiliaryFamily, 'shadow-vsm' );
		assert.deepEqual(
			familyTransactions[ 0 ].members.map( ( member ) => member.materialShape ).sort(),
			[ 'shadow-depth', 'shadow-vsm-horizontal', 'shadow-vsm-vertical' ],
		);
		const payload = payloads.find( ( candidate ) => candidate.materialShape === 'shadow-depth' );
		assert.ok( payload, 'expected one aggregate shadow-depth POST' );
		const variantKeys = Object.keys( payload.artifact.variants ).sort();
		assert.deepEqual(
			variantKeys.filter( ( key ) => ! key.startsWith( 'r185-reused-key:tslp-shadow:' ) ),
			[ 'directional-key', 'point-key', 'shared-key' ],
		);
		assert.deepEqual( payload.artifact.variants[ 'shared-key' ].renderContextSelectors, [ directionalSelector, pointSelector ].sort() );
		assert.equal( payload.artifact.variants[ 'directional-key' ].fragmentShader, 'directional-shadow' );
		assert.equal( payload.artifact.variants[ 'point-key' ].fragmentShader, 'point-shadow' );
		const rekeyed = variantKeys
			.filter( ( key ) => key.startsWith( 'r185-reused-key:tslp-shadow:' ) )
			.map( ( key ) => payload.artifact.variants[ key ] );
		assert.equal( rekeyed.length, 2, 'divergent payloads receive distinct durable keys' );
		assert.deepEqual( rekeyed.map( ( candidate ) => candidate.renderState.transparent ).sort(), [ true, undefined ] );
		assert.deepEqual(
			rekeyed.flatMap( ( candidate ) => candidate.renderContextSelectors ).sort(),
			[ reusedDirectionalSelector, reusedPointSelector ].sort(),
			'the signed target selectors remain authoritative after rekeying',
		);
		const vsmPayloads = payloads
			.filter( ( candidate ) => candidate.materialShape.startsWith( 'shadow-vsm-' ) )
			.sort( ( left, right ) => left.materialShape.localeCompare( right.materialShape ) );
		assert.deepEqual(
			vsmPayloads.map( ( candidate ) => candidate.materialShape ),
			[ 'shadow-vsm-horizontal', 'shadow-vsm-vertical' ],
			'both captured VSM filters are published beside the depth family',
		);
		assert.equal( vsmPayloads[ 0 ].configHash, vsmPayloads[ 1 ].configHash );
		const expectedVsmHash = hashPlainConfigSync( vsmSupportConfig, {
			shape: 'shadow-vsm',
			threeVersion: '0.185.1',
			pluginVersion: '0.1.0',
		} );
		assert.equal( vsmPayloads[ 0 ].configHash, expectedVsmHash );

		const payloadCountBeforeInvalidVsm = payloads.length;
		const invalidVsmResults = await precompileAuxiliary(
			{ shadowMap: { type: 3 } },
			scene,
			{},
			{
				devEndpoint: '/capture',
				threeVersion: '0.185.1',
				three: { VSMShadowMap: 3 },
				compileTSL: async ( _renderer, _scene, _camera, options = {} ) => {

					if ( options.captureRendererOutput ) throw new Error( 'no renderer output in focused shadow fixture' );
					return [
						sharedDirectional,
						directional,
						sharedPoint,
						point,
						reused2D,
						reusedCube,
						{ ...vsmVertical, internalPass: undefined },
						{ ...vsmHorizontal, internalPass: undefined },
					];

				},
			},
		);
		const invalidVsmFailure = invalidVsmResults.find( ( result ) =>
			result.shape === 'shadow-depth' && result.ok === false
		);
		assert.ok( invalidVsmFailure, JSON.stringify( invalidVsmResults ) );
		assert.match( invalidVsmFailure.error, /internalPass must be a plain object/ );
		assert.deepEqual(
			payloads
				.slice( payloadCountBeforeInvalidVsm )
				.filter( ( candidate ) => candidate.materialShape.startsWith( 'shadow-' ) ),
			[],
			'descriptor-less VSM shapes are rejected before any shadow family member is published',
		);

		const payloadCountBeforeIncompleteVsm = payloads.length;
		const incompleteResults = await precompileAuxiliary(
			{ shadowMap: { type: 3 } },
			scene,
			{},
			{
				devEndpoint: '/capture',
				threeVersion: '0.185.1',
				three: { VSMShadowMap: 3 },
				compileTSL: async ( _renderer, _scene, _camera, options = {} ) => {

					if ( options.captureRendererOutput ) throw new Error( 'no renderer output in focused shadow fixture' );
					return [ sharedDirectional, directional, sharedPoint, point, reused2D, reusedCube, vsmVertical ];

				},
			},
		);
		const incompleteVsmFailure = incompleteResults.find( ( result ) =>
			result.shape === 'shadow-depth' && result.ok === false
		);
		assert.ok( incompleteVsmFailure, JSON.stringify( incompleteResults ) );
		assert.match( incompleteVsmFailure.error, /missing expected stage "horizontal"/ );
		assert.deepEqual(
			payloads
				.slice( payloadCountBeforeIncompleteVsm )
				.filter( ( candidate ) => candidate.materialShape.startsWith( 'shadow-' ) ),
			[],
			'an incomplete VSM family is rejected before depth or filter members become durable',
		);

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
			assert.equal( call.sourceState.generateMipmaps, true, 'compile observes r185 temporary mip generation' );
			assert.equal(
				call.sourceState.minFilter,
				source === background ? three.LinearFilter : source.minFilter,
				'compile observes r185 pole-safe minification filter',
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

test( 'precompileAuxiliary reserves cube compilation atomically with its temporary source override', async () => {

	const source = cubeSourceTexture( 'cube-settled-tail-competitor', { minFilter: 1008 } );
	const { state, three, tsl, compileTSL: compileCube } = cubeCaptureFixture();
	let releaseLock;
	const firstLock = new Promise( ( resolve ) => { releaseLock = resolve; } );
	const renderer = {
		coordinateSystem: 'webgpu',
		__tslpCompileLock: firstLock,
	};
	let compileInvoked = false;
	const compileTSL = ( ...args ) => {

		compileInvoked = true;
		return compileCube( ...args );

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
		assert.equal( compileInvoked, false );

		let competitorObservation = null;
		const competitor = firstLock.then( () => {

			competitorObservation = {
				compileInvoked,
				generateMipmaps: source.generateMipmaps,
				minFilter: source.minFilter,
			};

		} );
		releaseLock();
		const results = await pendingCapture;
		await competitor;

		assert.deepEqual( competitorObservation, {
			compileInvoked: true,
			generateMipmaps: true,
			minFilter: 1006,
		}, 'the capture invokes compileTSL in the stable-tail microtask before a settled-tail competitor can run' );
		assert.equal( results.find( ( result ) => result.shape === 'cube-render-target' ).ok, true );
		assert.equal( source.generateMipmaps, false, 'temporary mip generation is restored' );
		assert.equal( source.minFilter, 1008, 'temporary minification filter is restored' );

	} finally {

		__resetAuxRegistryForTests();
		globalThis.fetch = originalFetch;

	}

} );

test( 'precompileAuxiliary restores its cube source before the next queued compile begins', async () => {

	const source = cubeSourceTexture( 'cube-post-compile-cleanup', { minFilter: 1008 } );
	const { state, three, tsl, compileTSL: compileCube } = cubeCaptureFixture();
	const renderer = { coordinateSystem: 'webgpu' };
	let queuedCompileObservation = null;
	let queuedCompile = null;
	const compileTSL = ( activeRenderer, ...args ) => {

		const options = args[ 2 ] || {};
		if ( ! options.renderTargetOverride ) return compileCube( activeRenderer, ...args );
		const previous = activeRenderer.__tslpCompileLock || Promise.resolve();
		let release;
		const owned = new Promise( ( resolve ) => { release = resolve; } );
		const tail = Promise.resolve( previous ).then( () => owned );
		activeRenderer.__tslpCompileLock = tail;
		const capture = ( async () => {

			await previous;
			try {

				return await compileCube( activeRenderer, ...args );

			} finally {

				release();

			}

		} )();
		queuedCompile = ( async () => {

			await tail;
			queuedCompileObservation = {
				generateMipmaps: source.generateMipmaps,
				minFilter: source.minFilter,
			};

		} )();
		return capture;

	};
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => ( { ok: true } );
	__resetAuxRegistryForTests();
	try {

		const results = await precompileAuxiliary( renderer, { background: null, environment: null, traverse() {} }, {}, {
			devEndpoint: '/capture',
			threeVersion: '184',
			compileTSL,
			three,
			tsl,
			cubeRenderTargetTexture: source,
		} );
		await queuedCompile;

		assert.equal( results.find( ( result ) => result.shape === 'cube-render-target' ).ok, true );
		assert.equal( state.cubeCalls.length, 1 );
		assert.deepEqual( queuedCompileObservation, {
			generateMipmaps: false,
			minFilter: 1008,
		}, 'the queued compile observes caller-owned state after synchronous capture cleanup' );

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

function pmremDiscoveryCaptureFixture() {

	const state = {
		generators: [],
		generatedSources: [],
		renderTargets: [],
	};
	class Scene {}
	class OrthographicCamera {}
	class DataTexture {

		constructor( data, width, height ) {

			this.isTexture = true;
			this.image = { data, width, height };
			this.disposed = false;
			state.generatedSources.push( this );

		}
		dispose() { this.disposed = true; }

	}
	class PMREMGenerator {

		constructor() {

			this.calls = [];
			this._cubeSize = 0;
			this._lodMax = 0;
			this.disposed = false;
			state.generators.push( this );

		}
		_setSize( size ) {

			this._lodMax = Math.floor( Math.log2( size ) );
			this._cubeSize = 2 ** this._lodMax;

		}
		_target( depthBuffer ) {

			const target = {
				width: 3 * Math.max( this._cubeSize, 16 * 7 ),
				height: 4 * this._cubeSize,
				depthBuffer,
				texture: { format: 1023, type: 1016 },
				disposed: false,
				dispose() { this.disposed = true; },
			};
			state.renderTargets.push( target );
			return target;

		}
		fromCubemap( source ) {

			const face = source.image[ 0 ];
			this._setSize( face.width || face.image.width );
			this.calls.push( { method: 'fromCubemap', source, cubeSize: this._cubeSize } );
			return this._target( false );

		}
		fromEquirectangular( source ) {

			this._setSize( source.image.width / 4 );
			this.calls.push( { method: 'fromEquirectangular', source, cubeSize: this._cubeSize } );
			return this._target( false );

		}
		_blur( _target, _lodIn, _lodOut, sigma ) {

			this.calls.push( { method: '_blur', sigma, cubeSize: this._cubeSize } );

		}
		fromScene( _scene, sigma, near, far, options ) {

			this._setSize( options.size );
			this.calls.push( { method: 'fromScene', sigma, near, far, size: options.size, cubeSize: this._cubeSize } );
			return this._target( true );

		}
		dispose() { this.disposed = true; }

	}
	const three = {
		DataTexture,
		EquirectangularReflectionMapping: 303,
		NodeMaterial: class {},
		OrthographicCamera,
		PMREMGenerator,
		Scene,
		WebGPURenderer: class {},
	};
	const renderer = {
		getRenderTarget: () => null,
		getActiveCubeFace: () => 0,
		getActiveMipmapLevel: () => 0,
		setRenderTarget() {},
	};
	const compileTSL = async () => {

		throw new Error( 'fixture stops after the real PMREM calls' );

	};
	const beginHarvest = () => ( {
		finish: async () => ( { supported: true, familiesByMaterial: new Map() } ),
	} );
	return { state, three, renderer, compileTSL, beginHarvest };

}

function pmremSourceTexture( kind, cubeSize ) {

	if ( kind === 'cube' ) return {
		isTexture: true,
		isCubeTexture: true,
		mapping: 301,
		image: Array.from( { length: 6 }, () => ( { image: { width: cubeSize, height: cubeSize } } ) ),
	};
	return {
		isTexture: true,
		mapping: 303,
		image: { width: cubeSize * 4, height: cubeSize * 2 },
	};

}

async function runPMREMDiscoveryCapture( scene, captureOptions = {} ) {

	const fixture = pmremDiscoveryCaptureFixture();
	__resetAuxRegistryForTests();
	const results = await precompileAuxiliary( fixture.renderer, scene, {}, {
		devEndpoint: '/capture',
		threeVersion: '0.185.1',
		compileTSL: fixture.compileTSL,
		beginRenderObjectHarvest: fixture.beginHarvest,
		three: fixture.three,
		...captureOptions,
	} );
	__resetAuxRegistryForTests();
	return { ...fixture, results };

}

test( 'precompileAuxiliary separates texture and scene PMREM operation families at one atlas layout', async () => {

	const cube = pmremSourceTexture( 'cube', 64 );
	assert.equal( cube.image.width, undefined, 'fixture must expose dimensions only through the first face' );
	const scene = {
		background: null,
		environment: cube,
		traverse() {},
	};
	const { state, results } = await runPMREMDiscoveryCapture( scene, { pmremSceneSizes: [ 64 ] } );

	assert.equal( state.generators.length, 2, 'source conversion and fromScene use independent PMREM material caches' );
	assert.deepEqual(
		state.generators[ 0 ].calls.map( ( call ) => call.method ),
		[ 'fromCubemap' ],
	);
	assert.equal( state.generators[ 0 ].calls[ 0 ].source, cube );
	assert.equal( state.generators[ 0 ].calls[ 0 ].cubeSize, 64, 'cubemap size comes from image[0].image.width' );
	assert.deepEqual( state.generators[ 1 ].calls.map( ( call ) => call.method ), [ 'fromScene' ] );
	assert.equal( state.generators[ 1 ].calls[ 0 ].size, 64 );
	assert.equal( state.generators.every( ( generator ) => generator.disposed ), true );
	assert.equal( state.renderTargets.every( ( target ) => target.disposed ), true );
	assert.equal( results.filter( ( result ) => result.shape === 'pmrem' ).length, 2 );

} );

test( 'precompileAuxiliary discovers PMREM sources in scene.environmentNode and material node graphs', async () => {

	const environmentNodeSource = pmremSourceTexture( 'equirect', 64 );
	const materialNodeSource = pmremSourceTexture( 'cube', 128 );
	const scene = {
		background: null,
		environment: null,
		environmentNode: {
			isNode: true,
			isPMREMNode: true,
			_value: environmentNodeSource,
		},
		traverse( callback ) {

			callback( {
				material: {
					envNode: {
						isNode: true,
						isPMREMNode: true,
						_value: materialNodeSource,
					},
				},
			} );

		},
	};
	const { state } = await runPMREMDiscoveryCapture( scene );

	assert.deepEqual(
		state.generators.map( ( generator ) => generator.calls[ 0 ].cubeSize ),
		[ 64, 128 ],
	);
	assert.equal( state.generators[ 0 ].calls[ 0 ].method, 'fromEquirectangular' );
	assert.equal( state.generators[ 0 ].calls[ 0 ].source, environmentNodeSource );
	assert.equal( state.generators[ 1 ].calls[ 0 ].method, 'fromCubemap' );
	assert.equal( state.generators[ 1 ].calls[ 0 ].source, materialNodeSource );

} );

test( 'precompileAuxiliary captures same-layout PMREM source topologies in independent generators', async () => {

	const normalized = {
		...pmremSourceTexture( 'equirect', 64 ),
		format: 1023,
		type: 1009,
		colorSpace: '',
		minFilter: 1006,
		magFilter: 1006,
		wrapS: 1001,
		wrapT: 1001,
	};
	const integer = {
		...pmremSourceTexture( 'equirect', 64 ),
		format: 1029,
		type: 1014,
		colorSpace: '',
		minFilter: 1003,
		magFilter: 1003,
		wrapS: 1000,
		wrapT: 1000,
	};
	const scene = {
		background: normalized,
		environment: integer,
		traverse() {},
	};
	const { state } = await runPMREMDiscoveryCapture( scene );

	assert.equal( state.generators.length, 2, 'one cached Three source material must never span incompatible source topology' );
	assert.deepEqual(
		state.generators.map( ( generator ) => generator.calls.map( ( call ) => call.method ) ),
		[ [ 'fromEquirectangular' ], [ 'fromEquirectangular' ] ],
	);
	assert.deepEqual(
		new Set( state.generators.map( ( generator ) => generator.calls[ 0 ].source ) ),
		new Set( [ normalized, integer ] ),
	);

} );

test( 'precompileAuxiliary waits for the renderer compile queue before a cold PMREM source render', async () => {

	const fixture = pmremDiscoveryCaptureFixture();
	const source = pmremSourceTexture( 'equirect', 64 );
	const scene = {
		background: null,
		environment: null,
		environmentNode: {
			isNode: true,
			isPMREMNode: true,
			_value: source,
		},
		traverse() {},
	};
	let releasePriorCompile;
	let priorCompileActive = true;
	const priorCompile = new Promise( ( resolve ) => {

		releasePriorCompile = () => {

			priorCompileActive = false;
			resolve();

		};

	} );
	fixture.renderer.__tslpCompileLock = priorCompile;
	let acceptedDraws = 0;
	let droppedDraws = 0;
	fixture.renderer.render = () => {

		if ( priorCompileActive ) droppedDraws ++;
		else acceptedDraws ++;

	};
	const originalFromEquirectangular = fixture.three.PMREMGenerator.prototype.fromEquirectangular;
	fixture.three.PMREMGenerator.prototype.fromEquirectangular = function renderEquirectangularSource( texture ) {

		fixture.renderer.render();
		return originalFromEquirectangular.call( this, texture );

	};

	__resetAuxRegistryForTests();
	const capture = precompileAuxiliary( fixture.renderer, scene, {}, {
		devEndpoint: '/capture',
		threeVersion: '0.185.1',
		compileTSL: fixture.compileTSL,
		beginRenderObjectHarvest: fixture.beginHarvest,
		three: fixture.three,
	} );
	try {

		await Promise.resolve();
		await Promise.resolve();
		assert.equal( fixture.state.generators.length, 1 );
		assert.equal( fixture.state.generators[ 0 ].calls.length, 0, 'PMREM must not render while an earlier compiler transaction suppresses external draws' );
		assert.equal( acceptedDraws, 0 );
		assert.equal( droppedDraws, 0 );

		releasePriorCompile();
		await capture;
		assert.equal( acceptedDraws, 1 );
		assert.equal( droppedDraws, 0 );
		assert.deepEqual(
			fixture.state.generators[ 0 ].calls.map( ( call ) => call.method ),
			[ 'fromEquirectangular' ],
		);

	} finally {

		releasePriorCompile();
		await capture;
		__resetAuxRegistryForTests();

	}

} );

test( 'precompileAuxiliary lets a pending marker microtask publish its lock before a cold PMREM fromScene render', async () => {

	const fixture = pmremDiscoveryCaptureFixture();
	const scene = {
		background: null,
		environment: null,
		traverse() {},
	};
	let releaseMarkerCompile;
	let markerCompileActive = false;
	const markerCompile = new Promise( ( resolve ) => {

		releaseMarkerCompile = () => {

			markerCompileActive = false;
			resolve();

		};

	} );
	let acceptedDraws = 0;
	let droppedDraws = 0;
	fixture.renderer.render = () => {

		if ( markerCompileActive ) droppedDraws ++;
		else acceptedDraws ++;

	};
	const originalFromScene = fixture.three.PMREMGenerator.prototype.fromScene;
	fixture.three.PMREMGenerator.prototype.fromScene = function renderSceneSource( ...args ) {

		fixture.renderer.render();
		return originalFromScene.apply( this, args );

	};

	// Model the marker epoch that the application render already queued. The
	// PMREM capture starts in the same task, before that microtask publishes
	// the renderer queue tail.
	Promise.resolve().then( () => {

		markerCompileActive = true;
		fixture.renderer.__tslpCompileLock = markerCompile;

	} );

	__resetAuxRegistryForTests();
	const capture = precompileAuxiliary( fixture.renderer, scene, {}, {
		devEndpoint: '/capture',
		threeVersion: '0.185.1',
		compileTSL: fixture.compileTSL,
		beginRenderObjectHarvest: fixture.beginHarvest,
		three: fixture.three,
		pmremSceneSizes: [ 64 ],
	} );
	try {

		await Promise.resolve();
		await Promise.resolve();
		assert.equal( fixture.state.generators.length, 1 );
		assert.equal( fixture.state.generators[ 0 ].calls.length, 0, 'fromScene must wait for the marker microtask queue tail' );
		assert.equal( acceptedDraws, 0 );
		assert.equal( droppedDraws, 0, 'the PMREM draw must not be offered to the active marker suppression window' );

		releaseMarkerCompile();
		await capture;
		assert.equal( acceptedDraws, 1 );
		assert.equal( droppedDraws, 0 );
		assert.deepEqual(
			fixture.state.generators[ 0 ].calls.map( ( call ) => call.method ),
			[ 'fromScene' ],
		);

	} finally {

		releaseMarkerCompile();
		await capture;
		__resetAuxRegistryForTests();

	}

} );

test( 'precompileAuxiliary rejects root three PMREMGenerator before it can capture WebGL ShaderMaterial output', async () => {

	const scene = {
		background: pmremSourceTexture( 'equirect', 64 ),
		environment: null,
		traverse() {},
	};
	const rootThreeLike = {
		DataTexture: class {},
		OrthographicCamera: class {},
		PMREMGenerator: class {},
		Scene: class {},
	};
	const { state, results } = await runPMREMDiscoveryCapture( scene, { three: rootThreeLike } );
	const failure = results.find( ( result ) => result.shape === 'pmrem' );

	assert.equal( state.generators.length, 0, 'the WebGPU capture generator is never constructed through the incompatible namespace' );
	assert.match( failure.error, /must be the `three\/webgpu` namespace/ );

} );

test( 'precompileAuxiliary captures fromScene without fabricating a bridge texture', async () => {

	const scene = {
		background: null,
		environment: null,
		traverse() {},
	};
	const { state } = await runPMREMDiscoveryCapture( scene, { pmremSceneSizes: [ 64 ] } );

	assert.equal( state.generatedSources.length, 0 );
	assert.deepEqual(
		state.generators[ 0 ].calls.map( ( call ) => call.method ),
		[ 'fromScene' ],
	);
	assert.equal( scene.background, null );
	assert.equal( scene.environment, null );

} );

test( 'precompileAuxiliary restores renderer state and disposes PMREM setup after capture exceptions', async () => {

	const fixture = pmremDiscoveryCaptureFixture();
	fixture.renderer.autoClear = true;
	fixture.renderer.toneMapping = 17;
	fixture.renderer.xr = { enabled: true };
	const scene = {
		background: pmremSourceTexture( 'equirect', 64 ),
		environment: null,
		traverse() {},
	};
	fixture.three.PMREMGenerator.prototype.fromEquirectangular = function failAfterMutatingRenderer() {

		fixture.renderer.autoClear = false;
		fixture.renderer.toneMapping = 0;
		fixture.renderer.xr.enabled = false;
		throw new Error( 'injected PMREM render failure' );

	};
	__resetAuxRegistryForTests();
	const results = await precompileAuxiliary( fixture.renderer, scene, {}, {
		devEndpoint: '/capture',
		threeVersion: '0.185.1',
		compileTSL: fixture.compileTSL,
		beginRenderObjectHarvest: fixture.beginHarvest,
		three: fixture.three,
	} );
	__resetAuxRegistryForTests();

	assert.match( results.find( ( result ) => result.shape === 'pmrem' ).error, /injected PMREM render failure/ );
	assert.equal( fixture.renderer.autoClear, true );
	assert.equal( fixture.renderer.toneMapping, 17 );
	assert.equal( fixture.renderer.xr.enabled, true );
	assert.equal( fixture.state.generators.length, 1 );
	assert.equal( fixture.state.generators[ 0 ].disposed, true );

	const setupFailure = pmremDiscoveryCaptureFixture();
	__resetAuxRegistryForTests();
	const setupResults = await precompileAuxiliary( setupFailure.renderer, scene, {}, {
		devEndpoint: '/capture',
		threeVersion: '0.185.1',
		compileTSL: setupFailure.compileTSL,
		beginRenderObjectHarvest: () => {

			throw new Error( 'injected harvest setup failure' );

		},
		three: setupFailure.three,
	} );
	__resetAuxRegistryForTests();
	assert.match( setupResults.find( ( result ) => result.shape === 'pmrem' ).error, /injected harvest setup failure/ );
	assert.equal( setupFailure.state.generators.length, 1 );
	assert.equal( setupFailure.state.generators[ 0 ].disposed, true );

} );

function pmremLiveTestCanvas( width = 256, height = 256 ) {

	let context = null;
	return {
		width,
		height,
		clientWidth: width,
		clientHeight: height,
		style: {},
		getContext( kind ) {

			if ( kind !== 'webgpu' ) return null;
			if ( ! context ) context = createMockGPUCanvasContext();
			return context;

		},
		addEventListener() {},
		removeEventListener() {},
		getBoundingClientRect: () => ( { left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 } ),
	};

}

function pmremArtifactSelectors( artifact ) {

	return collectArtifactVariantCandidates( artifact )
		.flatMap( ( candidate ) => candidate.renderContextSelectors || [] )
		.map( ( selector ) => JSON.parse( selector ) );

}

function pmremSelectorDepthKinds( artifact ) {

	return [ ...new Set( pmremArtifactSelectors( artifact ).map( ( selector ) =>
		Object.hasOwn( selector.target, 'depth' ) ? String( selector.target.depth ) : 'omitted'
	) ) ].sort();

}

test( 'precompileAuxiliary captures a selector-complete internal-pass family for an explicit fromScene-only layout', async () => {

	installMockWebGPU();
	const webgpu = await import( 'three/webgpu' );
	const renderer = new webgpu.WebGPURenderer( {
		canvas: pmremLiveTestCanvas(),
		antialias: false,
	} );
	await renderer.init();
	const originalRender = renderer.render;
	let syntheticRendersObserved = 0;
	let applicationRendersDropped = 0;
	renderer.render = function guardedApplicationRender( ...args ) {

		if ( ( globalThis.__tslpSyntheticRenderActive | 0 ) > 0 ) {

			syntheticRendersObserved ++;
			return originalRender.apply( this, args );

		}
		applicationRendersDropped ++;
		return undefined;

	};
	renderer.render.__tslpCaptureGuard = true;
	const scene = new webgpu.Scene();
	const camera = new webgpu.PerspectiveCamera();
	const originalFetch = globalThis.fetch;
	const payloads = [];
	const familyTransactions = [];
	globalThis.fetch = async ( _endpoint, request ) => {

		const body = JSON.parse( request.body );
		if ( Array.isArray( body.members ) ) {

			familyTransactions.push( body );
			payloads.push( ...body.members );

		} else payloads.push( body );
		return { ok: true };

	};
	const compilePMREMOnly = ( activeRenderer, captureScene, captureCamera, options = {} ) => {

		if ( ! options.renderObjectHarvest ) throw new Error( 'fixture skips the unrelated renderer-output capture' );
		return compileRealTSL( activeRenderer, captureScene, captureCamera, options );

	};
	__resetAuxRegistryForTests();
	try {

		const results = await precompileAuxiliary( renderer, scene, camera, {
			devEndpoint: '/capture',
			threeVersion: '0.185.1',
			compileTSL: compilePMREMOnly,
			beginRenderObjectHarvest,
			three: webgpu,
			pmremSceneSizes: [ 64 ],
		} );
		const pmremResults = results.filter( ( result ) => result.shape.startsWith( 'pmrem-' ) );
		assert.equal( familyTransactions.length, 1 );
		assert.equal( familyTransactions[ 0 ].auxiliaryFamily, 'pmrem' );
		assert.deepEqual(
			pmremResults.map( ( result ) => [ result.shape, result.ok ] ).sort(),
			[
				[ 'pmrem-blur', true ],
				[ 'pmrem-ggx', true ],
			],
			JSON.stringify( results ),
		);
		const byShape = new Map(
			payloads
				.filter( ( payload ) => typeof payload.materialShape === 'string' && payload.materialShape.startsWith( 'pmrem-' ) )
				.map( ( payload ) => [ payload.materialShape, payload ] ),
		);
		assert.deepEqual( [ ...byShape.keys() ].sort(), [ 'pmrem-blur', 'pmrem-ggx' ] );
		assert.equal( new Set( [ ...byShape.values() ].map( ( payload ) => payload.configHash ) ).size, 1 );
		const expectedPMREMHash = hashPlainConfigSync(
			byShape.get( 'pmrem-ggx' ).artifact.internalPass.config,
			{
				shape: 'pmrem',
				threeVersion: '0.185.1',
				pluginVersion: '0.1.0',
			},
		);
		assert.equal( byShape.get( 'pmrem-blur' ).configHash, expectedPMREMHash );

		for ( const subKind of [ 'blur', 'ggx' ] ) {

			const artifact = byShape.get( `pmrem-${ subKind }` ).artifact;
			assert.equal( assertInternalPassArtifact( artifact ), artifact.internalPass );
			assert.deepEqual( artifact.replayConfig, {
				schema: 'pmrem-layout@1',
				cubeSize: 64,
				lodMax: 6,
				target: { width: 336, height: 256 },
			} );
			assert.deepEqual( artifact.internalPass.config, {
				schema: 'pmrem-support@1',
				profile: 'scene',
				layout: artifact.replayConfig,
			} );
			assert.equal( Object.hasOwn( artifact.internalPass.config, 'source' ), false );
			for ( const candidate of collectArtifactVariantCandidates( artifact ) ) {

				assert.deepEqual( candidate.internalPass, artifact.internalPass, `${ subKind}: every selector member uses the family descriptor` );

			}

		}

		for ( const subKind of [ 'blur', 'ggx' ] ) {

			const artifact = byShape.get( `pmrem-${ subKind }` ).artifact;
			for ( const candidate of collectArtifactVariantCandidates( artifact ) ) {

				for ( const selector of candidate.renderContextSelectors || [] ) {

					assert.equal(
						Object.hasOwn( JSON.parse( selector ).target, 'depth' ),
						true,
						`${ subKind}: root and variant selectors must not retain the harvested omitted-depth state`,
					);

				}

			}
			assert.deepEqual(
				pmremSelectorDepthKinds( artifact ),
				[ 'false', 'true' ],
				`${ subKind}: ping-pong and depth-owning fromScene selectors must survive serialization`,
			);
			const noDepthSelector = pmremArtifactSelectors( artifact ).find( ( selector ) => selector.target.depth === false );
			assert.equal(
				noDepthSelector.target.depthTexture,
				null,
				`${ subKind}: normalized ping-pong selectors retain explicit no-depth-texture evidence`,
			);
			const depthSelector = pmremArtifactSelectors( artifact ).find( ( selector ) => selector.target.depth === true );
			assert.deepEqual( depthSelector.target.depthTexture, {
				kind: 'depth',
				format: webgpu.DepthFormat,
				internalFormat: null,
				dataType: webgpu.UnsignedIntType,
				colorSpace: '',
			} );

		}
		assert.ok(
			syntheticRendersObserved > 0,
			'the isolated PMREM draw family remains observable through an active material-capture guard',
		);
		assert.equal( applicationRendersDropped, 0, 'no isolated PMREM draw is mistaken for an application frame' );
		assert.equal( globalThis.__tslpSyntheticRenderActive | 0, 0, 'the nested render capability returns to baseline' );

		const blur = byShape.get( 'pmrem-blur' ).artifact;
		const weightsDescriptor = blur.internalPass.inputs.find( ( input ) => input.role === 'weights' );
		const weightsNames = new Set();
		for ( const candidate of collectArtifactVariantCandidates( blur ) ) {

			const objectPlan = candidate.uniformPlan.find( ( group ) => group.name === 'object' );
			const weights = objectPlan.orderedBindings.filter( ( binding ) => binding.type === 'buffer-uniform' );
			assert.equal( weights.length, 1 );
			weightsNames.add( weights[ 0 ].ref.name );

		}
		assert.deepEqual( [ ...weightsNames ], [ weightsDescriptor.binding ], 'weights metadata is canonical across the selector family' );

	} finally {

		__resetAuxRegistryForTests();
		globalThis.fetch = originalFetch;
		renderer.render = originalRender;
		renderer.setRenderTarget( null );
		renderer.dispose();

	}

} );

test( 'PMREM auxiliary-family HTTP failures retain profile and configHash in capture diagnostics', async () => {

	installMockWebGPU();
	const webgpu = await import( 'three/webgpu' );
	const renderer = new webgpu.WebGPURenderer( {
		canvas: pmremLiveTestCanvas(),
		antialias: false,
	} );
	await renderer.init();
	const scene = new webgpu.Scene();
	const camera = new webgpu.PerspectiveCamera();
	const originalFetch = globalThis.fetch;
	const familyPayloads = [];
	globalThis.fetch = async ( _endpoint, request ) => {

		const body = JSON.parse( request.body );
		if ( Array.isArray( body.members ) ) familyPayloads.push( body );
		return {
			ok: false,
			status: 503,
			text: async () => 'injected PMREM family rejection',
		};

	};
	const compilePMREMOnly = ( activeRenderer, captureScene, captureCamera, options = {} ) => {

		if ( ! options.renderObjectHarvest ) throw new Error( 'fixture skips the unrelated renderer-output capture' );
		return compileRealTSL( activeRenderer, captureScene, captureCamera, options );

	};
	const baseline = getDevCaptureStatus();
	__resetAuxRegistryForTests();
	try {

		const results = await precompileAuxiliary( renderer, scene, camera, {
			devEndpoint: '/capture',
			threeVersion: '0.185.1',
			compileTSL: compilePMREMOnly,
			beginRenderObjectHarvest,
			three: webgpu,
			pmremSceneSizes: [ 64 ],
		} );
		assert.equal( familyPayloads.length, 1 );
		const expectedConfigHash = familyPayloads[ 0 ].members[ 0 ].configHash;
		assert.match( expectedConfigHash, /^[a-f0-9]{64}$/ );

		const pmremResults = results
			.filter( ( result ) => result.shape.startsWith( 'pmrem-' ) )
			.sort( ( a, b ) => a.shape.localeCompare( b.shape ) );
		assert.deepEqual(
			pmremResults.map( ( result ) => ( {
				shape: result.shape,
				ok: result.ok,
				profile: result.profile,
				configHash: result.configHash,
			} ) ),
			[
				{ shape: 'pmrem-blur', ok: false, profile: 'scene', configHash: expectedConfigHash },
				{ shape: 'pmrem-ggx', ok: false, profile: 'scene', configHash: expectedConfigHash },
			],
		);

		const capturedFailures = getDevCaptureStatus().failures
			.filter( ( failure ) => failure.error.includes( 'injected PMREM family rejection' ) )
			.sort( ( a, b ) => a.shape.localeCompare( b.shape ) );
		assert.deepEqual(
			capturedFailures.map( ( failure ) => ( {
				shape: failure.shape,
				error: failure.error,
				profile: failure.profile,
				configHash: failure.configHash,
			} ) ),
			[
				{
					shape: 'pmrem-blur',
					error: '503 injected PMREM family rejection',
					profile: 'scene',
					configHash: expectedConfigHash,
				},
				{
					shape: 'pmrem-ggx',
					error: '503 injected PMREM family rejection',
					profile: 'scene',
					configHash: expectedConfigHash,
				},
			],
		);
		assert.equal( getDevCaptureStatus().failedCaptures - baseline.failedCaptures, 3 );

	} finally {

		__resetAuxRegistryForTests();
		globalThis.fetch = originalFetch;
		renderer.setRenderTarget( null );
		renderer.dispose();

	}

} );
