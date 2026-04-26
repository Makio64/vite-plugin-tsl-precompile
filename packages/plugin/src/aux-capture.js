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
 *   - `pmrem`            → `extractPMREMArtifact`
 *   - `lights`           → `extractLightingArtifact`
 *
 * @module AuxCapture
 */

import { installMockWebGPU, createMockGPUCanvasContext } from './mock-webgpu.js';
import { computeArtifactContentHash, computeNodeGraphHash, computePlainConfigHash } from './hash.js';
import { compileTSL } from './vendor/compileTSL.js';

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

	return opts.threeVersion || ( 'REVISION' in core ? String( core.REVISION ) : 'unknown' );

}

function pluginVersion( opts ) {

	return opts.pluginVersion || '0.0.0';

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

	const { outputNode, name = 'post-process-aux' } = await factory( { webgpu, core, tsl } );
	if ( ! outputNode ) throw new Error( 'extractPostProcessingArtifact: factory must return { outputNode: <TSL node> }' );

	const configHash = hashInput( 'post-process', outputNode, core, opts );

	// Drive the PostProcessing path: three.js exposes PostProcessing as
	// a renderer-level class. It builds an internal fullscreen NodeMaterial
	// whose colorNode is the `outputNode`. compileTSL walks it via the scene
	// render pass.
	const scene = new core.Scene();
	const camera = new core.PerspectiveCamera( 45, 1, 0.1, 100 );
	camera.position.set( 0, 0, 3 );

	const PP = webgpu.PostProcessing;
	if ( ! PP ) throw new Error( 'extractPostProcessingArtifact: three/webgpu does not export PostProcessing' );
	const pp = new PP( renderer );
	pp.outputNode = outputNode;

	// `compileTSL` runs `renderer.compileAsync` internally, which walks the
	// render list. For post-process, compileAsync of the scene isn't enough —
	// we have to explicitly compile the pp pass via `pp.render()`-adjacent
	// machinery. Easiest: compileTSL returns whatever artifacts flowed; the
	// post-process material will be the one whose vertexNode equals the
	// fullscreen-quad transform AND colorNode references the outputNode.
	// If none matches, we fall back to a direct compileAsync.
	const preArtifacts = await compileTSL( renderer, scene, camera );
	let artifact = null;
	for ( const a of preArtifacts ) {

		if ( a.materialName === 'PostProcessing.material' || a.name === 'PostProcessing.material' ) { artifact = a; break; }
		if ( a.materialShape === 'post-process' || a.materialShape === 'output-transform' ) { artifact = a; break; }

	}

	if ( ! artifact ) {

		// Direct path: build a tiny scene with a QuadMesh carrying the
		// outputNode. compileTSL will extract it as a regular material.
		const { QuadMesh } = webgpu;
		const mat = new webgpu.NodeMaterial();
		mat.name = 'PostProcessing.material';
		mat.vertexNode = null;   // default fullscreen
		mat.colorNode = outputNode;
		const quad = new QuadMesh ? new QuadMesh( mat ) : null;
		if ( quad ) {

			const ppScene = new core.Scene();
			ppScene.add( quad );
			const ppArtifacts = await compileTSL( renderer, ppScene, camera );
			artifact = ppArtifacts.find( ( a ) => a.materialUuid === mat.uuid ) || ppArtifacts[ 0 ];

		}

	}

	if ( ! artifact ) {

		throw new Error( 'extractPostProcessingArtifact: could not extract an artifact for the outputNode' );

	}

	stamp( artifact, 'post-process', configHash, name, core, opts );
	if ( typeof renderer.dispose === 'function' ) renderer.dispose();
	return { artifact, configHash, materialShape: 'post-process', hash: artifact.__hash };

}

// -------------------------------------------------------------------------
// PMREM
// -------------------------------------------------------------------------

/**
 * Extract artifact(s) for a PMREMGenerator pre-filter pass.
 *
 * PMREM produces multiple materials internally (one per mip). For the POC
 * we capture the first one — the dominant cost. A fuller implementation
 * returns an array keyed by mip level.
 *
 * @param {({webgpu, core, tsl}) => ({ sourceTexture: Object, kind: 'equirect' | 'cube', name?: string })} factory
 * @param {Object} [opts]
 * @return {Promise<{ artifact, configHash, materialShape: 'pmrem', hash: string }>}
 */
export async function extractPMREMArtifact( factory, opts = {} ) {

	const { webgpu, core, tsl } = await importThree();
	const renderer = makeRenderer( webgpu );
	await renderer.init();

	const { sourceTexture, kind = 'equirect', name = 'pmrem-aux' } = await factory( { webgpu, core, tsl } );
	if ( ! sourceTexture ) throw new Error( 'extractPMREMArtifact: factory must return { sourceTexture }' );

	// The config-hash covers (kind, texture-shape). Texture identity (uuid)
	// is NOT part of the hash — different textures of the same shape produce
	// the same PMREM material graph, only the sampled values differ.
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

	// PMREMGenerator's internal pipeline renders to a cube target. Its
	// internal materials aren't exposed cleanly via `compileTSL` unless we
	// trigger a PMREM generation. For the POC we just report the
	// configHash + a placeholder artifact; a real integration would hook
	// into PMREMGenerator's internal material constructions.
	const artifact = {
		uniformPlan: [],
		vertexShader: '',
		fragmentShader: '',
		materialShape: 'pmrem',
		pmremKind: kind,
	};
	stamp( artifact, 'pmrem', configHash, name, core, opts );
	if ( typeof renderer.dispose === 'function' ) renderer.dispose();
	return { artifact, configHash, materialShape: 'pmrem', hash: artifact.__hash };

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
