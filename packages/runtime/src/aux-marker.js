/**
 * Auxiliary-pass marker.
 *
 * Dev-time companion to `extractBackgroundArtifact` etc. in the plugin.
 * The author calls `precompileAuxiliary(renderer, scene, camera, opts)`
 * once after scene setup; the marker walks the live aux-pass inputs
 * (`scene.backgroundNode`, a passed `renderPipeline.outputNode`,
 * `scene.children` for lights), hashes each via the runtime graph-hasher,
 * runs extraction in-browser against a throwaway scene, and POSTs each
 * captured artifact to the dev-capture endpoint tagged with its aux shape.
 *
 * This is the browser-side symmetrical counterpart of
 * `vite-plugin-tsl-precompile/src/aux-capture.js`. They share the hash
 * algorithm (proven by the parity tests in `aux-capture.test.js`).
 *
 * @module AuxMarker
 */

import { hashNodeGraphSync, hashPlainConfigSync } from './graph-hash.js';
import { registerAuxArtifact } from './aux-loader.js';
import { cloneRenderTargetForCapture } from './capture-render-target.js';
import {
	assertCubeRenderTargetSourceTexture,
	captureCubeRenderTargetLive,
} from './auxiliary/cube-render-target-capture.js';
import { collectEffectNodes } from './slim-support/postprocess-effects.js';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { createRenderPipelineConfig } from '@tsl-precompile/contract/output-config';
import { collectArtifactVariantCandidates, mergeArtifactVariantFamily } from '@tsl-precompile/contract/artifact-variants';

const logged = new Set();
function logOnce( key, fn ) {

	if ( logged.has( key ) ) return;
	logged.add( key );
	fn();

}

function collectAuxPassNodes( opts ) {

	const passNodes = [];
	const push = ( node ) => {

		if ( node && node.isPassNode && node._mrt && ! passNodes.includes( node ) ) passNodes.push( node );

	};

	push( opts && opts.passNode );

	const visited = new Set();
	const walkNode = ( node ) => {

		if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) || visited.has( node ) ) return;
		visited.add( node );
		push( node );
		for ( const key of [ 'node', 'aNode', 'bNode', 'cNode', 'colorNode', 'outputNode', 'inputs' ] ) {

			let child = null;
			try { child = node[ key ]; } catch ( _ ) { continue; }
			if ( Array.isArray( child ) ) child.forEach( walkNode );
			else walkNode( child );

		}

	};

	walkNode( opts && opts.renderPipeline && opts.renderPipeline.outputNode );
	walkNode( opts && opts.postProcessing && opts.postProcessing.outputNode );

	return passNodes;

}

/**
 * Drive auxiliary-pass captures for a scene.
 *
 * @param {Object} renderer - Active `WebGPURenderer`.
 * @param {Object} scene - The scene carrying `backgroundNode`, lights, etc.
 * @param {Object} camera - A camera valid for the scene.
 * @param {Object} opts
 * @param {string} opts.devEndpoint - e.g. '/__tsl-precompile/capture'.
 * @param {?Object} [opts.renderPipeline] - A RenderPipeline whose real final material should be captured.
 * @param {?string} [opts.renderPipelineName] - Friendly name for the RenderPipeline capture.
 * @param {?Object} [opts.postProcessing] - Backward-compatible alias for `renderPipeline`.
 * @param {?string} [opts.postProcessingName] - Backward-compatible alias for `renderPipelineName`.
 * @param {?Object} [opts.cubeRenderTargetTexture] - One equirectangular 2D texture to capture for CubeRenderTarget conversion.
 * @param {?Array<Object>} [opts.cubeRenderTargetTextures] - Additional equirectangular 2D textures to capture.
 * @param {?Object} [opts.cubeRenderTargetOptions] - Destination options used
 *   when the application constructs its CubeRenderTarget. Format/MSAA/depth
 *   topology participates in the capture hash.
 * @param {?Object} [opts.three] - The three module (fallback to scene's constructor's module).
 * @param {?Object} [opts.tsl] - The `three/tsl` namespace. Loaded lazily when omitted.
 * @param {string} [opts.threeVersion='unknown']
 * @param {string} [opts.pluginVersion=ARTIFACT_TOOLCHAIN_VERSION]
 * @return {Promise<Array<{ shape: string, configHash: string, ok: boolean, error?: string }>>}
 */
