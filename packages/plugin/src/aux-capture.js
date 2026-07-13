/**
 * Auxiliary-pass capture — extract artifacts for the materials three.js's
 * renderer creates internally (Background, PMREM, PostProcessing,
 * CubeRenderTarget, Lighting) so Phase-7+ builds can rewrite those
 * construction sites to load precompiled artifacts instead of running the
 * node builder.
 *
 * Shape contract, common to every aux capture function:
 *
 *   - Accept a `factory` that returns the **input config** (a TSL node or a
 *     small plain-object config).
 *   - Hash that input via `computeNodeGraphHash(input, { shape, ... })` —
 *     the SAME hash the runtime will compute on its live equivalent input
 *     at render time, so the manifest lookup key matches.
 *   - Prime the pipeline, locate the aux material, extract the artifact
 *     via `compileTSL`, stamp `materialShape` + `__configHash` on it.
 *
 * Supported shapes today:
 *
 *   - `background`       → `extractBackgroundArtifact`
 *   - `post-process`     → `extractPostProcessingArtifact`
 *   - `cube-render-target` → `extractCubeRenderTargetArtifact`
 *   - `pmrem`            → `extractPMREMArtifact`
 *   - `lights`           → `extractLightingArtifact`
 *
 * @module AuxCapture
 */

import { installMockWebGPU, createMockGPUCanvasContext } from './mock-webgpu.js';
import { computeArtifactContentHash, computeNodeGraphHash, computePlainConfigHash } from './hash.js';
import { normalizeRevision } from './_shared/normalize-revision.js';
import { compileTSL } from './vendor/compileTSL.js';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { createRenderPipelineConfig } from '@tsl-precompile/contract/output-config';
import {
	assertCubeRenderTargetTextureEvidence,
	createCubeRenderTargetAuxConfig,
} from '@tsl-precompile/contract/cube-render-target';

let initialised = false;

function ensureGlobals() {

	if ( initialised ) return;
	installMockWebGPU();
	initialised = true;

}

async function importThree() {

	ensureGlobals();
	const webgpu = await import( 'three/webgpu' );
	const core = await import( 'three' );
	const tsl = await import( 'three/tsl' );
	return { webgpu, core, tsl };

}

function threeVersion( core, opts ) {

	return opts.threeVersion || normalizeRevision( core.REVISION );

}

function cubeRenderTargetThreeVersion( core, opts ) {

	if ( opts.threeVersion ) return opts.threeVersion;
	return `0.${ normalizeRevision( core.REVISION ) }.0`;

}

function pluginVersion( opts ) {

	return opts.pluginVersion || ARTIFACT_TOOLCHAIN_VERSION;

}

/**
 * @param {string} shape
 * @param {Object} input
 * @param {Object} core
 * @param {Object} opts
 * @return {string}
 */
function hashInput( shape, input, core, opts ) {

	return computeNodeGraphHash( input, {
		shape,
		threeVersion: threeVersion( core, opts ),
		pluginVersion: pluginVersion( opts ),
	} );

}

function stamp( artifact, shape, configHash, name, core, opts ) {

	artifact.materialShape = shape;
	artifact.__name = name;
	artifact.__configHash = configHash;
	// Artifact's own content-hash too — used by the existing 3-layer staleness gates.
	artifact.__hash = computeArtifactContentHash( artifact, {
		shape,
		threeVersion: threeVersion( core, opts ),
		pluginVersion: pluginVersion( opts ),
	} );
	return artifact;

}

function makeRenderer( webgpu ) {

	const renderer = new webgpu.WebGPURenderer( {
		canvas: makeFakeCanvas(),
		antialias: false,
	} );
	return renderer;

}

// -------------------------------------------------------------------------
// Background
// -------------------------------------------------------------------------

/**
 * Extract an artifact for `scene.backgroundNode`.
 *
 * @param {({webgpu, core, tsl}) => ({ backgroundNode: Object, name?: string })} factory
 * @param {Object} [opts]
 * @return {Promise<{ artifact, configHash, materialShape: 'background', hash: string }>}
 */
