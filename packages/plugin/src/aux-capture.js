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
import { compileTSL } from './vendor/compileTSL.js';
import { beginRenderObjectHarvest } from './vendor/render-object-observer.js';
import { SLIM_THREE_PACKAGE_VERSION } from '@tsl-precompile/contract/slim-three-policy';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import { createRenderPipelineConfig } from '@tsl-precompile/contract/output-config';
import { mergeArtifactVariantFamily } from '@tsl-precompile/contract/artifact-variants';
import {
	assertInternalPassFamily,
	assertInternalPassFamilyStages,
} from '@tsl-precompile/contract/internal-pass';
import {
	assertCubeRenderTargetTextureEvidence,
	createCubeRenderTargetAuxConfig,
} from '@tsl-precompile/contract/cube-render-target';
import {
	createPMREMLayoutConfig,
	createPMREMSupportConfig,
	pmremProfileForSource,
	pmremRequiredStages,
	pmremSourceInputTopology,
} from '@tsl-precompile/contract/pmrem-config';

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

function threeVersion( _core, opts ) {

	return opts.threeVersion || SLIM_THREE_PACKAGE_VERSION;

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

	const exactThreeVersion = threeVersion( core, opts );
	const exactPluginVersion = pluginVersion( opts );
	artifact.materialShape = shape;
	artifact.__name = name;
	artifact.__configHash = configHash;
	artifact.sourceThreeVersion = exactThreeVersion;
	artifact.sourceHashVersion = exactPluginVersion;
	artifact.artifactContentHashVersion = ARTIFACT_CONTENT_HASH_VERSION;
	// Artifact's own content-hash too — used by the existing 3-layer staleness gates.
	artifact.__hash = computeArtifactContentHash( artifact, {
		shape,
		threeVersion: exactThreeVersion,
		pluginVersion: exactPluginVersion,
	} );
	return artifact;

}