export async function precompileAuxiliary( renderer, scene, camera, opts = {} ) {

	if ( ! opts.devEndpoint ) {

		logOnce( 'no-endpoint', () => console.warn( '[tsl-precompile/aux] precompileAuxiliary: no devEndpoint configured; aux capture is a no-op.' ) );
		return [];

	}

	const results = [];
	if ( typeof window !== 'undefined' ) window.__tslpPrecompilePending = ( window.__tslpPrecompilePending | 0 ) + 1;

	try {

		// Production short-circuit: probe whether compileTSL can be loaded. The
		// dynamic import is `/* @vite-ignore */`'d, so it predictably fails in any
		// production bundle. When it fails, every downstream capture step would
		// throw — silently no-op the whole call instead so adopters don't need
		// `if ( import.meta.env.DEV )` guards in their app code.
		if ( ! opts.compileTSL && ( await lazyLoadCompileTSL() ) === null ) return [];

	if ( typeof opts.threeVersion !== 'string' || opts.threeVersion.length === 0 ) {

		throw new Error( 'precompileAuxiliary: opts.threeVersion is required (>= 184). Pass `threeVersion: String(THREE.REVISION).match(/^\\d+/)[0]` (e.g. "184").' );

	}
	const hashOpts = {
		threeVersion: opts.threeVersion,
		pluginVersion: opts.pluginVersion || ARTIFACT_TOOLCHAIN_VERSION,
	};

	// Register an aux artifact both on the dev server (via POST) AND in the
	// local runtime registry so the inspector panel sees captures live.
	const trackLocal = ( shape, configHash, artifact, name = undefined ) => {

		try {

			registerAuxArtifact( shape, configHash, artifact, {
				name,
				threeVersion: hashOpts.threeVersion,
				pluginVersion: hashOpts.pluginVersion,
			} );

		} catch ( _ ) { /* tolerate duplicates */ }

	};

	const passNodes = collectAuxPassNodes( opts );
	const mrtNode = opts.mrtNode || scene && scene.userData && scene.userData.__tslp_mrtNode || passNodes[ 0 ] && passNodes[ 0 ]._mrt || null;
	if ( mrtNode && scene ) {

		scene.userData = scene.userData || {};
		scene.userData.__tslp_mrtNode = mrtNode;

	}

	// Background -------------------------------------------------------------
	const backgroundInput = scene && ( scene.backgroundNode || scene.background );
	if ( backgroundInput ) {

		const shape = 'background';
		try {

			const configHash = hashNodeGraphSync( backgroundInput, { shape, ...hashOpts } );
			const artifact = await captureBackgroundLive( renderer, scene, camera, mrtNode ? { ...opts, mrtNode } : opts );
			trackLocal( shape, configHash, artifact );
			results.push( await post( opts.devEndpoint, {
				materialShape: shape,
				configHash,
				artifact,
				name: `aux-${ shape }-${ configHash.slice( 0, 12 ) }`,
			}, shape, configHash ) );

		} catch ( err ) {

			results.push( { shape, configHash: null, ok: false, error: err && err.message || String( err ) } );

		}

	}

	// RenderPipeline / legacy PostProcessing -------------------------------
	const renderPipeline = opts.renderPipeline || opts.postProcessing || null;
	if ( renderPipeline && renderPipeline.outputNode && renderPipeline.outputNode.isNode ) {

		const shape = 'post-process';
		try {

			const replayConfig = createRenderPipelineConfig( renderPipeline );
			const configHash = hashNodeGraphSync( replayConfig, { shape, ...hashOpts } );
			const captureName = opts.renderPipelineName || opts.postProcessingName || `aux-${ shape }-${ configHash.slice( 0, 12 ) }`;
			const captured = await capturePostProcessingLive( renderer, renderPipeline, scene, camera, opts, hashOpts );
			const artifact = captured && captured.artifact ? captured.artifact : captured;
			const extraArtifacts = captured && Array.isArray( captured.extraArtifacts ) ? captured.extraArtifacts : [];
			trackLocal( shape, configHash, artifact, captureName );
			results.push( await post( opts.devEndpoint, {
				materialShape: shape,
				configHash,
				artifact,
				name: captureName,
			}, shape, configHash ) );
			for ( const extra of extraArtifacts ) {

				if ( ! extra || ! extra.shape || ! extra.configHash || ! extra.artifact ) continue;
				trackLocal( extra.shape, extra.configHash, extra.artifact );
				results.push( await post( opts.devEndpoint, {
					materialShape: extra.shape,
					configHash: extra.configHash,
					artifact: extra.artifact,
					name: `aux-${ extra.shape }-${ extra.configHash.slice( 0, 12 ) }`,
				}, extra.shape, extra.configHash ) );

			}

		} catch ( err ) {

			results.push( { shape, configHash: null, ok: false, error: err && err.message || String( err ) } );

		}

	}

	// MRT pass nodes -------------------------------------------------------
	// When the user builds a `pass(scene, camera).setMRT(mrt({...}))` pipeline
	// (webgpu_mrt, webgpu_mrt_mask), the PassNode carries a live MRTNode
	// describing the output textures. We need a `mrt` shape descriptor in the
	// aux manifest so the slim runtime can size/format the MRT render target
	// correctly and route output textures to the right attachment slots.
	//
	// Discovery: walk opts.renderPipeline?.outputNode (a RenderPipeline) or
	// directly opts.passNode if provided. The user passes the pass instance
	// via opts.passNode.
	// The same pass list is resolved before background capture so PassNode
	// backgrounds compile with the pass MRT topology instead of the
	// single-output aux fallback.
	{

		// Sticky-stamp the discovered MRT on `scene.userData.__tslp_mrtNode`
		// so compileTSL's collectSceneMRTNode and precompile-marker captures
		// see it during their synthetic warm-up — PassNode only writes
		// `material.mrtNode` during a live render, too late for our compile.
		if ( passNodes.length > 0 && scene ) {

			scene.userData = scene.userData || {};
			scene.userData.__tslp_mrtNode = passNodes[ 0 ]._mrt;

		}

		for ( const passNode of passNodes ) {

			const shape = 'mrt';
			try {

				// Hash the MRT descriptor: scene + camera identity + MRT output names.
				const mrtNode = passNode._mrt;
				const outputNames = mrtNode && mrtNode.outputNodes
					? Object.keys( mrtNode.outputNodes ).sort()
					: [];
				const configHash = hashPlainConfigSync(
					{ scene: scene && scene.uuid, camera: camera && camera.uuid, outputNames },
					{ shape, ...hashOpts }
				);
				const artifact = await captureMRTLive( renderer, passNode, scene, camera, opts );
				trackLocal( shape, configHash, artifact );
				results.push( await post( opts.devEndpoint, {
					materialShape: shape,
					configHash,
					artifact,
					name: `aux-${ shape }-${ configHash.slice( 0, 12 ) }`,
				}, shape, configHash ) );

			} catch ( err ) {

				results.push( { shape, configHash: null, ok: false, error: err && err.message || String( err ) } );

			}

		}

	}

	// Backdrop materials ----------------------------------------------------
	// Walk the scene looking for materials with `backdropNode` set.
	// Each unique `backdropNode` TSL graph gets captured as a `backdrop`
	// shape artifact so the slim runtime can pre-wire the FramebufferTexture
	// bindings that `viewportSharedTexture()` produces.
	if ( scene && typeof scene.traverse === 'function' ) {

		// Collect unique backdrop materials synchronously (traverse is sync).
		const backdropMaterials = [];
		const seenBackdropNodes = new Set();

		scene.traverse( ( object ) => {

			const material = object && object.material;
			if ( ! material ) return;

			// Handle multi-material objects.
			const materials = Array.isArray( material ) ? material : [ material ];
			for ( const mat of materials ) {

				const backdropNode = mat && mat.backdropNode;
				if ( ! backdropNode || ! backdropNode.isNode ) continue;

				// De-duplicate by UUID so we don't capture the same graph twice.
				const nodeId = backdropNode.uuid || backdropNode;
				if ( seenBackdropNodes.has( nodeId ) ) continue;
				seenBackdropNodes.add( nodeId );
				backdropMaterials.push( { mat, backdropNode } );

			}

		} );

		// Now process them asynchronously.
		for ( const { mat, backdropNode } of backdropMaterials ) {

			const shape = 'backdrop';
			try {

				const configHash = hashNodeGraphSync( backdropNode, { shape, ...hashOpts } );
				const artifact = await captureBackdropLive( renderer, mat, scene, camera, opts );
				trackLocal( shape, configHash, artifact );
				results.push( await post( opts.devEndpoint, {
					materialShape: shape,
					configHash,
					artifact,
					name: `aux-${ shape }-${ configHash.slice( 0, 12 ) }`,
				}, shape, configHash ) );

			} catch ( err ) {

				results.push( { shape, configHash: null, ok: false, error: err && err.message || String( err ) } );

			}

		}

	}

	// Lights ----------------------------------------------------------------
	const lights = [];
	if ( scene && typeof scene.traverse === 'function' ) {

		scene.traverse( ( o ) => { if ( o && o.isLight ) lights.push( o ); } );

	}
	if ( lights.length > 0 ) {

		const shape = 'lights';
		try {

			const signature = lights
				.map( ( l ) => `${ l.type || l.constructor && l.constructor.name || 'Light' }:${ l.castShadow ? 'shadow' : '' }` )
				.sort();
			const configHash = hashPlainConfigSync( { signature }, { shape, ...hashOpts } );
			const lightsArtifact = { uniformPlan: [], vertexShader: '', fragmentShader: '', lightsSignature: signature };
			trackLocal( shape, configHash, lightsArtifact );
			// Light graphs are embedded in the standard material's extraction —
			// for the POC we register the signature without re-extracting a
			// dedicated lights-only artifact. A future pass walks `LightsNode`
			// explicitly to emit a standalone lights artifact.
			results.push( await post( opts.devEndpoint, {
				materialShape: shape,
				configHash,
				artifact: lightsArtifact,
				name: `aux-${ shape }-${ configHash.slice( 0, 12 ) }`,
			}, shape, configHash ) );

		} catch ( err ) {

			results.push( { shape: 'lights', configHash: null, ok: false, error: err && err.message || String( err ) } );

		}

	}

	const shadowLights = lights.filter( ( light ) => light && light.castShadow === true );
	if ( shadowLights.length > 0 ) {

		const shape = 'shadow-depth';
		try {

			const artifact = await captureShadowDepthLive( renderer, scene, camera, opts );
			if ( artifact ) {

				const signature = shadowLights
					.map( ( l ) => `${ l.type || l.constructor && l.constructor.name || 'Light' }:${ l.shadow && l.shadow.mapSize ? `${ l.shadow.mapSize.width }x${ l.shadow.mapSize.height }` : 'shadow' }` )
					.sort();
				const cacheKeys = collectArtifactVariantCandidates( artifact )
					.map( ( candidate ) => candidate.cacheKey )
					.filter( ( key ) => key !== undefined && key !== null )
					.map( ( key ) => String( key ) )
					.sort();
				const configHash = hashPlainConfigSync( { signature, cacheKeys }, { shape, ...hashOpts } );
				trackLocal( shape, configHash, artifact );
				results.push( await post( opts.devEndpoint, {
					materialShape: shape,
					configHash,
					artifact,
					name: `aux-${ shape }-${ configHash.slice( 0, 12 ) }`,
				}, shape, configHash ) );

			}

		} catch ( err ) {

			results.push( { shape, configHash: null, ok: false, error: err && err.message || String( err ) } );

		}

	}

	// CubeRenderTarget equirectangular conversion ---------------------------
	// CubeRenderTarget.fromEquirectangularTexture() creates a private
	// NodeMaterial at call time. Capture the exact r184 material graph once for
	// every live source texture so the slim source rewrite can replace that
	// private compiler path with a precompiled artifact. Explicit options and
	// scene-level discovery share one identity set: the same Texture referenced
	// from background, environment, and opts is compiled and POSTed only once.
	{

		const shape = 'cube-render-target';
		const sourceTextures = collectCubeRenderTargetTextures( scene, opts );
		for ( const sourceTexture of sourceTextures ) {

			let configHash = null;
			try {

				assertCubeRenderTargetSourceTexture( sourceTexture );
				const artifact = await captureCubeRenderTargetLive( renderer, sourceTexture, {
					...opts,
					compileTSL: opts.compileTSL || ( await lazyLoadCompileTSL() ),
					tsl: await resolveCubeRenderTargetTSL( opts ),
					serializeArtifact: jsonSafe,
				}, ( replayConfig ) => {

					configHash = hashPlainConfigSync( replayConfig, { shape, ...hashOpts } );

				} );
				trackLocal( shape, configHash, artifact );
				results.push( await post( opts.devEndpoint, {
					materialShape: shape,
					configHash,
					artifact,
					name: `aux-${ shape }-${ configHash.slice( 0, 12 ) }`,
				}, shape, configHash ) );

			} catch ( err ) {

				results.push( { shape, configHash, ok: false, error: err && err.message || String( err ) } );

			}

		}

	}

	// PMREM ------------------------------------------------------------------
	// Discover every (kind, sourceWidth, sourceHeight) signature reachable
	// from the scene that PMREMGenerator could be invoked on. For each unique
	// signature, capture the 4 internal materials (cubemap, equirect, blur,
	// ggx) so the slim renderer can drive PMREM through its precompiled
	// material path. Over-capturing is safe — the runtime only loads the
	// signatures it actually looks up via loadAux('pmrem-<sub>', hash).
	{

		const inputs = collectPMREMInputs( scene );
		for ( const { sourceTexture, kind } of inputs ) {

			try {

				const configInput = {
					kind,
					width: sourceTexture.image ? sourceTexture.image.width | 0 : 0,
					height: sourceTexture.image ? sourceTexture.image.height | 0 : 0,
					format: sourceTexture.format || 'unknown',
					type: sourceTexture.type || 'unknown',
				};
				const configHash = hashPlainConfigSync( configInput, { shape: 'pmrem', ...hashOpts } );
				const captured = await capturePMREMLive( renderer, sourceTexture, kind, opts );
				for ( const subKind of [ 'cubemap', 'equirect', 'blur', 'ggx' ] ) {

					const subArtifact = captured[ subKind ];
					if ( ! subArtifact ) continue;
					const subShape = `pmrem-${ subKind }`;
					trackLocal( subShape, configHash, subArtifact );
					results.push( await post( opts.devEndpoint, {
						materialShape: subShape,
						configHash,
						artifact: subArtifact,
						name: `aux-${ subShape }-${ configHash.slice( 0, 12 ) }`,
					}, subShape, configHash ) );

				}

			} catch ( err ) {

				results.push( { shape: 'pmrem', configHash: null, ok: false, error: err && err.message || String( err ) } );

			}

		}

	}

	// Renderer output transform ---------------------------------------------
	{

		const shape = 'render-output';
		try {

			const captured = await captureRenderOutputLive( renderer, scene, camera, opts );
			const artifact = captured.artifact;
			const configHash = hashPlainConfigSync( captured.replayConfig, { shape, ...hashOpts } );
			trackLocal( shape, configHash, artifact );
			results.push( await post( opts.devEndpoint, {
				materialShape: shape,
				configHash,
				artifact,
				name: `aux-${ shape }-${ configHash.slice( 0, 12 ) }`,
			}, shape, configHash ) );

		} catch ( err ) {

			results.push( { shape, configHash: null, ok: false, error: err && err.message || String( err ) } );

		}

	}

	} finally {

		if ( typeof window !== 'undefined' ) window.__tslpPrecompilePending = Math.max( 0, ( window.__tslpPrecompilePending | 0 ) - 1 );

	}

	return results;

}