export async function extractBackgroundArtifact( factory, opts = {} ) {

	const { webgpu, core, tsl } = await importThree();
	const renderer = makeRenderer( webgpu );
	await renderer.init();

	const { backgroundNode, name = 'background-aux' } = await factory( { webgpu, core, tsl } );
	if ( ! backgroundNode ) throw new Error( 'extractBackgroundArtifact: factory must return { backgroundNode: <TSL node> }' );

	const configHash = hashInput( 'background', backgroundNode, core, opts );

	const scene = new core.Scene();
	scene.backgroundNode = backgroundNode;
	const camera = new core.PerspectiveCamera( 45, 1, 0.1, 100 );
	camera.position.set( 0, 0, 3 );

	const artifacts = await compileTSL( renderer, scene, camera );
	const bgArtifact = locateBackgroundArtifact( artifacts, renderer, scene );
	if ( ! bgArtifact ) {

		throw new Error( `extractBackgroundArtifact: could not locate Background material among ${ artifacts.length } artifact(s).` );

	}

	stamp( bgArtifact, 'background', configHash, name, core, opts );
	if ( typeof renderer.dispose === 'function' ) renderer.dispose();
	return { artifact: bgArtifact, configHash, materialShape: 'background', hash: bgArtifact.__hash };

}

function locateBackgroundArtifact( artifacts, renderer, scene ) {

	for ( const a of artifacts ) {

		if ( a.materialShape === 'background' ) return a;
		if ( a.materialName === 'Background.material' ) return a;
		if ( a.name === 'Background.material' ) return a;

	}
	const bgComp = renderer._background;
	const sceneData = bgComp && typeof bgComp.get === 'function' ? bgComp.get( scene ) : null;
	const mesh = sceneData && sceneData.backgroundMesh;
	if ( ! mesh || ! mesh.material ) return null;
	for ( const a of artifacts ) {

		if ( a.materialUuid === mesh.material.uuid ) return a;

	}
	return null;

}

// -------------------------------------------------------------------------
// PostProcessing (outputNode)
// -------------------------------------------------------------------------

/**
 * Extract an artifact for a PostProcessing pipeline's `outputNode`.
 *
 * @param {({webgpu, core, tsl}) => ({ outputNode: Object, name?: string })} factory
 * @param {Object} [opts]
 * @return {Promise<{ artifact, configHash, materialShape: 'post-process', hash: string }>}
 */
export async function extractPostProcessingArtifact( factory, opts = {} ) {

	const { webgpu, core, tsl } = await importThree();
	const renderer = makeRenderer( webgpu );
	await renderer.init();

	const {
		outputNode,
		name = 'post-process-aux',
		outputColorTransform = true,
		toneMapping,
		outputColorSpace,
	} = await factory( { webgpu, core, tsl } );
	if ( ! outputNode ) throw new Error( 'extractPostProcessingArtifact: factory must return { outputNode: <TSL node> }' );
	if ( toneMapping !== undefined ) renderer.toneMapping = toneMapping;
	if ( outputColorSpace !== undefined ) renderer.outputColorSpace = outputColorSpace;

	// Drive Three's real renderer-level pipeline. Its internal fragmentNode
	// includes context and optional output transform semantics that a throwaway
	// NodeMaterial.colorNode cannot reproduce.
	const scene = new core.Scene();
	const camera = new core.PerspectiveCamera( 45, 1, 0.1, 100 );
	camera.position.set( 0, 0, 3 );

	const PP = webgpu.RenderPipeline || webgpu.PostProcessing;
	if ( ! PP ) throw new Error( 'extractPostProcessingArtifact: three/webgpu does not export RenderPipeline/PostProcessing' );
	const pp = new PP( renderer );
	pp.outputNode = outputNode;
	pp.outputColorTransform = outputColorTransform === true;
	const replayConfig = createRenderPipelineConfig( pp );
	const configHash = hashInput( 'post-process', replayConfig, core, opts );

	// `compileAsync(scene)` alone cannot build the final full-screen pass;
	// compileTSL's renderPipeline option drives pp.render() and records it.
	const preArtifacts = await compileTSL( renderer, scene, camera, { renderPipeline: pp, noGlobalMRT: true } );
	const pipelineMaterial = pp._quadMesh && pp._quadMesh.material;
	const artifact = preArtifacts.find( ( a ) => pipelineMaterial && a.materialUuid === pipelineMaterial.uuid )
		|| preArtifacts.find( ( a ) => a.materialShape === 'render-pipeline' );

	if ( ! artifact ) {

		throw new Error( 'extractPostProcessingArtifact: could not extract an artifact for the outputNode' );

	}

	artifact.materialShape = 'post-process';
	artifact.replayConfig = {
		schema: replayConfig.schema,
		outputColorTransform: replayConfig.outputColorTransform,
		toneMapping: replayConfig.toneMapping,
		outputColorSpace: replayConfig.outputColorSpace,
	};
	stamp( artifact, 'post-process', configHash, name, core, opts );
	if ( typeof renderer.dispose === 'function' ) renderer.dispose();
	return { artifact, configHash, materialShape: 'post-process', hash: artifact.__hash };

}

