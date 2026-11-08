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

import { hashArtifactContentSync, hashNodeGraphSync, hashPlainConfigSync } from './graph-hash.js';
import { createRuntimeCaptureHashOptions, createRuntimeThreeEmitterHashFields } from './three-emitter-identity.js';
import { createThreeEmitterSourceFields } from '@tsl-precompile/contract/three-emitter-identity';
import { registerAuxArtifact } from './aux-loader.js';
import {
	cloneRenderTargetForCapture,
	takeBackgroundCaptureRenderTargets,
} from './capture-render-target.js';
import {
	assertCubeRenderTargetSourceTexture,
	awaitRendererCompileQuiescence,
	captureCubeRenderTargetLive,
} from './auxiliary/cube-render-target-capture.js';
import { takeRenderObjectHarvest } from './auxiliary/render-object-harvest-handoff.js';
import { collectEffectNodes } from './slim-support/postprocess-effects.js';
import { collectPMREMInputs, createPMREMCaptureJobs } from './auxiliary/pmrem-inputs.js';
import { capturePMREMPrograms } from './auxiliary/pmrem-live-capture.js';
import { ARTIFACT_CONTENT_HASH_VERSION, stringifyArtifactJson } from '@tsl-precompile/contract/artifact-content';
import { createRenderPipelineConfig, createEffectPassCaptureName } from '@tsl-precompile/contract/output-config';
import {
	collectArtifactVariantCandidates,
	createArtifactVariantPayloadFingerprint,
	mergeArtifactVariantFamily,
} from '@tsl-precompile/contract/artifact-variants';
import {
	assertInternalPassFamily,
	assertInternalPassFamilyStages,
} from '@tsl-precompile/contract/internal-pass';
import { pmremRequiredStages } from '@tsl-precompile/contract/pmrem-config';
import { createBackgroundCaptureTargetTopologyKey } from '@tsl-precompile/contract/render-selector';
import { recordDevCaptureOutcome, recordDevCaptureResults } from './dev-capture-outcome.js';

const logged = new Set();
let isolatedCaptureMaterialSerial = 0;
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

function trackLocalArtifact( shape, configHash, artifact, hashOpts, name = undefined ) {

	try {

		registerAuxArtifact( shape, configHash, artifact, {
			name,
			...hashOpts,
		} );

	} catch ( _ ) { /* tolerate duplicates */ }

}

async function captureAndPublishRendererOutput( renderer, scene, camera, opts, hashOpts ) {

	const shape = 'render-output';
	try {

		const captured = await captureRenderOutputLive( renderer, scene, camera, opts );
		const artifact = captured.artifact;
		const configHash = hashPlainConfigSync( captured.replayConfig, { shape, ...hashOpts } );
		trackLocalArtifact( shape, configHash, artifact, hashOpts );
		return post( opts.devEndpoint, {
			materialShape: shape,
			configHash,
			artifact,
			name: `aux-${ shape }-${ configHash.slice( 0, 12 ) }`,
		}, shape, configHash, hashOpts );

	} catch ( err ) {

		return { shape, configHash: null, ok: false, error: err && err.message || String( err ) };

	}

}

/**
 * Capture only the renderer-owned output color transform.
 *
 * Unlike `precompileAuxiliary()`, this narrow path does not inspect scene
 * backgrounds, lights, shadows, PMREM inputs, or post-processing graphs. It
 * exists so slim-mode setup can capture the one renderer-internal material
 * every canvas render requires without turning first render into a broad
 * auxiliary sweep.
 *
 * @param {Object} renderer
 * @param {Object} scene
 * @param {Object} camera
 * @param {Object} opts
 * @return {Promise<Array<{ shape: 'render-output', configHash: ?string, ok: boolean, error?: string }>>}
 */
export async function precompileRendererOutput( renderer, scene, camera, opts = {} ) {

	if ( ! opts.devEndpoint ) {

		logOnce( 'no-render-output-endpoint', () => console.warn( '[tsl-precompile/aux] precompileRendererOutput: no devEndpoint configured; output capture is a no-op.' ) );
		return [];

	}

	if ( typeof window !== 'undefined' ) window.__tslpPrecompilePending = ( window.__tslpPrecompilePending | 0 ) + 1;

	let captureResults = null;
	try {

		if (
			Object.prototype.hasOwnProperty.call( opts, 'compileTSL' ) && opts.compileTSL === null ||
			! opts.compileTSL && ( await lazyLoadCompileTSL() ) === null
		) {

			recordDevCaptureOutcome( false );
			return [];

		}
		if ( typeof opts.threeVersion !== 'string' || opts.threeVersion.length === 0 ) {

			throw new Error( 'precompileRendererOutput: opts.threeVersion is required.' );

		}
		const hashOpts = createRuntimeCaptureHashOptions( opts );
		captureResults = [ await captureAndPublishRendererOutput( renderer, scene, camera, opts, hashOpts ) ];
		return captureResults;

	} catch ( error ) {

		recordDevCaptureOutcome( false );
		throw error;

	} finally {

		if ( captureResults ) recordDevCaptureResults( captureResults );
		if ( typeof window !== 'undefined' ) window.__tslpPrecompilePending = Math.max( 0, ( window.__tslpPrecompilePending | 0 ) - 1 );

	}

}