function makeRenderer( webgpu, rendererOptions = {} ) {

	const renderer = new webgpu.WebGPURenderer( {
		antialias: false,
		...rendererOptions,
		canvas: makeFakeCanvas(),
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
	const renderer = makeRenderer( webgpu, opts.rendererOptions );
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
		...( replayConfig.logarithmicDepthBuffer === true ? { logarithmicDepthBuffer: true } : {} ),
		...( replayConfig.reversedDepthBuffer === true ? { reversedDepthBuffer: true } : {} ),
	};
	stamp( artifact, 'post-process', configHash, name, core, opts );
	if ( typeof renderer.dispose === 'function' ) renderer.dispose();
	return { artifact, configHash, materialShape: 'post-process', hash: artifact.__hash };

}

// -------------------------------------------------------------------------
// CubeRenderTarget.fromEquirectangularTexture
// -------------------------------------------------------------------------

/**
 * Extract Three r185's fixed equirectangular-to-cube blit material.
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
			threeVersion: threeVersion( core, opts ),
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

function pmremSubShape( subKind ) {

	return `pmrem-${ subKind }`;

}

function restoreRendererTarget( renderer, state ) {

	if ( ! renderer || ! state || typeof renderer.setRenderTarget !== 'function' ) return;
	renderer.setRenderTarget( state.target, state.activeCubeFace, state.activeMipmapLevel );

}

function createPMREMReplayConfig( pmrem, renderTarget ) {

	const cubeSize = pmrem && pmrem._cubeSize;
	const lodMax = pmrem && pmrem._lodMax;
	const width = renderTarget && renderTarget.width;
	const height = renderTarget && renderTarget.height;
	if (
		! Number.isSafeInteger( cubeSize ) || cubeSize <= 0 ||
		! Number.isSafeInteger( lodMax ) || lodMax < 0 ||
		! Number.isSafeInteger( width ) || width <= 0 ||
		! Number.isSafeInteger( height ) || height <= 0
	) {

		throw new Error( 'extractPMREMArtifact: real PMREM render did not expose a valid compiled atlas layout' );

	}
	const config = createPMREMLayoutConfig( cubeSize );
	if ( config.lodMax !== lodMax || config.target.width !== width || config.target.height !== height ) {

		throw new Error( 'extractPMREMArtifact: real PMREM render layout diverges from the locked pmrem-layout@1 contract' );

	}
	return config;

}

const PMREM_UNIFORM_ROLES = Object.freeze( {
	blur: Object.freeze( {
		nodeUniform0: 'latitudinal',
		nodeUniform1: 'pole-axis',
		nodeUniform3: 'mip-int',
		nodeUniform5: 'samples',
		nodeUniform6: 'd-theta',
	} ),
	ggx: Object.freeze( {
		nodeUniform0: 'roughness',
		nodeUniform1: 'mip-int',
	} ),
} );

function pmremTextureTopology( artifact, binding, subKind, supportConfig ) {

	if ( subKind === 'cubemap' || subKind === 'equirect' ) return pmremSourceInputTopology( supportConfig.source );
	const source = binding && binding.source || {};
	const texture = artifact && artifact._textureRefs instanceof Map && source.textureUuid
		? artifact._textureRefs.get( source.textureUuid )
		: null;
	const topology = {
		dimension: binding && binding.textureType || '2d',
	};
	if ( texture && texture.format !== undefined && texture.format !== null ) topology.format = texture.format;
	if ( texture && texture.internalFormat !== undefined ) topology.internalFormat = texture.internalFormat;
	if ( texture && texture.type !== undefined && texture.type !== null ) topology.type = texture.type;
	if ( texture && texture.colorSpace !== undefined ) topology.colorSpace = texture.colorSpace;
	return topology;

}

function createPMREMInternalPassDescriptor( artifact, subKind, renderTarget, supportConfig ) {

	const group = ( artifact.uniformPlan || [] ).find( ( candidate ) => candidate && candidate.name === 'object' );
	if ( ! group ) {

		throw new Error( `extractPMREMArtifact: ${ pmremSubShape( subKind ) } has no object binding group` );

	}
	const sampledTextures = ( group.textures || [] ).filter( ( binding ) => binding && binding.bindingKind === 'sampled-texture' );
	if ( sampledTextures.length !== 1 ) {

		throw new Error( `extractPMREMArtifact: ${ pmremSubShape( subKind ) } expected exactly one sampled texture binding` );

	}
	const textureBinding = sampledTextures[ 0 ];
	const uniforms = [];
	const uniformRoles = PMREM_UNIFORM_ROLES[ subKind ] || {};
	for ( const [ binding, role ] of Object.entries( uniformRoles ) ) {

		const slot = ( group.slots || [] ).find( ( candidate ) => candidate && candidate.name === binding );
		if ( ! slot ) {

			throw new Error( `extractPMREMArtifact: ${ pmremSubShape( subKind ) } is missing ${ role } at object.${ binding }` );

		}
		uniforms.push( {
			role,
			group: 'object',
			binding,
			valueType: slot.dtype === 'number' ? 'float' : slot.dtype,
		} );

	}
	uniforms.sort( ( left, right ) => left.role.localeCompare( right.role ) );

	const inputs = [ {
		role: subKind === 'cubemap' || subKind === 'equirect' ? 'source' : 'env-map',
		kind: 'texture',
		group: 'object',
		binding: textureBinding.name,
		topology: pmremTextureTopology( artifact, textureBinding, subKind, supportConfig ),
	} ];
	if ( subKind === 'blur' ) {

		const weightBindings = ( group.orderedBindings || [] )
			.filter( ( binding ) => binding && binding.type === 'buffer-uniform' && binding.ref );
		if ( weightBindings.length !== 1 ) {

			throw new Error( 'extractPMREMArtifact: pmrem-blur expected exactly one uniform-buffer weights binding' );

		}
		const weights = weightBindings[ 0 ].ref;
		if ( ! Number.isSafeInteger( weights.byteLength ) || weights.byteLength <= 0 || weights.byteLength % 16 !== 0 ) {

			throw new Error( 'extractPMREMArtifact: pmrem-blur weights must use std140-style scalar stride' );

		}
		inputs.push( {
			role: 'weights',
			kind: 'buffer',
			group: 'object',
			binding: weights.name,
			topology: {
				byteLength: weights.byteLength,
				arrayType: weights.arrayType,
				count: weights.byteLength / 16,
				itemSize: 1,
				stride: 4,
			},
		} );

	}

	const outputTexture = renderTarget && renderTarget.texture;
	const outputTopology = { dimension: '2d', depth: false };
	if ( outputTexture && outputTexture.format !== undefined && outputTexture.format !== null ) outputTopology.format = outputTexture.format;
	if ( outputTexture && outputTexture.internalFormat !== undefined ) outputTopology.internalFormat = outputTexture.internalFormat;
	if ( outputTexture && outputTexture.type !== undefined && outputTexture.type !== null ) outputTopology.type = outputTexture.type;
	if ( outputTexture && outputTexture.colorSpace !== undefined ) outputTopology.colorSpace = outputTexture.colorSpace;
	return {
		schema: 'internal-pass@1',
		family: 'pmrem',
		stage: subKind,
		shape: pmremSubShape( subKind ),
		config: supportConfig,
		uniforms,
		inputs,
		output: { topology: outputTopology },
	};

}

function mergePMREMArtifactFamily( artifacts, material, subKind ) {

	const members = artifacts.filter( ( artifact ) => artifact.materialUuid === material.uuid );
	if ( members.length === 0 ) {

		throw new Error( `extractPMREMArtifact: no extracted artifact matched the real ${ pmremSubShape( subKind ) } material` );

	}
	normalizePMREMFamilyBindingNames( members, subKind );
	const family = members[ 0 ];
	const textureRefs = new Map();
	for ( const member of members ) {

		if ( ! ( member._textureRefs instanceof Map ) ) continue;
		for ( const [ uuid, texture ] of member._textureRefs ) {

			const existing = textureRefs.get( uuid );
			if ( existing && existing !== texture ) {

				throw new Error( `extractPMREMArtifact: ${ pmremSubShape( subKind ) } captured ambiguous texture identity ${ uuid }` );

			}
			textureRefs.set( uuid, texture );

		}

	}
	if ( textureRefs.size > 0 ) Object.defineProperty( family, '_textureRefs', {
		value: textureRefs,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	mergeArtifactVariantFamily( family, members );
	return family;

}

function normalizePMREMFamilyBindingNames( members, subKind ) {

	if ( subKind !== 'blur' ) return;
	let canonicalName = null;
	for ( const member of members ) {

		const group = ( member.uniformPlan || [] ).find( ( candidate ) => candidate && candidate.name === 'object' );
		const weights = ( group && group.orderedBindings || [] )
			.filter( ( binding ) => binding && binding.type === 'buffer-uniform' && binding.ref );
		if ( weights.length !== 1 || typeof weights[ 0 ].ref.name !== 'string' || weights[ 0 ].ref.name.length === 0 ) {

			throw new Error( 'extractPMREMArtifact: pmrem-blur family member has no exact weights binding name' );

		}
		if ( canonicalName === null ) canonicalName = weights[ 0 ].ref.name;

	}
	for ( const member of members ) {

		const group = member.uniformPlan.find( ( candidate ) => candidate && candidate.name === 'object' );
		const weights = group.orderedBindings.find( ( binding ) => binding && binding.type === 'buffer-uniform' ).ref;
		const capturedName = weights.name;
		const bindingGroup = ( member.bindings || [] ).find( ( candidate ) => candidate && candidate.name === 'object' );
		const bindingDescriptors = ( bindingGroup && bindingGroup.bindings || [] )
			.filter( ( binding ) => binding && binding.kind === 'uniform-buffer' && binding.name === capturedName );
		if ( bindingDescriptors.length !== 1 ) {

			throw new Error( `extractPMREMArtifact: pmrem-blur weights binding ${ capturedName } did not resolve exactly once` );

		}
		// Three numbers standalone UniformBuffer labels per NodeBuilderState, so
		// the same material receives a different metadata-only label for each
		// render-context cache key. WGSL and binding indices are unchanged.
		// Canonicalize that replay-local address across the proven family so one
		// internal-pass descriptor can address every exact selector member.
		weights.name = canonicalName;
		bindingDescriptors[ 0 ].name = canonicalName;

	}

}

function stampPMREMFamily( artifact, subKind, configHash, replayConfig, supportConfig, renderTarget, name, core, opts ) {

	const shape = pmremSubShape( subKind );
	artifact.pmremKind = subKind;
	artifact.materialShape = shape;
	artifact.replayConfig = replayConfig;
	const internalPass = artifact.internalPass && typeof artifact.internalPass === 'object'
		? artifact.internalPass
		: createPMREMInternalPassDescriptor( artifact, subKind, renderTarget, supportConfig );
	artifact.internalPass = { ...internalPass, config: supportConfig };
	for ( const variant of Object.values( artifact.variants || {} ) ) {

		if ( ! variant || typeof variant !== 'object' ) continue;
		variant.materialShape = shape;
		variant.replayConfig = replayConfig;
		variant.internalPass = artifact.internalPass;

	}
	return stamp( artifact, shape, configHash, `${ name }-${ subKind }`, core, opts );

}

/**
 * Extract the PMREMGenerator materials exercised by this input:
 * its kind-specific source blit and PMREM_ggx convolution. Scene blur is a
 * separate operation profile captured from a real fromScene() call by the
 * browser marker.
 *
 * The slim renderer cannot run PMREM's blur passes natively because its
 * rewritten Nodes.js:getForRender throws on non-precompiled materials.
 * Capturing these internal materials as standard precompiled artifacts
 * lets the slim renderer drive PMREM through the normal precompiled-material
 * path — no dual-renderer fallback needed.
 *
 * @param {({webgpu, core, tsl}) => ({ sourceTexture: Object, kind: 'equirect' | 'cube', name?: string })} factory
 * @param {Object} [opts]
 * @return {Promise<{ artifact, artifacts: Object, configHash, materialShape: 'pmrem', hash: string }>}
 *   `artifacts` is keyed by the exercised source blit plus 'ggx'.
 *   `artifact` is the primary one matching `kind` (kept for back-compat with
 *   the existing test fixture).
 */
export async function extractPMREMArtifact( factory, opts = {} ) {

	const { webgpu, core, tsl } = await importThree();
	const renderer = makeRenderer( webgpu );
	await renderer.init();

	const { sourceTexture, kind = 'equirect', name = 'pmrem-aux' } = await factory( { webgpu, core, tsl } );
	if ( ! sourceTexture ) throw new Error( 'extractPMREMArtifact: factory must return { sourceTexture }' );
	if ( kind !== 'equirect' && kind !== 'cube' ) {

		throw new Error( `extractPMREMArtifact: unsupported kind ${ JSON.stringify( kind ) }; expected "equirect" or "cube"` );

	}
	const profile = kind === 'cube' ? 'texture-cubemap' : 'texture-equirect';
	const inferredProfile = pmremProfileForSource( sourceTexture );
	if ( inferredProfile !== profile ) throw new Error(
		`extractPMREMArtifact: kind ${ JSON.stringify( kind ) } disagrees with the source texture mapping (${ inferredProfile })`,
	);

	const PMREM = webgpu.PMREMGenerator;
	if ( ! PMREM ) throw new Error( 'extractPMREMArtifact: three/webgpu does not export PMREMGenerator' );

	const pmrem = new PMREM( renderer );
	const previousTarget = {
		target: typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null,
		activeCubeFace: typeof renderer.getActiveCubeFace === 'function' ? renderer.getActiveCubeFace() : 0,
		activeMipmapLevel: typeof renderer.getActiveMipmapLevel === 'function' ? renderer.getActiveMipmapLevel() : 0,
	};
	let cubeUVRenderTarget = null;
	let harvestSession = null;

	try {

		// Observe the real PMREM draw sequence. Its private LOD meshes carry the
		// required `faceIndex` attribute and render against HalfFloat offscreen
		// targets; compiling the same materials on a generic PlaneGeometry
		// silently hard-coded face 0 and signed the wrong target topology.
		harvestSession = beginRenderObjectHarvest( renderer );
		cubeUVRenderTarget = kind === 'cube'
			? pmrem.fromCubemap( sourceTexture )
			: pmrem.fromEquirectangular( sourceTexture );

		const harvest = await harvestSession.finish();
		restoreRendererTarget( renderer, previousTarget );
		// PMREM rounds dimensions to the compiled atlas layout, but source
		// texture topology remains part of the family identity because it can
		// change WGSL sample type and binding layout at the same cube size.
		const replayConfig = createPMREMReplayConfig( pmrem, cubeUVRenderTarget );
		const supportConfig = createPMREMSupportConfig( replayConfig, profile, sourceTexture, { renderer } );
		const configHash = computePlainConfigHash( supportConfig, {
			shape: 'pmrem',
			threeVersion: threeVersion( core, opts ),
			pluginVersion: pluginVersion( opts ),
		} );

		const materials = {};
		for ( const material of harvest.familiesByMaterial.keys() ) {

			const match = /^PMREM_(cubemap|equirect|blur|ggx)$/.exec( material && material.name || '' );
			if ( match ) materials[ match[ 1 ] ] = material;

		}

		const exercisedSubKinds = pmremRequiredStages( profile );
		for ( const subKind of exercisedSubKinds ) {

			if ( ! materials[ subKind ] ) {

				throw new Error( `extractPMREMArtifact: real PMREM render did not harvest the ${ pmremSubShape( subKind ) } stage` );

			}

		}

		// compileTSL consumes the completed real-render harvest atomically. The
		// empty scene prevents an unrelated synthetic mesh from changing the
		// family; skipWarmupRender keeps this extraction read-only.
		const allArtifacts = await compileTSL(
			renderer,
			new core.Scene(),
			new core.OrthographicCamera(),
			{
				noGlobalMRT: true,
				renderObjectHarvest: harvest,
				skipWarmupRender: true,
			},
		);

		const artifacts = {};
		for ( const subKind of exercisedSubKinds ) {

			const material = materials[ subKind ];
			const found = mergePMREMArtifactFamily( allArtifacts, material, subKind );
			artifacts[ subKind ] = stampPMREMFamily(
				found,
				subKind,
				configHash,
				replayConfig,
				supportConfig,
				cubeUVRenderTarget,
				name,
				core,
				opts,
			);

		}

		const primaryKey = kind === 'cube' ? 'cubemap' : 'equirect';
		const primary = artifacts[ primaryKey ];
		assertInternalPassFamilyStages( 'pmrem', Object.keys( artifacts ), { profile, config: supportConfig } );
		assertInternalPassFamily(
			exercisedSubKinds.map( ( stage ) => artifacts[ stage ] ),
			{ family: 'pmrem', profile, config: supportConfig },
		);
		return {
			artifact: primary,
			artifacts,
			configHash,
			hash: primary.__hash,
			materialShape: 'pmrem',
			supportConfig,
		};

	} finally {

		if ( harvestSession && harvestSession.active ) await harvestSession.finish();
		restoreRendererTarget( renderer, previousTarget );
		if ( cubeUVRenderTarget && typeof cubeUVRenderTarget.dispose === 'function' ) cubeUVRenderTarget.dispose();
		pmrem.dispose();
		if ( typeof renderer.dispose === 'function' ) renderer.dispose();

	}

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