// -------------------------------------------------------------------------
// CubeRenderTarget.fromEquirectangularTexture
// -------------------------------------------------------------------------

/**
 * Extract Three r184's fixed equirectangular-to-cube blit material.
 *
 * The material graph deliberately matches CubeRenderTarget.js rather than
 * hashing only its equirect UV helper. The source texture remains a live
 * binding, while replayConfig signs the complete 2D texture/binding topology
 * shared with the rewritten runtime call site.
 *
 * @param {({webgpu, core, tsl}) => ({ sourceTexture: Object, targetOptions?: Object, name?: string })} factory
 * @param {Object} [opts]
 * @return {Promise<{ artifact, configHash, materialShape: 'cube-render-target', hash: string }>}
 */
export async function extractCubeRenderTargetArtifact( factory, opts = {} ) {

	const { webgpu, core, tsl } = await importThree();
	const renderer = makeRenderer( webgpu );
	let geometry = null;
	let material = null;
	let cubeTarget = null;
	let sourceTexture = null;
	let sourceState = null;

	try {

		await renderer.init();
		const input = await factory( { webgpu, core, tsl } );
		sourceTexture = input && input.sourceTexture;
		const name = input && input.name || 'cube-render-target-aux';
		if ( ! sourceTexture ) {

			throw new Error( 'extractCubeRenderTargetArtifact: factory must return { sourceTexture: <2D Texture> }' );

		}

		const targetOptions = input && input.targetOptions;
		if ( targetOptions !== undefined && targetOptions !== null && ( typeof targetOptions !== 'object' || Array.isArray( targetOptions ) ) ) {

			throw new TypeError( 'extractCubeRenderTargetArtifact: targetOptions must be a plain options object' );

		}

		// Mirror CubeRenderTarget.fromEquirectangularTexture() exactly. The
		// destination inherits source output topology before the source's pole
		// filter is temporarily narrowed for the six cube draws.
		cubeTarget = new webgpu.CubeRenderTarget( 1, cloneCubeTargetOptions( targetOptions, 'extractCubeRenderTargetArtifact' ) );
		cubeTarget.texture.type = sourceTexture.type;
		cubeTarget.texture.colorSpace = sourceTexture.colorSpace;
		cubeTarget.texture.generateMipmaps = true;
		cubeTarget.texture.minFilter = sourceTexture.minFilter;
		cubeTarget.texture.magFilter = sourceTexture.magFilter;

		const replayConfig = createCubeRenderTargetAuxConfig( sourceTexture, cubeTarget );
		const captureOpts = {
			...opts,
			threeVersion: cubeRenderTargetThreeVersion( core, opts ),
		};
		const configHash = computePlainConfigHash( replayConfig, {
			shape: 'cube-render-target',
			threeVersion: captureOpts.threeVersion,
			pluginVersion: pluginVersion( captureOpts ),
		} );

		sourceState = {
			generateMipmaps: sourceTexture.generateMipmaps,
			minFilter: sourceTexture.minFilter,
		};
		sourceTexture.generateMipmaps = true;
		if ( sourceTexture.minFilter === core.LinearMipmapLinearFilter ) sourceTexture.minFilter = core.LinearFilter;

		const uvNode = tsl.equirectUV( tsl.positionWorldDirection );
		material = new webgpu.NodeMaterial();
		material.name = 'CubeRenderTarget.equirectangular';
		material.colorNode = tsl.texture( sourceTexture, uvNode, 0 );
		material.side = core.BackSide;
		material.blending = core.NoBlending;

		geometry = new core.BoxGeometry( 5, 5, 5 );
		const mesh = new core.Mesh( geometry, material );
		const scene = new core.Scene();
		scene.add( mesh );
		const cubeCamera = new core.CubeCamera( 1, 10, cubeTarget );
		if (
			renderer.coordinateSystem !== undefined &&
			cubeCamera.coordinateSystem !== renderer.coordinateSystem &&
			typeof cubeCamera.updateCoordinateSystem === 'function'
		) {

			cubeCamera.coordinateSystem = renderer.coordinateSystem;
			cubeCamera.updateCoordinateSystem();

		}
		const camera = cubeCamera.children && cubeCamera.children[ 0 ];
		if ( ! camera || camera.isPerspectiveCamera !== true ) {

			throw new Error( 'extractCubeRenderTargetArtifact: CubeCamera did not expose its perspective face cameras' );

		}

		const artifacts = await compileTSL( renderer, scene, camera, {
			renderTargetOverride: cubeTarget,
			noGlobalMRT: true,
		} );
		const artifact = artifacts.byMaterialUuid && artifacts.byMaterialUuid.get( material.uuid )
			|| artifacts.find( ( candidate ) => candidate.materialUuid === material.uuid );
		if ( ! artifact ) {

			throw new Error( `extractCubeRenderTargetArtifact: could not locate the conversion material among ${ artifacts.length } artifact(s)` );

		}

		wireExactSourceTextureEvidence( artifact, sourceTexture );
		artifact.replayConfig = replayConfig;
		stamp( artifact, 'cube-render-target', configHash, name, core, captureOpts );
		return { artifact, configHash, materialShape: 'cube-render-target', hash: artifact.__hash };

	} finally {

		if ( sourceTexture && sourceState ) {

			try { sourceTexture.minFilter = sourceState.minFilter; } catch ( _ ) {}
			try { sourceTexture.generateMipmaps = sourceState.generateMipmaps; } catch ( _ ) {}

		}
		disposeSafely( geometry );
		disposeSafely( material );
		disposeSafely( cubeTarget );
		disposeSafely( renderer );

	}

}