/**
 * Live extraction of the Background material. Mirrors
 * `extractBackgroundArtifact` in the plugin: we attach `scene.backgroundNode`
 * to a tiny throwaway scene and run `compileTSL` against it. Three.js
 * populates `renderer._background`'s sceneData with a mesh whose material
 * is the one we extract.
 */
async function captureBackgroundLive( renderer, scene, camera, opts ) {

	const three = opts.three || scene.constructor && scene.constructor.__three || null;
	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );

	// Build a minimal throwaway scene with the same backgroundNode. We don't
	// want to mutate the user's scene (compileTSL attaches debug side-cars).
	const Ctor = opts.Scene || ( three && three.Scene ) || scene.constructor;
	const aux = new Ctor();
	aux.backgroundNode = scene.backgroundNode;
	aux.background = scene.background;

	const mrtNode = opts.mrtNode || scene && scene.userData && scene.userData.__tslp_mrtNode || null;
	const passNode = opts.passNode && opts.passNode.isPassNode && opts.passNode.scene === scene ? opts.passNode : null;
	const renderTargetOverride = cloneRenderTargetForCapture( passNode && passNode.renderTarget );

	// Plain aux scenes must not inherit a global MRT from the host renderer,
	// but PassNode MRT backgrounds do need the explicit pass descriptor so the
	// sky material emits the same multi-output fragment as the live pass. A
	// background rendered by a non-MRT PassNode still owns an offscreen target;
	// compile against a structural clone so its target selector and output
	// format match without clearing or disposing the live pass resources.
	const compileOpts = mrtNode ? { mrtNode } : { noGlobalMRT: true };
	if ( renderTargetOverride ) compileOpts.renderTargetOverride = renderTargetOverride;
	let artifacts;
	try {

		artifacts = await compileTSL( renderer, aux, camera, compileOpts );

	} finally {

		if ( renderTargetOverride ) {

			try { renderTargetOverride.dispose(); } catch ( _ ) {}

		}

	}
	const mesh = renderer._background && typeof renderer._background.get === 'function' ? renderer._background.get( aux ).backgroundMesh : null;
	let artifact = null;
	for ( const a of artifacts ) {

		if ( a.materialShape === 'background' ) { artifact = a; break; }
		if ( a.name === 'Background.material' || a.materialName === 'Background.material' ) { artifact = a; break; }
		if ( mesh && a.materialUuid === mesh.material.uuid ) { artifact = a; break; }

	}
	if ( ! artifact ) throw new Error( 'captureBackgroundLive: could not locate Background artifact among ' + artifacts.length );
	return jsonSafe( artifact );

}