/**
 * Drive auxiliary-pass captures for a scene.
 *
 * @param {Object} renderer - Active `WebGPURenderer`.
 * @param {Object} scene - The scene carrying `backgroundNode`, lights, etc.
 * @param {Object} camera - A camera valid for the scene.
 * @param {Object} opts
 * @param {string} opts.devEndpoint - e.g. '/__tsl-precompile/capture'.
 * @param {?string} [opts.backgroundName] - Friendly semantic name for the background capture.
 * @param {?Object} [opts.renderPipeline] - A RenderPipeline whose real final material should be captured.
 * @param {?string} [opts.renderPipelineName] - Friendly name for the RenderPipeline capture.
 * @param {?Object} [opts.renderPipelineTarget] - RenderTarget topology used by the pipeline's final quad.
 *   Capture uses a disposable 1x1 structural clone and never clears or disposes the live target.
 * @param {?Object} [opts.postProcessing] - Backward-compatible alias for `renderPipeline`.
 * @param {?string} [opts.postProcessingName] - Backward-compatible alias for `renderPipelineName`.
 * @param {?Object} [opts.cubeRenderTargetTexture] - One equirectangular 2D texture to capture for CubeRenderTarget conversion.
 * @param {?Array<Object>} [opts.cubeRenderTargetTextures] - Additional equirectangular 2D textures to capture.
 * @param {?Object} [opts.cubeRenderTargetOptions] - Destination options used
 *   when the application constructs its CubeRenderTarget. Format/MSAA/depth
 *   topology participates in the capture hash.
 * @param {?Array<number>} [opts.pmremSceneSizes] - Explicit
 *   `PMREMGenerator.fromScene(..., { size })` sizes used by the application.
 *   This is required for fromScene-only layouts because the generated PMREM
 *   texture does not retain its source scene or requested size.
 * @param {?Array<Object>} [opts.pmremSourceTextures] - Original cube/equirectangular
 *   inputs used by PMREMGenerator when the scene only retains generated CubeUV results.
 * @param {?Object} [opts.three] - The `three/webgpu` module namespace.
 * @param {?Object} [opts.tsl] - The `three/tsl` namespace. Loaded lazily when omitted.
 * @param {string} opts.threeVersion - Exact resolved Three package version, e.g. `0.185.1`.
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
		if (
			Object.prototype.hasOwnProperty.call( opts, 'compileTSL' ) && opts.compileTSL === null ||
			! opts.compileTSL && ( await lazyLoadCompileTSL() ) === null
		) {

			recordDevCaptureOutcome( false );
			return [];

		}

	if ( typeof opts.threeVersion !== 'string' || opts.threeVersion.length === 0 ) {

		throw new Error( 'precompileAuxiliary: opts.threeVersion is required. Pass the exact resolved Three package version (for example, globalThis.__TSLP_THREE_PACKAGE_VERSION__ in Vite).' );

	}
	const hashOpts = createRuntimeCaptureHashOptions( opts );

	// Register an aux artifact both on the dev server (via POST) AND in the
	// local runtime registry so the inspector panel sees captures live.
	const trackLocal = ( shape, configHash, artifact, name = undefined ) => {

		trackLocalArtifact( shape, configHash, artifact, hashOpts, name );

	};

	const passNodes = collectAuxPassNodes( opts );
	const mrtNode = opts.mrtNode || scene && scene.userData && scene.userData.__tslp_mrtNode || passNodes[ 0 ] && passNodes[ 0 ]._mrt || null;
	if ( mrtNode && scene ) {

		scene.userData = scene.userData || {};
		scene.userData.__tslp_mrtNode = mrtNode;

	}

	// Background -------------------------------------------------------------
	const backgroundInput = scene && ( scene.backgroundNode || scene.background );
	if ( backgroundInput && backgroundInput.isColor !== true ) {

		const shape = 'background';
		try {

			const graphConfigHash = hashNodeGraphSync( backgroundInput, { shape, ...hashOpts } );
			const requestedName = opts.backgroundName || null;
			const configHash = requestedName ? hashPlainConfigSync( {
				graphConfigHash,
				semanticName: requestedName,
			}, { shape, ...hashOpts } ) : graphConfigHash;
			const captureName = requestedName || `aux-${ shape }-${ configHash.slice( 0, 12 ) }`;
			const artifact = await captureBackgroundLive( renderer, scene, camera, mrtNode ? { ...opts, mrtNode } : opts );
			trackLocal( shape, configHash, artifact, captureName );
			results.push( await post( opts.devEndpoint, {
				materialShape: shape,
				configHash,
				artifact,
				name: captureName,
			}, shape, configHash, hashOpts ) );

		} catch ( err ) {

			results.push( {
				shape,
				configHash: null,
				ok: false,
				error: err && err.message || String( err ),
				...( err && typeof err.stack === 'string' ? { stack: err.stack } : {} ),
			} );

		}

	}

	// RenderPipeline / legacy PostProcessing -------------------------------
	const renderPipeline = opts.renderPipeline || opts.postProcessing || null;
	if ( renderPipeline && renderPipeline.outputNode && renderPipeline.outputNode.isNode ) {

		const shape = 'post-process';
		try {

			const replayConfig = createRenderPipelineConfig( renderPipeline );
			const graphConfigHash = hashNodeGraphSync( replayConfig, { shape, ...hashOpts } );
			// A friendly name is an explicit semantic identity, not just a label.
			// Partition named captures even when graph normalization collapses two
			// live pipelines to the same structural hash (for example, equivalent
			// MRT texture-node stubs backed by different attachments).
			const requestedName = opts.renderPipelineName || opts.postProcessingName || null;
			const configHash = requestedName ? hashPlainConfigSync( {
				graphConfigHash,
				semanticName: requestedName,
			}, { shape, ...hashOpts } ) : graphConfigHash;
			const captureName = requestedName || `aux-${ shape }-${ configHash.slice( 0, 12 ) }`;
			const captured = await capturePostProcessingLive( renderer, renderPipeline, scene, camera, opts, hashOpts );
			const artifact = captured && captured.artifact ? captured.artifact : captured;
			const extraArtifacts = captured && Array.isArray( captured.extraArtifacts ) ? captured.extraArtifacts : [];
			trackLocal( shape, configHash, artifact, captureName );
			results.push( await post( opts.devEndpoint, {
				materialShape: shape,
				configHash,
				artifact,
				name: captureName,
			}, shape, configHash, hashOpts ) );
			for ( const extra of extraArtifacts ) {

				if ( ! extra || ! extra.shape || ! extra.configHash || ! extra.artifact ) continue;
				trackLocal( extra.shape, extra.configHash, extra.artifact, extra.name );
				results.push( await post( opts.devEndpoint, {
					materialShape: extra.shape,
					configHash: extra.configHash,
					artifact: extra.artifact,
					name: extra.name || `aux-${ extra.shape }-${ extra.configHash.slice( 0, 12 ) }`,
				}, extra.shape, extra.configHash, hashOpts ) );

			}

		} catch ( err ) {

			results.push( {
				shape,
				configHash: null,
				ok: false,
				error: err && err.message || String( err ),
				...( err && typeof err.stack === 'string' ? { stack: err.stack } : {} ),
			} );

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
				}, shape, configHash, hashOpts ) );

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
				}, shape, configHash, hashOpts ) );

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
			}, shape, configHash, hashOpts ) );

		} catch ( err ) {

			results.push( { shape: 'lights', configHash: null, ok: false, error: err && err.message || String( err ) } );

		}

	}

	const shadowLights = lights.filter( ( light ) => light && light.castShadow === true );
	if ( shadowLights.length > 0 ) {

		const shape = 'shadow-depth';
		try {

			const capturedShadowPasses = await captureShadowPassesLive( renderer, scene, camera, opts );
			const artifact = capturedShadowPasses.depth;
			if ( ! artifact ) {

				throw new Error( 'shadow internal-pass family is missing the expected shadow-depth stage.' );

			}
			const vsmLights = shadowLights.filter( ( light ) => light && ! light.isPointLight );
			const presentVsmStages = [
				capturedShadowPasses.vsmVertical && 'vertical',
				capturedShadowPasses.vsmHorizontal && 'horizontal',
			].filter( Boolean );
			const expectsVsm = vsmLights.length > 0 && (
				presentVsmStages.length > 0 ||
				opts.expectVSM === true ||
				( Number.isFinite( opts.three?.VSMShadowMap ) && renderer?.shadowMap?.type === opts.three.VSMShadowMap )
			);
			if ( expectsVsm ) assertInternalPassFamilyStages(
				'shadow-vsm',
				presentVsmStages,
				{ expectedStages: [ 'vertical', 'horizontal' ] },
			);
			const vsmSupportConfig = capturedShadowPasses.vsmVertical?.internalPass?.config ||
				capturedShadowPasses.vsmHorizontal?.internalPass?.config ||
				null;
			if ( expectsVsm ) assertInternalPassFamily(
				[ capturedShadowPasses.vsmVertical, capturedShadowPasses.vsmHorizontal ],
				{
					family: 'shadow-vsm',
					expectedStages: [ 'vertical', 'horizontal' ],
					config: vsmSupportConfig,
				},
			);

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
			const depthPayload = {
				materialShape: shape,
				configHash,
				artifact,
				name: `aux-${ shape }-${ configHash.slice( 0, 12 ) }`,
			};

			if ( expectsVsm ) {

				const vsmConfigHash = hashPlainConfigSync(
					vsmSupportConfig,
					{ shape: 'shadow-vsm', ...hashOpts },
				);
				const familyPayloads = [ depthPayload ];
				for ( const [ stage, vsmArtifact ] of [
					[ 'vertical', capturedShadowPasses.vsmVertical ],
					[ 'horizontal', capturedShadowPasses.vsmHorizontal ],
				] ) {

					const vsmShape = `shadow-vsm-${ stage }`;
					trackLocal( vsmShape, vsmConfigHash, vsmArtifact );
					familyPayloads.push( {
						materialShape: vsmShape,
						configHash: vsmConfigHash,
						artifact: vsmArtifact,
						name: `aux-${ vsmShape }-${ vsmConfigHash.slice( 0, 12 ) }`,
					} );

				}
				results.push( ...await postAuxiliaryFamily(
					opts.devEndpoint,
					'shadow-vsm',
					familyPayloads,
					hashOpts,
				) );

			} else {

				results.push( await post( opts.devEndpoint, depthPayload, shape, configHash, hashOpts ) );

			}

		} catch ( err ) {

			results.push( { shape, configHash: null, ok: false, error: err && err.message || String( err ) } );

		}

	}

	// CubeRenderTarget equirectangular conversion ---------------------------
	// CubeRenderTarget.fromEquirectangularTexture() creates a private
	// NodeMaterial at call time. Capture the exact r185 material graph once for
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
				}, shape, configHash, hashOpts ) );

			} catch ( err ) {

				results.push( { shape, configHash, ok: false, error: err && err.message || String( err ) } );

			}

		}

	}

	// PMREM ------------------------------------------------------------------
	// Group reachable inputs by rounded atlas layout, then capture one fresh
	// family per source topology plus one explicit scene family.
	{

		let layouts = [];
		try {

			layouts = collectPMREMInputs( scene, opts, renderer );

		} catch ( err ) {

			results.push( { shape: 'pmrem', configHash: null, ok: false, error: err && err.message || String( err ) } );

		}
		for ( const layout of layouts ) {

			for ( const captureJob of createPMREMCaptureJobs( layout ) ) {

				try {

					const captured = await capturePMREMLive( renderer, captureJob, opts );
					const supportConfig = captured.supportConfig;
					const configHash = hashPlainConfigSync( supportConfig, { shape: 'pmrem', ...hashOpts } );
					const expectedStages = pmremRequiredStages( supportConfig.profile, supportConfig );
					assertInternalPassFamilyStages(
						'pmrem',
						Object.keys( captured ),
						{ profile: supportConfig.profile, config: supportConfig },
					);
					assertInternalPassFamily(
						expectedStages.map( ( stage ) => captured[ stage ] ),
						{ family: 'pmrem', profile: supportConfig.profile, config: supportConfig },
					);
					const familyPayloads = [];
					for ( const subKind of expectedStages ) {

						const subArtifact = captured[ subKind ];
						if ( ! subArtifact ) continue;
						const subShape = `pmrem-${ subKind }`;
						trackLocal( subShape, configHash, subArtifact );
						familyPayloads.push( {
							materialShape: subShape,
							configHash,
							artifact: subArtifact,
							name: `aux-${ subShape }-${ configHash.slice( 0, 12 ) }`,
						} );

					}
					results.push( ...await postAuxiliaryFamily(
						opts.devEndpoint,
						'pmrem',
						familyPayloads,
						hashOpts,
					) );

				} catch ( err ) {

					results.push( {
						shape: 'pmrem',
						configHash: null,
						profile: captureJob.profile,
						error: err && err.message || String( err ),
						ok: false,
					} );

				}

			}
		}

	}

	// Renderer output transform ---------------------------------------------
	results.push( await captureAndPublishRendererOutput( renderer, scene, camera, opts, hashOpts ) );

	} catch ( error ) {

		recordDevCaptureOutcome( false );
		throw error;

	} finally {

		if ( typeof window !== 'undefined' ) window.__tslpPrecompilePending = Math.max( 0, ( window.__tslpPrecompilePending | 0 ) - 1 );

	}

	recordDevCaptureResults( results );
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

	const Ctor = opts.Scene || ( three && three.Scene ) || scene.constructor;
	const mrtNode = opts.mrtNode || scene && scene.userData && scene.userData.__tslp_mrtNode || null;
	const passNode = opts.passNode && opts.passNode.isPassNode && opts.passNode.scene === scene ? opts.passNode : null;
	const targetContexts = takeBackgroundCaptureRenderTargets( scene, renderer );
	const appendTargetContext = ( renderTarget, contextMRT ) => {

		const exactRenderTarget = renderTarget || null;
		const exactMRT = contextMRT || null;
		const topologyKey = createBackgroundCaptureTargetTopologyKey( renderer, exactRenderTarget, exactMRT );
		if ( targetContexts.some( ( context ) => context.topologyKey === topologyKey ) ) return;
		targetContexts.push( {
			topologyKey,
			captureRenderTarget: null,
			liveRenderTarget: exactRenderTarget,
			mrtNode: exactMRT,
			ownsRenderTarget: false,
		} );

	};
	if ( passNode ) appendTargetContext( passNode.renderTarget, opts.mrtNode || passNode._mrt || null );
	if ( targetContexts.length === 0 ) appendTargetContext( passNode && passNode.renderTarget, mrtNode );

	const backgroundArtifacts = [];
	const renderTargetsToDispose = new Set(
		targetContexts
			.filter( ( context ) => context.ownsRenderTarget && context.captureRenderTarget )
			.map( ( context ) => context.captureRenderTarget ),
	);
	let uncloneableTargetContexts = 0;
	try {

		for ( const targetContext of targetContexts ) {

			// Build one minimal throwaway scene per observed target. Reusing a scene
			// would let Three's Background manager reuse the first target's cached
			// material and hide later exact attachment variants.
			const aux = new Ctor();
			aux.backgroundNode = scene.backgroundNode;
			aux.background = scene.background;

			const liveRenderTarget = targetContext.liveRenderTarget || null;
			const renderTargetOverride = targetContext.captureRenderTarget ||
				cloneRenderTargetForCapture( liveRenderTarget );
			if ( liveRenderTarget && ! renderTargetOverride ) {

				uncloneableTargetContexts ++;
				continue;

			}
			if ( renderTargetOverride ) renderTargetsToDispose.add( renderTargetOverride );

			// Plain aux scenes must not inherit a global MRT from the host renderer,
			// while an observed MRT background needs the exact descriptor paired with
			// its target. compileTSL borrows the disposable clone transactionally and
			// restores the renderer's target/MRT state before returning.
			const contextMRT = targetContext.mrtNode || null;
			const compileOpts = contextMRT ? { mrtNode: contextMRT } : { noGlobalMRT: true };
			if ( renderTargetOverride ) compileOpts.renderTargetOverride = renderTargetOverride;
			const artifacts = await compileTSL( renderer, aux, camera, compileOpts );
			const mesh = renderer._background && typeof renderer._background.get === 'function' ? renderer._background.get( aux ).backgroundMesh : null;
			let artifact = null;
			for ( const candidate of artifacts ) {

				if ( candidate.materialShape === 'background' ) { artifact = candidate; break; }
				if ( candidate.name === 'Background.material' || candidate.materialName === 'Background.material' ) { artifact = candidate; break; }
				if ( mesh && candidate.materialUuid === mesh.material.uuid ) { artifact = candidate; break; }

			}
			if ( ! artifact ) throw new Error( 'captureBackgroundLive: could not locate Background artifact among ' + artifacts.length );
			backgroundArtifacts.push( artifact );

		}

		if ( backgroundArtifacts.length === 0 && uncloneableTargetContexts > 0 ) {

			throw new Error( 'captureBackgroundLive: could not clone any observed background render target.' );

		}

	} finally {

		for ( const renderTarget of renderTargetsToDispose ) {

			try { renderTarget.dispose(); } catch ( _ ) {}

		}

	}
	const artifact = backgroundArtifacts[ 0 ];
	if ( backgroundArtifacts.length > 1 ) mergeArtifactVariantFamily( artifact, backgroundArtifacts );
	return jsonSafe( artifact );

}

async function capturePostProcessingLive( renderer, renderPipeline, scene, camera, opts, hashOpts = null ) {

	const three = opts.three || null;
	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );
	let liveEffectSetupState = [];
	let liveEffectCaptureCleanups = [];
	let renderTargetOverride = null;
	let isolatedPipeline = null;
	let captureScene = null;
	let artifact = null;
	let liveUpdateBeforeNodes = [];
	let isolatedMaterial = null;
	try {

	if ( ! three || ! three.Scene || typeof three.QuadMesh !== 'function' ) {

		throw new Error( 'capturePostProcessingLive: opts.three must expose Scene and QuadMesh' );

	}
	let artifactsPromise = null;
	await awaitRendererCompileQuiescence( renderer, () => {

		liveEffectSetupState = snapshotEffectSetupState( renderPipeline.outputNode, [
			renderPipeline && renderPipeline._quadMesh && renderPipeline._quadMesh.material
				? renderPipeline._quadMesh.material.fragmentNode
				: null,
		] );
		for ( const { handler, node } of collectEffectNodes( renderPipeline.outputNode ) ) {

			if ( typeof handler.prepareCapture !== 'function' ) continue;
			const cleanup = handler.prepareCapture( node, { renderer } );
			if ( typeof cleanup === 'function' ) liveEffectCaptureCleanups.push( cleanup );

		}

		// Capture only a private native final quad with its update phases
		// suppressed. Re-running the live pipeline/effect graph can poison
		// backend caches; handler-owned sub-passes are captured separately below.
		const Pipeline = renderPipeline && renderPipeline.constructor;
		if ( typeof Pipeline !== 'function' ) throw new Error( 'capturePostProcessingLive: renderPipeline must expose a constructor' );
		isolatedPipeline = new Pipeline( renderer, renderPipeline.outputNode );
		if ( ! isolatedPipeline || isolatedPipeline === renderPipeline || typeof isolatedPipeline._update !== 'function' ) {

			throw new Error( 'capturePostProcessingLive: could not construct an isolated RenderPipeline' );

		}
		isolatedPipeline.outputNode = renderPipeline.outputNode;
		isolatedPipeline.outputColorTransform = renderPipeline.outputColorTransform === true;
		if ( Object.hasOwn( renderPipeline, '_toneMapping' ) ) isolatedPipeline._toneMapping = renderPipeline._toneMapping;
		if ( Object.hasOwn( renderPipeline, '_outputColorSpace' ) ) isolatedPipeline._outputColorSpace = renderPipeline._outputColorSpace;
		isolatedPipeline.needsUpdate = true;
		isolatedPipeline._update();

		const isolatedQuad = isolatedPipeline._quadMesh;
		isolatedMaterial = isolatedQuad && isolatedQuad.material;
		const liveMaterial = renderPipeline._quadMesh && renderPipeline._quadMesh.material;
		if (
			! isolatedQuad
			|| ! isolatedMaterial
			|| isolatedMaterial === liveMaterial
			|| ( liveMaterial && isolatedMaterial.uuid === liveMaterial.uuid )
		) {

			throw new Error( 'capturePostProcessingLive: isolated pipeline must own a distinct final material UUID' );

		}
		isolateCaptureMaterialCacheKey( isolatedMaterial, 'post-process' );
		captureScene = new three.Scene();
		captureScene.add( isolatedQuad );
		const captureCamera = isolatedQuad.camera || camera || opts.camera
			|| ( three.PerspectiveCamera ? new three.PerspectiveCamera( 45, 1, 0.1, 100 ) : null );

		const liveRenderTarget = opts.renderPipelineTarget || null;
		renderTargetOverride = cloneRenderTargetForCapture( liveRenderTarget );
		if ( liveRenderTarget && ! renderTargetOverride ) {

			throw new Error( 'capturePostProcessingLive: opts.renderPipelineTarget must be a cloneable RenderTarget' );

		}
		const workingColorSpace = three.ColorManagement && three.ColorManagement.workingColorSpace;
		if ( three.NoToneMapping === undefined || workingColorSpace == null ) {

			throw new Error( 'capturePostProcessingLive: opts.three must expose NoToneMapping and ColorManagement.workingColorSpace' );

		}
		artifactsPromise = compileTSL( renderer, captureScene, captureCamera, {
			materials: [ isolatedMaterial ],
			fullscreenQuad: isolatedQuad,
			noGlobalMRT: true,
			skipWarmupRender: true,
			skipNodeUpdatesForMaterials: [ isolatedMaterial ],
			rendererStateOverride: {
				toneMapping: three.NoToneMapping,
				currentColorSpace: workingColorSpace,
			},
			...( renderTargetOverride ? { renderTargetOverride } : {} ),
		} );

	} );
	const artifacts = await artifactsPromise;
	artifact = artifacts.find( ( candidate ) => candidate && candidate.materialUuid === isolatedMaterial.uuid );
	if ( ! artifact ) throw new Error( 'capturePostProcessingLive: no artifact correlated to the isolated final material' );
	artifact.materialShape = 'post-process';
	artifact.replayConfig = renderPipelineReplayMetadata( createRenderPipelineConfig( renderPipeline ) );
	liveUpdateBeforeNodes = Array.isArray( artifact._liveUpdateBeforeNodes ) ? artifact._liveUpdateBeforeNodes.slice() : [];

	} finally {

		if ( renderTargetOverride ) {

			try { renderTargetOverride.dispose(); } catch ( _ ) {}

		}
		for ( let index = liveEffectCaptureCleanups.length - 1; index >= 0; index -- ) {

			try { liveEffectCaptureCleanups[ index ](); } catch ( _ ) {}

		}
		restoreEffectSetupState( liveEffectSetupState );
		if ( captureScene && isolatedPipeline && isolatedPipeline._quadMesh && typeof captureScene.remove === 'function' ) {

			try { captureScene.remove( isolatedPipeline._quadMesh ); } catch ( _ ) {}

		}
		if ( isolatedPipeline ) {

			try { isolatedPipeline.dispose(); } catch ( _ ) {

				try { isolatedPipeline._quadMesh && isolatedPipeline._quadMesh.material.dispose(); } catch ( __ ) {}

			}

		}

	}

	// Restore caller-owned pipeline/effect state before starting the subsequent
	// clone-isolated captures. Each compile coordinates with the renderer queue
	// independently and must never inherit this synthetic pipeline context.
	const extraArtifacts = await captureRegisteredEffectArtifactsLive( renderer, renderPipeline.outputNode, opts, hashOpts || createRuntimeCaptureHashOptions( opts ), liveUpdateBeforeNodes );
	return { artifact: jsonSafe( artifact ), extraArtifacts };

}

function snapshotEffectSetupState( outputNode, extraRoots = [] ) {

	const matches = collectEffectNodes( outputNode, { extraRoots } );
	const seen = new Set();
	const snapshots = [];
	for ( const match of matches ) {

		const node = match && match.node;
		if ( ! node || seen.has( node ) ) continue;
		seen.add( node );
		snapshots.push( snapshotEffectNodeSetupState( node ) );

	}
	return snapshots;

}

function snapshotEffectNodeSetupState( node ) {

	const properties = [];
	const materialSnapshots = [];
	const seenMaterials = new Set();
	const snapshotMaterial = ( material ) => {

		if ( ! material || typeof material !== 'object' || seenMaterials.has( material ) ) return;
		seenMaterials.add( material );
		const fields = [];
		for ( const key of [ 'fragmentNode', 'vertexNode', 'outputNode', 'version' ] ) {

			fields.push( {
				key,
				hadOwn: Object.hasOwn( material, key ),
				descriptor: Object.hasOwn( material, key ) ? Object.getOwnPropertyDescriptor( material, key ) : null,
			} );

		}
		materialSnapshots.push( { material, fields } );

	};

	for ( const [ key, descriptor ] of Object.entries( Object.getOwnPropertyDescriptors( node ) ) ) {

		if ( ! /material/i.test( key ) || ! ( 'value' in descriptor ) ) continue;
		const value = descriptor.value;
		if ( Array.isArray( value ) ) {

			const contents = value.slice();
			properties.push( { key, descriptor, array: value, contents } );
			for ( const material of contents ) snapshotMaterial( material );

		} else {

			properties.push( { key, descriptor, material: value } );
			snapshotMaterial( value );

		}

	}
	return { node, properties, materialSnapshots };

}

function restoreEffectSetupState( snapshots ) {

	for ( let snapshotIndex = snapshots.length - 1; snapshotIndex >= 0; snapshotIndex -- ) {

		const snapshot = snapshots[ snapshotIndex ];
		for ( let materialIndex = snapshot.materialSnapshots.length - 1; materialIndex >= 0; materialIndex -- ) {

			const { material, fields } = snapshot.materialSnapshots[ materialIndex ];
			for ( let fieldIndex = fields.length - 1; fieldIndex >= 0; fieldIndex -- ) {

				const field = fields[ fieldIndex ];
				try {

					if ( field.hadOwn ) Object.defineProperty( material, field.key, field.descriptor );
					else delete material[ field.key ];

				} catch ( _ ) { /* sealed custom materials remain caller-owned */ }

			}

		}
		for ( let propertyIndex = snapshot.properties.length - 1; propertyIndex >= 0; propertyIndex -- ) {

			const property = snapshot.properties[ propertyIndex ];
			try {

				if ( property.array ) {

					const current = snapshot.node[ property.key ];
					const originalMaterials = new Set( property.contents );
					if ( Array.isArray( current ) ) {

						for ( const material of current ) {

							if ( originalMaterials.has( material ) || ! material || typeof material.dispose !== 'function' ) continue;
							try { material.dispose(); } catch ( _ ) { /* ignore synthetic cleanup errors */ }

						}

					}
					property.array.splice( 0, property.array.length, ...property.contents );

				} else {

					const originalMaterial = property.descriptor.value;
					const currentMaterial = snapshot.node[ property.key ];
					if (
						currentMaterial !== originalMaterial
						&& currentMaterial
						&& typeof currentMaterial.dispose === 'function'
					) {

						try { currentMaterial.dispose(); } catch ( _ ) { /* ignore synthetic cleanup errors */ }

					}

				}
				Object.defineProperty( snapshot.node, property.key, property.descriptor );

			} catch ( _ ) { /* sealed custom effect nodes remain caller-owned */ }

		}

	}

}