// -------------------------------------------------------------------------
// PMREM
// -------------------------------------------------------------------------

// PMREMGenerator builds 4 internal NodeMaterials. The cubemap and equirect
// blit shaders are kind-specific only; blur and ggx depend on lodMax derived
// from the source texture size. We capture all 4 keyed by sub-shape under a
// single configHash that covers (kind, source dims) — that's the partition
// the runtime needs at PMREMGenerator construction time.
const PMREM_SUB_SHAPES = [ 'cubemap', 'equirect', 'blur', 'ggx' ];

function pmremSubShape( subKind ) {

	return `pmrem-${ subKind }`;

}

/**
 * Extract artifacts for PMREMGenerator's 4 internal materials
 * (PMREM_cubemap, PMREM_equirect, PMREM_blur, PMREM_ggx).
 *
 * The slim renderer cannot run PMREM's blur passes natively because its
 * rewritten Nodes.js:getForRender throws on non-precompiled materials.
 * Capturing these 4 internal materials as standard precompiled artifacts
 * lets the slim renderer drive PMREM through the normal precompiled-material
 * path — no dual-renderer fallback needed.
 *
 * @param {({webgpu, core, tsl}) => ({ sourceTexture: Object, kind: 'equirect' | 'cube', name?: string })} factory
 * @param {Object} [opts]
 * @return {Promise<{ artifact, artifacts: Object, configHash, materialShape: 'pmrem', hash: string }>}
 *   `artifacts` is a dict keyed by sub-shape ('cubemap'|'equirect'|'blur'|'ggx').
 *   `artifact` is the primary one matching `kind` (kept for back-compat with
 *   the existing test fixture).
 */