async function capturePostProcessingLive( renderer, renderPipeline, scene, camera, opts, hashOpts = null ) {

	const three = opts.three || null;
	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );

	// Compile through the real pipeline so the artifact includes Three's
	// context wrapper and implicit renderOutput(toneMapping, colorSpace) pass.
	if ( ! three || ! three.Scene ) {

		throw new Error( 'capturePostProcessingLive: opts.three must expose Scene' );

	}
	const captureScene = new three.Scene();
	const captureCamera = camera || opts.camera || ( three.PerspectiveCamera ? new three.PerspectiveCamera( 45, 1, 0.1, 100 ) : null );
	// A pipeline may already have rendered before capture. Force `_update()` so
	// a recently changed outputNode/transform flag cannot reuse stale WGSL.
	renderPipeline.needsUpdate = true;

	// Isolate this aux capture from any global MRT the host might have set
	// (e.g. webgpu_multiple_rendertargets's `renderer.setMRT(...)` in init).
	// Otherwise compileTSL would inherit it and emit a multi-output fragment
	// for our single-output post-process material, crashing WGSL validation.
	const artifacts = await compileTSL( renderer, captureScene, captureCamera, { renderPipeline, noGlobalMRT: true } );
	const pipelineMaterial = renderPipeline._quadMesh && renderPipeline._quadMesh.material;
	const artifact = artifacts.find( ( a ) => pipelineMaterial && a.materialUuid === pipelineMaterial.uuid )
		|| artifacts.find( ( a ) => a.materialShape === 'render-pipeline' );
	if ( ! artifact ) throw new Error( 'capturePostProcessingLive: no RenderPipeline artifact produced' );
	artifact.materialShape = 'post-process';
	artifact.replayConfig = renderPipelineReplayMetadata( createRenderPipelineConfig( renderPipeline ) );
	const extraArtifacts = await captureRegisteredEffectArtifactsLive( renderer, renderPipeline.outputNode, opts, hashOpts || {
		threeVersion: opts.threeVersion,
		pluginVersion: opts.pluginVersion || ARTIFACT_TOOLCHAIN_VERSION,
	}, artifact._liveUpdateBeforeNodes );
	return { artifact: jsonSafe( artifact ), extraArtifacts };

}