async function captureShadowPassesLive( renderer, scene, camera, opts ) {

	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );
	if ( ! compileTSL || ! scene || ! camera ) return {
		depth: null,
		vsmVertical: null,
		vsmHorizontal: null,
	};
	const hasExplicitHarvest = Object.prototype.hasOwnProperty.call( opts, 'renderObjectHarvest' );
	const stagedRenderObjectHarvest = hasExplicitHarvest
		? opts.renderObjectHarvest
		: takeRenderObjectHarvest( renderer, scene );
	let renderObjectHarvest = null;
	if ( stagedRenderObjectHarvest ) {

		try {

			renderObjectHarvest = await Promise.resolve( stagedRenderObjectHarvest );

		} catch ( _ ) {

			renderObjectHarvest = null;

		}

	}
	// A cached/static shadow or a receiver outside the opening camera's frustum
	// need not draw in the latest ordinary frame. Capture the complete visible
	// scene's shadow paths, then restore the application's update/culling policy.
	const restore = [];
	scene.traverse( object => {

		if ( object.isLight && object.castShadow && object.shadow ) {

			const shadow = object.shadow;
			const needsUpdate = shadow.needsUpdate;
			restore.push( () => { shadow.needsUpdate = needsUpdate; } );
			shadow.needsUpdate = true;

		}
		if ( object.isMesh ) {

			const frustumCulled = object.frustumCulled;
			restore.push( () => { object.frustumCulled = frustumCulled; } );
			object.frustumCulled = false;

		}

	} );
	let artifacts;
	try {

		artifacts = await compileTSL( renderer, scene, camera, {
			noGlobalMRT: true,
			materialShapes: [ 'shadow-depth', 'shadow-vsm-vertical', 'shadow-vsm-horizontal' ],
			freshShadowFrame: true,
			deferShadowFamilyMerge: true,
			...( renderObjectHarvest ? { renderObjectHarvest } : {} ),
		} );

	} finally {

		for ( const reset of restore ) reset();

	}
	const shadowArtifacts = artifacts.filter( ( artifact ) => artifact && artifact.materialShape === 'shadow-depth' );
	let depth = null;
	if ( shadowArtifacts.length > 0 ) {

		shadowArtifacts.sort( ( a, b ) => variantCount( b ) - variantCount( a ) || String( a.cacheKey ).localeCompare( String( b.cacheKey ) ) );
		const disambiguated = disambiguateShadowVariantCacheKeys( shadowArtifacts, createRuntimeCaptureHashOptions( opts ) );
		depth = shadowArtifacts[ 0 ];
		if ( disambiguated ) {

			// A flattened aggregate keeps root-only capture metadata while ensuring
			// every represented family member carries its disambiguated key.
			depth = { ...depth, ...disambiguated[ 0 ] };
			delete depth.variants;
			mergeArtifactVariantFamily( depth, [ depth, ...disambiguated.slice( 1 ) ] );

		} else {

			mergeArtifactVariantFamily( depth, shadowArtifacts );

		}

	}
	const pickInternalPass = ( materialShape ) => {

		const matches = artifacts.filter( ( candidate ) => candidate && candidate.materialShape === materialShape );
		if ( matches.length === 0 ) return null;
		matches.sort( ( a, b ) => variantCount( b ) - variantCount( a ) || String( a.cacheKey ).localeCompare( String( b.cacheKey ) ) );
		const selected = matches[ 0 ];
		if ( matches.length > 1 ) mergeArtifactVariantFamily( selected, matches );
		return jsonSafe( selected );

	};
	return {
		depth: depth ? jsonSafe( depth ) : null,
		vsmVertical: pickInternalPass( 'shadow-vsm-vertical' ),
		vsmHorizontal: pickInternalPass( 'shadow-vsm-horizontal' ),
	};

}