export async function extractPMREMArtifact( factory, opts = {} ) {

	const { webgpu, core, tsl } = await importThree();
	const renderer = makeRenderer( webgpu );
	await renderer.init();

	const { sourceTexture, kind = 'equirect', name = 'pmrem-aux' } = await factory( { webgpu, core, tsl } );
	if ( ! sourceTexture ) throw new Error( 'extractPMREMArtifact: factory must return { sourceTexture }' );

	// The config-hash covers (kind, texture-shape). Texture identity (uuid)
	// is NOT part of the hash — different textures of the same shape produce
	// the same PMREM material graph, only the sampled values differ. The
	// runtime computes the SAME hash from the live source texture passed to
	// PMREMGenerator.fromX(), so the registry lookup matches.
	const configInput = {
		kind,
		width: sourceTexture.image ? sourceTexture.image.width | 0 : 0,
		height: sourceTexture.image ? sourceTexture.image.height | 0 : 0,
		format: sourceTexture.format || 'unknown',
		type: sourceTexture.type || 'unknown',
	};
	const configHash = computePlainConfigHash( configInput, {
		shape: 'pmrem',
		threeVersion: threeVersion( core, opts ),
		pluginVersion: pluginVersion( opts ),
	} );

	const PMREM = webgpu.PMREMGenerator;
	if ( ! PMREM ) throw new Error( 'extractPMREMArtifact: three/webgpu does not export PMREMGenerator' );

	const pmrem = new PMREM( renderer );

	// 1. Materialise the cubemap and equirect blit shaders. These are
	//    compile-only (no render) — three.js exposes them precisely as
	//    pre-warmup helpers, populating pmrem._cubemapMaterial /
	//    pmrem._equirectMaterial without running fromX().
	await pmrem.compileCubemapShader();
	await pmrem.compileEquirectangularShader();

	// 2. Materialise blur + ggx by manually invoking _setSizeFromTexture
	//    + _init. _init builds _blurMaterial and _ggxMaterial sized for
	//    the source. We avoid fromX() because that also runs render passes
	//    we don't need (we only want compiled artifacts, not pixels).
	pmrem._setSizeFromTexture( sourceTexture );
	const cubeUVRenderTarget = pmrem._allocateTarget();
	pmrem._init( cubeUVRenderTarget );

	const materials = {
		cubemap: pmrem._cubemapMaterial,
		equirect: pmrem._equirectMaterial,
		blur: pmrem._blurMaterial,
		ggx: pmrem._ggxMaterial,
	};

	// 3. Build a throwaway scene with one mesh per material. compileTSL
	//    walks the renderer's NodeBuilder cache and returns one artifact
	//    per compiled material, keyed by materialUuid.
	const scene = new core.Scene();
	const camera = new core.PerspectiveCamera( 45, 1, 0.1, 100 );
	camera.position.set( 0, 0, 3 );

	const meshUuids = {};
	for ( const subKind of PMREM_SUB_SHAPES ) {

		const mat = materials[ subKind ];
		if ( ! mat ) continue;
		const geom = new core.PlaneGeometry( 1, 1 );
		const mesh = new core.Mesh( geom, mat );
		scene.add( mesh );
		meshUuids[ subKind ] = mat.uuid;

	}

	const allArtifacts = await compileTSL( renderer, scene, camera );

	const artifacts = {};
	for ( const subKind of PMREM_SUB_SHAPES ) {

		const uuid = meshUuids[ subKind ];
		if ( ! uuid ) continue;
		const found = allArtifacts.find( ( a ) => a.materialUuid === uuid );
		if ( ! found ) continue;
		found.pmremKind = subKind;
		stamp( found, pmremSubShape( subKind ), configHash, `${ name }-${ subKind }`, core, opts );
		artifacts[ subKind ] = found;

	}

	if ( Object.keys( artifacts ).length === 0 ) {

		throw new Error( `extractPMREMArtifact: produced 0 artifacts (compileTSL returned ${ allArtifacts.length }, none matched PMREM material UUIDs)` );

	}

	// Back-compat: return the artifact matching the input `kind` as
	// `result.artifact` so the existing test fixture (which checks
	// `r.artifact.pmremKind === 'equirect'`) keeps working.
	const primaryKey = kind === 'cube' ? 'cubemap' : 'equirect';
	const primary = artifacts[ primaryKey ] || Object.values( artifacts )[ 0 ];

	pmrem.dispose();
	if ( typeof renderer.dispose === 'function' ) renderer.dispose();
	return { artifact: primary, artifacts, configHash, materialShape: 'pmrem', hash: primary.__hash };

}

