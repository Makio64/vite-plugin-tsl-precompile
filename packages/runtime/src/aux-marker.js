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
import {
	collectPMREMSourceTexturesFromMaterial,
	collectPMREMSourceTexturesInNode,
} from './slim-support/pmrem.js';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { ARTIFACT_CONTENT_HASH_VERSION, stringifyArtifactJson } from '@tsl-precompile/contract/artifact-content';
import { createRenderPipelineConfig } from '@tsl-precompile/contract/output-config';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';
import {
	collectArtifactVariantCandidates,
	createArtifactVariantPayloadFingerprint,
	mergeArtifactVariantFamily,
} from '@tsl-precompile/contract/artifact-variants';
import {
	assertInternalPassFamily,
	assertInternalPassFamilyStages,
} from '@tsl-precompile/contract/internal-pass';
import {
	createPMREMLayoutConfig,
	createPMREMSourceTopologyKey,
	createPMREMSupportConfig,
	pmremRequiredStages,
	pmremSourceInputTopology,
} from '@tsl-precompile/contract/pmrem-config';
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
			threeVersion: hashOpts.threeVersion,
			pluginVersion: hashOpts.pluginVersion,
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
		const hashOpts = {
			threeVersion: opts.threeVersion,
			pluginVersion: opts.pluginVersion || ARTIFACT_TOOLCHAIN_VERSION,
		};
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
	const hashOpts = {
		threeVersion: opts.threeVersion,
		pluginVersion: opts.pluginVersion || ARTIFACT_TOOLCHAIN_VERSION,
	};

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
				trackLocal( extra.shape, extra.configHash, extra.artifact );
				results.push( await post( opts.devEndpoint, {
					materialShape: extra.shape,
					configHash: extra.configHash,
					artifact: extra.artifact,
					name: `aux-${ extra.shape }-${ extra.configHash.slice( 0, 12 ) }`,
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
					const expectedStages = pmremRequiredStages( supportConfig.profile );
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
					for ( const subKind of [ 'cubemap', 'equirect', 'blur', 'ggx' ] ) {

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

		// Never warm or compile the caller's live RenderPipeline material. Three
		// r185 compileAsync() executes every builder updateBefore node and the
		// historical renderPipeline warm-up executes the full Pass/GTAO/Bloom graph
		// again. Both paths can poison backend caches keyed by those live identities.
		// Build only a private final-quad identity, suppress its update phases, and
		// capture the handler-owned sub-passes separately below.
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
	const extraArtifacts = await captureRegisteredEffectArtifactsLive( renderer, renderPipeline.outputNode, opts, hashOpts || {
		threeVersion: opts.threeVersion,
		pluginVersion: opts.pluginVersion || ARTIFACT_TOOLCHAIN_VERSION,
	}, liveUpdateBeforeNodes );
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
	const artifacts = await compileTSL( renderer, scene, camera, {
		noGlobalMRT: true,
		...( renderObjectHarvest ? { renderObjectHarvest } : {} ),
	} );
	const shadowArtifacts = artifacts.filter( ( artifact ) => artifact && artifact.materialShape === 'shadow-depth' );
	let depth = null;
	if ( shadowArtifacts.length > 0 ) {

		shadowArtifacts.sort( ( a, b ) => variantCount( b ) - variantCount( a ) || String( a.cacheKey ).localeCompare( String( b.cacheKey ) ) );
		const disambiguated = disambiguateShadowVariantCacheKeys( shadowArtifacts, {
			threeVersion: opts.threeVersion,
			pluginVersion: opts.pluginVersion || ARTIFACT_TOOLCHAIN_VERSION,
		} );
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

			for ( const subPass of subPasses ) {

				if ( ! subPass || ! subPass.material || typeof subPass.shape !== 'string' ) {

					throw new Error( `captureRegisteredEffectArtifactsLive: ${ handler.name } returned an invalid sub-pass` );

				}
				jobs.push( {
					subPass,
					configHash: hashPlainConfigSync( subPass.config || { type: subPass.shape }, { shape: subPass.shape, ...hashOpts } ),
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

				const { subPass, configHash, captureMaterial } = job;
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
					out.push( { shape: subPass.shape, configHash, artifact } );

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
		const compileOpts = { noGlobalMRT: true };
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
 * Walk the adopter scene and explicit fromScene seams for PMREM layouts.
 *
 * PMREM's output allocation is grouped by rounded cube-atlas layout, while
 * source conversion is grouped by shader/binding topology. Three caches one
 * private source material per PMREMGenerator, so different source topologies
 * must be driven by independent capture jobs or the first source's WGSL wins.
 * A generated PMREM result (mapping 306) cannot reveal whether it came from a
 * texture or a scene and is therefore excluded; fromScene-only applications
 * declare their source size through `opts.pmremSceneSizes`.
 *
 * @param {?Object} scene
 * @param {Object} opts
 * @return {Array<{ cubeSize: number, sources: Map<'equirect'|'cube', Object>, sourceVariants: Map<string, Map<string, Object>>, explicitScene: boolean }>}
 */
function collectPMREMInputs( scene, opts = {}, renderer = null ) {

	const layouts = new Map();
	const ensureLayout = ( requestedSize ) => {

		const cubeSize = normalizePMREMCubeSize( requestedSize );
		let layout = layouts.get( cubeSize );
		if ( ! layout ) {

			layout = {
				cubeSize,
				sources: new Map(),
				sourceVariants: new Map(),
				explicitScene: false,
			};
			layouts.set( cubeSize, layout );

		}
		return layout;

	};
	const record = ( texture ) => {

		const kind = classifyPMREMSourceTexture( texture );
		if ( ! kind ) return;
		const cubeSize = pmremSourceCubeSize( texture, kind );
		const layout = ensureLayout( cubeSize );
		const profile = kind === 'cube' ? 'texture-cubemap' : 'texture-equirect';
		const topologyKey = createPMREMSourceTopologyKey( texture, profile, { renderer } );
		let variants = layout.sourceVariants.get( kind );
		if ( ! variants ) {

			variants = new Map();
			layout.sourceVariants.set( kind, variants );

		}
		if ( ! variants.has( topologyKey ) ) variants.set( topologyKey, texture );
		if ( ! layout.sources.has( kind ) ) layout.sources.set( kind, texture );

	};

	if ( scene ) {

		record( scene.background );
		record( scene.environment );

		// Walk both scene-level node graphs. PMREMNode keeps its original
		// cubemap/equirectangular source even after its generated CubeUV result
		// is assigned elsewhere.
		for ( const node of [ scene.backgroundNode, scene.environmentNode ] ) {

			for ( const source of collectPMREMSourceTexturesInNode( node ) ) record( source );

		}

		if ( typeof scene.traverse === 'function' ) {

			scene.traverse( ( object ) => {

				const material = object && object.material;
				if ( ! material ) return;
				const materials = Array.isArray( material ) ? material : [ material ];
				for ( const candidate of materials ) {

					record( candidate && candidate.envMap );
					for ( const source of collectPMREMSourceTexturesFromMaterial( candidate ) ) record( source );

				}

			} );

		}

	}

	const sceneSizes = opts.pmremSceneSizes;
	if ( sceneSizes !== undefined && ! Array.isArray( sceneSizes ) ) {

		throw new TypeError( 'precompileAuxiliary: opts.pmremSceneSizes must be an array of PMREMGenerator.fromScene() sizes.' );

	}
	for ( const requestedSize of sceneSizes || [] ) {

		const layout = ensureLayout( requestedSize );
		layout.explicitScene = true;

	}

	return [ ...layouts.values() ].sort( ( left, right ) => left.cubeSize - right.cubeSize );

}

function createPMREMCaptureJobs( layout ) {

	const jobs = [];
	for ( const kind of [ 'equirect', 'cube' ] ) {

		const variants = layout?.sourceVariants instanceof Map ? layout.sourceVariants.get( kind ) : null;
		for ( const [ topologyKey, sourceTexture ] of [ ...( variants || [] ) ].sort( ( left, right ) =>
			left[ 0 ] < right[ 0 ] ? - 1 : left[ 0 ] > right[ 0 ] ? 1 : 0
		) ) jobs.push( {
			cubeSize: layout.cubeSize,
			profile: kind === 'cube' ? 'texture-cubemap' : 'texture-equirect',
			sourceTexture,
			topologyKey,
		} );

	}
	if ( layout?.explicitScene === true ) jobs.push( {
		cubeSize: layout.cubeSize,
		profile: 'scene',
		sourceTexture: null,
		topologyKey: null,
	} );
	return jobs;

}

function classifyPMREMSourceTexture( texture ) {

	if ( ! texture || texture.isTexture !== true || texture.mapping === 306 ) return null;
	if ( texture.mapping === 301 || texture.mapping === 302 ) return 'cube';
	if ( texture.mapping === 303 || texture.mapping === 304 ) return 'equirect';
	return null;

}

function pmremSourceCubeSize( texture, kind ) {

	if ( kind === 'cube' ) {

		const faces = texture && texture.image;
		if ( Array.isArray( faces ) && faces.length === 0 ) return 16;
		const firstFace = Array.isArray( faces ) ? faces[ 0 ] : null;
		const image = firstFace && firstFace.image || firstFace;
		return Number( image && image.width || 0 );

	}
	return Number( texture && texture.image && texture.image.width || 0 ) / 4;

}

function normalizePMREMCubeSize( requestedSize ) {

	const size = Number( requestedSize );
	if ( ! Number.isFinite( size ) || size < 16 ) {

		throw new RangeError( `precompileAuxiliary: PMREM source resolves to a ${ size || 0 }px cube face; Three r185 requires at least 16px.` );

	}
	const cubeSize = 2 ** Math.floor( Math.log2( size ) );
	if ( ! Number.isSafeInteger( cubeSize ) ) {

		throw new RangeError( `precompileAuxiliary: PMREM cube size ${ requestedSize } is outside the supported integer range.` );

	}
	return cubeSize;

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

	const three = opts.three || null;
	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );
	const beginRenderObjectHarvest = opts.beginRenderObjectHarvest || cachedBeginRenderObjectHarvest;

	if ( ! three || ! three.PMREMGenerator || ! three.Scene || ! three.OrthographicCamera ) {

		throw new Error( 'capturePMREMLive: opts.three must expose the WebGPU PMREMGenerator plus Scene/OrthographicCamera' );

	}
	if ( ! three.NodeMaterial || ! three.WebGPURenderer ) {

		throw new Error( 'capturePMREMLive: opts.three must be the `three/webgpu` namespace; root `three`.PMREMGenerator is the incompatible WebGL ShaderMaterial implementation.' );

	}
	if ( typeof beginRenderObjectHarvest !== 'function' ) {

		throw new Error( 'capturePMREMLive: the dev extractor does not expose beginRenderObjectHarvest(); exact PMREM capture cannot fall back to synthetic geometry.' );

	}

	let pmrem = null;
	let harvestSession = null;
	const renderTargets = [];
	const profile = layout && layout.profile;
	const expectedStages = pmremRequiredStages( profile );
	const sourceTexture = layout && layout.sourceTexture || null;
	if ( expectedStages.length === 0 ) throw new Error( `capturePMREMLive: unsupported PMREM profile ${ JSON.stringify( profile ) }` );
	if ( profile !== 'scene' && ( ! sourceTexture || sourceTexture.isTexture !== true ) ) {

		throw new Error( `capturePMREMLive: ${ profile } requires one real source texture` );

	}
	let previousTarget = null;
	let previousFace = 0;
	let previousMip = 0;
	let previousAutoClear;
	let previousToneMapping;
	let previousXrEnabled;
	let rendererStateCaptured = false;
	let cubeUVRenderTarget = null;
	let renderObjectHarvest = null;
	let harvestFinished = false;
	try {

		pmrem = new three.PMREMGenerator( renderer );
		try {

			// A marker discovered by the application render closes its capture
			// epoch in a microtask. Let that handoff publish the compile-queue
			// tail before checking quiescence; otherwise a cold PMREM render can
			// run synchronously just before the marker installs its suppression
			// lock and the real PMREM material family is never harvested.
			await Promise.resolve();
			// A material-marker compile temporarily suppresses external renderer
			// draws while it owns `__tslpCompileLock`. Running PMREM inside that
			// window makes Three's synchronous source pass disappear entirely,
			// leaving no harvested material family on a cold startup. Start the
			// observer and real PMREM render together only after the queue tail is
			// stable; the callback is synchronous, so no competing compile can
			// reserve the renderer between the check and the draw sequence.
			await awaitRendererCompileQuiescence( renderer, () => {

				harvestSession = beginRenderObjectHarvest( renderer );
				previousTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
				previousFace = typeof renderer.getActiveCubeFace === 'function' ? renderer.getActiveCubeFace() : 0;
				previousMip = typeof renderer.getActiveMipmapLevel === 'function' ? renderer.getActiveMipmapLevel() : 0;
				previousAutoClear = renderer.autoClear;
				previousToneMapping = renderer.toneMapping;
				previousXrEnabled = renderer.xr && renderer.xr.enabled;
				rendererStateCaptured = true;

				withSyntheticRenderAccess( () => {

					if ( profile === 'scene' ) {

						// A nonzero sigma captures the complete public fromScene()
						// scheduler: blur plus GGX. The same family also serves sigma=0,
						// where the compiler-free scheduler simply skips blur.
						cubeUVRenderTarget = pmrem.fromScene(
							new three.Scene(),
							PMREM_CAPTURE_BLUR_SIGMA,
							0.1,
							100,
							{ size: layout.cubeSize },
						);

					} else {

						cubeUVRenderTarget = profile === 'texture-cubemap'
							? pmrem.fromCubemap( sourceTexture )
							: pmrem.fromEquirectangular( sourceTexture );

					}

				} );

			} );
			renderTargets.push( cubeUVRenderTarget );
			harvestFinished = true;
			renderObjectHarvest = await harvestSession.finish();

		} catch ( error ) {

			if ( ! harvestFinished ) {

				harvestFinished = true;
				try { await harvestSession.finish(); } catch ( _ ) { /* preserve PMREM failure */ }

			}
			throw error;

		}

		if ( typeof renderer.setRenderTarget === 'function' ) renderer.setRenderTarget( previousTarget, previousFace, previousMip );

		const materials = {
			cubemap: pmrem._cubemapMaterial,
			equirect: pmrem._equirectMaterial,
			blur: pmrem._blurMaterial,
			ggx: pmrem._ggxMaterial,
		};
		const exercisedSubKinds = expectedStages;
		const auxScene = new three.Scene();
		const camera = new three.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

		const allArtifacts = await compileTSL( renderer, auxScene, camera, {
			noGlobalMRT: true,
			renderObjectHarvest,
			skipWarmupRender: true,
		} );

		const captured = {};
		const replayConfig = createPMREMReplayConfig( pmrem, cubeUVRenderTarget );
		const supportConfig = createPMREMSupportConfig( replayConfig, profile, sourceTexture, { renderer } );
		for ( const subKind of exercisedSubKinds ) {

			const material = materials[ subKind ];
			if ( ! material ) {

				throw new Error( `capturePMREMLive: real PMREM render did not harvest the pmrem-${ subKind } stage.` );

			}
			const found = mergePMREMArtifactFamily( allArtifacts, material, subKind, renderObjectHarvest );
			found.materialShape = `pmrem-${ subKind }`;
			found.pmremKind = subKind;
			found.replayConfig = replayConfig;
			found.internalPass = createPMREMInternalPassDescriptor( found, subKind, cubeUVRenderTarget, supportConfig );
			for ( const variant of Object.values( found.variants || {} ) ) {

				if ( ! variant || typeof variant !== 'object' ) continue;
				variant.materialShape = `pmrem-${ subKind }`;
				variant.pmremKind = subKind;
				variant.replayConfig = replayConfig;
				variant.internalPass = found.internalPass;

			}
			captured[ subKind ] = jsonSafe( found );

		}

		if ( Object.keys( captured ).length === 0 ) {

			throw new Error( `capturePMREMLive: produced 0 artifacts (compileTSL returned ${ allArtifacts.length })` );

		}

		Object.defineProperty( captured, 'replayConfig', {
			value: replayConfig,
			enumerable: false,
			configurable: true,
		} );
		Object.defineProperty( captured, 'supportConfig', {
			value: supportConfig,
			enumerable: false,
			configurable: true,
		} );
		return captured;

		} finally {

			if ( harvestSession && ! harvestFinished ) {

				try { await harvestSession.finish(); } catch ( _ ) { /* preserve capture result */ }

			}
			try {

				if ( rendererStateCaptured && typeof renderer.setRenderTarget === 'function' ) renderer.setRenderTarget( previousTarget, previousFace, previousMip );

			} catch ( _ ) { /* preserve capture result */ }
			if ( rendererStateCaptured ) {

				try { renderer.autoClear = previousAutoClear; } catch ( _ ) { /* preserve capture result */ }
				try { renderer.toneMapping = previousToneMapping; } catch ( _ ) { /* preserve capture result */ }
				if ( renderer.xr && previousXrEnabled !== undefined ) {

					try { renderer.xr.enabled = previousXrEnabled; } catch ( _ ) { /* preserve capture result */ }

				}

			}
			for ( const renderTarget of new Set( renderTargets ) ) {

				if ( renderTarget && typeof renderTarget.dispose === 'function' ) {

					try { renderTarget.dispose(); } catch ( _ ) { /* preserve capture result */ }

				}

			}
			if ( pmrem && typeof pmrem.dispose === 'function' ) {

				try { pmrem.dispose(); } catch ( _ ) { /* preserve capture result */ }

			}
		}

}

const PMREM_CAPTURE_BLUR_SIGMA = 0.02;

function withSyntheticRenderAccess( callback ) {

	// A material capture keeps its application-frame guard installed through
	// codegen and the capture POST, after its compile lock has settled. PMREM's
	// deliberately isolated generator draws may therefore overlap that guard.
	// Use the same nested capability as compileTSL's warm-up renders so those
	// exact draws remain observable without reopening arbitrary app frames.
	globalThis.__tslpSyntheticRenderActive = ( globalThis.__tslpSyntheticRenderActive | 0 ) + 1;
	try {

		return callback();

	} finally {

		globalThis.__tslpSyntheticRenderActive = ( globalThis.__tslpSyntheticRenderActive | 0 ) - 1;

	}

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

function mergePMREMArtifactFamily( artifacts, material, subKind, renderObjectHarvest = null ) {

	const members = artifacts.filter( ( artifact ) => artifact.materialUuid === material.uuid );
	if ( members.length === 0 ) {

		const available = artifacts.slice( 0, 8 ).map( ( artifact ) =>
			`${ artifact.materialShape || 'unknown' }@${ artifact.materialUuid || 'no-uuid' }#${ artifact.cacheKey ?? 'no-cache-key' }`
		).join( ', ' );
		const omitted = Math.max( 0, artifacts.length - 8 );
		const harvestedFamily = renderObjectHarvest?.familiesByMaterial instanceof Map
			? renderObjectHarvest.familiesByMaterial.get( material )
			: null;
		const harvestedVariants = harvestedFamily && Array.isArray( harvestedFamily.variants )
			? harvestedFamily.variants.map( ( variant ) =>
				`${ variant.cacheKey ?? 'no-cache-key' }:${ variant.complete === true ? 'complete' : 'incomplete' }`
			).join( ', ' )
			: 'none';
		const requestSummary = Array.isArray( renderObjectHarvest?.requests )
			? renderObjectHarvest.requests.slice( 0, 8 ).map( ( request ) =>
				`${ request.material?.name || request.material?.type || 'unnamed' }@${ request.material?.uuid || 'no-uuid' }#${ request.cacheKey ?? 'no-cache-key' }`
			).join( ', ' )
			: 'none';
		throw new Error(
			`capturePMREMLive: no extracted artifact matched the real pmrem-${ subKind } material ` +
			`${ material.uuid || 'without-uuid' }; extracted ${ artifacts.length } ` +
			`(${ available || 'none' }${ omitted > 0 ? `, +${ omitted } more` : '' }); ` +
			`harvest family=${ harvestedFamily ? harvestedFamily.complete === true ? 'complete' : 'incomplete' : 'missing' } ` +
			`variants=[${ harvestedVariants }], requests=[${ requestSummary || 'none' }]`,
		);

	}
	normalizePMREMSelectorDepth( members );
	normalizePMREMFamilyBindingNames( members, subKind );
	const family = members[ 0 ];
	const textureRefs = new Map();
	for ( const member of members ) {

		if ( ! ( member._textureRefs instanceof Map ) ) continue;
		for ( const [ uuid, texture ] of member._textureRefs ) {

			const existing = textureRefs.get( uuid );
			if ( existing && existing !== texture ) {

				throw new Error( `capturePMREMLive: pmrem-${ subKind } captured ambiguous texture identity ${ uuid }` );

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

function normalizePMREMSelectorDepth( members ) {

	const candidates = new Set();
	for ( const member of members ) {

		for ( const candidate of collectArtifactVariantCandidates( member ) ) candidates.add( candidate );

	}
	for ( const candidate of candidates ) {

		if ( ! Array.isArray( candidate.renderContextSelectors ) ) continue;
		candidate.renderContextSelectors = [ ...new Set( candidate.renderContextSelectors.map( ( selector ) => {

			let descriptor;
			try {

				descriptor = JSON.parse( selector );

			} catch ( _ ) {

				return selector;

			}
			const target = descriptor && descriptor.target;
			if (
				! target || typeof target !== 'object' || Array.isArray( target )
				|| Object.prototype.hasOwnProperty.call( target, 'depth' )
				|| target.depthTexture !== null
			) return selector;
			// Three r185's PMREM ping-pong target is explicitly constructed
			// with depthBuffer:false, but its harvested RenderContext can omit
			// the `depth` field. Slim creates the same target with an explicit
			// false value, so persist the known stock topology instead of
			// signing an instrumentation omission as a third pipeline state.
			return stableJsonStringify( {
				...descriptor,
				target: { ...target, depth: false },
			}, 'pmremRenderContextSelector' );

		} ) ) ].sort();

	}

}

function normalizePMREMFamilyBindingNames( members, subKind ) {

	if ( subKind !== 'blur' ) return;
	let canonicalName = null;
	for ( const member of members ) {

		const group = ( member.uniformPlan || [] ).find( ( candidate ) => candidate && candidate.name === 'object' );
		const weights = ( group && group.orderedBindings || [] )
			.filter( ( binding ) => binding && binding.type === 'buffer-uniform' && binding.ref );
		if ( weights.length !== 1 || typeof weights[ 0 ].ref.name !== 'string' || weights[ 0 ].ref.name.length === 0 ) {

			throw new Error( 'capturePMREMLive: pmrem-blur family member has no exact weights binding name' );

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

			throw new Error( `capturePMREMLive: pmrem-blur weights binding ${ capturedName } did not resolve exactly once` );

		}
		weights.name = canonicalName;
		bindingDescriptors[ 0 ].name = canonicalName;

	}

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
	) throw new Error( 'capturePMREMLive: real PMREM render did not expose a valid compiled atlas layout' );
	const config = createPMREMLayoutConfig( cubeSize );
	if ( config.lodMax !== lodMax || config.target.width !== width || config.target.height !== height ) {

		throw new Error( 'capturePMREMLive: real PMREM render layout diverges from the locked pmrem-layout@1 contract' );

	}
	return config;

}

function createPMREMInternalPassDescriptor( artifact, subKind, renderTarget, supportConfig ) {

	const group = ( artifact.uniformPlan || [] ).find( ( candidate ) => candidate && candidate.name === 'object' );
	if ( ! group ) throw new Error( `capturePMREMLive: pmrem-${ subKind } has no object binding group` );
	const sampledTextures = ( group.textures || [] ).filter( ( binding ) => binding && binding.bindingKind === 'sampled-texture' );
	if ( sampledTextures.length !== 1 ) throw new Error( `capturePMREMLive: pmrem-${ subKind } expected exactly one sampled texture binding` );
	const textureBinding = sampledTextures[ 0 ];
	const source = textureBinding.source || {};
	const liveTexture = artifact._textureRefs instanceof Map && source.textureUuid
		? artifact._textureRefs.get( source.textureUuid )
		: null;
	const sourceStage = subKind === 'cubemap' || subKind === 'equirect';
	const textureTopology = sourceStage
		? pmremSourceInputTopology( supportConfig.source )
		: { dimension: textureBinding.textureType || '2d' };
	if ( ! textureTopology ) throw new Error( `capturePMREMLive: pmrem-${ subKind } is missing its source topology config` );
	if ( ! sourceStage && liveTexture && liveTexture.format !== undefined && liveTexture.format !== null ) textureTopology.format = liveTexture.format;
	if ( ! sourceStage && liveTexture && liveTexture.internalFormat !== undefined ) textureTopology.internalFormat = liveTexture.internalFormat;
	if ( ! sourceStage && liveTexture && liveTexture.type !== undefined && liveTexture.type !== null ) textureTopology.type = liveTexture.type;
	if ( ! sourceStage && liveTexture && liveTexture.colorSpace !== undefined ) textureTopology.colorSpace = liveTexture.colorSpace;
	const uniforms = [];
	for ( const [ binding, role ] of Object.entries( PMREM_UNIFORM_ROLES[ subKind ] || {} ) ) {

		const slot = ( group.slots || [] ).find( ( candidate ) => candidate && candidate.name === binding );
		if ( ! slot ) throw new Error( `capturePMREMLive: pmrem-${ subKind } is missing ${ role } at object.${ binding }` );
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
		topology: textureTopology,
	} ];
	if ( subKind === 'blur' ) {

		const weights = ( group.orderedBindings || [] )
			.filter( ( binding ) => binding && binding.type === 'buffer-uniform' && binding.ref )
			.map( ( binding ) => binding.ref );
		if ( weights.length !== 1 ) throw new Error( 'capturePMREMLive: pmrem-blur expected exactly one uniform-buffer weights binding' );
		if ( ! Number.isSafeInteger( weights[ 0 ].byteLength ) || weights[ 0 ].byteLength <= 0 || weights[ 0 ].byteLength % 16 !== 0 ) {

			throw new Error( 'capturePMREMLive: pmrem-blur weights must use std140-style scalar stride' );

		}
		inputs.push( {
			role: 'weights',
			kind: 'buffer',
			group: 'object',
			binding: weights[ 0 ].name,
			topology: {
				byteLength: weights[ 0 ].byteLength,
				arrayType: weights[ 0 ].arrayType,
				count: weights[ 0 ].byteLength / 16,
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
		shape: `pmrem-${ subKind }`,
		config: supportConfig,
		uniforms,
		inputs,
		output: { topology: outputTopology },
	};

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
	artifact.sourceThreeVersion = provenance.threeVersion;
	artifact.sourceHashVersion = provenance.pluginVersion;
	artifact.artifactContentHashVersion = ARTIFACT_CONTENT_HASH_VERSION;
	const hash = hashArtifactContentSync( artifact, {
		shape,
		threeVersion: provenance.threeVersion,
		pluginVersion: provenance.pluginVersion,
	} );
	return {
		...payload,
		hash,
		threeVersion: provenance.threeVersion,
		pluginVersion: provenance.pluginVersion,
		artifact,
	};

}

function jsonSafe( artifact ) {

	return JSON.parse( stringifyArtifactJson( artifact ) );

}