/**
 * Three's private shadow-material cache key can be reused across target
 * topologies even when the resulting signed payload differs. In r185 this is
 * observable when a 2D shadow pass carries `transparent: true` while the point
 * light's cube-face pass omits that render-state field under the same numeric
 * key. Signed render-context selectors are the authoritative routing contract,
 * so disjoint selector sets can be represented safely by deterministic durable
 * keys. If selectors overlap (or are absent), retain the original inputs and
 * let mergeArtifactVariantFamily fail closed.
 */
function disambiguateShadowVariantCacheKeys( artifacts, hashOpts ) {

	const candidates = artifacts.flatMap( ( artifact ) => collectArtifactVariantCandidates( artifact ) );
	const byCacheKey = new Map();
	for ( const candidate of candidates ) {

		if ( ! candidate || candidate.cacheKey === undefined || candidate.cacheKey === null ) continue;
		const cacheKey = String( candidate.cacheKey );
		let group = byCacheKey.get( cacheKey );
		if ( ! group ) {

			group = [];
			byCacheKey.set( cacheKey, group );

		}
		group.push( candidate );

	}

	const divergentKeys = new Set();
	const fingerprints = new Map();
	for ( const [ cacheKey, group ] of byCacheKey ) {

		const byFingerprint = new Map();
		for ( const candidate of group ) {

			const fingerprint = createArtifactVariantPayloadFingerprint( candidate );
			fingerprints.set( candidate, fingerprint );
			let members = byFingerprint.get( fingerprint );
			if ( ! members ) {

				members = [];
				byFingerprint.set( fingerprint, members );

			}
			members.push( candidate );

		}
		if ( byFingerprint.size < 2 ) continue;
		const selectorOwner = new Map();
		let selectorsAreDisjoint = true;
		for ( const [ fingerprint, members ] of byFingerprint ) {

			for ( const member of members ) {

				const selectors = Array.isArray( member.renderContextSelectors )
					? member.renderContextSelectors.filter( ( selector ) => typeof selector === 'string' && selector.length > 0 )
					: [];
				if ( selectors.length === 0 ) {

					selectorsAreDisjoint = false;
					break;

				}
				for ( const selector of selectors ) {

					const owner = selectorOwner.get( selector );
					if ( owner !== undefined && owner !== fingerprint ) {

						selectorsAreDisjoint = false;
						break;

					}
					selectorOwner.set( selector, fingerprint );

				}
				if ( ! selectorsAreDisjoint ) break;

			}
			if ( ! selectorsAreDisjoint ) break;

		}
		if ( ! selectorsAreDisjoint ) return null;
		divergentKeys.add( cacheKey );

	}
	if ( divergentKeys.size === 0 ) return null;

	return candidates.map( ( candidate ) => {

		const clone = { ...candidate };
		delete clone.variants;
		const cacheKey = String( candidate.cacheKey );
		if ( divergentKeys.has( cacheKey ) ) {

			const fingerprint = fingerprints.get( candidate ) || createArtifactVariantPayloadFingerprint( candidate );
			const suffix = hashPlainConfigSync( { cacheKey, fingerprint }, {
				shape: 'shadow-depth-variant-key',
				...hashOpts,
			} );
			clone.cacheKey = `${ cacheKey }:tslp-shadow:${ suffix }`;

		}
		return clone;

	} ).sort( ( left, right ) => String( left.cacheKey ).localeCompare( String( right.cacheKey ) ) );

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
		const effectSetupState = [ snapshotEffectNodeSetupState( node ) ];
		const jobs = [];
		try {

			if ( typeof handler.forceSetup === 'function' ) {

				try {

					handler.forceSetup( node, { renderer, sharedContext: {} } );

				} catch ( error ) {

					throw new Error(
						`captureRegisteredEffectArtifactsLive: ${ handler.name } forceSetup failed: ${ error && error.message || String( error ) }`,
					);

				}

			}

			let subPasses = [];
			try {

				subPasses = handler.subPasses( node, effectIndex );

			} catch ( error ) {

				throw new Error(
					`captureRegisteredEffectArtifactsLive: ${ handler.name } subPass discovery failed: ${ error && error.message || String( error ) }`,
				);

			}
			if ( ! Array.isArray( subPasses ) || subPasses.length === 0 ) {

				throw new Error( `captureRegisteredEffectArtifactsLive: ${ handler.name } returned no capturable sub-passes` );

			}

			for ( const [ passIndex, subPass ] of subPasses.entries() ) {

				if ( ! subPass || ! subPass.material || typeof subPass.shape !== 'string' ) {

					throw new Error( `captureRegisteredEffectArtifactsLive: ${ handler.name } returned an invalid sub-pass` );

				}
				const name = createEffectPassCaptureName( opts.renderPipelineName || opts.postProcessingName, handler.name, effectIndex, passIndex );
				const config = subPass.config || { type: subPass.shape };
				jobs.push( {
					subPass,
					name,
					configHash: hashPlainConfigSync( name ? { ...config, pipelinePassName: name } : config, { shape: subPass.shape, ...hashOpts } ),
					captureMaterial: cloneEffectMaterialForCapture( subPass.material, subPass.shape ),
					started: false,
				} );

			}

		} catch ( error ) {

			for ( const job of jobs ) {

				try { job.captureMaterial.dispose(); } catch ( _ ) { /* ignore */ }

			}
			throw error;

		} finally {

			// forceSetup and sub-pass discovery may materialize or invalidate
			// handler-owned graphs. All capture materials are cloned above, so
			// restore the live effect before any asynchronous backend compile.
			restoreEffectSetupState( effectSetupState );

		}

		try {

			for ( const job of jobs ) {

				const { subPass, configHash, captureMaterial, name } = job;
				job.started = true;
				try {

					const artifact = await captureNodeMaterialAsAuxLive(
						renderer,
						subPass.material,
						opts,
						compileTSL,
						subPass.shape,
						subPass.renderTargetHint || null,
						subPass.captureOverrides || [],
						captureMaterial,
					);
					out.push( { shape: subPass.shape, configHash, artifact, ...( name ? { name } : {} ) } );

				} catch ( error ) {

					throw new Error(
						`captureRegisteredEffectArtifactsLive: ${ handler.name }/${ subPass.shape } capture failed: ${ error && error.message || String( error ) }`,
					);

				}

			}

		} finally {

			for ( const job of jobs ) {

				if ( job.started ) continue;
				try { job.captureMaterial.dispose(); } catch ( _ ) { /* ignore */ }

			}

		}

	}

	return out;

}