async function captureShadowDepthLive( renderer, scene, camera, opts ) {

	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );
	if ( ! compileTSL || ! scene || ! camera ) return null;
	const artifacts = await compileTSL( renderer, scene, camera, { noGlobalMRT: true } );
	const shadowArtifacts = artifacts.filter( ( artifact ) => artifact && artifact.materialShape === 'shadow-depth' );
	if ( shadowArtifacts.length === 0 ) return null;
	shadowArtifacts.sort( ( a, b ) => variantCount( b ) - variantCount( a ) || String( a.cacheKey ).localeCompare( String( b.cacheKey ) ) );
	const artifact = shadowArtifacts[ 0 ];
	mergeArtifactVariantFamily( artifact, shadowArtifacts );
	return jsonSafe( artifact );

}

function variantCount( artifact ) {

	return collectArtifactVariantCandidates( artifact ).length;

}

/**
 * Walk a postprocess outputNode for registered effect handlers (bloom,
 * outline, ssr, dof, traa, ...) and capture each handler's internal
 * NodeMaterials as aux artifacts. Registry lives in
 * `slim-support/postprocess-effects.js` and is shared with the replay
 * wiring in `slim-support/postprocess-wire.js`.
 */
async function captureRegisteredEffectArtifactsLive( renderer, outputNode, opts, hashOpts, extraRoots = [] ) {

	const matches = collectEffectNodes( outputNode, { extraRoots } );
	if ( matches.length === 0 ) return [];

	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );
	const three = opts.three || null;
	if ( ! three || ! three.Scene || ! three.QuadMesh ) return [];

	const out = [];
	const indexByHandler = new Map();
	for ( const { handler, node } of matches ) {

		const effectIndex = indexByHandler.get( handler.name ) || 0;
		indexByHandler.set( handler.name, effectIndex + 1 );

		if ( typeof handler.forceSetup === 'function' ) {

			try { handler.forceSetup( node, { renderer, sharedContext: {} } ); } catch ( _ ) {}

		}

		let subPasses = [];
		try { subPasses = handler.subPasses( node, effectIndex ); } catch ( _ ) { continue; }
		if ( ! Array.isArray( subPasses ) ) continue;

		for ( const subPass of subPasses ) {

			if ( ! subPass || ! subPass.material || typeof subPass.shape !== 'string' ) continue;

			try {

				const configHash = hashPlainConfigSync( subPass.config || { type: subPass.shape }, { shape: subPass.shape, ...hashOpts } );
				const artifact = await captureNodeMaterialAsAuxLive( renderer, subPass.material, opts, compileTSL, subPass.shape, subPass.renderTargetHint || null );
				out.push( { shape: subPass.shape, configHash, artifact } );

			} catch ( _ ) {}

		}

	}

	return out;

}

async function captureNodeMaterialAsAuxLive( renderer, material, opts, compileTSL, shape, renderTargetHint = null ) {

	const three = opts.three || null;
	const scene = new three.Scene();
	scene.add( new three.QuadMesh( material ) );
	const camera = opts.camera || ( three.PerspectiveCamera ? new three.PerspectiveCamera( 45, 1, 0.1, 100 ) : null );

	// Allocate a matching RenderTarget when the sub-pass declares a non-default
	// fragment-output shape (DOF's `_CoCMaterial.outputNode = outputStruct(...)`
	// emits a 2-attachment RedFormat/HalfFloat fragment that the default 1×1
	// RGBA8 warm-up RT rejects). The hint is `{ count, format, type }`; missing
	// fields fall back to three.js RenderTarget defaults.
	const compileOpts = { noGlobalMRT: true };
	let auxRT = null;
	if ( renderTargetHint && three && typeof three.RenderTarget === 'function' ) {

		try {

			const rtOpts = { depthBuffer: false };
			if ( typeof renderTargetHint.count === 'number' && renderTargetHint.count > 0 ) rtOpts.count = renderTargetHint.count;
			if ( renderTargetHint.format != null ) rtOpts.format = renderTargetHint.format;
			if ( renderTargetHint.type != null ) rtOpts.type = renderTargetHint.type;
			auxRT = new three.RenderTarget( 1, 1, rtOpts );
			compileOpts.renderTargetOverride = auxRT;

		} catch ( _ ) {
			// Older three.js may reject `count` here; fall through without the
			// override and let compileTSL fail noisily so we know to update the
			// adopter's three version rather than silently corrupting capture.
			auxRT = null;

		}

	}

	try {

		const artifacts = await compileTSL( renderer, scene, camera, compileOpts );
		const artifact = artifacts.find( ( a ) => a.materialUuid === material.uuid ) || artifacts[ 0 ];
		if ( ! artifact ) throw new Error( `captureNodeMaterialAsAuxLive: no artifact produced for ${ shape }` );
		artifact.materialShape = shape;
		return jsonSafe( artifact );

	} finally {

		if ( auxRT ) {

			try { auxRT.dispose(); } catch ( _ ) { /* ignore */ }

		}

	}

}