// -------------------------------------------------------------------------
// Lighting
// -------------------------------------------------------------------------

/**
 * Extract an artifact for a scene's Lighting node — the graph LightsNode
 * builds based on a scene's light-set signature.
 *
 * Config-hash: ordered signature of light types + shadow flags. Two scenes
 * with the same light taxonomy share the same lights graph.
 *
 * @param {({webgpu, core, tsl}) => ({ lights: Array<Object>, name?: string })} factory
 * @param {Object} [opts]
 * @return {Promise<{ artifact, configHash, materialShape: 'lights', hash: string }>}
 */
export async function extractLightingArtifact( factory, opts = {} ) {

	const { webgpu, core, tsl } = await importThree();
	const renderer = makeRenderer( webgpu );
	await renderer.init();

	const { lights = [], name = 'lights-aux' } = await factory( { webgpu, core, tsl } );

	const signature = lights
		.map( ( l ) => `${ l.type || l.constructor && l.constructor.name || 'Light' }:${ l.castShadow ? 'shadow' : '' }` )
		.sort();
	const configInput = { signature };
	const configHash = computePlainConfigHash( configInput, {
		shape: 'lights',
		threeVersion: threeVersion( core, opts ),
		pluginVersion: pluginVersion( opts ),
	} );

	const scene = new core.Scene();
	const mat = new webgpu.MeshStandardNodeMaterial();
	const mesh = new core.Mesh( new core.BoxGeometry( 1, 1, 1 ), mat );
	scene.add( mesh );
	for ( const l of lights ) scene.add( l );

	const camera = new core.PerspectiveCamera( 45, 1, 0.1, 100 );
	camera.position.set( 0, 0, 3 );

	const artifacts = await compileTSL( renderer, scene, camera );
	// Lighting is embedded in the standard material artifact's uniformPlan.
	// The signature hash is the key; we stamp the whole-material artifact
	// with materialShape='lights' and let the runtime know this is the
	// lights-variant artifact for this signature.
	const artifact = artifacts.find( ( a ) => a.materialUuid === mat.uuid ) || artifacts[ 0 ];
	if ( ! artifact ) throw new Error( 'extractLightingArtifact: no artifacts produced' );

	stamp( artifact, 'lights', configHash, name, core, opts );
	if ( typeof renderer.dispose === 'function' ) renderer.dispose();
	return { artifact, configHash, materialShape: 'lights', hash: artifact.__hash };

}

// -------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------

function wireExactSourceTextureEvidence( artifact, texture ) {

	const uuid = texture && texture.uuid;
	assertCubeRenderTargetTextureEvidence( artifact, texture, 'extractCubeRenderTargetArtifact' );

	const refs = artifact._textureRefs instanceof Map ? artifact._textureRefs : new Map();
	const existing = refs.get( uuid );
	if ( existing && existing !== texture ) {

		throw new Error( 'extractCubeRenderTargetArtifact: captured source texture identity is ambiguous' );

	}
	refs.set( uuid, texture );
	if ( artifact._textureRefs !== refs ) {

		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );

	}

}

function disposeSafely( resource ) {

	if ( ! resource || typeof resource.dispose !== 'function' ) return;
	try { resource.dispose(); } catch ( _ ) {}

}

function cloneCubeTargetOptions( options, owner ) {

	if ( ! options ) return {};
	const cloned = { ...options };
	if ( options.depthTexture != null ) {

		if ( typeof options.depthTexture.clone !== 'function' ) {

			throw new TypeError( `${ owner }: targetOptions.depthTexture must expose clone()` );

		}
		cloned.depthTexture = options.depthTexture.clone();

	}
	return cloned;

}

function makeFakeCanvas( width = 256, height = 256 ) {

	let gpuContext = null;
	return {
		width, height, clientWidth: width, clientHeight: height,
		style: {},
		getContext: ( kind ) => {

			if ( kind === 'webgpu' ) {

				if ( ! gpuContext ) gpuContext = createMockGPUCanvasContext();
				return gpuContext;

			}
			return null;

		},
		addEventListener: () => {},
		removeEventListener: () => {},
		getBoundingClientRect: () => ( { left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 } ),
	};

}