async function captureNodeMaterialAsAuxLive(
	renderer,
	material,
	opts,
	compileTSL,
	shape,
	renderTargetHint = null,
	captureOverrides = [],
	ownedCaptureMaterial = null,
) {

	const three = opts.three || null;
	const captureMaterial = ownedCaptureMaterial || cloneEffectMaterialForCapture( material, shape );
	let auxRT = null;
	let overrideSnapshots = [];
	try {

		const scene = new three.Scene();
		scene.add( new three.QuadMesh( captureMaterial ) );
		const camera = opts.camera || ( three.PerspectiveCamera ? new three.PerspectiveCamera( 45, 1, 0.1, 100 ) : null );

		// Allocate a matching RenderTarget when the sub-pass declares a
		// non-default fragment-output shape (DOF's `_CoCMaterial.outputNode =
		// outputStruct(...)` emits a 2-attachment RedFormat/HalfFloat fragment
		// that the default 1×1 RGBA8 warm-up RT rejects).
		const compileOpts = {
			noGlobalMRT: true,
			materials: [ captureMaterial ],
			skipWarmupRender: true,
			skipNodeUpdatesForMaterials: [ captureMaterial ],
		};
		if ( renderTargetHint && three && typeof three.RenderTarget === 'function' ) {

			try {

				const rtOpts = { depthBuffer: false };
				if ( typeof renderTargetHint.count === 'number' && renderTargetHint.count > 0 ) rtOpts.count = renderTargetHint.count;
				if ( renderTargetHint.format != null ) rtOpts.format = renderTargetHint.format;
				if ( renderTargetHint.type != null ) rtOpts.type = renderTargetHint.type;
				auxRT = new three.RenderTarget( 1, 1, rtOpts );
				compileOpts.renderTargetOverride = auxRT;

			} catch ( _ ) {
				// Older three.js may reject `count` here; fall through without
				// the override and let compileTSL fail noisily.
				auxRT = null;

			}

		}

		// Do not expose a temporary live TextureNode value while an earlier
		// renderer compile still owns the queue. Once the observed tail is
		// stable, apply the override and synchronously invoke compileTSL so this
		// capture reserves the next queue turn before yielding again.
		let artifactsPromise = null;
		await awaitRendererCompileQuiescence( renderer, () => {

			overrideSnapshots = applyCaptureMaterialOverrides( captureMaterial, captureOverrides );
			artifactsPromise = compileTSL( renderer, scene, camera, compileOpts );

		} );
		const artifacts = await artifactsPromise;
		const artifact = artifacts.find( ( a ) => a.materialUuid === captureMaterial.uuid );
		if ( ! artifact ) {

			throw new Error( `captureNodeMaterialAsAuxLive: no artifact correlated to isolated ${ shape } material ${ captureMaterial.uuid }` );

		}
		artifact.materialShape = shape;
		return jsonSafe( artifact );

	} finally {

		restoreCaptureMaterialOverrides( overrideSnapshots );
		if ( auxRT ) {

			try { auxRT.dispose(); } catch ( _ ) { /* ignore */ }

		}
		try { captureMaterial.dispose(); } catch ( _ ) { /* ignore */ }

	}

}