async function captureRenderOutputLive( renderer, scene, camera, opts ) {

	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );
	const artifacts = await compileTSL( renderer, scene, camera, { noGlobalMRT: true, captureRendererOutput: true } );
	const captured = artifacts && artifacts.renderOutputCapture;
	const artifact = captured && captured.artifact;
	const replayConfig = captured && captured.replayConfig;
	if ( ! artifact || ! replayConfig || replayConfig.schema !== 'renderer-output@1' ) {

		throw new Error( 'captureRenderOutputLive: compileTSL did not return an exact active renderer-output capture' );

	}
	artifact.materialShape = 'render-output';
	const sampledTexture = inferRenderOutputSampledTexture( artifact );
	if ( replayConfig.sampledTexture !== sampledTexture ) {

		throw new Error(
			`captureRenderOutputLive: active output config samples ${ replayConfig.sampledTexture }, ` +
			`but the correlated artifact samples ${ sampledTexture }`,
		);

	}
	artifact.replayConfig = replayConfig;
	return { artifact: jsonSafe( artifact ), replayConfig };

}

function inferRenderOutputSampledTexture( artifact ) {

	for ( const group of artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			if ( ! entry || entry.bindingKind === 'sampler' ) continue;
			const source = entry.source || {};
			if ( source.kind !== 'artifact.texture' || source.mapping !== 300 ) continue;
			const type = String( entry.textureType || '' ).toLowerCase().replace( /_/g, '-' );
			return type === '2d-array' || type === 'array' ? '2d-array' : '2d';

		}

	}
	throw new Error( 'captureRenderOutputLive: output artifact has no framebuffer sampled texture' );

}

function renderPipelineReplayMetadata( config ) {

	return {
		schema: config.schema,
		outputColorTransform: config.outputColorTransform,
		toneMapping: config.toneMapping,
		outputColorSpace: config.outputColorSpace,
	};

}

/**
 * Capture a backdrop material artifact.
 *
 * Backdrop materials use `viewportSharedTexture()` to sample the current
 * framebuffer. We build a minimal scene with a single mesh using the
 * material, run `compileTSL`, and locate the artifact for this material's
 * uuid. The artifact's `_textureRefs` gets pre-wired by the aux-loader
 * registry on load so the FramebufferTexture binding is satisfied at
 * slim-replay time.
 *
 * @param {Object} renderer - Active WebGPURenderer.
 * @param {Object} material - The mesh material with `backdropNode` set.
 * @param {Object} scene - The user's scene (for environment/lights context).
 * @param {Object} camera - Camera for the scene.
 * @param {Object} opts - Same opts as precompileAuxiliary.
 * @return {Promise<Object>} The captured artifact (JSON-safe).
 */
async function captureBackdropLive( renderer, material, scene, camera, opts ) {

	const three = opts.three || null;
	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );

	if ( ! three || ! three.Scene || ! three.Mesh || ! three.SphereGeometry ) {

		throw new Error( 'captureBackdropLive: opts.three must expose Scene/Mesh/SphereGeometry' );

	}

	// Build a minimal throwaway scene with a single mesh using this material.
	// We copy scene context (environment, background) to make IBL bindings
	// match the real scene, but avoid mutating the user's scene.
	const auxScene = new three.Scene();
	if ( scene ) {

		auxScene.environment = scene.environment || null;

	}

	// Use a sphere for the backdrop mesh (same as the three.js webgpu_backdrop
	// examples), keeping the geometry simple enough to drive the shader.
	const geo = new three.SphereGeometry( 1, 16, 16 );
	const mesh = new three.Mesh( geo, material );
	auxScene.add( mesh );

	const artifacts = await compileTSL( renderer, auxScene, camera, { noGlobalMRT: true } );
	const artifact = artifacts.find( ( a ) => a.materialUuid === material.uuid )
		|| artifacts.find( ( a ) => a.materialShape === 'mesh-standard' || a.materialShape === 'mesh-physical' || a.materialShape === 'node-material' )
		|| artifacts[ 0 ];

	if ( ! artifact ) throw new Error( 'captureBackdropLive: no artifact produced for backdrop material' );
	return jsonSafe( artifact );

}

/**
 * Capture an MRT (Multiple Render Targets) pass artifact.
 *
 * MRT examples build `pass(scene, camera).setMRT(mrt({ output, normal, ... }))`
 * and then read individual textures via `passNode.getTexture('output')` etc.
 * In slim mode the PassNode stub stores `_mrt`; this function captures the
 * full pass render as an artifact with the MRT output names so the slim
 * runtime knows how many and what attachment slots were compiled.
 *
 * Extraction binds a structural 1x1 clone of the live PassNode target. This
 * preserves mixed MRT attachment formats without clearing or mutating the
 * application's live pass textures.
 *
 * @param {Object} renderer - Active WebGPURenderer.
 * @param {Object} passNode - A PassNode with `_mrt` set.
 * @param {Object} scene - The user's scene.
 * @param {Object} camera - Camera for the scene.
 * @param {Object} opts - Same opts as precompileAuxiliary.
 * @return {Promise<Object>} The captured artifact (JSON-safe), stamped with MRT info.
 */