function cloneEffectMaterialForCapture( material, shape ) {

	if ( ! material || typeof material.clone !== 'function' ) {

		throw new Error( `captureNodeMaterialAsAuxLive: ${ shape } material must expose clone() for isolated capture` );

	}
	let clone = null;
	try {

		clone = material.clone();
		if ( ! clone || clone === material || clone.uuid === material.uuid ) {

			throw new Error( `captureNodeMaterialAsAuxLive: ${ shape } material clone must have a distinct identity and UUID` );

		}

		// NodeMaterial.copy() intentionally skips ad-hoc properties that are not
		// present on a fresh NodeMaterial. Effect implementations attach live
		// sidecars such as Bloom's colorTexture/direction/invSize after
		// construction, so mirror missing public properties onto the isolated
		// material. The graph nodes remain shared by design; any temporary value
		// override below is restored exactly after extraction.
		for ( const [ key, descriptor ] of Object.entries( Object.getOwnPropertyDescriptors( material ) ) ) {

			if ( key === 'id' || key === 'uuid' || key === 'version' || key.startsWith( '_' ) ) continue;
			if ( ! Object.hasOwn( clone, key ) ) Object.defineProperty( clone, key, descriptor );

		}
		isolateCaptureMaterialCacheKey( clone, shape );
		return clone;

	} catch ( error ) {

		if ( clone && clone !== material ) {

			try { clone.dispose(); } catch ( _ ) { /* ignore */ }

		}
		throw error;
	}

}