async function captureMRTLive( renderer, passNode, scene, camera, opts ) {

	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );

	const mrtNode = passNode._mrt;
	const declaredOutputNames = mrtNode && mrtNode.outputNodes
		? Object.keys( mrtNode.outputNodes )
		: [];

	// Pass `mrtNode` explicitly so compileTSL's warm-up activates the right
	// MRT topology even when the renderer/material haven't observed the pass
	// yet. Without this, the synthetic compile emits a single-output fragment
	// against a multi-attachment RT.
	const renderTargetOverride = cloneRenderTargetForCapture( passNode.renderTarget, declaredOutputNames );
	// The target's attachment order determines shader locations. Three resolves
	// MRT outputs by texture name, so this may intentionally differ from the
	// declaration order in mrtNode.outputNodes.
	const outputNames = renderTargetOverride && Array.isArray( renderTargetOverride.textures )
		? renderTargetOverride.textures.map( ( texture ) => texture.name )
		: declaredOutputNames;
	let artifacts;
	try {

		artifacts = await compileTSL( renderer, scene, camera, {
			mrtNode,
			...( renderTargetOverride ? { renderTargetOverride } : {} ),
		} );

	} finally {

		if ( renderTargetOverride ) {

			try { renderTargetOverride.dispose(); } catch ( _ ) {}

		}

	}
	const artifact = artifacts.find( ( a ) => a.materialShape === 'post-process' )
		|| artifacts.find( ( a ) => a.materialShape === 'output-transform' )
		|| artifacts[ 0 ];

	if ( ! artifact ) throw new Error( 'captureMRTLive: no artifact produced for MRT pass' );

	// Stamp MRT metadata onto the artifact so the runtime can reconstruct
	// the correct render target topology.
	artifact.mrt = { outputNames };

	return jsonSafe( artifact );

}

/**
 * Collect source textures for CubeRenderTarget.fromEquirectangularTexture().
 * Explicit entries are retained even when unsupported so each requested
 * candidate produces an actionable failure result instead of disappearing.
 * Automatic scene discovery is deliberately narrower: only non-cube Texture
 * identities are candidates.
 *
 * @param {?Object} scene
 * @param {Object} opts
 * @return {Array<*>}
 */
function collectCubeRenderTargetTextures( scene, opts ) {

	const textures = [];
	const seen = new Set();
	const push = ( texture ) => {

		if ( texture == null || seen.has( texture ) ) return;
		seen.add( texture );
		textures.push( texture );

	};

	push( opts && opts.cubeRenderTargetTexture );
	if ( opts && opts.cubeRenderTargetTextures !== undefined ) {

		if ( Array.isArray( opts.cubeRenderTargetTextures ) ) {

			for ( const texture of opts.cubeRenderTargetTextures ) push( texture );

		} else {

			// Preserve a malformed explicit collection as one candidate. The
			// per-candidate validator below reports it without blocking valid
			// scene or singular-option captures.
			push( opts.cubeRenderTargetTextures );

		}

	}

	for ( const texture of [ scene && scene.background, scene && scene.environment ] ) {

		if ( texture && texture.isTexture === true && texture.isCubeTexture !== true ) push( texture );

	}

	return textures;

}

let cachedCubeRenderTargetTSL = null;
async function resolveCubeRenderTargetTSL( opts ) {

	let tsl = opts.tsl || null;
	// Some applications already pass a merged `three/webgpu` + `three/tsl`
	// namespace. Keep that ergonomic path without pretending the stock
	// `three/webgpu` entry exports TSL graph primitives.
	if ( ! tsl && opts.three && typeof opts.three.equirectUV === 'function' ) tsl = opts.three;
	if ( ! tsl ) {

		if ( ! cachedCubeRenderTargetTSL ) {

			try {

				cachedCubeRenderTargetTSL = await import( 'three/tsl' );

			} catch ( err ) {

				throw new Error( `captureCubeRenderTargetLive: could not load three/tsl; pass opts.tsl (${ err && err.message || err })` );

			}

		}
		tsl = cachedCubeRenderTargetTSL;

	}
	const missing = [];
	if ( typeof tsl.equirectUV !== 'function' ) missing.push( 'equirectUV' );
	if ( ! tsl.positionWorldDirection ) missing.push( 'positionWorldDirection' );
	if ( typeof tsl.texture !== 'function' ) missing.push( 'texture' );
	if ( missing.length > 0 ) {

		throw new Error( `captureCubeRenderTargetLive: opts.tsl must expose ${ missing.join( '/' ) }` );

	}
	return tsl;

}

/**
 * Walk a scene for textures that PMREMGenerator could be invoked on.
 * Returns deduped entries keyed by (kind, width, height) — the partition
 * the runtime needs.
 *
 * Heuristic: cubemaps and 2D textures with reflection mappings are
 * candidate PMREM inputs. CubeUVReflectionMapping (306) is the PMREM
 * RESULT and is excluded.
 *
 * @param {Object} scene
 * @return {Array<{ sourceTexture: Object, kind: 'equirect' | 'cube' }>}
 */
function collectPMREMInputs( scene ) {

	const seen = new Map();

	function record( tex ) {

		if ( ! tex || tex.isTexture !== true ) return;
		if ( tex.mapping === 306 ) return; // CubeUVReflectionMapping = PMREM result, skip
		let kind = null;
		if ( tex.isCubeTexture || tex.mapping === 301 || tex.mapping === 302 ) {

			kind = 'cube';

		} else if ( tex.mapping === 303 || tex.mapping === 304 ) {

			kind = 'equirect';

		}
		if ( ! kind ) return;
		const w = tex.image ? tex.image.width | 0 : 0;
		const h = tex.image ? tex.image.height | 0 : 0;
		const key = `${ kind }:${ w }:${ h }:${ tex.format || '' }:${ tex.type || '' }`;
		if ( seen.has( key ) ) return;
		seen.set( key, { sourceTexture: tex, kind } );

	}

	if ( ! scene ) return [];
	if ( scene.background && scene.background.isTexture === true ) record( scene.background );

	// Walk scene.backgroundNode for pmremTexture(source) — the real PMREMNode
	// (dev path uses real three/tsl, not slim stubs) carries `.value`/`.texture`
	// pointing at the source.
	if ( scene.backgroundNode ) {

		const found = findTextureInNode( scene.backgroundNode );
		if ( found ) record( found );

	}

	if ( typeof scene.traverse === 'function' ) {

		scene.traverse( ( object ) => {

			const m = object && object.material;
			if ( ! m ) return;
			const mats = Array.isArray( m ) ? m : [ m ];
			for ( const mat of mats ) {

				if ( mat && mat.envMap && mat.envMap.isTexture === true ) record( mat.envMap );

			}

		} );

	}

	return Array.from( seen.values() );

}