function isolateCaptureMaterialCacheKey( material, shape ) {

	if ( ! material || typeof shape !== 'string' ) return;
	let base = shape;
	if ( typeof material.customProgramCacheKey === 'function' ) {

		try { base = String( material.customProgramCacheKey() ); } catch ( _ ) {}

	}
	const serial = ++ isolatedCaptureMaterialSerial;
	material.customProgramCacheKey = () => `${ base }:tslp-isolated-capture:${ shape }:${ serial }`;

}

function applyCaptureMaterialOverrides( material, overrides ) {

	if ( ! Array.isArray( overrides ) || overrides.length === 0 ) return [];
	const snapshots = [];
	try {

		for ( const override of overrides ) {

			const property = override && override.property;
			const key = override && override.key;
			const target = typeof property === 'string' && material ? material[ property ] : null;
			if ( ! target || ( typeof target !== 'object' && typeof target !== 'function' ) || typeof key !== 'string' ) {

				throw new Error( `captureNodeMaterialAsAuxLive: invalid capture override ${ String( property ) }.${ String( key ) }` );

			}
			snapshots.push( {
				target,
				key,
				hadOwn: Object.hasOwn( target, key ),
				descriptor: Object.hasOwn( target, key ) ? Object.getOwnPropertyDescriptor( target, key ) : null,
			} );
			target[ key ] = override.value;

		}
		return snapshots;

	} catch ( error ) {

		restoreCaptureMaterialOverrides( snapshots );
		throw error;

	}

}

function restoreCaptureMaterialOverrides( snapshots ) {

	for ( let i = snapshots.length - 1; i >= 0; i -- ) {

		const state = snapshots[ i ];
		try {

			if ( state.hadOwn ) Object.defineProperty( state.target, state.key, state.descriptor );
			else delete state.target[ state.key ];

		} catch ( _ ) { /* sealed custom sidecars remain caller-owned */ }

	}

}