function findTextureInNode( node, depth = 0, seen = new Set() ) {

	if ( ! node || depth > 6 || seen.has( node ) ) return null;
	seen.add( node );
	if ( node.isTexture === true ) return node;
	for ( const key of [ 'value', '_value', 'texture', '_texture' ] ) {

		const v = node[ key ];
		if ( v && v.isTexture === true ) return v;

	}
	for ( const key of [ 'node', 'aNode', 'bNode', 'uvNode', 'levelNode', 'sourceNode' ] ) {

		const child = node[ key ];
		if ( child ) {

			const found = findTextureInNode( child, depth + 1, seen );
			if ( found ) return found;

		}

	}
	return null;

}

/**
 * Live capture of PMREMGenerator's 4 internal materials for a given
 * (sourceTexture, kind) signature. Mirrors `extractPMREMArtifact` in the
 * plugin but uses the live renderer (so artifact byte content matches what
 * production builds would emit).
 *
 * Returns a dict keyed by sub-shape ('cubemap'|'equirect'|'blur'|'ggx').
 *
 * @param {Object} renderer
 * @param {Object} sourceTexture
 * @param {'equirect'|'cube'} kind
 * @param {Object} opts
 * @return {Promise<{ cubemap: Object, equirect: Object, blur: Object, ggx: Object }>}
 */
async function capturePMREMLive( renderer, sourceTexture, kind, opts ) {

	const three = opts.three || null;
	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );

	if ( ! three || ! three.PMREMGenerator || ! three.Scene || ! three.Mesh || ! three.PlaneGeometry || ! three.PerspectiveCamera ) {

		throw new Error( 'capturePMREMLive: opts.three must expose PMREMGenerator/Scene/Mesh/PlaneGeometry/PerspectiveCamera' );

	}

	const pmrem = new three.PMREMGenerator( renderer );

	// Materialise cubemap + equirect blit shaders (compile-only, no render).
	await pmrem.compileCubemapShader();
	await pmrem.compileEquirectangularShader();

	// Materialise blur + ggx by manually invoking _setSizeFromTexture + _init.
	// We avoid fromX() because that runs render passes we don't need.
	pmrem._setSizeFromTexture( sourceTexture );
	const cubeUVRenderTarget = pmrem._allocateTarget();
	pmrem._init( cubeUVRenderTarget );

	const materials = {
		cubemap: pmrem._cubemapMaterial,
		equirect: pmrem._equirectMaterial,
		blur: pmrem._blurMaterial,
		ggx: pmrem._ggxMaterial,
	};

	const auxScene = new three.Scene();
	const camera = new three.PerspectiveCamera( 45, 1, 0.1, 100 );
	camera.position.set( 0, 0, 3 );

	const meshUuids = {};
	for ( const subKind of [ 'cubemap', 'equirect', 'blur', 'ggx' ] ) {

		const mat = materials[ subKind ];
		if ( ! mat ) continue;
		const mesh = new three.Mesh( new three.PlaneGeometry( 1, 1 ), mat );
		auxScene.add( mesh );
		meshUuids[ subKind ] = mat.uuid;

	}

	const allArtifacts = await compileTSL( renderer, auxScene, camera, { noGlobalMRT: true } );

	const captured = {};
	for ( const subKind of [ 'cubemap', 'equirect', 'blur', 'ggx' ] ) {

		const uuid = meshUuids[ subKind ];
		if ( ! uuid ) continue;
		const found = allArtifacts.find( ( a ) => a.materialUuid === uuid );
		if ( ! found ) continue;
		found.materialShape = `pmrem-${ subKind }`;
		found.pmremKind = subKind;
		captured[ subKind ] = jsonSafe( found );

	}

	pmrem.dispose();

	if ( Object.keys( captured ).length === 0 ) {

		throw new Error( `capturePMREMLive: produced 0 artifacts (compileTSL returned ${ allArtifacts.length })` );

	}

	return captured;

}

let cachedCompileTSL = null;
let compileTSLLoadFailed = false;
async function lazyLoadCompileTSL() {

	if ( cachedCompileTSL ) return cachedCompileTSL;
	if ( compileTSLLoadFailed ) return null;
	try {

			const mod = await import( /* @vite-ignore */ 'vite-plugin-tsl-precompile/src/vendor/compileTSL.js' );
			cachedCompileTSL = mod.compileTSL;
		return cachedCompileTSL;

	} catch ( err ) {

		// Production bundles never have compileTSL — the bare specifier above
		// is `/* @vite-ignore */`'d so Vite leaves it for the browser to
		// resolve, where it predictably fails. Treat as the production signal:
		// remember the failure so subsequent calls are cheap, and let callers
		// no-op cleanly instead of throwing into user code.
		compileTSLLoadFailed = true;
		logOnce( 'aux-prod-noop', () => console.info( '[tsl-precompile/aux] precompileAuxiliary: production environment detected (compileTSL not bundled); aux capture is a no-op. Run `pnpm dev` to refresh artifacts.' ) );
		return null;

	}

}

async function post( endpoint, payload, shape, configHash ) {

	try {

		const res = await fetch( endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify( payload ),
		} );
		if ( ! res.ok ) {

			const text = await res.text();
			return { shape, configHash, ok: false, error: `${ res.status } ${ text }` };

		}
		return { shape, configHash, ok: true };

	} catch ( err ) {

		return { shape, configHash, ok: false, error: err && err.message || String( err ) };

	}

}

function jsonSafe( artifact ) {

	return JSON.parse( JSON.stringify( artifact ) );

}