async function captureRenderOutputLive( renderer, scene, camera, opts ) {

	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );
	const compileOpts = { noGlobalMRT: true, captureRendererOutput: true };
	if ( opts.rendererOutputConfig ) compileOpts.rendererOutputConfig = opts.rendererOutputConfig;
	const artifacts = await compileTSL( renderer, scene, camera, compileOpts );
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
		...( config.logarithmicDepthBuffer === true ? { logarithmicDepthBuffer: true } : {} ),
		...( config.reversedDepthBuffer === true ? { reversedDepthBuffer: true } : {} ),
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
	auxScene.userData = auxScene.userData || {};
	auxScene.userData.__tslpSyntheticCaptureScene = true;
	if ( scene ) {

		auxScene.environment = scene.environment || null;

	}

	// Use a sphere for the backdrop mesh (same as the three.js webgpu_backdrop
	// examples), keeping the geometry simple enough to drive the shader.
	const geo = new three.SphereGeometry( 1, 16, 16 );
	const mesh = new three.Mesh( geo, material );
	auxScene.add( mesh );

	try {

		const artifacts = await compileTSL( renderer, auxScene, camera, { noGlobalMRT: true } );
		const artifact = artifacts.find( ( a ) => a.materialUuid === material.uuid )
			|| artifacts.find( ( a ) => a.materialShape === 'mesh-standard' || a.materialShape === 'mesh-physical' || a.materialShape === 'node-material' )
			|| artifacts[ 0 ];

		if ( ! artifact ) throw new Error( 'captureBackdropLive: no artifact produced for backdrop material' );
		return jsonSafe( artifact );

	} finally {

		geo.dispose();

	}

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
 * Live capture of one topology-keyed PMREM operation family. Each source
 * topology receives a fresh Three PMREMGenerator because its private source
 * material is cached after the first compile. Scene support is captured as a
 * separate blur/GGX family and never fabricates a source texture.
 *
 * Returns a dict keyed by sub-shape ('cubemap'|'equirect'|'blur'|'ggx').
 *
 * @param {Object} renderer
 * @param {{ cubeSize: number, profile: string, sourceTexture: ?Object }} layout
 * @param {Object} opts
 * @return {Promise<Object>}
 */
async function capturePMREMLive( renderer, layout, opts ) {

	const compileTSL = opts.compileTSL || await lazyLoadCompileTSL();
	return capturePMREMPrograms( renderer, layout, {
		...opts, compileTSL,
		beginRenderObjectHarvest: opts.beginRenderObjectHarvest || cachedBeginRenderObjectHarvest,
	} );

}

let cachedCompileTSL = null;
let cachedBeginRenderObjectHarvest = null;
let compileTSLLoadFailed = false;
async function lazyLoadCompileTSL() {

	if ( cachedCompileTSL ) return cachedCompileTSL;
	if ( compileTSLLoadFailed ) return null;
	try {

			const mod = await import( /* @vite-ignore */ 'vite-plugin-tsl-precompile/src/vendor/compileTSL.js' );
			cachedCompileTSL = mod.compileTSL;
			cachedBeginRenderObjectHarvest = mod.beginRenderObjectHarvest || null;
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

async function post( endpoint, payload, shape, configHash, provenance ) {

	try {

		if ( ! provenance || typeof provenance.threeVersion !== 'string' || provenance.threeVersion.length === 0 ||
			typeof provenance.pluginVersion !== 'string' || provenance.pluginVersion.length === 0 ) {

			throw new Error( `Cannot publish ${ shape } auxiliary capture without exact Three/toolchain provenance.` );

		}
		const signedPayload = createSignedAuxiliaryPayload( payload, shape, provenance );
		const res = await fetch( endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify( signedPayload ),
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

async function postAuxiliaryFamily( endpoint, family, payloads, provenance ) {

	const fallbackResults = () => ( payloads || [] ).map( ( payload ) => ( {
		shape: payload?.materialShape || family,
		configHash: payload?.configHash || null,
		profile: payload?.artifact?.internalPass?.config?.profile || null,
		family,
		ok: false,
	} ) );
	try {

		const signedPayload = createSignedAuxiliaryFamilyPayload( family, payloads, provenance );
		const res = await fetch( endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify( signedPayload ),
		} );
		if ( ! res.ok ) {

			const body = await res.text();
			return fallbackResults().map( ( result ) => ( {
				...result,
				error: `${ res.status } ${ body }`,
			} ) );

		}
		return signedPayload.members.map( ( member ) => ( {
			shape: member.materialShape,
			configHash: member.configHash,
			profile: member?.artifact?.internalPass?.config?.profile || null,
			family,
			familyTransaction: true,
			ok: true,
		} ) );

	} catch ( error ) {

		return fallbackResults().map( ( result ) => ( {
			...result,
			error: error && error.message || String( error ),
		} ) );

	}

}

export function createSignedAuxiliaryFamilyPayload( family, payloads, provenance ) {

	if ( family !== 'pmrem' && family !== 'shadow-vsm' ) throw new TypeError(
		`Unsupported auxiliary family ${ JSON.stringify( family ) }.`,
	);
	if ( ! Array.isArray( payloads ) || payloads.length === 0 ) throw new TypeError(
		'Auxiliary family capture requires a non-empty payload array.',
	);
	return {
		auxiliaryFamily: family,
		members: payloads.map( ( payload ) => createSignedAuxiliaryPayload(
			payload,
			payload && payload.materialShape,
			provenance,
		) ),
	};

}

export function createSignedAuxiliaryPayload( payload, shape, provenance ) {

	if ( ! payload || ! payload.artifact || typeof payload.artifact !== 'object' ) {

		throw new TypeError( 'Auxiliary capture payload must include an artifact object.' );

	}
	if ( payload.materialShape !== shape ) {

		throw new Error( `Auxiliary capture shape mismatch: payload=${ payload.materialShape || '<missing>' }, requested=${ shape || '<missing>' }.` );

	}
	if ( ! provenance || typeof provenance.threeVersion !== 'string' || provenance.threeVersion.length === 0 ||
		typeof provenance.pluginVersion !== 'string' || provenance.pluginVersion.length === 0 ) {

		throw new Error( `Cannot sign ${ shape || '<unknown>' } auxiliary capture without exact Three/toolchain provenance.` );

	}
	const artifact = jsonSafe( payload.artifact );
	const emitterFields = createRuntimeThreeEmitterHashFields( provenance );
	artifact.sourceThreeVersion = provenance.threeVersion;
	Object.assign( artifact, createThreeEmitterSourceFields( { ...provenance, ...emitterFields } ) );
	artifact.sourceHashVersion = provenance.pluginVersion;
	artifact.artifactContentHashVersion = ARTIFACT_CONTENT_HASH_VERSION;
	const hash = hashArtifactContentSync( artifact, {
		shape,
		...provenance,
		...emitterFields,
	} );
	return {
		...payload,
		hash,
		threeVersion: provenance.threeVersion,
		...emitterFields,
		pluginVersion: provenance.pluginVersion,
		artifact,
	};

}

function jsonSafe( artifact ) {

	return JSON.parse( stringifyArtifactJson( artifact ) );

}
