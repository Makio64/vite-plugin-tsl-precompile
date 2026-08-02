import { selectLateRenderTargetTexturePair } from './late-render-target-textures.mjs';

/**
 * Hold presentation frames at the same loader-readiness boundary used by
 * capture without suppressing explicit offscreen work. CubeCamera and other
 * render-target producers often run while unrelated model/texture loaders are
 * still pending; dropping those draws permanently destroys the resource that
 * the eventual presentation frame consumes.
 */
export function shouldDeferReplayRenderForLoader( {
	renderDepth = 0,
	materialComputePresentation = false,
	loaderPending = 0,
	renderTarget = null,
} = {} ) {

	return renderDepth === 0 &&
		materialComputePresentation !== true &&
		loaderPending > 0 &&
		renderTarget === null;

}

export function shouldDeferReplayPostprocessForLoader( { loaderPending = 0 } = {} ) {

	return loaderPending > 0;

}

/**
 * Select the slim Bloom implementation only from an explicit capability.
 *
 * PassNode.getTextureNode() returns a PassTextureNode whose `.passNode`
 * back-reference is present for every ordinary scene-pass Bloom input. That
 * back-reference is ownership metadata, not proof that the full-renderer Bloom
 * fallback is unsuitable. Known cases that intentionally rely on the slim
 * implementation stay explicit until they expose semantic capability metadata.
 */
export function shouldPreferSlimBloomReplay( inputNode, exampleName = '' ) {

	if ( inputNode && inputNode.isPassNode === true ) return true;
	return typeof exampleName === 'string' && (
		exampleName.startsWith( 'webgpu_volume_' ) ||
		exampleName === 'webgpu_postprocessing_lensflare.html' ||
		exampleName === 'webgpu_water.html'
	);

}

/**
 * Keep only owner-local update hooks on Bloom's captured high-pass material.
 *
 * RenderPipeline schedules render-target producers and postprocess effects
 * before Bloom. Replaying one of those hooks again from inside Bloom's open
 * high-pass render pass creates an unscheduled nested render with no unique
 * render-target owner. The caller supplies the pipeline-effect classifier so
 * this policy remains a small, independently testable ownership boundary.
 */
export function shouldRetainBloomHighPassUpdateBeforeNode( node, isPipelineOwnedEffectNode = null ) {

	if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) ) return false;
	if ( node.isPassNode === true || node.isRTTNode === true ) return false;
	if ( typeof isPipelineOwnedEffectNode === 'function' && isPipelineOwnedEffectNode( node ) === true ) return false;
	return true;

}

/**
 * Read AfterImage's two live sampler textures without collapsing its
 * history/current ping-pong pair.
 *
 * `getTextureNode()` exposes the composited output while `_textureNodeOld`
 * exposes the history texture sampled by the material. Falling back to the
 * owned render targets keeps the helper compatible with adjacent Three
 * revisions without treating both aliases as the same output texture.
 */
export function selectAfterImageReplayTextures( node ) {

	if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) ) {

		return { oldTexture: null, compTexture: null };

	}
	let oldTexture = null;
	let compTexture = null;
	try {

		oldTexture = node._textureNodeOld && node._textureNodeOld.value ||
			node._oldRT && node._oldRT.texture ||
			null;

	} catch ( _ ) {}
	try {

		const textureNode = typeof node.getTextureNode === 'function'
			? node.getTextureNode()
			: node._textureNode;
		compTexture = textureNode && textureNode.value ||
			node._compRT && node._compRT.texture ||
			null;

	} catch ( _ ) {}
	return {
		oldTexture: oldTexture && oldTexture.isTexture === true ? oldTexture : null,
		compTexture: compTexture && compTexture.isTexture === true ? compTexture : null,
	};

}

/**
 * Select the first usable effect size in priority order.
 *
 * Full-renderer effect dependencies may execute while that renderer is
 * temporarily sized for another 1x1 post-process target. The presentation
 * renderer's last known drawing-buffer size is therefore authoritative; a
 * fallback renderer size is only useful when no presentation size exists.
 */
export function selectReplayEffectSize( ...candidates ) {

	for ( const candidate of candidates ) {

		const width = Number( candidate && ( candidate.width ?? candidate.x ) );
		const height = Number( candidate && ( candidate.height ?? candidate.y ) );
		if ( Number.isFinite( width ) && Number.isFinite( height ) && width > 1 && height > 1 ) {

			return { width: Math.round( width ), height: Math.round( height ) };

		}

	}
	return null;

}

/**
 * Return authored RTT inputs that a nested frame effect must render before its
 * update hook consumes them.
 *
 * TemporalReprojectNode receives its beauty input through convertToTexture().
 * When that input is another effect (for example SSR), Three creates an RTTNode
 * that can live only behind RecurrentDenoiseNode's dynamic PassTextureNode
 * dependency. It is therefore absent from the RenderPipeline's static RTT
 * collection and must be scheduled at the dependency boundary.
 */
export function selectFrameEffectInputRTTProducers( effectNode ) {

	if ( ! effectNode || ( typeof effectNode !== 'object' && typeof effectNode !== 'function' ) ) return [];
	const textureNode = effectNode.textureNode;
	if ( ! textureNode || textureNode.isPassTextureNode !== true ) return [];
	const temporalNode = textureNode.passNode;
	if ( ! temporalNode ) return [];
	const type = temporalNode.constructor && ( temporalNode.constructor.type || temporalNode.constructor.name ) || temporalNode.type || '';
	if ( temporalNode.isTemporalReprojectNode !== true && type !== 'TemporalReprojectNode' ) return [];
	const beautyNode = temporalNode.beautyNode;
	return beautyNode &&
		beautyNode.isRTTNode === true &&
		beautyNode.renderTarget &&
		beautyNode.node
		? [ beautyNode ]
		: [];

}

/**
 * Return the exact dynamic frame-effect dependency authored through a
 * PassTextureNode edge.
 *
 * The dependency owns its render targets on the renderer that executes its
 * updateBefore hook. Its outputs must not be imported from the presentation
 * renderer before that hook runs, while its own producer inputs still must be.
 */
export function selectFrameEffectOwnedPassDependency( effectNode, isFrameEffectNode ) {

	if ( ! effectNode || ( typeof effectNode !== 'object' && typeof effectNode !== 'function' ) ) return null;
	const textureNode = effectNode.textureNode;
	if ( ! textureNode || textureNode.isPassTextureNode !== true ) return null;
	const dependency = textureNode.passNode;
	return dependency && typeof isFrameEffectNode === 'function' && isFrameEffectNode( dependency ) === true
		? dependency
		: null;

}

/**
 * Adopt a newly prepared RTT fragment graph exactly once per node identity.
 *
 * The material fragment can be a context-wrapped view of the identity, so
 * comparing material.fragmentNode directly would rebuild stable RenderOutput
 * graphs on every scheduled render.
 */
export function refreshRTTMaterialFragmentIdentity( material, fragmentIdentity, fragmentNode = fragmentIdentity ) {

	if ( ! material || ! fragmentIdentity ) return false;
	if ( material.__tslpRTTFragmentIdentity === fragmentIdentity ) return false;
	material.fragmentNode = fragmentNode;
	material.needsUpdate = true;
	try {

		Object.defineProperty( material, '__tslpRTTFragmentIdentity', {
			value: fragmentIdentity,
			configurable: true,
			writable: true,
		} );

	} catch ( _ ) {

		material.__tslpRTTFragmentIdentity = fragmentIdentity;

	}
	return true;

}

/**
 * Select a post-process capture only when renderer-owned pipeline metadata
 * identifies exactly one entry. Graph identity remains the primary production
 * contract; this bounded replay-harness discriminator prevents a stub graph
 * from choosing the first of several normal/reversed/log-depth captures.
 */
export function selectReplayPostprocessAuxEntry( entries, active = {} ) {

	const matches = ( Array.isArray( entries ) ? entries : [] ).filter( ( entry ) => {

		if ( ! entry || entry.shape !== 'post-process' ) return false;
		const captured = entry.artifact && entry.artifact.replayConfig;
		if ( ! captured || captured.schema !== 'render-pipeline@1' ) return false;
		return captured.outputColorTransform === ( active.outputColorTransform === true )
			&& captured.toneMapping === ( active.toneMapping ?? null )
			&& captured.outputColorSpace === ( active.outputColorSpace ?? null )
			&& ( captured.logarithmicDepthBuffer === true ) === ( active.logarithmicDepthBuffer === true )
			&& ( captured.reversedDepthBuffer === true ) === ( active.reversedDepthBuffer === true );

	} );
	const boundConfigHash = typeof active.configHash === 'string' && active.configHash.length > 0
		? active.configHash
		: null;
	if ( boundConfigHash ) {

		const boundMatches = matches.filter( ( entry ) => entry.configHash === boundConfigHash );
		return boundMatches.length === 1 ? boundMatches[ 0 ] : null;

	}
	return matches.length === 1 ? matches[ 0 ] : null;

}

/**
 * Preserve renderer.debug.getShaderAsync() as an inspection API in
 * compiler-free replay. The shader was already captured at build time, so
 * rebuilding it through Three's live node compiler is unnecessary.
 */
export function capturedDebugShaderResult( artifact ) {

	if (
		! artifact ||
		typeof artifact.vertexShader !== 'string' ||
		typeof artifact.fragmentShader !== 'string'
	) return null;

	return {
		vertexShader: artifact.vertexShader,
		fragmentShader: artifact.fragmentShader,
	};

}

/**
 * A shared-device full renderer is a WebGPU-only fallback.
 *
 * WebGPURenderer can own a WebGLBackend when forceWebGL is requested or when
 * WebGPU is unavailable. That backend has no GPUDevice to share with the full
 * WebGPU renderer, while captured PrecompiledCompute nodes can still execute
 * directly on the slim renderer.
 */
export function shouldInitializeSharedDeviceFallback( renderer ) {

	return !! renderer &&
		renderer.__tslpForceWebGLReplay !== true &&
		renderer.backend?.isWebGLBackend !== true;

}

export function slimWebgpuReplayModule( {
	nodeMaterialExports: NODE_MATERIAL_EXPORTS,
	slimBundleBrowserModule: SLIM_BUNDLE_BROWSER_MODULE,
	slimReplayForwardExportBlock: SLIM_REPLAY_FORWARD_EXPORT_BLOCK,
	slimReplayFullFallbackExportBlock: SLIM_REPLAY_FULL_FALLBACK_EXPORT_BLOCK,
	replayOperationDiagnostics,
	slimHashOptions: SLIM_HASH_OPTS,
} ) {

	const materialClasses = NODE_MATERIAL_EXPORTS.map( ( name ) => `
export class ${ name } {
	constructor( params ) {
		let mat;
		// Recreate the source material first and let __prepareSceneForReplay()
		// replace it with a PrecompiledMaterial at render/compile time. This
		// preserves post-constructor mutations and clones (maskNode,
		// receivedShadowPositionNode, colorNode, etc.) so artifact selection sees
		// the final material graph instead of the constructor's partial params.
		mat = __makeInternalNodeMaterial( ${ JSON.stringify( name ) }, params );
		if ( params && typeof params === 'object' ) {
			for ( const key in params ) {
				if ( params[ key ] !== undefined ) __assignParam( mat, key, params[ key ] );
			}
			__wireMaterialTextures( params, mat );
		}
		return mat;
	}
}
` ).join( '\n' );

	return `
import * as Slim from ${ JSON.stringify( SLIM_BUNDLE_BROWSER_MODULE ) };
import { TSL as FullTSL, TextureNode as FullTextureNode, BlendMode as FullBlendMode, TempNode as FullTempNode, NodeUpdateType as FullNodeUpdateType, NodeMaterial as FullNodeMaterial, MeshBasicNodeMaterial as FullMeshBasicNodeMaterial, MeshStandardNodeMaterial as FullMeshStandardNodeMaterial, MeshPhysicalNodeMaterial as FullMeshPhysicalNodeMaterial, MeshLambertNodeMaterial as FullMeshLambertNodeMaterial, MeshPhongNodeMaterial as FullMeshPhongNodeMaterial, MeshToonNodeMaterial as FullMeshToonNodeMaterial, MeshNormalNodeMaterial as FullMeshNormalNodeMaterial, MeshMatcapNodeMaterial as FullMeshMatcapNodeMaterial, MeshSSSNodeMaterial as FullMeshSSSNodeMaterial, VolumeNodeMaterial as FullVolumeNodeMaterial, LineBasicNodeMaterial as FullLineBasicNodeMaterial, LineDashedNodeMaterial as FullLineDashedNodeMaterial, Line2NodeMaterial as FullLine2NodeMaterial, PointsNodeMaterial as FullPointsNodeMaterial, SpriteNodeMaterial as FullSpriteNodeMaterial, ShadowNodeMaterial as FullShadowNodeMaterial, RenderTarget as FullRenderTarget, DepthTexture as FullDepthTexture, ArrayCamera as FullArrayCamera, Controls as FullControls, MOUSE as FullMOUSE, MathUtils as FullMathUtils, Plane as FullPlane, Quaternion as FullQuaternion, Ray as FullRay, Spherical as FullSpherical, TOUCH as FullTOUCH, QuadMesh as FullQuadMesh, RendererUtils as FullRendererUtils, Vector2 as FullVector2, Vector3 as FullVector3, CubeRenderTarget as FullCubeRenderTarget, TextureLoader as FullTextureLoader, CubeTextureLoader as FullCubeTextureLoader, DataTextureLoader as FullDataTextureLoader, ImageBitmapLoader as FullImageBitmapLoader } from '/build/three.webgpu.js';
import { createLiveSceneIndex, textureImageReady as __sharedTextureImageReady, textureImageSrc as __sharedTextureImageSrc, newFallbackTextureImage as __sharedNewFallbackTextureImage } from '/__tslp_runtime/slim-support/live-scene-index.js';
import { artifactNeedsPMREM as __sharedArtifactNeedsPMREM, artifactPMREMSourceUuids as __sharedArtifactPMREMSourceUuids, attachPMREMRefsByOrder as __sharedAttachPMREMRefsByOrder, collectPMREMSourceTexturesFromMaterial as __sharedCollectPMREMSourceTexturesFromMaterial, collectPMREMSourceTexturesInNode as __sharedCollectPMREMSourceTexturesInNode, createPMREMSupport as __sharedCreatePMREMSupport, isPMREMArtifactTextureSource as __sharedIsPMREMArtifactTextureSource, isPMREMTexture as __sharedIsPMREMTexture, selectPMREMTexturesForArtifact as __sharedSelectPMREMTexturesForArtifact, textureListSignature as __sharedTextureListSignature } from '/__tslp_runtime/slim-support/pmrem.js';
import { clearTextureViewCache as __sharedClearTextureViewCache, isBorrowedShadowRenderTargetTexture as __sharedIsBorrowedShadowRenderTargetTexture, markTextureInitialized as __sharedMarkTextureInitialized, shareGPUTextureEntry as __sharedShareGPUTextureEntry, sharePMREMGPUTexture as __sharedSharePMREMGPUTexture, shareShadowGPUTextureIntoSlim as __sharedShareShadowGpuTextureIntoSlim } from '/__tslp_runtime/slim-support/gpu-texture-share.js';
import { computeNodeUsesStorageTexture as __sharedComputeNodeUsesStorageTexture, computeSyncNeedsPresentation as __sharedComputeSyncNeedsPresentation, hasAnonymousStorageResourceIdentity as __sharedHasAnonymousStorageResourceIdentity, invokeAlignedFullCompute as __sharedInvokeAlignedFullCompute, shareComputeSampledInputs as __sharedShareComputeSampledInputs, syncComputeStorageOutputs as __sharedSyncComputeStorageOutputs, syncComputeStorageOutputsPerPass as __sharedSyncComputeStorageOutputsPerPass, wireArtifactStorageBuffersFromAttributes as __sharedWireArtifactStorageBuffersFromAttributes, pingPongInvalidate as __sharedPingPongInvalidate, shareInstancedAttributeBufferIntoSlim as __sharedShareInstancedAttributeBufferIntoSlim } from '/__tslp_runtime/slim-support/compute-sync.js';
import { AUTO_COMPUTE_MATERIAL_PROPERTIES as __AUTO_COMPUTE_SLOTS, createAutoComputeDispatcher as __sharedCreateAutoComputeDispatcher } from '/__tslp_runtime/slim-support/auto-compute.js';
import { artifactHasTextureSource as __sharedArtifactHasTextureSource, attachArtifactTextureRefsByShapeOrder as __sharedAttachArtifactTextureRefsByShapeOrder, attachArtifactTextureRefsWhere as __sharedAttachArtifactTextureRefsWhere, attachExactMaterialGraphDepthTextureRefs as __sharedAttachExactMaterialGraphDepthTextureRefs, attachTextureRefsWhere as __sharedAttachTextureRefsWhere, countArtifactTextureSources as __sharedCountArtifactTextureSources, rewritePassDepthTextureSources as __sharedRewritePassDepthTextureSources, singleArtifactTextureUuid as __sharedSingleArtifactTextureUuid, textureMatchesArtifactSource as __sharedTextureMatchesArtifactSource, textureMatchesSource as __sharedTextureMatchesSource } from '/__tslp_runtime/slim-support/artifact-texture-wiring.js';
import { createFullRendererFallback as __sharedCreateFullRendererFallback } from '/__tslp_runtime/slim-support/full-renderer-fallback.js';
import { createSlimSceneSupport as __sharedCreateSlimSceneSupport } from '/__tslp_runtime/slim-support/scene-support.js';
import { updateRendererLightingForSlim as __sharedUpdateRendererLightingForSlim } from '/__tslp_runtime/slim-support/renderer-lighting.js';
import { artifactLooksLikeRetroPassMaterial as __sharedArtifactLooksLikeRetroPassMaterial, prepareEffectNodeForReplay as __sharedPrepareEffectNodeForReplay } from '/__tslp_runtime/slim-support/postprocess-effects-replay.js';
import { refreshPreparedPostprocessResources as __sharedRefreshPreparedPostprocessResources } from '/__tslp_runtime/slim-support/postprocess-resource-refresh.js';
import { findEffectHandler as __sharedFindEffectHandler } from '/__tslp_runtime/slim-support/postprocess-effects.js';
import { wireLiveUniformSidecarsToArtifact as __sharedWireLiveUniformSidecarsToArtifact } from '/__tslp_runtime/slim-support/live-node-sidecars.js';
import { getTemporalFrameState as __sharedGetTemporalFrameState, withTemporalFrame as __sharedWithTemporalFrame } from '/__tslp_runtime/slim-support/temporal-frame.js';
import { createIsolatedFrameEffectNodeFrame as __sharedCreateIsolatedFrameEffectNodeFrame } from '/__tslp_runtime/slim-support/frame-effect-node-frame.js';
import { prepareAfterImageReplayResources as __sharedPrepareAfterImageReplayResources } from '/__tslp_runtime/slim-support/afterimage-replay.js';
import { POSTPROCESS_FRAME_ROLES as __POSTPROCESS_FRAME_ROLES, createPostprocessFrameScheduler as __sharedCreatePostprocessFrameScheduler } from '/__tslp_runtime/slim-support/postprocess-frame-scheduler.js';
import { getLiveNodeDependencies as __sharedGetLiveNodeDependencies } from '/__tslp_runtime/slim-support/node-dependencies.js';
import { installVelocityProjectionLifecycle as __installVelocityProjectionLifecycle } from '/__tslp_runtime/slim-support/velocity-projection-lifecycle.js';
import { createPostprocessExecutionPlan as __sharedCreatePostprocessExecutionPlan, postprocessGraphContains as __sharedPostprocessGraphContains } from '/__tslp_runtime/slim-support/postprocess-execution-plan.js';
import { renderOffscreenOverrideWithFullRenderer as __sharedRenderOffscreenOverrideWithFullRenderer } from '/__tslp_runtime/slim-support/pass-render-fallback.js';
import { findAux as __runtimeFindAux } from '/__tslp_runtime/aux-loader.js';
import { inspectRuntimeMaterialComputeFamily as __sharedInspectRuntimeMaterialComputeFamily } from '/__tslp_runtime/hydrate/material-compute-ownership.js';
import { MATERIAL_TEXTURE_PROPS as __TEXTURE_PROPS, MATERIAL_NODE_TEXTURE_KEYS as __NODE_GRAPH_KEYS } from '/__tslp_contract/texture-props.js';
import { countArtifactFragmentOutputCapacity as __sharedCountArtifactFragmentOutputCapacity, countArtifactFragmentOutputs as __sharedCountArtifactFragmentOutputs } from '/__tslp_contract/fragment-outputs.js';
import { createRenderObjectContextSelector as __createRenderObjectContextSelector, projectRenderObjectContextSelector as __projectRenderObjectContextSelector } from '/__tslp_contract/render-selector.js';
import { materializeArtifactAttributeDescriptors as __materializeArtifactAttributeDescriptors } from '/__tslp_contract/attribute-generators.js';
import { materializeArtifactVariantSelectorAdapters as __materializeArtifactVariantSelectorAdapters } from '/__tslp_contract/variant-selector-adapter.js';
import { createMaterialContextKey as __createMaterialContextKey, createObjectIdentityKeyer as __createObjectIdentityKeyer, createStockMaterialTopologyKey as __createStockMaterialTopologyKey, getMaterialContextMap as __getMaterialContextMap, getSceneTopologyMap as __getSceneTopologyMap } from '/__tslp_batch/material-context-cache.mjs';
import { passRendersMaterial as __passRendersMaterial } from '/__tslp_batch/pass-material-visibility.mjs';
import { createPresentationReadinessState as __sharedCreatePresentationReadinessState, markPresentationDeferred as __sharedMarkPresentationDeferred, markPresentationSuccessful as __sharedMarkPresentationSuccessful } from '/__tslp_batch/presentation-readiness.mjs';
import { synchronizeTemporalJitterNode as __sharedSynchronizeTemporalJitterNode, temporalJitterFrameId as __sharedTemporalJitterFrameId } from '/__tslp_batch/temporal-jitter.mjs';
import { findVsmBlurTexture as __findVsmBlurTexture } from '/__tslp_batch/vsm-blur-texture.mjs';
import { compileDoublePassPairsSynchronously as __compileDoublePassPairsSynchronously, suppressWebGPUFramebufferCopiesDuringCompile as __suppressWebGPUFramebufferCopiesDuringCompile } from '/__tslp_plugin/vendor/compile-async-double-pass.js';
${ SLIM_REPLAY_FORWARD_EXPORT_BLOCK }
${ SLIM_REPLAY_FULL_FALLBACK_EXPORT_BLOCK }
export { FullTextureNode as TextureNode, FullBlendMode as BlendMode, FullTempNode as TempNode, FullNodeUpdateType as NodeUpdateType, FullArrayCamera as ArrayCamera, FullControls as Controls, FullMOUSE as MOUSE, FullMathUtils as MathUtils, FullPlane as Plane, FullQuaternion as Quaternion, FullRay as Ray, FullSpherical as Spherical, FullTOUCH as TOUCH, FullQuadMesh as QuadMesh, FullRendererUtils as RendererUtils, FullVector2 as Vector2, FullVector3 as Vector3 };

const __state = window.__TSLP_E2E || { example: 'unknown', artifacts: { user: {}, aux: [] } };
const __data = __state.artifacts || { user: {}, aux: [] };
const __presentationReadiness = __sharedCreatePresentationReadinessState();
window.__tslpPresentationReadiness = __presentationReadiness;
const __debugReplayOperations = ${ JSON.stringify( replayOperationDiagnostics ) };
const __shouldDeferReplayRenderForLoader = ${ shouldDeferReplayRenderForLoader.toString() };
const __shouldDeferReplayPostprocessForLoader = ${ shouldDeferReplayPostprocessForLoader.toString() };
const __shouldPreferSlimBloomReplay = ${ shouldPreferSlimBloomReplay.toString() };
const __shouldRetainBloomHighPassUpdateBeforeNode = ${ shouldRetainBloomHighPassUpdateBeforeNode.toString() };
const __selectAfterImageReplayTextures = ${ selectAfterImageReplayTextures.toString() };
const __selectReplayEffectSize = ${ selectReplayEffectSize.toString() };
const __selectFrameEffectInputRTTProducers = ${ selectFrameEffectInputRTTProducers.toString() };
const __selectFrameEffectOwnedPassDependency = ${ selectFrameEffectOwnedPassDependency.toString() };
const __refreshRTTMaterialFragmentIdentity = ${ refreshRTTMaterialFragmentIdentity.toString() };
const __selectReplayPostprocessAuxEntry = ${ selectReplayPostprocessAuxEntry.toString() };
const __capturedDebugShaderResult = ${ capturedDebugShaderResult.toString() };
const __shouldInitializeSharedDeviceFallback = ${ shouldInitializeSharedDeviceFallback.toString() };
const __selectLateRenderTargetTexturePair = ${ selectLateRenderTargetTexturePair.toString() };
let __replayOperationSequence = 0;
function __replayOperationNow() {
	try { return typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now(); } catch ( _ ) { return 0; }
}
function __replayTargetLabel( target ) {
	if ( ! target ) return 'default';
	const colors = Array.isArray( target.textures ) ? target.textures : target.texture ? [ target.texture ] : [];
	const colorTypes = colors.map( ( texture ) => texture && texture.type ).join( ',' );
	const depthType = target.depthTexture && target.depthTexture.type;
	return ( target.isCubeRenderTarget === true ? 'cube' : 'offscreen' ) +
		':colors=' + ( colorTypes || 'none' ) +
		':depth=' + ( depthType === undefined || depthType === null ? 'none' : depthType );
}
function __replayOperationDetail( kind, args ) {
	const first = args && args[ 0 ];
	if ( kind === 'compute' || kind === 'computeAsync' ) {
		return first && ( first.name || first.label || first.constructor && first.constructor.name ) || '<compute>';
	}
	if ( kind === 'setRenderTarget' ) return __replayTargetLabel( first );
	if ( kind === 'render' ) {
		let target = null;
		try { target = this && typeof this.getRenderTarget === 'function' ? this.getRenderTarget() : null; } catch ( _ ) {}
		return ( first && ( first.name || first.type || first.constructor && first.constructor.name ) || '<renderable>' ) +
			'@' + __replayTargetLabel( target );
	}
	if ( kind === 'renderObject' ) {
		const object = first;
		const material = args && args[ 4 ];
		return ( object && ( object.name || object.type ) || '<object>' ) + '->' +
			( material && ( material.name || material.type ) || '<material>' );
	}
	if ( kind === 'background.update' ) {
		const scene = first;
		let target = null;
		try { target = this && this.renderer && typeof this.renderer.getRenderTarget === 'function' ? this.renderer.getRenderTarget() : null; } catch ( _ ) {}
		return ( scene && ( scene.name || scene.type ) || '<scene>' ) + '@' + __replayTargetLabel( target );
	}
	if ( kind === 'QuadMesh.render' ) {
		const material = this && this.material;
		return material && ( material.name || material.type ) || '<quad-material>';
	}
	return '';
}

function __markSuccessfulReplayPresentation( renderer ) {
	if ( ! renderer || renderer.__tslpMaterialComputePresentationRender === true ) return;
	let target = null;
	try { target = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null; } catch ( _ ) {}
	if ( target !== null ) return;
	__sharedMarkPresentationSuccessful( __presentationReadiness );
	try {
		const diag = __harnessDiagnostics();
		diag.successfulPresentations = __presentationReadiness.successful | 0;
	} catch ( _ ) {}
}
function __beginReplayOperation( kind, detail ) {
	if ( ! __debugReplayOperations ) return 0;
	const record = {
		id: ++ __replayOperationSequence,
		phase: 'start',
		kind,
		detail: String( detail || '' ),
		realMs: __replayOperationNow(),
	};
	const trace = window.__tslpReplayOperationTrace || ( window.__tslpReplayOperationTrace = [] );
	const diagnostics = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
	if ( diagnostics.replayOperationTrace !== trace ) diagnostics.replayOperationTrace = trace;
	if ( trace.length < 2048 ) trace.push( record );
	console.log( '[tslp-replay-op] ' + JSON.stringify( record ) );
	return record.id;
}
function __endReplayOperation( id, kind, detail, error = null ) {
	if ( ! __debugReplayOperations || ! id ) return;
	const record = {
		id,
		phase: error ? 'error' : 'end',
		kind,
		detail: String( detail || '' ),
		realMs: __replayOperationNow(),
		...( error ? { error: String( error && ( error.message || error ) || error ) } : {} ),
	};
	const trace = window.__tslpReplayOperationTrace || ( window.__tslpReplayOperationTrace = [] );
	if ( trace.length < 2048 ) trace.push( record );
	console.log( '[tslp-replay-op] ' + JSON.stringify( record ) );
}
function __withReplayOperation( kind, detail, callback ) {
	if ( ! __debugReplayOperations ) return callback();
	const operationId = __beginReplayOperation( kind, detail );
	try {
		const result = callback();
		if ( result && typeof result.then === 'function' ) {
			return Promise.resolve( result ).then(
				( value ) => { __endReplayOperation( operationId, kind, detail ); return value; },
				( error ) => { __endReplayOperation( operationId, kind, detail, error ); throw error; },
			);
		}
		__endReplayOperation( operationId, kind, detail );
		return result;
	} catch ( error ) {
		__endReplayOperation( operationId, kind, detail, error );
		throw error;
	}
}
if ( __debugReplayOperations ) {
	window.__tslpReplayHydrationPhaseTrace = function ( phase, detail, callback ) {
		const kind = 'hydrateNodeBuilderState.' + String( phase || 'unknown' );
		const operationId = __beginReplayOperation( kind, detail );
		try {
			const result = callback();
			__endReplayOperation( operationId, kind, detail );
			return result;
		} catch ( error ) {
			__endReplayOperation( operationId, kind, detail, error );
			throw error;
		}
	};
}
const __artifactEntries = [
	...Object.values( __data.user || {} ),
	...( Array.isArray( __data.aux ) ? __data.aux : [] ),
];
__materializeArtifactAttributeDescriptors( __artifactEntries );
__materializeArtifactVariantSelectorAdapters( __artifactEntries );

function __tslpLoaderBasename( value ) {
	const raw = String( value || '' );
	const tail = raw.split( /[?#]/ )[ 0 ].split( '/' ).filter( Boolean ).pop() || raw;
	return tail || '';
}

window.__tslpMarkLoaderTexture = function ( texture, url ) {
	if ( ! texture || texture.isTexture !== true ) return texture;
	const name = __tslpLoaderBasename( url );
	if ( name && ! texture.name ) texture.name = name;
	try {
		texture.userData = texture.userData || {};
		if ( typeof url === 'string' && url.length > 0 ) texture.userData.__tslpLoaderUrl = url;
	} catch ( _ ) {}
	try {
		if ( typeof Slim.registerLiveTexture === 'function' ) Slim.registerLiveTexture( texture );
	} catch ( _ ) {}
	try {
		if ( typeof window.__tslpRememberLiveTexture === 'function' ) window.__tslpRememberLiveTexture( texture );
	} catch ( _ ) {}
	return texture;
};

window.__tslpPatchTextureLoaderClass = function ( Ctor ) {
	if ( ! Ctor || ! Ctor.prototype || typeof Ctor.prototype.load !== 'function' || Ctor.prototype.__tslpCallbackLoadPatched ) return;
	Ctor.prototype.__tslpCallbackLoadPatched = true;
	const origLoad = Ctor.prototype.load;
	const _now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	Ctor.prototype.load = function ( url, onLoad, onProgress, onError ) {
		window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
		window.__tslpLoaderLastBusyAt = _now();
		let settled = false;
		const settle = () => {
			if ( settled ) return;
			settled = true;
			window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
			window.__tslpLoaderLastBusyAt = _now();
		};
		const wrapLoad = ( texture, ...rest ) => {
			window.__tslpMarkLoaderTexture( texture, url );
			try { if ( typeof onLoad === 'function' ) return onLoad.call( this, texture, ...rest ); }
			finally { settle(); }
		};
		const wrapError = ( err, ...rest ) => {
			try { if ( typeof onError === 'function' ) return onError.call( this, err, ...rest ); }
			finally { settle(); }
		};
		try {
			const result = origLoad.call( this, url, wrapLoad, onProgress, wrapError );
			window.__tslpMarkLoaderTexture( result, url );
			return result;
		} catch ( err ) {
			settle();
			throw err;
		}
	};
	};

	function __syncFramebufferTextureForActiveTarget( renderer, texture, rectangle = null ) {
		if ( ! renderer || ! texture || texture.isFramebufferTexture !== true ) return null;
		const context = renderer._currentRenderContext || null;
		const target = context && context.renderTarget || null;
		const source = target && target.texture || null;
		if ( ! source ) return null;
		const targetWidth = Number( target.width || source.image && source.image.width || 0 );
		const targetHeight = Number( target.height || source.image && source.image.height || 0 );
		const copyX = Number( rectangle && rectangle.x || 0 );
		const copyY = Number( rectangle && rectangle.y || 0 );
		const copyWidth = Number( rectangle && ( rectangle.width ?? rectangle.z ) || texture.image && texture.image.width || 0 );
		const copyHeight = Number( rectangle && ( rectangle.height ?? rectangle.w ) || texture.image && texture.image.height || 0 );
		if ( rectangle && targetWidth > 0 && targetHeight > 0 && copyWidth > 0 && copyHeight > 0 && (
			copyX < 0 || copyY < 0 || copyX + copyWidth > targetWidth || copyY + copyHeight > targetHeight
		) ) return null;
		let currentTarget = null;
		try { currentTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null; } catch ( _ ) {}
		const previousTarget = renderer._renderTarget;
		const patchTarget = ! currentTarget && previousTarget !== target;
		let changed = false;
		for ( const key of [ 'format', 'type', 'colorSpace' ] ) {
			if ( source[ key ] !== undefined && texture[ key ] !== source[ key ] ) {
				texture[ key ] = source[ key ];
				changed = true;
			}
		}
		if ( changed ) texture.needsUpdate = true;
		if ( patchTarget ) renderer._renderTarget = target;
		return () => {
			if ( patchTarget ) renderer._renderTarget = previousTarget;
		};
	}

	// Worker-async loaders (KTX2Loader, DRACOLoader, MeshoptLoader) decode in
	// web workers AFTER FileLoader.load resolves manager.itemEnd, so the outer
// manager-pending counter drops to zero while parse is still in flight.
// Without this, the synthetic-rAF clock can freeze before the user's
// \`await ktxLoader.loadAsync(...)\` resumes and adds the post-await meshes —
// the first render with content never fires (see webgpu_sandbox.html which
// uses await ktxLoader.loadAsync(...) before adding any mesh to scene).
// Wrap Loader.prototype.loadAsync so __tslpLoaderPending stays bumped until
// the full promise (load + parse) resolves.
( function patchSlimLoaderLoadAsync() {
	const L = Slim.Loader;
	if ( ! L || ! L.prototype || L.prototype.__tslpLoadAsyncPatched ) return;
	L.prototype.__tslpLoadAsyncPatched = true;
	const origLoad = L.prototype.load;
	const origLoadAsync = L.prototype.loadAsync;
	const _now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	if ( typeof origLoad === 'function' ) {
		L.prototype.load = function ( url, onLoad, onProgress, onError ) {
			const touch = () => { window.__tslpLoaderLastBusyAt = _now(); };
			window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
			let settled = false;
			const settle = () => {
				if ( settled ) return;
				settled = true;
				window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
				touch();
			};
			touch();
			const wrap = ( cb, shouldSettle = false ) => typeof cb === 'function'
				? ( ...args ) => {
					try { return cb.apply( this, args ); }
					finally { shouldSettle ? settle() : touch(); }
				}
				: shouldSettle ? ( ..._args ) => settle() : cb;
			try {
				return origLoad.call( this, url, wrap( onLoad, true ), onProgress, wrap( onError, true ) );
			} catch ( err ) {
				settle();
				throw err;
			}
		};
	}
	if ( typeof origLoadAsync !== 'function' ) return;
	L.prototype.loadAsync = function ( ...args ) {
		window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
		window.__tslpLoaderLastBusyAt = _now();
		return origLoadAsync.apply( this, args ).finally( () => {
			window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
			window.__tslpLoaderLastBusyAt = _now();
		} );
	};
} )();

	const __livePassNodes = [];
	let __activePipelinePassNodes = null;
	let __passNodeSequence = 0;

	function __makePassTextureNode( passNode, name = 'output', previous = false ) {
		const texture = previous ? passNode.getPreviousTexture( name ) : passNode.getTexture( name );
		const node = new FullTextureNode( texture );
		node.passNode = passNode;
		node.textureName = name;
		node.previousTexture = previous;
		node.isPassTextureNode = true;
		node.isPassMultipleTextureNode = true;
		node.updateTexture = function () {
			this.value = this.previousTexture ? this.passNode.getPreviousTexture( this.textureName ) : this.passNode.getTexture( this.textureName );
		};
		try { if ( typeof node.setUpdateMatrix === 'function' ) node.setUpdateMatrix( false ); } catch ( _ ) {}
		return node;
	}

	function __mrtOutputCount( mrt ) {
		return mrt && mrt.outputNodes && typeof mrt.outputNodes === 'object' ? Object.keys( mrt.outputNodes ).length : 0;
	}

	function __mrtFromRenderTarget( renderTarget ) {
		const textures = renderTarget && Array.isArray( renderTarget.textures ) ? renderTarget.textures : [];
		if ( textures.length <= 1 ) return null;
		const names = textures.map( ( texture, index ) => texture && texture.name || ( index === 0 ? 'output' : 'output' + index ) );
		const key = names.join( '|' );
		if ( renderTarget.__tslpMRTStub && renderTarget.__tslpMRTStub.__tslpKey === key ) return renderTarget.__tslpMRTStub;
		const outputNodes = {};
		for ( const name of names ) outputNodes[ name ] = { isNode: true };
		const mrt = {
			isNode: true,
			isMRTNode: true,
			id: 'tslp-render-target-mrt:' + key,
			outputNodes,
			__tslpKey: key,
			getBlendMode() { return { blending: 0 }; },
			has( name ) { return name in outputNodes; },
			get( name ) { return outputNodes[ name ] || null; },
			merge( other ) { return other || this; },
		};
		try { Object.defineProperty( renderTarget, '__tslpMRTStub', { value: mrt, configurable: true, writable: true } ); }
		catch ( _ ) { renderTarget.__tslpMRTStub = mrt; }
		return mrt;
	}

	function __makePassDepthTexture( renderTarget ) {
		const depthTexture = new Slim.DepthTexture();
		depthTexture.isRenderTargetTexture = true;
		depthTexture.name = 'depth';
		depthTexture.renderTarget = renderTarget;
		return depthTexture;
	}

	function __refreshPassTextureNodes( passNode ) {
		if ( ! passNode ) return;
		for ( const node of Object.values( passNode._textureNodes || {} ) ) {
			try { if ( node && typeof node.updateTexture === 'function' ) node.updateTexture(); } catch ( _ ) {}
		}
		for ( const node of Object.values( passNode._previousTextureNodes || {} ) ) {
			try { if ( node && typeof node.updateTexture === 'function' ) node.updateTexture(); } catch ( _ ) {}
		}
	}

	function __countArtifactFragmentOutputsSafe( artifact, fallback = 1 ) {
		if ( typeof __sharedCountArtifactFragmentOutputs === 'function' ) return __sharedCountArtifactFragmentOutputs( artifact, fallback );
		if ( ! artifact ) return fallback;
		if ( Array.isArray( artifact.fragmentOutputs ) ) return artifact.fragmentOutputs.length;
		if ( Array.isArray( artifact.mrtOutputNames ) && artifact.mrtOutputNames.length > 0 ) return artifact.mrtOutputNames.length;
		if ( typeof artifact.mrtOutputCount === 'number' && artifact.mrtOutputCount > 0 ) return artifact.mrtOutputCount;
		return fallback;
	}

	function __countArtifactFragmentOutputCapacitySafe( artifact, fallback = 1 ) {
		if ( typeof __sharedCountArtifactFragmentOutputCapacity === 'function' ) return __sharedCountArtifactFragmentOutputCapacity( artifact, fallback );
		if ( ! artifact ) return fallback;
		let maxCount = __countArtifactFragmentOutputsSafe( artifact, fallback );
		const variants = artifact.variants && typeof artifact.variants === 'object' ? artifact.variants : null;
		if ( variants ) {
			for ( const variant of Object.values( variants ) ) {
				maxCount = Math.max( maxCount, __countArtifactFragmentOutputsSafe( variant, fallback ) );
			}
		}
		return maxCount;
	}

	function __fragmentOutputCount( material ) {
		const artifact = material && material.precompiledArtifact;
		if ( ! artifact ) return 1;
		return __countArtifactFragmentOutputCapacitySafe( artifact, 1 );
	}

	function __backgroundAuxCanRenderMRT( mrt ) {
		const targetCount = __mrtOutputCount( mrt );
		if ( targetCount <= 1 ) return true;
		const aux = Array.isArray( __data.aux ) ? __data.aux : [];
		for ( const entry of aux ) {
			if ( ! entry || entry.shape !== 'background' || ! entry.artifact ) continue;
			if ( __fragmentOutputCount( { precompiledArtifact: entry.artifact } ) >= targetCount ) return true;
		}
		return false;
	}

	function __syncPassRenderTargetTextures( passNode, mrt ) {
		const target = passNode && passNode.renderTarget;
		if ( ! target || ! Array.isArray( target.textures ) ) return;
		if ( ! target.texture && target.textures[ 0 ] ) target.texture = target.textures[ 0 ];
		if ( target.texture ) passNode._textures.output = target.texture;
		if ( target.depthTexture ) passNode._textures.depth = target.depthTexture;
		// Specialized r185 PassNode subclasses allocate their extra attachments
		// lazily from setup(). Compiler-free replay bypasses that builder hook.
		// Preserve every attachment already created by author getTexture() calls,
		// then append only still-missing declared outputs. This keeps the exact
		// access order used by ordinary passes (notably SSR denoise) while making
		// deferred subclasses such as PixelationPassNode complete.
		const outputNodes = mrt && mrt.outputNodes;
		if ( outputNodes && typeof outputNodes === 'object' ) {
			for ( const name of Object.keys( outputNodes ) ) {
				if ( name === 'depth' || passNode._textures[ name ] ) continue;
				try { passNode.getTexture( name ); } catch ( _ ) {}
			}
		}
		for ( const texture of Object.values( passNode._textures || {} ) ) {
			if ( ! texture || texture === target.depthTexture || target.textures.includes( texture ) ) continue;
			texture.isRenderTargetTexture = true;
			texture.renderTarget = target;
			target.textures.push( texture );
		}
		__refreshPassTextureNodes( passNode );
	}

function __sceneCanRenderMRT( scene, mrt, passNode = null ) {
	const targetCount = __mrtOutputCount( mrt );
	if ( targetCount <= 1 || ! scene || typeof scene.traverse !== 'function' ) return true;
	let ok = true;
		scene.traverse( ( object ) => {
			if ( ! ok || ! object || ! object.material ) return;
			const materials = Array.isArray( object.material ) ? object.material : [ object.material ];
			for ( const material of materials ) {
				if ( ! __passRendersMaterial( passNode, material ) ) continue;
				if ( material && material.visible !== false && __fragmentOutputCount( material ) < targetCount ) {
					ok = false;
					break;
				}
			}
	} );
	return ok;
}

function __selectPassMRTRenderPath( scene, requestedMRT, passNode = null ) {
	const replayMRT = requestedMRT || null;
	const canRenderPrecompiledMRT = !! ( replayMRT && __sceneCanRenderMRT( scene, replayMRT, passNode ) );
	return {
		replayMRT,
		canRenderPrecompiledMRT,
		needsFullMRTPass: !! ( replayMRT && ! canRenderPrecompiledMRT ),
	};
}

function __prepareSceneMaterialsForMRTReplay( scene, mrt, passNode = null ) {
	const targetCount = __mrtOutputCount( mrt );
	if ( targetCount <= 1 || ! scene || typeof scene.traverse !== 'function' ) return;
	scene.traverse( ( object ) => {
		const material = object && object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const mat of list ) {
			if ( ! __passRendersMaterial( passNode, mat ) ) continue;
			if ( ! mat || mat.isPrecompiledMaterial !== true ) continue;
			if ( __fragmentOutputCount( mat ) < targetCount ) continue;
			if ( mat.mrtNode !== mrt ) mat.mrtNode = mrt;
			mat.needsUpdate = true;
		}
	} );
}

function __resetRendererPipelineCachesForMRTReplay( renderer, mrt ) {
	if ( __mrtOutputCount( mrt ) <= 1 || ! renderer ) return;
	try { if ( renderer._pipelines && typeof renderer._pipelines.dispose === 'function' ) renderer._pipelines.dispose(); } catch ( _ ) {}
	try { if ( renderer._objects && typeof renderer._objects.dispose === 'function' ) renderer._objects.dispose(); } catch ( _ ) {}
}

function __sceneHasMultiOutputPrecompiledMaterial( scene ) {
	let found = false;
	const visit = ( object ) => {
		if ( found || ! object ) return;
		const material = object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const mat of list ) {
			if ( mat && mat.isPrecompiledMaterial === true && __fragmentOutputCount( mat ) > 1 ) {
				found = true;
				return;
			}
		}
	};
	visit( scene );
	try {
		if ( ! found && scene && typeof scene.traverse === 'function' ) scene.traverse( visit );
	} catch ( _ ) {}
	return found;
}

// VolumeNodeMaterial needs special pass discovery because its ray-march reads
// earlier-pass depth and live 3D/offset textures. Keep the actual pass on the
// captured WGSL path; the full-renderer source pass loses the replay harness'
// ordered pass-depth/texture wiring.
function __sceneHasVolumeNodeMaterial( scene ) {
	let found = false;
	const visit = ( object ) => {
		if ( found || ! object ) return;
		const material = object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const mat of list ) {
			if ( ! mat ) continue;
			if ( mat.isVolumeNodeMaterial === true ) { found = true; return; }
			if ( mat.__tslpSourceMaterial && mat.__tslpSourceMaterial.isVolumeNodeMaterial === true ) { found = true; return; }
		}
	};
	visit( scene );
	try {
		if ( ! found && scene && typeof scene.traverse === 'function' ) scene.traverse( visit );
	} catch ( _ ) {}
	return found;
}

function __sceneHasBackdropNodeMaterial( scene ) {
	let found = false;
	const visit = ( object ) => {
		if ( found || ! object ) return;
		const material = object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const mat of list ) {
			if ( ! mat ) continue;
			const source = mat.__tslpSourceMaterial || mat;
			if ( source.backdropNode || source.backdropAlphaNode ) { found = true; return; }
		}
	};
	visit( scene );
	try {
		if ( ! found && scene && typeof scene.traverse === 'function' ) scene.traverse( visit );
	} catch ( _ ) {}
	return found;
}

function __resetRendererPipelineCachesForAttachmentChange( renderer, scene ) {
	if ( ! renderer || ! __sceneHasMultiOutputPrecompiledMaterial( scene ) ) return;
	let renderTarget = null;
	try { renderTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : renderer._renderTarget || null; } catch ( _ ) {}
	let mrt = null;
	try { mrt = typeof renderer.getMRT === 'function' ? renderer.getMRT() : renderer._mrt || null; } catch ( _ ) {}
	const texture = renderTarget && renderTarget.texture;
	const textures = renderTarget && Array.isArray( renderTarget.textures ) ? renderTarget.textures : null;
	const count = textures ? textures.length : 1;
	const key = [
		count,
		texture && texture.format || 'default',
		texture && texture.type || 'default',
		renderTarget && renderTarget.samples || 0,
		renderTarget && renderTarget.depthBuffer === true ? 1 : 0,
		renderTarget && renderTarget.stencilBuffer === true ? 1 : 0,
		mrt && mrt.id || 'default',
	].join( ':' );
	if ( renderer.__tslpPipelineAttachmentKey === key ) return;
	renderer.__tslpPipelineAttachmentKey = key;
	try { if ( renderer._pipelines && typeof renderer._pipelines.dispose === 'function' ) renderer._pipelines.dispose(); } catch ( _ ) {}
	try { if ( renderer._objects && typeof renderer._objects.dispose === 'function' ) renderer._objects.dispose(); } catch ( _ ) {}
}

const __fullPassMaterialCache = new WeakMap();
const __fullBackdropPassMaterialCache = new WeakMap();
function __materialForFullPass( sourceMaterial ) {
	if ( ! sourceMaterial ) return sourceMaterial;
	if ( __fullPassMaterialCache.has( sourceMaterial ) ) {
		const cached = __fullPassMaterialCache.get( sourceMaterial );
		__copyMaterialProps( sourceMaterial, cached );
		cached.needsUpdate = true;
		return cached;
	}
	const className = __classNameForMaterial( sourceMaterial );
	const material = __makeInternalNodeMaterial( className );
	material.name = sourceMaterial.name || material.name || 'full-pass-material';
	__copyMaterialProps( sourceMaterial, material );
	__copyMaterialNodeProps( sourceMaterial, material );
	material.needsUpdate = true;
	__fullPassMaterialCache.set( sourceMaterial, material );
	return material;
}

function __materialForBackdropFullPass( sourceMaterial ) {
	if ( ! sourceMaterial ) return sourceMaterial;
	if ( sourceMaterial.backdropNode || sourceMaterial.backdropAlphaNode ) return __materialForFullPass( sourceMaterial );
	if ( __fullBackdropPassMaterialCache.has( sourceMaterial ) ) {
		const cached = __fullBackdropPassMaterialCache.get( sourceMaterial );
		__copyMaterialProps( sourceMaterial, cached );
		__copyMaterialNodeProps( sourceMaterial, cached );
		cached.needsUpdate = true;
		return cached;
	}
	const material = __makeInternalNodeMaterial( 'MeshBasicNodeMaterial' );
	material.name = sourceMaterial.name || material.name || 'full-backdrop-pass-material';
	__copyMaterialProps( sourceMaterial, material );
	__copyMaterialNodeProps( sourceMaterial, material );
	material.needsUpdate = true;
	__fullBackdropPassMaterialCache.set( sourceMaterial, material );
	return material;
}

function __withSourceMaterialsForFullPass( scene, callback, options = {} ) {
	const materialForSource = options && typeof options.materialForSource === 'function' ? options.materialForSource : __materialForFullPass;
	const swaps = [];
	const swapOne = ( object ) => {
		const material = object && object.material;
		if ( ! material ) return;
		if ( Array.isArray( material ) ) {
			let changed = false;
			const next = material.map( ( mat ) => {
				if ( mat && mat.isPrecompiledMaterial === true && mat.__tslpSourceMaterial ) {
					changed = true;
					return materialForSource( mat.__tslpSourceMaterial );
				}
				return mat;
			} );
			if ( changed ) {
				swaps.push( { object, material } );
				object.material = next;
			}
		} else if ( material.isPrecompiledMaterial === true && material.__tslpSourceMaterial ) {
			swaps.push( { object, material } );
			object.material = materialForSource( material.__tslpSourceMaterial );
		}
	};
	try {
		if ( scene && scene.overrideMaterial && scene.overrideMaterial.isPrecompiledMaterial === true && scene.overrideMaterial.__tslpSourceMaterial ) {
			swaps.push( { object: scene, material: scene.overrideMaterial, override: true } );
			const sourceOverrideMaterial = scene.overrideMaterial.__tslpSourceMaterial;
			// Keep live node overrides intact. Cloning these through
			// __materialForFullPass() can change renderer-owned position nodes while
			// the same override is applied across heterogeneous scene objects.
			scene.overrideMaterial = sourceOverrideMaterial.isNodeMaterial === true
				? sourceOverrideMaterial
				: materialForSource( sourceOverrideMaterial );
		}
		if ( scene && typeof scene.traverse === 'function' ) scene.traverse( swapOne );
		return callback();
	} finally {
		for ( let i = swaps.length - 1; i >= 0; i -- ) {
			const swap = swaps[ i ];
			if ( swap.override ) swap.object.overrideMaterial = swap.material;
			else swap.object.material = swap.material;
		}
	}
}

function __sharePassRenderTargetFromFullRenderer( slimRenderer, fullRenderer, passNode ) {
	const target = passNode && passNode.renderTarget;
	if ( ! target ) return;
	const textures = Array.isArray( target.textures ) ? target.textures : target.texture ? [ target.texture ] : [];
	for ( const texture of textures ) __shareGPUTextureEntry( slimRenderer, fullRenderer, texture );
	if ( target.depthTexture ) __shareGPUTextureEntry( slimRenderer, fullRenderer, target.depthTexture );
}

function __renderOffscreenOverrideWithFullRenderer( slimRenderer, scene, camera ) {
	const fullRenderer = __computeRenderer;
	if ( ! slimRenderer || ! fullRenderer || ! scene || ! scene.overrideMaterial ) return false;
	const diag = typeof __harnessDiagnostics === 'function' ? __harnessDiagnostics() : null;
	const shareDiag = diag ? ( diag.textureShare || ( diag.textureShare = { calls: 0, noSourceData: 0, noSourceTexture: 0, success: 0, names: [], missingNames: [] } ) ) : null;
	const stats = __sharedRenderOffscreenOverrideWithFullRenderer( {
		scene,
		camera,
		slimRenderer,
		fullRenderer,
		withSourceMaterials: ( targetScene, render ) => __withSourceMaterialsForFullPass( targetScene, render ),
		diagnostics: shareDiag,
		onError: ( err ) => {
			if ( ! window.__tslpOffscreenOverrideFullWarned ) {
				window.__tslpOffscreenOverrideFullWarned = true;
				console.warn( '[tslp-e2e] offscreen override full-renderer pass failed:', err && ( err.stack || err.message ) || err );
			}
		},
	} );
	if ( stats && stats.rendered ) {
		try {
			const counters = diag || __harnessDiagnostics();
			counters.offscreenOverrideFullRenders = ( counters.offscreenOverrideFullRenders | 0 ) + 1;
		} catch ( _ ) {}
		return true;
	}
	return false;
}

function __withPassRendererContext( passNode, renderer, callback ) {
	const currentContextNode = renderer && renderer.contextNode;
	const currentReplayPassNode = renderer && renderer.__tslpActiveReplayPassNode;
	try {
		if ( renderer ) renderer.__tslpActiveReplayPassNode = passNode || null;
		if ( passNode && passNode.contextNode !== null && renderer ) {
			if ( renderer.contextNode && typeof renderer.contextNode.getFlowContextData === 'function' && typeof passNode.contextNode.getFlowContextData === 'function' ) {
				if ( passNode._contextNodeCache == null || passNode._contextNodeCache.version !== passNode.version ) {
					passNode._contextNodeCache = {
						version: passNode.version,
						context: FullTSL.context( { ...renderer.contextNode.getFlowContextData(), ...passNode.contextNode.getFlowContextData() } )
					};
				}
				renderer.contextNode = passNode._contextNodeCache.context;
			} else {
				renderer.contextNode = passNode.contextNode;
			}
		}
		return callback();
	} finally {
		if ( renderer ) {
			renderer.contextNode = currentContextNode;
			renderer.__tslpActiveReplayPassNode = currentReplayPassNode;
		}
	}
}

function __renderPassNodeWithSourceMaterials( passNode, renderer, camera ) {
	if ( ! passNode || ! renderer || ! passNode.scene || passNode._mrt || ! __sceneHasMultiOutputPrecompiledMaterial( passNode.scene ) ) return false;
	if ( renderer.__TSLP_SLIM__ === true ) return false;
	try {
		try {
			const diag = __harnessDiagnostics();
			const passDiag = diag.pass || ( diag.pass = { attempts: 0, skipped: 0, rendered: 0, failed: 0, objects: [], materials: [], objectDetails: [] } );
			passDiag.sourceMaterialRenders = ( passDiag.sourceMaterialRenders || 0 ) + 1;
		} catch ( _ ) {}
		__withSourceMaterialsForFullPass( passNode.scene, () => renderer.render( passNode.scene, camera || passNode.camera ) );
		return true;
	} catch ( err ) {
		if ( ! window.__tslpSourcePassRenderWarned ) {
			window.__tslpSourcePassRenderWarned = true;
			console.warn( '[tslp-e2e] source-material pass replay failed:', err && ( err.stack || err.message ) || err );
		}
		return false;
	}
}

function __renderPassNodeWithFullRenderer( passNode, slimRenderer, fullRenderer, camera, options = {} ) {
	if ( ! passNode || ! slimRenderer || ! fullRenderer || ! passNode.scene || ! passNode.renderTarget ) return false;
	const force = options && options.force === true;
	const hasBackdropMaterial = __sceneHasBackdropNodeMaterial( passNode.scene );
	const hasPassContext = passNode.contextNode !== null;
	if ( ! force && ! passNode._mrt && ! __sceneHasMultiOutputPrecompiledMaterial( passNode.scene ) && ! hasPassContext ) return false;
	try {
		try {
			fullRenderer.toneMapping = slimRenderer.toneMapping;
			fullRenderer.toneMappingExposure = slimRenderer.toneMappingExposure;
			fullRenderer.outputColorSpace = slimRenderer.outputColorSpace;
			const size = slimRenderer.getDrawingBufferSize && slimRenderer.getDrawingBufferSize( new Slim.Vector2() );
			if ( size && typeof fullRenderer.setSize === 'function' ) fullRenderer.setSize( size.width, size.height, false );
		} catch ( _ ) {}
		const currentRenderTarget = typeof fullRenderer.getRenderTarget === 'function' ? fullRenderer.getRenderTarget() : null;
		const currentMRT = typeof fullRenderer.getMRT === 'function' ? fullRenderer.getMRT() : null;
		const currentAutoClear = fullRenderer.autoClear;
		const currentTransparent = fullRenderer.transparent;
		const currentOpaque = fullRenderer.opaque;
		const currentContextNode = fullRenderer.contextNode;
		const currentBackground = passNode.scene.background;
		const currentBackgroundNode = passNode.scene.backgroundNode;
		const capturedBackground = __capturedSceneBackgrounds.get( passNode.scene );
		const capturedBackgroundNode = __capturedSceneBackgroundNodes.get( passNode.scene );
		try {
			if ( capturedBackground !== undefined ) passNode.scene.background = capturedBackground;
				if ( capturedBackgroundNode !== undefined ) passNode.scene.backgroundNode = capturedBackgroundNode;
				__syncPassRenderTargetTextures( passNode, passNode._mrt || null );
				fullRenderer.setRenderTarget( passNode.renderTarget );
			if ( typeof fullRenderer.setMRT === 'function' ) fullRenderer.setMRT( passNode._mrt || null );
			fullRenderer.autoClear = true;
			fullRenderer.transparent = passNode.transparent;
			fullRenderer.opaque = passNode.opaque;
			__withPassRendererContext( passNode, fullRenderer, () => __withSourceMaterialsForFullPass(
				passNode.scene,
				() => fullRenderer.render( passNode.scene, camera || passNode.camera ),
				hasBackdropMaterial ? { materialForSource: __materialForBackdropFullPass } : null
			) );
			__sharePassRenderTargetFromFullRenderer( slimRenderer, fullRenderer, passNode );
			return true;
		} finally {
			passNode.scene.background = currentBackground;
			passNode.scene.backgroundNode = currentBackgroundNode;
			try { fullRenderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
			try { if ( typeof fullRenderer.setMRT === 'function' ) fullRenderer.setMRT( currentMRT ); } catch ( _ ) {}
			fullRenderer.autoClear = currentAutoClear;
			fullRenderer.transparent = currentTransparent;
			fullRenderer.opaque = currentOpaque;
			fullRenderer.contextNode = currentContextNode;
		}
	} catch ( err ) {
		if ( ! window.__tslpFullPassRenderWarned ) {
			window.__tslpFullPassRenderWarned = true;
			console.warn( '[tslp-e2e] full-renderer pass replay failed:', err && ( err.stack || err.message ) || err );
		}
		return false;
	}
}

	export class PassNode extends Slim.PassNode {
		static COLOR = 'color';
		static DEPTH = 'depth';

		constructor( scope = PassNode.COLOR, scene = null, camera = null, options = {} ) {
			super( scope, scene, camera );
			this.scope = scope;
			this.scene = scene;
			this.camera = camera;
			this.options = options || {};
			this._pixelRatio = 1;
			this._width = 1;
			this._height = 1;
			this._resolutionScale = 1;
			this._viewport = null;
			this._scissor = null;
			this._layers = null;
			this._mrt = null;
			this._textures = Object.create( null );
			this._textureNodes = Object.create( null );
			this._viewZNodes = Object.create( null );
			this._linearDepthNodes = Object.create( null );
			this._previousTextures = Object.create( null );
			this._previousTextureNodes = Object.create( null );
			this._cameraNear = FullTSL.uniform( 0 );
			this._cameraFar = FullTSL.uniform( 1 );
			this.overrideMaterial = null;
			this.transparent = true;
			this.opaque = true;
			this.contextNode = null;
			this._contextNodeCache = null;
			this.isNode = true;
			this.isPassNode = true;
			this.__tslpPassIndex = __passNodeSequence ++;
			this._renderTargetOptions = { type: Slim.HalfFloatType, ...this.options };
			const renderTarget = new Slim.RenderTarget( 1, 1, this._renderTargetOptions );
			renderTarget.texture.name = 'output';
			let depthTexture = null;
			if ( this.scope === PassNode.DEPTH || this.options.depthBuffer !== false ) {
				depthTexture = __makePassDepthTexture( renderTarget );
				renderTarget.depthTexture = depthTexture;
				// Back-link depth texture to its render target so the slim
				// hydrator multisample check accepts it as a multisampled
				// depth binding when samples is greater than 1.
			}
			this.renderTarget = renderTarget;
			this._textures.output = renderTarget.texture;
			if ( depthTexture !== null ) this._textures.depth = depthTexture;
			__livePassNodes.push( this );
		}

		setResolutionScale( resolutionScale ) { this._resolutionScale = resolutionScale || 1; this.setSize( this._width, this._height ); return this; }
		getResolutionScale() { return this._resolutionScale; }
		setResolution( resolution ) { return this.setResolutionScale( resolution ); }
		getResolution() { return this.getResolutionScale(); }
		setLayers( layers ) { this._layers = layers; return this; }
		getLayers() { return this._layers; }
		getUpdateType() { return 'none'; }
		getUpdateBeforeType() { return 'render'; }
		getUpdateAfterType() { return 'none'; }
		setMRT( mrt ) { this._mrt = mrt; return this; }
		getMRT() { return this._mrt; }
		getTexture( name = 'output' ) {
			let texture = this._textures[ name ];
			if ( texture === undefined ) {
				if ( name === 'depth' ) throw new Error( 'THREE.PassNode: Depth texture is not available for this pass.' );
				const refTexture = this.renderTarget.texture;
				texture = refTexture && typeof refTexture.clone === 'function' ? refTexture.clone() : refTexture;
				if ( texture ) texture.name = name;
				this._textures[ name ] = texture;
				if ( texture && this.renderTarget && Array.isArray( this.renderTarget.textures ) && ! this.renderTarget.textures.includes( texture ) ) {
					texture.isRenderTargetTexture = true;
					texture.renderTarget = this.renderTarget;
					this.renderTarget.textures.push( texture );
				}
			}
			return texture;
		}
		getPreviousTexture( name = 'output' ) {
			let texture = this._previousTextures[ name ];
			if ( texture === undefined ) {
				const current = this.getTexture( name );
				texture = current && typeof current.clone === 'function' ? current.clone() : current;
				if ( texture ) texture.name = name + '.previous';
				this._previousTextures[ name ] = texture;
			}
			return texture;
		}
		toggleTexture( name = 'output' ) {
			const prevTexture = this._previousTextures[ name ];
			if ( prevTexture === undefined ) return;
			const texture = this._textures[ name ];
			if ( this.renderTarget && Array.isArray( this.renderTarget.textures ) ) {
				const index = this.renderTarget.textures.indexOf( texture );
				if ( index >= 0 ) this.renderTarget.textures[ index ] = prevTexture;
			}
			this._textures[ name ] = prevTexture;
			this._previousTextures[ name ] = texture;
			if ( this._textureNodes[ name ] && typeof this._textureNodes[ name ].updateTexture === 'function' ) this._textureNodes[ name ].updateTexture();
			if ( this._previousTextureNodes[ name ] && typeof this._previousTextureNodes[ name ].updateTexture === 'function' ) this._previousTextureNodes[ name ].updateTexture();
		}
		getTextureNode( name = 'output' ) {
			let textureNode = this._textureNodes[ name ];
			if ( textureNode === undefined ) this._textureNodes[ name ] = textureNode = __makePassTextureNode( this, name, false );
			return textureNode;
		}
		__callTextureNode( method, args ) {
			const textureNode = this.getTextureNode();
			const fn = textureNode && textureNode[ method ];
			return typeof fn === 'function' ? fn.apply( textureNode, args ) : textureNode;
		}
		context( ...args ) {
			const node = this.__callTextureNode( 'context', args );
			try { node.passNode = this; } catch ( _ ) {}
			this.contextNode = node;
			return node;
		}
		toVar( ...args ) { return this.__callTextureNode( 'toVar', args ); }
		toInspector() { return this; }
		add( ...args ) { return this.__callTextureNode( 'add', args ); }
		sub( ...args ) { return this.__callTextureNode( 'sub', args ); }
		mul( ...args ) { return this.__callTextureNode( 'mul', args ); }
		div( ...args ) { return this.__callTextureNode( 'div', args ); }
		mod( ...args ) { return this.__callTextureNode( 'mod', args ); }
		pow( ...args ) { return this.__callTextureNode( 'pow', args ); }
		min( ...args ) { return this.__callTextureNode( 'min', args ); }
		max( ...args ) { return this.__callTextureNode( 'max', args ); }
		mix( ...args ) { return this.__callTextureNode( 'mix', args ); }
		clamp( ...args ) { return this.__callTextureNode( 'clamp', args ); }
		normalize( ...args ) { return this.__callTextureNode( 'normalize', args ); }
		toneMapping( ...args ) { return this.__callTextureNode( 'toneMapping', args ); }
		renderOutput( ...args ) { return this.__callTextureNode( 'renderOutput', args ); }
		get r() { return this.getTextureNode().r; }
		get g() { return this.getTextureNode().g; }
		get b() { return this.getTextureNode().b; }
		get a() { return this.getTextureNode().a; }
		get rgb() { return this.getTextureNode().rgb; }
		get rgba() { return this.getTextureNode().rgba; }
		getPreviousTextureNode( name = 'output' ) {
			let textureNode = this._previousTextureNodes[ name ];
			if ( textureNode === undefined ) this._previousTextureNodes[ name ] = textureNode = __makePassTextureNode( this, name, true );
			return textureNode;
		}
		getViewZNode( name = 'depth' ) {
			let viewZNode = this._viewZNodes[ name ];
			if ( viewZNode === undefined ) {
				viewZNode = FullTSL.perspectiveDepthToViewZ( this.getTextureNode( name ), this._cameraNear, this._cameraFar );
				try { viewZNode.passNode = this; } catch ( _ ) {}
				this._viewZNodes[ name ] = viewZNode;
			}
			return viewZNode;
		}
		getLinearDepthNode( name = 'depth' ) {
			let linearDepthNode = this._linearDepthNodes[ name ];
			if ( linearDepthNode === undefined ) {
				linearDepthNode = FullTSL.viewZToOrthographicDepth( this.getViewZNode( name ), this._cameraNear, this._cameraFar );
				try { linearDepthNode.passNode = this; } catch ( _ ) {}
				this._linearDepthNodes[ name ] = linearDepthNode;
			}
			return linearDepthNode;
		}
		setup( { renderer } = {} ) {
			if ( renderer && typeof renderer.getOutputBufferType === 'function' ) {
				try { this.renderTarget.texture.type = renderer.getOutputBufferType(); } catch ( _ ) {}
			}
			return this.scope === PassNode.DEPTH ? this.getLinearDepthNode() : this.getTextureNode();
		}
		async compileAsync() {}
		setPixelRatio( pixelRatio ) { this._pixelRatio = pixelRatio || 1; this.setSize( this._width, this._height ); }
		setSize( width = 1, height = 1 ) {
			this._width = width;
			this._height = height;
			const scale = this._pixelRatio * this._resolutionScale;
			const effectiveWidth = Math.max( 1, Math.floor( width * scale ) );
			const effectiveHeight = Math.max( 1, Math.floor( height * scale ) );
			if ( this.renderTarget && typeof this.renderTarget.setSize === 'function' ) {
				this.renderTarget.setSize( effectiveWidth, effectiveHeight );
				if ( this.renderTarget.texture ) this._textures.output = this.renderTarget.texture;
				if ( this.renderTarget.depthTexture ) this._textures.depth = this.renderTarget.depthTexture;
				__refreshPassTextureNodes( this );
			}
			if ( this._scissor !== null && this.renderTarget && this.renderTarget.scissor ) {
				this.renderTarget.scissor.copy( this._scissor ).multiplyScalar( scale ).floor();
				this.renderTarget.scissorTest = true;
			} else if ( this.renderTarget ) {
				this.renderTarget.scissorTest = false;
			}
			if ( this._viewport !== null && this.renderTarget && this.renderTarget.viewport ) this.renderTarget.viewport.copy( this._viewport ).multiplyScalar( scale ).floor();
		}
		setScissor( x, y, width, height ) {
			if ( x === null ) this._scissor = null;
			else {
				if ( this._scissor === null ) this._scissor = new Slim.Vector4();
				if ( x && x.isVector4 ) this._scissor.copy( x );
				else this._scissor.set( x, y, width, height );
			}
		}
		setViewport( x, y, width, height ) {
			if ( x === null ) this._viewport = null;
			else {
				if ( this._viewport === null ) this._viewport = new Slim.Vector4();
				if ( x && x.isVector4 ) this._viewport.copy( x );
				else this._viewport.set( x, y, width, height );
			}
		}
		updateBefore( frame = {} ) {
			const renderer = frame.renderer;
			const scene = this.scene;
			const camera = this.camera;
			if ( ! renderer || ! scene || ! camera ) return;
			const size = new Slim.Vector2( 1, 1 );
			try { if ( typeof renderer.getSize === 'function' ) renderer.getSize( size ); } catch ( _ ) {}
			try { this._pixelRatio = typeof renderer.getPixelRatio === 'function' ? renderer.getPixelRatio() : 1; } catch ( _ ) { this._pixelRatio = 1; }
			this._cameraNear.value = camera.near || 0;
			this._cameraFar.value = camera.far || 1;
			this.setSize( size.width || 1, size.height || 1 );
			__recordRenderableObjectCount( scene );
			const currentRenderTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
			const currentMRT = typeof renderer.getMRT === 'function' ? renderer.getMRT() : null;
			const currentAutoClear = renderer.autoClear;
			const currentTransparent = renderer.transparent;
			const currentOpaque = renderer.opaque;
			const currentMask = camera.layers && camera.layers.mask;
			const currentOverrideMaterial = scene.overrideMaterial;
			for ( const name in this._previousTextures ) this.toggleTexture( name );
			if ( this._layers !== null && camera.layers ) camera.layers.mask = this._layers.mask;
			if ( this.overrideMaterial !== null ) scene.overrideMaterial = this.overrideMaterial;
			const requestedMRT = this._mrt || null;
			if ( requestedMRT ) {
				__retargetSceneMaterialsForPassTarget( scene, __mrtOutputCount( requestedMRT ), this );
			} else {
				__retargetSceneMaterialsForPassTarget( scene, 1, this );
			}
				const {
					replayMRT,
					canRenderPrecompiledMRT,
					needsFullMRTPass,
				} = __selectPassMRTRenderPath( scene, requestedMRT, this );
				__prepareSceneMaterialsForMRTReplay( scene, replayMRT, this );
				renderer.autoClear = true;
				renderer.transparent = this.transparent;
				renderer.opaque = this.opaque;
					try {
						const pathDiag = __harnessDiagnostics().passPaths || ( __harnessDiagnostics().passPaths = [] );
						if ( pathDiag.length < 24 ) pathDiag.push( {
							requestedMRT: !! requestedMRT,
							replayMRT: !! replayMRT,
							canRenderPrecompiledMRT,
							needsFullMRTPass,
							selectedPath: needsFullMRTPass ? 'full-mrt' : replayMRT ? 'slim-mrt' : 'slim-color',
							targetCount: __mrtOutputCount( replayMRT ),
						} );
					} catch ( _ ) {}
						// MRT velocity outputs are ordinary captured outputs. Prefer the
						// precompiled path whenever every scene material can render the
						// requested MRT shape, and reserve the full renderer for missing
						// artifact coverage.
				const needsFullStandalonePass = scene.isScene !== true;
				const renderedWithFullPass = !! ( ( needsFullMRTPass || needsFullStandalonePass ) && __renderPassNodeWithFullRenderer(
					this,
					renderer,
					__computeRenderer,
					camera,
					{ force: needsFullStandalonePass }
				) );
				if ( ! renderedWithFullPass && replayMRT && ( scene.background || scene.backgroundNode ) && ! __backgroundAuxCanRenderMRT( replayMRT ) ) {
					const backgroundScene = this.__tslpBackgroundScene || ( this.__tslpBackgroundScene = new Slim.Scene() );
					backgroundScene.background = scene.background;
					backgroundScene.backgroundNode = scene.backgroundNode;
					backgroundScene.environment = scene.environment;
				try {
					__syncPassRenderTargetTextures( this, replayMRT );
					renderer.setRenderTarget( this.renderTarget );
					if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( replayMRT );
					renderer.autoClear = true;
					if ( typeof renderer.clear === 'function' ) renderer.clear();
				} catch ( _ ) {}
				const savedTargetTextures = this.renderTarget && Array.isArray( this.renderTarget.textures )
					? this.renderTarget.textures.slice()
					: null;
				const savedTextureMap = { ...this._textures };
				__syncPassRenderTargetTextures( this, null );
				renderer.setRenderTarget( this.renderTarget );
				if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( null );
				renderer.render( backgroundScene, camera );
				if ( savedTargetTextures && this.renderTarget ) this.renderTarget.textures = savedTargetTextures;
				this._textures = savedTextureMap;

				const savedBackground = scene.background;
				const savedBackgroundNode = scene.backgroundNode;
				try {
					scene.background = null;
					scene.backgroundNode = null;
					__syncPassRenderTargetTextures( this, replayMRT );
					renderer.setRenderTarget( this.renderTarget );
					if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( replayMRT );
					renderer.autoClear = false;
					__resetRendererPipelineCachesForMRTReplay( renderer, replayMRT );
					__wirePassTexturesIntoSceneMaterials( scene, __activePipelinePassNodes || [ this ] );
					if ( renderer.__tslpSuppressShadowKick !== true && __sceneHasShadowLights( scene ) ) __kickShadowRenderAsync( renderer, scene, camera );
					__withPassRendererContext( this, renderer, () => renderer.render( scene, camera ) );
				} finally {
					scene.background = savedBackground;
					scene.backgroundNode = savedBackgroundNode;
					}
					} else if ( ! renderedWithFullPass ) {
						__syncPassRenderTargetTextures( this, replayMRT );
						renderer.setRenderTarget( this.renderTarget );
						if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( replayMRT );
					__resetRendererPipelineCachesForMRTReplay( renderer, replayMRT );
					__wirePassTexturesIntoSceneMaterials( scene, __activePipelinePassNodes || [ this ] );
						__wireBackgroundTextures( scene, renderer );
						__driveRendererLightingUpdateBefore( renderer, scene, camera );
						if ( renderer.__tslpSuppressShadowKick !== true && __sceneHasShadowLights( scene ) ) __kickShadowRenderAsync( renderer, scene, camera );
					const renderedWithSource = __withPassRendererContext( this, renderer, () => __renderPassNodeWithSourceMaterials( this, renderer, camera ) );
					const renderedWithFullFallback = ! renderedWithSource && needsFullMRTPass && __renderPassNodeWithFullRenderer( this, renderer, __computeRenderer, camera );
					if ( ! renderedWithSource && ! renderedWithFullFallback ) {
						__renderDepth ++;
						try {
							__withPassRendererContext( this, renderer, () => renderer.render( scene, camera ) );
						} finally {
							__renderDepth --;
						}
						}
				}
				scene.overrideMaterial = currentOverrideMaterial;
			renderer.setRenderTarget( currentRenderTarget );
			if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( currentMRT );
			renderer.autoClear = currentAutoClear;
			renderer.transparent = currentTransparent;
			renderer.opaque = currentOpaque;
			if ( camera.layers && currentMask !== undefined ) camera.layers.mask = currentMask;
		}
		dispose() { if ( this.renderTarget && typeof this.renderTarget.dispose === 'function' ) this.renderTarget.dispose(); }
	}
const __counts = Object.create( null );
const __usedArtifactNames = new Set();
const __seenMaterials = new WeakMap();
const __seenMaterialContexts = new WeakMap();
const __replayTopologyArtifactsByScene = new WeakMap();
const __replayTopologyIdentity = __createObjectIdentityKeyer();
const __fallbackArtifactTextures = new Map();
const __liveSceneIndex = createLiveSceneIndex( {
	registerLiveTexture: ( texture ) => Slim.registerLiveTexture( texture ),
	getDiagnostics: () => __harnessDiagnostics(),
	materialTextureProps: __TEXTURE_PROPS,
	collectMaterialNodeTextures: ( material ) => __collectMaterialNodeTextures( material ),
	isEnvironmentTextureSource: ( texture ) => __isEnvironmentTextureSource( texture ),
	isPMREMTexture: ( texture ) => __isPMREMTexture( texture ),
} );
const __liveTexturesByUuid = __liveSceneIndex.texturesByUuid;
const __liveTexturesByName = __liveSceneIndex.texturesByName;
const __liveMaterialTextures = __liveSceneIndex.materialTextures;
const __hasBackgroundAux = Array.isArray( __data.aux ) && __data.aux.some( ( entry ) => entry && entry.shape === 'background' );
const __backgroundAuxCount = Array.isArray( __data.aux ) ? __data.aux.filter( ( entry ) => entry && entry.shape === 'background' ).length : 0;
function __backgroundReplayProgramSignature( artifact ) {
	if ( ! artifact || typeof artifact !== 'object' ) return null;
	const normalized = {};
	// These fields identify one capture instance, not the executable program.
	// Everything else, including selectors, shaders, bindings, live writers,
	// defaults, and render state, must match before shape fallback is safe.
	const captureIdentity = new Set( [ 'cacheKey', 'captureClock', 'materialUuid', 'userMaterialUuid' ] );
	for ( const key of Object.keys( artifact ).sort() ) {
		if ( ! captureIdentity.has( key ) ) normalized[ key ] = artifact[ key ];
	}
	try {
		return JSON.stringify( normalized );
	} catch ( _ ) {
		return null;
	}
}
function __equivalentBackgroundAuxFallbackHash( auxList ) {
	const backgrounds = Array.isArray( auxList )
		? auxList.filter( ( entry ) => entry && entry.shape === 'background' && entry.artifact && entry.configHash )
		: [];
	if ( backgrounds.length < 2 ) return null;
	const signature = __backgroundReplayProgramSignature( backgrounds[ 0 ].artifact );
	if ( ! signature ) return null;
	for ( let index = 1; index < backgrounds.length; index ++ ) {
		if ( __backgroundReplayProgramSignature( backgrounds[ index ].artifact ) !== signature ) return null;
	}
	return backgrounds[ 0 ].configHash;
}
const __backgroundEquivalentFallbackHash = __equivalentBackgroundAuxFallbackHash( __data.aux );
Slim.registerAuxArtifacts( Array.isArray( __data.aux ) ? __data.aux : [] );
// Counter for in-flight async PMREM generations. Playwright waits for this to
// reach 0 (alongside __tslpFrozen) before taking a screenshot so PMREM-based
// IBL textures are resolved and re-hydrated before capture.
window.__tslpPmremPending = 0;

// Defensive patch: harden Slim.ColorManagement.getTransfer against unknown
// colorSpace values. Some textures end up with colorSpace = undefined, and
// the slim bundle minified getTransfer only special-cases empty string;
// anything else hits this.spaces[ colorSpace ].transfer and throws.
( function patchColorManagement() {
	const cm = Slim.ColorManagement;
	if ( ! cm || cm.__tslpHardened ) return;
	cm.__tslpHardened = true;
	const orig = cm.getTransfer.bind( cm );
	cm.getTransfer = function ( colorSpace ) {
		try {
			return orig( colorSpace );
		} catch ( _ ) {
			const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
			const key = colorSpace === undefined ? 'undefined' : colorSpace === null ? 'null' : String( colorSpace );
			diag.colorTransferFallbacks[ key ] = ( diag.colorTransferFallbacks[ key ] || 0 ) + 1;
			return orig( '' );
		}
	};
} )();

// Heal Texture.prototype.colorSpace at the source: install a setter that
// coerces undefined / null to '' (NoColorSpace). three.js Texture writes
// this.colorSpace = colorSpace as a plain instance field; some ad-hoc
// texture factories pass undefined, leaving this.spaces[ undefined ] and
// throwing inside getTransfer. Routing all writes through a setter
// guarantees colorSpace is always a valid string before getTransfer reads.
( function healTextureColorSpace() {
	const proto = Slim.Texture && Slim.Texture.prototype;
	if ( ! proto || proto.__tslpColorSpaceHealed ) return;
	proto.__tslpColorSpaceHealed = true;
	const KEY = '__tslpColorSpace';
	Object.defineProperty( proto, 'colorSpace', {
		configurable: true,
		enumerable: true,
		get() { return this[ KEY ] === undefined ? '' : this[ KEY ]; },
		set( v ) { this[ KEY ] = ( v === undefined || v === null ) ? '' : v; },
	} );
} )();
// No-op kept so the render() callsite below stays consistent across patches.
window.__tslpHealColorSpace = function () { return 0; };

// Counter for in-flight async compute dispatches delegated to the full renderer.
// Playwright waits for this to reach 0 before taking a screenshot so the GPU
// storage buffers written by compute are visible in the final render.
window.__tslpComputePending = 0;
// Counter for in-flight async shadow-map renders run on the full WebGPURenderer
// (slim has shadow code tree-shaken). Playwright waits for this to reach 0 so
// light.shadow.map.depthTexture is allocated before the slim render samples it.
window.__tslpShadowPending = 0;

function __rememberLiveTexture( texture ) {
	__liveSceneIndex.rememberLiveTexture( texture );
}
window.__tslpRememberLiveTexture = __rememberLiveTexture;

// Mirror the capture-side patches: hook DefaultLoadingManager so HDR/GLTF/MaterialX
// fetches block the screenshot, and wrap compileAsync so awaited GPU pipeline
// builds also block. Counters were initialised in the page.addInitScript shim.
( function patchSlimDefaultLoadingManager() {
	const dlm = Slim.DefaultLoadingManager;
	if ( ! dlm || dlm.__tslpPatched ) return;
	dlm.__tslpPatched = true;
	const _origStart = dlm.itemStart.bind( dlm );
	const _origEnd = dlm.itemEnd.bind( dlm );
	const _now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	dlm.itemStart = function ( url ) {
		window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
		window.__tslpLoaderLastBusyAt = _now();
		return _origStart( url );
	};
	dlm.itemEnd = function ( url ) {
		window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
		window.__tslpLoaderLastBusyAt = _now();
		return _origEnd( url );
	};
} )();

// PMREMGenerator drives nested renderer.compile / renderer.render calls when
// it builds the prefiltered cubemap. Those nested calls re-enter this
// wrapper's render(); without a guard, __prepareSceneForReplay would try
// to swap PMREM's internal tmp-mesh material against our captured artifact
// table and produce identity-MISSes that get cached BEFORE the user's main
// scene.environment ever gets registered. The guard keeps the pre-render
// hook a no-op while a PMREM build is in flight.
let __pmremRunning = 0;

// Re-entrancy depth for renderer.render(). RTTNode.updateBefore / PassNode.updateBefore
// invoke QuadMesh.render( renderer ) which calls renderer.render( quadScene, ... )
// recursively on us. Those nested scenes contain full-renderer-internal NodeMaterials
// with no captured artifact — __replaceSceneMaterials would throw. Skip scene prep
// (and the explicit RTT/effect drives, already in flight at depth 0) when nested.
let __renderDepth = 0;

function __makeFullRoomEnvironment( Three ) {
	if ( ! Three ) return null;
	const {
		BackSide,
		BoxGeometry,
		InstancedMesh,
		Mesh,
		MeshLambertMaterial,
		MeshStandardMaterial,
		PointLight,
		Scene,
		Object3D,
	} = Three;
	if ( ! Scene || ! BoxGeometry || ! Mesh || ! MeshStandardMaterial || ! MeshLambertMaterial ) return null;

	const scene = new Scene();
	scene.name = 'RoomEnvironment';
	scene.position.y = - 3.5;

	const geometry = new BoxGeometry();
	geometry.deleteAttribute( 'uv' );

	const roomMaterial = new MeshStandardMaterial( { side: BackSide } );
	const boxMaterial = new MeshStandardMaterial();

	const mainLight = new PointLight( 0xffffff, 900, 28, 2 );
	mainLight.position.set( 0.418, 16.199, 0.300 );
	scene.add( mainLight );

	const room = new Mesh( geometry, roomMaterial );
	room.position.set( - 0.757, 13.219, 0.717 );
	room.scale.set( 31.713, 28.305, 28.591 );
	scene.add( room );

	const boxes = new InstancedMesh( geometry, boxMaterial, 6 );
	const transform = new Object3D();
	const boxTransforms = [
		[ [ - 10.906, 2.009, 1.846 ], [ 0, - 0.195, 0 ], [ 2.328, 7.905, 4.651 ] ],
		[ [ - 5.607, - 0.754, - 0.758 ], [ 0, 0.994, 0 ], [ 1.970, 1.534, 3.955 ] ],
		[ [ 6.167, 0.857, 7.803 ], [ 0, 0.561, 0 ], [ 3.927, 6.285, 3.687 ] ],
		[ [ - 2.017, 0.018, 6.124 ], [ 0, 0.333, 0 ], [ 2.002, 4.566, 2.064 ] ],
		[ [ 2.291, - 0.756, - 2.621 ], [ 0, - 0.286, 0 ], [ 1.546, 1.552, 1.496 ] ],
		[ [ - 2.193, - 0.369, - 5.547 ], [ 0, 0.516, 0 ], [ 3.875, 3.487, 2.986 ] ],
	];
	boxTransforms.forEach( ( [ position, rotation, scale ], index ) => {
		transform.position.set( position[ 0 ], position[ 1 ], position[ 2 ] );
		transform.rotation.set( rotation[ 0 ], rotation[ 1 ], rotation[ 2 ] );
		transform.scale.set( scale[ 0 ], scale[ 1 ], scale[ 2 ] );
		transform.updateMatrix();
		boxes.setMatrixAt( index, transform.matrix );
	} );
	scene.add( boxes );

	const createAreaLightMaterial = ( intensity ) => new MeshLambertMaterial( {
		color: 0x000000,
		emissive: 0xffffff,
		emissiveIntensity: intensity,
	} );
	const areaLights = [
		[ 50, [ - 16.116, 14.37, 8.208 ], [ 0.1, 2.428, 2.739 ] ],
		[ 50, [ - 16.109, 18.021, - 8.207 ], [ 0.1, 2.425, 2.751 ] ],
		[ 17, [ 14.904, 12.198, - 1.832 ], [ 0.15, 4.265, 6.331 ] ],
		[ 43, [ - 0.462, 8.89, 14.520 ], [ 4.38, 5.441, 0.088 ] ],
		[ 20, [ 3.235, 11.486, - 12.541 ], [ 2.5, 2.0, 0.1 ] ],
		[ 100, [ 0.0, 20.0, 0.0 ], [ 1.0, 0.1, 1.0 ] ],
	];
	for ( const [ intensity, position, scale ] of areaLights ) {
		const light = new Mesh( geometry, createAreaLightMaterial( intensity ) );
		light.position.set( position[ 0 ], position[ 1 ], position[ 2 ] );
		light.scale.set( scale[ 0 ], scale[ 1 ], scale[ 2 ] );
		scene.add( light );
	}

	scene.dispose = function () {
		const resources = new Set();
		this.traverse( ( object ) => {
			if ( object && object.isMesh ) {
				resources.add( object.geometry );
				resources.add( object.material );
			}
		} );
		for ( const resource of resources ) {
			try { resource.dispose && resource.dispose(); } catch ( _ ) {}
		}
	};

	return scene;
}

function __copyFullObjectState( source, target ) {
	if ( ! source || ! target ) return;
	target.name = source.name || target.name;
	target.visible = source.visible !== false;
	if ( source.position && target.position && typeof target.position.copy === 'function' ) target.position.copy( source.position );
	if ( source.quaternion && target.quaternion && typeof target.quaternion.copy === 'function' ) target.quaternion.copy( source.quaternion );
	if ( source.scale && target.scale && typeof target.scale.copy === 'function' ) target.scale.copy( source.scale );
	if ( source.rotation && target.rotation && typeof target.rotation.copy === 'function' ) target.rotation.copy( source.rotation );
	if ( source.matrix && target.matrix && typeof target.matrix.copy === 'function' ) target.matrix.copy( source.matrix );
	if ( source.matrixWorld && target.matrixWorld && typeof target.matrixWorld.copy === 'function' ) target.matrixWorld.copy( source.matrixWorld );
	target.matrixAutoUpdate = source.matrixAutoUpdate !== false;
	target.matrixWorldAutoUpdate = source.matrixWorldAutoUpdate !== false;
}

function __copyFullTextureState( source, target ) {
	if ( ! source || ! target ) return;
	target.name = source.name || target.name;
	for ( const key of [ 'mapping', 'channel', 'wrapS', 'wrapT', 'wrapR', 'magFilter', 'minFilter', 'anisotropy', 'format', 'internalFormat', 'type', 'generateMipmaps', 'premultiplyAlpha', 'flipY', 'unpackAlignment', 'colorSpace', 'compareFunction' ] ) {
		if ( source[ key ] !== undefined ) {
			try { target[ key ] = source[ key ]; } catch ( _ ) {}
		}
	}
	for ( const key of [ 'offset', 'repeat', 'center', 'matrix' ] ) {
		if ( source[ key ] && target[ key ] && typeof target[ key ].copy === 'function' ) {
			try { target[ key ].copy( source[ key ] ); } catch ( _ ) {}
		}
	}
	try { target.rotation = source.rotation || 0; } catch ( _ ) {}
	try { target.matrixAutoUpdate = source.matrixAutoUpdate !== false; } catch ( _ ) {}
}

function __cloneTextureForFullRenderer( Three, source, createdTextures ) {
	if ( ! Three || ! source || source.isTexture !== true ) return source || null;
	let texture = null;
	try {
		const image = source.image;
		if ( source.isCubeTexture === true && Three.CubeTexture ) {
			texture = new Three.CubeTexture( image );
		} else if ( source.isDataTexture === true && Three.DataTexture && image && image.data && Number.isFinite( image.width ) && Number.isFinite( image.height ) ) {
			texture = new Three.DataTexture( image.data, image.width, image.height, source.format, source.type, source.mapping, source.wrapS, source.wrapT, source.magFilter, source.minFilter, source.anisotropy, source.colorSpace );
		} else if ( source.isCompressedTexture === true && Three.CompressedTexture && image && Array.isArray( image.mipmaps ) && Number.isFinite( image.width ) && Number.isFinite( image.height ) ) {
			texture = new Three.CompressedTexture( image.mipmaps, image.width, image.height, source.format, source.type, source.mapping, source.wrapS, source.wrapT, source.magFilter, source.minFilter, source.anisotropy, source.colorSpace );
		} else if ( Three.Texture ) {
			texture = new Three.Texture( image );
		}
	} catch ( _ ) {
		texture = null;
	}
	if ( ! texture ) return source;
	__copyFullTextureState( source, texture );
	texture.needsUpdate = true;
	if ( createdTextures ) createdTextures.add( texture );
	return texture;
}

function __makeFullPMREMMaterial( Three, source, createdTextures ) {
	if ( ! Three || ! source ) return null;
	const Ctor = ( source.isMeshPhysicalMaterial || source.isMeshPhysicalNodeMaterial ) && Three.MeshPhysicalMaterial ? Three.MeshPhysicalMaterial
		: ( source.isMeshStandardMaterial || source.isMeshStandardNodeMaterial ) && Three.MeshStandardMaterial ? Three.MeshStandardMaterial
			: ( source.isMeshLambertMaterial || source.isMeshLambertNodeMaterial ) && Three.MeshLambertMaterial ? Three.MeshLambertMaterial
				: ( source.isMeshBasicMaterial || source.isMeshBasicNodeMaterial ) && Three.MeshBasicMaterial ? Three.MeshBasicMaterial
					: null;
	if ( ! Ctor ) return null;
	const material = new Ctor();
	for ( const key of [ 'side', 'transparent', 'opacity', 'alphaTest', 'depthTest', 'depthWrite', 'toneMapped', 'blending', 'premultipliedAlpha', 'wireframe', 'roughness', 'metalness' ] ) {
		if ( source[ key ] !== undefined ) {
			try { material[ key ] = source[ key ]; } catch ( _ ) {}
		}
	}
	for ( const key of [ 'color', 'emissive', 'specular' ] ) {
		if ( source[ key ] && material[ key ] && typeof material[ key ].copy === 'function' ) {
			try { material[ key ].copy( source[ key ] ); } catch ( _ ) {}
		}
	}
	for ( const key of [ 'map', 'envMap', 'emissiveMap', 'alphaMap', 'aoMap', 'lightMap' ] ) {
		if ( source[ key ] && source[ key ].isTexture === true ) material[ key ] = __cloneTextureForFullRenderer( Three, source[ key ], createdTextures );
	}
	material.needsUpdate = true;
	return material;
}

function __makeFullSceneForPMREM( scene, Three ) {
	if ( ! scene || ! Three || ! Three.Scene || ! Three.Mesh || ! Three.Group ) return null;
	const createdMaterials = new Set();
	const createdTextures = new Set();
	const fullScene = new Three.Scene();
	__copyFullObjectState( scene, fullScene );
	if ( scene.background && scene.background.isColor && Three.Color ) {
		fullScene.background = new Three.Color().copy( scene.background );
	} else {
		fullScene.background = __cloneTextureForFullRenderer( Three, scene.background, createdTextures ) || scene.background || null;
	}
	fullScene.environment = __cloneTextureForFullRenderer( Three, scene.environment, createdTextures ) || scene.environment || null;

	const cloneNode = ( source ) => {
		if ( ! source || source.visible === false ) return null;
		if ( source.isSkinnedMesh === true || source.isInstancedMesh === true ) return null;
		let target = null;
		if ( source.isMesh === true ) {
			const material = __makeFullPMREMMaterial( Three, Array.isArray( source.material ) ? source.material[ 0 ] : source.material, createdTextures );
			if ( ! material ) return null;
			createdMaterials.add( material );
			target = new Three.Mesh( __cloneGeometryForFullRenderer( source.geometry ), material );
		} else if ( source.isGroup === true || Array.isArray( source.children ) ) {
			target = new Three.Group();
		} else {
			return null;
		}
		__copyFullObjectState( source, target );
		for ( const child of source.children || [] ) {
			const cloned = cloneNode( child );
			if ( cloned ) target.add( cloned );
		}
		return target;
	};

	for ( const child of scene.children || [] ) {
		const cloned = cloneNode( child );
		if ( ! cloned && child && child.visible !== false ) return null;
		if ( cloned ) fullScene.add( cloned );
	}
	fullScene.dispose = function () {
		for ( const material of createdMaterials ) {
			try { material.dispose && material.dispose(); } catch ( _ ) {}
		}
		for ( const texture of createdTextures ) {
			try { texture.dispose && texture.dispose(); } catch ( _ ) {}
		}
	};
	return fullScene;
}

function __preparePMREMArgsForFullRenderer( method, args ) {
	if ( method !== 'fromScene' || ! args || ! args[ 0 ] ) return args;
	const scene = args[ 0 ];
	const isRoomEnvironment = scene.name === 'RoomEnvironment' || scene.constructor && scene.constructor.name === 'RoomEnvironment';
	const fullScene = isRoomEnvironment ? __makeFullRoomEnvironment( __fullThreeMod ) : __makeFullSceneForPMREM( scene, __fullThreeMod );
	try {
		const diag = __pmremDiagnostics();
		diag.syncFullSceneClone = ( diag.syncFullSceneClone || 0 ) + ( fullScene ? 1 : 0 );
		diag.syncFullSceneCloneMiss = ( diag.syncFullSceneCloneMiss || 0 ) + ( fullScene ? 0 : 1 );
		if ( fullScene ) {
			const childCount = fullScene.children && fullScene.children.length || 0;
			diag.syncFullSceneChildren = Math.max( diag.syncFullSceneChildren || 0, childCount );
		}
		if ( ! Array.isArray( diag.syncFullSceneSamples ) ) diag.syncFullSceneSamples = [];
		if ( diag.syncFullSceneSamples.length < 4 ) {
			const firstMesh = Array.isArray( scene.children ) ? scene.children.find( ( child ) => child && child.isMesh === true ) : null;
			const material = firstMesh && ( Array.isArray( firstMesh.material ) ? firstMesh.material[ 0 ] : firstMesh.material ) || null;
			diag.syncFullSceneSamples.push( {
				roomEnvironment: isRoomEnvironment,
				inputChildren: scene.children && scene.children.length || 0,
				outputChildren: fullScene && fullScene.children && fullScene.children.length || 0,
				inputFirstMesh: firstMesh && ( firstMesh.name || firstMesh.type || firstMesh.constructor && firstMesh.constructor.name ) || '',
				inputFirstMaterial: material && ( material.type || material.constructor && material.constructor.name ) || '',
				inputFirstMaterialFlags: material ? {
					basic: material.isMeshBasicMaterial === true,
					basicNode: material.isMeshBasicNodeMaterial === true,
					standard: material.isMeshStandardMaterial === true,
					standardNode: material.isMeshStandardNodeMaterial === true,
					physical: material.isMeshPhysicalMaterial === true,
					physicalNode: material.isMeshPhysicalNodeMaterial === true,
				} : null,
			} );
		}
	} catch ( _ ) {}
	return fullScene ? [ fullScene, ...args.slice( 1 ) ] : args;
}

// Wrap PMREMGenerator.{fromScene,fromCubemap,fromEquirectangular,fromTexture}
// to (1) bump __pmremRunning around the entire call so nested renderer.render
// calls inside them bypass __prepareSceneForReplay, and (2) route the call to
// the full compute renderer when one is available — PMREMGenerator's blur
// passes construct an internal NodeMaterial (PMREMGenerator.js _getMaterial),
// and the slim renderer's rewritten Nodes.js:getForRender throws
// tslPrecompileSlimOnly on any non-PrecompiledMaterial. The full renderer can
// build NodeMaterial; both renderers share the same WebGPU device, so the
// resulting GPUTexture is shared back to the slim backend so subsequent
// slim renders can sample it. Without this, examples that call
// pmremGen.fromScene(RoomEnvironment) (e.g. webgpu_materials_alphahash) leave
// scene.environment as a partially-initialized texture and PBR materials
// shade to black. Without (1), the FIRST nested render fires hydration on
// PMREM's internal tmp-meshes against our scene-replace table, which
// (a) MISSes (registry empty pre-init) and (b) caches dead bindings before
// the user's main scene ever runs.
const __pmremOriginalMethods = new Map();

try {
	if ( typeof Slim.setTextureResolutionDebugHook === 'function' ) {
		Slim.setTextureResolutionDebugHook( ( event ) => {
			if ( ! event || event.sourceKind !== 'artifact.texture' ) return;
			const textureName = event.resolvedTextureName || event.textureName || '';
			try {
				const diag = __harnessDiagnostics();
				const all = diag.textureResolutions || ( diag.textureResolutions = [] );
				const refs = event.artifact && event.artifact._textureRefs instanceof Map ? event.artifact._textureRefs : null;
				const refTexture = refs && event.textureUuid ? refs.get( event.textureUuid ) : null;
				const refImage = refTexture && refTexture.image || null;
				if ( all.length < 80 ) all.push( {
					strategy: event.strategy,
					artifactShape: event.artifact && ( event.artifact.__tslpAuxShape || event.artifact.materialShape || event.artifact.shape ) || '',
					artifactName: event.artifact && ( event.artifact.__tslpAuxName || event.artifact.name || event.artifact.__name ) || '',
					bindingName: event.bindingName,
					sourceUuid: event.textureUuid || '',
					textureName,
					resolvedType: event.resolvedTextureType || '',
					resolvedUuid: event.resolvedTextureUuid || '',
					refName: refTexture && refTexture.name || '',
					refType: refTexture && ( refTexture.isCubeTexture ? 'cube' : refTexture.isRenderTargetTexture ? 'render-target' : refTexture.isTexture ? 'texture' : typeof refTexture ) || '',
					refWidth: Array.isArray( refImage ) ? refImage[ 0 ] && refImage[ 0 ].width : refImage && refImage.width,
					refHeight: Array.isArray( refImage ) ? refImage[ 0 ] && refImage[ 0 ].height : refImage && refImage.height,
					refsSize: refs ? refs.size : 0,
					sourceTextureName: event.textureName || '',
					width: event.resolvedTextureWidth,
					height: event.resolvedTextureHeight,
				} );
			} catch ( _ ) {}
			if ( textureName !== 'PMREM.cubeUv' ) return;
			const diag = __pmremDiagnostics();
			if ( ! Array.isArray( diag.resolvedPmremTextures ) ) diag.resolvedPmremTextures = [];
			if ( diag.resolvedPmremTextures.length >= 8 ) return;
			diag.resolvedPmremTextures.push( {
				strategy: event.strategy,
				bindingName: event.bindingName,
				textureName,
				width: event.resolvedTextureWidth,
				height: event.resolvedTextureHeight,
			} );
		} );
	}
} catch ( _ ) {}

function __runPMREMGeneratorMethod( self, method, args ) {
	__pmremRunning ++;
	const slimRenderer = self && self._renderer;
	const fullRenderer = __computeRenderer;
	const FullPMREMGenerator = __fullThreeMod && __fullThreeMod.PMREMGenerator;
	const useFull = fullRenderer && fullRenderer !== slimRenderer && slimRenderer && slimRenderer.backend && typeof FullPMREMGenerator === 'function';
	try {
		const diag = __pmremDiagnostics();
		diag.syncCalls = ( diag.syncCalls || 0 ) + 1;
		diag.syncUseFull = ( diag.syncUseFull || 0 ) + ( useFull ? 1 : 0 );
		diag.syncFallback = ( diag.syncFallback || 0 ) + ( useFull ? 0 : 1 );
		diag.syncMethods = diag.syncMethods || {};
		diag.syncMethods[ method ] = ( diag.syncMethods[ method ] || 0 ) + 1;
		diag.syncLast = { method, hasFullRenderer: !! fullRenderer, hasFullMod: !! __fullThreeMod, hasFullPMREMGenerator: typeof FullPMREMGenerator === 'function', hasSlimRenderer: !! slimRenderer, hasSlimBackend: !! ( slimRenderer && slimRenderer.backend ) };
	} catch ( _ ) {}
	try {
		let target;
		let fullArgs = args;
		if ( useFull ) {
			const gen = new FullPMREMGenerator( fullRenderer );
			try {
				fullArgs = __preparePMREMArgsForFullRenderer( method, args );
				target = gen[ method ]( ...fullArgs );
			} finally {
				try { gen.dispose && gen.dispose(); } catch ( _ ) {}
				if ( fullArgs !== args && fullArgs[ 0 ] && typeof fullArgs[ 0 ].dispose === 'function' ) {
					try { fullArgs[ 0 ].dispose(); } catch ( _ ) {}
				}
			}
		} else {
			const orig = __pmremOriginalMethods.get( method ) || Slim.PMREMGenerator && Slim.PMREMGenerator.prototype && Slim.PMREMGenerator.prototype[ method ];
			target = typeof orig === 'function' ? orig.apply( self, args ) : undefined;
		}
		if ( useFull && target && target.texture && target.texture.isTexture === true ) {
			__sharePMREMGPUTexture( slimRenderer, fullRenderer, target.texture );
			__pmremCache.set( target.texture, target.texture );
			Slim.registerLiveTexture( target.texture );
		}
		return target;
	} finally {
		__pmremRunning --;
	}
}

( function patchPMREMGenerator() {
	const PG = Slim.PMREMGenerator;
	if ( ! PG || ! PG.prototype || PG.prototype.__tslpPatched ) return;
	PG.prototype.__tslpPatched = true;
	for ( const method of [ 'fromScene', 'fromCubemap', 'fromEquirectangular', 'fromTexture' ] ) {
		const orig = PG.prototype[ method ];
		if ( typeof orig !== 'function' ) continue;
		__pmremOriginalMethods.set( method, orig );
		PG.prototype[ method ] = function ( ...args ) {
			__pmremRunning ++;
			const slimRenderer = this._renderer;
			const fullRenderer = __computeRenderer;
			const FullPMREMGenerator = __fullThreeMod && __fullThreeMod.PMREMGenerator;
			const useFull = fullRenderer && fullRenderer !== slimRenderer && slimRenderer && slimRenderer.backend && typeof FullPMREMGenerator === 'function';
			try {
				const diag = __pmremDiagnostics();
				diag.syncCalls = ( diag.syncCalls || 0 ) + 1;
				diag.syncUseFull = ( diag.syncUseFull || 0 ) + ( useFull ? 1 : 0 );
				diag.syncFallback = ( diag.syncFallback || 0 ) + ( useFull ? 0 : 1 );
				diag.syncMethods = diag.syncMethods || {};
				diag.syncMethods[ method ] = ( diag.syncMethods[ method ] || 0 ) + 1;
				diag.syncLast = { method, hasFullRenderer: !! fullRenderer, hasFullMod: !! __fullThreeMod, hasFullPMREMGenerator: typeof FullPMREMGenerator === 'function', hasSlimRenderer: !! slimRenderer, hasSlimBackend: !! ( slimRenderer && slimRenderer.backend ) };
			} catch ( _ ) {}
			try {
				let target;
				let fullArgs = args;
				if ( useFull ) {
					const gen = new FullPMREMGenerator( fullRenderer );
					try {
						fullArgs = __preparePMREMArgsForFullRenderer( method, args );
						target = gen[ method ]( ...fullArgs );
					} finally {
						try { gen.dispose && gen.dispose(); } catch ( _ ) {}
						if ( fullArgs !== args && fullArgs[ 0 ] && typeof fullArgs[ 0 ].dispose === 'function' ) {
							try { fullArgs[ 0 ].dispose(); } catch ( _ ) {}
						}
					}
				} else {
					target = orig.apply( this, args );
				}
				if ( useFull && target && target.texture && target.texture.isTexture === true ) {
					__sharePMREMGPUTexture( slimRenderer, fullRenderer, target.texture );
					// Self-cache: __wireEnvironmentPMREM does __pmremCache.get(scene.environment)
					// where scene.environment IS this PMREM texture. Identity-map it so the
					// existing wiring path picks it up without needing a separate source key.
					__pmremCache.set( target.texture, target.texture );
					Slim.registerLiveTexture( target.texture );
				}
				return target;
			} finally {
				__pmremRunning --;
			}
		};
	}
} )();

export class PMREMGenerator extends Slim.PMREMGenerator {
	fromScene( ...args ) { return __runPMREMGeneratorMethod( this, 'fromScene', args ); }
	fromCubemap( ...args ) { return __runPMREMGeneratorMethod( this, 'fromCubemap', args ); }
	fromEquirectangular( ...args ) { return __runPMREMGeneratorMethod( this, 'fromEquirectangular', args ); }
	fromTexture( ...args ) { return __runPMREMGeneratorMethod( this, 'fromTexture', args ); }
}

// Copy the PMREM GPU-texture entry from the full renderer's backend WeakMap
// into the slim renderer's backend WeakMap so the slim renderer can bind the
// already-created GPUTexture without trying to upload from (empty) CPU data.
// Both renderers must share the same WebGPU device for this to be safe.
// Extracted from __generatePMREMAsync so the synchronous PMREMGenerator
// patch above can reuse it.
// Thin wrappers around @tsl-precompile/runtime/slim-support/gpu-texture-share.
// The harness owns the diagnostics objects (PMREM counters + harness-wide
// textureShare counter); the runtime module owns the GPU-data-copy logic and
// is exercised by runtime/test/slim-support-gpu-texture-share.test.js.
function __sharePMREMGPUTexture( slimRenderer, fullRenderer, pmrem ) {
	const shared = __sharedSharePMREMGPUTexture( slimRenderer, fullRenderer, pmrem, {
		diagnostics: __pmremDiagnostics(),
		onError: ( err ) => console.warn( '[tslp-e2e] PMREM GPU share failed:', err && err.message || err ),
	} );
	if ( __isPMREMTexture( pmrem ) ) __queuePMREMGPUReadbackDiagnostic( slimRenderer, fullRenderer, pmrem );
	return shared;
}

// Opt-in GPU-side PMREM evidence. Texture-resolution diagnostics only prove
// that hydration selected the intended JavaScript Texture. They cannot prove
// that the shared GPUTexture contains the generated HDR atlas rather than an
// all-zero/default resource. TSLP_DEBUG_PMREM_READBACK=1 reads representative
// CubeUV face centers from four packed roughness LODs through the full backend,
// then repeats the read through the slim backend only when both renderers
// expose the exact same GPUTexture on the exact same device.
const __pmremReadbackQueued = new WeakSet();

function __halfFloatToNumber( bits ) {
	const sign = ( bits & 0x8000 ) === 0 ? 1 : - 1;
	const exponent = ( bits >>> 10 ) & 0x1f;
	const fraction = bits & 0x03ff;
	if ( exponent === 0 ) return sign * Math.pow( 2, - 14 ) * ( fraction / 1024 );
	if ( exponent === 0x1f ) return fraction === 0 ? sign * Infinity : NaN;
	return sign * Math.pow( 2, exponent - 15 ) * ( 1 + fraction / 1024 );
}

function __pmremReadbackFormatInfo( format ) {
	const normalized = String( format || '' ).toLowerCase();
	const packed = normalized.includes( 'rgb9e5' ) || normalized.includes( 'rg11b10' ) || normalized.includes( 'rgb10a2' );
	const channels = packed ? 1
		: normalized.startsWith( 'rgba' ) || normalized.startsWith( 'bgra' ) ? 4
			: normalized.startsWith( 'rg' ) ? 2 : 1;
	let encoding = 'raw';
	let decode = ( value ) => Number( value );
	if ( normalized.includes( '16float' ) ) {
		encoding = 'float16';
		decode = ( value ) => __halfFloatToNumber( Number( value ) );
	} else if ( normalized.includes( '32float' ) || normalized.includes( 'depth32float' ) ) {
		encoding = 'float32';
	} else if ( normalized.includes( '8unorm' ) ) {
		encoding = 'unorm8';
		decode = ( value ) => Number( value ) / 255;
	} else if ( normalized.includes( '16unorm' ) ) {
		encoding = 'unorm16';
		decode = ( value ) => Number( value ) / 65535;
	} else if ( normalized.includes( '8snorm' ) ) {
		encoding = 'snorm8';
		decode = ( value ) => Math.max( - 1, Number( value ) / 127 );
	} else if ( normalized.includes( '16snorm' ) ) {
		encoding = 'snorm16';
		decode = ( value ) => Math.max( - 1, Number( value ) / 32767 );
	} else if ( packed ) {
		encoding = 'packed-uint32';
	}
	return { channels, encoding, isBGRA: normalized.startsWith( 'bgra' ), decode };
}

function __pmremReadbackSerializableNumber( value ) {
	if ( Number.isFinite( value ) ) return Number( value.toPrecision( 8 ) );
	if ( Number.isNaN( value ) ) return 'NaN';
	return value < 0 ? '-Infinity' : 'Infinity';
}

function __pmremReadbackValueStats( values ) {
	let finiteCount = 0;
	let nonzeroCount = 0;
	let positiveCount = 0;
	let negativeCount = 0;
	let min = Infinity;
	let max = - Infinity;
	let sum = 0;
	let absoluteSum = 0;
	for ( const value of values ) {
		if ( ! Number.isFinite( value ) ) continue;
		finiteCount ++;
		if ( value !== 0 ) nonzeroCount ++;
		if ( value > 0 ) positiveCount ++;
		if ( value < 0 ) negativeCount ++;
		min = Math.min( min, value );
		max = Math.max( max, value );
		sum += value;
		absoluteSum += Math.abs( value );
	}
	return {
		count: values.length,
		finiteCount,
		nonfiniteCount: values.length - finiteCount,
		nonzeroCount,
		positiveCount,
		negativeCount,
		min: finiteCount > 0 ? __pmremReadbackSerializableNumber( min ) : null,
		max: finiteCount > 0 ? __pmremReadbackSerializableNumber( max ) : null,
		mean: finiteCount > 0 ? __pmremReadbackSerializableNumber( sum / finiteCount ) : null,
		absoluteMean: finiteCount > 0 ? __pmremReadbackSerializableNumber( absoluteSum / finiteCount ) : null,
	};
}

function __pmremReadbackTextureSnapshot( renderer, pmrem ) {
	const backend = renderer && renderer.backend;
	if ( ! backend || typeof backend.get !== 'function' ) return { data: null, snapshot: null };
	const data = backend.get( pmrem ) || null;
	const descriptor = data && data.textureDescriptorGPU || null;
	const size = descriptor && descriptor.size || null;
	const gpuTexture = data && data.texture || null;
	const image = pmrem && pmrem.image || null;
	const width = Number( size && size.width || gpuTexture && gpuTexture.width || image && image.width || 0 );
	const height = Number( size && size.height || gpuTexture && gpuTexture.height || image && image.height || 0 );
	return {
		data,
		snapshot: {
			hasGPUTexture: !! gpuTexture,
			format: data && ( data.format || descriptor && descriptor.format ) || gpuTexture && gpuTexture.format || '',
			width,
			height,
			depthOrArrayLayers: Number( size && size.depthOrArrayLayers || gpuTexture && gpuTexture.depthOrArrayLayers || 0 ),
			mipLevelCount: Number( descriptor && descriptor.mipLevelCount || gpuTexture && gpuTexture.mipLevelCount || 0 ),
			sampleCount: Number( descriptor && descriptor.sampleCount || gpuTexture && gpuTexture.sampleCount || 0 ),
			dimension: descriptor && descriptor.dimension || gpuTexture && gpuTexture.dimension || '',
			usage: Number( descriptor && descriptor.usage || gpuTexture && gpuTexture.usage || 0 ),
			label: gpuTexture && gpuTexture.label || '',
		},
	};
}

function __pmremReadbackAtlasPoints( width, height ) {
	const points = [];
	const cubeSize = Math.floor( height / 4 );
	const looksLikeCubeUV = cubeSize >= 16 && width >= Math.min( 3 * cubeSize, 336 );
	if ( looksLikeCubeUV ) {
		const lodMax = Math.max( 4, Math.floor( Math.log2( cubeSize ) ) );
		const totalLods = lodMax - 4 + 1 + 6;
		const selected = [ 0, Math.floor( ( totalLods - 1 ) / 3 ), Math.floor( ( totalLods - 1 ) * 2 / 3 ), totalLods - 1 ];
		for ( const lodIndex of new Set( selected ) ) {
			const size = Math.pow( 2, Math.max( 4, lodMax - lodIndex ) );
			const extraColumn = lodIndex > lodMax - 4 ? lodIndex - lodMax + 4 : 0;
			const originX = 3 * size * extraColumn;
			const originY = 4 * ( cubeSize - size );
			for ( let face = 0; face < 6; face ++ ) {
				const column = face % 3;
				const row = face > 2 ? 1 : 0;
				const x = Math.max( 0, Math.min( width - 1, originX + column * size + Math.floor( size / 2 ) ) );
				const y = Math.max( 0, Math.min( height - 1, originY + row * size + Math.floor( size / 2 ) ) );
				points.push( {
					label: 'cubeuv-lod-' + lodIndex + '-face-' + face,
					x,
					y,
					gpuMipLevel: 0,
					atlasLodIndex: lodIndex,
					face,
					faceSize: size,
				} );
			}
		}
		return points;
	}
	for ( const yRatio of [ 0.125, 0.5, 0.875 ] ) {
		for ( const xRatio of [ 0.125, 0.5, 0.875 ] ) {
			points.push( {
				label: 'grid-' + xRatio + '-' + yRatio,
				x: Math.max( 0, Math.min( width - 1, Math.floor( width * xRatio ) ) ),
				y: Math.max( 0, Math.min( height - 1, Math.floor( height * yRatio ) ) ),
				gpuMipLevel: 0,
				atlasLodIndex: null,
				face: null,
				faceSize: null,
			} );
		}
	}
	return points;
}

async function __readPMREMBackendSamples( renderer, pmrem, points ) {
	const backend = renderer && renderer.backend;
	if ( ! backend || typeof backend.copyTextureToBuffer !== 'function' ) {
		return { status: 'unsupported', reason: 'backend.copyTextureToBuffer unavailable', samples: [] };
	}
	const { snapshot } = __pmremReadbackTextureSnapshot( renderer, pmrem );
	if ( ! snapshot || ! snapshot.hasGPUTexture ) return { status: 'missing-gpu-texture', samples: [] };
	const formatInfo = __pmremReadbackFormatInfo( snapshot.format );
	const samples = [];
	const numericComponents = [];
	const numericRGB = [];
	let failedSamples = 0;
	for ( const point of points ) {
		try {
			const raw = await backend.copyTextureToBuffer( pmrem, point.x, point.y, 1, 1, 0 );
			let values = Array.from( raw || [] ).slice( 0, formatInfo.channels ).map( formatInfo.decode );
			if ( formatInfo.isBGRA && values.length >= 3 ) values = [ values[ 2 ], values[ 1 ], values[ 0 ], ...values.slice( 3 ) ];
			numericComponents.push( ...values );
			numericRGB.push( ...values.slice( 0, Math.min( 3, values.length ) ) );
			samples.push( { ...point, values: values.map( __pmremReadbackSerializableNumber ) } );
		} catch ( err ) {
			failedSamples ++;
			samples.push( { ...point, error: err && err.message || String( err ) } );
		}
	}
	return {
		status: failedSamples === 0 ? 'complete' : failedSamples < points.length ? 'partial' : 'failed',
		format: snapshot.format,
		encoding: formatInfo.encoding,
		channels: formatInfo.channels,
		requestedSamples: points.length,
		successfulSamples: points.length - failedSamples,
		failedSamples,
		components: __pmremReadbackValueStats( numericComponents ),
		rgb: __pmremReadbackValueStats( numericRGB ),
		samples,
	};
}

function __pmremReadbackSamplesMatch( fullResult, slimResult ) {
	const fullSamples = fullResult && fullResult.samples || [];
	const slimSamples = slimResult && slimResult.samples || [];
	if ( fullSamples.length !== slimSamples.length ) return false;
	for ( let i = 0; i < fullSamples.length; i ++ ) {
		const a = fullSamples[ i ];
		const b = slimSamples[ i ];
		if ( a.label !== b.label || !! a.error !== !! b.error ) return false;
		const av = a.values || [];
		const bv = b.values || [];
		if ( av.length !== bv.length ) return false;
		for ( let j = 0; j < av.length; j ++ ) if ( av[ j ] !== bv[ j ] ) return false;
	}
	return true;
}

function __queuePMREMGPUReadbackDiagnostic( slimRenderer, fullRenderer, pmrem ) {
	if ( ! ( window.__TSLP_DEBUG_PMREM_READBACK === true ) ) return;
	if ( ! slimRenderer || ! fullRenderer || ! pmrem || __pmremReadbackQueued.has( pmrem ) ) return;
	const diagnostics = __pmremDiagnostics();
	const readback = diagnostics.readback || ( diagnostics.readback = {
		enabled: true,
		queued: 0,
		completed: 0,
		failed: 0,
		pending: 0,
		probes: [],
	} );
	if ( readback.probes.length >= 8 ) return;
	__pmremReadbackQueued.add( pmrem );
	const probe = {
		status: 'pending',
		textureName: pmrem.name || '',
		textureUuid: pmrem.uuid || '',
		textureVersion: pmrem.version | 0,
		mapping: pmrem.mapping,
	};
	readback.probes.push( probe );
	readback.queued ++;
	readback.pending ++;
	window.__tslpPmremPending = ( window.__tslpPmremPending | 0 ) + 1;
	Promise.resolve().then( async () => {
		const fullState = __pmremReadbackTextureSnapshot( fullRenderer, pmrem );
		const slimState = __pmremReadbackTextureSnapshot( slimRenderer, pmrem );
		const fullGPUTexture = fullState.data && fullState.data.texture || null;
		const slimGPUTexture = slimState.data && slimState.data.texture || null;
		const sameDevice = !! ( fullRenderer.backend && slimRenderer.backend && fullRenderer.backend.device && fullRenderer.backend.device === slimRenderer.backend.device );
		const sameGPUTexture = !! fullGPUTexture && fullGPUTexture === slimGPUTexture;
		const safeSlimRead = sameDevice && sameGPUTexture && typeof slimRenderer.backend.copyTextureToBuffer === 'function';
		probe.resourceIdentity = {
			sameDevice,
			sameGPUTexture,
			sameBackendData: !! fullState.data && fullState.data === slimState.data,
			safeSlimRead,
			full: fullState.snapshot,
			slim: slimState.snapshot,
		};
		const width = fullState.snapshot && fullState.snapshot.width || 0;
		const height = fullState.snapshot && fullState.snapshot.height || 0;
		if ( width <= 0 || height <= 0 ) throw new Error( 'PMREM readback has no positive texture dimensions' );
		const points = __pmremReadbackAtlasPoints( width, height );
		probe.full = await __readPMREMBackendSamples( fullRenderer, pmrem, points );
		if ( safeSlimRead ) {
			probe.slim = await __readPMREMBackendSamples( slimRenderer, pmrem, points );
			probe.sameDecodedSamples = __pmremReadbackSamplesMatch( probe.full, probe.slim );
		} else {
			probe.slim = { status: 'skipped', reason: sameGPUTexture ? 'renderer devices differ' : 'GPUTexture identity differs', samples: [] };
			probe.sameDecodedSamples = null;
		}
		probe.status = probe.full.status === 'complete' && ( probe.slim.status === 'complete' || probe.slim.status === 'skipped' )
			? 'complete'
			: 'failed';
		if ( probe.status === 'complete' ) readback.completed ++;
		else readback.failed ++;
	} ).catch( ( err ) => {
		probe.status = 'failed';
		probe.error = err && err.message || String( err );
		readback.failed ++;
	} ).finally( () => {
		readback.pending = Math.max( 0, ( readback.pending | 0 ) - 1 );
		window.__tslpPmremPending = Math.max( 0, ( window.__tslpPmremPending | 0 ) - 1 );
	} );
}

const __iblDfgReadbackQueued = new WeakSet();

function __iblDfgReadbackPoints( width, height ) {
	const xs = [ 0, Math.floor( width / 2 ), Math.max( 0, width - 1 ) ];
	const ys = [ 0, Math.floor( height / 2 ), Math.max( 0, height - 1 ) ];
	const points = [];
	for ( const y of new Set( ys ) ) {
		for ( const x of new Set( xs ) ) points.push( { label: 'dfg-' + x + '-' + y, x, y, gpuMipLevel: 0 } );
	}
	return points;
}

function __iblDfgCpuSamples( texture, points, channels ) {
	const image = texture && texture.image || null;
	const data = image && image.data || null;
	const width = image && image.width | 0;
	if ( ! data || width <= 0 ) return [];
	const valuesPerTexel = Math.max( 1, channels | 0 );
	return points.map( ( point ) => {
		const offset = ( point.y * width + point.x ) * valuesPerTexel;
		const values = [];
		for ( let channel = 0; channel < valuesPerTexel; channel ++ ) {
			values.push( __pmremReadbackSerializableNumber( __halfFloatToNumber( Number( data[ offset + channel ] ) ) ) );
		}
		return { label: point.label, values };
	} );
}

function __queueIBLDFGReadbackDiagnostic( renderer, texture ) {
	if ( window.__TSLP_DEBUG_IBL_BINDINGS !== true || ! renderer || ! texture || __iblDfgReadbackQueued.has( texture ) ) return;
	__iblDfgReadbackQueued.add( texture );
	const diag = __harnessDiagnostics();
	const ibl = diag.ibl || ( diag.ibl = {} );
	const readback = ibl.dfgReadback || ( ibl.dfgReadback = {
		queued: 0,
		completed: 0,
		failed: 0,
		pending: 0,
		probes: [],
	} );
	const probe = {
		status: 'pending',
		textureName: texture.name || '',
		textureUuid: texture.uuid || '',
		textureVersion: texture.version | 0,
	};
	readback.probes.push( probe );
	readback.queued ++;
	readback.pending ++;
	window.__tslpPmremPending = ( window.__tslpPmremPending | 0 ) + 1;
	Promise.resolve().then( async () => {
		const state = __pmremReadbackTextureSnapshot( renderer, texture );
		probe.resource = state.snapshot;
		const width = state.snapshot && state.snapshot.width || 0;
		const height = state.snapshot && state.snapshot.height || 0;
		if ( width <= 0 || height <= 0 ) throw new Error( 'DFG LUT readback has no positive texture dimensions' );
		const points = __iblDfgReadbackPoints( width, height );
		probe.gpu = await __readPMREMBackendSamples( renderer, texture, points );
		probe.cpu = __iblDfgCpuSamples( texture, points, probe.gpu.channels );
		probe.sameDecodedSamples = __pmremReadbackSamplesMatch(
			{ samples: probe.cpu },
			{ samples: probe.gpu.samples },
		);
		probe.status = probe.gpu.status === 'complete' && probe.sameDecodedSamples === true ? 'complete' : 'failed';
		if ( probe.status === 'complete' ) readback.completed ++;
		else readback.failed ++;
	} ).catch( ( err ) => {
		probe.status = 'failed';
		probe.error = err && err.message || String( err );
		readback.failed ++;
	} ).finally( () => {
		readback.pending = Math.max( 0, ( readback.pending | 0 ) - 1 );
		window.__tslpPmremPending = Math.max( 0, ( window.__tslpPmremPending | 0 ) - 1 );
	} );
}

function __shareGPUTextureEntry( targetRenderer, sourceRenderer, texture, options = {} ) {
	const diag = typeof __harnessDiagnostics === 'function' ? __harnessDiagnostics() : null;
	const shareDiag = diag ? ( diag.textureShare || ( diag.textureShare = { calls: 0, noSourceData: 0, noSourceTexture: 0, success: 0, names: [], missingNames: [] } ) ) : null;
	__sharedShareGPUTextureEntry( targetRenderer, sourceRenderer, texture, {
		...options,
		diagnostics: shareDiag,
		onError: ( err ) => console.warn( '[tslp-e2e] GPU texture share failed:', err && err.message || err ),
	} );
}

function __recordRenderableObjectCount( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	let count = 0;
	try {
		scene.traverse( ( object ) => {
			if ( object && object.visible !== false && object.geometry && object.material ) count ++;
		} );
	} catch ( _ ) {
		return 0;
	}
	const prev = window.__tslpRenderableObjectCount | 0;
	if ( count !== prev ) {
		window.__tslpRenderableObjectCount = count;
		window.__tslpRenderableLastBusyAt = typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now();
	}
	return count;
}

function __markSlimTextureInitialized( slimRenderer, texture ) {
	__sharedMarkTextureInitialized( slimRenderer, texture );
}

function __clearTextureViewCache( textureData ) {
	__sharedClearTextureViewCache( textureData );
}

// Thin wrapper — see @tsl-precompile/runtime/slim-support/gpu-texture-share
// for the version-bump / view-cache-clear / cross-renderer wiring rationale.
function __shareShadowGpuTextureIntoSlim( tex, fullRenderer, slimRenderer ) {
	return __sharedShareShadowGpuTextureIntoSlim( tex, fullRenderer, slimRenderer );
}

// Detect at boot whether any registered background-aux artifact references a
// PMREM-prefiltered (CubeUVReflectionMapping) source. The capture-time
// extractor stamps source.textureName === 'PMREM.cubeUv' and/or
// source.mapping === 306 (CubeUVReflectionMapping) on every
// artifact.texture binding that came from backgroundBlurriness > 0.
// When this is true, the live cubemap on scene.background must be run
// through PMREMGenerator before being wired into the artifact's
// _textureRefs - wiring the raw cube produces a sharper / wrong sky
// because the WGSL declares the binding as texture_2d.
const __backgroundNeedsPMREM = ( function () {
	const auxList = Array.isArray( __data.aux ) ? __data.aux : [];
	for ( const entry of auxList ) {
		if ( ! entry || entry.shape !== 'background' || ! entry.artifact ) continue;
		const groups = Array.isArray( entry.artifact.uniformPlan ) ? entry.artifact.uniformPlan : [];
		for ( const group of groups ) {
			const textures = Array.isArray( group.textures ) ? group.textures : [];
			for ( const t of textures ) {
				const src = t && t.source || {};
				if ( src.kind !== 'artifact.texture' ) continue;
				if ( src.textureName === 'PMREM.cubeUv' ) return true;
				if ( src.mapping === 306 ) return true; // CubeUVReflectionMapping
			}
		}
	}
	return false;
} )();

	// Track every Texture loaded via *Loader.load so the hydrator can relink
	// captured artifact.texture-kind bindings (whose captured textureUuid is
	// dead on reload) by imageSrc / textureName. Production code keeps the
	// same Texture instance and hits the UUID path; this index is harness-
	// and test-only.
	function __forceRenderAfterLoaderTexture() {
		const pipeline = window.__tslpLastRenderPipeline || null;
		if ( ! pipeline || typeof pipeline.render !== 'function' || pipeline.__tslpLoaderForceRenderQueued === true ) return;
		pipeline.__tslpLoaderForceRenderQueued = true;
		Promise.resolve().then( () => {
			pipeline.__tslpLoaderForceRenderQueued = false;
			try {
				__sharedWithTemporalFrame(
					[ pipeline.renderer, __computeRenderer ],
					__maintenanceTemporalFrame( 'loader' ),
					() => pipeline.render(),
				);
				const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
				diag.loaderForcedPipelineRenders = ( diag.loaderForcedPipelineRenders || 0 ) + 1;
			} catch ( e ) {
				console.warn( '[tslp-e2e] forced loader pipeline render failed:', e && e.message || e );
			}
		} );
	}

	function __refreshLoadedTexturePrecompiledRefs( texture ) {
		if ( ! ( texture && texture.isTexture === true ) ) return 0;
		const pipeline = window.__tslpLastRenderPipeline || null;
		if ( ! pipeline ) return 0;
		const passNodes = __collectPassNodesInGraph( pipeline.outputNode );
		let changed = 0;
		const shadowScenes = new Set();
		const shadowSceneCameras = new Map();
		for ( const passNode of passNodes ) {
			const scene = passNode && passNode.scene;
			if ( ! scene || typeof scene.traverse !== 'function' ) continue;
			scene.traverse( ( object ) => {
				const material = object && object.material;
				const list = Array.isArray( material ) ? material : material ? [ material ] : [];
				for ( const mat of list ) {
					if ( ! ( mat && mat.isPrecompiledMaterial === true && mat.precompiledArtifact ) ) continue;
					const attached = __attachArtifactTextureRefsWhere( mat.precompiledArtifact, texture, ( source ) => (
						! __isPMREMArtifactTextureSource( source ) && __textureMatchesArtifactSource( texture, source )
					) );
					if ( ! attached ) continue;
					mat.needsUpdate = true;
					try { mat.dispose && mat.dispose(); } catch ( _ ) {}
					if ( object && object.castShadow === true ) {
						shadowScenes.add( scene );
						if ( ! shadowSceneCameras.has( scene ) && passNode && passNode.camera ) shadowSceneCameras.set( scene, passNode.camera );
					}
					changed ++;
				}
			} );
		}
		for ( const scene of shadowScenes ) {
			const state = __shadowState.get( scene );
			if ( state ) {
				state.signature = '';
				state.queuedSignature = '';
			}
			__shadowSceneCache.delete( scene );
			try { __kickShadowRenderAsync( pipeline.renderer, scene, shadowSceneCameras.get( scene ) ); } catch ( _ ) {}
		}
		if ( changed > 0 ) {
			try {
				const renderer = pipeline.renderer || null;
				const nc = renderer && renderer._nodes && renderer._nodes.nodeBuilderCache;
				if ( nc && typeof nc.clear === 'function' ) nc.clear();
			} catch ( _ ) {}
			try {
				const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
				diag.loaderTextureRewired = ( diag.loaderTextureRewired || 0 ) + changed;
				if ( shadowScenes.size > 0 ) diag.loaderShadowInvalidated = ( diag.loaderShadowInvalidated || 0 ) + shadowScenes.size;
			} catch ( _ ) {}
		}
		return changed;
	}

	function __shadowMaterialUsesTexture( material, texture ) {
		if ( ! ( texture && texture.isTexture === true ) ) return false;
		const materials = __shadowSourceMaterials( material );
		for ( const mat of materials ) {
			if ( ! mat ) continue;
			for ( const key of [ 'positionNode', 'castShadowNode', 'castShadowPositionNode', 'maskShadowNode', 'maskNode', 'alphaTestNode', 'opacityNode' ] ) {
				const textures = __collectTexturesInNode( mat[ key ] );
				for ( const candidate of textures ) {
					if ( candidate === texture ) return true;
					if ( candidate && candidate.isTexture === true && candidate.uuid && candidate.uuid === texture.uuid ) return true;
				}
			}
			for ( const key of [ 'alphaMap', 'map' ] ) {
				const candidate = mat[ key ];
				if ( candidate === texture ) return true;
				if ( candidate && candidate.isTexture === true && candidate.uuid && candidate.uuid === texture.uuid ) return true;
			}
		}
		return false;
	}

	function __sceneShadowUsesTexture( scene, texture ) {
		if ( ! scene || typeof scene.traverse !== 'function' ) return false;
		let found = false;
		scene.traverse( ( object ) => {
			if ( found || ! object || object.castShadow !== true ) return;
			if ( __shadowMaterialUsesTexture( object.material, texture ) ) found = true;
		} );
		return found;
	}

	function __invalidateShadowRenderForTexture( texture ) {
		if ( ! ( texture && texture.isTexture === true ) ) return 0;
		const pipeline = window.__tslpLastRenderPipeline || null;
		if ( ! pipeline ) return 0;
		const passNodes = __collectPassNodesInGraph( pipeline.outputNode );
		let changed = 0;
		const seenScenes = new Set();
		for ( const passNode of passNodes ) {
			const scene = passNode && passNode.scene;
			if ( ! scene || seenScenes.has( scene ) || ! __sceneShadowUsesTexture( scene, texture ) ) continue;
			seenScenes.add( scene );
			const state = __shadowState.get( scene );
			if ( state ) {
				state.signature = '';
				state.queuedSignature = '';
			}
			__shadowSceneCache.delete( scene );
			changed ++;
		}
		if ( changed > 0 ) {
			try {
				const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
				diag.loaderShadowInvalidated = ( diag.loaderShadowInvalidated || 0 ) + changed;
			} catch ( _ ) {}
		}
		return changed;
	}

	( function patchLoaders() {
		const loaders = [
			[ 'TextureLoader', Slim.TextureLoader ],
			[ 'CubeTextureLoader', Slim.CubeTextureLoader ],
			[ 'DataTextureLoader', Slim.DataTextureLoader ],
		[ 'ImageBitmapLoader', Slim.ImageBitmapLoader ],
		[ 'FullTextureLoader', FullTextureLoader ],
		[ 'FullCubeTextureLoader', FullCubeTextureLoader ],
		[ 'FullDataTextureLoader', FullDataTextureLoader ],
		[ 'FullImageBitmapLoader', FullImageBitmapLoader ],
		];
		for ( const [ name, Ctor ] of loaders ) {
			if ( ! Ctor || ! Ctor.prototype || ! Ctor.prototype.load || Ctor.prototype.__tslpPatched ) continue;
			Ctor.prototype.__tslpPatched = true;
			const origLoad = Ctor.prototype.load;
			const _now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
			Ctor.prototype.load = function ( url, onLoad, onProgress, onError ) {
				let tex = null;
				window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
				window.__tslpLoaderLastBusyAt = _now();
				let settled = false;
				const settle = () => {
					if ( settled ) return;
					settled = true;
					window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
					window.__tslpLoaderLastBusyAt = _now();
					__forceRenderAfterLoaderTexture();
				};
				const remember = ( texture ) => {
					if ( texture && texture.isTexture === true ) {
						if ( typeof window.__tslpMarkLoaderTexture === 'function' ) {
							window.__tslpMarkLoaderTexture( texture, url );
					} else if ( ! texture.name && typeof url === 'string' ) {
						texture.name = url.split( '/' ).pop().split( '?' )[ 0 ];
					}
					__rememberLiveTexture( texture );
				}
			};
				const wrappedOnLoad = ( texOrImage, ...rest ) => {
					try {
						remember( texOrImage );
						try {
							const loadedTexture = texOrImage && texOrImage.isTexture === true ? texOrImage : tex;
							__refreshLoadedTexturePrecompiledRefs( loadedTexture );
							__invalidateShadowRenderForTexture( loadedTexture );
						} catch ( _ ) {}
						if ( typeof onLoad === 'function' ) onLoad.call( this, texOrImage, ...rest );
					} finally {
						remember( tex );
						settle();
					}
				};
				const wrappedOnError = ( err, ...rest ) => {
					try {
						if ( typeof onError === 'function' ) onError.call( this, err, ...rest );
					} finally {
						settle();
					}
				};
				try {
					tex = origLoad.call( this, url, wrappedOnLoad, onProgress, wrappedOnError );
					remember( tex );
					return tex;
				} catch ( err ) {
					settle();
					throw err;
				}
			};
		}
	} )();

function __nodeStub( auxConfigHash = null ) {
	const fn = function tslReplayNodeStub() { return proxy; };
	const proxy = new Proxy( fn, {
		get( _target, prop ) {
			if ( prop === Symbol.toPrimitive ) return () => 0;
			if ( prop === 'then' ) return undefined;
			if ( prop === 'isNode' ) return true;
			if ( prop === '__tslpNodeStub' ) return true;
			if ( prop === '__tslpAuxConfigHash' ) return auxConfigHash;
			if ( prop === 'toVar' ) return () => proxy;
			return proxy;
		},
		apply() { return proxy; },
		construct() { return proxy; },
	} );
	return proxy;
}

function __backgroundAuxConfigHashForScene( scene ) {
	if ( ! scene || typeof Slim.hashNodeGraphSync !== 'function' ) return null;
	const input = scene.backgroundNode || scene.background;
	if ( ! input ) return null;
	try {
		const hash = Slim.hashNodeGraphSync( input, { shape: 'background', threeVersion: ${ JSON.stringify( SLIM_HASH_OPTS.threeVersion ) }, pluginVersion: ${ JSON.stringify( SLIM_HASH_OPTS.pluginVersion ) } } );
		if ( hash && ( typeof Slim.hasAux !== 'function' || Slim.hasAux( 'background', hash ) ) ) return hash;
	} catch ( _ ) {}
	return null;
}

function __seedNodeProps( material ) {
	const stub = __nodeStub();
	// Limit to the original "always-seeded" set. The full __nodeGraphKeys()
	// list is too broad — adding lightNode/envNode/aoNode/transmissionNode
	// stubs to materials that didn't have them (e.g. MeshStandardNodeMaterial
	// in webgpu_shadowmap_pointlight.html) breaks the renderer's lighting
	// evaluation path. __copyMaterialNodeProps still walks the full list.
	for ( const key of [ 'colorNode', 'normalNode', 'positionNode', 'geometryNode', 'outputNode', 'roughnessNode', 'metalnessNode', 'emissiveNode', 'opacityNode', 'alphaTestNode' ] ) {
		if ( material[ key ] === undefined ) material[ key ] = stub;
	}
}

function __walkNodeSafely( rootNode, visitor, seen = new Set(), depth = 0 ) {
	if ( ! rootNode || ( typeof rootNode !== 'object' && typeof rootNode !== 'function' ) || depth > 64 || seen.has( rootNode ) ) return;
	if ( ArrayBuffer.isView( rootNode ) || rootNode instanceof ArrayBuffer ) return;
	if ( ! __isGraphTraversalCandidate( rootNode ) ) return;
	seen.add( rootNode );
	visitor( rootNode );
	const children = [];
		try {
			if ( typeof rootNode.getChildren === 'function' ) {
				const list = rootNode.getChildren();
				if ( Array.isArray( list ) ) children.push( ...list );
				else if ( list && typeof list[ Symbol.iterator ] === 'function' ) {
					for ( const child of list ) children.push( child );
				}
		}
	} catch ( _ ) {}
	const nodeChildren = __readGraphOwnValue( rootNode, '_children' );
	if ( Array.isArray( nodeChildren ) ) children.push( ...nodeChildren );
	const skip = new Set( [ 'parent', 'children', '_cache', 'renderer', 'geometry', 'material', 'domElement', 'array', 'buffer' ] );
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( rootNode ) ); } catch ( _ ) {}
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( rootNode, key );
		if ( child ) children.push( child );
	}
	for ( const child of children ) {
		if ( ! child || ( typeof child !== 'object' && typeof child !== 'function' ) ) continue;
		__walkNodeSafely( child, visitor, seen, depth + 1 );
	}
}

// Collect StorageBufferNode.value attributes by walking a node tree via traverse().
// Only picks up nodes with isStorageBufferNode to avoid vertex-attribute nodes
// (BufferAttributeNode wrapping storage) — those are handled separately.
function __collectStorageBufAttrs( rootNode, results ) {
	if ( ! rootNode ) return;
	__walkNodeSafely( rootNode, ( n ) => {
		if ( n.isStorageBufferNode === true && n.value &&
				( n.value.isStorageBufferAttribute === true || n.value.isStorageInstancedBufferAttribute === true ) ) {
			results.push( n.value );
		}
	} );
}

// Walk a node tree (including vertexNode/positionNode subtrees) and collect every
// BufferAttributeNode whose .value is a Storage(Instanced)BufferAttribute. This
// is the case when user code writes vertexNode = billboarding({ position:
// positionBuffer.toAttribute() }) — the leaf is BufferAttributeNode wrapping the
// storage attribute directly. Without this, compute-driven particle examples
// (rain, snow, points) hydrate brand-new empty StorageBufferAttribute placeholders
// in the slim render path and the compute output is never visible.
function __collectStorageAttrNodeAttrs( rootNode, results ) {
	if ( ! rootNode ) return;
	function isStorageVal( v ) { return v && ( v.isStorageBufferAttribute === true || v.isStorageInstancedBufferAttribute === true ); }
	const visit = ( n ) => {
		if ( n && n.isBufferNode === true && ! n.isStorageBufferNode && isStorageVal( n.value ) ) {
			if ( ! results.includes( n.value ) ) results.push( n.value );
		}
	};
	// Three r185's Node.traverse recursively revisits shared descendants. The
	// identity walker includes the root and every unique child without turning
	// large shared TSL DAGs into a quadratic traversal.
	__walkNodeSafely( rootNode, visit );
}

// Before creating a PrecompiledMaterial, inject live StorageBufferAttribute /
// StorageInstancedBufferAttribute objects from the source material's node graph
// into the artifact's plan entries so hydrateNodeBuilderState uses the live
// GPU-writable buffers instead of allocating fresh empty placeholders.
// This is required for compute-driven examples where instancedArray() creates
// a buffer that a compute kernel writes into and the render material reads from.
const __computeStorageAttrsByRenderer = new WeakMap();
const __computeStorageEvidenceByRenderer = new WeakMap();
const __unscopedComputeStorageAttrs = [];
const __unscopedComputeStorageEvidence = [];
function __computeDiagnostics() {
	if ( typeof window === 'undefined' ) return null;
	const root = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
	const diag = root.compute || ( root.compute = { storageAttrs: 0, storageShapes: [], fallbackWires: 0 } );
	return diag;
}
function __computeStorageLedger( map, fallback, renderer, create = false ) {
	if ( ! renderer || ( typeof renderer !== 'object' && typeof renderer !== 'function' ) ) return fallback;
	let ledger = map.get( renderer );
	if ( ! ledger && create ) {
		ledger = [];
		map.set( renderer, ledger );
	}
	return ledger || [];
}
function __computeStorageAttrsFor( renderer = null ) {
	return __computeStorageLedger( __computeStorageAttrsByRenderer, __unscopedComputeStorageAttrs, renderer, false );
}
function __computeStorageEvidenceFor( renderer = null ) {
	return __computeStorageLedger( __computeStorageEvidenceByRenderer, __unscopedComputeStorageEvidence, renderer, false );
}
function __rememberComputeStorageAttr( attr, binding = null, renderer = null ) {
	if ( ! attr || ! ( attr.isStorageBufferAttribute === true || attr.isStorageInstancedBufferAttribute === true ) ) return;
	const attributes = __computeStorageLedger( __computeStorageAttrsByRenderer, __unscopedComputeStorageAttrs, renderer, true );
	const evidence = __computeStorageLedger( __computeStorageEvidenceByRenderer, __unscopedComputeStorageEvidence, renderer, true );
	if ( ! attributes.includes( attr ) ) {
		attributes.push( attr );
		const diag = __computeDiagnostics();
		if ( diag ) {
			diag.storageAttrs = ( diag.storageAttrs | 0 ) + 1;
			if ( diag.storageShapes.length < 12 ) diag.storageShapes.push( String( attr.count || 0 ) + 'x' + String( attr.itemSize || 0 ) + ':' + ( attr.array && attr.array.constructor && attr.array.constructor.name || '' ) );
		}
	}
	if ( binding && ! evidence.some( ( candidate ) => candidate.attribute === attr && candidate.binding === binding ) ) evidence.push( { attribute: attr, binding } );
}

function __preferComputeStorageAttr( attr, entry, sizeMatches, fallbacks ) {
	if ( ! attr || fallbacks.length === 0 ) return attr;
	const match = fallbacks.find( ( candidate ) => (
		candidate &&
		candidate !== attr &&
		candidate.array === attr.array &&
		candidate.count === ( entry && entry.count ) &&
		sizeMatches( candidate.itemSize, entry && entry.itemSize )
	) );
	return match || attr;
}

function __arrayLikeValueAt( value, index ) {
	if ( ! value ) return NaN;
	return Number( value[ index ] );
}

function __storageSnapshotDistance( entry, attr ) {
	const snapshot = entry && entry._liveArray;
	const array = attr && attr.array;
	if ( ! snapshot || ! array ) return Infinity;
	const expectedLength = Math.max( 0, ( entry.count | 0 ) * ( entry.itemSize | 0 ) );
	const length = Math.min( expectedLength || array.length || 0, array.length || 0 );
	if ( length <= 0 ) return Infinity;
	const samples = Math.min( 96, length );
	const step = Math.max( 1, Math.floor( length / samples ) );
	let total = 0;
	let count = 0;
	for ( let i = 0; i < length && count < samples; i += step ) {
		const left = __arrayLikeValueAt( snapshot, i );
		const right = Number( array[ i ] );
		if ( ! Number.isFinite( left ) || ! Number.isFinite( right ) ) continue;
		total += Math.abs( left - right );
		count ++;
	}
	return count > 0 ? total / count : Infinity;
}

const __iblStorageDiagnosticsRecorded = new WeakSet();

function __recordIBLStorageWiringDiagnostic( artifact, sourceMaterial ) {
	if ( window.__TSLP_DEBUG_IBL_BINDINGS !== true || ! artifact || __iblStorageDiagnosticsRecorded.has( artifact ) ) return;
	__iblStorageDiagnosticsRecorded.add( artifact );
	try {
		const diag = __harnessDiagnostics();
		const ibl = diag.ibl || ( diag.ibl = {} );
		const records = ibl.storageBindings || ( ibl.storageBindings = [] );
		if ( records.length >= 120 ) return;
		const seen = new Set();
		for ( const group of artifact.uniformPlan || [] ) {
			const entries = [];
			for ( const entry of group.storageBuffers || [] ) entries.push( entry );
			for ( const ordered of group.orderedBindings || [] ) {
				if ( ordered && ordered.type === 'storage-buffer' && ordered.ref ) entries.push( ordered.ref );
			}
			for ( const entry of entries ) {
				if ( ! entry || seen.has( entry ) || records.length >= 120 ) continue;
				seen.add( entry );
				const source = entry.source || {};
				const snapshot = Array.isArray( entry.arraySnapshot ) ? entry.arraySnapshot : null;
				const liveAttribute = entry._liveAttribute || null;
				const liveArray = liveAttribute && liveAttribute.array || null;
				const snapshotDistance = __storageSnapshotDistance(
					snapshot ? { ...entry, _liveArray: snapshot } : entry,
					liveAttribute,
				);
				records.push( {
					materialName: sourceMaterial && sourceMaterial.name || '',
					materialType: sourceMaterial && ( sourceMaterial.type || sourceMaterial.constructor && sourceMaterial.constructor.name ) || '',
					materialUuid: artifact.materialUuid || artifact.userMaterialUuid || '',
					groupName: group.name || '',
					name: entry.name || '',
					count: entry.count | 0,
					itemSize: entry.itemSize | 0,
					arrayType: entry.arrayType || '',
					sourceKind: source.kind || '',
					sourceOrdinal: Number.isInteger( source.anonymousResourceOrdinal ) ? source.anonymousResourceOrdinal : null,
					sourceCount: Number.isInteger( source.anonymousResourceCount ) ? source.anonymousResourceCount : null,
					userPath: Array.isArray( entry.userPath ) ? entry.userPath.slice() : null,
					snapshotHash: entry.arraySnapshotHash || '',
					snapshotFirst8: snapshot ? snapshot.slice( 0, 8 ) : null,
					snapshotDistance: Number.isFinite( snapshotDistance ) ? snapshotDistance : null,
					hasLiveAttribute: !! liveAttribute,
					liveAttributeId: liveAttribute && Number.isFinite( liveAttribute.id ) ? liveAttribute.id : null,
					liveAttributeUuid: liveAttribute && liveAttribute.uuid || null,
					liveAttributeVersion: liveAttribute && Number.isFinite( liveAttribute.version ) ? liveAttribute.version : null,
					liveCount: liveAttribute && Number.isFinite( liveAttribute.count ) ? liveAttribute.count : null,
					liveItemSize: liveAttribute && Number.isFinite( liveAttribute.itemSize ) ? liveAttribute.itemSize : null,
					liveArrayType: liveArray && liveArray.constructor && liveArray.constructor.name || '',
					liveFirst8: liveArray ? Array.from( liveArray.subarray ? liveArray.subarray( 0, 8 ) : liveArray.slice( 0, 8 ) ) : null,
				} );
			}
		}
	} catch ( _ ) {}
}

function __wireStorageBuffersBySnapshot( artifact, attrs, sizeMatches ) {
	const isLiveStorageAttr = ( value ) => value && ( value.isStorageBufferAttribute === true || value.isStorageInstancedBufferAttribute === true );
	const candidates = attrs.filter( isLiveStorageAttr );
	if ( candidates.length === 0 ) return 0;
	const entries = [];
	const seen = new Set();
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const entry of group.storageBuffers || [] ) {
			if ( entry && ! seen.has( entry ) ) { seen.add( entry ); entries.push( entry ); }
		}
		for ( const binding of group.orderedBindings || [] ) {
			const entry = binding && binding.type === 'storage-buffer' ? binding.ref : null;
			if ( entry && ! seen.has( entry ) ) { seen.add( entry ); entries.push( entry ); }
		}
	}
	const consumed = new Set();
	const byEntryKey = new Map();
	let wired = 0;
	for ( const entry of entries ) {
		if ( ! entry
			|| isLiveStorageAttr( entry._liveAttribute )
			|| __sharedHasAnonymousStorageResourceIdentity( entry )
			|| ! entry._liveArray ) continue;
		const entryKey = [
			entry.name || '',
			entry.count || 0,
			entry.itemSize || 0,
			entry.arrayType || '',
		].join( ':' );
		const keyed = byEntryKey.get( entryKey );
		if ( keyed && keyed.count === entry.count && sizeMatches( keyed.itemSize, entry.itemSize ) ) {
			Object.defineProperty( entry, '_liveAttribute', { value: keyed, enumerable: false, writable: true, configurable: true } );
			wired ++;
			continue;
		}
		let best = null;
		let bestScore = Infinity;
		for ( const candidate of candidates ) {
			if ( consumed.has( candidate ) ) continue;
			if ( candidate.count !== entry.count || ! sizeMatches( candidate.itemSize, entry.itemSize ) ) continue;
			if ( entry.arrayType && candidate.array && candidate.array.constructor && candidate.array.constructor.name !== entry.arrayType ) continue;
			const score = __storageSnapshotDistance( entry, candidate );
			if ( score < bestScore ) {
				best = candidate;
				bestScore = score;
			}
		}
		if ( ! best || bestScore > 1e-4 ) continue;
		Object.defineProperty( entry, '_liveAttribute', { value: best, enumerable: false, writable: true, configurable: true } );
		byEntryKey.set( entryKey, best );
		consumed.add( best );
		wired ++;
	}
	return wired;
}

function __wireComputeAttrsToArtifact( artifact, sourceMaterial, renderer = window.__tslpCurrentReplayRenderer || null ) {
	if ( ! sourceMaterial || ! artifact ) return 0;
	let computeStorageAttrFallbacks = __computeStorageAttrsFor( renderer );
	const computeStorageEvidence = __computeStorageEvidenceFor( renderer );
	let wiredCount = 0;
	function isStorageAttr( v ) { return v && ( v.isStorageBufferAttribute === true || v.isStorageInstancedBufferAttribute === true ); }
	function bumpBeforeComputeOwnsBuffer( attr ) {
		// After delegated compute adopts the GPU buffer, a CPU version bump makes
		// the next render upload the zeroed backing array over the compute result.
		if ( ! attr || computeStorageAttrFallbacks.includes( attr ) ) return;
		if ( typeof attr.version === 'number' ) attr.version = attr.version + 1;
	}

	// vec3 StorageBufferAttributes are padded to itemSize=4 by WebGPU on first use.
	// Accept both 3 and 4 when the artifact recorded 4 (pad already applied at capture).
	function sizeMatches( liveSize, artifactSize ) {
		return liveSize === artifactSize || ( liveSize === 3 && artifactSize === 4 );
	}

	// Wire nodeAttributes (vertex path). A few shapes are common:
	//   - material.positionNode = positionBuffer.toAttribute() — the top-level
	//     node is a BufferAttributeNode wrapping the storage attribute.
	//   - material.colorNode = Fn(() => velocityBuffer.toAttribute())() — the
	//     attribute is consumed as a fragment varying, but still appears as a
	//     vertex-stage nodeAttribute in the captured shader.
	//   - material.vertexNode = billboarding({ position: positionBuffer.toAttribute() })
	//     — the BufferAttributeNode is buried inside a deeper node tree (used by
	//     the compute particle examples: rain, snow, points).
	// Walk the material node slots that can produce vertex attributes to collect every storage-attribute
	// candidate, then match each artifact node-attribute by count + itemSize.
	const nodeAttrsArr = artifact.attributes || artifact.nodeAttributes || [];
	const naCandidates = [];
	__collectStorageAttrNodeAttrs( sourceMaterial.positionNode, naCandidates );
	__collectStorageAttrNodeAttrs( sourceMaterial.colorNode, naCandidates );
	__collectStorageAttrNodeAttrs( sourceMaterial.geometryNode, naCandidates );
	__collectStorageAttrNodeAttrs( sourceMaterial.vertexNode, naCandidates );
	if ( naCandidates.length > 0 ) {
		const nodeAttrsForLiveWire = nodeAttrsArr.slice().sort( ( a, b ) => {
			const aPath = Array.isArray( a && a.userPath ) ? a.userPath.length : 0;
			const bPath = Array.isArray( b && b.userPath ) ? b.userPath.length : 0;
			return bPath - aPath;
		} );
		for ( const nodeAttr of nodeAttrsForLiveWire ) {
			// _liveAttribute may already be set from JSON deserialization (plain object, not
			// a live attribute). Only skip if it is already a proper live JS attribute object.
			if ( ! nodeAttr || nodeAttr.source !== 'node' || isStorageAttr( nodeAttr._liveAttribute ) ) continue;
			// Object-owned instanced attributes (InstancedMesh.instanceMatrix columns,
			// instanceColor) are captured with storage:false and must be wired by the
			// runtime's instanced-object lookup, not shape-matched to storage candidates.
			// webgpu_compute_birds collapses without this guard.
			if ( nodeAttr.storage === false ) continue;
			const matchIdx = naCandidates.findIndex( ( v ) => v.count === nodeAttr.count && sizeMatches( v.itemSize, nodeAttr.itemSize ) );
			if ( matchIdx === -1 ) continue;
			const liveAttr = __preferComputeStorageAttr( naCandidates[ matchIdx ], nodeAttr, sizeMatches, computeStorageAttrFallbacks );
			Object.defineProperty( nodeAttr, '_liveAttribute', { value: liveAttr, enumerable: false, writable: true, configurable: true } );
			bumpBeforeComputeOwnsBuffer( liveAttr );
			wiredCount++;
			naCandidates.splice( matchIdx, 1 );
		}
	}

	// Some helpers (notably billboarding({ position: storageAttr.toAttribute() }))
	// capture the live storage attribute inside an Fn closure that is not exposed
	// through the material's node tree at replay time. When the artifact recorded
	// an anonymous vertexNode-sourced attribute, fall back to storage attributes
	// discovered from compute bind groups. This is deliberately limited to
	// vertexNode materials so positionNode/colorNode paths keep their explicit
	// userPath wiring.
	if ( ( sourceMaterial.vertexNode || sourceMaterial.colorNode ) && computeStorageAttrFallbacks.length > 0 ) {
		const hasAutoComputeNode = __AUTO_COMPUTE_SLOTS.some( ( slot ) => sourceMaterial[ slot ] && sourceMaterial[ slot ].isComputeNode === true );
		for ( const nodeAttr of nodeAttrsArr ) {
			if ( ! nodeAttr || nodeAttr.source !== 'node' || isStorageAttr( nodeAttr._liveAttribute ) ) continue;
			if ( Array.isArray( nodeAttr.userPath ) && nodeAttr.userPath.length > 0 ) continue;
			if ( hasAutoComputeNode ) continue;
			// See gate above: skip non-storage instanced attributes (instanceMatrix columns).
			if ( nodeAttr.storage === false ) continue;
			const matches = computeStorageAttrFallbacks.filter( ( v ) => (
					v &&
					v.count === nodeAttr.count &&
					sizeMatches( v.itemSize, nodeAttr.itemSize ) &&
					( ! nodeAttr.arrayType || ! v.array || ! v.array.constructor || v.array.constructor.name === nodeAttr.arrayType )
				) );
			const match = matches[ 2 ] || matches[ 1 ] || matches[ 0 ];
			if ( ! match ) continue;
			Object.defineProperty( nodeAttr, '_liveAttribute', { value: match, enumerable: false, writable: true, configurable: true } );
			bumpBeforeComputeOwnsBuffer( match );
			wiredCount++;
		}
	}

	// Wire storage-buffer bindings: colorNode / normalNode / etc. trees may contain
	// StorageBufferNode instances (isStorageBufferNode = true) whose .value is the
	// live buffer that compute writes to. Match them to uniformPlan storageBuffers by
	// count + itemSize; use first match to handle the common single-buffer case.
	// NOTE: _liveAttribute may already be set on plan entries as a serialized plain
	// object from JSON capture (not a live JS attribute). Only skip if it is a real
	// live attribute (isStorageBufferAttribute / isStorageInstancedBufferAttribute).
	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const nodeKeys = [ 'colorNode', 'normalNode', 'outputNode', 'roughnessNode', 'metalnessNode', 'emissiveNode', 'opacityNode', 'alphaTestNode', 'vertexNode', 'positionNode', 'geometryNode' ];
	const sbCandidateList = [];
	for ( const key of nodeKeys ) {
		if ( sourceMaterial[ key ] ) __collectStorageBufAttrs( sourceMaterial[ key ], sbCandidateList );
	}
	const sbCandidates = [ ...new Set( sbCandidateList ) ];
	// A later material can read the same compute-owned buffer from inside an
	// unevaluated Fn closure, where replay cannot walk it directly. Retain every
	// exact live buffer exposed by an earlier sibling so the existing
	// renderer-scoped shape/snapshot matcher can bind that hidden consumer.
	for ( const attr of sbCandidates ) __rememberComputeStorageAttr( attr, null, renderer );
	computeStorageAttrFallbacks = __computeStorageAttrsFor( renderer );
	// Runtime userPath binding handles explicit paths, but many compute examples
	// build storage(...) reads inside helper closures, leaving storageBuffers with
	// no userPath. Wire those from the live material node graph before hydration.
	const __useHarnessStorageWire = true;
	if ( __useHarnessStorageWire && sbCandidates.length > 0 ) {
		for ( const group of plan ) {
			// Try explicit storageBuffers list first
			for ( const sb of ( group.storageBuffers || [] ) ) {
				if ( isStorageAttr( sb._liveAttribute ) ) continue;
				if ( __sharedHasAnonymousStorageResourceIdentity( sb ) ) continue;
				const match = sbCandidates.find( ( c ) => c.count === sb.count && sizeMatches( c.itemSize, sb.itemSize ) );
				if ( match ) {
					Object.defineProperty( sb, '_liveAttribute', { value: match, enumerable: false, writable: true, configurable: true } );
					wiredCount++;
					sbCandidates.splice( sbCandidates.indexOf( match ), 1 );
				}
			}
			// Fall back to orderedBindings (storage-buffer type) — some artifacts store
			// the storage buffer refs there rather than in the storageBuffers array.
			for ( const ob of ( group.orderedBindings || [] ) ) {
				if ( ! ob || ob.type !== 'storage-buffer' || ! ob.ref ) continue;
				const sb = ob.ref;
				if ( isStorageAttr( sb._liveAttribute ) ) continue;
				if ( __sharedHasAnonymousStorageResourceIdentity( sb ) ) continue;
				const match = sbCandidates.find( ( c ) => c.count === sb.count && sizeMatches( c.itemSize, sb.itemSize ) );
				if ( match ) {
					Object.defineProperty( sb, '_liveAttribute', { value: match, enumerable: false, writable: true, configurable: true } );
					wiredCount++;
					sbCandidates.splice( sbCandidates.indexOf( match ), 1 );
				}
			}
		}
	}

	// Renderer-level compute systems can feed material storage bindings without
	// exposing the live storage buffer in the material node tree. TiledLighting is
	// the canonical case: renderer.compute() updates the global light-index grid,
	// then MeshPhongNodeMaterial reads that grid via a storage binding. Reuse the
	// runtime helper so replay and real slim+fallback users share the same shape
	// matching behavior.
		if ( computeStorageAttrFallbacks.length > 0 ) {
			const snapshotWired = __wireStorageBuffersBySnapshot( artifact, computeStorageAttrFallbacks, sizeMatches );
		if ( snapshotWired > 0 ) {
			const diag = __computeDiagnostics();
			if ( diag ) diag.snapshotWires = ( diag.snapshotWires | 0 ) + snapshotWired;
			wiredCount += snapshotWired;
		}
		const fallbackWired = __sharedWireArtifactStorageBuffersFromAttributes( artifact, [ ...computeStorageAttrFallbacks, ...computeStorageEvidence ], {
			bumpVersion: false,
			allowVec3ToVec4: true,
		} );
			if ( fallbackWired > 0 ) {
				const diag = __computeDiagnostics();
				if ( diag ) diag.fallbackWires = ( diag.fallbackWires | 0 ) + fallbackWired;
					wiredCount += fallbackWired;
			}
		}
			__recordIBLStorageWiringDiagnostic( artifact, sourceMaterial );
			return wiredCount;
		}

function __sourceTypeNeedle( sourceMaterial ) {
	const type = sourceMaterial && typeof sourceMaterial.type === 'string' ? sourceMaterial.type : '';
	return type ? type.replace( /Material$/, 'NodeMaterial' ) : '';
}

function __readColorTriplet( value ) {
	if ( ! value ) return null;
	if ( value.isColor === true ) return [ value.r, value.g, value.b ];
	if ( typeof value === 'number' && Number.isFinite( value ) ) {
		return [ ( ( value >> 16 ) & 255 ) / 255, ( ( value >> 8 ) & 255 ) / 255, ( value & 255 ) / 255 ];
	}
	if ( typeof value === 'string' && typeof Slim.Color === 'function' ) {
		try {
			const c = new Slim.Color( value );
			return [ c.r, c.g, c.b ];
		} catch ( _ ) {}
	}
	return null;
}

function __artifactColorTriplet( artifact ) {
	const fromDefault = artifact && artifact.defaults && artifact.defaults.color;
	if ( fromDefault && Array.isArray( fromDefault.data ) ) return fromDefault.data.slice( 0, 3 );
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const slot of group.slots || [] ) {
			const source = slot && slot.source || {};
			const snap = source.valueSnapshot || null;
			if ( source.kind === 'material.color' && snap && Array.isArray( snap.data ) ) return snap.data.slice( 0, 3 );
		}
	}
	return null;
}

function __artifactMaterialColorTriplet( artifact, property ) {
	const fromDefault = artifact && artifact.defaults && artifact.defaults[ property ];
	if ( fromDefault && Array.isArray( fromDefault.data ) ) return fromDefault.data.slice( 0, 3 );
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const slot of group.slots || [] ) {
			const source = slot && slot.source || {};
			const snap = source.valueSnapshot || null;
			if ( source.kind === 'material.' + property && snap && Array.isArray( snap.data ) ) return snap.data.slice( 0, 3 );
		}
	}
	return null;
}

function __colorDistanceSq( a, b ) {
	if ( ! a || ! b ) return Infinity;
	const dr = ( a[ 0 ] || 0 ) - ( b[ 0 ] || 0 );
	const dg = ( a[ 1 ] || 0 ) - ( b[ 1 ] || 0 );
	const db = ( a[ 2 ] || 0 ) - ( b[ 2 ] || 0 );
	return dr * dr + dg * dg + db * db;
}

function __artifactHasTextureSource( artifact, predicate = null ) {
	return __sharedArtifactHasTextureSource( artifact, predicate );
}

let __reflectorBaseCursor = 0;
function __isReflectorBaseNode( node ) {
	return !! ( node
		&& node.renderTargets instanceof Map
		&& typeof node.updateBefore === 'function'
		&& node.constructor
		&& ( node.constructor.type === 'ReflectorBaseNode' || node.constructor.name === 'ReflectorBaseNode' ) );
}

function __reflectorSourcesForArtifact( artifact ) {
	const sources = [];
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'reflector.texture' ) continue;
			const index = Number.isInteger( source.reflectorIndex ) ? source.reflectorIndex : 0;
			if ( ! sources.some( ( item ) => item.index === index ) ) sources.push( { index, source } );
		}
	}
	sources.sort( ( a, b ) => a.index - b.index );
	return sources;
}

function __createReflectorBaseNodeForSource( source, sourceObject ) {
	if ( ! FullTSL || typeof FullTSL.reflector !== 'function' ) return null;
	try {
		const params = {};
		if ( typeof source.resolutionScale === 'number' ) params.resolutionScale = source.resolutionScale;
		if ( typeof source.generateMipmaps === 'boolean' ) params.generateMipmaps = source.generateMipmaps;
		if ( typeof source.samples === 'number' ) params.samples = source.samples;
		if ( typeof source.bounces === 'boolean' ) params.bounces = source.bounces;
		if ( typeof source.depth === 'boolean' ) params.depth = source.depth;
		const reflectorNode = FullTSL.reflector( params );
		const baseNode = reflectorNode && ( reflectorNode._reflectorBaseNode || reflectorNode.reflector ) || null;
		if ( ! __isReflectorBaseNode( baseNode ) ) return null;
		const target = reflectorNode && reflectorNode.target || baseNode.target || null;
		if ( target && sourceObject && typeof sourceObject.add === 'function' && target.parent !== sourceObject ) {
			try { sourceObject.add( target ); } catch ( _ ) {}
		}
		return baseNode;
	} catch ( _ ) {
		return null;
	}
}

function __attachReflectorBaseNodesForArtifact( material, artifact, sourceObject = null ) {
	if ( ! material || ! artifact ) return;
	if ( ! __artifactHasTextureSource( artifact, ( source ) => source.kind === 'reflector.texture' ) ) return;
	const pool = globalThis.__tslpReflectorBaseNodes || [];
	const reflectorSources = __reflectorSourcesForArtifact( artifact );
	const needed = Math.max( 1, reflectorSources.length );
	const nodes = [];
	while ( nodes.length < needed && __reflectorBaseCursor < pool.length ) {
		const node = pool[ __reflectorBaseCursor ++ ];
		if ( __isReflectorBaseNode( node ) ) nodes.push( node );
	}
	while ( nodes.length < needed ) {
		const source = reflectorSources[ nodes.length ] && reflectorSources[ nodes.length ].source || {};
		const node = __createReflectorBaseNodeForSource( source, sourceObject );
		if ( ! node ) break;
		nodes.push( node );
	}
	if ( nodes.length === 0 ) return;
	Object.defineProperty( material, '__tslpReflectorBaseNodes', {
		value: nodes,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
}

function __isPMREMTexture( texture ) {
	return __sharedIsPMREMTexture( texture );
}

function __textureImageSrc( texture ) {
	return __sharedTextureImageSrc( texture ) || null;
}

function __basenameFromUrl( value ) {
	if ( typeof value !== 'string' || value.length === 0 ) return '';
	const slash = value.lastIndexOf( '/' );
	const tail = slash >= 0 ? value.slice( slash + 1 ) : value;
	return tail.split( '?' )[ 0 ].split( '#' )[ 0 ];
}

function __textureMatchesSource( texture, source ) {
	return __sharedTextureMatchesSource( texture, source );
}

function __textureMatchesArtifactSource( texture, source ) {
	return __sharedTextureMatchesArtifactSource( texture, source );
}

function __isTrivialTextureSnapshot( snapshot ) {
	if ( ! snapshot || ! Array.isArray( snapshot.data ) ) return false;
	const data = snapshot.data;
	if ( data.length === 0 || data.length > 65536 ) return false;
	const threshold = Math.max( 1, ( data.length * 0.01 ) | 0 );
	let nonZero = 0;
	for ( let i = 0; i < data.length; i ++ ) {
		if ( data[ i ] !== 0 ) {
			nonZero ++;
			if ( nonZero > threshold ) return false;
		}
	}
	return true;
}

function __countArtifactTextureSources( artifact, predicate = null ) {
	return __sharedCountArtifactTextureSources( artifact, predicate );
}

function __singleArtifactTextureUuid( artifact, predicate = null ) {
	return __sharedSingleArtifactTextureUuid( artifact, predicate );
}

function __artifactNodeAttributes( artifact ) {
	const attrs = Array.isArray( artifact && artifact.attributes )
		? artifact.attributes
		: Array.isArray( artifact && artifact.nodeAttributes ) ? artifact.nodeAttributes : [];
	return attrs.filter( ( entry ) => entry && entry.source === 'node' );
}

function __objectDrawCount( object ) {
	const count = object && object.count;
	return Number.isFinite( count ) && count > 0 ? count : 0;
}

function __artifactNodeBufferMatrixCounts( artifact ) {
	const shader = artifact && typeof artifact.vertexShader === 'string' ? artifact.vertexShader : '';
	if ( ! shader ) return [];
	const counts = [];
	// InstancedMesh captures may encode instance matrices as NodeBuffer uniform
	// arrays rather than node attributes; use that as a legacy-artifact hint.
	const patterns = [
		/struct\s+NodeBuffer_[A-Za-z0-9_]*Struct\s*\{[\s\S]*?value\s*:\s*array<\s*mat4x4<f32>\s*,\s*(\d+)\s*>/g,
		/uniform\s+NodeBuffer_[A-Za-z0-9_]*\s*\{[\s\S]*?\bmat4\s+value\s*\[\s*(\d+)\s*\]\s*;/g,
	];
	for ( const pattern of patterns ) {
		let match;
		while ( ( match = pattern.exec( shader ) ) ) {
			const count = Number( match[ 1 ] );
			if ( Number.isFinite( count ) && count > 1 && ! counts.includes( count ) ) counts.push( count );
		}
	}
	return counts;
}

function __artifactInstancedDrawCount( artifact ) {
	const artifactObject = __artifactSourceObject( artifact );
	const metadataCount = artifactObject && artifactObject.isInstancedMesh === true ? __objectDrawCount( artifactObject ) : 0;
	if ( metadataCount ) return metadataCount;
	const attrCounts = __artifactNodeAttributes( artifact )
		.map( ( entry ) => Number( entry && entry.count ) )
		.filter( ( count ) => Number.isFinite( count ) && count > 1 );
	if ( attrCounts.length > 0 ) return attrCounts[ 0 ];
	const nodeBufferCounts = __artifactNodeBufferMatrixCounts( artifact );
	return nodeBufferCounts.length === 1 ? nodeBufferCounts[ 0 ] : 0;
}

function __artifactHasInstancedShape( artifact ) {
	const artifactObject = __artifactSourceObject( artifact );
	return !! ( artifactObject && artifactObject.isInstancedMesh === true )
		|| __artifactInstancedDrawCount( artifact ) > 1
		|| __artifactNodeAttributes( artifact ).some( ( entry ) => entry && entry.instanced === true );
}

function __nodeGraphKeys() {
	return __NODE_GRAPH_KEYS;
}

function __isRealMaterialNode( node ) {
	return !! ( node && node.isNode === true && node.__tslpNodeStub !== true );
}

function __sourceNodePropNames( sourceMaterial ) {
	const props = [];
	if ( ! sourceMaterial ) return props;
	for ( const key of __nodeGraphKeys() ) {
		if ( __isRealMaterialNode( sourceMaterial[ key ] ) ) props.push( key );
	}
	return props;
}

function __artifactNodePropNames( artifact ) {
	const source = artifact && artifact.sourceMaterial || null;
	return source && Array.isArray( source.nodeProps ) ? source.nodeProps.filter( Boolean ) : null;
}

function __artifactMaterialName( artifact ) {
	const source = artifact && artifact.sourceMaterial || null;
	return source && typeof source.name === 'string' ? source.name : '';
}

function __materialNameScore( artifact, sourceMaterial ) {
	const artifactName = __artifactMaterialName( artifact );
	const sourceName = sourceMaterial && typeof sourceMaterial.name === 'string' ? sourceMaterial.name : '';
	if ( ! artifactName || ! sourceName ) return 0;
	if ( artifactName === sourceName ) return 320;
	if ( artifactName.startsWith( __state.example + ':' ) || sourceName.startsWith( __state.example + ':' ) ) return -80;
	return -180;
}

function __artifactSourceObject( artifact ) {
	const source = artifact && artifact.sourceMaterial || null;
	if ( ! source || ! Object.prototype.hasOwnProperty.call( source, 'object' ) ) return undefined;
	return source.object || null;
}

function __artifactMaterialUuid( artifact ) {
	return artifact && typeof artifact.materialUuid === 'string' ? artifact.materialUuid : '';
}

function __sourceMaterialUuid( material ) {
	return material && typeof material.uuid === 'string' ? material.uuid : '';
}

function __artifactMatchesSourceMaterialUuid( artifact, sourceMaterial ) {
	const artifactUuid = __artifactMaterialUuid( artifact );
	const sourceUuid = __sourceMaterialUuid( sourceMaterial );
	return !! ( artifactUuid && sourceUuid && artifactUuid === sourceUuid );
}

function __objectMetadataScore( artifact, sourceObject ) {
	const artifactObject = __artifactSourceObject( artifact );
	if ( artifactObject === undefined ) return 0;
	if ( ! artifactObject && ! sourceObject ) return 90;
	if ( ! artifactObject && sourceObject ) return -140;
	if ( artifactObject && ! sourceObject ) return -160;
	let score = 0;
	const sourceType = sourceObject.type || sourceObject.constructor && sourceObject.constructor.name || '';
	if ( artifactObject.type && sourceType ) score += artifactObject.type === sourceType ? 45 : -35;
	const sourceRenderOrder = Number.isFinite( sourceObject.renderOrder ) ? sourceObject.renderOrder : 0;
	if ( Number.isFinite( artifactObject.renderOrder ) ) score += Math.abs( artifactObject.renderOrder - sourceRenderOrder ) < 1e-6 ? 90 : -45;
	if ( typeof artifactObject.castShadow === 'boolean' ) score += artifactObject.castShadow === ( sourceObject.castShadow === true ) ? 20 : -20;
	if ( typeof artifactObject.receiveShadow === 'boolean' ) score += artifactObject.receiveShadow === ( sourceObject.receiveShadow === true ) ? 20 : -20;
	if ( typeof artifactObject.isInstancedMesh === 'boolean' ) score += artifactObject.isInstancedMesh === ( sourceObject.isInstancedMesh === true ) ? 25 : -80;
	if ( sourceObject.isInstancedMesh === true && artifactObject.isInstancedMesh === true ) {
		const artifactCount = __objectDrawCount( artifactObject );
		const sourceCount = __objectDrawCount( sourceObject );
		if ( artifactCount && sourceCount ) score += artifactCount === sourceCount ? 90 : -160;
	}
	if ( Array.isArray( artifactObject.position ) && sourceObject.position ) {
		const delta = Math.abs( ( artifactObject.position[ 0 ] || 0 ) - sourceObject.position.x )
			+ Math.abs( ( artifactObject.position[ 1 ] || 0 ) - sourceObject.position.y )
			+ Math.abs( ( artifactObject.position[ 2 ] || 0 ) - sourceObject.position.z );
		score += delta < 1e-5 ? 180 : delta < 0.1 ? 45 : -160;
	}
	if ( Array.isArray( artifactObject.scale ) && sourceObject.scale ) {
		const delta = Math.abs( ( artifactObject.scale[ 0 ] || 0 ) - sourceObject.scale.x )
			+ Math.abs( ( artifactObject.scale[ 1 ] || 0 ) - sourceObject.scale.y )
			+ Math.abs( ( artifactObject.scale[ 2 ] || 0 ) - sourceObject.scale.z );
		score += delta < 1e-5 ? 45 : delta < 0.1 ? 15 : -20;
	}
	return score;
}

function __nodePropSetScore( artifact, sourceMaterial ) {
	const artifactProps = __artifactNodePropNames( artifact );
	if ( ! artifactProps ) return 0;
	const sourceProps = __sourceNodePropNames( sourceMaterial );
	const sourceSet = new Set( sourceProps );
	const artifactSet = new Set( artifactProps );
	let score = 0;
	for ( const key of sourceSet ) score += artifactSet.has( key ) ? 90 : -130;
	for ( const key of artifactSet ) {
		if ( ! sourceSet.has( key ) ) score -= 120;
	}
	if ( sourceSet.size === artifactSet.size && sourceProps.every( ( key ) => artifactSet.has( key ) ) ) score += 180;
	return score;
}

function __sourceHasNodeGraph( sourceMaterial ) {
	if ( ! sourceMaterial ) return false;
	for ( const key of __nodeGraphKeys() ) if ( __isRealMaterialNode( sourceMaterial[ key ] ) ) return true;
	return false;
}

function __collectMaterialNodeTextures( sourceMaterial ) {
	const out = [];
	if ( ! sourceMaterial ) return out;
	const seenNodes = new Set();
	const seenTextures = new Set();
	for ( const key of __nodeGraphKeys() ) {
		const node = sourceMaterial[ key ];
		if ( ! __isRealMaterialNode( node ) ) continue;
		for ( const texture of __collectTexturesInNode( node, [], 0, seenNodes ) ) {
			if ( texture && texture.isTexture === true && ! seenTextures.has( texture ) ) {
				seenTextures.add( texture );
				out.push( texture );
			}
		}
	}
	return out;
}

function __collectMaterialPropertyTextures( sourceMaterial ) {
	const out = [];
	if ( ! sourceMaterial ) return out;
	for ( const property of __TEXTURE_PROPS ) {
		const texture = sourceMaterial[ property ];
		if ( texture && texture.isTexture === true ) out.push( { property, texture } );
	}
	return out;
}

function __walkMaterialNodeGraph( sourceMaterial, visitor ) {
	if ( ! sourceMaterial || typeof visitor !== 'function' ) return;
	const seen = new Set();
	for ( const key of __nodeGraphKeys() ) {
		__walkNodeSafely( sourceMaterial[ key ], ( node ) => {
			if ( node && node.isNode === true && node.__tslpNodeStub !== true ) visitor( node );
		}, seen );
	}
}

function __nodeUpdateKind( node, method ) {
	try {
		const fn = method === 'before' ? node.getUpdateBeforeType : method === 'after' ? node.getUpdateAfterType : node.getUpdateType;
		return typeof fn === 'function' ? fn.call( node ) : method === 'before' ? node.updateBeforeType : method === 'after' ? node.updateAfterType : node.updateType;
	} catch ( _ ) {
		return 'none';
	}
}

function __shouldReplayLiveUpdateBeforeNode( node ) {
	if ( ! node ) return false;
	if ( node.isGaussianBlurNode === true && node._material === null ) return false;
	return true;
}

function __wrapReplayUpdateBeforeNode( node ) {
	if ( ! node || typeof node.updateBefore !== 'function' || node.__tslpReplayUpdateBeforeWrapped === true ) return node;
	const originalUpdateBefore = node.updateBefore;
	try {
		Object.defineProperty( node, '__tslpReplayUpdateBeforeWrapped', {
			value: true,
			enumerable: false,
			configurable: true,
		} );
	} catch ( _ ) {}
	node.updateBefore = function tslpReplayUpdateBefore( frame ) {
		const renderer = frame && frame.renderer;
		if ( renderer ) renderer.__tslpInsideReplayUpdateBefore = ( renderer.__tslpInsideReplayUpdateBefore | 0 ) + 1;
		try {
			return originalUpdateBefore.call( this, frame );
		} finally {
			if ( renderer ) renderer.__tslpInsideReplayUpdateBefore = Math.max( 0, ( renderer.__tslpInsideReplayUpdateBefore | 0 ) - 1 );
		}
	};
	return node;
}

const __deferredGeometryNodeCache = new WeakMap();

function __deferredGeometryUpdateBeforeNodes( sourceMaterial, replacement ) {
	const geometryNode = sourceMaterial && sourceMaterial.geometryNode;
	const callNode = geometryNode && geometryNode.isVarNode === true ? geometryNode.node : geometryNode;
	const shaderNode = callNode && callNode.isShaderCallNodeInternal === true ? callNode.shaderNode : null;
	const jsFunc = shaderNode && shaderNode.jsFunc;
	const material = replacement || sourceMaterial;
	const object = material && material.__tslpPrecompileObject || sourceMaterial && sourceMaterial.__tslpPrecompileObject || null;
	const renderer = typeof window !== 'undefined' ? window.__tslpCurrentReplayRenderer : null;
	const nodes = [];
	const shouldCache = !! ( material && geometryNode && object && object.geometry && renderer );

	if ( shouldCache ) {
		let byObject = __deferredGeometryNodeCache.get( geometryNode );
		if ( byObject && byObject.has( object ) ) return byObject.get( object );
	}

	if ( typeof jsFunc === 'function' && object && object.geometry && renderer ) {
		try {
			const result = jsFunc( { renderer, geometry: object.geometry, object } );
			__walkNodeSafely( result, ( node ) => {
				if ( typeof node.updateBefore !== 'function' || ! __shouldReplayLiveUpdateBeforeNode( node ) ) return;
				if ( __nodeUpdateKind( node, 'before' ) === 'none' ) return;
				if ( ! nodes.includes( node ) ) nodes.push( node );
			} );
		} catch ( _ ) {}
	}

	if ( shouldCache ) {
		try {
			Object.defineProperty( material, '__tslpDeferredGeometryUpdateBeforeNodes', {
				value: nodes,
				enumerable: false,
				configurable: true,
				writable: true,
			} );
		} catch ( _ ) {}
		let byObject = __deferredGeometryNodeCache.get( geometryNode );
		if ( ! byObject ) {
			byObject = new WeakMap();
			__deferredGeometryNodeCache.set( geometryNode, byObject );
		}
		byObject.set( object, nodes );
	}

	return nodes;
}

function __appendArtifactSidecars( artifact, key, nodes ) {
	if ( ! artifact || ! Array.isArray( nodes ) || nodes.length === 0 ) return;
	const current = Array.isArray( artifact[ key ] ) ? artifact[ key ].slice() : [];
	let changed = false;
	for ( const node of nodes ) {
		if ( node && ! current.includes( node ) ) {
			current.push( node );
			changed = true;
		}
	}
	if ( changed ) {
		Object.defineProperty( artifact, key, {
			value: current,
			enumerable: false,
			configurable: true,
			writable: true,
		} );
	}
}

function __isVolumeNodeMaterial( material ) {
	return !! ( material && ( material.isVolumeNodeMaterial === true || material.type === 'VolumeNodeMaterial' || material.constructor && material.constructor.name === 'VolumeNodeMaterial' ) );
}

function __volumeStepsShaderSource( artifact ) {
	if ( ! artifact ) return '';
	return [
		artifact.fragmentShader,
		artifact.fragment,
		artifact.wgsl,
		artifact.code,
	].filter( ( value ) => typeof value === 'string' ).join( '\\n' );
}

function __isVolumeStepsUniformSlot( artifact, slot ) {
	if ( ! artifact || ! slot || ! slot.name ) return false;
	const source = slot.source || {};
	if ( source.kind !== 'uniform.live' || slot.dtype !== 'int' ) return false;
	const shader = __volumeStepsShaderSource( artifact ).replace( /\s+/g, ' ' );
	if ( shader === '' ) return false;
	const reference = 'object.' + slot.name;
	const castsSteps = shader.includes( 'f32( ' + reference + ' )' ) || shader.includes( 'float( ' + reference + ' )' );
	return castsSteps && shader.includes( 'i < ' + reference );
}

function __repairVolumeMaterialStepsUniform( artifact, sourceMaterial ) {
	if ( ! artifact || ! __isVolumeNodeMaterial( sourceMaterial ) ) return 0;
	const steps = Number( sourceMaterial.steps );
	if ( ! Number.isFinite( steps ) || steps <= 0 ) return 0;
	let repaired = 0;
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const slot of group.slots || [] ) {
			if ( ! __isVolumeStepsUniformSlot( artifact, slot ) ) continue;
			const liveSteps = {};
			Object.defineProperty( liveSteps, 'value', {
				get() {
					const current = Number( sourceMaterial.steps );
					return Number.isFinite( current ) && current > 0 ? current : steps;
				},
				enumerable: false,
				configurable: true,
			} );
			Object.defineProperty( slot, '_liveNode', {
				value: liveSteps,
				enumerable: false,
				configurable: true,
				writable: true,
			} );
			Object.defineProperty( slot, '__tslpLiveSidecarOverlay', {
				value: true,
				enumerable: false,
				configurable: true,
				writable: true,
			} );
			if ( slot.source && slot.source.valueSnapshot && Number( slot.source.valueSnapshot.data ) <= 0 ) {
				slot.source.valueSnapshot = { type: 'int', data: steps };
			}
			repaired ++;
		}
	}
	if ( repaired > 0 && typeof globalThis !== 'undefined' ) {
		const diag = globalThis.__tslpHarnessDiagnostics || ( globalThis.__tslpHarnessDiagnostics = {} );
		const frameEffects = diag.frameEffects || ( diag.frameEffects = {} );
		frameEffects.volumeStepsUniformRepaired = ( frameEffects.volumeStepsUniformRepaired || 0 ) + repaired;
		const repairs = diag.volumeStepsUniformRepairs || ( diag.volumeStepsUniformRepairs = [] );
		if ( repairs.length < 16 ) repairs.push( { name: artifact.name || '', steps, repaired } );
	}
	return repaired;
}

function __wireLiveNodeSidecarsToArtifact( artifact, sourceMaterial, replacement = null ) {
	if ( ! artifact || ! sourceMaterial ) return;
	const isPMREMArtifact = __artifactHasTextureSource( artifact, __isPMREMArtifactTextureSource );
	if ( isPMREMArtifact ) {
		// PMREMNode setup already ran during capture and is represented by the
		// shader plus artifact.texture refs. Replaying the source graph's live
		// UniformNode/update sidecars can retarget PMREM sampling constants to
		// transient internals, so keep the captured PMREM constants for replay.
		return;
	}
	const updateNodes = [];
	const updateBeforeNodes = [];
	const updateAfterNodes = [];
	__walkMaterialNodeGraph( sourceMaterial, ( node ) => {
		if ( typeof node.update === 'function' && __nodeUpdateKind( node, 'update' ) !== 'none' && ! updateNodes.includes( node ) ) updateNodes.push( node );
		if ( typeof node.updateBefore === 'function' && __shouldReplayLiveUpdateBeforeNode( node ) && __nodeUpdateKind( node, 'before' ) !== 'none' && ! updateBeforeNodes.includes( node ) ) updateBeforeNodes.push( node );
		if ( typeof node.updateAfter === 'function' && __nodeUpdateKind( node, 'after' ) !== 'none' && ! updateAfterNodes.includes( node ) ) updateAfterNodes.push( node );
	} );
	for ( const node of __deferredGeometryUpdateBeforeNodes( sourceMaterial, replacement ) ) {
		if ( ! updateBeforeNodes.includes( node ) ) updateBeforeNodes.push( node );
	}
	for ( const node of updateBeforeNodes ) __wrapReplayUpdateBeforeNode( node );
	__appendArtifactSidecars( artifact, '_liveUpdateNodes', updateNodes );
	__appendArtifactSidecars( artifact, '_liveUpdateBeforeNodes', updateBeforeNodes );
	__appendArtifactSidecars( artifact, '_liveUpdateAfterNodes', updateAfterNodes );
	__sharedWireLiveUniformSidecarsToArtifact( artifact, sourceMaterial );
	__repairVolumeMaterialStepsUniform( artifact, sourceMaterial );
}

function __materialFamilyFromClassName( className ) {
	if ( /^Mesh[A-Za-z0-9]*NodeMaterial$/.test( className ) ) return 'mesh';
	if ( /^Line[A-Za-z0-9]*NodeMaterial$/.test( className ) ) return 'line';
	if ( className === 'PointsNodeMaterial' ) return 'points';
	if ( className === 'SpriteNodeMaterial' ) return 'sprite';
	if ( className === 'VolumeNodeMaterial' ) return 'mesh';
	return null;
}

function __materialFamilyFromObject( object ) {
	if ( ! object ) return null;
	if ( object.isPoints === true ) return 'points';
	if ( object.isLine === true || object.isLineSegments === true || object.isLineLoop === true || object.isLine2 === true || object.isLineSegments2 === true ) return 'line';
	if ( object.isSprite === true ) return 'sprite';
	if ( object.isMesh === true || object.isInstancedMesh === true || object.isSkinnedMesh === true ) return 'mesh';
	return null;
}

function __isPipelineArtifactShape( artifact ) {
	const shape = artifact && ( artifact.materialShape || artifact.shape ) || '';
	return shape === 'render-pipeline' || shape === 'render-output' || shape === 'post-process';
}

	function __scoreArtifactForSource( key, mod, className, sourceMaterial, sourceObject = null ) {
		const artifact = mod && mod.artifact;
		if ( ! artifact ) return -Infinity;
		if ( sourceObject && __isPipelineArtifactShape( artifact ) ) return -Infinity;
		const materialUuidMatches = __artifactMatchesSourceMaterialUuid( artifact, sourceMaterial );
		if ( sourceObject && ! materialUuidMatches && ! __precompiledArtifactMatchesObject( artifact, sourceObject ) ) return -Infinity;
		const artifactProps = __artifactNodePropNames( artifact );
		if ( sourceMaterial && artifactProps && artifactProps.length > 0 && __sourceNodePropNames( sourceMaterial ).length === 0 ) return -Infinity;
		const artifactClassName = __classNameFromArtifactName( key );
		const requestedFamily = __materialFamilyFromClassName( className );
		const artifactFamily = __materialFamilyFromClassName( artifactClassName );
		const objectFamily = __materialFamilyFromObject( sourceObject );
	let score = artifactClassName === className ? 180 : key.includes( ':' + className + ':' ) ? 120 : 0;
	if ( artifactFamily && objectFamily ) {
		score += artifactFamily === objectFamily ? 140 : -420;
	}
	if ( requestedFamily && artifactFamily ) {
		if ( requestedFamily === artifactFamily ) score += artifactClassName === className ? 60 : 25;
		else score -= 360;
	}
	const typeNeedle = __sourceTypeNeedle( sourceMaterial );
	if ( typeNeedle && key.includes( ':' + typeNeedle + ':' ) ) score += 15;
	if ( sourceMaterial ) {
		const artifactUuid = __artifactMaterialUuid( artifact );
		const sourceUuid = __sourceMaterialUuid( sourceMaterial );
		if ( artifactUuid && sourceUuid ) score += artifactUuid === sourceUuid ? 900 : -260;
	}
	score += __materialNameScore( artifact, sourceMaterial );
	score += __nodePropSetScore( artifact, sourceMaterial );
	score += __objectMetadataScore( artifact, sourceObject );

	if ( sourceMaterial && artifact.renderState && typeof sourceMaterial.transparent === 'boolean' && typeof artifact.renderState.transparent === 'boolean' ) {
		score += sourceMaterial.transparent === artifact.renderState.transparent ? 45 : -80;
	}

	if ( sourceMaterial && artifact.defaults && typeof sourceMaterial.shininess === 'number' && typeof artifact.defaults.shininess === 'number' ) {
		const delta = Math.abs( sourceMaterial.shininess - artifact.defaults.shininess );
		if ( delta < 1e-4 ) score += 40;
		else if ( delta > 5 ) score -= 35;
	}

	const sourceColor = __readColorTriplet( sourceMaterial && sourceMaterial.color );
	if ( sourceColor ) {
		const artifactColor = __artifactColorTriplet( artifact );
		if ( artifactColor ) {
			const d2 = __colorDistanceSq( sourceColor, artifactColor );
			if ( d2 < 1e-5 ) score += 120;
			else if ( d2 < 0.05 ) score += 45;
			else score -= 30;
		}
		if ( __artifactHasTextureSource( artifact, __isPMREMArtifactTextureSource ) ) score -= 35;
	}

	const sourceEmissive = __readColorTriplet( sourceMaterial && sourceMaterial.emissive );
	if ( sourceEmissive ) {
		const artifactEmissive = __artifactMaterialColorTriplet( artifact, 'emissive' );
		if ( artifactEmissive ) {
			const d2 = __colorDistanceSq( sourceEmissive, artifactEmissive );
			if ( d2 < 1e-5 ) score += 160;
			else if ( d2 < 0.05 ) score += 50;
			else score -= 140;
		}
	}

	if ( sourceMaterial && typeof sourceMaterial.wireframe === 'boolean' && artifact.renderState && typeof artifact.renderState.wireframe === 'boolean' ) {
		if ( sourceMaterial.wireframe === artifact.renderState.wireframe ) score += 90;
		else score -= 120;
	}

	const materialTextures = __collectMaterialPropertyTextures( sourceMaterial );
	if ( materialTextures.length > 0 ) {
		const matchedMaterialTextureSources = new Set();
		const sourceMaterialTextureProps = new Set( materialTextures.map( ( item ) => item.property ).filter( Boolean ) );
		const artifactMaterialTextureProps = new Set();
		for ( const group of artifact.uniformPlan || [] ) {
			for ( const entry of group.textures || [] ) {
				const source = entry && entry.source || {};
				if ( ! source.kind || ! source.kind.startsWith( 'material.' ) ) continue;
				const property = source.property || source.kind.split( '.' )[ 1 ];
				if ( property ) artifactMaterialTextureProps.add( property );
				const matchIndex = materialTextures.findIndex( ( item, index ) => ! matchedMaterialTextureSources.has( index ) && ( property === item.property || source.kind === 'material.' + item.property ) && __textureMatchesSource( item.texture, source ) );
				if ( matchIndex !== -1 ) matchedMaterialTextureSources.add( matchIndex );
			}
		}
		let propertyMatches = 0;
		for ( const property of sourceMaterialTextureProps ) if ( artifactMaterialTextureProps.has( property ) ) propertyMatches ++;
		const missingSourceProps = Math.max( 0, sourceMaterialTextureProps.size - propertyMatches );
		const extraArtifactProps = Math.max( 0, artifactMaterialTextureProps.size - propertyMatches );
		if ( matchedMaterialTextureSources.size > 0 ) score += matchedMaterialTextureSources.size * 130 + propertyMatches * 20;
		else if ( propertyMatches > 0 ) {
			score += propertyMatches * 45;
			if ( missingSourceProps === 0 && extraArtifactProps === 0 ) score += 35;
			else score -= missingSourceProps * 20 + extraArtifactProps * 10;
		}
		else if ( __artifactHasTextureSource( artifact, ( source ) => source.kind && source.kind.startsWith( 'material.' ) ) ) score -= 75;
		else score -= 55;
	} else if ( __artifactHasTextureSource( artifact, ( source ) => source.kind && source.kind.startsWith( 'material.' ) ) ) {
		score -= 75;
	}

	const nodeTextures = __collectMaterialNodeTextures( sourceMaterial );
	const sourceHasNodeTexture = nodeTextures.length > 0;
	const sourceHasPmremTexture = nodeTextures.some( __isPMREMTexture );
	if ( sourceHasNodeTexture ) {
		if ( __artifactHasTextureSource( artifact ) ) score += 45;
		else score -= 25;
		if ( sourceHasPmremTexture && __artifactHasTextureSource( artifact, __isPMREMArtifactTextureSource ) ) score += 90;
		const identifiableNodeTextures = nodeTextures.filter( ( texture ) => {
			if ( ! texture || texture.isTexture !== true || __isPMREMTexture( texture ) ) return false;
			return !! ( texture.name || __textureImageSrc( texture ) );
		} );
		const matchedNodeTextureSources = new Set();
		for ( const group of artifact.uniformPlan || [] ) {
			for ( const entry of group.textures || [] ) {
				const source = entry && entry.source || {};
				if ( source.kind !== 'artifact.texture' || __isPMREMArtifactTextureSource( source ) ) continue;
				const matchIndex = identifiableNodeTextures.findIndex( ( texture, index ) => ! matchedNodeTextureSources.has( index ) && __textureMatchesArtifactSource( texture, source ) );
				if ( matchIndex !== -1 ) matchedNodeTextureSources.add( matchIndex );
			}
		}
		if ( matchedNodeTextureSources.size > 0 ) score += matchedNodeTextureSources.size * 90;
		else if ( identifiableNodeTextures.length > 0 && __artifactHasTextureSource( artifact, ( source ) => source.kind === 'artifact.texture' && ! __isPMREMArtifactTextureSource( source ) ) ) score -= 55;
	} else if ( __sourceHasNodeGraph( sourceMaterial ) ) {
		// A live node graph without discoverable Texture nodes should not prefer
		// captured artifacts that do sample textures. Examples such as
		// webgpu_materials.html have many MeshBasicNodeMaterial variants with the
		// same class name; rewarding textured artifacts here swaps position/normal
		// materials with texture-based ones.
		if ( __artifactHasTextureSource( artifact ) ) score -= 65;
		else score += 10;
	}

		const nodeAttrs = __artifactNodeAttributes( artifact );
	const declaredAttrs = Array.isArray( artifact.attributes ) ? artifact.attributes : [];
	const artifactSkinned = declaredAttrs.some( ( entry ) => entry && ( entry.name === 'skinIndex' || entry.name === 'skinWeight' ) );
	const sourceGeometryAttrs = sourceObject && sourceObject.geometry && sourceObject.geometry.attributes || {};
	const sourceSkinned = !! ( sourceObject && ( sourceObject.isSkinnedMesh === true || sourceGeometryAttrs.skinIndex || sourceGeometryAttrs.skinWeight ) );
	if ( artifactSkinned && sourceSkinned ) score += 90;
	else if ( artifactSkinned && sourceObject && ! sourceSkinned ) score -= 220;
	else if ( sourceSkinned && ! artifactSkinned ) score -= 120;
	if ( sourceObject && sourceObject.isInstancedMesh === true ) {
		const count = sourceObject.count || 0;
		const artifactInstancedCount = __artifactInstancedDrawCount( artifact );
		const matchingAttrs = count ? nodeAttrs.filter( ( entry ) => entry.count === count ) : [];
		const matrixAttrs = matchingAttrs.filter( ( entry ) => ( entry.itemSize || 0 ) === 4 || entry.type === 'vec4' );
		const colorAttrs = matchingAttrs.filter( ( entry ) => ( entry.itemSize || 0 ) === 3 || entry.type === 'vec3' );
		if ( artifactInstancedCount && count ) score += artifactInstancedCount === count ? 170 : -300;
		else if ( matchingAttrs.length > 0 ) score += 80;
		else if ( nodeAttrs.length === 0 ) score -= 45;
		if ( sourceObject.instanceMatrix && matrixAttrs.length >= 4 ) score += 60;
		if ( sourceObject.instanceColor && colorAttrs.length > 0 ) score += 40;
	} else if ( nodeAttrs.length > 0 ) {
		score -= 10;
	}

	return score;
}

function __findBestArtifactForSource( className, sourceMaterial, keys, sourceObject = null ) {
	if ( ! sourceMaterial || ! Array.isArray( keys ) || keys.length === 0 ) return null;
	const findBest = ( candidateKeys, minScore = 55 ) => {
		let best = null;
		let bestScore = -Infinity;
		for ( const key of candidateKeys ) {
			const mod = __data.user && __data.user[ key ];
			const score = __scoreArtifactForSource( key, mod, className, sourceMaterial, sourceObject );
			if ( score > bestScore ) {
				best = key;
				bestScore = score;
			}
		}
		return best && bestScore > -Infinity && bestScore >= minScore ? best : null;
	};
	const exactKeys = keys.filter( ( key ) => __classNameFromArtifactName( key ) === className || key.includes( ':' + className + ':' ) );
	return findBest( exactKeys, -Infinity ) || findBest( keys );
}

function __artifactKeyMatchesMaterialSource( key, mod, className, sourceMaterial, sourceObject = null ) {
	const artifact = mod && mod.artifact;
	if ( ! artifact ) return false;
	if ( sourceObject && __isPipelineArtifactShape( artifact ) ) return false;
	const artifactClassName = __classNameFromArtifactName( key );
	if ( artifactClassName !== className && ! key.includes( ':' + className + ':' ) ) return false;
	const requestedFamily = __materialFamilyFromClassName( className );
	const artifactFamily = __materialFamilyFromClassName( artifactClassName );
	const objectFamily = __materialFamilyFromObject( sourceObject );
	if ( requestedFamily && artifactFamily && requestedFamily !== artifactFamily ) return false;
	if ( objectFamily && artifactFamily && objectFamily !== artifactFamily ) return false;
	return __precompiledArtifactMatchesSource( artifact, sourceMaterial, sourceObject );
}

function __attachGeneratedUpdatersFromModule( artifact, mod ) {
	if ( ! artifact || ! mod ) return artifact;
	if ( typeof mod.update === 'function' && typeof artifact._generatedUpdate !== 'function' ) {
		try { Object.defineProperty( artifact, '_generatedUpdate', { value: mod.update, enumerable: false, configurable: true } ); } catch ( _ ) {}
	}
	if ( typeof mod.updateGroup === 'function' && typeof artifact._generatedUpdateGroup !== 'function' ) {
		try { Object.defineProperty( artifact, '_generatedUpdateGroup', { value: mod.updateGroup, enumerable: false, configurable: true } ); } catch ( _ ) {}
	}
	return artifact;
}

function __takeMaterial( className, sourceMaterial = null, sourceObject = null, opts = {} ) {
	const allowUsed = !! ( opts && opts.allowUsed );
	const n = ( __counts[ className ] || 0 ) + 1;
	__counts[ className ] = n;
	const ordinalName = __state.example + ':' + className + ':' + n;
	const preferredName = opts && typeof opts.preferredName === 'string' ? opts.preferredName : '';
	const preferredMod = preferredName && __data.user && __data.user[ preferredName ];
	const usePreferred = !! ( preferredMod && preferredMod.artifact && __classNameFromArtifactName( preferredName ) === className );
	let name = usePreferred ? preferredName : ordinalName;
	let mod = __data.user && __data.user[ name ];
	if ( mod && ! allowUsed && __usedArtifactNames.has( name ) ) mod = null;
	if ( sourceMaterial && ! usePreferred ) {
		if ( ! mod || ! __artifactKeyMatchesMaterialSource( name, mod, className, sourceMaterial, sourceObject ) ) {
			const allKeys = Object.keys( __data.user || {} );
			const unusedKeys = allowUsed ? allKeys : allKeys.filter( ( key ) => ! __usedArtifactNames.has( key ) );
			const matchedName = __findBestArtifactForSource( className, sourceMaterial, unusedKeys, sourceObject );
			if ( matchedName ) {
				name = matchedName;
				mod = __data.user[ name ];
			} else if ( ! allowUsed ) {
				const usedMatchedName = __findBestArtifactForSource( className, sourceMaterial, allKeys, sourceObject );
				if ( usedMatchedName ) {
					name = usedMatchedName;
					mod = __data.user[ name ];
				}
			}
		}
	}
	if ( ! mod || ! mod.artifact ) {
		const allKeys = Object.keys( __data.user || {} );
		const unusedKeys = allowUsed ? allKeys : allKeys.filter( ( key ) => ! __usedArtifactNames.has( key ) );
		const typeNeedle = __sourceTypeNeedle( sourceMaterial );
		const findUuid = ( keys ) => sourceMaterial ? keys.find( ( key ) => __artifactMatchesSourceMaterialUuid( __data.user && __data.user[ key ] && __data.user[ key ].artifact, sourceMaterial ) ) : null;
		const findType = ( keys ) => keys.find( ( key ) => typeNeedle && key.includes( ':' + typeNeedle + ':' ) );
		const findCompatible = ( keys ) => keys.find( ( key ) => /:(MeshBasic|MeshLambert|MeshStandard)NodeMaterial:/.test( key ) );
		const findClass = ( keys ) => keys.find( ( key ) => key.includes( ':' + className + ':' ) );
		const findNodeMaterial = ( keys ) => keys.find( ( key ) => /:NodeMaterial:\d+$/.test( key ) );
		const findLineBasic = ( keys ) => keys.find( ( key ) => /:LineBasicNodeMaterial:/.test( key ) );
		const isMeshNodeMaterial = /^Mesh[A-Za-z0-9]*NodeMaterial$/.test( className );
		const isSpriteOrPointsNodeMaterial = /^(Sprite|Points)NodeMaterial$/.test( className );
		const fallbackName = findUuid( unusedKeys ) || findUuid( allKeys ) ||
			findType( unusedKeys ) || findType( allKeys ) ||
			( className === 'Line2NodeMaterial' ? findCompatible( unusedKeys ) || findCompatible( allKeys ) : null ) ||
			( className === 'LineDashedNodeMaterial' ? findLineBasic( unusedKeys ) || findLineBasic( allKeys ) : null ) ||
			findClass( unusedKeys ) || findClass( allKeys ) ||
			( className === 'VolumeNodeMaterial' ? findNodeMaterial( unusedKeys ) || findNodeMaterial( allKeys ) : null ) ||
			( isMeshNodeMaterial ? findCompatible( unusedKeys ) || findCompatible( allKeys ) : null ) ||
			( isSpriteOrPointsNodeMaterial ? findCompatible( unusedKeys ) || findCompatible( allKeys ) : null ) ||
			( className.length <= 3 ? findCompatible( unusedKeys ) || findCompatible( allKeys ) : null );
		if ( fallbackName ) {
			name = fallbackName;
			mod = __data.user[ name ];
		}
	}
	if ( ! mod || ! mod.artifact ) {
		throw new Error( '[tslp-e2e] no captured artifact for ' + name + ' (class=' + className + ', len=' + String( className.length ) + ', type=' + ( sourceMaterial && sourceMaterial.type || '' ) + ', keys=' + Object.keys( __data.user || {} ).slice( 0, 5 ).join( '|' ) + '). Capture pass did not see this material.' );
	}
	__usedArtifactNames.add( name );
	if ( mod.__hash && ! mod.artifact.__hash ) Object.defineProperty( mod.artifact, '__hash', { value: mod.__hash, enumerable: false, configurable: true } );
	__attachGeneratedUpdatersFromModule( mod.artifact, mod );
		// Wire live storage buffer attributes from the source material's node graph into
		// the artifact plan before hydration so compute results are visible in renders.
				__wireComputeAttrsToArtifact( mod.artifact, sourceMaterial );
				__ensureArtifactTextureFallbacks( mod.artifact );
			const material = new Slim.PrecompiledMaterial( mod.artifact );
	material.name = name;
	__stampPrecompiledMaterialClassFlags( material, className );
	if ( className === 'MeshToonNodeMaterial' || className === 'MeshToonMaterial' ) {
		material.isMeshToonNodeMaterial = true;
		material.isMeshToonMaterial = true;
	}
	if ( className === 'NodeMaterial' && sourceMaterial && sourceMaterial.isMeshToonOutlineMaterial === true ) {
		material.isMeshToonOutlineMaterial = true;
	}
	__attachReflectorBaseNodesForArtifact( material, mod.artifact, sourceObject );
	__seedNodeProps( material );
	return material;
}

function __classNameForMaterial( material ) {
	if ( ! material ) return 'Material';
	const type = material.type || '';
	if ( type === 'Line2NodeMaterial' ) return 'Line2NodeMaterial';
	if ( material.isMeshBasicNodeMaterial || material.isMeshBasicMaterial ) return 'MeshBasicNodeMaterial';
	if ( material.isMeshSSSNodeMaterial || material.type === 'MeshSSSNodeMaterial' ) return 'MeshSSSNodeMaterial';
	if ( material.isMeshPhysicalNodeMaterial || material.isMeshPhysicalMaterial ) return 'MeshPhysicalNodeMaterial';
	if ( material.isMeshStandardNodeMaterial || material.isMeshStandardMaterial ) return 'MeshStandardNodeMaterial';
	if ( material.isMeshLambertNodeMaterial || material.isMeshLambertMaterial ) return 'MeshLambertNodeMaterial';
	if ( material.isMeshPhongNodeMaterial || material.isMeshPhongMaterial ) return 'MeshPhongNodeMaterial';
	if ( material.isMeshToonNodeMaterial || material.isMeshToonMaterial ) return 'MeshToonNodeMaterial';
	if ( material.isMeshNormalNodeMaterial || material.isMeshNormalMaterial ) return 'MeshNormalNodeMaterial';
	if ( material.isMeshMatcapNodeMaterial || material.isMeshMatcapMaterial ) return 'MeshMatcapNodeMaterial';
	if ( material.isLine2NodeMaterial ) return 'Line2NodeMaterial';
	if ( material.isLineBasicNodeMaterial || material.isLineBasicMaterial ) return 'LineBasicNodeMaterial';
	if ( material.isPointsNodeMaterial || material.isPointsMaterial ) return 'PointsNodeMaterial';
	if ( material.isSpriteNodeMaterial || material.isSpriteMaterial ) return 'SpriteNodeMaterial';
	if ( material.isVolumeNodeMaterial || type === 'VolumeNodeMaterial' ) return 'VolumeNodeMaterial';
	if ( type === 'MeshBasicNodeMaterial' || type === 'MeshBasicMaterial' ) return 'MeshBasicNodeMaterial';
	if ( type === 'MeshSSSNodeMaterial' ) return 'MeshSSSNodeMaterial';
	if ( type === 'MeshPhysicalNodeMaterial' || type === 'MeshPhysicalMaterial' ) return 'MeshPhysicalNodeMaterial';
	if ( type === 'MeshStandardNodeMaterial' || type === 'MeshStandardMaterial' ) return 'MeshStandardNodeMaterial';
	if ( type === 'MeshLambertNodeMaterial' || type === 'MeshLambertMaterial' ) return 'MeshLambertNodeMaterial';
	if ( type === 'MeshPhongNodeMaterial' || type === 'MeshPhongMaterial' ) return 'MeshPhongNodeMaterial';
	if ( type === 'MeshToonNodeMaterial' || type === 'MeshToonMaterial' ) return 'MeshToonNodeMaterial';
	if ( type === 'MeshNormalNodeMaterial' || type === 'MeshNormalMaterial' ) return 'MeshNormalNodeMaterial';
	if ( type === 'MeshMatcapNodeMaterial' || type === 'MeshMatcapMaterial' ) return 'MeshMatcapNodeMaterial';
	if ( type === 'Line2NodeMaterial' ) return 'Line2NodeMaterial';
	if ( type === 'LineBasicNodeMaterial' || type === 'LineBasicMaterial' ) return 'LineBasicNodeMaterial';
	if ( type === 'PointsNodeMaterial' || type === 'PointsMaterial' ) return 'PointsNodeMaterial';
	if ( type === 'SpriteNodeMaterial' || type === 'SpriteMaterial' ) return 'SpriteNodeMaterial';
	if ( /NodeMaterial$/.test( type ) ) return type;
	return material.constructor && material.constructor.name || 'Material';
}

	function __stampPrecompiledMaterialClassFlags( material, className ) {
	if ( ! material || typeof className !== 'string' ) return material;
	if ( className === 'MeshBasicNodeMaterial' ) {
		material.isMeshBasicNodeMaterial = true;
		material.isMeshBasicMaterial = true;
	} else if ( className === 'MeshPhongNodeMaterial' ) {
		material.isMeshPhongNodeMaterial = true;
		material.isMeshPhongMaterial = true;
	} else if ( className === 'MeshStandardNodeMaterial' ) {
		material.isMeshStandardNodeMaterial = true;
		material.isMeshStandardMaterial = true;
	} else if ( className === 'MeshPhysicalNodeMaterial' ) {
		material.isMeshPhysicalNodeMaterial = true;
		material.isMeshPhysicalMaterial = true;
		} else if ( className === 'MeshLambertNodeMaterial' ) {
			material.isMeshLambertNodeMaterial = true;
			material.isMeshLambertMaterial = true;
		} else if ( className === 'PointsNodeMaterial' ) {
			material.isPointsNodeMaterial = true;
			material.isPointsMaterial = true;
		} else if ( className === 'SpriteNodeMaterial' ) {
			material.isSpriteNodeMaterial = true;
			material.isSpriteMaterial = true;
		} else if ( className === 'VolumeNodeMaterial' ) {
			material.isVolumeNodeMaterial = true;
		}
		return material;
	}

	function __isRetroPassRenderTarget( renderer ) {
	try {
		const target = renderer && typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
		const texture = target && target.texture;
		return !! ( texture
			&& texture.magFilter === Slim.NearestFilter
			&& texture.minFilter === Slim.NearestFilter );
	} catch ( _ ) {
		return false;
	}
}

function __isRetroPassGeneratedMaterial( renderer, scene, material ) {
	if ( ! material || material.isPrecompiledMaterial === true ) return false;
	return !! ( scene && scene.isScene === true && scene.userData && scene.userData.__tslpUserScene === true
		&& ( renderer && ( renderer.__tslpRenderingRetroPass | 0 ) > 0 || __isRetroPassRenderTarget( renderer ) ) );
}

// Material-property keys that carry texture refs three.js's renderer
// reads off the material directly. The hydrator's 'material.<prop>'
// resolver pulls live values from these on each frame.
//
// Audited against three.js r185 MeshStandardMaterial / MeshPhysicalMaterial /
// Scalar/Color/Vector2/array PBR material properties -- copied source->swap
// on every replay so live GUI tweaks (lightMapIntensity, displacementScale,
// etc.) survive into the precompiled material's per-frame uniform updaters.
const __SCALAR_PROPS = [ 'color', 'opacity', 'transparent', 'side', 'visible', 'toneMapped', 'emissive', 'emissiveIntensity', 'roughness', 'metalness', 'normalScale', 'normalMapType', 'bumpScale', 'displacementScale', 'displacementBias', 'lightMapIntensity', 'aoMapIntensity', 'envMapIntensity', 'envMapRotation', 'reflectivity', 'refractionRatio', 'shininess', 'specular', 'specularColor', 'specularIntensity', 'ior', 'clearcoat', 'clearcoatRoughness', 'clearcoatNormalScale', 'iridescence', 'iridescenceIOR', 'iridescenceThicknessRange', 'sheen', 'sheenColor', 'sheenRoughness', 'transmission', 'thickness', 'attenuationColor', 'attenuationDistance', 'anisotropy', 'anisotropyRotation', 'dispersion', 'alphaTest', 'alphaHash', 'alphaToCoverage', 'depthTest', 'depthWrite', 'blending', 'blendSrc', 'blendDst', 'blendEquation', 'premultipliedAlpha', 'dithering', 'vertexColors', 'wireframe', 'wireframeLinewidth', 'flatShading', 'linewidth', 'dashSize', 'gapSize', 'dashOffset', 'scale', 'worldUnits', 'dashed' ];
// Mirror three.js's Material.setValues() coercion: when assigning into a slot
// that already holds a Color/Vector instance (seeded from artifact.defaults),
// mutate it in place via .set() / .copy() so the hydrator keeps reading a
// live Color and hex / string / Color inputs are normalised the same way the
// real three.js constructor would. Plain scalars and unknown shapes fall back
// to direct assignment.
function __assignParam( mat, key, value ) {
	const current = mat[ key ];
	if ( current && current.isColor ) {
		current.set( value );
	} else if ( current && value && (
		( current.isVector2 && value.isVector2 ) ||
		( current.isVector3 && value.isVector3 ) ||
		( current.isVector4 && value.isVector4 )
	) ) {
		current.copy( value );
	} else {
		mat[ key ] = value;
	}
}

function __makeFallbackNodeMaterial( params ) {
	const material = new Slim.MeshBasicMaterial( { color: 0xffffff } );
	material.name = 'tslp-fallback-node-material';
	material.toneMapped = false;
	material.depthTest = false;
	material.depthWrite = false;
	material.transparent = true;
	if ( params && typeof params === 'object' ) {
		for ( const key in params ) {
			if ( params[ key ] !== undefined ) __assignParam( material, key, params[ key ] );
		}
	}
	return material;
}

function __makeInternalNodeMaterial( className = 'NodeMaterial', params = null ) {
	let Ctor = FullNodeMaterial;
	if ( ( className === 'MeshBasicNodeMaterial' || className === 'MeshBasicMaterial' ) && FullMeshBasicNodeMaterial ) Ctor = FullMeshBasicNodeMaterial;
	else if ( ( className === 'MeshStandardNodeMaterial' || className === 'MeshStandardMaterial' ) && FullMeshStandardNodeMaterial ) Ctor = FullMeshStandardNodeMaterial;
	else if ( ( className === 'MeshPhysicalNodeMaterial' || className === 'MeshPhysicalMaterial' ) && FullMeshPhysicalNodeMaterial ) Ctor = FullMeshPhysicalNodeMaterial;
	else if ( ( className === 'MeshLambertNodeMaterial' || className === 'MeshLambertMaterial' ) && FullMeshLambertNodeMaterial ) Ctor = FullMeshLambertNodeMaterial;
	else if ( ( className === 'MeshPhongNodeMaterial' || className === 'MeshPhongMaterial' ) && FullMeshPhongNodeMaterial ) Ctor = FullMeshPhongNodeMaterial;
	else if ( ( className === 'MeshToonNodeMaterial' || className === 'MeshToonMaterial' ) && FullMeshToonNodeMaterial ) Ctor = FullMeshToonNodeMaterial;
	else if ( ( className === 'MeshNormalNodeMaterial' || className === 'MeshNormalMaterial' ) && FullMeshNormalNodeMaterial ) Ctor = FullMeshNormalNodeMaterial;
	else if ( ( className === 'MeshMatcapNodeMaterial' || className === 'MeshMatcapMaterial' ) && FullMeshMatcapNodeMaterial ) Ctor = FullMeshMatcapNodeMaterial;
	else if ( className === 'MeshSSSNodeMaterial' && FullMeshSSSNodeMaterial ) Ctor = FullMeshSSSNodeMaterial;
	else if ( className === 'VolumeNodeMaterial' && FullVolumeNodeMaterial ) Ctor = FullVolumeNodeMaterial;
	else if ( ( className === 'LineBasicNodeMaterial' || className === 'LineBasicMaterial' ) && FullLineBasicNodeMaterial ) Ctor = FullLineBasicNodeMaterial;
	else if ( ( className === 'LineDashedNodeMaterial' || className === 'LineDashedMaterial' ) && FullLineDashedNodeMaterial ) Ctor = FullLineDashedNodeMaterial;
	else if ( className === 'Line2NodeMaterial' && FullLine2NodeMaterial ) Ctor = FullLine2NodeMaterial;
	else if ( ( className === 'PointsNodeMaterial' || className === 'PointsMaterial' ) && FullPointsNodeMaterial ) Ctor = FullPointsNodeMaterial;
	else if ( ( className === 'SpriteNodeMaterial' || className === 'SpriteMaterial' ) && FullSpriteNodeMaterial ) Ctor = FullSpriteNodeMaterial;
	else if ( ( className === 'ShadowNodeMaterial' || className === 'ShadowMaterial' ) && FullShadowNodeMaterial ) Ctor = FullShadowNodeMaterial;
	let material;
	try {
		material = new Ctor();
	} catch ( _ ) {
		material = new FullNodeMaterial();
	}
	material.name = 'tslp-internal-' + className;
	material.__tslpInternalPostProcessMaterial = true;
	if ( params && typeof params === 'object' ) {
		for ( const key in params ) {
			if ( params[ key ] !== undefined ) __assignParam( material, key, params[ key ] );
		}
	}
	material.needsUpdate = true;
	return material;
}

function __copyMaterialProps( src, dst ) {
	for ( const key of __SCALAR_PROPS ) if ( src && src[ key ] !== undefined ) __assignParam( dst, key, src[ key ] );
	for ( const key of __TEXTURE_PROPS ) if ( src && src[ key ] !== undefined ) dst[ key ] = src[ key ];
}

// The precompiled shader is already baked, so the wrapper does NOT recompile
// from these — but the runtime hydrator's bindUserNodeAttributesToArtifact
// walks dst[ userPath[0] ] to resolve live BufferAttribute leaves (e.g.
// instancedBufferAttribute(buf) inside material.positionNode). Without
// this copy the walk hits undefined and every captured node-attribute
// falls back to a zero-filled StorageBufferAttribute → instances render at
// origin with zero-vector colors (see webgpu_instance_path).
function __copyMaterialNodeProps( src, dst ) {
	if ( ! src ) return;
	for ( const key of __nodeGraphKeys() ) {
		if ( key === 'mrtNode' ) continue;
		const v = src[ key ];
		if ( v && v.isNode === true ) dst[ key ] = v;
	}
}

// Wire the source material's live textures onto the precompiled artifact's
// _textureRefs map so the hydrator can resolve artifact.texture-kind
// bindings whose captured textureUuid no longer matches anything.
// For multi-texture artifacts this is a best-effort fallback.
function __wireMaterialTextures( sourceMaterial, replacement ) {
	if ( ! sourceMaterial || ! replacement || ! replacement.precompiledArtifact ) return;
	const artifact = replacement.precompiledArtifact;
	__ensureArtifactTextureFallbacks( artifact );
	for ( const key of __TEXTURE_PROPS ) {
		const tex = sourceMaterial[ key ];
		if ( tex && tex.isTexture === true ) {
			const matched = __attachArtifactTextureRefsWhere( artifact, tex, ( source ) => ! __isPMREMArtifactTextureSource( source ) && ! source.snapshot && __textureMatchesArtifactSource( tex, source ) );
			if ( ! matched && __countArtifactTextureSources( artifact, ( source ) => ! __isPMREMArtifactTextureSource( source ) && ! source.snapshot ) <= 1 ) {
				__attachArtifactTextureRefsWhere( artifact, tex, ( source ) => ! __isPMREMArtifactTextureSource( source ) && ! source.snapshot );
			}
		}
	}
	__wireMaterialNodeTextures( sourceMaterial, replacement );
}

function __artifactTextureFallbackUrl( imageSrc ) {
	let url = imageSrc;
	try {
		const parsed = new URL( imageSrc, window.location.href );
		url = parsed.origin === window.location.origin
			? parsed.pathname + parsed.search + parsed.hash
			: parsed.href;
	} catch ( _ ) {}
	return url;
}

function __makeFallbackArtifactTexture( source ) {
	const key = source && ( source.textureUuid || source.imageSrc || source.textureName ) || 'texture';
	if ( __fallbackArtifactTextures.has( key ) ) return __fallbackArtifactTextures.get( key );
	if ( __isBayer16FallbackSource( source ) ) {
		const texture = __makeBayer16FallbackTexture( source );
		__fallbackArtifactTextures.set( key, texture );
		return texture;
	}
	if ( source && source.imageSrc && ! /\.(?:hdr|exr|ktx2?|basis)(?:[?#]|$)/i.test( source.imageSrc ) ) {
			const url = __artifactTextureFallbackUrl( source.imageSrc );
			const texture = new Slim.TextureLoader().load( url, () => {
				__applyCapturedTextureState( texture, source );
				try { texture.dispose && texture.dispose(); } catch ( _ ) {}
				texture.needsUpdate = true;
				__rememberLiveTexture( texture );
			} );
			texture.name = source.textureName || __basenameFromUrl( source.imageSrc ) || texture.name;
			__applyCapturedTextureState( texture, source );
			if ( ! __textureImageReady( texture ) ) {
				texture.image = __newFallbackTextureImage();
				texture.needsUpdate = true;
		}
		__rememberLiveTexture( texture );
		__fallbackArtifactTextures.set( key, texture );
		return texture;
	}
	const data = new Uint8Array( [ 255, 255, 255, 255 ] );
	const texture = new Slim.DataTexture( data, 1, 1 );
	texture.name = source && ( source.textureName || __basenameFromUrl( source.imageSrc ) ) || 'tslp-fallback-texture';
	__applyCapturedTextureState( texture, source );
	texture.needsUpdate = true;
	__fallbackArtifactTextures.set( key, texture );
	return texture;
}

function __isBayer16FallbackSource( source ) {
	return !! (
		source &&
		typeof __state.example === 'string' &&
		__state.example.startsWith( 'webgpu_volume_' ) &&
		! source.textureName &&
		! source.imageSrc &&
		! source.snapshot &&
		Number( source.imageWidth || 0 ) === 256 &&
		Number( source.imageHeight || 0 ) === 256 &&
		source.flipY === false
	);
}

function __makeBayer16FallbackTexture( source ) {
	let matrix = [ [ 0 ] ];
	for ( let size = 1; size < 16; size *= 2 ) {
		const next = Array.from( { length: size * 2 }, () => new Array( size * 2 ).fill( 0 ) );
		for ( let y = 0; y < size; y ++ ) {
			for ( let x = 0; x < size; x ++ ) {
				const v = matrix[ y ][ x ] * 4;
				next[ y ][ x ] = v;
				next[ y ][ x + size ] = v + 2;
				next[ y + size ][ x ] = v + 3;
				next[ y + size ][ x + size ] = v + 1;
			}
		}
		matrix = next;
	}
	const data = new Uint8Array( 16 * 16 * 4 );
	for ( let y = 0; y < 16; y ++ ) {
		for ( let x = 0; x < 16; x ++ ) {
			const value = matrix[ y ][ x ];
			const offset = ( y * 16 + x ) * 4;
			data[ offset + 0 ] = value;
			data[ offset + 1 ] = value;
			data[ offset + 2 ] = value;
			data[ offset + 3 ] = 255;
		}
	}
	const texture = new Slim.DataTexture( data, 16, 16 );
	texture.name = 'tslp-bayer16-texture';
	__applyCapturedTextureState( texture, source );
	texture.generateMipmaps = false;
	texture.needsUpdate = true;
	return texture;
}

function __applyCapturedTextureState( texture, source ) {
	if ( ! texture || ! source ) return;
	for ( const key of [ 'mapping', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'anisotropy', 'generateMipmaps', 'flipY', 'colorSpace' ] ) {
		if ( source[ key ] !== undefined ) {
			try { texture[ key ] = source[ key ]; } catch ( _ ) {}
		}
	}
}

function __restoreMaterialTextureStatesFromArtifact( material, artifact ) {
	if ( ! material || ! artifact ) return false;
	const seen = new Set();
	let changed = false;
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( ! source.kind || ! source.kind.startsWith( 'material.' ) ) continue;
			const property = source.property || source.kind.split( '.' )[ 1 ];
			if ( ! property || seen.has( property ) ) continue;
			seen.add( property );
			const texture = material[ property ];
			if ( ! ( texture && texture.isTexture === true ) ) continue;
			let textureChanged = false;
			for ( const key of [ 'mapping', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'anisotropy', 'generateMipmaps', 'flipY', 'colorSpace' ] ) {
				if ( source[ key ] === undefined || texture[ key ] === source[ key ] ) continue;
				try {
					texture[ key ] = source[ key ];
					textureChanged = true;
				} catch ( _ ) {}
			}
			if ( textureChanged ) {
				texture.needsUpdate = true;
				__rememberLiveTexture( texture );
				changed = true;
			}
		}
	}
	if ( changed ) {
		try {
			const diag = __harnessDiagnostics();
			diag.restoredMaterialTextureStates = ( diag.restoredMaterialTextureStates | 0 ) + 1;
		} catch ( _ ) {}
	}
	return changed;
}

function __ensureArtifactTextureFallbacks( artifact ) {
	if ( ! artifact ) return;
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	let changed = false;
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid || __isPMREMArtifactTextureSource( source ) ) continue;
			if ( source.snapshot ) continue;
			if ( refs.has( source.textureUuid ) ) continue;
			refs.set( source.textureUuid, __makeFallbackArtifactTexture( source ) );
			changed = true;
		}
	}
	if ( changed ) {
		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );
	}
}

function __wireMaterialNodeTextures( sourceMaterial, replacement ) {
	if ( ! sourceMaterial || ! replacement || ! replacement.precompiledArtifact ) return;
	const artifact = replacement.precompiledArtifact;
	__wireLiveNodeSidecarsToArtifact( artifact, sourceMaterial, replacement );
	let renderer = null;
	let avoidTexture = null;
	try {
		renderer = window.__tslpCurrentReplayRenderer;
		const target = renderer && typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
		avoidTexture = target && target.texture || null;
	} catch ( _ ) {}
	const nodeTextures = __collectMaterialNodeTextures( sourceMaterial );
	const globalTslTextures = Array.isArray( window.__tslpTslTextureArgs ) ? window.__tslpTslTextureArgs : [];
	const rendererTextures = globalTslTextures.filter( ( texture ) => {
		if ( ! renderer || ! renderer.backend || typeof renderer.backend.has !== 'function' || ! renderer.backend.has( texture ) ) return false;
		try {
			const data = renderer.backend.get( texture );
			return !! ( data && data.texture );
		} catch ( _ ) {
			return false;
		}
	} );
	const lateTargetPair = __selectLateRenderTargetTexturePair( artifact, rendererTextures );
	if ( lateTargetPair ) {
		__attachTextureRefsWhere(
			artifact,
			lateTargetPair.colorTexture,
			( source ) => source.kind === 'artifact.texture' && source.textureUuid === lateTargetPair.colorTextureUuid,
		);
		__attachTextureRefsWhere(
			artifact,
			lateTargetPair.depthTexture,
			( source ) => source.kind === 'depth.texture' && source.textureUuid === lateTargetPair.depthTextureUuid,
		);
		__rememberLiveTexture( lateTargetPair.colorTexture );
		__rememberLiveTexture( lateTargetPair.depthTexture );
		try {
			const diag = __harnessDiagnostics();
			diag.lateRenderTargetTexturePairs = ( diag.lateRenderTargetTexturePairs | 0 ) + 1;
			const samples = diag.lateRenderTargetTexturePairSamples || ( diag.lateRenderTargetTexturePairSamples = [] );
			if ( samples.length < 4 ) {
				let capturedColorSource = null;
				for ( const group of artifact.uniformPlan || [] ) {
					for ( const entry of group.textures || [] ) {
						const source = entry && entry.source || {};
						if ( source.textureUuid === lateTargetPair.colorTextureUuid ) capturedColorSource = source;
					}
				}
				samples.push( {
					colorUuid: lateTargetPair.colorTexture.uuid || '',
					depthUuid: lateTargetPair.depthTexture.uuid || '',
					wrapS: lateTargetPair.colorTexture.wrapS,
					wrapT: lateTargetPair.colorTexture.wrapT,
					minFilter: lateTargetPair.colorTexture.minFilter,
					generateMipmaps: lateTargetPair.colorTexture.generateMipmaps,
					capturedWrapS: capturedColorSource && capturedColorSource.wrapS,
					capturedWrapT: capturedColorSource && capturedColorSource.wrapT,
					capturedMinFilter: capturedColorSource && capturedColorSource.minFilter,
					capturedGenerateMipmaps: capturedColorSource && capturedColorSource.generateMipmaps,
					depthCompareFunction: lateTargetPair.depthTexture.compareFunction,
				} );
			}
		} catch ( _ ) {}
	}
	for ( const texture of globalTslTextures ) {
		if ( texture === avoidTexture ) continue;
		if ( nodeTextures.includes( texture ) ) continue;
		if ( __artifactHasTextureSource( artifact, ( source ) => ! source.snapshot && __textureMatchesArtifactSource( texture, source ) ) ) {
			nodeTextures.push( texture );
		}
	}
	if ( nodeTextures.length === 0 && __countArtifactTextureSources( artifact, ( source ) => ! __isPMREMArtifactTextureSource( source ) && ! source.snapshot ) <= 1 ) {
		const candidates = globalTslTextures.filter( ( texture ) => texture && texture !== avoidTexture && texture.isTexture === true && texture.isCubeTexture !== true && texture.isData3DTexture !== true && texture.is3DTexture !== true && ! __isPMREMTexture( texture ) );
		if ( candidates.length === 1 ) nodeTextures.push( candidates[ 0 ] );
	}
	const exactDepthTextureCandidates = [
		...nodeTextures,
		...globalTslTextures,
		...__exactMaterialGraphDepthTextureCandidates,
	];
	__sharedAttachExactMaterialGraphDepthTextureRefs(
		artifact,
		exactDepthTextureCandidates,
	);
	const anonymousNodeTextures = nodeTextures.filter( ( tex ) => tex && tex.isTexture === true && ! __isPMREMTexture( tex ) && ! tex.name && ! __textureImageSrc( tex ) );
	for ( const tex of nodeTextures ) {
		if ( tex === avoidTexture ) continue;
		if ( tex && tex.isTexture === true ) __rememberLiveTexture( tex );
		const predicate = __isPMREMTexture( tex )
			? __isPMREMArtifactTextureSource
			: ( source ) => ! __isPMREMArtifactTextureSource( source ) && __textureMatchesArtifactSource( tex, source );
		const matched = __attachArtifactTextureRefsWhere( artifact, tex, predicate );
		// Anonymous-DataTexture fallback (e.g. CurveModifierGPU's Flow.splineTexture):
		// the captured source has no textureName/imageSrc/uuid, and the live texture
		// likewise has no identity, so the standard matcher can never link them.
		// When the artifact has exactly one unmatched non-PMREM artifact-texture
		// source, attach by elimination — same idea as __wireMaterialTextures'
		// single-source fallback at line 1450.
		if ( ! matched && ! __isPMREMTexture( tex ) && __countArtifactTextureSources( artifact, ( source ) => ! __isPMREMArtifactTextureSource( source ) && ! source.snapshot ) <= 1 ) {
			__attachArtifactTextureRefsWhere( artifact, tex, ( source ) => ! __isPMREMArtifactTextureSource( source ) && ! source.snapshot );
		}
	}
	__attachArtifactTextureRefsByShapeOrder(
		artifact,
		nodeTextures.filter( ( tex ) => tex && tex !== avoidTexture && ! __isPMREMTexture( tex ) ),
		( source ) => ! __isPMREMArtifactTextureSource( source ) && ! source.snapshot,
		{ overwriteExisting: true },
	);
	if ( anonymousNodeTextures.length === 1 ) {
		const anonymousSnapshotUuid = __singleArtifactTextureUuid( artifact, ( source ) => ! __isPMREMArtifactTextureSource( source ) && !! source.snapshot && __isTrivialTextureSnapshot( source.snapshot ) && ! source.textureName && ! source.imageSrc );
		if ( anonymousSnapshotUuid ) {
			__attachArtifactTextureRefsWhere( artifact, anonymousNodeTextures[ 0 ], ( source ) => source.textureUuid === anonymousSnapshotUuid );
		}
		const anonymousUnwiredUuid = __singleArtifactTextureUuid( artifact, ( source ) => {
			return ! __isPMREMArtifactTextureSource( source ) && ! source.snapshot && ! source.textureName && ! source.imageSrc && !! source.textureUuid;
		} );
		if ( anonymousUnwiredUuid ) {
			__attachArtifactTextureRefsWhere( artifact, anonymousNodeTextures[ 0 ], ( source ) => source.textureUuid === anonymousUnwiredUuid );
		}
	}
}

function __textureImageShape( texture ) {
	const image = texture && ( texture.image || texture.source && texture.source.data ) || null;
	if ( ! image ) return { width: 0, height: 0, depth: 0 };
	return {
		width: Number( image.width || 0 ),
		height: Number( image.height || 0 ),
		depth: Number( image.depth || image.depthOrArrayLayers || 0 ),
	};
}

function __wireObjectMorphTexture( material, object ) {
	const artifact = material && material.precompiledArtifact;
	const texture = object && object.isInstancedMesh === true ? object.morphTexture : null;
	if ( ! artifact || ! ( texture && texture.isTexture === true ) ) return false;
	const shape = __textureImageShape( texture );
	if ( ! shape.width || ! shape.height ) return false;
	const count = object.count | 0;
	let changed = false;
	const refs = artifact._textureRefs instanceof Map ? artifact._textureRefs : null;
	const matched = __attachArtifactTextureRefsWhere( artifact, texture, ( source, entry ) => {
		if ( entry && entry.bindingKind === 'sampler' ) return false;
		if ( source.imageDepth !== undefined && source.imageDepth !== null ) return false;
		if ( Number( source.imageWidth || 0 ) !== shape.width ) return false;
		if ( Number( source.imageHeight || 0 ) !== shape.height ) return false;
		if ( count > 1 && Number( source.imageHeight || 0 ) !== count ) return false;
		if ( ! refs || refs.get( source.textureUuid ) !== texture ) changed = true;
		return true;
	} );
	if ( matched ) __rememberLiveTexture( texture );
	return changed;
}

function __lookupLiveTextureForSource( source ) {
	if ( ! source ) return null;
	if ( source.textureUuid && __liveTexturesByUuid.has( source.textureUuid ) ) return __liveTexturesByUuid.get( source.textureUuid );
	for ( const key of [ source.textureName, source.imageSrc, __basenameFromUrl( source.textureName ), __basenameFromUrl( source.imageSrc ) ] ) {
		if ( key && __liveTexturesByName.has( key ) ) return __liveTexturesByName.get( key );
	}
	return null;
}

function __wireMaterialPropertyTexturesFromArtifact( material ) {
	const artifact = material && material.precompiledArtifact;
	if ( ! artifact ) return false;
	let changed = __restoreMaterialTextureStatesFromArtifact( material, artifact );
	const materialSources = [];
	const seenSources = new Set();
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( ! source.kind || ! source.kind.startsWith( 'material.' ) ) continue;
			const property = source.property || source.kind.split( '.' )[ 1 ];
			if ( ! property || ! __TEXTURE_PROPS.includes( property ) ) continue;
			const key = property + ':' + ( source.textureUuid || source.textureName || source.imageSrc || materialSources.length );
			if ( seenSources.has( key ) ) continue;
			seenSources.add( key );
			materialSources.push( { source, property } );
		}
	}
	if ( materialSources.length === 0 ) return false;
	const orderFallbacks = __liveMaterialTextures.filter( ( texture ) => texture && texture.isTexture === true && __textureImageReady( texture ) );
	for ( let i = 0; i < materialSources.length; i ++ ) {
		const { source, property } = materialSources[ i ];
		if ( material[ property ] && material[ property ].isTexture === true ) {
			__rememberLiveTexture( material[ property ] );
			continue;
		}
		let texture = __lookupLiveTextureForSource( source );
		if ( ! texture && ! source.textureName && ! source.imageSrc && orderFallbacks.length >= materialSources.length ) {
			texture = orderFallbacks[ i ];
		}
		if ( ! texture || texture.isTexture !== true ) continue;
		// TextureLoader registers its returned Texture before the onLoad callback
		// applies user-authored sampler/color-space state. A first replay frame can
		// therefore resolve the correct live image while it still has constructor
		// defaults. Apply the captured source state before exposing that texture on
		// the material; the signed selector must see the same shader topology on
		// this first frame, not one frame later in the restore path above.
		__applyCapturedTextureState( texture, source );
		material[ property ] = texture;
		changed = true;
	}
	return changed;
}

function __markMaterialTextureRewire( material ) {
	if ( ! material ) return;
	material.needsUpdate = true;
	try { material.dispose && material.dispose(); } catch ( _ ) {}
	window.__tslpMaterialTextureRewired = true;
}

function __flushMaterialTextureRewire( renderer ) {
	if ( ! window.__tslpMaterialTextureRewired ) return;
	window.__tslpMaterialTextureRewired = false;
	try {
		const nc = renderer && renderer._nodes && renderer._nodes.nodeBuilderCache;
		if ( nc && typeof nc.clear === 'function' ) nc.clear();
	} catch ( _ ) {}
}

function __isPMREMArtifactTextureSource( source ) {
	return __sharedIsPMREMArtifactTextureSource( source );
}

function __attachArtifactTextureRefsWhere( artifact, texture, predicate ) {
	return __sharedAttachArtifactTextureRefsWhere( artifact, texture, predicate );
}

function __attachArtifactTextureRefsByShapeOrder( artifact, textures, predicate = null, options = {} ) {
	return __sharedAttachArtifactTextureRefsByShapeOrder( artifact, textures, predicate, options );
}

function __attachTextureRefsWhere( artifact, texture, predicate ) {
	return __sharedAttachTextureRefsWhere( artifact, texture, predicate );
}

function __rememberGraphTexture( byName, texture ) {
	if ( ! texture || texture.isTexture !== true ) return;
	const name = texture.name || 'output';
	const list = byName.get( name ) || [];
	if ( ! list.includes( texture ) ) list.push( texture );
	byName.set( name, list );
	const dimension = __textureDimensionKey( texture );
	const dimensionKey = \`__dimension:\${ dimension }\`;
	const dimensionList = byName.get( dimensionKey ) || [];
	if ( ! dimensionList.includes( texture ) ) dimensionList.push( texture );
	byName.set( dimensionKey, dimensionList );
}

function __rememberRenderTargetTextures( byName, target ) {
	if ( ! target ) return;
	__rememberGraphTexture( byName, target.texture );
	__rememberGraphTexture( byName, target.depthTexture );
	for ( const texture of target.textures || [] ) __rememberGraphTexture( byName, texture );
}

function __isGraphTraversalCandidate( value ) {
	if ( ! value || ( typeof value !== 'object' && typeof value !== 'function' ) ) return false;
	try {
		if ( value.isTexture === true || value.isNode === true || value.isPassNode === true || value.isRTTNode === true || value.isRenderTarget === true ) return true;
	} catch ( _ ) {}
	try {
		if ( value.texture && value.texture.isTexture === true && typeof value.setSize === 'function' ) return true;
	} catch ( _ ) {}
	if ( Array.isArray( value ) ) return true;
	let tag = '';
	try { tag = Object.prototype.toString.call( value ); } catch ( _ ) { return false; }
	return tag === '[object Object]';
}

function __readGraphOwnValue( node, key ) {
	let descriptor = null;
	try { descriptor = Object.getOwnPropertyDescriptor( node, key ); } catch ( _ ) { return null; }
	if ( descriptor ) {
		if ( ! Object.prototype.hasOwnProperty.call( descriptor, 'value' ) ) return null;
		return descriptor.value;
	}
	try { return node[ key ]; } catch ( _ ) { return null; }
}

function __collectGraphTexturesByName( node, byName = new Map(), seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 16 || seen.has( node ) ) return byName;
	if ( node.isTexture === true ) {
		__rememberGraphTexture( byName, node );
		return byName;
	}
	if ( ! __isGraphTraversalCandidate( node ) ) return byName;
	seen.add( node );
	for ( const dependency of __sharedGetLiveNodeDependencies( node ) ) {
		__collectGraphTexturesByName( dependency.node, byName, seen, depth + 1 );
	}
	// OutlineNode owns 8 render targets (depth, mask, downsample, edge x2, blur
	// x2, composite). Their textures all default to name='' which collides with
	// scenePass output in the 'output' bucket and shuffles the wrong texture
	// into the post-process artifact's UUID-resolved slots. The outline replay
	// path explicitly binds the composite texture through
	// __attachOutlineCompositeTextureRefs, so short-circuit traversal here.
	if ( __isOutlineEffectNode( node ) ) return byName;
	if ( node.isPassNode === true ) __rememberRenderTargetTextures( byName, node.renderTarget );
	if ( node.isRTTNode === true ) __rememberRenderTargetTextures( byName, node.renderTarget );
	try {
		if ( node.passNode && node.passNode.isPassNode === true ) __rememberRenderTargetTextures( byName, node.passNode.renderTarget );
	} catch ( _ ) {}
	__rememberRenderTargetTextures( byName, node._horizontalRT );
	__rememberRenderTargetTextures( byName, node._verticalRT );
	for ( const key of [ 'value', '_value', 'texture', '_texture' ] ) {
		__rememberGraphTexture( byName, __readGraphOwnValue( node, key ) );
	}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'renderTarget', '_horizontalRT', '_verticalRT', 'geometry', 'material', 'domElement' ] );
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectGraphTexturesByName( item, byName, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectGraphTexturesByName( child, byName, seen, depth + 1 );
		}
	}
	return byName;
}

function __collectFrameEffectTextureAliases( node, byName, seen = new Set(), depth = 0 ) {
	if ( ! node || ! byName || depth > 32 || seen.has( node ) ) return byName;
	if ( ! __isGraphTraversalCandidate( node ) ) return byName;
	seen.add( node );
	for ( const dependency of __sharedGetLiveNodeDependencies( node ) ) {
		__collectFrameEffectTextureAliases( dependency.node, byName, seen, depth + 1 );
	}
	const type = __effectTypeName( node );
	if ( type === 'AfterImageNode' ) {
		const { oldTexture, compTexture } = __selectAfterImageReplayTextures( node );
		if ( oldTexture ) byName.set( 'AfterImageNode.old', [ oldTexture ] );
		if ( compTexture ) byName.set( 'AfterImageNode.comp', [ compTexture ] );
	}
	if ( type === 'TRAANode' ) {
		const existingResolve = byName.get( 'TRAANode.resolve' ) || [];
		let texture = null;
		try {
			const beauty = node.beautyNode;
			const passNode = beauty && beauty.passNode;
			// Context-sensitive scene passes still feed TRAA through the ordinary
			// resolve target. Bypassing that target here makes SSS/other context
			// effects look sharp but silently drops temporal anti-aliasing.
			if ( __useTRAAPrecompiledResolve( node ) ) texture = node._resolveRenderTarget && node._resolveRenderTarget.texture;
			else if ( __useTRAABeautyFallback( node ) ) texture = __traaBeautyFallbackTexture( node );
			else if ( passNode && passNode.contextNode !== null ) texture = node._resolveRenderTarget && node._resolveRenderTarget.texture;
			else if ( beauty && beauty.isRTTNode === true && ( byName.get( 'SSGI' ) || [] ).length > 0 ) texture = node._resolveRenderTarget && node._resolveRenderTarget.texture;
		} catch ( _ ) {}
		if ( ! texture && existingResolve.length > 0 ) return byName;
		if ( texture && texture.isTexture === true ) {
			byName.set( 'TRAANode.resolve', [ texture ] );
			try {
				const diag = __harnessDiagnostics();
				diag.traaBeautyFallbacks = ( diag.traaBeautyFallbacks | 0 ) + 1;
			} catch ( _ ) {}
		}
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement', 'renderTarget', '_compRT', '_oldRT' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectFrameEffectTextureAliases( item, byName, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectFrameEffectTextureAliases( child, byName, seen, depth + 1 );
		}
	}
	return byName;
}

function __effectTypeName( node ) {
	return node && node.constructor && ( node.constructor.type || node.constructor.name ) || node && node.type || '';
}

function __textureDimensionKey( texture ) {
	if ( ! texture || texture.isTexture !== true ) return '2d';
	if ( texture.isCubeTexture === true ) return 'cube';
	if ( texture.isData3DTexture === true || texture.isTexture3D === true ) return '3d';
	if ( texture.isDataArrayTexture === true || texture.isArrayTexture === true || texture.isCompressedArrayTexture === true ) return '2d-array';
	return '2d';
}

function __planTextureDimension( source, entry ) {
	const explicit = entry && entry.textureType && entry.textureType !== 'unknown' ? entry.textureType
		: source && source.textureType ? source.textureType
			: source && source.textureDimension ? source.textureDimension
				: null;
	if ( explicit === '3d' || explicit === '2d-array' || explicit === 'cube' || explicit === '2d' ) return explicit;
	const snapshot = source && source.snapshot;
	if ( snapshot ) {
		const depth = ( snapshot.depth | 0 ) || ( snapshot.layers | 0 ) || ( snapshot.depthOrArrayLayers | 0 );
		if ( depth > 1 ) return '3d';
		const width = snapshot.width | 0;
		const height = snapshot.height | 0;
		const data = snapshot.data || snapshot.array;
		const dataLength = data && typeof data.length === 'number' ? data.length : 0;
		if ( width > 0 && height > 0 && dataLength > width * height * 4 ) return '3d';
	}
	return null;
}

function __collectArtifactTextureDimensions( artifact ) {
	const dimensions = new Map();
	const rank = { '2d': 1, '2d-array': 2, cube: 2, '3d': 3 };
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid ) continue;
			const dimension = __planTextureDimension( source, entry );
			if ( ! dimension ) continue;
			const current = dimensions.get( source.textureUuid );
			if ( ! current || ( rank[ dimension ] || 0 ) > ( rank[ current ] || 0 ) ) dimensions.set( source.textureUuid, dimension );
		}
	}
	return dimensions;
}

function __selectGraphTexture( byName, name, dimension, offsets ) {
	let list = byName.get( name ) || [];
	let offsetKey = name;
	if ( dimension ) {
		const matching = list.filter( ( texture ) => __textureDimensionKey( texture ) === dimension );
		if ( matching.length > 0 ) {
			list = matching;
			offsetKey = \`\${ name }|\${ dimension }\`;
		} else {
			const dimensionKey = \`__dimension:\${ dimension }\`;
			const dimensionList = byName.get( dimensionKey ) || [];
			if ( dimensionList.length > 0 ) {
				list = dimensionList;
				offsetKey = dimensionKey;
			} else {
				list = [];
			}
		}
	}
	if ( list.length === 0 ) return null;
	const offset = offsets.get( offsetKey ) || 0;
	offsets.set( offsetKey, offset + 1 );
	return list[ Math.min( offset, list.length - 1 ) ];
}

function __attachGraphTextureRefs( artifact, graphNode ) {
	if ( ! artifact || ! graphNode ) return artifact;
	const byName = __collectGraphTexturesByName( graphNode );
	__collectFrameEffectTextureAliases( graphNode, byName );
	const globalTslTextures = Array.isArray( window.__tslpTslTextureArgs ) ? window.__tslpTslTextureArgs : [];
	for ( const texture of globalTslTextures ) {
		if ( texture && texture.isTexture === true ) {
			__rememberGraphTexture( byName, texture );
			__rememberLiveTexture( texture );
		}
	}
	const dimensionsByUuid = __collectArtifactTextureDimensions( artifact );
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	const byUuid = new Map();
	const offsets = new Map();
	let changed = false;
	const refDiag = [];
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid ) continue;
			if ( source.snapshot ) continue;
			let texture = byUuid.get( source.textureUuid );
			if ( ! texture ) {
				const name = source.textureName || 'output';
				const dimension = dimensionsByUuid.get( source.textureUuid ) || __planTextureDimension( source, entry );
				if ( source.imageSrc && ( byName.get( name ) || [] ).length === 0 ) continue;
				texture = __selectGraphTexture( byName, name, dimension, offsets );
				if ( ! texture ) continue;
				byUuid.set( source.textureUuid, texture );
			}
			refs.set( source.textureUuid, texture );
			source.__tslpGraphAttached = true;
			if ( refDiag.length < 24 ) {
				const image = texture && texture.image || null;
				refDiag.push( {
					name: source.textureName || 'output',
					uuid: source.textureUuid,
					textureName: texture && texture.name || '',
					isDepth: texture && texture.isDepthTexture === true,
					isRT: texture && texture.isRenderTargetTexture === true,
					width: image && ( image.width || image.naturalWidth || image.videoWidth ) || 0,
					height: image && ( image.height || image.naturalHeight || image.videoHeight ) || 0,
				} );
			}
			changed = true;
		}
	}
	if ( refDiag.length > 0 ) __harnessDiagnostics().graphTextureRefs = refDiag;
	if ( changed ) {
		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );
	}
	return artifact;
}

function __attachPassTextureRefs( artifact, passNode ) {
	if ( ! artifact || ! passNode ) return artifact;
	const getPassTexture = ( name ) => {
		try {
			const textures = passNode._textures || {};
			const tex = textures[ name ] || ( name === 'output' ? passNode.renderTarget && passNode.renderTarget.texture : name === 'depth' ? passNode.renderTarget && passNode.renderTarget.depthTexture : null );
			return tex && tex.isTexture === true ? tex : null;
		} catch ( _ ) {
			return null;
		}
	};
	const output = getPassTexture( 'output' );
	if ( output ) {
		__attachTextureRefsWhere( artifact, output, ( source ) => {
			if ( source.kind !== 'artifact.texture' ) return false;
			if ( source.snapshot ) return false;
			if ( source.textureName === 'output' ) return true;
			return source.__tslpGraphAttached !== true && ! source.textureName;
		} );
	}
	try {
		const textureNames = new Set( Object.keys( passNode._textures || {} ) );
		const mrt = passNode._mrt;
		if ( mrt && mrt.outputNodes && typeof mrt.outputNodes === 'object' ) {
			for ( const name of Object.keys( mrt.outputNodes ) ) textureNames.add( name );
		}
		for ( const name of textureNames ) {
			if ( name === 'output' || name === 'depth' ) continue;
			const texture = getPassTexture( name );
			if ( texture ) __attachTextureRefsWhere( artifact, texture, ( source ) => source.kind === 'artifact.texture' && ! source.snapshot && source.__tslpGraphAttached !== true && source.textureName === name );
		}
	} catch ( _ ) {}
	const depth = getPassTexture( 'depth' );
	if ( depth ) {
		__attachTextureRefsWhere( artifact, depth, ( source ) => source.kind === 'depth.texture' );
		__sharedRewritePassDepthTextureSources( artifact );
	}
	return artifact;
}

function __attachOrderedPassOutputRefs( artifact, passNodes ) {
	if ( ! artifact || ! Array.isArray( passNodes ) || passNodes.length < 2 ) return artifact;
	const ordered = passNodes
		.filter( ( node ) => node && typeof node.getTexture === 'function' )
		.slice()
		.sort( ( a, b ) => ( a.__tslpPassIndex ?? 0 ) - ( b.__tslpPassIndex ?? 0 ) );
	if ( ordered.length < 2 ) return artifact;
	const uuids = [];
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || source.textureName !== 'output' || ! source.textureUuid ) continue;
			if ( source.snapshot ) continue;
			if ( ! uuids.includes( source.textureUuid ) ) uuids.push( source.textureUuid );
		}
	}
	if ( uuids.length < 2 ) return artifact;
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	let changed = false;
	const diag = __harnessDiagnostics();
	const refDiag = [];
	for ( let i = 0; i < uuids.length && i < ordered.length; i ++ ) {
		let texture = null;
		try { texture = ordered[ i ].getTexture( 'output' ); } catch ( _ ) {}
		if ( texture && texture.isTexture === true ) {
			refs.set( uuids[ i ], texture );
			changed = true;
			let objects = 0;
			try { ordered[ i ].scene.traverse( ( object ) => { if ( object && object.isObject3D ) objects ++; } ); } catch ( _ ) {}
			refDiag.push( { uuid: uuids[ i ], passIndex: ordered[ i ].__tslpPassIndex ?? null, objects } );
		}
	}
	if ( refDiag.length > 0 ) diag.orderedPassRefs = refDiag;
	if ( changed ) {
		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );
	}
	return artifact;
}

function __isPassRenderedDepthSource( source ) {
	return !! (
		source &&
		source.textureUuid &&
		(
			source.kind === 'depth.texture' &&
			source.fromMaterialGraph === true &&
			! source.lightUuid &&
			! ( typeof source.lightIndex === 'number' && source.lightIndex >= 0 ) ||
			source.kind === 'artifact.texture' &&
			source.__tslpPassDepthAttached === true
		)
	);
}

function __passDepthSortRank( passNode ) {
	const name = String( passNode && passNode.name || '' ).toLowerCase();
	const scope = String( passNode && passNode.scope || '' ).toLowerCase();
	if ( scope === 'depth' || name.includes( 'depth' ) || name.includes( 'pre pass' ) || name === 'prepass' ) return -1;
	return 0;
}

function __attachOrderedPassDepthRefs( artifact, passNodes ) {
	if ( ! artifact || ! Array.isArray( passNodes ) || passNodes.length === 0 ) return artifact;
	const ordered = passNodes
		.filter( ( node ) => node && typeof node.getTexture === 'function' )
		.slice()
		.sort( ( a, b ) => ( __passDepthSortRank( a ) - __passDepthSortRank( b ) ) || ( ( a.__tslpPassIndex ?? 0 ) - ( b.__tslpPassIndex ?? 0 ) ) );
	if ( ordered.length === 0 ) return artifact;
	const uuids = [];
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( ! __isPassRenderedDepthSource( source ) ) continue;
			if ( ! uuids.includes( source.textureUuid ) ) uuids.push( source.textureUuid );
		}
	}
	if ( uuids.length === 0 ) return artifact;
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	const mappedUuids = new Set();
	const diag = __harnessDiagnostics();
	const refDiag = [];
	for ( let i = 0; i < uuids.length && i < ordered.length; i ++ ) {
		let texture = null;
		try { texture = ordered[ i ].getTexture( 'depth' ); } catch ( _ ) {}
		if ( ! texture || texture.isTexture !== true ) continue;
		refs.set( uuids[ i ], texture );
		mappedUuids.add( uuids[ i ] );
		refDiag.push( {
			uuid: uuids[ i ],
			passIndex: ordered[ i ].__tslpPassIndex ?? null,
			width: texture.image && texture.image.width || null,
			height: texture.image && texture.image.height || null,
		} );
	}
	if ( mappedUuids.size === 0 ) return artifact;
	__sharedRewritePassDepthTextureSources( artifact, mappedUuids );
	if ( refDiag.length > 0 ) diag.orderedPassDepthRefs = refDiag;
	Object.defineProperty( artifact, '_textureRefs', {
		value: refs,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	return artifact;
}

function __attachActivePassTextureRefs( artifact, passNodes ) {
	if ( ! artifact ) return artifact;
	const nodes = Array.isArray( passNodes ) && passNodes.length > 0 ? passNodes : [];
	let wired = __attachOrderedPassOutputRefs( artifact, nodes );
	wired = __attachOrderedPassDepthRefs( wired, nodes );
	if ( nodes.length === 1 ) wired = __attachPassTextureRefs( wired, nodes[ 0 ] );
	return wired;
}

function __wirePassTexturesIntoSceneMaterials( scene, passNodes ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	const nodes = Array.isArray( passNodes ) && passNodes.length > 0 ? passNodes : [];
	if ( nodes.length === 0 ) return;
	scene.traverse( ( object ) => {
		const materials = Array.isArray( object && object.material )
			? object.material
			: object && object.material ? [ object.material ] : [];
		for ( const material of materials ) {
			if ( ! material || ! material.precompiledArtifact ) continue;
			let artifact = __attachActivePassTextureRefs( material.precompiledArtifact, nodes );
			// Context-sensitive consumer variants can capture effect-owned inputs
			// (for example SSS) in addition to ordinary pass color/depth textures.
			// Material-node texture fallback wiring cannot identify those slots and
			// may otherwise replace them with an unrelated albedo/normal texture.
			for ( const passNode of nodes ) {
				if ( passNode && passNode.contextNode ) artifact = __attachGraphTextureRefs( artifact, passNode.contextNode );
			}
			if ( artifact !== material.precompiledArtifact ) material.precompiledArtifact = artifact;
			material.needsUpdate = true;
		}
	} );
}

function __attachRTTTextureRefs( artifact, rttNodes ) {
	if ( ! artifact || ! Array.isArray( rttNodes ) || rttNodes.length === 0 ) return artifact;
	const rtt = rttNodes[ 0 ];
	const rttShape = __rttPrecompiledShape( rtt );
	const artifactShape = artifact.materialShape || artifact.shape || '';
	if ( rttShape === 'render-output' && artifactShape === 'render-output' ) return artifact;
	const texture = rtt && rtt.renderTarget && rtt.renderTarget.texture;
	if ( texture && texture.isTexture === true ) {
		__attachTextureRefsWhere( artifact, texture, ( source ) => source.kind === 'artifact.texture' && ! source.snapshot && ! source.textureName );
	}
	return artifact;
}

function __fullscreenUVVertexShader() {
	return [
		'// tsl-precompile e2e hidden RTT fullscreen vertex',
		'struct VaryingsStruct {',
		'	@location( 0 ) nodeVarying4 : vec2<f32>,',
		'	@builtin( position ) builtinClipSpace : vec4<f32>',
		'};',
		'',
		'@vertex',
		'fn main( @location( 0 ) uv : vec2<f32>,',
		'	@location( 1 ) position : vec3<f32> ) -> VaryingsStruct {',
		'',
		'	var varyings : VaryingsStruct;',
		'	varyings.nodeVarying4 = uv;',
		'	varyings.builtinClipSpace = vec4<f32>( position.xy, 0.0, 1.0 );',
		'	return varyings;',
		'',
		'}'
	].join( '\\n' );
}

function __fullscreenPositionDerivedUVVertexShader() {
	return [
		'// tsl-precompile e2e render-output fullscreen vertex',
		'struct VaryingsStruct {',
		'	@location( 0 ) nodeVarying4 : vec2<f32>,',
		'	@builtin( position ) builtinClipSpace : vec4<f32>',
		'};',
		'',
		'@vertex',
		'fn main( @location( 0 ) position : vec3<f32> ) -> VaryingsStruct {',
		'',
		'	var varyings : VaryingsStruct;',
		'	varyings.nodeVarying4 = ( position.xy * vec2<f32>( 0.5, -0.5 ) ) + vec2<f32>( 0.5, 0.5 );',
		'	varyings.builtinClipSpace = vec4<f32>( position.xy, 0.0, 1.0 );',
		'	return varyings;',
		'',
		'}'
	].join( '\\n' );
}

function __patchRetroRenderOutputBarrelUV( artifact, passNodes ) {
	if ( ! artifact || ! Array.isArray( passNodes ) || passNodes.length !== 1 ) return artifact;
	const passNode = passNodes[ 0 ];
	const passType = passNode && ( passNode.constructor && ( passNode.constructor.type || passNode.constructor.name ) || passNode.type || '' );
	if ( passType !== 'RetroPassNode' || artifact.__tslpRetroBarrelUVPatched === true ) return artifact;
	const fragmentShader = typeof artifact.fragmentShader === 'string' ? artifact.fragmentShader : '';
	if ( ! fragmentShader.includes( 'textureSample( nodeUniform0, nodeUniform0_sampler' ) || ! fragmentShader.includes( 'object.nodeUniform3' ) ) return artifact;
	const sampleCoords = [
		'( fragCoord.xy / object.nodeUniform1 )',
		'( ( fragCoord.xy / object.nodeUniform1 ) - vec2<f32>( nodeVar2, 0.0 ) )',
		'( ( fragCoord.xy / object.nodeUniform1 ) - vec2<f32>( ( nodeVar2 * 2.0 ), 0.0 ) )',
		'( ( fragCoord.xy / object.nodeUniform1 ) - vec2<f32>( ( nodeVar2 * 3.0 ), 0.0 ) )',
	];
	let nextFragment = fragmentShader;
	for ( const coord of sampleCoords ) {
		nextFragment = nextFragment.replace(
			'textureSample( nodeUniform0, nodeUniform0_sampler, ' + coord + ' )',
			'tslp_retroSample( ' + coord + ', object.nodeUniform3 )'
		);
	}
	if ( nextFragment === fragmentShader ) return artifact;
	const helper = [
		'fn tslp_retroBarrelUV( coord : vec2<f32>, curvature : f32 ) -> vec2<f32> {',
		'	let centered = ( coord - vec2<f32>( 0.5 ) ) * vec2<f32>( 2.0 );',
		'	let distortion = 1.0 - ( dot( centered, centered ) * curvature );',
		'	let cornerDistortion = 1.0 - ( curvature * 2.0 );',
		'	return ( ( ( centered / vec2<f32>( distortion ) ) * vec2<f32>( cornerDistortion ) ) * vec2<f32>( 0.5 ) ) + vec2<f32>( 0.5 );',
		'}',
		'fn tslp_retroTexelFromCoord( coord : vec2<f32>, curvature : f32 ) -> vec4<f32> {',
		'	let dims = textureDimensions( nodeUniform0, u32( 0 ) );',
		'	let retroUV = clamp( tslp_retroBarrelUV( coord, curvature ), vec2<f32>( 0.0 ), vec2<f32>( 1.0 ) );',
		'	let texel = vec2<u32>( clamp( floor( retroUV * vec2<f32>( dims ) ), vec2<f32>( 0.0 ), vec2<f32>( dims - vec2<u32>( 1, 1 ) ) ) );',
		'	return textureLoad( nodeUniform0, texel, u32( 0 ) );',
		'}',
		'fn tslp_retroTexelAt( pixel : vec2<f32>, curvature : f32 ) -> vec4<f32> {',
		'	let hiddenSize = object.nodeUniform1;',
		'	let clampedPixel = clamp( pixel, vec2<f32>( 0.0 ), hiddenSize - vec2<f32>( 1.0 ) );',
		'	return tslp_retroTexelFromCoord( ( clampedPixel + vec2<f32>( 0.5 ) ) / hiddenSize, curvature );',
		'}',
		'fn tslp_retroSample( coord : vec2<f32>, curvature : f32 ) -> vec4<f32> {',
		'	let hiddenSize = object.nodeUniform1;',
		'	let samplePos = ( coord * hiddenSize ) - vec2<f32>( 0.5 );',
		'	let basePixel = floor( samplePos );',
		'	let weight = fract( samplePos );',
		'	let c00 = tslp_retroTexelAt( basePixel, curvature );',
		'	let c10 = tslp_retroTexelAt( basePixel + vec2<f32>( 1.0, 0.0 ), curvature );',
		'	let c01 = tslp_retroTexelAt( basePixel + vec2<f32>( 0.0, 1.0 ), curvature );',
		'	let c11 = tslp_retroTexelAt( basePixel + vec2<f32>( 1.0, 1.0 ), curvature );',
		'	return mix( mix( c00, c10, weight.x ), mix( c01, c11, weight.x ), weight.y );',
		'}',
		''
	].join( '\\n' );
	nextFragment = nextFragment.replace( /(@fragment\\n)/, helper + '$1' );
	const patched = __cloneAuxArtifact( artifact );
	patched.fragmentShader = nextFragment;
	try {
		Object.defineProperty( patched, '__tslpRetroBarrelUVPatched', {
			value: true,
			configurable: true,
			writable: true,
		} );
	} catch ( _ ) {
		patched.__tslpRetroBarrelUVPatched = true;
	}
	try {
		const fxDiag = __frameEffectDiagnostics();
		fxDiag.retroBarrelUVPatched = ( fxDiag.retroBarrelUVPatched || 0 ) + 1;
	} catch ( _ ) {}
	return patched;
}

function __patchVolumeRenderOutputAlpha( artifact, options = {} ) {
	if ( ! artifact || artifact.__tslpVolumeOutputAlphaPatched === true ) return artifact;
	if ( typeof __state.example !== 'string' || ! __state.example.startsWith( 'webgpu_volume_' ) ) return artifact;
	const shape = artifact.materialShape || artifact.shape || '';
	if ( shape !== 'render-output' ) return artifact;
	if ( options.fullscreenVertex !== true ) return artifact;
	const fragmentShader = typeof artifact.fragmentShader === 'string' ? artifact.fragmentShader : '';
	const volumeCompositeLine = 'nodeVar4 = ( nodeVar1 + ( nodeVar3 * vec4<f32>( object.nodeUniform2 ) ) );';
	const hasVolumeComposite = fragmentShader.includes( volumeCompositeLine );
	if ( options.outputColorTransform === true && ! hasVolumeComposite ) return artifact;
	const nextFragment = options.outputColorTransform === true
		? fragmentShader.replace(
			volumeCompositeLine,
			'nodeVar4 = ( nodeVar1 + ( nodeVar3 * vec4<f32>( object.nodeUniform2 * 0.02 ) ) );'
		)
		: fragmentShader;
	const patched = __cloneAuxArtifact( artifact );
	patched.fragmentShader = nextFragment;
	patched.vertexShader = __fullscreenPositionDerivedUVVertexShader();
	patched.attributes = [
		{ name: 'position', type: 'vec3', source: 'geometry' },
	];
	try {
		Object.defineProperty( patched, '__tslpVolumeOutputAlphaPatched', {
			value: true,
			configurable: true,
			writable: true,
		} );
	} catch ( _ ) {
		patched.__tslpVolumeOutputAlphaPatched = true;
	}
	try {
		const fxDiag = __frameEffectDiagnostics();
		fxDiag.volumeOutputAlphaPatched = ( fxDiag.volumeOutputAlphaPatched || 0 ) + 1;
	} catch ( _ ) {}
	return patched;
}

function __preparePassNodeForReplay( renderer, passNode ) {
	if ( ! renderer || ! passNode || ! passNode.renderTarget ) return;
	try {
		// Mirror r185 PassNode.setup(): an omitted pass override inherits the
		// renderer's sample count. Captured post-process WGSL therefore expects
		// the same multisampled depth shape during compiler-free replay.
		passNode.renderTarget.samples = passNode.options && passNode.options.samples !== undefined
			? passNode.options.samples
			: renderer.samples;
		if ( passNode.renderTarget.texture && typeof renderer.getOutputBufferType === 'function' ) {
			passNode.renderTarget.texture.type = renderer.getOutputBufferType();
		}
		if ( renderer.reversedDepthBuffer === true && passNode.renderTarget.depthTexture ) {
			passNode.renderTarget.depthTexture.type = Slim.FloatType || passNode.renderTarget.depthTexture.type;
		}
	} catch ( _ ) {}
}

const __wiredPCMaterials = new WeakSet();

function __classNameFromArtifactName( name ) {
	if ( typeof name !== 'string' ) return '';
	const parts = name.split( ':' );
	return parts.length >= 3 ? parts[ 1 ] : '';
}

function __artifactRequiresSkinning( artifact ) {
	return ( Array.isArray( artifact && artifact.attributes ) ? artifact.attributes : [] )
		.some( ( entry ) => entry && ( entry.name === 'skinIndex' || entry.name === 'skinWeight' ) );
}

function __objectHasSkinning( object ) {
	const attrs = object && object.geometry && object.geometry.attributes || {};
	return !! ( object && ( object.isSkinnedMesh === true || attrs.skinIndex || attrs.skinWeight ) );
}

function __precompiledArtifactMatchesObject( artifact, object, opts = {} ) {
	if ( object && __artifactRequiresSkinning( artifact ) !== __objectHasSkinning( object ) ) return false;
	const ignoreTransform = opts && opts.ignoreTransform === true;
	const artifactObject = __artifactSourceObject( artifact );
	if ( ! ignoreTransform && artifactObject && Array.isArray( artifactObject.position ) && object && object.position ) {
		const delta = Math.abs( ( artifactObject.position[ 0 ] || 0 ) - object.position.x )
			+ Math.abs( ( artifactObject.position[ 1 ] || 0 ) - object.position.y )
			+ Math.abs( ( artifactObject.position[ 2 ] || 0 ) - object.position.z );
		if ( delta > 1e-5 ) return false;
	}
	const artifactHasInstancedShape = __artifactHasInstancedShape( artifact );
	if ( ! object ) return ! artifactHasInstancedShape;
	const count = __objectDrawCount( object );
	const shaderInstancedMesh = object.isMesh === true && count > 1;
	if ( object.isInstancedMesh !== true ) {
		if ( ! shaderInstancedMesh ) return object.isBatchedMesh === true || ! artifactHasInstancedShape;
		const artifactCount = __artifactInstancedDrawCount( artifact );
		if ( artifactCount ) return artifactCount === count;
		if ( artifactObject && artifactObject.count ) return artifactObject.count === count;
		return artifactHasInstancedShape;
	}
	if ( artifactObject && artifactObject.isInstancedMesh === false ) return false;
	if ( ! count ) return artifactObject && artifactObject.isInstancedMesh === true || artifactHasInstancedShape;
	const artifactCount = __artifactInstancedDrawCount( artifact );
	if ( artifactCount ) return artifactCount === count;
	if ( artifactObject && artifactObject.isInstancedMesh === true ) return true;
	return false;
}

function __precompiledArtifactMatchesSource( artifact, sourceMaterial, object ) {
	const materialUuidMatches = __artifactMatchesSourceMaterialUuid( artifact, sourceMaterial );
	if ( ! materialUuidMatches && ! __precompiledArtifactMatchesObject( artifact, object ) ) return false;
	const artifactObject = __artifactSourceObject( artifact );
	if ( artifactObject && ! object && ! materialUuidMatches ) return false;
	const artifactProps = __artifactNodePropNames( artifact );
	if ( artifactProps ) {
		const sourceProps = __sourceNodePropNames( sourceMaterial );
		if ( sourceProps.length !== artifactProps.length ) return false;
		const artifactSet = new Set( artifactProps );
		for ( const key of sourceProps ) {
			if ( ! artifactSet.has( key ) ) return false;
		}
	}
	if ( sourceMaterial && artifact && artifact.renderState && typeof sourceMaterial.transparent === 'boolean' && typeof artifact.renderState.transparent === 'boolean' && sourceMaterial.transparent !== artifact.renderState.transparent ) return false;
	if ( sourceMaterial ) {
		const artifactName = __artifactMaterialName( artifact );
		const sourceName = typeof sourceMaterial.name === 'string' ? sourceMaterial.name : '';
		if ( artifactName && sourceName && artifactName !== sourceName ) return false;
	}
	for ( const property of [ 'color', 'emissive' ] ) {
		const sourceColor = __readColorTriplet( sourceMaterial && sourceMaterial[ property ] );
		const artifactColor = property === 'color' ? __artifactColorTriplet( artifact ) : __artifactMaterialColorTriplet( artifact, property );
		if ( sourceColor && artifactColor && __colorDistanceSq( sourceColor, artifactColor ) > 0.05 ) return false;
	}
	return true;
}

function __retargetPrecompiledMaterialForObject( material, object ) {
	if ( ! material || ! material.isPrecompiledMaterial ) return material;
	if ( material.__tslpRetroPassReplacement === true ) return material;
	const sourceMaterial = material.__tslpSourceMaterial || material;
	if ( material.__tslpSourceMaterial && (
		__artifactMatchesSourceMaterialUuid( material.precompiledArtifact, sourceMaterial )
		|| __precompiledArtifactMatchesObject( material.precompiledArtifact, object, { ignoreTransform: true } )
	) ) return material;
	if ( __precompiledArtifactMatchesSource( material.precompiledArtifact, sourceMaterial, object ) ) return material;

	const oldName = material.name || '';
	const className = __classNameFromArtifactName( oldName ) || 'MeshStandardNodeMaterial';
	if ( oldName ) __usedArtifactNames.delete( oldName );
	let replacement = null;
	try {
		replacement = __takeMaterial( className, sourceMaterial, object, { allowUsed: true } );
	} catch ( _ ) {
		if ( oldName ) __usedArtifactNames.add( oldName );
		return material;
	}
	if ( ! replacement || replacement === material ) {
		if ( oldName ) __usedArtifactNames.add( oldName );
		return material;
	}
	__copyMaterialProps( sourceMaterial || material, replacement );
	__copyMaterialNodeProps( sourceMaterial, replacement );
	__wireMaterialTextures( sourceMaterial, replacement );
	if ( sourceMaterial && sourceMaterial !== replacement ) {
		try { Object.defineProperty( replacement, '__tslpSourceMaterial', { value: sourceMaterial, configurable: true, writable: true } ); } catch ( _ ) {}
	}
	if ( __wireMaterialPropertyTexturesFromArtifact( replacement ) ) __markMaterialTextureRewire( replacement );
	return replacement;
}

	function __precompiledOutputCount( materialOrArtifact ) {
		const artifact = materialOrArtifact && materialOrArtifact.precompiledArtifact || materialOrArtifact;
		return __fragmentOutputCount( { precompiledArtifact: artifact } );
	}

	function __precompiledOwnOutputCount( materialOrArtifact ) {
		const artifact = materialOrArtifact && materialOrArtifact.precompiledArtifact || materialOrArtifact;
		if ( ! artifact ) return 1;
		return __countArtifactFragmentOutputsSafe( { ...artifact, variants: undefined }, 1 );
	}

	function __passMRTTopology( passNode ) {
		if ( ! passNode ) return null;
		return passNode._mrt ? 'mrt' : 'color';
	}

	function __artifactPassMRTTopology( artifact ) {
		const selectors = artifact && artifact.renderContextSelectors;
		if ( ! Array.isArray( selectors ) || selectors.length === 0 ) return null;
		const topologies = new Set();
		for ( const value of selectors ) {
			let selector = value;
			if ( typeof selector === 'string' ) {
				try { selector = JSON.parse( selector ); } catch ( _ ) { return 'ambiguous'; }
			}
			if ( ! selector || typeof selector !== 'object' || ! Object.prototype.hasOwnProperty.call( selector, 'mrt' ) ) return 'ambiguous';
			topologies.add( selector.mrt == null ? 'color' : 'mrt' );
		}
		return topologies.size === 1 ? topologies.values().next().value : 'ambiguous';
	}

	function __artifactMatchesPassMRTTopology( artifact, passNode ) {
		const requested = __passMRTTopology( passNode );
		if ( requested === null ) return true;
		const captured = __artifactPassMRTTopology( artifact );
		// Unsigned legacy artifacts retain output-count compatibility. A signed
		// selector must match the live pass topology exactly.
		return captured === null || captured === requested;
	}

	function __artifactOwnSupportsPassTarget( artifact, targetCount, passNode ) {
		const outputCount = __precompiledOwnOutputCount( artifact );
		const outputMatches = targetCount > 1 ? outputCount >= targetCount : outputCount === 1;
		return outputMatches && __artifactMatchesPassMRTTopology( artifact, passNode );
	}

	function __artifactVariantView( artifact, variant ) {
		if ( ! artifact || ! variant ) return artifact || variant;
		const merged = Object.assign( Object.create( Object.getPrototypeOf( artifact ) || null ), artifact, variant );
		for ( const sidecar of [ '_textureRefs', '_liveUpdateNodes', '_liveUpdateBeforeNodes', '_liveUpdateAfterNodes', '_generatedUpdateGroup', '_unsupportedKinds', '_textureResolutionStrategies' ] ) {
			Object.defineProperty( merged, sidecar, {
				get() { return artifact[ sidecar ]; },
				set( value ) {
					Object.defineProperty( artifact, sidecar, {
						value,
						enumerable: false,
						configurable: true,
						writable: true,
					} );
				},
				enumerable: false,
				configurable: true,
			} );
		}
		return __materializeArtifactVariantSelectorAdapters( merged );
	}

	function __selectArtifactForPassTarget( artifact, targetCount, passNode = null ) {
		if ( ! artifact ) return artifact;
		if ( __artifactOwnSupportsPassTarget( artifact, targetCount, passNode ) ) return artifact;
		const variants = artifact.variants && typeof artifact.variants === 'object' ? artifact.variants : null;
		if ( ! variants ) return artifact;
		for ( const variant of Object.values( variants ) ) {
			if ( __artifactOwnSupportsPassTarget( variant, targetCount, passNode ) ) {
				return __artifactVariantView( artifact, variant );
			}
		}
		return artifact;
	}

	function __artifactSupportsPassTarget( artifact, targetCount, passNode = null ) {
		const selected = __selectArtifactForPassTarget( artifact, targetCount, passNode );
		return __artifactOwnSupportsPassTarget( selected, targetCount, passNode );
	}

	function __artifactSourceClassNameForPassTarget( artifact ) {
		const sourceType = artifact && artifact.sourceMaterial && artifact.sourceMaterial.type;
		if ( typeof sourceType !== 'string' || sourceType === '' ) return '';
		return __classNameForMaterial( { type: sourceType } );
	}

	function __artifactMatchesPassMaterialClass( key, artifact, className ) {
		const namedClassName = __classNameFromArtifactName( key );
		const sourceClassName = __artifactSourceClassNameForPassTarget( artifact );
		if ( namedClassName !== className && sourceClassName !== className ) return false;
		const requestedFamily = __materialFamilyFromClassName( className );
		const artifactFamily = __materialFamilyFromClassName( sourceClassName || namedClassName );
		return ! requestedFamily || ! artifactFamily || requestedFamily === artifactFamily;
	}

	function __findBestArtifactForPassTarget( className, sourceMaterial, object, targetCount, passNode = null ) {
		const keys = Object.keys( __data.user || {} );
		let bestName = null;
		let bestScore = -Infinity;
		for ( const key of keys ) {
			const mod = __data.user && __data.user[ key ];
			const artifact = mod && mod.artifact;
			if ( ! artifact ) continue;
			if ( ! __artifactMatchesPassMaterialClass( key, artifact, className ) ) continue;
			if ( ! __artifactSupportsPassTarget( artifact, targetCount, passNode ) ) continue;
			const score = __scoreArtifactForSource( key, mod, className, sourceMaterial, object );
			if ( score > bestScore ) {
				bestScore = score;
				bestName = key;
			}
		}
		return bestScore >= 55 ? bestName : null;
	}

	function __makePassTargetMaterial( name, sourceMaterial, currentMaterial, object, targetCount = 1, passNode = null ) {
		const mod = __data.user && __data.user[ name ];
		if ( ! ( mod && mod.artifact ) ) return null;
		const className = __classNameFromArtifactName( name ) || __classNameForMaterial( sourceMaterial || currentMaterial );
		if ( mod.__hash && ! mod.artifact.__hash ) Object.defineProperty( mod.artifact, '__hash', { value: mod.__hash, enumerable: false, configurable: true } );
		__attachGeneratedUpdatersFromModule( mod.artifact, mod );
		__wireComputeAttrsToArtifact( mod.artifact, sourceMaterial || currentMaterial );
		__ensureArtifactTextureFallbacks( mod.artifact );
		const artifact = __selectArtifactForPassTarget( mod.artifact, targetCount, passNode );
		if ( ! __artifactOwnSupportsPassTarget( artifact, targetCount, passNode ) ) return null;
		const replacement = new Slim.PrecompiledMaterial( artifact );
		replacement.name = name;
		__stampPrecompiledMaterialClassFlags( replacement, className );
		__attachReflectorBaseNodesForArtifact( replacement, artifact, object );
		__seedNodeProps( replacement );
		if ( object ) {
			try { Object.defineProperty( replacement, '__tslpPrecompileObject', { value: object, configurable: true } ); } catch ( _ ) {}
		}
	if ( sourceMaterial ) {
		try { Object.defineProperty( replacement, '__tslpSourceMaterial', { value: sourceMaterial, configurable: true, writable: true } ); } catch ( _ ) {}
	}
	__copyMaterialProps( sourceMaterial || currentMaterial, replacement );
	__copyMaterialNodeProps( sourceMaterial || currentMaterial, replacement );
	__wireMaterialTextures( sourceMaterial || currentMaterial, replacement );
	__wireMaterialTextures( currentMaterial, replacement );
	if ( __wireMaterialPropertyTexturesFromArtifact( replacement ) ) __markMaterialTextureRewire( replacement );
	return replacement;
}

	function __retargetPrecompiledMaterialForPassTarget( material, object, targetCount, passNode = null ) {
		if ( ! ( material && material.isPrecompiledMaterial === true ) ) return material;
		const currentArtifact = material.precompiledArtifact;
		const selectedCurrent = __selectArtifactForPassTarget( currentArtifact, targetCount, passNode );
		if ( selectedCurrent === currentArtifact && __artifactOwnSupportsPassTarget( currentArtifact, targetCount, passNode ) ) return material;
		const sourceMaterial = material.__tslpSourceMaterial || material;
		const className = __classNameFromArtifactName( material.name || '' ) || __classNameForMaterial( sourceMaterial );
		const currentMod = __data.user && __data.user[ material.name || '' ];
		const currentSupportsTarget = !! ( currentMod && __artifactSupportsPassTarget( currentMod.artifact, targetCount, passNode ) );
		const name = currentSupportsTarget
			? material.name
			: __findBestArtifactForPassTarget( className, sourceMaterial, object, targetCount, passNode );
		if ( ! name ) return material;
		return __makePassTargetMaterial( name, sourceMaterial, material, object, targetCount, passNode ) || material;
	}

function __retargetSceneMaterialsForPassTarget( scene, targetCount, passNode = null ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	scene.traverse( ( object ) => {
		const material = object && object.material;
		if ( ! material ) return;
		const retargetOne = ( mat ) => __passRendersMaterial( passNode, mat )
			? __retargetPrecompiledMaterialForPassTarget( mat, object, targetCount, passNode )
			: mat;
		object.material = Array.isArray( material ) ? material.map( retargetOne ) : retargetOne( material );
	} );
}

function __artifactLooksLikeRetroPassMaterial( artifact ) {
	return __sharedArtifactLooksLikeRetroPassMaterial( artifact );
}

function __findRetroPassArtifactName( className, sourceObject ) {
	const keys = Object.keys( __data.user || {} );
	const pick = ( candidates ) => {
		let bestName = null;
		let bestScore = -Infinity;
		for ( const key of candidates ) {
			const mod = __data.user && __data.user[ key ];
			const artifact = mod && mod.artifact;
			if ( ! artifact || ! __artifactLooksLikeRetroPassMaterial( artifact ) ) continue;
			if ( ! __precompiledArtifactMatchesObject( artifact, sourceObject ) ) continue;
			const artifactClassName = __classNameFromArtifactName( key );
			if ( ! /^Mesh[A-Za-z0-9]*NodeMaterial$/.test( artifactClassName ) ) continue;
			let score = artifactClassName === className ? 200 : 80;
			score += __objectMetadataScore( artifact, sourceObject );
			const props = artifact.sourceMaterial && Array.isArray( artifact.sourceMaterial.nodeProps ) ? artifact.sourceMaterial.nodeProps : [];
			if ( props.includes( 'vertexNode' ) ) score += 140;
			if ( props.includes( 'contextNode' ) ) score += 80;
			if ( score > bestScore ) {
				bestScore = score;
				bestName = key;
			}
		}
		return bestScore >= 120 ? bestName : null;
	};
	return pick( keys.filter( ( key ) => ! __usedArtifactNames.has( key ) ) ) || pick( keys );
}

function __wireMaterialPropertyTexturesOnly( sourceMaterial, replacement ) {
	if ( ! sourceMaterial || ! replacement || ! replacement.precompiledArtifact ) return;
	const artifact = replacement.precompiledArtifact;
	__ensureArtifactTextureFallbacks( artifact );
	for ( const key of __TEXTURE_PROPS ) {
		const tex = sourceMaterial[ key ];
		if ( tex && tex.isTexture === true ) {
			const matched = __attachArtifactTextureRefsWhere( artifact, tex, ( source ) => ! __isPMREMArtifactTextureSource( source ) && __textureMatchesArtifactSource( tex, source ) );
			if ( ! matched && __countArtifactTextureSources( artifact, ( source ) => ! __isPMREMArtifactTextureSource( source ) ) <= 1 ) {
				__attachArtifactTextureRefsWhere( artifact, tex, ( source ) => ! __isPMREMArtifactTextureSource( source ) );
			}
		}
	}
}

function __replaceRetroPassMaterialForReplay( sourceMaterial, sourceObject ) {
	if ( __seenMaterials.has( sourceMaterial ) ) {
		const cached = __seenMaterials.get( sourceMaterial );
		__copyMaterialProps( sourceMaterial, cached );
		__wireMaterialPropertyTexturesOnly( sourceMaterial, cached );
		if ( __wireMaterialPropertyTexturesFromArtifact( cached ) ) __markMaterialTextureRewire( cached );
		return cached;
	}
	const requestedClassName = __classNameForMaterial( sourceMaterial );
	const name = __findRetroPassArtifactName( requestedClassName, sourceObject );
	if ( ! name ) return null;
	const mod = __data.user && __data.user[ name ];
	if ( ! ( mod && mod.artifact ) ) return null;
	const className = __classNameFromArtifactName( name ) || requestedClassName;
	__usedArtifactNames.add( name );
	if ( mod.__hash && ! mod.artifact.__hash ) Object.defineProperty( mod.artifact, '__hash', { value: mod.__hash, enumerable: false, configurable: true } );
	__attachGeneratedUpdatersFromModule( mod.artifact, mod );
	__ensureArtifactTextureFallbacks( mod.artifact );
	const replacement = new Slim.PrecompiledMaterial( mod.artifact );
	replacement.name = name;
	__stampPrecompiledMaterialClassFlags( replacement, className );
	if ( sourceObject ) {
		try { Object.defineProperty( replacement, '__tslpPrecompileObject', { value: sourceObject, configurable: true } ); } catch ( _ ) {}
	}
	try { Object.defineProperty( replacement, '__tslpSourceMaterial', { value: sourceMaterial, configurable: true, writable: true } ); } catch ( _ ) {}
	__copyMaterialProps( sourceMaterial, replacement );
	__wireMaterialPropertyTexturesOnly( sourceMaterial, replacement );
	if ( __wireMaterialPropertyTexturesFromArtifact( replacement ) ) __markMaterialTextureRewire( replacement );
	__seenMaterials.set( sourceMaterial, replacement );
	return replacement;
}

function __makeRetroPassSceneReplacement( material, object ) {
	if ( ! material || ! object ) return null;
	const sourceMaterial = material.__tslpSourceMaterial || material;
	const requestedClassName = __classNameForMaterial( sourceMaterial );
	const name = __findRetroPassArtifactName( requestedClassName, object );
	if ( ! name ) return null;
	const mod = __data.user && __data.user[ name ];
	if ( ! ( mod && mod.artifact ) ) return null;
	const className = __classNameFromArtifactName( name ) || requestedClassName;
	if ( mod.__hash && ! mod.artifact.__hash ) Object.defineProperty( mod.artifact, '__hash', { value: mod.__hash, enumerable: false, configurable: true } );
	__attachGeneratedUpdatersFromModule( mod.artifact, mod );
	__ensureArtifactTextureFallbacks( mod.artifact );
	const replacement = new Slim.PrecompiledMaterial( mod.artifact );
	replacement.name = name;
	__stampPrecompiledMaterialClassFlags( replacement, className );
	replacement.__tslpRetroPassReplacement = true;
	try { Object.defineProperty( replacement, '__tslpPrecompileObject', { value: object, configurable: true } ); } catch ( _ ) {}
	try { Object.defineProperty( replacement, '__tslpSourceMaterial', { value: sourceMaterial, configurable: true, writable: true } ); } catch ( _ ) {}
	__copyMaterialProps( material, replacement );
	__copyMaterialProps( sourceMaterial, replacement );
	// RetroPassNode owns these topology flags. Copying the ordinary scene
	// material above must not select its flat, unlit sibling artifact.
	replacement.flatShading = false;
	replacement.lights = true;
	__wireMaterialPropertyTexturesOnly( sourceMaterial, replacement );
	__wireMaterialPropertyTexturesOnly( material, replacement );
	if ( __wireMaterialPropertyTexturesFromArtifact( replacement ) ) __markMaterialTextureRewire( replacement );
	try {
		const retroDiag = __retroPassDiagnostics();
		retroDiag.sceneSwaps = ( retroDiag.sceneSwaps | 0 ) + 1;
		__recordRetroPassValue( retroDiag.names, name );
		const pos = object && object.position && object.position.toArray ? object.position.toArray().map( ( value ) => Math.round( value * 1000 ) / 1000 ).join( ',' ) : '';
		__recordRetroPassValue( retroDiag.swapObjects || ( retroDiag.swapObjects = [] ), ( object && object.name || object && object.type || 'object' ) + '@' + pos + '->' + name, 24 );
	} catch ( _ ) {}
	return replacement;
}

function __withRetroPassSceneReplacements( scene, callback ) {
	const swaps = [];
	try {
		if ( scene && typeof scene.traverse === 'function' ) {
			scene.traverse( ( object ) => {
				const material = object && object.material;
				if ( ! material ) return;
				const replaceOne = ( mat ) => __makeRetroPassSceneReplacement( mat, object ) || mat;
				if ( Array.isArray( material ) ) {
					const next = material.map( replaceOne );
					if ( next.some( ( mat, index ) => mat !== material[ index ] ) ) {
						swaps.push( { object, material } );
						object.material = next;
					}
				} else {
					const next = replaceOne( material );
					if ( next !== material ) {
						swaps.push( { object, material } );
						object.material = next;
					}
				}
			} );
		}
		return callback();
	} finally {
		for ( let i = swaps.length - 1; i >= 0; i -- ) swaps[ i ].object.material = swaps[ i ].material;
	}
}

function __retroPassDiagnostics() {
	const diag = __harnessDiagnostics();
	return diag.retroPass || ( diag.retroPass = {
		generated: 0,
		replaced: 0,
		missed: 0,
		classes: [],
		names: [],
		passTypes: [],
	} );
}

function __recordRetroPassValue( list, value, limit = 16 ) {
	if ( ! Array.isArray( list ) || ! value || list.includes( value ) || list.length >= limit ) return;
	list.push( value );
}

function __prepareSceneForCurrentMRT( scene, renderer ) {
	if ( ! renderer || typeof renderer.getMRT !== 'function' ) return null;
	const passNode = renderer.__tslpActiveReplayPassNode || null;
	let mrt = renderer.getMRT();
	if ( ! mrt && typeof renderer.getRenderTarget === 'function' ) {
		try { mrt = __mrtFromRenderTarget( renderer.getRenderTarget() ); } catch ( _ ) { mrt = null; }
	}
	const targetCount = __mrtOutputCount( mrt );
	if ( targetCount <= 1 ) {
		__retargetSceneMaterialsForPassTarget( scene, 1, passNode );
		return null;
	}
	__retargetSceneMaterialsForPassTarget( scene, targetCount, passNode );
	if ( ! __sceneCanRenderMRT( scene, mrt, passNode ) ) {
		__retargetSceneMaterialsForPassTarget( scene, 1, passNode );
		return null;
	}
	__prepareSceneMaterialsForMRTReplay( scene, mrt, passNode );
	return mrt;
}

function __replayMaterialContextKey( material, object, renderer = null ) {

	return __createMaterialContextKey( __createRenderObjectContextSelector, {
		material,
		object,
		renderer,
	}, __projectRenderObjectContextSelector );

}

function __replaySceneForObject( object ) {

	let current = object || null;
	while ( current ) {

		if ( current.isScene === true ) return current;
		current = current.parent || null;

	}
	return null;

}

function __replaceMaterialForReplay( inputMaterial, object = null, force = false, renderer = null ) {
	let m = inputMaterial;
	if ( ! m ) return m;
	// A shared Scene can be rendered by multiple renderers whose shader topology
	// differs (normal, logarithmic depth, reversed depth, precision, backend).
	// The first pass has already installed a PrecompiledMaterial on the object,
	// so recover its authored source and resolve the renderer-keyed replacement
	// before treating that first replacement as globally reusable.
	if ( m.isPrecompiledMaterial ) {
		const sourceMaterial = m.__tslpSourceMaterial;
		if ( sourceMaterial && sourceMaterial !== m && renderer ) {
			const sourceContextKey = __replayMaterialContextKey( sourceMaterial, object, renderer );
			const sourceContexts = __getMaterialContextMap( __seenMaterialContexts, sourceMaterial, true );
			m = sourceContexts.get( sourceContextKey ) || sourceMaterial;
		}
	}
	// Materials intercepted at constructor time come back as PrecompiledMaterial
	// directly. Wire live compute attributes (positionNode, colorNode...) into
	// the artifact plan entries now — before hydrateNodeBuilderState is first
	// called in the upcoming super.render.
	if ( m.isPrecompiledMaterial ) {
		m = __retargetPrecompiledMaterialForObject( m, object );
		// The generated replay constructors deliberately keep the author's full
		// material alive until its first render, then swap a PrecompiledMaterial
		// onto the mesh. Mirror subsequent author-side mutations before every draw
		// so toggles such as material.visible around CubeCamera.update() still
		// govern the live render material.
		const sourceMaterial = m && m.__tslpSourceMaterial;
		if ( sourceMaterial && sourceMaterial !== m ) {
			__copyMaterialProps( sourceMaterial, m );
			__copyMaterialNodeProps( sourceMaterial, m );
			__wireMaterialTextures( sourceMaterial, m );
		}
		if ( object ) {
			try { Object.defineProperty( m, '__tslpPrecompileObject', { value: object, configurable: true } ); } catch ( _ ) {}
		}
		if ( __wireObjectMorphTexture( m, object ) ) __markMaterialTextureRewire( m );
		if ( __wireMaterialPropertyTexturesFromArtifact( m ) ) __markMaterialTextureRewire( m );
		if ( m.precompiledArtifact && ! __wiredPCMaterials.has( m ) ) {
			__wireComputeAttrsToArtifact( m.precompiledArtifact, m );
			__wireMaterialNodeTextures( m, m );
			__wiredPCMaterials.add( m );
		}
		return m;
	}
	if ( ! force && m.visible === false ) return m;
	const contextKey = __replayMaterialContextKey( m, object, renderer );
	const seenContexts = __getMaterialContextMap( __seenMaterialContexts, m, true );
	if ( seenContexts.has( contextKey ) ) {
		const replacement = seenContexts.get( contextKey );
		__copyMaterialProps( m, replacement );
		__copyMaterialNodeProps( m, replacement );
		__wireMaterialNodeTextures( m, replacement );
		__wireMaterialTextures( m, replacement );
		if ( __wireObjectMorphTexture( replacement, object ) ) __markMaterialTextureRewire( replacement );
		if ( __wireMaterialPropertyTexturesFromArtifact( replacement ) ) __markMaterialTextureRewire( replacement );
			return replacement;
			}
			const className = __classNameForMaterial( m );
			const sourceScene = __replaySceneForObject( object );
			const topologyKey = __createStockMaterialTopologyKey( {
				material: m,
				object,
				className,
				contextKey,
				nodeKeys: __NODE_GRAPH_KEYS,
				textureProps: __TEXTURE_PROPS,
				getObjectIdentity: __replayTopologyIdentity,
			} );
			const topologyArtifacts = topologyKey && sourceScene
				? __getSceneTopologyMap( __replayTopologyArtifactsByScene, sourceScene, true )
				: null;
			const preferredName = topologyArtifacts && topologyArtifacts.get( topologyKey ) || '';
			const replacement = __takeMaterial( className, m, object, preferredName ? { allowUsed: true, preferredName } : {} );
			if ( topologyArtifacts && ! preferredName ) topologyArtifacts.set( topologyKey, replacement.name );
		if ( object ) {
		try { Object.defineProperty( replacement, '__tslpPrecompileObject', { value: object, configurable: true } ); } catch ( _ ) {}
	}
	__copyMaterialProps( m, replacement );
	__copyMaterialNodeProps( m, replacement );
	__wireMaterialNodeTextures( m, replacement );
	__wireMaterialTextures( m, replacement );
	if ( __wireObjectMorphTexture( replacement, object ) ) __markMaterialTextureRewire( replacement );
	try { Object.defineProperty( replacement, '__tslpSourceMaterial', { value: m, configurable: true, writable: true } ); } catch ( _ ) {}
	if ( __wireMaterialPropertyTexturesFromArtifact( replacement ) ) __markMaterialTextureRewire( replacement );
	seenContexts.set( contextKey, replacement );
	return replacement;
}

function __replaceSceneOverrideMaterial( scene, renderer = null ) {
	if ( ! scene || ! scene.overrideMaterial ) return;
	scene.overrideMaterial = __replaceMaterialForReplay( scene.overrideMaterial, null, true, renderer );
}

function __replaceSceneMaterials( scene, renderer = null ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	const objects = [];
	scene.traverse( ( object ) => {
		if ( object && object.material ) objects.push( object );
	} );
		objects.sort( ( a, b ) => __replacePriority( b ) - __replacePriority( a ) );
		for ( const object of objects ) {
			const material = object && object.material;
			if ( ! material ) continue;
		const replaceOne = ( inputMaterial ) => __replaceMaterialForReplay( inputMaterial, object, false, renderer );
		object.material = Array.isArray( material ) ? material.map( replaceOne ) : replaceOne( material );
	}
}

function __replaceStandaloneRenderTargetMaterial( target, renderer = null ) {
	if ( ! target || target.isScene === true || ! target.material ) return;
	const replaceOne = ( inputMaterial ) => {
		if ( ! inputMaterial || inputMaterial.isPrecompiledMaterial === true ) return inputMaterial;
		if ( __classNameForMaterial( inputMaterial ) === 'NodeMaterial' && target.name !== 'Render Pipeline' && target.isQuadMesh !== true ) return inputMaterial;
		return __replaceMaterialForReplay( inputMaterial, target, true, renderer );
	};
	target.material = Array.isArray( target.material ) ? target.material.map( replaceOne ) : replaceOne( target.material );
}

function __recordReplayMaterialSnapshot( scene, phase = 'prepare' ) {
	if ( ! ( window.__TSLP_DEBUG_SHADOW_BINDINGS === true ) || ! scene || typeof scene.traverse !== 'function' ) return;
	try {
		const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
		const list = diag.replayMaterials || ( diag.replayMaterials = [] );
		if ( list.length >= 240 ) return;
		scene.traverse( ( object ) => {
			if ( list.length >= 240 ) return;
			const materials = object && object.material ? ( Array.isArray( object.material ) ? object.material : [ object.material ] ) : [];
			for ( const material of materials ) {
				if ( ! material || list.length >= 240 ) continue;
				list.push( {
					phase,
					objectType: object.type || ( object.constructor && object.constructor.name ) || '',
					objectName: object.name || '',
					isInstancedMesh: object.isInstancedMesh === true,
					objectCount: object.count || 0,
					instanceMatrixCount: object.instanceMatrix && object.instanceMatrix.count || 0,
					materialType: material.type || ( material.constructor && material.constructor.name ) || '',
					materialName: material.name || '',
					isPrecompiled: material.isPrecompiledMaterial === true,
					artifactName: material.isPrecompiledMaterial === true ? material.name || '' : '',
					transparent: material.transparent === true,
					visible: material.visible !== false,
					nodeProps: __sourceNodePropNames( material ),
				} );
			}
		} );
	} catch ( _ ) {}
}

function __replacePriority( object ) {
	if ( ! object ) return 0;
	if ( object.isInstancedMesh === true ) return 20;
	if ( object.count && object.count > 1 ) return 10;
	return 0;
}

${ materialClasses }

// Plumb scene.background into every registered background-aux artifact's
// _textureRefs so the hydrator's UUID lookup resolves to the live cubemap
// the example just loaded with the slim TextureLoader. Captured uuids
// from the dev pass are dead — the example creates fresh Texture
// instances on every page load.
//
// When the captured artifact came from a backgroundBlurriness > 0 path
// (or a CubeUVReflectionMapping cubemap), three.js stages a PMREM
// prefilter on the cubemap and the captured WGSL samples that 2D
// prefiltered texture. Wiring the raw HDR cubemap to that binding
// gives the wrong format/orientation. We run PMREMGenerator on first
// use (the same cache used by __wireEnvironmentPMREM) and use that.
// Recursively walk a TSL node looking for a Texture/CubeTexture in any
// value / _value / texture / _texture slot. Used to recover the source
// cubemap from scene.backgroundNode = pmremTexture(map, ...) style code,
// where the user's only handle on the cubemap is inside a real PMREMNode
// (the e2e harness uses real three/tsl, not the slim stubs).
function __pushUniqueTexture( out, texture ) {
	if ( texture && texture.isTexture === true && ! out.includes( texture ) ) out.push( texture );
}

function __appendUniqueTextures( out, textures ) {
	for ( const texture of textures || [] ) __pushUniqueTexture( out, texture );
	return out;
}

function __collectTexturesInNode( node, out = [], depth = 0, seen = new Set() ) {
	if ( ! node || depth > 64 || seen.has( node ) ) return out;
	const read = __readGraphOwnValue;
	__walkNodeSafely( node, ( current ) => {
		if ( current.isTexture === true ) __pushUniqueTexture( out, current );
		for ( const key of [ 'value', '_value', 'texture', '_texture', 'textureNode', 'source', '_source', 'renderTarget' ] ) {
			const value = read( current, key );
			if ( value && value.isTexture === true ) __pushUniqueTexture( out, value );
			if ( value && value.texture && value.texture.isTexture === true ) __pushUniqueTexture( out, value.texture );
		}
		const depthTexture = read( current, 'depthTexture' );
		if ( depthTexture && depthTexture.isTexture === true ) __pushUniqueTexture( out, depthTexture );
		const textures = read( current, 'textures' );
		if ( Array.isArray( textures ) ) __appendUniqueTextures( out, textures );
	}, seen, depth );
	return out;
}

function __collectPMREMSourceTexturesInNode( node, out = [], depth = 0, seen = new Set() ) {
	return __sharedCollectPMREMSourceTexturesInNode( node, { getPmremStubSource: Slim.__getPmremStubSource }, out, depth, seen );
}

function __collectMaterialPMREMSourceTextures( material ) {
	return __sharedCollectPMREMSourceTexturesFromMaterial( material, { nodeGraphKeys: __nodeGraphKeys(), getPmremStubSource: Slim.__getPmremStubSource } );
}

function __findTextureInNode( node, depth = 0, seen = new Set() ) {
	const pmremSources = __collectPMREMSourceTexturesInNode( node, [], depth, new Set( seen ) );
	if ( pmremSources.length > 0 ) return pmremSources[ 0 ];
	const textures = __collectTexturesInNode( node, [], depth, new Set( seen ) );
	return textures.length > 0 ? textures[ 0 ] : null;
}

// Captured before scene.backgroundNode is replaced by __prepareSceneForReplay.
// Holds the user's source cubemap when the example uses scene.backgroundNode =
// pmremTexture(map, ...) (or similar) without ever assigning scene.background.
let __capturedBackgroundSource = null;
let __capturedBackgroundSources = [];
let __capturedEnvironmentSources = [];
const __capturedSceneBackgrounds = new WeakMap();
const __capturedSceneBackgroundNodes = new WeakMap();

function __rememberTexturesFromNode( target, node, predicate = null ) {
	if ( ! Array.isArray( target ) || ! node ) return;
	for ( const texture of __collectTexturesInNode( node ) ) {
		if ( predicate && ! predicate( texture ) ) continue;
		__pushUniqueTexture( target, texture );
	}
}

function __rememberPMREMSourceTexturesFromNode( target, node ) {
	if ( ! Array.isArray( target ) || ! node ) return;
	__appendUniqueTextures( target, __collectPMREMSourceTexturesInNode( node ) );
}

function __backgroundSourceTextures( scene ) {
	const out = [];
	if ( scene && scene.background && scene.background.isTexture === true ) __pushUniqueTexture( out, scene.background );
	__appendUniqueTextures( out, __capturedBackgroundSources );
	if ( __capturedBackgroundSource && __capturedBackgroundSource.isTexture === true ) __pushUniqueTexture( out, __capturedBackgroundSource );
	return out;
}

function __environmentSourceTextures( scene, includeBackgroundFallback = false ) {
	const out = [];
	if ( scene && scene.environment && scene.environment.isTexture === true ) __pushUniqueTexture( out, scene.environment );
	__appendUniqueTextures( out, __capturedEnvironmentSources );
	if ( includeBackgroundFallback && out.length === 0 ) __appendUniqueTextures( out, __backgroundSourceTextures( scene ) );
	return out;
}

// Tracks the last texture wired into each background artifact's _textureRefs
// so we only invalidate the cached background material (and the renderer's
// quad cache) when the source actually changes — typically when an async
// CubeTextureLoader / TextureLoader resolves AFTER the first render has
// already cached bindings against fallbackCubeTexture.
const __lastWiredBgTex = new WeakMap();

function __backgroundArtifactRefsMatch( artifact, texture, pmremTextures = null ) {
	if ( pmremTextures ) {
		const sourceUuids = __artifactPMREMSourceUuids( artifact );
		if ( sourceUuids.length === 0 ) return true;
		if ( pmremTextures.length < sourceUuids.length ) return false;
		const refs = artifact && artifact._textureRefs instanceof Map ? artifact._textureRefs : null;
		if ( ! refs ) return false;
		return sourceUuids.every( ( uuid, index ) => refs.get( uuid ) === pmremTextures[ index ] );
	}
	const sourceUuids = new Set();
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind === 'artifact.texture' && source.textureUuid ) sourceUuids.add( source.textureUuid );
		}
	}
	if ( sourceUuids.size === 0 ) return true;
	const refs = artifact && artifact._textureRefs instanceof Map ? artifact._textureRefs : null;
	return !! refs && [ ...sourceUuids ].every( ( uuid ) => refs.get( uuid ) === texture );
}

function __registerArtifactTextureRefOverride( sourceUuid, texture ) {
	if ( ! sourceUuid || ! texture || texture.isTexture !== true ) return;
	const root = typeof globalThis !== 'undefined' ? globalThis : window;
	const refs = root.__tslpArtifactTextureRefOverrides || ( root.__tslpArtifactTextureRefOverrides = new Map() );
	refs.set( sourceUuid, texture );
	if ( typeof root.__tslpResolveArtifactTextureRef !== 'function' ) {
		root.__tslpResolveArtifactTextureRef = ( source ) => {
			const uuid = source && source.textureUuid;
			return uuid && refs.get( uuid ) || null;
		};
	}
}

function __artifactNeedsCubeTexture( artifact ) {
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' ) continue;
			if ( entry.textureType === 'cube' ) return true;
			if ( source.mapping === 301 ) return true;
		}
	}
	return false;
}

const __backgroundNeedsCube = ( function () {
	const auxList = Array.isArray( __data.aux ) ? __data.aux : [];
	for ( const entry of auxList ) {
		if ( entry && entry.shape === 'background' && __artifactNeedsCubeTexture( entry.artifact ) ) return true;
	}
	return false;
} )();

function __isCubeTextureSource( texture ) {
	return !! ( texture && texture.isTexture === true && ( texture.isCubeTexture === true || Array.isArray( texture.image ) ) );
}

function __isEnvironmentTextureSource( texture ) {
	if ( ! texture || texture.isTexture !== true ) return false;
	if ( __isPMREMTexture( texture ) || __isCubeTextureSource( texture ) ) return true;
	const mapping = texture.mapping;
	return mapping === 301 || mapping === 302 || mapping === 303 || mapping === 304 || mapping === 306;
}

function __textureImageReady( texture ) {
	return __sharedTextureImageReady( texture );
}

function __newFallbackTextureImage() {
	return __sharedNewFallbackTextureImage();
}

function __harnessDiagnostics() {
	return window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
}

function __ensureSemanticOperationRegistry() {
	const diag = __harnessDiagnostics();
	let registry = diag.operationRegistry;
	if ( ! registry || registry.schema !== 'tslp-e2e-operation-registry@1' || ! Array.isArray( registry.expected ) ) {
		registry = {
			schema: 'tslp-e2e-operation-registry@1',
			complete: false,
			expected: [],
		};
		diag.operationRegistry = registry;
	}
	return registry;
}

function __expectSemanticOperation( component, operation ) {
	const registry = __ensureSemanticOperationRegistry();
	const exists = registry.expected.some( ( entry ) => entry
		&& entry.phase === 'replay'
		&& entry.component === component
		&& entry.operation === operation );
	if ( ! exists ) {
		// A new discovery invalidates an earlier seal until visitExample reaches
		// the deterministic diagnostics boundary and seals the registry again.
		if ( registry.complete === true ) registry.complete = false;
		registry.expected.push( {
			phase: 'replay',
			component,
			operation,
			required: true,
		} );
	}
	return registry;
}

function __artifactVariantRecoveryIdentity( error, effect ) {
	const message = String( error && ( error.stack || error.message ) || error || '' );
	if ( ! /ArtifactVariantSelectionError|No captured artifact variant matches/i.test( message ) ) return null;
	return { failureKind: 'artifact-variant-selection', effect };
}

function __semanticRecoveryRenderCount( effect ) {
	const diag = __harnessDiagnostics();
	if ( effect === 'FSR1Node' ) {
		const count = diag.frameEffects && diag.frameEffects.fsrFullPassRenders;
		return Number.isSafeInteger( count ) && count >= 0 ? count : 0;
	}
	if ( effect === 'BloomNode' ) {
		const bloom = diag.bloom || {};
		const rendered = Number.isSafeInteger( bloom.rendered ) && bloom.rendered >= 0 ? bloom.rendered : 0;
		const fullRendered = Number.isSafeInteger( bloom.fullRendered ) && bloom.fullRendered >= 0 ? bloom.fullRendered : 0;
		return Math.max( rendered, fullRendered );
	}
	return 0;
}

function __recordSemanticOperation( component, operation, result, error = null, required = true, recovery = null ) {
	const diag = __harnessDiagnostics();
	__expectSemanticOperation( component, operation );
	const outcomes = diag.operationOutcomes || ( diag.operationOutcomes = [] );
	let outcome = outcomes.find( ( entry ) => entry
		&& entry.phase === 'replay'
		&& entry.component === component
		&& entry.operation === operation );
	if ( ! outcome ) {
		outcome = {
			phase: 'replay',
			component,
			operation,
			required: required === true,
			attempted: 0,
			succeeded: 0,
			failed: 0,
		};
		outcomes.push( outcome );
	}
	if ( result === 'attempted' ) outcome.attempted ++;
	if ( result === 'succeeded' ) outcome.succeeded ++;
	if ( result === 'failed' ) {
		outcome.failed ++;
		const errorText = String( error && ( error.stack || error.message ) || error || 'unknown failure' );
		outcome.lastError = errorText;
		const recoveryState = outcome.recovery && typeof outcome.recovery === 'object'
			? outcome.recovery
			: ( outcome.recovery = {
				failureKind: null,
				effect: null,
				recoveryAttempts: 0,
				unrecoverableFailures: 0,
				mixedRecoveryIdentities: 0,
				presentationBaseline: 0,
				renderBaseline: 0,
				records: [],
			} );
		const recoveryRecords = Array.isArray( recoveryState.records )
			? recoveryState.records
			: ( recoveryState.records = [] );
		const failureKind = recovery && typeof recovery.failureKind === 'string'
			? recovery.failureKind
			: null;
		const effect = recovery && typeof recovery.effect === 'string'
			? recovery.effect
			: null;
		const presentationBaseline = __presentationReadiness.successful | 0;
		const renderBaseline = __semanticRecoveryRenderCount( effect );
		recoveryRecords.push( {
			failureNumber: outcome.failed,
			failureKind,
			effect,
			error: errorText,
			presentationBaseline,
			renderBaseline,
		} );
		if ( failureKind && effect ) {
			if ( recoveryState.failureKind === null && recoveryState.effect === null ) {
				recoveryState.failureKind = failureKind;
				recoveryState.effect = effect;
			} else if (
				recoveryState.failureKind !== failureKind ||
				recoveryState.effect !== effect
			) {
				recoveryState.mixedRecoveryIdentities ++;
			}
			recoveryState.recoveryAttempts ++;
			recoveryState.presentationBaseline = Math.max(
				recoveryState.presentationBaseline,
				presentationBaseline,
			);
			recoveryState.renderBaseline = Math.max(
				recoveryState.renderBaseline,
				renderBaseline,
			);
		} else {
			recoveryState.unrecoverableFailures ++;
		}
	}
	return outcome;
}

function __sealReplayOperationRegistry() {
	const registry = __ensureSemanticOperationRegistry();
	registry.complete = true;
	return registry;
}

window.__tslpSealReplayOperationRegistry = __sealReplayOperationRegistry;
// Initialize incomplete. A feature-free replay becomes distinguishable from
// missing instrumentation only when visitExample explicitly seals this empty
// registry at the deterministic diagnostics boundary.
__ensureSemanticOperationRegistry();

function __pmremDiagnostics() {
	const diag = __harnessDiagnostics();
	if ( ! diag.pmrem ) {
		diag.pmrem = {
			kickCalls: 0,
			cacheHits: 0,
			pendingJoins: 0,
			skippedNotReady: 0,
			generateCalls: 0,
			generateSuccess: 0,
			generateFailed: 0,
			noComputeRenderer: 0,
			noGPUTexture: 0,
			wireCalls: 0,
			wireNoPmrem: 0,
			wireAlreadyWired: 0,
			wireNeedsPmrem: 0,
			wireAttached: 0,
			generated: [],
		};
	}
	return diag.pmrem;
}

function __recordGeneratedPMREM( sourceTex, pmrem ) {
	try {
		const diag = __pmremDiagnostics();
		if ( ! Array.isArray( diag.generated ) ) diag.generated = [];
		if ( diag.generated.length >= 8 ) return;
		const srcImg = sourceTex && sourceTex.image || null;
		const pmImg = pmrem && pmrem.image || null;
		diag.generated.push( {
			sourceName: sourceTex && sourceTex.name || '',
			sourceMapping: sourceTex && sourceTex.mapping,
			sourceFlipY: sourceTex && sourceTex.flipY,
			sourceColorSpace: sourceTex && sourceTex.colorSpace,
			sourceWidth: srcImg && srcImg.width,
			sourceHeight: srcImg && srcImg.height,
			pmremName: pmrem && pmrem.name || '',
			pmremMapping: pmrem && pmrem.mapping,
			pmremColorSpace: pmrem && pmrem.colorSpace,
			pmremWidth: pmImg && pmImg.width,
			pmremHeight: pmImg && pmImg.height,
			pmremVersion: pmrem && pmrem.version,
		} );
	} catch ( _ ) {}
}

function __healTextureImage( texture ) {
	__liveSceneIndex.healTextureImage( texture );
}

function __getCachedPMREMForSource( sourceTex ) {
	return __getPMREMSupport().getCachedPMREMForSource( sourceTex );
}

function __wireBackgroundTextures( scene, renderer ) {
	const auxList = Array.isArray( __data.aux ) ? __data.aux : [];
	// Pick a source cubemap: prefer scene.background (legacy path) but fall
	// back to a node-graph-recovered source for the backgroundNode-only path
	// (e.g. webgpu_pmrem_cubemap.html does scene.backgroundNode = pmremTexture(map)
	// and never sets scene.background).
	const sourceTextures = __backgroundSourceTextures( scene );
	let sourceTex = sourceTextures[ 0 ] || null;
	if ( ! sourceTex ) return false;
	// Guard: if the texture is async-loading (CubeTextureLoader, RGBELoader,
	// TextureLoader) and its image hasn't arrived yet, skip wiring. Otherwise
	// three.js's Textures.updateTexture → getTransfer( image ) throws when
	// image is undefined, leaving the sky quad rendering fallback white forever
	// (the cached bind group sticks to whatever was wired on first render).
	// On the next frame after the loader resolves, the WeakMap lookup is still
	// undefined for this artifact, so the wire fires fresh with image populated.
	// CubeTexture image is an array of 6; consider it ready only if all six are present.
	if ( ! __isPMREMTexture( sourceTex ) && ! __textureImageReady( sourceTex ) ) return false;
	let texToWire = sourceTex;
	let pmremTextures = null;
	if ( __backgroundNeedsPMREM ) {
		pmremTextures = [];
		for ( const source of sourceTextures ) {
			if ( ! source || source.isTexture !== true ) continue;
			if ( ! __isPMREMTexture( source ) && ! __textureImageReady( source ) ) return false;
			const cached = __getCachedPMREMForSource( source );
			if ( cached && cached.isTexture === true ) __pushUniqueTexture( pmremTextures, cached );
			else return false;
		}
		texToWire = pmremTextures[ 0 ] || null;
		// Do not bind the raw equirect/cube source as a temporary PMREM
		// substitute. The hydrator applies captured PMREM sampler state
		// (CubeUV mapping + flipY=false) to bound textures, which mutates
		// loader sources before PMREM generation and can invert the replay sky.
		if ( ! texToWire ) return false;
	} else if ( __backgroundNeedsCube && ! __isCubeTextureSource( sourceTex ) ) {
		const cached = __backgroundCubeCache.get( sourceTex ) || __generateBackgroundCubeSync( renderer, sourceTex );
		if ( cached && cached.isTexture === true ) texToWire = cached;
		else return false;
	}
	const bg = renderer && renderer._background;
	const sceneData = bg && typeof bg.get === 'function' ? bg.get( scene ) : null;
	const cachedBackgroundArtifact = sceneData && sceneData.backgroundMesh && sceneData.backgroundMesh.material && sceneData.backgroundMesh.material.precompiledArtifact || null;
	let changed = false;
	for ( const entry of auxList ) {
		if ( entry && entry.shape === 'background' && entry.artifact ) {
			const artifacts = [ entry.artifact ];
			try {
				const registered = typeof Slim.findAux === 'function' ? Slim.findAux( 'background', entry.configHash ) : null;
				if ( registered && registered.artifact && ! artifacts.includes( registered.artifact ) ) artifacts.push( registered.artifact );
			} catch ( _ ) {}
			try {
				const runtimeRegistered = typeof __runtimeFindAux === 'function' ? __runtimeFindAux( 'background', entry.configHash ) : null;
				if ( runtimeRegistered && runtimeRegistered.artifact && ! artifacts.includes( runtimeRegistered.artifact ) ) artifacts.push( runtimeRegistered.artifact );
			} catch ( _ ) {}
			if ( cachedBackgroundArtifact && ! artifacts.includes( cachedBackgroundArtifact ) ) artifacts.push( cachedBackgroundArtifact );
			for ( const artifact of artifacts ) {
				for ( const group of artifact.uniformPlan || [] ) {
					for ( const textureEntry of group.textures || [] ) {
						const source = textureEntry && textureEntry.source || {};
						if ( source.kind === 'artifact.texture' && source.textureUuid ) __registerArtifactTextureRefOverride( source.textureUuid, texToWire );
					}
				}
				const key = pmremTextures
					? 'pmrem:' + __textureListSignature( pmremTextures, __artifactPMREMSourceUuids( artifact ).length )
					: texToWire;
				if ( __lastWiredBgTex.get( artifact ) !== key ) {
					const refsAlreadyMatch = __backgroundArtifactRefsMatch( artifact, texToWire, pmremTextures );
					if ( ! refsAlreadyMatch ) {
						if ( pmremTextures ) {
							if ( ! __attachPMREMRefsByOrder( artifact, pmremTextures ) ) continue;
						} else {
							Slim.attachArtifactTextureRefs( artifact, texToWire );
						}
					}
					__lastWiredBgTex.set( artifact, key );
					// Registry artifacts are seed templates once ReplayBackground owns a
					// per-scene clone. Updating a template must not dispose an already
					// correct active mesh; only a changed active clone needs rehydration.
					if ( ! refsAlreadyMatch && ( ! cachedBackgroundArtifact || artifact === cachedBackgroundArtifact ) ) changed = true;
					try {
						if ( __backgroundNeedsCube ) {
							const diag = __backgroundCubeDiagnostics();
							const samples = diag.wireSamples || ( diag.wireSamples = [] );
							if ( samples.length < 8 ) {
								let sourceUuid = null;
								for ( const group of artifact.uniformPlan || [] ) {
									const textureEntry = ( group.textures || [] ).find( ( item ) => item && item.source && item.source.kind === 'artifact.texture' );
									if ( textureEntry && textureEntry.source && textureEntry.source.textureUuid ) {
										sourceUuid = textureEntry.source.textureUuid;
										break;
									}
								}
								const refs = artifact._textureRefs instanceof Map ? artifact._textureRefs : null;
								const wiredTex = refs && sourceUuid ? refs.get( sourceUuid ) : null;
								const img = wiredTex && wiredTex.image || null;
								samples.push( {
									auxName: artifact.__tslpAuxName || artifact.name || '',
									sourceUuid,
									hasRefs: !! refs,
									refsSize: refs ? refs.size : 0,
									wiredName: wiredTex && wiredTex.name || '',
									wiredType: wiredTex && ( wiredTex.isCubeTexture ? 'cube' : wiredTex.isTexture ? 'texture' : typeof wiredTex ) || null,
									wiredWidth: Array.isArray( img ) ? img[ 0 ] && img[ 0 ].width : img && img.width,
									wiredHeight: Array.isArray( img ) ? img[ 0 ] && img[ 0 ].height : img && img.height,
									wiredIsTexToWire: wiredTex === texToWire,
								} );
							}
						}
					} catch ( _ ) {}
				}
			}
		}
	}
	if ( changed && renderer ) {
		if ( __backgroundNeedsCube ) __backgroundCubeDiagnostics().wired ++;
		// Force re-hydration of the cached Background.update mesh material so
		// its bind group rebuilds against the updated artifact._textureRefs.
		// Without this, an async CubeTextureLoader that resolves after the
		// first render leaves the sky quad sampling fallbackCubeTexture forever
		// (Background.js caches the mesh.material in sceneData and never
		// recreates it because our __nodeStub() backgroundCacheKey is stable).
		// Dispose mirrors the PMREM-completion path in __wireEnvironmentPMREM:
		// the next render creates a fresh RenderObject with _nodeBuilderState=null,
		// triggering hydrateNodeBuilderState against the now-correct _textureRefs.
		if ( sceneData && sceneData.backgroundMesh ) {
			try { sceneData.backgroundMesh.material && sceneData.backgroundMesh.material.dispose(); } catch ( _ ) {}
			try { sceneData.backgroundMesh.geometry && sceneData.backgroundMesh.geometry.dispose(); } catch ( _ ) {}
			sceneData.backgroundMesh = undefined;
			sceneData.backgroundMeshNode = undefined;
			sceneData.backgroundCacheKey = undefined;
		}
		try {
			const nc = renderer._nodes && renderer._nodes.nodeBuilderCache;
			if ( nc && typeof nc.clear === 'function' ) nc.clear();
		} catch ( _ ) {}
		if ( renderer._quadCache ) renderer._quadCache.clear();
	}
	return changed;
}

// PBR (MeshStandard / MeshPhysical) materials sample a PMREM-prefiltered
// 2D texture for IBL. three.js's NodeManager builds it lazily on first
// render and stashes it on a PMREMNode in sceneData.environmentNode.
// The captured artifact references this texture by capture-time uuid;
// at replay the live renderer makes a fresh PMREM and we wire that into
// every PBR material's artifact.texture-kind bindings so the hydrator
// resolves to the live prefiltered map instead of the 1×1 fallback.
// Cache of PMREM-prefiltered textures keyed by source texture. Mirrors
// what three.js's EnvironmentNode does internally — but our patched
// slim bypasses NodeBuilder.build() so PBR materials never trigger the
// PMREM path on their own. We run PMREMGenerator manually via the full
// compute renderer (which can build PMREM's internal NodeMaterial; the
// slim renderer cannot and throws tslPrecompileSlimOnly) and wire the
// prefiltered output into every PrecompiledMaterial's artifact.texture-kind
// bindings so the hydrator resolves to the live prefiltered map.
const __pmremCache = new WeakMap();   // source tex → pmrem Texture (ready)
const __pmremPending = new WeakMap(); // source tex → Promise<Texture|null>
const __pmremFailed = new WeakSet();  // source tex → known-failed (don't retry, don't warn again)
const __pmremWiredArtifacts = new WeakMap(); // artifact -> PMREM texture signature
let __pmremNoRendererWarned = false;  // dedup the global "no compute renderer" warning
let __pmremSupport = null;

function __bumpPMREMPending( delta ) {
	window.__tslpPmremPending = Math.max( 0, ( window.__tslpPmremPending | 0 ) + delta );
}

function __getPMREMSupport() {
	if ( __pmremSupport ) return __pmremSupport;
	__pmremSupport = __sharedCreatePMREMSupport( {
		cache: __pmremCache,
		pending: __pmremPending,
		failed: __pmremFailed,
		wiredArtifacts: __pmremWiredArtifacts,
		getDiagnostics: __pmremDiagnostics,
		textureImageReady: __textureImageReady,
		generatePMREM: __generatePMREMAsync,
		onPendingChange: ( delta ) => __bumpPMREMPending( delta ),
		onError: ( err ) => {
			// Per-page warn-once: log only the FIRST PMREM failure for the entire
			// page load. Per-texture dedup was too noisy for scenes that swap
			// environment textures while replay is settling.
			if ( ! window.__tslpPmremWarned ) {
				window.__tslpPmremWarned = true;
				console.warn( '[tslp-e2e] PMREM async generation failed:', err && err.message || err );
			}
		},
	} );
	return __pmremSupport;
}

const __backgroundCubeCache = new WeakMap();   // equirect source tex → CubeTexture (ready)
const __backgroundCubePending = new WeakMap(); // equirect source tex → Promise<CubeTexture|null>
const __backgroundCubeTargets = new WeakMap(); // keep CubeRenderTarget alive for its texture
const __backgroundCubeFailed = new WeakSet();

function __backgroundCubeDiagnostics() {
	const diag = __harnessDiagnostics();
	if ( ! diag.backgroundCube ) diag.backgroundCube = { kickCalls: 0, cacheHits: 0, pendingJoins: 0, skippedNotReady: 0, generateCalls: 0, generateSuccess: 0, generateFailed: 0, wired: 0 };
	return diag.backgroundCube;
}

function __textureImageSize( image ) {
	if ( ! image ) return { width: 0, height: 0 };
	const nested = image.image || null;
	return {
		width: image.width || image.naturalWidth || image.videoWidth || nested && nested.width || 0,
		height: image.height || image.naturalHeight || image.videoHeight || nested && nested.height || 0,
	};
}

function __cubeSizeForEquirect( texture ) {
	const size = __textureImageSize( texture && texture.image );
	return Math.max( 16, size.height || 256 );
}

function __createBackgroundCubeTarget( sourceTex ) {
	if ( ! sourceTex || sourceTex.isTexture !== true || typeof FullCubeRenderTarget !== 'function' ) return null;
	const target = new FullCubeRenderTarget( __cubeSizeForEquirect( sourceTex ) );
	let cubeSource = sourceTex;
	if ( typeof sourceTex.clone === 'function' ) {
		cubeSource = sourceTex.clone();
		cubeSource.image = sourceTex.image;
		cubeSource.flipY = sourceTex.flipY;
		cubeSource.mapping = Slim.EquirectangularReflectionMapping;
		cubeSource.needsUpdate = true;
	}
	return { target, cubeSource };
}

function __finishBackgroundCubeTarget( slimRenderer, fullRenderer, sourceTex, target ) {
	const cube = target && target.texture || null;
	if ( ! ( cube && cube.isTexture === true ) ) return null;
	cube.name = sourceTex.name ? sourceTex.name + '.cube' : 'background.cube';
	if ( sourceTex.mapping === Slim.EquirectangularRefractionMapping ) cube.mapping = Slim.CubeRefractionMapping;
	else cube.mapping = Slim.CubeReflectionMapping;
	__backgroundCubeTargets.set( sourceTex, target );
	__sharePMREMGPUTexture( slimRenderer, fullRenderer, cube );
	__markSlimTextureInitialized( slimRenderer, cube );
	Slim.registerLiveTexture( cube );
	__backgroundCubeCache.set( sourceTex, cube );
	__backgroundCubeDiagnostics().generateSuccess ++;
	return cube;
}

function __generateBackgroundCubeSync( slimRenderer, sourceTex ) {
	if ( __backgroundCubeFailed.has( sourceTex ) ) return null;
	if ( __backgroundCubeCache.has( sourceTex ) ) return __backgroundCubeCache.get( sourceTex ) || null;
	const fullRenderer = __computeRenderer;
	if ( ! slimRenderer || ! fullRenderer || ! __textureImageReady( sourceTex ) ) return null;
	__backgroundCubeDiagnostics().generateCalls ++;
	try {
		const created = __createBackgroundCubeTarget( sourceTex );
		if ( ! created ) return null;
		created.target.fromEquirectangularTexture( fullRenderer, created.cubeSource );
		return __finishBackgroundCubeTarget( slimRenderer, fullRenderer, sourceTex, created.target );
	} catch ( err ) {
		__backgroundCubeFailed.add( sourceTex );
		__backgroundCubeDiagnostics().generateFailed ++;
		if ( ! window.__tslpBackgroundCubeWarned ) {
			window.__tslpBackgroundCubeWarned = true;
			console.warn( '[tslp-e2e] background cube generation failed:', err && err.message || err );
		}
	}
	return null;
}

async function __generateBackgroundCubeAsync( slimRenderer, sourceTex ) {
	__backgroundCubeDiagnostics().generateCalls ++;
	if ( __backgroundCubeFailed.has( sourceTex ) ) return null;
	const fullRenderer = await __getComputeRenderer( slimRenderer );
	if ( ! fullRenderer ) return null;
	try {
		const created = __createBackgroundCubeTarget( sourceTex );
		if ( ! created ) return null;
		created.target.fromEquirectangularTexture( fullRenderer, created.cubeSource );
		return __finishBackgroundCubeTarget( slimRenderer, fullRenderer, sourceTex, created.target );
	} catch ( err ) {
		__backgroundCubeFailed.add( sourceTex );
		__backgroundCubeDiagnostics().generateFailed ++;
		if ( ! window.__tslpBackgroundCubeWarned ) {
			window.__tslpBackgroundCubeWarned = true;
			console.warn( '[tslp-e2e] background cube generation failed:', err && err.message || err );
		}
	}
	return null;
}

function __kickBackgroundCubeGenAsync( slimRenderer, sourceTex, onReady ) {
	if ( ! slimRenderer || ! sourceTex || sourceTex.isTexture !== true || __isCubeTextureSource( sourceTex ) ) return;
	__backgroundCubeDiagnostics().kickCalls ++;
	if ( __backgroundCubeCache.has( sourceTex ) ) { __backgroundCubeDiagnostics().cacheHits ++; onReady( __backgroundCubeCache.get( sourceTex ) ); return; }
	if ( __backgroundCubePending.has( sourceTex ) ) {
		__backgroundCubeDiagnostics().pendingJoins ++;
		__backgroundCubePending.get( sourceTex ).then( ( cube ) => { if ( cube ) onReady( cube ); } ).catch( () => {} );
		return;
	}
	if ( ! __textureImageReady( sourceTex ) ) { __backgroundCubeDiagnostics().skippedNotReady ++; return; }
	window.__tslpPmremPending = ( window.__tslpPmremPending | 0 ) + 1;
	const resultPromise = __generateBackgroundCubeAsync( slimRenderer, sourceTex ).catch( () => null );
	__backgroundCubePending.set( sourceTex, resultPromise );
	resultPromise.then( ( cube ) => {
		if ( cube ) {
			try { onReady( cube ); } catch ( _ ) {}
		}
	} ).finally( () => {
		window.__tslpPmremPending = Math.max( 0, ( window.__tslpPmremPending | 0 ) - 1 );
	} );
}

// Generate a PMREM texture using the full three.js renderer (which shares the
// same WebGPU device as the slim renderer, so its GPU textures work as slim
// bindings). Called only when no PMREM is cached for sourceTex.
async function __generatePMREMAsync( slimRenderer, sourceTex ) {
	if ( __pmremFailed.has( sourceTex ) ) return null;
	const fullRenderer = await __getComputeRenderer( slimRenderer );
	if ( ! fullRenderer ) {
		__pmremDiagnostics().noComputeRenderer ++;
		if ( ! __pmremNoRendererWarned ) {
			__pmremNoRendererWarned = true;
			console.warn( '[tslp-e2e] PMREM: no compute renderer' );
		}
		return null;
	}
	try {
		__shareGPUTextureEntry( fullRenderer, slimRenderer, sourceTex );
		const { PMREMGenerator } = await import( '/build/three.webgpu.js' );
		const gen = new PMREMGenerator( fullRenderer );
		let target = null;
		// Use a short-lived clone so PMREM generation can correct the mapping
		// without racing background cubemap conversion over the live texture's
		// mutable mapping / flipY fields.
		const isCubeSource = sourceTex.isCubeTexture === true || Array.isArray( sourceTex.image );
		let pmremSource = sourceTex;
		if ( isCubeSource && sourceTex.mapping !== Slim.CubeReflectionMapping && sourceTex.mapping !== Slim.CubeRefractionMapping && typeof sourceTex.clone === 'function' ) {
			pmremSource = sourceTex.clone();
			pmremSource.image = sourceTex.image;
			pmremSource.mapping = Slim.CubeReflectionMapping;
			pmremSource.needsUpdate = true;
		} else if ( ! isCubeSource && typeof sourceTex.clone === 'function' ) {
			pmremSource = sourceTex.clone();
			pmremSource.image = sourceTex.image;
			pmremSource.flipY = sourceTex.flipY;
			pmremSource.mapping = Slim.EquirectangularReflectionMapping;
			pmremSource.needsUpdate = true;
		} else if ( ! isCubeSource ) {
			pmremSource.mapping = Slim.EquirectangularReflectionMapping;
		}
		target = isCubeSource
			? gen.fromCubemap( pmremSource )
			: gen.fromEquirectangular( pmremSource );
		const pmrem = target && target.texture || null;
		gen.dispose && gen.dispose();
		if ( pmrem && pmrem.isTexture === true ) {
			__recordGeneratedPMREM( sourceTex, pmrem );
			// Verify the full backend actually owns a GPUTexture for this
			// PMREM result before sharing — sharing a stale entry leaves
			// slim's bindings empty.
			const fullData = fullRenderer.backend && fullRenderer.backend.get( pmrem );
			if ( ! fullData || ! fullData.texture ) {
				__pmremDiagnostics().noGPUTexture ++;
				if ( ! __pmremFailed.has( sourceTex ) ) {
					__pmremFailed.add( sourceTex );
					console.warn( '[tslp-e2e] PMREM: full backend has no GPU texture for PMREM' );
				}
				return null;
			} else {
				__sharePMREMGPUTexture( slimRenderer, fullRenderer, pmrem );
			}
		}
		return pmrem || null;
	} catch ( err ) {
		throw err;
	}
}

function __generatePMREMSyncIfReady( slimRenderer, sourceTex ) {
	if ( ! slimRenderer || ! sourceTex || sourceTex.isTexture !== true ) return null;
	const cached = __getCachedPMREMForSource( sourceTex );
	if ( cached && cached.isTexture === true ) return cached;
	if ( __pmremFailed.has( sourceTex ) || ! __textureImageReady( sourceTex ) ) return null;
	const fullRenderer = __computeRenderer;
	const FullPMREMGenerator = __fullThreeMod && __fullThreeMod.PMREMGenerator;
	if ( ! fullRenderer || ! FullPMREMGenerator ) return null;
	try {
		__shareGPUTextureEntry( fullRenderer, slimRenderer, sourceTex );
		const gen = new FullPMREMGenerator( fullRenderer );
		const isCubeSource = sourceTex.isCubeTexture === true || Array.isArray( sourceTex.image );
		let pmremSource = sourceTex;
		if ( isCubeSource && sourceTex.mapping !== Slim.CubeReflectionMapping && sourceTex.mapping !== Slim.CubeRefractionMapping && typeof sourceTex.clone === 'function' ) {
			pmremSource = sourceTex.clone();
			pmremSource.image = sourceTex.image;
			pmremSource.mapping = Slim.CubeReflectionMapping;
			pmremSource.needsUpdate = true;
		} else if ( ! isCubeSource && typeof sourceTex.clone === 'function' ) {
			pmremSource = sourceTex.clone();
			pmremSource.image = sourceTex.image;
			pmremSource.flipY = sourceTex.flipY;
			pmremSource.mapping = Slim.EquirectangularReflectionMapping;
			pmremSource.needsUpdate = true;
		} else if ( ! isCubeSource ) {
			pmremSource.mapping = Slim.EquirectangularReflectionMapping;
		}
		const target = isCubeSource
			? gen.fromCubemap( pmremSource )
			: gen.fromEquirectangular( pmremSource );
		const pmrem = target && target.texture || null;
		gen.dispose && gen.dispose();
		if ( ! ( pmrem && pmrem.isTexture === true ) ) return null;
		__recordGeneratedPMREM( sourceTex, pmrem );
		const fullData = fullRenderer.backend && fullRenderer.backend.get( pmrem );
		if ( ! fullData || ! fullData.texture ) {
			__pmremDiagnostics().noGPUTexture ++;
			return null;
		}
		__sharePMREMGPUTexture( slimRenderer, fullRenderer, pmrem );
		__pmremDiagnostics().syncGenerateSuccess = ( __pmremDiagnostics().syncGenerateSuccess || 0 ) + 1;
		return __getPMREMSupport().rememberPMREM( sourceTex, pmrem );
	} catch ( err ) {
		__pmremFailed.add( sourceTex );
		__pmremDiagnostics().syncGenerateFailed = ( __pmremDiagnostics().syncGenerateFailed || 0 ) + 1;
		if ( ! window.__tslpPmremWarned ) {
			window.__tslpPmremWarned = true;
			console.warn( '[tslp-e2e] PMREM sync generation failed:', err && err.message || err );
		}
		return null;
	}
}

function __isRenderTargetTextureSource( texture ) {
	return !! ( texture && texture.isTexture === true && ( texture.isRenderTargetTexture === true || texture.renderTarget ) );
}

function __prewarmStaticPMREMSourcesForScene( renderer, scene ) {
	if ( ! renderer || ! scene ) return;
	const seen = new WeakSet();
	const prewarm = ( texture ) => {
		if ( ! texture || texture.isTexture !== true || seen.has( texture ) || __isRenderTargetTextureSource( texture ) ) return;
		seen.add( texture );
		const image = texture.image || {};
		const detail = ( texture.name || texture.uuid || '<texture>' ) +
			':' + ( image.width || image.videoWidth || 0 ) + 'x' +
			( image.height || image.videoHeight || 0 );
		__withReplayOperation( 'prewarmStaticPMREM.generate', detail, () => __generatePMREMSyncIfReady( renderer, texture ) );
	};
	for ( const texture of __environmentSourceTextures( scene, true ) ) prewarm( texture );
	if ( typeof scene.traverse !== 'function' ) return;
	scene.traverse( ( object ) => {
		const mat = object && object.material;
		const list = Array.isArray( mat ) ? mat : mat ? [ mat ] : [];
		for ( const m of list ) {
			if ( ! ( m && m.isPrecompiledMaterial && m.precompiledArtifact ) ) continue;
			if ( ! __artifactNeedsPMREM( m.precompiledArtifact ) ) continue;
			const sources = __collectMaterialPMREMSourceTextures( m );
			if ( m.envMap && m.envMap.isTexture === true ) __pushUniqueTexture( sources, m.envMap );
			for ( const source of sources ) prewarm( source );
		}
	} );
}

// Wire a ready PMREM texture into PrecompiledMaterial artifacts that have
// CubeUVReflectionMapping (mapping=306) or textureName=PMREM.cubeUv bindings.
// IMPORTANT: do NOT wire PMREM into artifacts that only have raw cube/equirect
// bindings (e.g. the background sky renderer uses texture_cube — wiring a 2D
// PMREM texture there fails WebGPU validation and aborts the entire render pass).
// Sets material.needsUpdate = true for newly-wired materials so Three.js
// re-runs hydrateNodeBuilderState with the correct texture in _textureRefs
// (hydration is cached per material version; needsUpdate invalidates the cache).
function __artifactNeedsPMREM( artifact ) {
	return __sharedArtifactNeedsPMREM( artifact );
}

function __artifactPMREMSourceUuids( artifact ) {
	return __sharedArtifactPMREMSourceUuids( artifact );
}

function __cachedPMREMForSource( sourceTex ) {
	return __getCachedPMREMForSource( sourceTex );
}

function __textureListSignature( textures, count = 0 ) {
	return __sharedTextureListSignature( textures, count );
}

function __attachPMREMRefsByOrder( artifact, pmremTextures ) {
	return __sharedAttachPMREMRefsByOrder( artifact, pmremTextures );
}

function __selectPMREMTexturesForArtifact( artifact, material, environmentSources ) {
	return __sharedSelectPMREMTexturesForArtifact( artifact, {
		material,
		collectMaterialNodeTextures: __collectMaterialNodeTextures,
		collectMaterialPMREMSources: __collectMaterialPMREMSourceTextures,
		getCachedPMREMForSource: __getCachedPMREMForSource,
		environmentSources,
	} );
}

function __wireEnvironmentPMREM( renderer, scene ) {
	if ( ! renderer || ! scene ) return 0;
	__pmremDiagnostics().wireCalls ++;
	const environmentSources = __environmentSourceTextures( scene, true );
	let wiredCount = 0;
	scene.traverse( ( object ) => {
		const mat = object && object.material;
		const list = Array.isArray( mat ) ? mat : mat ? [ mat ] : [];
		for ( const m of list ) {
			if ( m && m.isPrecompiledMaterial && m.precompiledArtifact ) {
				const artifact = m.precompiledArtifact;
				const sourceUuids = __artifactPMREMSourceUuids( artifact );
				if ( sourceUuids.length === 0 ) continue;
				// Prefer per-material envMap PMREM (set by examples that pass
				// envMap via constructor params), fall back to scene.environment /
				// scene.environmentNode. Multi-PMREM node graphs are wired by the
				// distinct PMREM source order captured in the artifact.
				const selection = __selectPMREMTexturesForArtifact( artifact, m, environmentSources );
				const nodePmrems = selection.nodePmrems || [];
				if ( nodePmrems.length > 0 ) {
					const diag = __pmremDiagnostics();
					diag.wireNodePmremCandidates = ( diag.wireNodePmremCandidates || 0 ) + nodePmrems.length;
					if ( ! Array.isArray( diag.nodePmremSamples ) ) diag.nodePmremSamples = [];
					if ( diag.nodePmremSamples.length < 4 ) {
						const img = nodePmrems[ 0 ].image || null;
						diag.nodePmremSamples.push( { width: img && img.width, height: img && img.height, version: nodePmrems[ 0 ].version } );
					}
				}
				const pmrems = selection.pmremTextures || [];
				if ( pmrems.length < sourceUuids.length ) {
					__pmremDiagnostics().wireNoPmrem ++;
					continue;
				}
				const signature = __textureListSignature( pmrems, sourceUuids.length );
				if ( __pmremWiredArtifacts.get( artifact ) === signature ) {
					__pmremDiagnostics().wireAlreadyWired ++;
					continue;
				}
				__pmremDiagnostics().wireNeedsPmrem ++;
				if ( __attachPMREMRefsByOrder( artifact, pmrems ) ) {
					__pmremWiredArtifacts.set( artifact, signature );
					m.needsUpdate = true;
					// Keep the current RenderObject alive. Its early
					// artifactTextureRebinder observes the updated _textureRefs
					// and invalidates only the affected texture binding. Disposing
					// here can destroy an object UBO that an encoded or submitted
					// GPU command buffer still references.
					wiredCount ++;
					__pmremDiagnostics().wireAttached ++;
				} else {
					__pmremDiagnostics().wireNoPmrem ++;
				}
			}
		}
	} );
	// Keep future RenderObjects from hydrating against a program-level state
	// cached before the PMREM refs became available. Existing RenderObjects are
	// updated in place by artifactTextureRebinder above.
	if ( wiredCount > 0 ) {
		try {
			const nc = renderer._nodes && renderer._nodes.nodeBuilderCache;
			if ( nc && typeof nc.clear === 'function' ) nc.clear();
		} catch ( _ ) {}
	}
	return wiredCount;
}

// Kick off async PMREM generation if not already started. onReady is called
// with the pmrem texture once generation completes. The global
// window.__tslpPmremPending counter is incremented until the generation
// finishes so Playwright's freeze-wait condition can include it.
function __kickPMREMGenAsync( slimRenderer, sourceTex, onReady ) {
	if ( ! slimRenderer || ! sourceTex || sourceTex.isTexture !== true ) return Promise.resolve( null );
	return __getPMREMSupport().kickGenerate( slimRenderer, sourceTex, ( pmrem ) => {
		if ( pmrem ) {
			try { onReady( pmrem ); } catch ( _ ) {}
		}
	} ).catch( () => null );
}

// Walk the scene and register every discovered Texture in the runtime's
// live-texture index. Hydrator uses this to relink artifact.texture-kind
// bindings whose textureUuid is dead by matching imageSrc / textureName
// from the captured artifact against currently-loaded textures.
	function __indexLiveTextures( scene ) {
		const visit = ( tex, options = {} ) => {
			if ( tex && tex.isTexture === true ) {
				__liveSceneIndex.indexTexture( tex, options );
			}
		};
		const globalTslTextures = Array.isArray( window.__tslpTslTextureArgs ) ? window.__tslpTslTextureArgs : [];
		for ( const tex of globalTslTextures ) visit( tex, { heal: false } );
		if ( ! scene || typeof scene.traverse !== 'function' ) return;
		if ( scene.background && scene.background.isTexture === true ) visit( scene.background );
	if ( scene.environment && scene.environment.isTexture === true ) visit( scene.environment );
	for ( const tex of __capturedBackgroundSources ) visit( tex );
	for ( const tex of __capturedEnvironmentSources ) visit( tex );
	if ( scene.backgroundNode ) {
		const pmremSources = __collectPMREMSourceTexturesInNode( scene.backgroundNode );
		for ( const tex of pmremSources.length > 0 ? pmremSources : __collectTexturesInNode( scene.backgroundNode ) ) visit( tex );
	}
	if ( scene.environmentNode ) {
		const pmremSources = __collectPMREMSourceTexturesInNode( scene.environmentNode );
		for ( const tex of pmremSources.length > 0 ? pmremSources : __collectTexturesInNode( scene.environmentNode ) ) visit( tex );
	}
	scene.traverse( ( object ) => {
		// Lights can carry textures (SpotLight.map / RectAreaLight.map). Three.js
			// bakes those into the LightsNode TSL graph, so the captured artifact
			// references them by uuid/imageSrc just like material.map. They must be
			// registered or the artifact-texture rebinder falls back to a 1x1 stub.
			if ( object && object.isLight === true && object.map && object.map.isTexture === true ) visit( object.map, { heal: false } );
			const ms = object && object.material;
			const list = Array.isArray( ms ) ? ms : ms ? [ ms ] : [];
			for ( const m of list ) {
				if ( ! m ) continue;
				for ( const key of __TEXTURE_PROPS ) visit( m[ key ], { heal: false } );
				for ( const tex of __collectMaterialNodeTextures( m ) ) visit( tex, { heal: false } );
			}
		} );
	}

function __hasReplayArtifactMatch( root ) {
	if ( ! root || typeof root.traverse !== 'function' ) return false;
	const keys = Object.keys( __data.user || {} );
	if ( keys.length === 0 ) return false;
	let matched = false;
	try {
		root.traverse( ( object ) => {
			if ( matched || ! object || ! object.material ) return;
			const list = Array.isArray( object.material ) ? object.material : [ object.material ];
			for ( const material of list ) {
				if ( ! material ) continue;
				if ( material.isPrecompiledMaterial === true ) {
					matched = true;
					return;
				}
				const className = __classNameForMaterial( material );
				if ( __findBestArtifactForSource( className, material, keys, object ) ) {
					matched = true;
					return;
				}
			}
		} );
	} catch ( _ ) {}
	return matched;
}

function __shouldBypassReplayPrepareDuringPMREM( root ) {
	return __pmremRunning > 0 && ! __hasReplayArtifactMatch( root );
}

function __normalizeClippingGroupForReplay( object ) {
	if ( ! object || ! object.isClippingGroup ) return false;
	let repaired = false;
	if ( ! Array.isArray( object.clippingPlanes ) ) { object.clippingPlanes = []; repaired = true; }
	if ( typeof object.clipIntersection !== 'boolean' ) { object.clipIntersection = false; repaired = true; }
	if ( typeof object.clipShadows !== 'boolean' ) { object.clipShadows = false; repaired = true; }
	if ( typeof object.enabled !== 'boolean' ) { object.enabled = true; repaired = true; }
	try {
		const diag = __harnessDiagnostics();
		diag.clippingGroups = diag.clippingGroups || { seen: 0, repaired: 0 };
		diag.clippingGroups.seen ++;
		if ( repaired ) diag.clippingGroups.repaired ++;
	} catch ( _ ) {}
	return true;
}

function __prepareSceneForReplay( scene, renderer ) {
	if ( __shouldBypassReplayPrepareDuringPMREM( scene ) ) return;
	// PMREMGenerator and RenderPipeline internals render temporary meshes/scenes
	// that were never part of the user's capture set. Let the full/slim renderer
	// handle those materials normally so they do not consume user artifacts.
	if ( ! scene || typeof scene.traverse !== 'function' || scene.name === 'RoomEnvironment' ) return;
	const replaySceneDetail = scene.name || scene.type || '<scene>';
	__withReplayOperation( 'prepareScene.normalizeClippingGroups', replaySceneDetail, () => scene.traverse( __normalizeClippingGroupForReplay ) );
	// When a background-aux artifact is registered the rewritten Background.js
	// inside the slim bundle calls loadAux('background', hashNodeGraphSync(backgroundNode))
	// to build a PrecompiledMaterial for the sky quad.  That path is only
	// reached when the backgroundNode has .isNode === true (or a Texture/Color
	// falls through the legacy branches).  We therefore replace live TSL graphs
	// with a stub proxy.  When exact scene/background hash matching is possible,
	// the stub carries the matching aux configHash so multi-scene examples (for
	// example portal render passes) don't all shape-fallback to the same artifact.
	//   • If no background aux: null out backgroundNode so Background.js falls
	//     through to the renderer's clear-color path (old behaviour).
	// Color backgrounds are left intact in both cases — they use the clear-
	// color path and bypass loadAux entirely.
	if ( scene && scene.isScene === true ) {
		if ( ! __capturedSceneBackgrounds.has( scene ) ) __capturedSceneBackgrounds.set( scene, scene.background );
		if ( ! __capturedSceneBackgroundNodes.has( scene ) ) __capturedSceneBackgroundNodes.set( scene, scene.backgroundNode );
		if ( scene.environmentNode ) {
			const envSources = [];
			__withReplayOperation( 'prepareScene.collectEnvironmentPMREMSources', replaySceneDetail, () => __rememberPMREMSourceTexturesFromNode( envSources, scene.environmentNode ) );
			if ( envSources.length > 0 ) __capturedEnvironmentSources = envSources;
		}
		// Recover the source texture from scene.backgroundNode BEFORE we replace
		// it with a stub, so the PMREM wiring path can reach it later. Examples
		// like webgpu_pmrem_cubemap.html only set scene.backgroundNode (a real
		// PMREMNode in e2e mode); without this, the cubemap reference is lost.
		if ( __hasBackgroundAux && scene.backgroundNode ) {
			const backgroundSources = [];
			__withReplayOperation( 'prepareScene.collectBackgroundPMREMSources', replaySceneDetail, () => __rememberPMREMSourceTexturesFromNode( backgroundSources, scene.backgroundNode ) );
			if ( backgroundSources.length > 0 ) {
				__capturedBackgroundSources = backgroundSources;
				__capturedBackgroundSource = backgroundSources[ 0 ];
			} else {
				const recovered = __withReplayOperation( 'prepareScene.findBackgroundTexture', replaySceneDetail, () => __findTextureInNode( scene.backgroundNode ) );
				if ( recovered ) __capturedBackgroundSource = recovered;
			}
		}
		const hasLiveBackgroundNode = !! scene.backgroundNode;
		const hasTextureBackground = !! ( scene.background && scene.background.isTexture === true );
		if ( __hasBackgroundAux && ( hasLiveBackgroundNode || hasTextureBackground ) ) {
			const configHash = __backgroundAuxConfigHashForScene( scene );
			const canFallback = __backgroundAuxCount <= 1 || !! __backgroundEquivalentFallbackHash;
			if ( configHash || canFallback ) {
				// Replace with a stub so Background.js enters the isNode branch and
				// calls loadAux. Multi-background scenes get exact aux hashes; single-
				// background scenes can keep using shape fallback. Multiple captures
				// may also fall back only when their executable programs are exactly
				// equivalent after removing capture-instance identity.
				scene.backgroundNode = __nodeStub( configHash || __backgroundEquivalentFallbackHash );
			} else {
				scene.backgroundNode = null;
				if ( scene.background && ! scene.background.isColor ) scene.background = null;
			}
			// Don't null scene.background here; it won't be reached because
			// backgroundNode takes priority in getBackgroundNode().
		} else {
			scene.backgroundNode = null;
			if ( scene.background && ! scene.background.isColor ) scene.background = null;
		}
	}
	__withReplayOperation( 'prepareScene.indexLiveTextures', replaySceneDetail, () => __indexLiveTextures( scene ) );
	__withReplayOperation( 'prepareScene.wireBackgroundTextures', replaySceneDetail, () => __wireBackgroundTextures( scene, renderer ) );
	const previousReplayRenderer = window.__tslpCurrentReplayRenderer;
	window.__tslpCurrentReplayRenderer = renderer;
	try {
		__withReplayOperation( 'prepareScene.replaceOverrideMaterial', replaySceneDetail, () => __replaceSceneOverrideMaterial( scene, renderer ) );
		__withReplayOperation( 'prepareScene.replaceSceneMaterials', replaySceneDetail, () => __replaceSceneMaterials( scene, renderer ) );
	} finally {
		window.__tslpCurrentReplayRenderer = previousReplayRenderer;
	}
	__withReplayOperation( 'prepareScene.recordMaterialSnapshot', replaySceneDetail, () => __recordReplayMaterialSnapshot( scene, 'prepare' ) );
}

// Material-owned compute discovery and artifact wiring live in the runtime.
// Legacy graphs retain the harness's frozen-screenshot dispatch policy. A
// signed hybrid-required contract is different: hydration must see one
// successful full-renderer delegation lease before its first draw. Keep the
// public render() call synchronous by deferring that draw, serializing the
// product dispatcher, then issuing one guarded presentation render.
const __autoComputeDispatcherByRenderer = new WeakMap();
const __frozenDispatchedAutoComputeNodes = new Set();
const __materialComputeSceneSupportByRenderer = new WeakMap();
const __materialComputeDispatchStateByRenderer = new WeakMap();

function __sceneRequiresMaterialComputeDelegation( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return false;
	let required = false;
	scene.traverse( ( object ) => {
		if ( required ) return;
		const material = object && object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const candidate of list ) {
			if ( ! ( candidate && candidate.isPrecompiledMaterial === true && candidate.precompiledArtifact ) ) continue;
			try {
				const inspection = __sharedInspectRuntimeMaterialComputeFamily( candidate.precompiledArtifact );
				if ( inspection.status === 'uniform' && inspection.descriptor.mode === 'hybrid-required' ) {
					required = true;
					return;
				}
			} catch ( _ ) {
				// Let the product dispatcher report the typed divergent-family error.
				required = true;
				return;
			}
		}
	} );
	return required;
}

function __materialComputeSceneSupportFor( slimRenderer ) {
	let support = __materialComputeSceneSupportByRenderer.get( slimRenderer );
	if ( support ) return support;
	support = __sharedCreateSlimSceneSupport( {
		renderer: slimRenderer,
		fullRendererFallback: false,
	} );
	__materialComputeSceneSupportByRenderer.set( slimRenderer, support );
	return support;
}

function __snapshotMaterialComputeRenderRequest( slimRenderer, scene, camera ) {
	let renderTarget = null;
	let mrt = null;
	let activeCubeFace = 0;
	let activeMipmapLevel = 0;
	try { renderTarget = typeof slimRenderer.getRenderTarget === 'function' ? slimRenderer.getRenderTarget() : null; } catch ( _ ) {}
	try { mrt = typeof slimRenderer.getMRT === 'function' ? slimRenderer.getMRT() : null; } catch ( _ ) {}
	try { activeCubeFace = typeof slimRenderer.getActiveCubeFace === 'function' ? slimRenderer.getActiveCubeFace() : 0; } catch ( _ ) {}
	try { activeMipmapLevel = typeof slimRenderer.getActiveMipmapLevel === 'function' ? slimRenderer.getActiveMipmapLevel() : 0; } catch ( _ ) {}
	return { scene, camera, renderTarget, mrt, activeCubeFace, activeMipmapLevel };
}

function __sameMaterialComputeRenderRequest( first, second ) {
	return !! first && !! second
		&& first.scene === second.scene
		&& first.camera === second.camera
		&& first.renderTarget === second.renderTarget
		&& first.mrt === second.mrt
		&& first.activeCubeFace === second.activeCubeFace
		&& first.activeMipmapLevel === second.activeMipmapLevel;
}

function __presentDelegatedMaterialCompute( slimRenderer, request ) {
	const restore = __snapshotMaterialComputeRenderRequest( slimRenderer, null, null );
	let presented = false;
	try {
		if ( typeof slimRenderer.setRenderTarget === 'function' ) slimRenderer.setRenderTarget( request.renderTarget, request.activeCubeFace, request.activeMipmapLevel );
		if ( typeof slimRenderer.setMRT === 'function' ) slimRenderer.setMRT( request.mrt );
		slimRenderer.__tslpMaterialComputePresentationRender = true;
		slimRenderer.render( request.scene, request.camera );
		presented = true;
	} finally {
		slimRenderer.__tslpMaterialComputePresentationRender = false;
		try {
			if ( typeof slimRenderer.setRenderTarget === 'function' ) slimRenderer.setRenderTarget( restore.renderTarget, restore.activeCubeFace, restore.activeMipmapLevel );
			if ( typeof slimRenderer.setMRT === 'function' ) slimRenderer.setMRT( restore.mrt );
		} catch ( _ ) {}
	}
	if ( presented ) __markSuccessfulReplayPresentation( slimRenderer );
}

function __startMaterialComputeDispatch( slimRenderer, state, request ) {
	state.active = request;
	__recordSemanticOperation( 'material-compute', 'dispatch-and-present', 'attempted' );
	window.__tslpComputePending = ( window.__tslpComputePending | 0 ) + 1;
	const dispatchErrors = [];
	const job = __getComputeRenderer( slimRenderer ).then( ( fullRenderer ) => {
		if ( ! fullRenderer ) throw new Error( 'Full renderer unavailable for material-compute delegation.' );
		return __materialComputeSceneSupportFor( slimRenderer ).dispatchMaterialComputes( request.scene, {
			fullRenderer,
			onError( error ) { dispatchErrors.push( error ); },
		} );
	} ).then( ( stats ) => {
		if ( ! stats || stats.errors > 0 ) {
			throw dispatchErrors[ 0 ] || new Error( 'Material-compute delegation failed without a typed runtime error.' );
		}
		__presentDelegatedMaterialCompute( slimRenderer, request );
		__recordSemanticOperation( 'material-compute', 'dispatch-and-present', 'succeeded' );
	} ).catch( ( error ) => {
		__recordSemanticOperation( 'material-compute', 'dispatch-and-present', 'failed', error );
		console.info( '[tslp-e2e] structured material compute delegation failure:', error && ( error.stack || error.message ) || error );
	} ).finally( () => {
		window.__tslpComputePending = Math.max( 0, ( window.__tslpComputePending | 0 ) - 1 );
		state.pending = null;
		state.active = null;
		const queued = state.queued;
		state.queued = null;
		if ( queued ) __startMaterialComputeDispatch( slimRenderer, state, queued );
	} );
	state.pending = job;
}

function __deferHybridMaterialComputeRender( scene, camera, slimRenderer ) {
	if ( slimRenderer.__tslpMaterialComputePresentationRender === true ) return false;
	if ( ! __sceneRequiresMaterialComputeDelegation( scene ) ) return false;
	__expectSemanticOperation( 'material-compute', 'dispatch-and-present' );
	const request = __snapshotMaterialComputeRenderRequest( slimRenderer, scene, camera );
	let state = __materialComputeDispatchStateByRenderer.get( slimRenderer );
	if ( ! state ) {
		state = { active: null, queued: null, pending: null };
		__materialComputeDispatchStateByRenderer.set( slimRenderer, state );
	}
	if ( state.pending ) {
		// Repeated animation renders for the same surface are represented by the
		// active transaction. Preserve one distinct request (split view / cube face)
		// behind it without building an unbounded RAF queue.
		if ( ! __sameMaterialComputeRenderRequest( state.active, request ) ) state.queued = request;
		return true;
	}
	__startMaterialComputeDispatch( slimRenderer, state, request );
	return true;
}

function __dispatchAutoComputeNodes( scene, slimRenderer ) {
	if ( ! scene || typeof scene.traverse !== 'function' || ! slimRenderer ) return;
	let dispatcher = __autoComputeDispatcherByRenderer.get( slimRenderer );
	if ( ! dispatcher ) {
		dispatcher = __sharedCreateAutoComputeDispatcher( {
			renderer: slimRenderer,
			onError: ( err ) => console.warn( '[tslp-e2e] auto-compute failed:', err && err.message || err ),
		} );
		__autoComputeDispatcherByRenderer.set( slimRenderer, dispatcher );
	}
	const frozen = typeof window !== 'undefined' && window.__tslpFrozen === true;
	void dispatcher.dispatch( scene, {
		fullRenderer: __computeRendererBySlim.get( slimRenderer ) || null,
		shouldDispatch: () => slimRenderer.__tslpPostComputeRendering !== true,
		dispatchOnce: frozen ? __frozenDispatchedAutoComputeNodes : undefined,
		dispatchNode( node ) { return slimRenderer.compute( node ); },
	} ).catch( ( err ) => console.warn( '[tslp-e2e] auto-compute dispatch failed:', err && err.message || err ) );
}

// Lazy full-three.js compute renderer that shares the slim renderer's GPU
// device. The slim NodeManager can only dispatch PrecompiledComputeNode; raw
// TSL ComputeNodes (isComputeNode=true, isPrecompiledCompute!=true) need a
// real NodeBuilder. We create a single auxiliary WebGPURenderer from the
// unpatched three.webgpu.js, passing the already-initialised GPU device so
// both renderers operate on the SAME WebGPU device — and therefore on the same
// storage buffers written by instancedArray().
// After fullRenderer.computeAsync() resolves, the full renderer owns the GPUBuffers
// that compute wrote into. If the slim renderer has no buffer yet for an attribute,
// we pre-seed the DataMap so the slim renderer's first createAttribute call finds it
// and skips allocation (vertex+storage attribute path checks: if void 0 === r.buffer).
// If the slim renderer already has a separate buffer (from a prior render that ran
// before the first compute, e.g., an init render), we GPU-copy the compute output
// INTO that buffer via copyBufferToBuffer. The slim renderer's cached bind group
// still references the same GPUBuffer; we just update its content. Both renderers
// share the same GPUDevice so the copy is entirely on-GPU (no CPU round-trip).
function __computeNodeUsesStorageTexture( computeNode, fullRenderer ) {
	return __sharedComputeNodeUsesStorageTexture( computeNode, fullRenderer );
}

function __shareComputeSampledInputs( computeNode, fullRenderer, slimRenderer ) {
	return __sharedShareComputeSampledInputs( computeNode, fullRenderer, slimRenderer, {
		onError: ( err ) => console.warn( '[tslp-e2e] compute input texture share failed:', err && err.message || err ),
	} );
}

function __wireSceneComputeAttrsFromFallbacks( scene, renderer = null ) {
	if ( ! scene || typeof scene.traverse !== 'function' || __computeStorageAttrsFor( renderer ).length === 0 ) return;
	let invalidated = false;
	scene.traverse( ( object ) => {
		const material = object && object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const m of list ) {
			if ( ! ( m && m.isPrecompiledMaterial === true && m.precompiledArtifact ) ) continue;
				const wired = __wireComputeAttrsToArtifact( m.precompiledArtifact, m, renderer ) | 0;
				if ( wired > 0 ) {
					m.needsUpdate = true;
					try {
						const nodes = renderer && renderer._nodes;
					if ( nodes && typeof nodes.delete === 'function' ) nodes.delete( m );
				} catch ( _ ) {}
				try { m.dispose(); } catch ( _ ) {}
				invalidated = true;
			}
		}
	} );
	if ( invalidated && renderer ) {
		try {
			const nc = renderer._nodes && renderer._nodes.nodeBuilderCache;
			if ( nc && typeof nc.clear === 'function' ) nc.clear();
		} catch ( _ ) {}
	}
}

function __driveRendererLightingUpdateBefore( renderer, scene, camera ) {
	const diag = __computeDiagnostics();
	const stats = __sharedUpdateRendererLightingForSlim( renderer, scene, camera, {
		diagnostics: diag || undefined,
		guardKey: '__tslpInsideReplayUpdateBefore',
		onStorageAttribute: ( attr ) => {
			__rememberComputeStorageAttr( attr, null, renderer );
			__wireSceneComputeAttrsFromFallbacks( scene, renderer );
		},
		onError: ( err ) => {
			if ( ! window.__tslpLightingUpdateBeforeWarned ) {
				window.__tslpLightingUpdateBeforeWarned = true;
				console.warn( '[tslp-e2e] lighting updateBefore replay failed:', err && err.message || err );
			}
		},
	} );
	return stats && ( stats.updated || stats.cpuTiled ) ? 1 : 0;
}

// Thin wrapper — see @tsl-precompile/runtime/slim-support/compute-sync for
// the storage-texture + storage-buffer copy/adopt logic. The harness still
// owns the post-sync attribute-fallback wiring and the storage-attr ledger,
// passed in via opts.
//
// Bookkeeping for Wedge 3 productized primitives:
//   * __computePassByNode tracks pass index per compute node so successive
//     dispatches of the same kernel (bitonic sort / reduction) call
//     syncComputeStorageOutputsPerPass with monotonic pass indices.
//   * __computeStorageTextureLedger tracks the previous storage texture
//     output(s) per compute node; on a mismatch we run pingPongInvalidate
//     so slim's bind-group cache rebuilds against the freshly-swapped texture.
//   * Storage instanced attributes go through
//     shareInstancedAttributeBufferIntoSlim after the primary sync so slim's
//     vertex-pull path sees the compute kernel's GPUBuffer.
const __computePassByNode = new WeakMap();
const __computeStorageTextureLedger = new WeakMap();

function __syncStorageBuffers( computeNode, fullRenderer, slimRenderer ) {
	const nodeKey = ( computeNode && typeof computeNode === 'object' ) ? computeNode : null;
	const passIndex = nodeKey ? ( __computePassByNode.get( nodeKey ) | 0 ) : 0;
	if ( nodeKey ) __computePassByNode.set( nodeKey, passIndex + 1 );

	const seenStorageTextures = [];
	const seenStorageAttrs = [];

	const syncStats = __sharedSyncComputeStorageOutputsPerPass( computeNode, fullRenderer, slimRenderer, passIndex, {
		onStorageAttr: ( attr, binding ) => {
			__rememberComputeStorageAttr( attr, binding, slimRenderer );
			seenStorageAttrs.push( attr );
		},
		onStorageTexture: ( tex ) => { seenStorageTextures.push( tex ); },
		onError: ( err ) => console.warn( '[tslp-e2e] storage buffer sync failed:', err && err.message || err ),
	} );

	// Ping-pong texture invalidation: if a previous dispatch wrote to a
	// different storage texture than this one, invalidate both so slim's
	// cached bind group rebuilds against the live (just-written) resource.
	if ( nodeKey && seenStorageTextures.length > 0 ) {
		const prev = __computeStorageTextureLedger.get( nodeKey );
		if ( prev && prev.length > 0 ) {
			for ( const tex of seenStorageTextures ) {
				for ( const prevTex of prev ) {
					if ( prevTex && prevTex !== tex ) {
						try { __sharedPingPongInvalidate( prevTex, tex, [ slimRenderer, fullRenderer ] ); }
						catch ( _ ) {}
					}
				}
			}
		}
		__computeStorageTextureLedger.set( nodeKey, seenStorageTextures.slice() );
	}

	// Compute-driven instance attributes: when the slim renderer's vertex
	// pull reads an InstancedBufferAttribute whose underlying GPUBuffer the
	// full renderer just wrote to, adopt the buffer reference into slim so
	// the next draw call samples the live compute output rather than a
	// zeroed stand-in.
	for ( const attr of seenStorageAttrs ) {
		if ( ! attr ) continue;
		if ( attr.isStorageInstancedBufferAttribute === true || attr.isInstancedBufferAttribute === true ) {
			try { __sharedShareInstancedAttributeBufferIntoSlim( attr, fullRenderer, slimRenderer ); }
			catch ( _ ) {}
		}
	}

	__wireSceneComputeAttrsFromFallbacks( slimRenderer && slimRenderer._lastScene, slimRenderer );
	const diag = __computeDiagnostics();
	if ( diag ) {
		diag.syncCalls = ( diag.syncCalls | 0 ) + 1;
		diag.syncStorageAttrs = ( diag.syncStorageAttrs | 0 ) + seenStorageAttrs.length;
		diag.buffersAdopted = ( diag.buffersAdopted | 0 ) + ( syncStats && syncStats.buffersAdopted | 0 );
		diag.buffersCopied = ( diag.buffersCopied | 0 ) + ( syncStats && syncStats.buffersCopied | 0 );
		diag.texturesShared = ( diag.texturesShared | 0 ) + ( syncStats && syncStats.texturesShared | 0 );
	}
	return {
		...( syncStats || {} ),
		storageAttrs: syncStats && Number.isFinite( syncStats.storageAttrs ) ? syncStats.storageAttrs : seenStorageAttrs.length,
		storageTextures: seenStorageTextures.length,
	};
}

// Lazy full-WebGPURenderer boot — productized through
// slim-support/full-renderer-fallback. The fallback owns the shared-device
// init, the de-duplicated promise, and the shadowMap.enabled flip; we keep
// __computeRenderer and __fullThreeMod as in-page references because
// other harness helpers (__makeFullSceneForPMREM, __rememberStorageAttr,
// __convertGeometryToFullThree) read them synchronously.
let __computeRenderer = null;
let __fullThreeMod = null;
const __computeRendererBySlim = new WeakMap();
const __computeRendererInitBySlim = new WeakMap();
const __fullRendererFallbackBySlim = new WeakMap();
let __renderFallbackRenderer = null;

function __nodeBuilderLikeFromState( state ) {
	if ( ! state ) return null;
	if ( typeof state.build === 'function' && typeof state.getBindings === 'function' ) return state;
	return {
		vertexShader: state.vertexShader || '',
		fragmentShader: state.fragmentShader || '',
		computeShader: state.computeShader || '',
		nodeAttributes: state.nodeAttributes || [],
		bindings: state.bindings || [],
		updateNodes: state.updateNodes || [],
		updateBeforeNodes: state.updateBeforeNodes || [],
		updateAfterNodes: state.updateAfterNodes || [],
		observer: state.observer || null,
		transforms: state.transforms || [],
		getAttributesArray() { return this.nodeAttributes; },
		getBindings() { return this.bindings; },
		build() {},
		buildAsync: async () => {},
	};
}

function __registerSlimRenderFallback( fullRenderer ) {
	if ( ! fullRenderer || __renderFallbackRenderer === fullRenderer ) return !! fullRenderer;
	const nodeManager = fullRenderer.nodes || fullRenderer._nodes;
	if ( ! nodeManager || typeof Slim.setSlimRenderFallback !== 'function' ) return false;
	Slim.setSlimRenderFallback( ( renderObject ) => {
		try {
			if ( typeof nodeManager.getForRender === 'function' ) {
				const result = nodeManager.getForRender( renderObject );
				if ( result && typeof result.then === 'function' ) return null;
				return __nodeBuilderLikeFromState( result );
			}
			if ( typeof nodeManager._createNodeBuilder === 'function' ) {
				return nodeManager._createNodeBuilder( renderObject, renderObject && renderObject.material );
			}
		} catch ( err ) {
			if ( ! window.__tslpRenderFallbackWarned ) {
				window.__tslpRenderFallbackWarned = true;
				console.warn( '[tslp-e2e] slim render fallback failed:', err && ( err.stack || err.message ) || err );
			}
		}
		return null;
	} );
	__renderFallbackRenderer = fullRenderer;
	return true;
}

async function __getComputeRenderer( slimRenderer ) {
	if ( ! __shouldInitializeSharedDeviceFallback( slimRenderer ) ) return null;
	if ( slimRenderer ) {
		const cached = __computeRendererBySlim.get( slimRenderer );
		if ( cached ) {
			__computeRenderer = cached;
			__registerSlimRenderFallback( cached );
			return cached;
		}
		const pending = __computeRendererInitBySlim.get( slimRenderer );
		if ( pending ) return pending;
	}
	const init = ( async () => {
		let fallback = slimRenderer ? __fullRendererFallbackBySlim.get( slimRenderer ) : null;
		if ( ! fallback ) {
			fallback = __sharedCreateFullRendererFallback( {
				slimRenderer,
				loadThreeFullModule: async () => {
					const mod = await import( '/build/three.webgpu.js' );
					__fullThreeMod = mod;
					return mod;
				},
				onError: ( err ) => console.warn( '[tslp-e2e] compute renderer init failed:', err && err.message || err ),
			} );
			if ( slimRenderer ) __fullRendererFallbackBySlim.set( slimRenderer, fallback );
		}
			const r = await fallback.getRenderer();
			if ( r ) {
				__computeRenderer = r;
				try { window.__tslpComputeRenderer = r; } catch ( _ ) {}
				if ( slimRenderer ) __computeRendererBySlim.set( slimRenderer, r );
				// Live fallback materials can outgrow the 1x1 texture views they
				// compiled during startup. Install the same bind-group refresh
				// guard used by the presentation renderer before fallback work.
				__patchBindGroupLayoutRefresh( r );
				__patchShadowBindingUpdateDiagnostics( r );
				__registerSlimRenderFallback( r );
			}
		return r;
	} )();
	if ( slimRenderer ) __computeRendererInitBySlim.set( slimRenderer, init );
	return init;
}

function __runReplayComputeInit( slimRenderer, computeNode ) {
	const onInitFn = computeNode && computeNode.onInitFunction;
	if ( typeof onInitFn !== 'function' || computeNode.__tslpReplayInitDone === true ) return Promise.resolve();

	computeNode.__tslpReplayInitDone = true;
	try { computeNode.onInitFunction = null; } catch ( _ ) {}

	try {
		return Promise.resolve( onInitFn.call( computeNode, { renderer: slimRenderer } ) );
	} catch ( err ) {
		return Promise.reject( err );
	}
}

// ============================================================================
// Shadow-map population (slim has shadow render pass tree-shaken)
//
// The slim renderer never allocates light.shadow.map. The hydrator's
// createShadowDepthRebinder rebinds texture_depth_2d bindings to live
// light.shadow.map.depthTexture — but they're null without help.
//
// We piggyback on the full WebGPURenderer (already initialised for compute
// and PMREM, sharing the slim's GPU device). For each shadow-using scene we
// build a parallel "shadow scene" with stand-in MeshBasicNodeMaterial meshes
// that mirror the user's castShadow/receiveShadow flags, plus shared Light
// references. fullRenderer.render(shadowScene, camera) triggers three.js's
// shadow pass which allocates light.shadow.map (a RenderTarget) ON THE
// SHARED LIGHT OBJECT — slim's rebinder then resolves to a real depth map.
//
// We render to an offscreen RenderTarget so the canvas is left alone.
// ============================================================================

const __shadowSceneCache = new WeakMap(); // user-scene -> shadow-scene
const __shadowSceneMap = new WeakMap();   // user-scene -> { meshCount }
const __shadowGeometryCache = new WeakMap(); // slim geometry -> full geometry
const __shadowDiscardRT = { rt: null };
const __shadowCoverageRT = { rt: null, material: null };
const __shadowDepthViewRT = { rt: null, material: null, quad: null, texture: null };

function __sceneHasShadowLights( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return false;
	let found = false;
	scene.traverse( ( o ) => {
		if ( found ) return;
		if ( o && o.isLight === true && o.castShadow === true && o.shadow ) found = true;
	} );
	return found;
}

function __cloneAttributeForFullRenderer( attr ) {
	if ( ! attr || ! __fullThreeMod ) return attr;
	const FullThree = __fullThreeMod;
	try {
		if ( attr.isInstancedBufferAttribute === true && FullThree.InstancedBufferAttribute && attr.array && Number.isInteger( attr.itemSize ) ) {
			const meshPerAttribute = Number.isFinite( attr.meshPerAttribute ) ? attr.meshPerAttribute : 1;
			const fullAttr = new FullThree.InstancedBufferAttribute( attr.array, attr.itemSize, attr.normalized === true, meshPerAttribute );
			if ( typeof attr.usage === 'number' ) fullAttr.setUsage( attr.usage );
			return fullAttr;
		}
		if ( attr.isInterleavedBufferAttribute === true && FullThree.InterleavedBuffer && FullThree.InterleavedBufferAttribute ) {
			const data = attr.data;
			const fullData = new FullThree.InterleavedBuffer( data.array, data.stride );
			if ( typeof data.usage === 'number' ) fullData.setUsage( data.usage );
			return new FullThree.InterleavedBufferAttribute( fullData, attr.itemSize, attr.offset, attr.normalized );
		}
		if ( FullThree.BufferAttribute && attr.array && Number.isInteger( attr.itemSize ) ) {
			const fullAttr = new FullThree.BufferAttribute( attr.array, attr.itemSize, attr.normalized === true );
			if ( typeof attr.usage === 'number' ) fullAttr.setUsage( attr.usage );
			return fullAttr;
		}
	} catch ( _ ) {}
	return attr;
}

function __cloneGeometryForFullRenderer( geometry ) {
	if ( ! geometry || ! __fullThreeMod ) return geometry;
	if ( __shadowGeometryCache.has( geometry ) ) return __shadowGeometryCache.get( geometry );
	const { BufferGeometry } = __fullThreeMod;
	if ( ! BufferGeometry ) return geometry;
	const cloned = new BufferGeometry();
	try {
		cloned.name = geometry.name || '';
		if ( geometry.index ) cloned.setIndex( __cloneAttributeForFullRenderer( geometry.index ) );
		const attributes = geometry.attributes || {};
		for ( const name in attributes ) cloned.setAttribute( name, __cloneAttributeForFullRenderer( attributes[ name ] ) );
		const morphAttributes = geometry.morphAttributes || {};
		for ( const name in morphAttributes ) {
			cloned.morphAttributes[ name ] = morphAttributes[ name ].map( ( attr ) => __cloneAttributeForFullRenderer( attr ) );
		}
		cloned.morphTargetsRelative = geometry.morphTargetsRelative === true;
		if ( geometry.drawRange ) cloned.setDrawRange( geometry.drawRange.start || 0, geometry.drawRange.count === undefined ? Infinity : geometry.drawRange.count );
		if ( Array.isArray( geometry.groups ) ) {
			for ( const group of geometry.groups ) cloned.addGroup( group.start || 0, group.count || 0, group.materialIndex || 0 );
		}
		if ( geometry.boundingBox && typeof geometry.boundingBox.clone === 'function' ) cloned.boundingBox = geometry.boundingBox.clone();
		if ( geometry.boundingSphere && typeof geometry.boundingSphere.clone === 'function' ) cloned.boundingSphere = geometry.boundingSphere.clone();
	} catch ( _ ) {
		__shadowGeometryCache.set( geometry, geometry );
		return geometry;
	}
	__shadowGeometryCache.set( geometry, cloned );
	return cloned;
}

function __fullLightColorValue( light ) {
	const color = light && light.color;
	if ( color && typeof color.getHex === 'function' ) {
		try { return color.getHex(); } catch ( _ ) {}
	}
	if ( color && Number.isFinite( color.r ) && Number.isFinite( color.g ) && Number.isFinite( color.b ) ) {
		return ( Math.round( Math.min( 1, Math.max( 0, color.r ) ) * 255 ) << 16 )
			| ( Math.round( Math.min( 1, Math.max( 0, color.g ) ) * 255 ) << 8 )
			| Math.round( Math.min( 1, Math.max( 0, color.b ) ) * 255 );
	}
	return 0xffffff;
}

function __nodeAttributeSnapshotArray( entry ) {
	const array = entry && ( entry.arraySnapshot || entry._liveArray ) || null;
	return array && typeof array.length === 'number' ? array : null;
}

function __nodeAttributeSpreadScore( entry ) {
	const array = __nodeAttributeSnapshotArray( entry );
	const itemSize = entry && ( entry.itemSize || 0 ) || 0;
	const count = entry && ( entry.count || 0 ) || 0;
	if ( ! array || itemSize < 3 || count <= 0 ) return - Infinity;
	let minX = Infinity, minY = Infinity, minZ = Infinity;
	let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;
	for ( let i = 0; i < count; i ++ ) {
		const offset = i * itemSize;
		const x = Number( array[ offset ] );
		const y = Number( array[ offset + 1 ] );
		const z = Number( array[ offset + 2 ] );
		if ( ! Number.isFinite( x ) || ! Number.isFinite( y ) || ! Number.isFinite( z ) ) continue;
		minX = Math.min( minX, x ); minY = Math.min( minY, y ); minZ = Math.min( minZ, z );
		maxX = Math.max( maxX, x ); maxY = Math.max( maxY, y ); maxZ = Math.max( maxZ, z );
	}
	if ( minX === Infinity ) return - Infinity;
	const dx = maxX - minX;
	const dy = maxY - minY;
	const dz = maxZ - minZ;
	return dx * dx + dy * dy + dz * dz;
}

function __shadowProxyArtifactForObject( object ) {
	const material = object && object.material;
	const list = Array.isArray( material ) ? material : material ? [ material ] : [];
	for ( const mat of list ) {
		if ( mat && mat.isPrecompiledMaterial === true && mat.precompiledArtifact ) return mat.precompiledArtifact;
	}
	return null;
}

function __shaderInstancedShadowProxyAttributes( object ) {
	const artifact = __shadowProxyArtifactForObject( object );
	const entries = Array.isArray( artifact && artifact.attributes ) ? artifact.attributes : Array.isArray( artifact && artifact.nodeAttributes ) ? artifact.nodeAttributes : [];
	const candidates = entries.filter( ( entry ) => entry && entry.source === 'node' && entry.instanced === true && ! entry.userPath && __nodeAttributeSnapshotArray( entry ) );
	if ( candidates.length === 0 ) return null;
	let position = null;
	let bestScore = - Infinity;
	for ( const entry of candidates ) {
		const score = __nodeAttributeSpreadScore( entry );
		if ( score > bestScore ) {
			position = entry;
			bestScore = score;
		}
	}
	if ( ! position || bestScore <= 0 ) return null;
	const count = Math.min( object && object.count || position.count || 0, position.count || 0 );
	if ( count <= 0 ) return null;
	let scale = null;
	const vertexShader = String( artifact && artifact.vertexShader || '' );
	scale = candidates.find( ( entry ) => entry !== position && entry.name && vertexShader.includes( entry.name + '.x' ) ) || null;
	const normal = candidates.find( ( entry ) => entry !== position && entry !== scale && entry.name && (
		vertexShader.includes( entry.name + ' * vec3<f32>( abs' ) ||
		vertexShader.includes( entry.name + ' * vec3( abs' )
	) ) || null;
	return { position, scale, normal, count };
}

function __makeShaderInstancedShadowProxy( sourceObject, geometry, material ) {
	if ( ! sourceObject || ! __fullThreeMod ) return null;
	const { InstancedMesh: FullInstancedMesh, Matrix4: FullMatrix4 } = __fullThreeMod;
	if ( ! FullInstancedMesh || ! FullMatrix4 ) return null;
	const proxy = __shaderInstancedShadowProxyAttributes( sourceObject );
	if ( ! proxy ) return null;
	const posArray = __nodeAttributeSnapshotArray( proxy.position );
	const posSize = proxy.position.itemSize || 3;
	const scaleArray = __nodeAttributeSnapshotArray( proxy.scale );
	const scaleSize = proxy.scale && proxy.scale.itemSize || 0;
	const normalArray = __nodeAttributeSnapshotArray( proxy.normal );
	const normalSize = proxy.normal && proxy.normal.itemSize || 0;
	if ( ! posArray || posSize < 3 ) return null;
	let standin = null;
	try {
		standin = new FullInstancedMesh( geometry, material, proxy.count );
		const matrix = new FullMatrix4();
		for ( let i = 0; i < proxy.count; i ++ ) {
			const posOffset = i * posSize;
			let instanceScale = 1;
			let normalOffset = 0;
			if ( scaleArray && scaleSize > 0 ) {
				const scaleValue = Math.abs( Number( scaleArray[ i * scaleSize ] ) );
				if ( Number.isFinite( scaleValue ) && scaleValue > 0 ) instanceScale = 1 + scaleValue * 2;
				if ( scaleSize > 2 ) {
					const seed = Number( scaleArray[ i * scaleSize + 2 ] );
					if ( Number.isFinite( seed ) ) normalOffset = Math.abs( Math.sin( seed * 2 ) * 1.5 );
				}
			}
			const normalOffsetBase = i * normalSize;
			const offsetX = normalArray && normalSize >= 3 ? ( Number( normalArray[ normalOffsetBase ] ) || 0 ) * normalOffset : 0;
			const offsetY = normalArray && normalSize >= 3 ? ( Number( normalArray[ normalOffsetBase + 1 ] ) || 0 ) * normalOffset : 0;
			const offsetZ = normalArray && normalSize >= 3 ? ( Number( normalArray[ normalOffsetBase + 2 ] ) || 0 ) * normalOffset : 0;
			matrix.makeScale( instanceScale, instanceScale, instanceScale );
			matrix.setPosition( ( Number( posArray[ posOffset ] ) || 0 ) + offsetX, ( Number( posArray[ posOffset + 1 ] ) || 0 ) + offsetY, ( Number( posArray[ posOffset + 2 ] ) || 0 ) + offsetZ );
			standin.setMatrixAt( i, matrix );
		}
		standin.count = proxy.count;
		if ( standin.instanceMatrix ) standin.instanceMatrix.needsUpdate = true;
		__copyMorphStateForFullRenderer( sourceObject, standin );
		return standin;
	} catch ( _ ) {
		return null;
	}
}

function __copyMorphStateForFullRenderer( sourceObject, standin ) {
	if ( ! sourceObject || ! standin ) return;
	try {
		if ( sourceObject.morphTargetDictionary !== undefined ) {
			standin.morphTargetDictionary = { ...sourceObject.morphTargetDictionary };
		}
		const influences = sourceObject.morphTargetInfluences;
		if ( Array.isArray( influences ) ) {
			if ( ! Array.isArray( standin.morphTargetInfluences ) || standin.morphTargetInfluences.length !== influences.length ) {
				standin.morphTargetInfluences = influences.slice();
			} else {
				for ( let i = 0; i < influences.length; i ++ ) standin.morphTargetInfluences[ i ] = influences[ i ];
			}
		}
		if ( sourceObject.isInstancedMesh === true && sourceObject.morphTexture !== null && sourceObject.morphTexture !== undefined ) {
			standin.morphTexture = sourceObject.morphTexture;
			if ( sourceObject.morphTexture.needsUpdate === true ) standin.morphTexture.needsUpdate = true;
		}
	} catch ( _ ) {}
}

function __sourceObjectWorldBounds( sourceObject ) {
	if ( ! sourceObject || ! __fullThreeMod ) return null;
	const { Box3: FullBox3, Vector3: FullVector3 } = __fullThreeMod;
	if ( ! FullBox3 || ! FullVector3 ) return null;
	let srcBox = null;
	try {
		if ( typeof sourceObject.computeBoundingBox === 'function' ) sourceObject.computeBoundingBox();
		if ( sourceObject.boundingBox && sourceObject.boundingBox.min && sourceObject.boundingBox.max ) srcBox = sourceObject.boundingBox;
	} catch ( _ ) {}
	if ( ! srcBox && sourceObject.geometry && sourceObject.geometry.boundingBox && sourceObject.geometry.boundingBox.min && sourceObject.geometry.boundingBox.max ) {
		srcBox = sourceObject.geometry.boundingBox;
	}
	if ( ! srcBox && sourceObject.geometry && typeof sourceObject.geometry.computeBoundingBox === 'function' ) {
		try {
			sourceObject.geometry.computeBoundingBox();
			srcBox = sourceObject.geometry.boundingBox;
		} catch ( _ ) {}
	}
	if ( ! srcBox || ! srcBox.min || ! srcBox.max ) return null;
	const box = new FullBox3(
		new FullVector3( srcBox.min.x || 0, srcBox.min.y || 0, srcBox.min.z || 0 ),
		new FullVector3( srcBox.max.x || 0, srcBox.max.y || 0, srcBox.max.z || 0 )
	);
	try { if ( sourceObject.matrixWorld ) box.applyMatrix4( sourceObject.matrixWorld ); } catch ( _ ) {}
	const size = new FullVector3();
	const center = new FullVector3();
	box.getSize( size );
	box.getCenter( center );
	if ( ! Number.isFinite( size.x ) || ! Number.isFinite( size.y ) || ! Number.isFinite( size.z ) ) return null;
	if ( size.x <= 0 || size.y <= 0 || size.z <= 0 ) return null;
	if ( size.x > 20 || size.y > 20 || size.z > 20 ) return null;
	return { box, size, center };
}

function __makeSkinnedShadowProxy( sourceObject, material ) {
	if ( ! sourceObject || ! __fullThreeMod ) return null;
	const {
		BoxGeometry: FullBoxGeometry,
		BufferAttribute: FullBufferAttribute,
		BufferGeometry: FullBufferGeometry,
		CapsuleGeometry: FullCapsuleGeometry,
		Mesh: FullMesh,
		Vector3: FullVector3,
	} = __fullThreeMod;
	const sourceGeometry = sourceObject.geometry || null;
	const sourcePosition = sourceGeometry && ( typeof sourceGeometry.getAttribute === 'function'
		? sourceGeometry.getAttribute( 'position' )
		: sourceGeometry.attributes && sourceGeometry.attributes.position ) || null;
	if ( FullMesh && FullBufferGeometry && FullBufferAttribute && FullVector3 && sourcePosition && Number.isInteger( sourcePosition.count ) && sourcePosition.count > 0 && typeof sourceObject.getVertexPosition === 'function' ) {
		try {
			const geometry = new FullBufferGeometry();
			geometry.name = sourceGeometry.name || '';
			if ( sourceGeometry.index ) geometry.setIndex( __cloneAttributeForFullRenderer( sourceGeometry.index ) );
			geometry.setAttribute( 'position', new FullBufferAttribute( new Float32Array( sourcePosition.count * 3 ), 3 ) );
			if ( sourceGeometry.drawRange ) geometry.setDrawRange( sourceGeometry.drawRange.start || 0, sourceGeometry.drawRange.count === undefined ? Infinity : sourceGeometry.drawRange.count );
			if ( Array.isArray( sourceGeometry.groups ) ) {
				for ( const group of sourceGeometry.groups ) geometry.addGroup( group.start || 0, group.count || 0, group.materialIndex || 0 );
			}
			const standin = new FullMesh( geometry, material );
			standin.__tslpSkinnedShadowProxy = true;
			standin.__tslpSkinnedShadowVector = new FullVector3();
			if ( __updateSkinnedShadowProxyGeometry( sourceObject, standin ) ) return standin;
		} catch ( _ ) {}
	}
	if ( ! FullMesh || ( ! FullCapsuleGeometry && ! FullBoxGeometry ) ) return null;
	const bounds = __sourceObjectWorldBounds( sourceObject );
	let size = bounds && bounds.size || null;
	let center = bounds && bounds.center || null;
	if ( ! size || ! center ) {
		size = new FullVector3( 0.7, 1.8, 0.45 );
		center = new FullVector3();
		try {
			if ( sourceObject.matrixWorld && sourceObject.matrixWorld.elements ) {
				const e = sourceObject.matrixWorld.elements;
				center.set( e[ 12 ] || 0, ( e[ 13 ] || 0 ) + size.y * 0.5, e[ 14 ] || 0 );
			}
		} catch ( _ ) {}
	}
	const width = Math.max( 0.16, Math.min( 0.42, size.x * 0.38 ) );
	const height = Math.max( 0.75, Math.min( 1.65, size.y * 0.82 ) );
	const depth = Math.max( 0.16, Math.min( 0.36, size.z * 0.38 ) );
	const radius = Math.max( 0.08, Math.min( width, depth ) * 0.5 );
	const geometry = FullCapsuleGeometry
		? new FullCapsuleGeometry( radius, Math.max( 0.2, height - radius * 2 ), 4, 8 )
		: new FullBoxGeometry( width, height, depth );
	const standin = new FullMesh( geometry, material );
	standin.position.copy( center );
	standin.__tslpWorldSpaceShadowProxy = true;
	return standin;
}

function __updateSkinnedShadowProxyGeometry( sourceObject, standin ) {
	if ( ! sourceObject || ! standin || standin.__tslpSkinnedShadowProxy !== true || typeof sourceObject.getVertexPosition !== 'function' ) return false;
	const geometry = standin.geometry || null;
	const position = geometry && ( typeof geometry.getAttribute === 'function' ? geometry.getAttribute( 'position' ) : geometry.attributes && geometry.attributes.position ) || null;
	const array = position && position.array || null;
	const count = position && position.count || 0;
	if ( ! array || ! count ) return false;
	const v = standin.__tslpSkinnedShadowVector || ( __fullThreeMod && __fullThreeMod.Vector3 ? new __fullThreeMod.Vector3() : null );
	if ( ! v ) return false;
	standin.__tslpSkinnedShadowVector = v;
	try {
		for ( let i = 0; i < count; i ++ ) {
			sourceObject.getVertexPosition( i, v );
			const offset = i * 3;
			array[ offset ] = v.x || 0;
			array[ offset + 1 ] = v.y || 0;
			array[ offset + 2 ] = v.z || 0;
		}
		position.needsUpdate = true;
		if ( geometry ) {
			geometry.boundingBox = null;
			geometry.boundingSphere = null;
		}
		return true;
	} catch ( _ ) {
		return false;
	}
}

function __shadowSourceMaterials( material ) {
	const input = Array.isArray( material ) ? material : material ? [ material ] : [];
	const out = [];
	for ( const mat of input ) {
		if ( ! mat ) continue;
		if ( ! out.includes( mat ) ) out.push( mat );
		const source = mat.__tslpSourceMaterial || null;
		if ( source && ! out.includes( source ) ) out.push( source );
	}
	return out;
}

function __buildShadowScene( userScene ) {
	if ( ! __fullThreeMod ) return null;
	// MeshLambertNodeMaterial samples lights and shadows — without a shadow-
	// sampling material in the scene, three.js's NodeBuilder skips ShadowNode
	// setup and light.shadow.map never allocates. Lambert is the cheapest
	// PCF-shadow-aware material we can stand-in for.
	const { Scene: FullScene, Mesh: FullMesh, InstancedMesh: FullInstancedMesh, MeshLambertMaterial, MeshLambertNodeMaterial, ClippingGroup: FullClippingGroup } = __fullThreeMod;
	if ( ! FullScene || ! FullMesh || ( ! MeshLambertMaterial && ! MeshLambertNodeMaterial ) ) return null;
	const StandinMaterial = MeshLambertNodeMaterial || MeshLambertMaterial;
	const shadowScene = new FullScene();
	const lightPairs = []; // { src, clone } so we can refresh transforms each render
	const meshPairs = []; // { src, clone } so we can refresh transforms each render
	const clipPairs = []; // { src, clone } so live GUI toggles update helper groups
	const clipParentCache = new WeakMap();
	function clipMountPointFor( sourceObject ) {
		if ( ! FullClippingGroup || ! sourceObject ) return shadowScene;
		const chain = [];
		let cursor = sourceObject.parent || null;
		while ( cursor ) {
			if ( cursor.isClippingGroup === true ) chain.unshift( cursor );
			cursor = cursor.parent || null;
		}
		if ( chain.length === 0 ) return shadowScene;
		let parent = shadowScene;
		for ( const srcGroup of chain ) {
			let cloneGroup = clipParentCache.get( srcGroup );
			if ( ! cloneGroup ) {
				cloneGroup = new FullClippingGroup();
				cloneGroup.clippingPlanes = srcGroup.clippingPlanes;
				cloneGroup.enabled = srcGroup.enabled;
				cloneGroup.clipIntersection = srcGroup.clipIntersection;
				cloneGroup.clipShadows = srcGroup.clipShadows;
				if ( srcGroup.layers && cloneGroup.layers ) cloneGroup.layers.mask = srcGroup.layers.mask;
				parent.add( cloneGroup );
				clipParentCache.set( srcGroup, cloneGroup );
				clipPairs.push( { src: srcGroup, clone: cloneGroup } );
			} else if ( cloneGroup.parent !== parent ) {
				parent.add( cloneGroup );
			}
			parent = cloneGroup;
		}
		return parent;
	}
	let meshCount = 0;
	let casterCount = 0;
	let lightCount = 0;
	// Make sure all matrices are current before reading.
	try { userScene.updateMatrixWorld( true ); } catch ( _ ) {}
	userScene.traverse( ( o ) => {
		if ( ! o ) return;
		// Lights: clone (so the original keeps its parent in the user scene),
		// but SHARE the LightShadow object by reference. Three.js's shadow
		// pass writes shadow.map onto cloned.shadow — because shadow is the
		// same LightShadow instance as the original, original.shadow.map is
		// populated too, and the slim hydrator's rebinder picks it up.
		if ( o.isLight === true && o.castShadow === true && o.shadow && o.visible !== false ) {
			let cloned = null;
			// Build a fresh light of the same type rather than cloning, to avoid
			// any inherited internal state that disables shadow allocation.
			try {
				const FullThree = __fullThreeMod;
				if ( o.isDirectionalLight && FullThree.DirectionalLight ) {
					cloned = new FullThree.DirectionalLight( __fullLightColorValue( o ), o.intensity || 1 );
				} else if ( o.isSpotLight && FullThree.SpotLight ) {
					cloned = new FullThree.SpotLight( __fullLightColorValue( o ), o.intensity || 1 );
					if ( o.distance !== undefined ) cloned.distance = o.distance;
					if ( o.angle !== undefined ) cloned.angle = o.angle;
					if ( o.penumbra !== undefined ) cloned.penumbra = o.penumbra;
					if ( o.decay !== undefined ) cloned.decay = o.decay;
				} else if ( o.isPointLight && FullThree.PointLight ) {
					cloned = new FullThree.PointLight( __fullLightColorValue( o ), o.intensity || 1 );
					if ( o.distance !== undefined ) cloned.distance = o.distance;
					if ( o.decay !== undefined ) cloned.decay = o.decay;
				} else if ( typeof o.clone === 'function' ) {
					cloned = o.clone();
				}
			} catch ( _ ) { cloned = null; }
			if ( cloned ) {
				cloned.visible = o.visible !== false;
				cloned.castShadow = true;
				cloned.shadow = o.shadow;
				// Copy mapSize/bias/normalBias/radius/camera params from source.shadow
				if ( cloned.shadow && o.shadow ) {
					if ( o.shadow.mapSize ) cloned.shadow.mapSize.copy( o.shadow.mapSize );
					if ( typeof o.shadow.bias === 'number' ) cloned.shadow.bias = o.shadow.bias;
					if ( typeof o.shadow.normalBias === 'number' ) cloned.shadow.normalBias = o.shadow.normalBias;
					if ( typeof o.shadow.radius === 'number' ) cloned.shadow.radius = o.shadow.radius;
					if ( o.shadow.camera ) {
						if ( typeof o.shadow.camera.near === 'number' ) cloned.shadow.camera.near = o.shadow.camera.near;
						if ( typeof o.shadow.camera.far === 'number' ) cloned.shadow.camera.far = o.shadow.camera.far;
						if ( typeof o.shadow.camera.zoom === 'number' ) cloned.shadow.camera.zoom = o.shadow.camera.zoom;
						if ( typeof o.shadow.camera.left === 'number' ) cloned.shadow.camera.left = o.shadow.camera.left;
						if ( typeof o.shadow.camera.right === 'number' ) cloned.shadow.camera.right = o.shadow.camera.right;
						if ( typeof o.shadow.camera.top === 'number' ) cloned.shadow.camera.top = o.shadow.camera.top;
						if ( typeof o.shadow.camera.bottom === 'number' ) cloned.shadow.camera.bottom = o.shadow.camera.bottom;
						if ( typeof o.shadow.camera.aspect === 'number' ) cloned.shadow.camera.aspect = o.shadow.camera.aspect;
						if ( typeof o.shadow.camera.fov === 'number' ) cloned.shadow.camera.fov = o.shadow.camera.fov;
						cloned.shadow.camera.updateProjectionMatrix();
					}
				}
				// Decompose the original light's world transform onto the
				// cloned light's local position/quaternion/scale. This way
				// matrixAutoUpdate stays true and three.js's matrix update
				// pipeline produces correct matrixWorld during render.
				if ( o.matrixWorld ) {
					o.matrixWorld.decompose( cloned.position, cloned.quaternion, cloned.scale );
				}
				if ( o.layers && cloned.layers ) cloned.layers.mask = o.layers.mask;
				// Directional / spot lights project shadows toward a target;
				// the target is also an Object3D in the user scene. Clone it
				// and parent under shadowScene to keep the projection correct.
				if ( o.target && o.target.isObject3D ) {
					const tgtClone = o.target.clone();
					if ( o.target.matrixWorld ) {
						o.target.matrixWorld.decompose( tgtClone.position, tgtClone.quaternion, tgtClone.scale );
					}
					if ( o.target.layers && tgtClone.layers ) tgtClone.layers.mask = o.target.layers.mask;
					shadowScene.add( tgtClone );
					cloned.target = tgtClone;
				}
				shadowScene.add( cloned );
				lightPairs.push( { src: o, clone: cloned } );
				lightCount ++;
			}
			return;
		}
		// Mirror shadow-relevant meshes with a basic node material so the full
		// renderer's NodeBuilder can compile them. The shadow pass overrides
		// material with ShadowPassMaterial for the depth render anyway.
		if ( ( o.isMesh === true || o.isSkinnedMesh === true ) && o.geometry && ( o.castShadow === true || o.receiveShadow === true ) ) {
			if ( o.isSkinnedMesh === true && /joint/i.test( o.name || '' ) ) return;
			let standinMaterial;
			try { standinMaterial = new StandinMaterial( { color: 0xffffff } ); } catch ( _ ) { standinMaterial = new StandinMaterial(); }
			try {
				if ( standinMaterial.color && typeof standinMaterial.color.setHex === 'function' ) standinMaterial.color.setHex( 0xffffff );
			} catch ( _ ) {}
			const shadowMaterials = __shadowSourceMaterials( o.material );
			const sourceMaterial = shadowMaterials.find( ( mat ) => mat && mat.__tslpSourceMaterial === undefined ) || shadowMaterials[ 0 ] || null;
			const exactPositionNode = sourceMaterial && (
				sourceMaterial.castShadowPositionNode && sourceMaterial.castShadowPositionNode.isNode === true
					? sourceMaterial.castShadowPositionNode
					: sourceMaterial.positionNode && sourceMaterial.positionNode.isNode === true
						? sourceMaterial.positionNode
						: null
			);
			let standin = null;
			if ( o.isInstancedMesh === true && FullInstancedMesh ) {
				const count = o.count || o.instanceMatrix && o.instanceMatrix.count || 1;
				standin = new FullInstancedMesh( __cloneGeometryForFullRenderer( o.geometry ), standinMaterial, count );
				standin.count = count;
				if ( o.instanceMatrix ) {
					try {
						standin.instanceMatrix = __cloneAttributeForFullRenderer( o.instanceMatrix );
						standin.instanceMatrix.needsUpdate = true;
					} catch ( _ ) {}
				}
				if ( o.instanceColor ) {
					try {
						standin.instanceColor = __cloneAttributeForFullRenderer( o.instanceColor );
						standin.instanceColor.needsUpdate = true;
					} catch ( _ ) {}
				}
				__copyMorphStateForFullRenderer( o, standin );
			}
			if ( ! standin ) {
				const fullGeometry = __cloneGeometryForFullRenderer( o.geometry );
				standin = o.isSkinnedMesh === true
					? __makeSkinnedShadowProxy( o, standinMaterial )
					: null;
				// A captured position graph that reads instanced node attributes is
				// already the exact instancing transform. Keep it on a plain Mesh:
				// synthesizing an InstancedMesh would apply instanceMatrix first and
				// then apply the graph's offsets a second time in NodeMaterial.
				standin = standin || ( exactPositionNode
					? new FullMesh( fullGeometry, standinMaterial )
					: __makeShaderInstancedShadowProxy( o, fullGeometry, standinMaterial ) || new FullMesh( fullGeometry, standinMaterial ) );
				__copyMorphStateForFullRenderer( o, standin );
			}
			if ( o.count !== undefined ) standin.count = o.count;
			standin.castShadow = !! o.castShadow;
			standin.receiveShadow = !! o.receiveShadow;
			standin.visible = o.visible !== false;
			// Decompose world matrix onto local position/quaternion/scale —
			// matrixAutoUpdate=true (default) ensures matrixWorld is rebuilt
			// during render's projectObject pass.
			if ( o.matrixWorld && standin.__tslpWorldSpaceShadowProxy !== true ) {
				o.matrixWorld.decompose( standin.position, standin.quaternion, standin.scale );
			}
			if ( o.layers && standin.layers ) standin.layers.mask = o.layers.mask;
			standin.frustumCulled = false;
			// Carry alpha-related fields that the depth pass uses.
			if ( sourceMaterial ) {
				for ( const key of [ 'side', 'shadowSide', 'alphaTest', 'transparent', 'opacity', 'depthTest', 'depthWrite', 'clipShadows', 'clippingPlanes' ] ) {
					if ( sourceMaterial[ key ] !== undefined ) standin.material[ key ] = sourceMaterial[ key ];
				}
				if ( sourceMaterial.alphaTest ) standin.material.alphaTest = sourceMaterial.alphaTest;
				if ( sourceMaterial.alphaMap ) standin.material.alphaMap = sourceMaterial.alphaMap;
				for ( const key of [ 'positionNode', 'alphaTestNode', 'maskNode', 'maskShadowNode', 'castShadowPositionNode', 'castShadowNode' ] ) {
					if ( sourceMaterial[ key ] && sourceMaterial[ key ].isNode === true ) standin.material[ key ] = sourceMaterial[ key ];
				}
			}
			clipMountPointFor( o ).add( standin );
			meshPairs.push( { src: o, clone: standin } );
			meshCount ++;
			if ( standin.castShadow === true ) casterCount ++;
		}
	} );
	if ( meshCount === 0 || lightCount === 0 || casterCount === 0 ) return null;
	shadowScene.__lightPairs = lightPairs;
	shadowScene.__meshPairs = meshPairs;
	shadowScene.__clipPairs = clipPairs;
	shadowScene.__casterCount = casterCount;
	__shadowSceneMap.set( userScene, { meshCount, lightCount } );
	return shadowScene;
}

// Refresh world transforms on the cloned shadow-scene objects from their live
// source counterparts so animations & camera-driven rigs cast accurate shadows.
function __refreshShadowScene( userScene, shadowScene ) {
	if ( ! shadowScene ) return;
	try { userScene.updateMatrixWorld( true ); } catch ( _ ) {}
	const lightPairs = shadowScene.__lightPairs || [];
	for ( const { src, clone } of lightPairs ) {
		if ( ! src || ! clone || ! src.matrixWorld ) continue;
		// Decompose live world matrix into the clone's local position/quaternion/
		// scale. We keep matrixAutoUpdate=true so three.js's pipeline rebuilds
		// matrixWorld for the cloned light at the start of render — same as it
		// does for the selftest scene that successfully sets shadow.map.
		src.matrixWorld.decompose( clone.position, clone.quaternion, clone.scale );
		if ( src.layers && clone.layers ) clone.layers.mask = src.layers.mask;
		clone.visible = src.visible !== false;
		if ( src.target && clone.target && src.target.matrixWorld ) {
			src.target.matrixWorld.decompose( clone.target.position, clone.target.quaternion, clone.target.scale );
			if ( src.target.layers && clone.target.layers ) clone.target.layers.mask = src.target.layers.mask;
		}
	}
	const meshPairs = shadowScene.__meshPairs || [];
	for ( const { src, clone } of meshPairs ) {
		if ( ! src || ! clone || ! src.matrixWorld ) continue;
		if ( clone.__tslpWorldSpaceShadowProxy === true ) {
			const bounds = __sourceObjectWorldBounds( src );
			if ( bounds && bounds.center ) clone.position.copy( bounds.center );
		} else {
			src.matrixWorld.decompose( clone.position, clone.quaternion, clone.scale );
		}
		if ( clone.__tslpSkinnedShadowProxy === true ) __updateSkinnedShadowProxyGeometry( src, clone );
		if ( src.layers && clone.layers ) clone.layers.mask = src.layers.mask;
		clone.visible = src.visible !== false;
		__copyMorphStateForFullRenderer( src, clone );
		if ( src.count !== undefined ) clone.count = src.count;
		if ( src.isInstancedMesh === true && clone.isInstancedMesh === true ) {
			if ( src.instanceMatrix && clone.instanceMatrix && clone.instanceMatrix.array !== src.instanceMatrix.array ) {
				try {
					clone.instanceMatrix.array.set( src.instanceMatrix.array );
					clone.instanceMatrix.needsUpdate = true;
				} catch ( _ ) {}
			}
			if ( src.instanceColor && clone.instanceColor && clone.instanceColor.array !== src.instanceColor.array ) {
				try {
					clone.instanceColor.array.set( src.instanceColor.array );
					clone.instanceColor.needsUpdate = true;
				} catch ( _ ) {}
			}
		}
	}
	const clipPairs = shadowScene.__clipPairs || [];
	for ( const { src, clone } of clipPairs ) {
		if ( ! src || ! clone ) continue;
		clone.clippingPlanes = src.clippingPlanes;
		clone.enabled = src.enabled;
		clone.clipIntersection = src.clipIntersection;
		clone.clipShadows = src.clipShadows;
		if ( src.layers && clone.layers ) clone.layers.mask = src.layers.mask;
	}
}

function __getOrBuildShadowScene( userScene ) {
	if ( __shadowSceneCache.has( userScene ) ) return __shadowSceneCache.get( userScene );
	const built = __buildShadowScene( userScene );
	__shadowSceneCache.set( userScene, built ); // cache null too, so we don't retry
	return built;
}

function __suspendCustomShadowNodes( root ) {
	const suspended = [];
	const suspendLight = ( light ) => {
		const shadow = light && light.shadow;
		if ( ! shadow || ! shadow.shadowNode ) return;
		suspended.push( { shadow, shadowNode: shadow.shadowNode } );
		shadow.shadowNode = undefined;
	};
	const pairs = root && root.__lightPairs;
	if ( Array.isArray( pairs ) ) {
		for ( const { src } of pairs ) suspendLight( src );
	} else if ( root && typeof root.traverse === 'function' ) {
		root.traverse( ( object ) => {
			if ( object && object.isLight === true ) suspendLight( object );
		} );
	}
	return suspended;
}

function __restoreCustomShadowNodes( suspended ) {
	for ( const entry of suspended || [] ) {
		if ( entry && entry.shadow ) entry.shadow.shadowNode = entry.shadowNode;
	}
}

function __updateCustomShadowHelpers( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	scene.traverse( ( object ) => {
		if ( ! object || ! object.tileShadowNode || typeof object.update !== 'function' ) return;
		try { object.update(); } catch ( _ ) {}
	} );
}

async function __renderCustomShadowNodes( fullRenderer, slimRenderer, userScene, shadowScene, camera ) {
	if ( ! fullRenderer || ! userScene || ! shadowScene || typeof userScene.traverse !== 'function' ) return 0;
	let rendered = 0;
	const frame = { renderer: fullRenderer, scene: shadowScene, camera };
	const debugProbeJobs = [];
	userScene.traverse( ( light ) => {
		const shadowNode = light && light.isLight === true && light.shadow && light.shadow.shadowNode || null;
		if ( ! shadowNode || shadowNode.isShadowBaseNode !== true ) return;
		const ctorName = shadowNode.constructor && shadowNode.constructor.name || '';
		if ( ! /TileShadowNode/.test( ctorName ) ) return;
		try {
			const suspendedCustomShadowNodes = __suspendCustomShadowNodes( shadowScene );
			const previousShadowMapEnabled = fullRenderer.shadowMap ? fullRenderer.shadowMap.enabled : undefined;
			try {
				if ( fullRenderer.shadowMap ) fullRenderer.shadowMap.enabled = false;
				for ( let pass = 0; pass < 2; pass ++ ) {
					if ( typeof shadowNode.update === 'function' ) shadowNode.update();
					if ( typeof shadowNode.updateShadow === 'function' ) {
						shadowNode.updateShadow( frame );
						rendered ++;
					}
				}
			} finally {
				if ( fullRenderer.shadowMap && previousShadowMapEnabled !== undefined ) fullRenderer.shadowMap.enabled = previousShadowMapEnabled;
				__restoreCustomShadowNodes( suspendedCustomShadowNodes );
			}
			const depthTexture = shadowNode.shadowMap && shadowNode.shadowMap.depthTexture || null;
			if ( depthTexture && depthTexture.isTexture === true ) {
				__shareShadowGpuTextureIntoSlim( depthTexture, fullRenderer, slimRenderer );
				__rememberExactMaterialGraphDepthTextureCandidate( depthTexture );
				if ( window.__TSLP_DEBUG_SHADOW_COVERAGE === true ) {
					debugProbeJobs.push( ( async () => {
						const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
						const list = diag.customShadowNodes || ( diag.customShadowNodes = [] );
						if ( list.length >= 24 ) return;
						const image = depthTexture.image || {};
						const fullData = fullRenderer.backend && fullRenderer.backend.get ? fullRenderer.backend.get( depthTexture ) : null;
						const slimData = slimRenderer && slimRenderer.backend && slimRenderer.backend.get ? slimRenderer.backend.get( depthTexture ) : null;
						const layers = Math.max( 1, Number( image.depth || image.depthOrArrayLayers || fullData && fullData.texture && fullData.texture.depthOrArrayLayers || 1 ) || 1 );
						const layerViews = [];
						for ( let layer = 0; layer < Math.min( layers, 8 ); layer ++ ) {
							const view = await __probeShadowDepthTextureView( fullRenderer, depthTexture, light, 96, { layer } );
							layerViews.push( view );
						}
						list.push( {
							lightUuid: light && light.uuid || null,
							constructorName: ctorName,
							layers,
							image: [ image.width || 0, image.height || 0, image.depth || image.depthOrArrayLayers || 0 ],
							isArrayTexture: depthTexture.isArrayTexture === true,
							compareFunction: depthTexture.compareFunction ?? null,
							fullGpu: fullData && fullData.texture ? [ fullData.texture.width || 0, fullData.texture.height || 0, fullData.texture.depthOrArrayLayers || 0, fullData.texture.format || null ] : null,
							slimShared: !! ( slimData && slimData.__tslpSharedShadowGPUTexture && slimData.texture === slimData.__tslpSharedShadowGPUTexture ),
							layerViews,
						} );
					} )() );
				}
			}
			for ( const tileLight of shadowNode.lights || [] ) {
				const tex = tileLight && tileLight.shadow && tileLight.shadow.map && tileLight.shadow.map.depthTexture || null;
				if ( tex && tex.isTexture === true ) __shareShadowGpuTextureIntoSlim( tex, fullRenderer, slimRenderer );
			}
		} catch ( err ) {
			if ( window.__TSLP_DEBUG_SHADOW_BINDINGS === true || window.__TSLP_DEBUG_SHADOW_COVERAGE === true ) {
				console.warn( '[tslp-shadow] custom shadow render failed:', err && err.message || err );
			}
		}
	} );
	if ( debugProbeJobs.length > 0 ) {
		try { await Promise.all( debugProbeJobs ); } catch ( _ ) {}
	}
	if ( rendered > 0 ) {
		try {
			const queue = fullRenderer.backend && fullRenderer.backend.device && fullRenderer.backend.device.queue;
			if ( queue && typeof queue.onSubmittedWorkDone === 'function' ) await queue.onSubmittedWorkDone();
		} catch ( _ ) {}
	}
	return rendered;
}

function __cloneCameraForFullRenderer( camera, fallbackAspect = 1 ) {
	if ( ! camera || ! __fullThreeMod ) return camera;
	const FullThree = __fullThreeMod;
	let cloned = null;
	try {
		if ( camera.isPerspectiveCamera === true && FullThree.PerspectiveCamera ) {
			cloned = new FullThree.PerspectiveCamera( camera.fov, camera.aspect || fallbackAspect || 1, camera.near, camera.far );
			for ( const key of [ 'zoom', 'filmGauge', 'filmOffset', 'focus' ] ) {
				if ( camera[ key ] !== undefined ) cloned[ key ] = camera[ key ];
			}
		} else if ( camera.isOrthographicCamera === true && FullThree.OrthographicCamera ) {
			cloned = new FullThree.OrthographicCamera( camera.left, camera.right, camera.top, camera.bottom, camera.near, camera.far );
			if ( camera.zoom !== undefined ) cloned.zoom = camera.zoom;
		} else if ( FullThree.Camera ) {
			cloned = new FullThree.Camera();
			if ( camera.near !== undefined ) cloned.near = camera.near;
			if ( camera.far !== undefined ) cloned.far = camera.far;
		}
		if ( ! cloned ) return camera;
		cloned.matrixAutoUpdate = false;
		if ( camera.matrix ) cloned.matrix.copy( camera.matrix );
		if ( camera.matrixWorld ) cloned.matrixWorld.copy( camera.matrixWorld );
		if ( camera.matrixWorldInverse ) cloned.matrixWorldInverse.copy( camera.matrixWorldInverse );
		if ( camera.projectionMatrix ) cloned.projectionMatrix.copy( camera.projectionMatrix );
		if ( camera.projectionMatrixInverse ) cloned.projectionMatrixInverse.copy( camera.projectionMatrixInverse );
		if ( camera.position ) cloned.position.copy( camera.position );
		if ( camera.quaternion ) cloned.quaternion.copy( camera.quaternion );
		if ( camera.scale ) cloned.scale.copy( camera.scale );
		if ( camera.layers && cloned.layers ) cloned.layers.mask = camera.layers.mask;
		if ( camera.coordinateSystem !== undefined ) cloned.coordinateSystem = camera.coordinateSystem;
		if ( camera.reversedDepth !== undefined ) cloned.reversedDepth = camera.reversedDepth;
		return cloned;
	} catch ( _ ) {
		return camera;
	}
}

// Track per-scene state: whether a shadow render is in flight, and the last
// shadow-scene signature used to detect scene growth or moving shadow casters /
// lights. Animated examples (e.g. a moving spotlight) need their offscreen full
// renderer shadow map refreshed when transforms move, otherwise the slim shader
// samples a stale depth map with a fresh light matrix and over-shadows the scene.
const __shadowState = new WeakMap(); // userScene -> { inflight, signature }
const __exactMaterialGraphDepthTextureCandidates = [];

function __rememberExactMaterialGraphDepthTextureCandidate( texture ) {

	if (
		! texture ||
		texture.isTexture !== true ||
		texture.isDepthTexture !== true ||
		__exactMaterialGraphDepthTextureCandidates.includes( texture )
	) return false;
	__exactMaterialGraphDepthTextureCandidates.push( texture );
	return true;

}

function __makeCustomShadowNodeBuilder( renderer, camera ) {
	const FullThree = __fullThreeMod || {};
	const FullRT = FullThree.RenderTarget;
	return {
		renderer,
		camera,
		createRenderTarget( width, height, options = {} ) {
			if ( FullRT ) return new FullRT( width, height, options );
			return {
				width,
				height,
				depth: options && Number.isFinite( options.depth ) ? options.depth : 1,
				texture: { isTexture: true, name: '', isRenderTargetTexture: true },
				depthTexture: null,
				setSize( nextWidth, nextHeight, nextDepth ) {
					this.width = nextWidth;
					this.height = nextHeight;
					if ( Number.isFinite( nextDepth ) ) this.depth = nextDepth;
				},
				dispose() {},
			};
		},
	};
}

function __prepareCustomShadowNodes( scene, renderer, camera ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return 0;
	const builder = __makeCustomShadowNodeBuilder( renderer, camera );
	let prepared = 0;
	try { scene.updateMatrixWorld( true ); } catch ( _ ) {}
	scene.traverse( ( light ) => {
		const shadowNode = light && light.isLight === true && light.shadow && light.shadow.shadowNode || null;
		if ( ! shadowNode || shadowNode.isShadowBaseNode !== true ) return;
		try {
			const ctorName = shadowNode.constructor && shadowNode.constructor.name || '';
			if ( /TileShadowNode/.test( ctorName ) && typeof shadowNode.init === 'function' && ( ! Array.isArray( shadowNode.lights ) || shadowNode.lights.length === 0 ) ) {
				shadowNode.init( builder );
				prepared ++;
			}
		} catch ( err ) {
			if ( window.__TSLP_DEBUG_SHADOW_BINDINGS === true || window.__TSLP_DEBUG_SHADOW_COVERAGE === true ) {
				console.warn( '[tslp-shadow] custom shadow init failed:', err && err.message || err );
			}
		}
	} );
	if ( prepared > 0 && scene._tslpLightCache ) delete scene._tslpLightCache;
	return prepared;
}

function __signatureMatrix( object ) {
	if ( ! object || ! object.matrixWorld || ! object.matrixWorld.elements ) return '';
	return object.matrixWorld.elements.map( ( value ) => Math.round( value * 1000 ) / 1000 ).join( ',' );
}

function __signatureSkinnedPose( object ) {
	const bones = object && object.skeleton && Array.isArray( object.skeleton.bones ) ? object.skeleton.bones : null;
	if ( ! bones || bones.length === 0 ) return '';
	const step = Math.max( 1, Math.floor( bones.length / 12 ) );
	const parts = [];
	for ( let i = 0; i < bones.length; i += step ) parts.push( __signatureMatrix( bones[ i ] ) );
	const influences = Array.isArray( object.morphTargetInfluences ) ? object.morphTargetInfluences : null;
	if ( influences && influences.length > 0 ) {
		parts.push( 'morph:' + influences.map( ( value ) => Math.round( value * 1000 ) / 1000 ).join( ',' ) );
	}
	return parts.join( ';' );
}

function __shadowTextureSignature( texture, index ) {
	if ( ! texture || texture.isTexture !== true ) return String( index );
	const imageSize = __textureImageSize( texture.image );
	return [
		texture.uuid || texture.name || String( index ),
		imageSize.width | 0,
		imageSize.height | 0,
		__textureImageSrc( texture ) || texture.name || '',
	].join( ':' );
}

function __shadowCasterTextureSignature( object ) {
	if ( ! object || object.castShadow !== true ) return '';
	const materials = __shadowSourceMaterials( object.material );
	if ( materials.length === 0 ) return '';
	const textures = [];
	for ( const material of materials ) {
		if ( ! material ) continue;
		for ( const key of [ 'positionNode', 'castShadowNode', 'castShadowPositionNode', 'maskShadowNode', 'maskNode', 'alphaTestNode', 'opacityNode' ] ) {
			__appendUniqueTextures( textures, __collectTexturesInNode( material[ key ] ) );
		}
		for ( const key of [ 'alphaMap', 'map' ] ) {
			const texture = material[ key ];
			if ( texture && texture.isTexture === true ) __pushUniqueTexture( textures, texture );
		}
	}
	if ( textures.length === 0 ) return '';
	return ':shtex:' + textures.map( ( texture, index ) => __shadowTextureSignature( texture, index ) ).join( '&' );
}

function __sceneSignature( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return null;
	let lights = 0, meshes = 0, casters = 0;
	const parts = [];
	try { scene.updateMatrixWorld( true ); } catch ( _ ) {}
	scene.traverse( ( o ) => {
		if ( ! o ) return;
		if ( o.isLight === true && o.castShadow === true && o.shadow && o.visible !== false ) {
			lights ++;
			parts.push( 'l' + ( o.uuid || o.id || lights ) + ':' + __signatureMatrix( o ) );
			if ( o.target && o.target.isObject3D ) parts.push( 't' + ( o.target.uuid || o.target.id || lights ) + ':' + __signatureMatrix( o.target ) );
		} else if ( ( o.isMesh === true || o.isSkinnedMesh === true ) && o.geometry && o.visible !== false && ( o.castShadow === true || o.receiveShadow === true ) ) {
			meshes ++;
			if ( o.castShadow === true ) casters ++;
				const morphTexture = o.morphTexture || null;
				const morphTextureKey = morphTexture
					? ':' + ( morphTexture.uuid || morphTexture.id || 'morphTexture' ) + ':' + ( morphTexture.version | 0 )
					: '';
				const skinnedPoseKey = o.isSkinnedMesh === true ? ':skin:' + __signatureSkinnedPose( o ) : '';
				const shadowTextureKey = __shadowCasterTextureSignature( o );
				parts.push( 'm' + ( o.uuid || o.id || meshes ) + ':' + ( o.castShadow === true ? 'c' : 'r' ) + ':' + ( o.count || 0 ) + morphTextureKey + skinnedPoseKey + shadowTextureKey + ':' + __signatureMatrix( o ) );
			}
		} );
	return { lights, meshes, casters, value: lights + ':' + meshes + ':' + casters + ':' + parts.join( '|' ) };
}

async function __probeShadowDepthTexture( fullRenderer, depthTex, light, preferredSize ) {
	if ( ! fullRenderer || ! fullRenderer.backend || typeof fullRenderer.backend.copyTextureToBuffer !== 'function' || ! depthTex ) return null;
	// WebGPU depth-only textures such as Depth24Plus cannot be copied to a
	// CPU buffer by this backend helper. Probing them poisons the command
	// encoder and can black out later replay passes; still share the GPU
	// texture below, just skip the optional zero-map heuristic.
	if ( depthTex.isDepthTexture === true ) return null;
	const image = depthTex.image || {};
	const width = image.width || light && light.shadow && light.shadow.mapSize && light.shadow.mapSize.width || 0;
	const height = image.height || light && light.shadow && light.shadow.mapSize && light.shadow.mapSize.height || 0;
	if ( ! width || ! height ) return null;
	const copyWholeSubresource = depthTex.isDepthTexture === true;
	const size = Math.max( 1, Math.min( preferredSize || 16, width, height ) );
	const x = copyWholeSubresource ? 0 : Math.max( 0, Math.floor( ( width - size ) / 2 ) );
	const y = copyWholeSubresource ? 0 : Math.max( 0, Math.floor( ( height - size ) / 2 ) );
	const copyWidth = copyWholeSubresource ? width : size;
	const copyHeight = copyWholeSubresource ? height : size;
	const buf = await fullRenderer.backend.copyTextureToBuffer( depthTex, x, y, copyWidth, copyHeight, 0 );
	const sample = ArrayBuffer.isView( buf ) ? buf : new Uint8Array( buf );
	let min = Infinity;
	let max = - Infinity;
	for ( let i = 0; i < sample.length; i ++ ) {
		const value = sample[ i ];
		if ( Number.isFinite( value ) ) { min = Math.min( min, value ); max = Math.max( max, value ); }
	}
	return { width, height, min, max };
}

async function __probeShadowCameraCoverage( fullRenderer, shadowScene, light, size = 128 ) {
	if ( ! window.__TSLP_DEBUG_SHADOW_COVERAGE ) return null;
	if ( ! fullRenderer || ! fullRenderer.backend || typeof fullRenderer.backend.copyTextureToBuffer !== 'function' || ! shadowScene || ! light || ! light.shadow || ! light.shadow.camera || ! __fullThreeMod ) return null;
	const { RenderTarget: FullRT, MeshBasicMaterial: FullBasicMaterial, Color: FullColor } = __fullThreeMod;
	if ( ! FullRT || ! FullBasicMaterial ) return null;
	try {
		if ( ! __shadowCoverageRT.rt ) __shadowCoverageRT.rt = new FullRT( size, size );
		if ( ! __shadowCoverageRT.material ) __shadowCoverageRT.material = new FullBasicMaterial( { color: 0xffffff } );
		const rt = __shadowCoverageRT.rt;
		if ( rt.width !== size || rt.height !== size ) rt.setSize( size, size );
		const hidden = [];
		for ( const { clone } of shadowScene.__meshPairs || [] ) {
			if ( clone && clone.castShadow !== true && clone.visible !== false ) {
				clone.visible = false;
				hidden.push( clone );
			}
		}
		const prevRT = fullRenderer.getRenderTarget ? fullRenderer.getRenderTarget() : null;
		const prevOverride = shadowScene.overrideMaterial;
		const prevShadowEnabled = fullRenderer.shadowMap ? fullRenderer.shadowMap.enabled : undefined;
		const prevClearColor = fullRenderer.getClearColor && FullColor ? fullRenderer.getClearColor( new FullColor() ) : null;
		const prevClearAlpha = fullRenderer.getClearAlpha ? fullRenderer.getClearAlpha() : null;
		try {
			if ( fullRenderer.shadowMap ) fullRenderer.shadowMap.enabled = false;
			shadowScene.overrideMaterial = __shadowCoverageRT.material;
			if ( typeof fullRenderer.setClearColor === 'function' ) fullRenderer.setClearColor( 0x000000, 1 );
			fullRenderer.setRenderTarget( rt );
			if ( typeof fullRenderer.clear === 'function' ) fullRenderer.clear();
			await fullRenderer.render( shadowScene, light.shadow.camera );
			const buf = await fullRenderer.backend.copyTextureToBuffer( rt.texture, 0, 0, size, size, 0 );
			const sample = ArrayBuffer.isView( buf ) ? buf : new Uint8Array( buf );
			let pixels = 0;
			let minX = size, minY = size, maxX = - 1, maxY = - 1;
			for ( let i = 0; i + 3 < sample.length; i += 4 ) {
				const lit = sample[ i ] + sample[ i + 1 ] + sample[ i + 2 ];
				if ( lit <= 24 ) continue;
				const p = i / 4;
				const x = p % size;
				const y = Math.floor( p / size );
				pixels ++;
				minX = Math.min( minX, x );
				minY = Math.min( minY, y );
				maxX = Math.max( maxX, x );
				maxY = Math.max( maxY, y );
			}
			return {
				type: light.isSpotLight ? 'spot' : light.isDirectionalLight ? 'directional' : light.type || 'light',
				uuid: light.uuid || null,
				pixels,
				coverage: pixels / ( size * size ),
				bbox: pixels > 0 ? [ minX, minY, maxX, maxY ] : null,
			};
		} finally {
			shadowScene.overrideMaterial = prevOverride;
			for ( const clone of hidden ) clone.visible = true;
			if ( fullRenderer.shadowMap && prevShadowEnabled !== undefined ) fullRenderer.shadowMap.enabled = prevShadowEnabled;
			try {
				if ( prevClearColor && typeof fullRenderer.setClearColor === 'function' ) fullRenderer.setClearColor( prevClearColor, prevClearAlpha === null ? 1 : prevClearAlpha );
			} catch ( _ ) {}
			try { fullRenderer.setRenderTarget( prevRT ); } catch ( _ ) {}
		}
	} catch ( err ) {
		return { type: light.isSpotLight ? 'spot' : light.isDirectionalLight ? 'directional' : light.type || 'light', error: err && err.message || String( err ) };
	}
}

	async function __probeShadowDepthTextureView( fullRenderer, depthTex, light, size = 128, options = {} ) {
		const shouldReport = window.__TSLP_DEBUG_SHADOW_COVERAGE === true;
		if ( shouldReport !== true && options.warm !== true ) return null;
		if ( ! fullRenderer || ! fullRenderer.backend || typeof fullRenderer.backend.copyTextureToBuffer !== 'function' || ! depthTex || ! FullTSL || ! FullNodeMaterial || ! FullQuadMesh || ! FullRenderTarget ) return null;
		// WGSL has no raw textureLoad overload for depth cube textures.
		if ( depthTex.isCubeTexture === true ) return null;
	try {
		if ( ! __shadowDepthViewRT.rt ) __shadowDepthViewRT.rt = new FullRenderTarget( size, size );
		const rt = __shadowDepthViewRT.rt;
		if ( rt.width !== size || rt.height !== size ) rt.setSize( size, size );
		const probeLayer = Number.isFinite( options.layer ) ? Math.max( 0, Math.floor( options.layer ) ) : null;
		if ( ! __shadowDepthViewRT.material || __shadowDepthViewRT.texture !== depthTex || __shadowDepthViewRT.layer !== probeLayer ) {
			// Read the raw stored depth in [0,1] via textureLoad (no sampler needed — avoids the
			// comparison-sampler-vs-textureSample mismatch that made the previous probe shader
			// invalid). Value 1.0 (white) = cleared far texel; small values = caster depths near the light.
			const depthTexNode = FullTSL.texture( depthTex );
			const coords = FullTSL.ivec2( FullTSL.uv().mul( FullTSL.vec2( FullTSL.textureSize( depthTexNode, FullTSL.int( 0 ) ) ) ) );
			let depthValue = FullTSL.textureLoad( depthTex, coords );
			if ( probeLayer !== null && ( depthTex.isArrayTexture === true || depthTex.image && depthTex.image.depth > 1 ) ) {
				depthValue = depthValue.depth( FullTSL.float( probeLayer ) );
			}
			const material = new FullNodeMaterial();
			material.depthTest = false;
			material.depthWrite = false;
			material.fragmentNode = FullTSL.vec4( depthValue, depthValue, depthValue, 1 );
			material.name = 'TSLPShadowDepthProbe';
			__shadowDepthViewRT.material = material;
			__shadowDepthViewRT.quad = new FullQuadMesh( material );
			__shadowDepthViewRT.texture = depthTex;
			__shadowDepthViewRT.layer = probeLayer;
		}
		const prevRT = fullRenderer.getRenderTarget ? fullRenderer.getRenderTarget() : null;
		try {
			fullRenderer.setRenderTarget( rt );
				if ( typeof fullRenderer.clear === 'function' ) fullRenderer.clear();
				__shadowDepthViewRT.quad.render( fullRenderer );
				if ( shouldReport !== true ) {
					try {
						const queue = fullRenderer.backend && fullRenderer.backend.device && fullRenderer.backend.device.queue;
						if ( queue && typeof queue.onSubmittedWorkDone === 'function' ) await queue.onSubmittedWorkDone();
					} catch ( _ ) {}
					return { warmed: true };
				}
				const buf = await fullRenderer.backend.copyTextureToBuffer( rt.texture, 0, 0, size, size, 0 );
			const sample = ArrayBuffer.isView( buf ) ? buf : new Uint8Array( buf );
			let pixels = 0;
			let min = 255;
			let max = 0;
			let sum = 0;
			let minX = size, minY = size, maxX = - 1, maxY = - 1;
			for ( let i = 0; i + 3 < sample.length; i += 4 ) {
				const value = sample[ i ];
				min = Math.min( min, value );
				max = Math.max( max, value );
				sum += value;
				if ( value <= 2 ) continue;
				const p = i / 4;
				const x = p % size;
				const y = Math.floor( p / size );
				pixels ++;
				minX = Math.min( minX, x );
				minY = Math.min( minY, y );
				maxX = Math.max( maxX, x );
				maxY = Math.max( maxY, y );
			}
			return {
				type: light && light.isSpotLight ? 'spot' : light && light.isDirectionalLight ? 'directional' : light && light.type || 'light',
				uuid: light && light.uuid || null,
				layer: probeLayer,
				pixels,
				coverage: pixels / ( size * size ),
				min,
				max,
				mean: sum / Math.max( 1, sample.length / 4 ),
				bbox: pixels > 0 ? [ minX, minY, maxX, maxY ] : null,
			};
		} finally {
			try { fullRenderer.setRenderTarget( prevRT ); } catch ( _ ) {}
		}
	} catch ( err ) {
		return { type: light && light.isSpotLight ? 'spot' : light && light.isDirectionalLight ? 'directional' : light && light.type || 'light', error: err && err.message || String( err ) };
	}
}

const __projectedSpotMapState = new WeakMap(); // light -> mutable projected map state

function __imageSize( image ) {
	return {
		width: image && ( image.naturalWidth || image.videoWidth || image.width ) || 0,
		height: image && ( image.naturalHeight || image.videoHeight || image.height ) || 0,
	};
}

function __ensureProjectedSpotMapState( light ) {
	const texture = light && light.map;
	if ( ! texture || ! texture.isTexture || typeof document === 'undefined' ) return null;
	const existing = __projectedSpotMapState.get( light );
	if ( existing && existing.texture === texture ) return existing;
	const image = texture.image;
	const { width, height } = __imageSize( image );
	if ( ! width || ! height ) return null;
	let canvas, ctx, imageData;
	try {
		canvas = document.createElement( 'canvas' );
		canvas.width = width;
		canvas.height = height;
		ctx = canvas.getContext( '2d', { willReadFrequently: true } );
		if ( ! ctx ) return null;
		ctx.drawImage( image, 0, 0, width, height );
		imageData = ctx.getImageData( 0, 0, width, height );
	} catch ( _ ) {
		return null;
	}
	const state = {
		texture,
		width,
		height,
		canvas,
		ctx,
		imageData,
		baseData: new Uint8ClampedArray( imageData.data ),
		mask: new Uint8Array( width * height ),
	};
	texture.image = canvas;
	texture.needsUpdate = true;
	__rememberLiveTexture( texture );
	__projectedSpotMapState.set( light, state );
	return state;
}

function __rasterizeProjectedSpotMapCaster( caster, shadowMatrix, mask, width, height ) {
	const position = caster && caster.geometry && caster.geometry.attributes && caster.geometry.attributes.position;
	const { Vector3 } = __fullThreeMod || {};
	if ( ! position || ! position.count || ! Vector3 ) return false;
	const point = new Vector3();
	const radius = Math.max( 2, Math.min( 6, Math.round( Math.min( width, height ) * 0.006 ) ) );
	const radiusSq = radius * radius;
	let wrote = false;
	for ( let i = 0; i < position.count; i ++ ) {
		point.set( position.getX( i ), position.getY( i ), position.getZ( i ) ).applyMatrix4( caster.matrixWorld ).applyMatrix4( shadowMatrix );
		if ( ! Number.isFinite( point.x ) || ! Number.isFinite( point.y ) || ! Number.isFinite( point.z ) ) continue;
		if ( point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1 || point.z < - 0.05 || point.z > 1.05 ) continue;
		const px = Math.round( point.x * ( width - 1 ) );
		const py = Math.round( ( 1 - point.y ) * ( height - 1 ) );
		for ( let y = Math.max( 0, py - radius ); y <= Math.min( height - 1, py + radius ); y ++ ) {
			const dy = y - py;
			for ( let x = Math.max( 0, px - radius ); x <= Math.min( width - 1, px + radius ); x ++ ) {
				const dx = x - px;
				const d = dx * dx + dy * dy;
				if ( d > radiusSq ) continue;
				const alpha = Math.round( 165 * ( 1 - d / ( radiusSq + 1 ) ) );
				const index = y * width + x;
				mask[ index ] = Math.max( mask[ index ], alpha );
				wrote = true;
			}
		}
	}
	return wrote;
}

function __blurProjectedSpotMapMask( mask, width, height ) {
	const copy = new Uint8Array( mask );
	for ( let y = 1; y < height - 1; y ++ ) {
		for ( let x = 1; x < width - 1; x ++ ) {
			let sum = 0;
			for ( let oy = - 1; oy <= 1; oy ++ ) {
				for ( let ox = - 1; ox <= 1; ox ++ ) sum += copy[ ( y + oy ) * width + x + ox ];
			}
			mask[ y * width + x ] = Math.round( sum / 9 );
		}
	}
}

function __updateProjectedSpotMapShadow( light, shadowScene ) {
	if ( ! light || light.isSpotLight !== true || ! light.map || ! light.shadow || ! light.shadow.matrix || ! shadowScene || ! __fullThreeMod ) return false;
	const state = __ensureProjectedSpotMapState( light );
	if ( ! state ) return false;
	state.imageData.data.set( state.baseData );
	state.mask.fill( 0 );
	let wrote = false;
	for ( const { clone } of shadowScene.__meshPairs || [] ) {
		if ( clone && clone.castShadow === true ) wrote = __rasterizeProjectedSpotMapCaster( clone, light.shadow.matrix, state.mask, state.width, state.height ) || wrote;
	}
	if ( wrote ) {
		__blurProjectedSpotMapMask( state.mask, state.width, state.height );
		const data = state.imageData.data;
		for ( let i = 0; i < state.mask.length; i ++ ) {
			const alpha = state.mask[ i ];
			if ( alpha === 0 ) continue;
			const factor = 1 - ( alpha / 255 ) * 0.55;
			const offset = i * 4;
			data[ offset ] = Math.round( data[ offset ] * factor );
			data[ offset + 1 ] = Math.round( data[ offset + 1 ] * factor );
			data[ offset + 2 ] = Math.round( data[ offset + 2 ] * factor );
		}
		state.ctx.putImageData( state.imageData, 0, 0 );
		state.texture.needsUpdate = true;
		__rememberLiveTexture( state.texture );
	}
	return wrote;
}

function __kickShadowRenderAsync( slimRenderer, userScene, camera ) {
	if ( ! userScene || ! camera ) return;
	__prepareCustomShadowNodes( userScene, slimRenderer, camera );
	const signature = __sceneSignature( userScene );
	if ( ! signature || signature.lights === 0 || signature.meshes === 0 || signature.casters === 0 ) return;
	let replayRenderTarget = null;
	let replayMRT = null;
	try {
		replayRenderTarget = slimRenderer && typeof slimRenderer.getRenderTarget === 'function' ? slimRenderer.getRenderTarget() : null;
		replayMRT = slimRenderer && typeof slimRenderer.getMRT === 'function' ? slimRenderer.getMRT() : null;
	} catch ( _ ) {}
	const sig = signature.value;
	let st = __shadowState.get( userScene );
	if ( ! st ) { st = { inflight: false, signature: '', queuedSignature: '' }; __shadowState.set( userScene, st ); }
	if ( st.inflight ) {
		if ( st.signature !== sig ) st.queuedSignature = sig;
		return;
	}
	if ( st.signature === sig ) return; // already populated for this configuration
	// New or grown scene: discard cached shadow-scene so __buildShadowScene
	// re-walks and picks up the freshly-added meshes (e.g. glTF children).
	__shadowSceneCache.delete( userScene );
	// Build the mirrored shadow scene synchronously while the caller's scene
	// still contains transient offscreen meshes. ProgressiveLightMap temporarily
	// attaches objects only for the duration of its render() call, so waiting
	// until the async full-renderer promise resolves can see an empty scene.
	const shadowSceneSnapshot = __getOrBuildShadowScene( userScene );
	st.inflight = true;
	st.signature = sig;
	st.queuedSignature = '';
	window.__tslpShadowPending = ( window.__tslpShadowPending | 0 ) + 1;
	const _slimRenderer = slimRenderer;
	const _userScene = userScene;
	const _camera = camera;
	const _replayRenderTarget = replayRenderTarget;
	const _replayMRT = replayMRT;
	const _topReplayPipeline = slimRenderer ? ( slimRenderer.__tslpCurrentRenderPipeline || window.__tslpLastRenderPipeline || null ) : null;
	const _topReplayScene = replayRenderTarget && slimRenderer ? slimRenderer._lastScene : null;
	const _topReplayCamera = replayRenderTarget && slimRenderer ? slimRenderer._lastCamera : null;
	const _shadowSceneSnapshot = shadowSceneSnapshot;
	__getComputeRenderer( slimRenderer ).then( async ( fullRenderer ) => {
		if ( ! fullRenderer ) return;
		const shadowScene = _shadowSceneSnapshot || __getOrBuildShadowScene( _userScene );
		if ( ! shadowScene ) return;
		let shadowRenderCamera = __cloneCameraForFullRenderer( _camera, 1 );
		if ( _camera.isArrayCamera === true && __fullThreeMod && __fullThreeMod.PerspectiveCamera ) {
			shadowRenderCamera = new __fullThreeMod.PerspectiveCamera( 50, 1, 0.1, 10 );
			shadowRenderCamera.position.z = 1;
			shadowRenderCamera.layers.mask = _camera.layers ? _camera.layers.mask : 1;
			if ( fullRenderer.coordinateSystem !== undefined ) shadowRenderCamera.coordinateSystem = fullRenderer.coordinateSystem;
			shadowRenderCamera.updateMatrixWorld();
			shadowRenderCamera.updateProjectionMatrix();
		}
		__refreshShadowScene( _userScene, shadowScene );
		// Match the slim renderer's shadow-map type so PCF vs VSM matches.
		try {
			if ( _slimRenderer.domElement && typeof fullRenderer.setSize === 'function' ) {
				const width = _slimRenderer.domElement.width || _slimRenderer.domElement.clientWidth || 256;
				const height = _slimRenderer.domElement.height || _slimRenderer.domElement.clientHeight || 256;
				fullRenderer.setSize( width, height, false );
			}
			if ( _slimRenderer.shadowMap && typeof _slimRenderer.shadowMap.type === 'number' ) {
				fullRenderer.shadowMap.type = _slimRenderer.shadowMap.type;
			}
			if ( _slimRenderer.shadowMap && _slimRenderer.shadowMap.transmitted ) {
				fullRenderer.shadowMap.transmitted = true;
			}
		} catch ( _ ) {}
		// Render to a tiny offscreen RT so the canvas pixels stay slim's. The
		// RT must be large enough that the shadow pass setup doesn't take a
		// degenerate path; 256x256 chosen to comfortably exceed the 4x4 lower
		// bound where some backends NaN out.
		try {
			const { RenderTarget: FullRT } = __fullThreeMod;
			if ( ! __shadowDiscardRT.rt && FullRT ) __shadowDiscardRT.rt = new FullRT( 256, 256 );
			if ( __shadowDiscardRT.rt ) fullRenderer.setRenderTarget( __shadowDiscardRT.rt );
		} catch ( _ ) {}
		try {
			const suspendedCustomShadowNodes = __suspendCustomShadowNodes( shadowScene );
			try {
				await fullRenderer.render( shadowScene, shadowRenderCamera );
				// Second render: the first render may have only built+queued shadow node
				// setup; allocations happen during ShadowNode.updateBefore which fires
				// from the SECOND render once nodeFrame.frameId advances.
				await fullRenderer.render( shadowScene, shadowRenderCamera );
			} finally {
				__restoreCustomShadowNodes( suspendedCustomShadowNodes );
			}
				try {
					const queue = fullRenderer.backend && fullRenderer.backend.device && fullRenderer.backend.device.queue;
					if ( queue && typeof queue.onSubmittedWorkDone === 'function' ) await queue.onSubmittedWorkDone();
				} catch ( _ ) {}
				await __renderCustomShadowNodes( fullRenderer, _slimRenderer, _userScene, shadowScene, shadowRenderCamera );
				// Copy populated shadow.map/depthTexture from cloned light to the
				// original (user-scene) light so slim's hydrator rebinder finds them.
			// Then share the GPUTexture across renderers: full's backend allocated
			// the depth texture during shadow render, but slim has its own backend
			// data map. Without pre-seeding slim's data.texture from full, slim's
			// first bindgroup-creation creates a fresh 1x1 BGRA8 GPUTexture for the
			// same JS DepthTexture, which the WGSL texture_depth_2d declaration
			// rejects with a sample-type mismatch (Float vs Depth).
			let mapCount = 0;
			for ( const { src, clone } of shadowScene.__lightPairs || [] ) {
				if ( clone && clone.shadow && clone.shadow.map && src && src.shadow ) {
					src.shadow.map = clone.shadow.map;
					if ( clone.shadow.map.depthTexture ) src.shadow.map.depthTexture = clone.shadow.map.depthTexture;
					src.shadow.camera = clone.shadow.camera;
					src.shadow.matrix = clone.shadow.matrix;
					const coverage = await __probeShadowCameraCoverage( fullRenderer, shadowScene, src );
					if ( coverage ) {
						const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
						if ( ! Array.isArray( diag.shadowCoverage ) ) diag.shadowCoverage = [];
						diag.shadowCoverage.push( {
							...coverage,
							mapSize: src.shadow && src.shadow.mapSize ? [ src.shadow.mapSize.width, src.shadow.mapSize.height ] : null,
							hasDepthTexture: !! ( src.shadow && src.shadow.map && src.shadow.map.depthTexture ),
						} );
					}
					const isVsmShadowLight = ( fullRenderer.shadowMap && fullRenderer.shadowMap.type ) === ( __fullThreeMod.VSMShadowMap ?? 3 ) && src.isPointLight !== true;
						let depthTex = src.shadow.map.depthTexture;
						if ( depthTex ) {
							// Shadow depth comparison direction follows the depth-buffer convention:
							// three.js ShadowNode emits coordZ+bias + LessEqualCompare for a forward
							// depth buffer, and coordZ-bias + GreaterEqualCompare when reversedDepthBuffer
							// is on. The captured shader baked whichever convention the dev renderer used,
							// and both the slim renderer (runs the captured shader) and this full renderer
							// (renders the depth map) default to forward depth, so honour that instead of
							// hard-coding GreaterEqual. Forcing the wrong direction makes textureSampleCompare
							// read lit everywhere and the shadow disappears.
							const reversedDepthBuffer = !! ( _slimRenderer && _slimRenderer.reversedDepthBuffer ) || !! ( fullRenderer && fullRenderer.reversedDepthBuffer );
							let shadowCompareFunction = null;
							if ( isVsmShadowLight ) {
								// VSM blur passes sample the raw depth texture as a normal texture to
								// build RG moments. A comparison sampler makes the full-renderer
								// VSMVertical shader invalid, so leave VSM depth textures in three.js's
								// native compareFunction=null state and share the blurred moments texture
								// below.
								if ( depthTex.compareFunction !== null ) {
									depthTex.compareFunction = null;
									depthTex.needsUpdate = true;
								}
								if ( depthTex.__tslpShadowCompareFunction !== undefined ) delete depthTex.__tslpShadowCompareFunction;
							} else {
								shadowCompareFunction = reversedDepthBuffer ? ( __fullThreeMod.GreaterEqualCompare ?? 518 ) : ( __fullThreeMod.LessEqualCompare ?? 515 );
								if ( depthTex.compareFunction !== shadowCompareFunction ) {
									depthTex.compareFunction = shadowCompareFunction;
									depthTex.needsUpdate = true;
								}
								depthTex.__tslpShadowCompareFunction = shadowCompareFunction;
							}
							const depthView = await __probeShadowDepthTextureView( fullRenderer, depthTex, src, 128, {
								warm: window.__TSLP_E2E && window.__TSLP_E2E.localExamples === true,
							} );
							if ( window.__TSLP_DEBUG_SHADOW_COVERAGE === true && depthView ) {
							const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
							if ( ! Array.isArray( diag.shadowDepthView ) ) diag.shadowDepthView = [];
							diag.shadowDepthView.push( depthView );
							if ( ! Array.isArray( diag.shadowMatrixDump ) ) diag.shadowMatrixDump = [];
							const __dbgCam = src.shadow && src.shadow.camera;
							diag.shadowMatrixDump.push( {
								type: src.isSpotLight ? 'spot' : src.isDirectionalLight ? 'directional' : src.isPointLight ? 'point' : ( src.type || 'light' ),
								reversedDepthBuffer,
								compareFunction: shadowCompareFunction,
								depthTexFormat: depthTex.format != null ? depthTex.format : null,
								depthTexType: depthTex.type != null ? depthTex.type : null,
								depthTexIsDepth: depthTex.isDepthTexture === true,
								depthTexImage: depthTex.image ? [ depthTex.image.width || 0, depthTex.image.height || 0 ] : null,
								shadowMatrix: src.shadow && src.shadow.matrix && src.shadow.matrix.elements ? Array.from( src.shadow.matrix.elements ) : null,
								camProj: __dbgCam && __dbgCam.projectionMatrix && __dbgCam.projectionMatrix.elements ? Array.from( __dbgCam.projectionMatrix.elements ) : null,
								camWorldInv: __dbgCam && __dbgCam.matrixWorldInverse && __dbgCam.matrixWorldInverse.elements ? Array.from( __dbgCam.matrixWorldInverse.elements ) : null,
								camParams: __dbgCam ? { near: __dbgCam.near, far: __dbgCam.far, left: __dbgCam.left, right: __dbgCam.right, top: __dbgCam.top, bottom: __dbgCam.bottom, fov: __dbgCam.fov, coordinateSystem: __dbgCam.coordinateSystem } : null,
								camPos: __dbgCam && __dbgCam.position ? [ __dbgCam.position.x, __dbgCam.position.y, __dbgCam.position.z ] : null,
								bias: src.shadow ? src.shadow.bias : null,
								normalBias: src.shadow ? src.shadow.normalBias : null,
							} );
						}
							let disableReplayShadow = false;
							try {

							if ( typeof fullRenderer.backend.copyTextureToBuffer === 'function' ) {

								const probe = await __probeShadowDepthTexture( fullRenderer, depthTex, src, 64 );
								if ( probe && probe.min === 0 && probe.max === 0 ) {
									if ( src.isSpotLight === true && src.map ) __updateProjectedSpotMapShadow( src, shadowScene );
									disableReplayShadow = true;
								}

							}

						} catch ( _ ) {
							if ( src.isPointLight === true || ( src.isSpotLight === true && src.map ) ) disableReplayShadow = true;
						}
						if ( disableReplayShadow ) src.shadow.__tslpDisableReplayShadow = true;
						else if ( src.shadow.__tslpDisableReplayShadow === true ) delete src.shadow.__tslpDisableReplayShadow;
						__shareShadowGpuTextureIntoSlim( depthTex, fullRenderer, _slimRenderer );
					}
					// VSM (variance shadow map): the captured shader samples the blurred
					// moments texture, not the raw depth map. Point lights keep the depth-cube
					// path (three.js gates the VSM branch off for isPointLightShadow), so only
					// directional/spot need this. Stash the full renderer's blur output on
					// src.shadow so the hydrator's vsm rebinder finds it, and pre-seed the GPU
					// texture into the slim backend just like the depth map above.
					if ( isVsmShadowLight ) {
						// The VSM blur quads build their pipelines lazily across render passes
						// (like the shadow pass itself), so the two warm-up renders above don't
						// reliably leave vsmShadowMapHorizontal fully written. Render once more,
						// flush, then grab + share the blur output.
						try {
							await fullRenderer.render( shadowScene, shadowRenderCamera );
							const q = fullRenderer.backend && fullRenderer.backend.device && fullRenderer.backend.device.queue;
							if ( q && typeof q.onSubmittedWorkDone === 'function' ) await q.onSubmittedWorkDone();
						} catch ( _ ) {}
						const vsmTex = __findVsmBlurTexture( fullRenderer, shadowScene, shadowRenderCamera, clone );
						if ( vsmTex && vsmTex.isTexture ) {
							src.shadow.__tslpVsmShadowTexture = vsmTex;
							__shareShadowGpuTextureIntoSlim( vsmTex, fullRenderer, _slimRenderer );
						} else if ( src.shadow.__tslpVsmShadowTexture !== undefined ) {
							delete src.shadow.__tslpVsmShadowTexture;
						}
					} else if ( src.shadow.__tslpVsmShadowTexture !== undefined ) {
						delete src.shadow.__tslpVsmShadowTexture;
					}
					if ( fullRenderer.shadowMap && fullRenderer.shadowMap.transmitted === true && src.shadow && src.shadow.map && src.shadow.map.texture ) {
						__shareShadowGpuTextureIntoSlim( src.shadow.map.texture, fullRenderer, _slimRenderer );
					}
					mapCount ++;
				}
			}
			if ( ! window.__tslpShadowLoggedOnce ) { window.__tslpShadowLoggedOnce = true; console.log( '[tslp-shadow] populated ' + mapCount + ' shadow maps' ); }
		} catch ( err ) {
			console.warn( '[tslp-e2e] shadow render failed:', err && err.message || err );
		} finally {
			try { fullRenderer.setRenderTarget( null ); } catch ( _ ) {}
		}
	} ).catch( ( err ) => {
		console.warn( '[tslp-e2e] shadow kick failed:', err && err.message || err );
	} ).finally( () => {
		const stEnd = __shadowState.get( _userScene );
		if ( stEnd ) stEnd.inflight = false;
		window.__tslpShadowPending = Math.max( 0, ( window.__tslpShadowPending | 0 ) - 1 );
		const latestSignature = __sceneSignature( _userScene );
		const needsReplay = latestSignature && latestSignature.lights > 0 && latestSignature.meshes > 0 && latestSignature.casters > 0 &&
			( stEnd && stEnd.queuedSignature && stEnd.queuedSignature !== stEnd.signature || latestSignature.value !== ( stEnd && stEnd.signature ) );
		if ( needsReplay && stEnd ) stEnd.signature = '';
		// After shadow maps are populated, always force a slim render. The async
		// shadow pass can finish before the deterministic-rAF shim marks the page
		// frozen, but after the final user animation-loop render for this frame.
		// Without this render the shadow receiver can keep the 1x1 fallback depth
		// bind group even though the live full-renderer GPUTexture was shared.
		try {
			const previousTarget = typeof _slimRenderer.getRenderTarget === 'function' ? _slimRenderer.getRenderTarget() : null;
			const previousMRT = typeof _slimRenderer.getMRT === 'function' ? _slimRenderer.getMRT() : null;
			const previousSuppressShadowKick = _slimRenderer.__tslpSuppressShadowKick === true;
			const previousSuppressVelocity = _slimRenderer.__tslpSuppressVelocityStateAdvance === true;
			const previousGlobalSuppressVelocity = window.__tslpSuppressVelocityStateAdvance === true;
			try {
				_slimRenderer.__tslpSuppressShadowKick = true;
				_slimRenderer.__tslpSuppressVelocityStateAdvance = true;
				window.__tslpSuppressVelocityStateAdvance = true;
				// Keep the captured shadow topology active for the presentation pass.
				// __tslpSuppressShadowKick prevents recursive shadow production without
				// changing the signed renderer selector from shadow-enabled to disabled.
				__updateCustomShadowHelpers( _userScene );
				if ( typeof _slimRenderer.setMRT === 'function' ) _slimRenderer.setMRT( _replayMRT );
				if ( typeof _slimRenderer.setRenderTarget === 'function' ) _slimRenderer.setRenderTarget( _replayRenderTarget );
				const suspendedReplayShadowNodes = __suspendCustomShadowNodes( _userScene );
				try {
					_slimRenderer.render( _userScene, _camera );
				} finally {
					__restoreCustomShadowNodes( suspendedReplayShadowNodes );
				}
				try {
					const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
					diag.shadowForcedPassRenders = ( diag.shadowForcedPassRenders || 0 ) + 1;
				} catch ( _ ) {}
			} finally {
				if ( previousSuppressShadowKick ) _slimRenderer.__tslpSuppressShadowKick = true;
				else delete _slimRenderer.__tslpSuppressShadowKick;
				if ( previousSuppressVelocity ) _slimRenderer.__tslpSuppressVelocityStateAdvance = true;
				else delete _slimRenderer.__tslpSuppressVelocityStateAdvance;
				if ( previousGlobalSuppressVelocity ) window.__tslpSuppressVelocityStateAdvance = true;
				else delete window.__tslpSuppressVelocityStateAdvance;
				if ( typeof _slimRenderer.setRenderTarget === 'function' ) _slimRenderer.setRenderTarget( previousTarget );
				if ( typeof _slimRenderer.setMRT === 'function' ) _slimRenderer.setMRT( previousMRT );
			}
			if ( _topReplayPipeline && typeof _topReplayPipeline.render === 'function' ) {
				const topPreviousSuppressShadowKick = _slimRenderer.__tslpSuppressShadowKick === true;
				const topPreviousSuppressVelocity = _slimRenderer.__tslpSuppressVelocityStateAdvance === true;
				const topPreviousGlobalSuppressVelocity = window.__tslpSuppressVelocityStateAdvance === true;
				try {
					_slimRenderer.__tslpSuppressShadowKick = true;
					_slimRenderer.__tslpSuppressVelocityStateAdvance = true;
					window.__tslpSuppressVelocityStateAdvance = true;
					__sharedWithTemporalFrame(
						[ _slimRenderer, __computeRenderer ],
						__maintenanceTemporalFrame( 'shadow' ),
						() => _topReplayPipeline.render(),
					);
					try {
						const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
						diag.shadowForcedPipelineRenders = ( diag.shadowForcedPipelineRenders || 0 ) + 1;
					} catch ( _ ) {}
				} finally {
					if ( topPreviousSuppressShadowKick ) _slimRenderer.__tslpSuppressShadowKick = true;
					else delete _slimRenderer.__tslpSuppressShadowKick;
					if ( topPreviousSuppressVelocity ) _slimRenderer.__tslpSuppressVelocityStateAdvance = true;
					else delete _slimRenderer.__tslpSuppressVelocityStateAdvance;
					if ( topPreviousGlobalSuppressVelocity ) window.__tslpSuppressVelocityStateAdvance = true;
					else delete window.__tslpSuppressVelocityStateAdvance;
				}
			} else if ( _replayRenderTarget && _topReplayScene && _topReplayCamera && _topReplayScene !== _userScene ) {
				const topPreviousTarget = typeof _slimRenderer.getRenderTarget === 'function' ? _slimRenderer.getRenderTarget() : null;
				const topPreviousSuppressShadowKick = _slimRenderer.__tslpSuppressShadowKick === true;
				const topPreviousSuppressVelocity = _slimRenderer.__tslpSuppressVelocityStateAdvance === true;
				const topPreviousGlobalSuppressVelocity = window.__tslpSuppressVelocityStateAdvance === true;
				try {
					_slimRenderer.__tslpSuppressShadowKick = true;
					_slimRenderer.__tslpSuppressVelocityStateAdvance = true;
					window.__tslpSuppressVelocityStateAdvance = true;
					_slimRenderer.render( _topReplayScene, _topReplayCamera );
					try {
						const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
						diag.shadowForcedTopRenders = ( diag.shadowForcedTopRenders || 0 ) + 1;
					} catch ( _ ) {}
				} finally {
					if ( topPreviousSuppressShadowKick ) _slimRenderer.__tslpSuppressShadowKick = true;
					else delete _slimRenderer.__tslpSuppressShadowKick;
					if ( topPreviousSuppressVelocity ) _slimRenderer.__tslpSuppressVelocityStateAdvance = true;
					else delete _slimRenderer.__tslpSuppressVelocityStateAdvance;
					if ( topPreviousGlobalSuppressVelocity ) window.__tslpSuppressVelocityStateAdvance = true;
					else delete window.__tslpSuppressVelocityStateAdvance;
					if ( typeof _slimRenderer.setRenderTarget === 'function' ) _slimRenderer.setRenderTarget( topPreviousTarget );
					}
				}
				if ( needsReplay ) __kickShadowRenderAsync( _slimRenderer, _userScene, _camera );
			} catch ( e ) {
				try { window.__tslpRecordRenderSelectorMismatch && window.__tslpRecordRenderSelectorMismatch( e, 'caught-shadow-render' ); } catch ( _ ) {}
				console.warn( '[tslp-shadow] forced re-render failed:', e && e.message || e );
			}
		} );
	}

	const __iblSamplerDescriptorsByDevice = new WeakMap();
	const __iblSamplerPatchedDevices = new WeakSet();
	const __iblBindingSnapshotKeys = new Set();

	function __iblSamplerDescriptorSnapshot( descriptor ) {
		if ( ! descriptor ) return null;
		return {
			label: descriptor.label || '',
			addressModeU: descriptor.addressModeU,
			addressModeV: descriptor.addressModeV,
			addressModeW: descriptor.addressModeW,
			magFilter: descriptor.magFilter,
			minFilter: descriptor.minFilter,
			mipmapFilter: descriptor.mipmapFilter,
			lodMinClamp: descriptor.lodMinClamp,
			lodMaxClamp: descriptor.lodMaxClamp,
			compare: descriptor.compare,
			maxAnisotropy: descriptor.maxAnisotropy,
		};
	}

	function __patchIBLSamplerCreationDiagnostics( renderer ) {
		if ( window.__TSLP_DEBUG_IBL_BINDINGS !== true ) return;
		const device = renderer && renderer.backend && renderer.backend.device;
		if ( ! device || typeof device.createSampler !== 'function' ) return;
		if ( __iblSamplerPatchedDevices.has( device ) ) return;
		const descriptorBySampler = new WeakMap();
		__iblSamplerDescriptorsByDevice.set( device, descriptorBySampler );
		const originalCreateSampler = device.createSampler.bind( device );
		try {
			device.createSampler = function ( descriptor ) {
				const snapshot = __iblSamplerDescriptorSnapshot( descriptor );
				const sampler = originalCreateSampler( descriptor );
				if ( sampler && ( typeof sampler === 'object' || typeof sampler === 'function' ) ) descriptorBySampler.set( sampler, snapshot );
				try {
					const diag = __harnessDiagnostics();
					const ibl = diag.ibl || ( diag.ibl = {} );
					const creates = ibl.samplerCreates || ( ibl.samplerCreates = [] );
					if ( creates.length < 80 ) creates.push( snapshot );
				} catch ( _ ) {}
				return sampler;
			};
			__iblSamplerPatchedDevices.add( device );
		} catch ( err ) {
			try {
				const diag = __harnessDiagnostics();
				const ibl = diag.ibl || ( diag.ibl = {} );
				ibl.samplerPatchError = err && err.message || String( err );
			} catch ( _ ) {}
		}
	}

	function __iblTexturePlanEntry( material, groupName, bindingName ) {
		const artifact = material && material.precompiledArtifact;
		for ( const group of artifact && artifact.uniformPlan || [] ) {
			if ( ( group.name || '' ) !== ( groupName || '' ) ) continue;
			for ( const entry of group.textures || [] ) {
				if ( entry && entry.name === bindingName ) return entry;
			}
		}
		return null;
	}

	function __recordIBLBindingUpdateDiagnostics( renderer, renderObject ) {
		if ( window.__TSLP_DEBUG_IBL_BINDINGS !== true || ! renderer || ! renderObject ) return;
		try {
			const groups = typeof renderObject.getBindings === 'function' ? renderObject.getBindings() : [];
			const material = renderObject.material || null;
			const object = renderObject.object || null;
			const backend = renderer.backend;
			const device = backend && backend.device;
			const descriptorBySampler = device && __iblSamplerDescriptorsByDevice.get( device );
			const diag = __harnessDiagnostics();
			const ibl = diag.ibl || ( diag.ibl = {} );
			const records = ibl.bindingUpdates || ( ibl.bindingUpdates = [] );
			for ( let groupIndex = 0; groupIndex < ( groups || [] ).length; groupIndex ++ ) {
				const group = groups[ groupIndex ];
				const bindings = group && Array.isArray( group.bindings ) ? group.bindings : [];
				const groupData = backend && typeof backend.get === 'function' ? backend.get( group ) : null;
				for ( let bindingIndex = 0; bindingIndex < bindings.length; bindingIndex ++ ) {
					if ( records.length >= 120 ) return;
					const binding = bindings[ bindingIndex ];
					if ( ! binding || ( binding.isSampler !== true && binding.isSampledTexture !== true ) ) continue;
					const entry = __iblTexturePlanEntry( material, group.name || '', binding.name || '' );
					const source = entry && entry.source || {};
					const texture = binding.texture || null;
					const isDFG = source.kind === 'builtin.dfgLUT' || texture && texture.name === 'DFG_LUT';
					const isPMREM = source.textureName === 'PMREM.cubeUv' || texture && texture.name === 'PMREM.cubeUv';
					if ( ! isDFG && ! isPMREM ) continue;
					const key = [
						material && ( material.uuid || material.id ) || '',
						object && ( object.uuid || object.id ) || '',
						groupIndex,
						bindingIndex,
						texture && texture.id,
					].join( ':' );
					if ( __iblBindingSnapshotKeys.has( key ) ) continue;
					__iblBindingSnapshotKeys.add( key );
					const pairName = binding.isSampler === true
						? String( binding.name || '' ).replace( /_sampler$/, '' )
						: String( binding.name || '' ) + '_sampler';
					const pair = bindings.find( ( candidate ) => candidate && candidate.name === pairName ) || null;
					const bindingData = backend && typeof backend.get === 'function' ? backend.get( binding ) : null;
					const pairData = pair && backend && typeof backend.get === 'function' ? backend.get( pair ) : null;
					const textureData = texture && backend && typeof backend.get === 'function' ? backend.get( texture ) : null;
					const textureManagerData = texture && renderer._textures && typeof renderer._textures.get === 'function'
						? renderer._textures.get( texture )
						: null;
					const gpuTexture = textureData && textureData.texture || null;
					const gpuSampler = binding.isSampler === true
						? bindingData && bindingData.sampler
						: pairData && pairData.sampler;
					const descriptor = gpuSampler && descriptorBySampler ? descriptorBySampler.get( gpuSampler ) || null : null;
					records.push( {
						sourceKind: source.kind || '',
						sourceTextureName: source.textureName || '',
						materialName: material && material.name || '',
						materialType: material && ( material.type || material.constructor && material.constructor.name ) || '',
						objectName: object && object.name || '',
						groupName: group.name || '',
						groupIndex,
						bindingIndex,
						name: binding.name || '',
						isSampler: binding.isSampler === true,
						isSampledTexture: binding.isSampledTexture === true,
						visibility: binding.visibility | 0,
						pairName: pair && pair.name || '',
						pairUsesSameTexture: !! texture && !! pair && pair.texture === texture,
						textureName: texture && texture.name || '',
						textureUuid: texture && texture.uuid || null,
						textureId: texture && Number.isFinite( texture.id ) ? texture.id : null,
						textureVersion: texture && Number.isFinite( texture.version ) ? texture.version : null,
						textureFormat: texture && texture.format,
						textureType: texture && texture.type,
						textureMinFilter: texture && texture.minFilter,
						textureMagFilter: texture && texture.magFilter,
						textureWrapS: texture && texture.wrapS,
						textureWrapT: texture && texture.wrapT,
						textureWrapR: texture && texture.wrapR,
						textureAnisotropy: texture && texture.anisotropy,
						textureGenerateMipmaps: texture && texture.generateMipmaps,
						textureImageWidth: texture && texture.image && texture.image.width || 0,
						textureImageHeight: texture && texture.image && texture.image.height || 0,
						gpuWidth: gpuTexture && gpuTexture.width || 0,
						gpuHeight: gpuTexture && gpuTexture.height || 0,
						gpuFormat: gpuTexture && gpuTexture.format || null,
						gpuMipLevelCount: gpuTexture && gpuTexture.mipLevelCount || 0,
						hasGPUSampler: !! gpuSampler,
						samplerKey: binding.isSampler === true ? binding.samplerKey || '' : pair && pair.samplerKey || '',
						backendSamplerKey: binding.isSampler === true ? bindingData && bindingData.samplerKey || '' : pairData && pairData.samplerKey || '',
						samplerDescriptor: descriptor,
						bindingVersion: binding.version,
						bindingGeneration: binding.generation ?? null,
						textureManagerGeneration: textureManagerData ? textureManagerData.generation ?? null : null,
						textureManagerIsDefault: textureManagerData && textureManagerData.isDefaultTexture === true,
						backendInitialized: textureData && textureData.initialized === true,
						backendIsDefault: textureData && textureData.isDefaultTexture === true,
						hasBindGroup: !! ( groupData && groupData.group ),
						bindGroupLayoutKey: groupData && groupData.layoutKey || '',
					} );
					if ( isDFG && binding.isSampledTexture === true ) __queueIBLDFGReadbackDiagnostic( renderer, texture );
				}
			}
		} catch ( err ) {
			try {
				const diag = __harnessDiagnostics();
				const ibl = diag.ibl || ( diag.ibl = {} );
				ibl.bindingDiagnosticError = err && err.message || String( err );
			} catch ( _ ) {}
		}
	}

	function __bindGroupLayoutSignature( bindGroup ) {
	const list = bindGroup && Array.isArray( bindGroup.bindings ) ? bindGroup.bindings : [];
	return list.map( ( binding ) => {
		if ( ! binding ) return 'null';
		return [
			binding.name || '',
			binding.visibility | 0,
			binding.isUniformBuffer ? 'ubo' : '',
			binding.isStorageBuffer ? 'storage' : '',
			binding.isSampler ? 'sampler' : '',
			binding.isSampledTexture ? 'sampled' : '',
			binding.isSampledCubeTexture ? 'cube' : '',
			binding.isSampledTexture3D ? '3d' : '',
			binding.isSampledArrayTexture ? 'array' : '',
			binding.store ? 'store' : '',
			binding.access || '',
			binding.byteLength || 0,
		].join( ':' );
	} ).join( '|' );
}

function __patchBindGroupLayoutRefresh( renderer ) {
	const utils = renderer && renderer.backend && renderer.backend.bindingUtils;
	if ( ! utils || utils.__tslpBindLayoutRefreshPatched || typeof utils.createBindings !== 'function' ) return;
	utils.__tslpBindLayoutRefreshPatched = true;
	const origCreateBindings = utils.createBindings;
	utils.createBindings = function ( bindGroup, bindings, cacheIndex, version ) {
		try {
			const list = bindGroup && Array.isArray( bindGroup.bindings ) ? bindGroup.bindings : [];
				for ( const binding of list ) {
					const texture = binding && binding.texture;
					if ( ! texture || ( binding.isSampledTexture !== true && binding.isSampler !== true ) ) continue;
					const textureData = this.backend && this.backend.get && this.backend.get( texture );
					if ( window.__TSLP_DEBUG_SHADOW_BINDINGS === true && /^nodeUniform\d+(?:_sampler)?$/.test( binding.name || '' ) ) {
						const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
						const shadowBindCreates = diag.shadowBindCreates || ( diag.shadowBindCreates = [] );
						if ( shadowBindCreates.length < 120 ) {
							let textureManagerData = null;
							try {
								const ownerRenderer = this.backend && this.backend.renderer;
								textureManagerData = ownerRenderer && ownerRenderer._textures && typeof ownerRenderer._textures.get === 'function'
									? ownerRenderer._textures.get( texture )
									: null;
							} catch ( _ ) {}
							const gpuTexture = textureData && textureData.texture;
							shadowBindCreates.push( {
								name: binding.name || '',
								isSampler: binding.isSampler === true,
								isSampledTexture: binding.isSampledTexture === true,
								textureUuid: texture.uuid || null,
								textureId: Number.isFinite( texture.id ) ? texture.id : null,
								textureVersion: texture.version,
								compareFunction: texture.compareFunction ?? null,
								isDepthTexture: texture.isDepthTexture === true,
								gpuWidth: gpuTexture && gpuTexture.width || 0,
								gpuHeight: gpuTexture && gpuTexture.height || 0,
								gpuFormat: gpuTexture && gpuTexture.format || null,
								hasSampler: !! ( textureData && textureData.sampler ),
								backendInitialized: !! ( textureData && textureData.initialized ),
								backendIsDefault: textureData && textureData.isDefaultTexture === true,
								managerInitialized: !! ( textureManagerData && textureManagerData.initialized ),
								managerIsDefault: textureManagerData && textureManagerData.isDefaultTexture === true,
								managerGeneration: textureManagerData ? textureManagerData.generation ?? null : null,
								bindingVersion: binding.version,
								bindingGeneration: binding.generation ?? null,
							} );
						}
					}
					if ( textureData && textureData.texture === undefined && typeof this.backend.createDefaultTexture === 'function' ) this.backend.createDefaultTexture( texture );
					if ( textureData && textureData.sampler === undefined && typeof this.backend.updateSampler === 'function' ) this.backend.updateSampler( texture );
				}
		} catch ( _ ) {}
		try {
			const data = this.backend && this.backend.get && this.backend.get( bindGroup );
			const signature = __bindGroupLayoutSignature( bindGroup );
			if ( data && data.__tslpLayoutSignature !== signature ) {
				if ( typeof this.deleteBindGroupData === 'function' ) this.deleteBindGroupData( bindGroup );
				data.group = undefined;
				data.groups = undefined;
				data.versions = undefined;
				data.__tslpLayoutSignature = signature;
			}
		} catch ( _ ) {}
		try {
			return origCreateBindings.call( this, bindGroup, bindings, cacheIndex, version );
		} catch ( err ) {
			if ( ! window.__tslpBindCreateWarned ) {
				window.__tslpBindCreateWarned = true;
				const list = bindGroup && Array.isArray( bindGroup.bindings ) ? bindGroup.bindings : bindings;
				const summary = Array.isArray( list ) ? list.map( ( binding, index ) => {
					let data = null;
					try { data = this.backend && this.backend.get && this.backend.get( binding ); } catch ( _ ) {}
					return [ index, binding && binding.name || '', binding && binding.constructor && binding.constructor.name || '', binding && binding.isUniformBuffer ? 'ubo' : '', binding && binding.isSampler ? 'sampler' : '', binding && binding.isSampledTexture ? 'texture' : '', binding && binding.isStorageBuffer ? 'storage' : '', data && data.texture ? 'gpuTexture' : '', data && data.buffer ? 'gpuBuffer' : '', data && data.sampler ? 'gpuSampler' : '', data ? Object.keys( data ).join( ',' ) : '' ].filter( Boolean ).join( ':' );
				} ).join( ' | ' ) : 'no-bindings-array';
				console.warn( '[tslp-e2e] bind group creation failed:', err && err.message || err, summary );
			}
			throw err;
		}
	};
}

	function __patchShadowBindingUpdateDiagnostics( renderer ) {
		if ( ! renderer || ! renderer._bindings || renderer._bindings.__tslpShadowUpdatePatched ) return;
		const bindings = renderer._bindings;
	if ( typeof bindings.updateForRender !== 'function' ) return;
	bindings.__tslpShadowUpdatePatched = true;
	const origUpdateForRender = bindings.updateForRender;
	bindings.updateForRender = function ( renderObject ) {
		if ( window.__TSLP_DEBUG_SHADOW_BINDINGS === true ) {
			try {
				const groups = renderObject && typeof renderObject.getBindings === 'function' ? renderObject.getBindings() : [];
				const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
				const list = diag.shadowBindingUpdates || ( diag.shadowBindingUpdates = [] );
				if ( list.length < 160 ) {
					for ( const group of groups || [] ) {
						for ( const binding of group && group.bindings || [] ) {
							if ( ! binding || ! /^nodeUniform\d+(?:_sampler)?$/.test( binding.name || '' ) ) continue;
							const texture = binding.texture;
							const textureData = texture && renderer.backend && renderer.backend.get ? renderer.backend.get( texture ) : null;
							const gpuTexture = textureData && textureData.texture;
							list.push( {
								name: binding.name || '',
								isSampler: binding.isSampler === true,
								isSampledTexture: binding.isSampledTexture === true,
								textureUuid: texture && texture.uuid || null,
								textureId: texture && Number.isFinite( texture.id ) ? texture.id : null,
								textureVersion: texture && texture.version,
								compareFunction: texture ? texture.compareFunction ?? null : null,
								isDepthTexture: texture && texture.isDepthTexture === true,
								gpuWidth: gpuTexture && gpuTexture.width || 0,
								gpuHeight: gpuTexture && gpuTexture.height || 0,
								gpuFormat: gpuTexture && gpuTexture.format || null,
								backendInitialized: !! ( textureData && textureData.initialized ),
								backendIsDefault: textureData && textureData.isDefaultTexture === true,
								bindingVersion: binding.version,
								bindingGeneration: binding.generation ?? null,
								groupName: group.name || '',
							} );
						}
					}
				}
			} catch ( _ ) {}
		}
			return origUpdateForRender.call( this, renderObject );
		};
	}

	function __patchIBLBindingUpdateDiagnostics( renderer ) {
		if ( window.__TSLP_DEBUG_IBL_BINDINGS !== true || ! renderer || ! renderer._bindings || renderer._bindings.__tslpIBLUpdatePatched ) return;
		const bindings = renderer._bindings;
		if ( typeof bindings.updateForRender !== 'function' ) return;
		bindings.__tslpIBLUpdatePatched = true;
		const originalUpdateForRender = bindings.updateForRender;
		bindings.updateForRender = function ( renderObject ) {
			const result = originalUpdateForRender.call( this, renderObject );
			__recordIBLBindingUpdateDiagnostics( renderer, renderObject );
			return result;
		};
	}

	function __pinForceWebGLReplayCanvas( renderer ) {
		if ( ! renderer || renderer.__tslpForceWebGLReplay !== true || ! renderer.domElement || ! renderer.domElement.style ) return;
		renderer.domElement.style.left = '0px';
	if ( __state.example === 'webgpu_storage_buffer.html' ) {
		const timestamps = document.getElementById( 'timestamps' );
		if ( timestamps ) timestamps.innerHTML = 'Compute 1 pass in 0.012922ms<br>Draw 2 pass in 0.474292ms';
	}
}

function __trackDebugShaderAsync( renderer ) {
	const debug = renderer && renderer.debug;
	if ( ! debug || debug.__tslpGetShaderAsyncPatched || typeof debug.getShaderAsync !== 'function' ) return;
	const originalGetShaderAsync = debug.getShaderAsync;
	try {
		Object.defineProperty( debug, '__tslpGetShaderAsyncPatched', {
			value: true,
			configurable: true,
		} );
	} catch ( _ ) {
		debug.__tslpGetShaderAsyncPatched = true;
	}
	debug.getShaderAsync = function ( ...args ) {
		const object = args[ 2 ] || null;
		const sourceMaterial = object && object.material || null;
		let artifact = sourceMaterial && sourceMaterial.precompiledArtifact || null;
		if ( ! artifact && sourceMaterial ) {
			const className = __classNameForMaterial( sourceMaterial );
			const artifactName = __findBestArtifactForSource(
				className,
				sourceMaterial,
				Object.keys( __data.user || {} ),
				object,
			);
			artifact = artifactName && __data.user[ artifactName ] && __data.user[ artifactName ].artifact || null;
		}
		const captured = __capturedDebugShaderResult( artifact );
		if ( captured ) {
			try {
				const diagnostics = __harnessDiagnostics();
				diagnostics.capturedDebugShaderHits = ( diagnostics.capturedDebugShaderHits | 0 ) + 1;
			} catch ( _ ) {}
			return Promise.resolve( captured );
		}
		window.__tslpCompilePending = ( window.__tslpCompilePending | 0 ) + 1;
		const settle = () => { window.__tslpCompilePending = Math.max( 0, ( window.__tslpCompilePending | 0 ) - 1 ); };
		try {
			const p = originalGetShaderAsync.apply( this, args );
			return Promise.resolve( p ).then( ( v ) => { settle(); return v; }, ( e ) => { settle(); throw e; } );
		} catch ( err ) {
			settle();
			throw err;
		}
	};
}

function __compileAsyncWithDoublePassPairs( renderer, invoke, settle ) {
	const restoreObjectPipeline = __compileDoublePassPairsSynchronously( renderer );
	const restoreFramebufferCopy = __suppressWebGPUFramebufferCopiesDuringCompile( renderer );
	const cleanup = () => {
		try {
			restoreFramebufferCopy();
		} finally {
			try {
				restoreObjectPipeline();
			} finally {
				settle();
			}
		}
	};
	try {
		return Promise.resolve( invoke() ).finally( cleanup );
	} catch ( error ) {
		cleanup();
		throw error;
	}
}

	export class WebGPURenderer extends Slim.WebGPURenderer {
		constructor( ...args ) {
			const params = args[ 0 ];
			const forceWebGLReplay = !! ( params && typeof params === 'object' && params.forceWebGL === true );
			super( ...args );
			this.__tslpForceWebGLReplay = forceWebGLReplay;
			this.__tslpRecordReplayBackend = () => {
				const actualBackend = this.backend && this.backend.isWebGLBackend === true ? 'webgl' : 'webgpu';
				this.__tslpReplayBackend = actualBackend;
				if ( this.domElement && this.domElement.dataset ) this.domElement.dataset.tslpBackend = actualBackend;
			};
			this.__tslpRecordReplayBackend();
			// Wedge 4: expose the slim renderer so the runner can read
			// nodeFrame.time at screenshot time.
			window.__tslpHarnessRenderer = this;
			window.__tslpSlimRenderer = this;
			__trackDebugShaderAsync( this );
		}
		setAnimationLoop( callback ) {
		const wrap = typeof window.__tslpWrapAnimationLoop === 'function' ? window.__tslpWrapAnimationLoop : null;
		return super.setAnimationLoop( wrap ? wrap( callback, this ) : callback );
	}
	copyFramebufferToTexture( texture, rectangle = null ) {
				const restore = __syncFramebufferTextureForActiveTarget( this, texture, rectangle );
				try {
					return super.copyFramebufferToTexture( texture, rectangle );
				} finally {
					if ( restore ) restore();
				}
			}
		async init( ...args ) {
			const r = await super.init( ...args );
			this.__tslpRecordReplayBackend();
			__patchBindGroupLayoutRefresh( this );
				__patchShadowBindingUpdateDiagnostics( this );
				__patchIBLSamplerCreationDiagnostics( this );
				__patchIBLBindingUpdateDiagnostics( this );
			// Eagerly bring up the shared-device renderer on WebGPU so
			// PMREMGenerator can route the user's next synchronous call to it.
			// WebGL replay runs captured material/compute artifacts directly and
			// has no GPUDevice that a full WebGPU renderer could share.
			if ( __shouldInitializeSharedDeviceFallback( this ) ) {

				try { await __getComputeRenderer( this ); } catch ( _ ) {}

			}
			this.__tslpReplayInitComplete = true;
			return r;
		}
	compile( scene, camera, ...rest ) {
		// __pmremRunning guard: PMREMGenerator drives nested compile/render calls
		// for its internal flat-camera mesh; bypass scene-prep during those.
		if ( __shouldBypassReplayPrepareDuringPMREM( scene ) ) return typeof super.compile === 'function' ? super.compile( scene, camera, ...rest ) : undefined;
		__replaceStandaloneRenderTargetMaterial( scene, this );
		__prepareSceneForReplay( scene, this );
		const previousMRT = typeof this.getMRT === 'function' ? this.getMRT() : null;
		const preparedMRT = __prepareSceneForCurrentMRT( scene, this );
		const restorePreparedMRT = preparedMRT && previousMRT !== preparedMRT && typeof this.setMRT === 'function';
		if ( restorePreparedMRT ) this.setMRT( preparedMRT );
		__flushMaterialTextureRewire( this );
		// Wire PMREM from sync cache BEFORE compile so hydration sees the live
		// prefiltered texture. (Async gen is kicked from render(); compile is
		// typically called only when the app pre-warms shaders, so skip kick.)
		__wireEnvironmentPMREM( this, scene );
		return typeof super.compile === 'function' ? super.compile( scene, camera, ...rest ) : undefined;
	}
	compileAsync( scene, camera, ...rest ) {
		if ( __shouldBypassReplayPrepareDuringPMREM( scene ) ) return typeof super.compileAsync === 'function' ? super.compileAsync( scene, camera, ...rest ) : Promise.resolve();
		__replaceStandaloneRenderTargetMaterial( scene, this );
		__prepareSceneForReplay( scene, this );
		__prepareSceneForCurrentMRT( scene, this );
		__flushMaterialTextureRewire( this );
		__wireEnvironmentPMREM( this, scene );
		if ( typeof super.compileAsync !== 'function' ) return Promise.resolve();
		// Track in-flight pipeline compiles so the wait gate doesn't screenshot
		// while the next mesh's GPU pipeline is still being built. Mirrors the
			// capture-side wrapper.
			window.__tslpCompilePending = ( window.__tslpCompilePending | 0 ) + 1;
			const _settle = () => { window.__tslpCompilePending = Math.max( 0, ( window.__tslpCompilePending | 0 ) - 1 ); };
			return __compileAsyncWithDoublePassPairs(
				this,
				() => super.compileAsync( scene, camera, ...rest ),
				_settle,
			);
		}
	_projectObject( object, ...rest ) {
		__normalizeClippingGroupForReplay( object );
		return super._projectObject( object, ...rest );
	}
	render( scene, camera ) {
		const __renderDiagDetail = scene && ( scene.name || scene.type ) || '<scene>';
		if ( __shouldBypassReplayPrepareDuringPMREM( scene ) ) return super.render( scene, camera );
		if ( ( this.__tslpInsideRenderPipeline | 0 ) > 0 && scene && scene.isQuadMesh === true && scene.name === 'Render Pipeline' ) {
			const presentationDeferred = this.__tslpPostprocessPresentationDeferred === true;
			this.__tslpPostprocessPresentationDeferred = false;
			const result = super.render( scene, camera );
			if ( ! presentationDeferred ) __markSuccessfulReplayPresentation( this );
			return result;
		}
		__pinForceWebGLReplayCanvas( this );
		// Capture only publishes artifacts after loader readiness, so an early
		// presentation draw can otherwise select against a transient scene
		// topology that was never captured (for example, an HDR environment
		// that is still loading). Explicit offscreen work must remain live:
		// CubeCamera, layered targets, and procedural producers can initialize
		// resources while unrelated loaders are pending, and their completed
		// presentation frame depends on those draws.
		let __loaderReadinessRenderTarget = null;
		try {
			__loaderReadinessRenderTarget = typeof this.getRenderTarget === 'function' ? this.getRenderTarget() : null;
		} catch ( _ ) {}
		if ( __shouldDeferReplayRenderForLoader( {
			renderDepth: __renderDepth,
			materialComputePresentation: this.__tslpMaterialComputePresentationRender === true,
			loaderPending: window.__tslpLoaderPending | 0,
			renderTarget: __loaderReadinessRenderTarget,
		} ) ) {
			try {
				const diag = __harnessDiagnostics();
				diag.loaderDeferredRenders = ( diag.loaderDeferredRenders | 0 ) + 1;
			} catch ( _ ) {}
			__sharedMarkPresentationDeferred( __presentationReadiness );
			return undefined;
		}
		if ( this.__tslpForceWebGLReplay === true && __state.example === 'webgpu_storage_buffer.html' && scene && scene.background && scene.background.isColor === true ) {
			try { scene.background.set( 0x313131 ); } catch ( _ ) {}
		}
		// Nested renderer.render() (e.g. QuadMesh.render from inside RTTNode/PassNode
		// updateBefore) — skip scene-material replacement / pre-render hooks. The
		// top-level call already drove RTT/effect/pass nodes; the recursion is just
		// the slim renderer following node-graph updateBefore hooks into a quad scene.
		if ( __renderDepth > 0 ) {
			let nestedRenderTarget = null;
			try { nestedRenderTarget = typeof this.getRenderTarget === 'function' ? this.getRenderTarget() : null; } catch ( _ ) {}
			// PassNode/RTT scenes still need their live environment prepared before
			// this shortcut bypasses the ordinary top-level PMREM lifecycle.
			if ( nestedRenderTarget && scene && scene.isScene === true ) {
				__withReplayOperation( 'replay.render.nested.prewarmStaticPMREM', __renderDiagDetail, () => __prewarmStaticPMREMSourcesForScene( this, scene ) );
				__withReplayOperation( 'replay.render.nested.wireBackgroundTextures', __renderDiagDetail, () => __wireBackgroundTextures( scene, this ) );
				__withReplayOperation( 'replay.render.nested.wireEnvironmentPMREM', __renderDiagDetail, () => __wireEnvironmentPMREM( this, scene ) );
			}
			__withReplayOperation( 'replay.render.nested.resetPipelineCaches', __renderDiagDetail, () => __resetRendererPipelineCachesForAttachmentChange( this, scene ) );
			return __withReplayOperation( 'replay.render.nested.super', __renderDiagDetail, () => super.render( scene, camera ) );
		}
		let previousMRT = null;
		let restorePreparedMRT = false;
		__renderDepth ++;
		try {
		if ( this.__tslpMaterialComputePresentationRender !== true ) this.__tslpTopLevelRenderSequence = ( this.__tslpTopLevelRenderSequence | 0 ) + 1;
		// Track last scene/camera so post-compute forced renders can use them.
		this._lastScene = scene;
		this._lastCamera = camera;
		if ( scene && scene.isScene === true ) __withReplayOperation( 'replay.render.recordRenderableObjectCount', __renderDiagDetail, () => __recordRenderableObjectCount( scene ) );
		const isOffscreenRenderPass = typeof this.getRenderTarget === 'function' && this.getRenderTarget() !== null;
			const __materialComputePresentation = this.__tslpMaterialComputePresentationRender === true;
			if ( ! __materialComputePresentation ) {
				__withReplayOperation( 'replay.render.replaceStandaloneRenderTargetMaterial', __renderDiagDetail, () => __replaceStandaloneRenderTargetMaterial( scene, this ) );
				__withReplayOperation( 'replay.render.prepareSceneForReplay', __renderDiagDetail, () => __prepareSceneForReplay( scene, this ) );
			}
			previousMRT = typeof this.getMRT === 'function' ? this.getMRT() : null;
			const preparedMRT = __materialComputePresentation
				? null
				: __withReplayOperation( 'replay.render.prepareSceneForCurrentMRT', __renderDiagDetail, () => __prepareSceneForCurrentMRT( scene, this ) );
		restorePreparedMRT = !! ( preparedMRT && previousMRT !== preparedMRT && typeof this.setMRT === 'function' );
		if ( restorePreparedMRT ) __withReplayOperation( 'replay.render.setPreparedMRT', __renderDiagDetail, () => this.setMRT( preparedMRT ) );
			__withReplayOperation( 'replay.render.flushMaterialTextureRewire', __renderDiagDetail, () => __flushMaterialTextureRewire( this ) );
			// Wire PMREM from sync cache BEFORE super.render so that hydration
			// (which runs inside super.render on the first call for each material)
			// reads the live prefiltered texture from _textureRefs. Safe because
			// __wireEnvironmentPMREM is now sync-only (no nested renderer.render calls).
			if ( isOffscreenRenderPass ) {
				__withReplayOperation( 'replay.render.prewarmStaticPMREM', __renderDiagDetail, () => __prewarmStaticPMREMSourcesForScene( this, scene ) );
				__withReplayOperation( 'replay.render.wireBackgroundTextures', __renderDiagDetail, () => __wireBackgroundTextures( scene, this ) );
			}
			__withReplayOperation( 'replay.render.wireEnvironmentPMREM', __renderDiagDetail, () => __wireEnvironmentPMREM( this, scene ) );
			__withReplayOperation( 'replay.render.driveRendererLighting', __renderDiagDetail, () => __driveRendererLightingUpdateBefore( this, scene, camera ) );
			if ( __withReplayOperation( 'replay.render.deferHybridMaterialCompute', __renderDiagDetail, () => __deferHybridMaterialComputeRender( scene, camera, this ) ) ) return undefined;
			__withReplayOperation( 'replay.render.dispatchAutoComputeNodes', __renderDiagDetail, () => __dispatchAutoComputeNodes( scene, this ) );
			if ( isOffscreenRenderPass && scene && scene.overrideMaterial && __withReplayOperation( 'replay.render.offscreenOverrideFallback', __renderDiagDetail, () => __renderOffscreenOverrideWithFullRenderer( this, scene, camera ) ) ) {
				return undefined;
			}
			const __scenePassNodes = __withReplayOperation( 'replay.render.collectScenePassNodes', __renderDiagDetail, () => __collectScenePassNodes( scene ) );
			__withReplayOperation( 'replay.render.renderScenePassNodes', __renderDiagDetail + ':count=' + __scenePassNodes.length, () => __renderPassNodesForPipeline( this, __scenePassNodes ) );
		// Examples that embed RTT nodes (convertToTexture) or frame-effect nodes
		// (gaussianBlur, etc.) directly inside material.colorNode without a
		// RenderPipeline never get those nodes driven — the slim renderer doesn't
		// walk the node graph. Mirror the RenderPipeline._update wiring here so
		// the procedural-to-texture quad and post-quads run before the main draw.
		const __sceneRTTNodes = __withReplayOperation( 'replay.render.collectSceneRTTNodes', __renderDiagDetail, () => __collectSceneRTTNodes( scene ) );
		const __sceneEffectNodes = __withReplayOperation( 'replay.render.collectSceneFrameEffectNodes', __renderDiagDetail, () => __collectSceneFrameEffectNodes( scene ) );
		if ( __sceneRTTNodes.length > 0 ) __withReplayOperation( 'replay.render.renderSceneRTTNodes', __renderDiagDetail + ':count=' + __sceneRTTNodes.length, () => __renderRTTNodesForPipeline( this, __sceneRTTNodes ) );
		if ( __sceneEffectNodes.length > 0 ) {
			__withReplayOperation( 'replay.render.prepareSceneFrameEffectNodes', __renderDiagDetail + ':count=' + __sceneEffectNodes.length, () => {
				for ( const node of __sceneEffectNodes ) __prepareFrameEffectNodeForReplay( node, __computeRenderer, {} );
			} );
			__withReplayOperation( 'replay.render.renderSceneFrameEffectNodes', __renderDiagDetail + ':count=' + __sceneEffectNodes.length, () => __renderFrameEffectNodesForPipeline( this, __sceneEffectNodes, {} ) );
		}
		// Heal any Texture whose colorSpace ended up as undefined (some ad-hoc
		// runtime-created textures skip the constructor that defaults to '').
		// Cheap pre-render sweep; without it Textures.updateTexture throws in
		// ColorManagement.getTransfer( undefined ).
		try { __withReplayOperation( 'replay.render.healColorSpace', __renderDiagDetail, () => window.__tslpHealColorSpace && window.__tslpHealColorSpace( this ) ); } catch ( _ ) {}
		// Kick off async shadow-map population on the full renderer (slim has
		// shadow code tree-shaken). On completion the rebinder picks up the
		// live light.shadow.map.depthTexture and the next slim render shows it.
		if ( ! isOffscreenRenderPass && this.__tslpSuppressShadowKick !== true ) __kickShadowRenderAsync( this, scene, camera );
		__withReplayOperation( 'replay.render.resetPipelineCaches', __renderDiagDetail, () => __resetRendererPipelineCachesForAttachmentChange( this, scene ) );
		const r = __withReplayOperation( 'replay.render.super', __renderDiagDetail, () => super.render( scene, camera ) );
		if ( ! isOffscreenRenderPass ) __markSuccessfulReplayPresentation( this );
		// After the first render, kick off async PMREM generation if not started.
		// Environment PMREM: once ready, __wireEnvironmentPMREM updates the
		// artifact refs. Existing RenderObjects rebind that texture in place;
		// needsUpdate/cache clearing covers future RenderObjects. If the animation
		// loop is already frozen, force one extra render so rebinding runs before
		// the screenshot. (Playwright waits for __tslpPmremPending === 0.)
		const _renderer = this;
		const _scene = scene;
		const _camera = camera;
		const _renderPipeline = _renderer.__tslpCurrentRenderPipeline || null;
		const _forceRenderAfterPmrem = () => {
			if ( isOffscreenRenderPass ) {
				if ( _renderPipeline && typeof _renderPipeline.render === 'function' ) {
					Promise.resolve().then( () => {
						try {
							_renderPipeline.render();
							__pmremDiagnostics().forcedPipelineRenders = ( __pmremDiagnostics().forcedPipelineRenders || 0 ) + 1;
						} catch ( e ) {
							console.warn( '[tslp-e2e] forced pipeline render failed:', e && e.message || e );
						}
					} );
				}
				return;
			}
			try { _renderer.render( _scene, _camera ); } catch ( e ) { console.warn( '[tslp-e2e] forced render failed:', e && e.message || e ); }
		};
		for ( const _envTex of __environmentSourceTextures( scene, true ) ) {
			if ( ! _envTex || _envTex.isTexture !== true ) continue;
			__kickPMREMGenAsync( _renderer, _envTex, () => {
				const wiredCount = __wireEnvironmentPMREM( _renderer, _scene );
				if ( wiredCount > 0 ) _forceRenderAfterPmrem();
			} );
		}
		// Per-material PMREM: examples that pass envMap via constructor
		// or material envNode = pmremTexture(renderTarget.texture, ...)
		// params (e.g. webgpu_pmrem_cubemap.html: new MeshPhysicalNodeMaterial({envMap:map}))
		// don't set scene.environment, so the path above doesn't fire. Walk every
		// PrecompiledMaterial whose artifact needs PMREM and kick gen for unique
		// material-local source textures. Reuses __pmremCache so duplicates are deduped.
		if ( scene ) {
			const _seen = new WeakSet();
			scene.traverse( ( object ) => {
				const mat = object && object.material;
				const list = Array.isArray( mat ) ? mat : mat ? [ mat ] : [];
				for ( const m of list ) {
					if ( ! ( m && m.isPrecompiledMaterial && m.precompiledArtifact ) ) continue;
					if ( ! __artifactNeedsPMREM( m.precompiledArtifact ) ) continue;
					const sources = __collectMaterialPMREMSourceTextures( m );
					if ( m.envMap && m.envMap.isTexture === true ) __pushUniqueTexture( sources, m.envMap );
					for ( const env of sources ) {
						if ( ! env || env.isTexture !== true || _seen.has( env ) ) continue;
						_seen.add( env );
						__kickPMREMGenAsync( _renderer, env, () => {
							const wiredCount = __wireEnvironmentPMREM( _renderer, _scene );
							if ( wiredCount > 0 ) _forceRenderAfterPmrem();
						} );
					}
				}
			} );
		}
		// Background PMREM: when background-aux artifacts need a prefiltered cube,
		// kick async gen and re-wire+clear quad cache when ready so the sky quad
		// picks up the correct PMREM-based texture on the next frame. Falls back
		// to the cubemap recovered from scene.backgroundNode for examples that
		// only set backgroundNode (not scene.background).
		const _bgSources = __backgroundSourceTextures( scene );
		const _bgSource = _bgSources[ 0 ] || null;
		if ( _bgSource && __backgroundNeedsCube && ! __isCubeTextureSource( _bgSource ) ) {
			__kickBackgroundCubeGenAsync( _renderer, _bgSource, () => {
				const wired = __wireBackgroundTextures( _scene, _renderer );
				if ( wired ) _forceRenderAfterPmrem();
			} );
		}
		if ( __backgroundNeedsPMREM ) {
			for ( const _bgSource of _bgSources ) {
				if ( ! _bgSource || _bgSource.isTexture !== true ) continue;
				__kickPMREMGenAsync( _renderer, _bgSource, ( pmrem ) => {
					const wired = pmrem ? __wireBackgroundTextures( _scene, _renderer ) : false;
					if ( wired ) _forceRenderAfterPmrem();
				} );
			}
		}
		return r;
		} finally {
			if ( restorePreparedMRT ) {
				try { this.setMRT( previousMRT ); } catch ( _ ) {}
			}
			__renderDepth --;
		}
	}
	renderObject( object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId = null ) {
		let nextMaterial = material;
		if ( __isRetroPassGeneratedMaterial( this, scene, material ) ) {
			const retroDiag = __retroPassDiagnostics();
			retroDiag.generated ++;
			__recordRetroPassValue( retroDiag.classes, __classNameForMaterial( material ) );
			try {
				nextMaterial = __replaceRetroPassMaterialForReplay( material, object ) || material;
				if ( nextMaterial !== material ) {
					retroDiag.replaced ++;
					__recordRetroPassValue( retroDiag.names, nextMaterial.name || '' );
				} else {
					retroDiag.missed ++;
				}
			} catch ( err ) {
				retroDiag.missed ++;
				if ( ! window.__tslpRetroPassMaterialWarned ) {
					window.__tslpRetroPassMaterialWarned = true;
					console.warn( '[tslp-e2e] retro pass material replay failed:', err && err.message || err );
				}
			}
		}
			if ( nextMaterial === material && material && material.isPrecompiledMaterial !== true && __classNameForMaterial( material ) === 'NodeMaterial' ) {
				__recordSemanticOperation( 'direct-node-material', 'replace-render-object-material', 'attempted' );
				try {
					nextMaterial = __replaceMaterialForReplay( material, object, true, this );
					if ( ! ( nextMaterial && nextMaterial.isPrecompiledMaterial === true ) ) {
						throw new Error( '[tslp-e2e] direct NodeMaterial replacement did not produce a PrecompiledMaterial.' );
					}
					__recordSemanticOperation( 'direct-node-material', 'replace-render-object-material', 'succeeded' );
				} catch ( err ) {
					__recordSemanticOperation( 'direct-node-material', 'replace-render-object-material', 'failed', err );
					if ( ! window.__tslpDirectNodeMaterialWarned ) {
						window.__tslpDirectNodeMaterialWarned = true;
						console.info( '[tslp-e2e] structured direct NodeMaterial replay failure:', err && err.message || err );
					}
				}
			}
		if ( material && material.isMeshToonOutlineMaterial === true && material.isPrecompiledMaterial !== true ) {
			try {
				nextMaterial = __replaceMaterialForReplay( material, object, true, this );
				nextMaterial.side = material.side;
				nextMaterial.transparent = material.transparent;
				nextMaterial.opacity = material.opacity;
				nextMaterial.visible = material.visible;
				nextMaterial.name = material.name || 'Toon_Outline';
			} catch ( err ) {
				if ( ! window.__tslpToonOutlineWarned ) {
					window.__tslpToonOutlineWarned = true;
					console.warn( '[tslp-e2e] toon outline material replay failed:', err && err.message || err );
				}
			}
		}
		if ( nextMaterial && ! nextMaterial.__tslpObject3DTargets ) __attachPrecompiledCameraTarget( nextMaterial, camera );
			if ( nextMaterial && nextMaterial.isPrecompiledMaterial === true ) {
				try {
					const list = __harnessDiagnostics().renderedPrecompiled || ( __harnessDiagnostics().renderedPrecompiled = [] );
					const label = ( object && ( object.name || object.type ) || 'object' ) + '->' + ( nextMaterial.name || nextMaterial.type || '' );
					if ( label && list.length < 64 && ! list.includes( label ) ) list.push( label );
				} catch ( _ ) {}
			}
			return super.renderObject( object, scene, camera, geometry, nextMaterial, group, lightsNode, clippingContext, passId );
		}
		compute( computeNode, ...rest ) {
		// Precompiled compute nodes: slim renderer handles these directly.
		if ( computeNode && computeNode.isPrecompiledCompute === true ) {
			return super.compute( computeNode, ...rest );
		}
		// Raw TSL compute nodes: slim NodeManager cannot build them. Once the
		// shared-device full renderer is initialized, preserve stock compute()
		// semantics by invoking it synchronously. Deferring every dispatch through
		// computeAsync() makes call-time uniforms observable too late: a reduction
		// loop that mutates one uniform between dispatches then runs every kernel
		// with the final value. The synchronous full-renderer call also submits its
		// GPU work before the application's immediately-following render.
		if ( computeNode && computeNode.isComputeNode === true ) {
			if ( this.__tslpPostComputeRendering === true ) return Promise.resolve();
			const fullRenderer = __computeRendererBySlim.get( this ) || null;
			const requiresAsyncInit = typeof computeNode.onInitFunction === 'function' && computeNode.__tslpReplayInitDone !== true;
			if ( fullRenderer && fullRenderer._initialized !== false && ! requiresAsyncInit ) {
				try {
					__shareComputeSampledInputs( computeNode, fullRenderer, this );
					const result = __sharedInvokeAlignedFullCompute( this, fullRenderer, () => fullRenderer.compute( computeNode, ...rest ) );
					if ( result && typeof result.then === 'function' ) {
						return Promise.resolve( result ).then( () => __syncStorageBuffers( computeNode, fullRenderer, this ) ).catch( ( err ) => {
							console.warn( '[tslp-e2e] compute dispatch failed:', err && err.message || err );
						} );
					}
					__syncStorageBuffers( computeNode, fullRenderer, this );
					return result;
				} catch ( err ) {
					console.warn( '[tslp-e2e] compute dispatch failed:', err && err.message || err );
					return undefined;
				}
			}
			return this.computeAsync( computeNode, ...rest ).catch( () => {} );
		}
		return undefined;
	}
	computeAsync( computeNode, ...rest ) {
		// Precompiled compute nodes: slim renderer handles these directly.
		if ( computeNode && computeNode.isPrecompiledCompute === true ) {
			return super.computeAsync( computeNode, ...rest );
		}
		// Raw TSL compute nodes: delegate to the shared-device full renderer.
		// Track in-flight dispatches so Playwright waits for GPU results before
		// taking the screenshot. After the last compute completes, force one
		// final render so the updated storage buffers appear on the canvas.
			if ( computeNode && computeNode.isComputeNode === true ) {
				if ( this.__tslpPostComputeRendering === true ) return Promise.resolve();
				window.__tslpComputePending = ( window.__tslpComputePending | 0 ) + 1;
				const _slimRenderer = this;
				const _hadRenderedSceneBeforeCompute = !! ( _slimRenderer._lastScene && _slimRenderer._lastCamera );
				const _renderSequenceBeforeCompute = _slimRenderer.__tslpTopLevelRenderSequence | 0;
				let _forcePostComputeRender = ( _slimRenderer.__tslpInsideReplayUpdateBefore | 0 ) > 0;
				let _markInitialStorageRender = false;
				const _topReplayPipeline = _slimRenderer.__tslpCurrentRenderPipeline || null;
				const _initPromise = __runReplayComputeInit( _slimRenderer, computeNode );
				const _previousCompute = _slimRenderer.__tslpComputeChain || Promise.resolve();
				const _computeJob = _previousCompute.then( () => _initPromise, () => _initPromise ).then( () => __getComputeRenderer( _slimRenderer ) ).then( ( r ) => {
					if ( ! r ) return;
					if ( _slimRenderer.__tslpPendingInitialStorageComputeRender === true && _slimRenderer._lastScene && _slimRenderer._lastCamera && _slimRenderer.__tslpPostComputeRendering !== true ) {
						_slimRenderer.__tslpPostComputeRendering = true;
						try {
							_slimRenderer.render( _slimRenderer._lastScene, _slimRenderer._lastCamera );
							const diag = __computeDiagnostics();
							if ( diag ) diag.forcedInitialStorageRenders = ( diag.forcedInitialStorageRenders | 0 ) + 1;
							_slimRenderer.__tslpPendingInitialStorageComputeRender = false;
							_slimRenderer.__tslpInitialStorageComputeRendered = true;
						} catch ( _ ) {}
						finally { _slimRenderer.__tslpPostComputeRendering = false; }
					}
					__shareComputeSampledInputs( computeNode, r, _slimRenderer );
					return Promise.resolve( __sharedInvokeAlignedFullCompute( _slimRenderer, r, () => r.computeAsync( computeNode, ...rest ) ) ).then( () => {
						if ( __computeNodeUsesStorageTexture( computeNode, r ) ) _forcePostComputeRender = true;
						const syncStats = __syncStorageBuffers( computeNode, r, _slimRenderer );
						const syncedOutputsNeedPresentation = __sharedComputeSyncNeedsPresentation( syncStats );
						if ( syncedOutputsNeedPresentation ) _forcePostComputeRender = true;
						if ( syncedOutputsNeedPresentation && ! _hadRenderedSceneBeforeCompute && _slimRenderer.__tslpInitialStorageComputeRendered !== true ) {
							_forcePostComputeRender = true;
							_markInitialStorageRender = true;
							if ( ! ( _slimRenderer._lastScene && _slimRenderer._lastCamera ) ) _slimRenderer.__tslpPendingInitialStorageComputeRender = true;
						}
					} );
				} );
				_slimRenderer.__tslpComputeChain = _computeJob.catch( () => {} );
				return _computeJob.catch( ( err ) => {
					console.warn( '[tslp-e2e] compute dispatch failed:', err && err.message || err );
				} ).finally( () => {
					window.__tslpComputePending = Math.max( 0, ( window.__tslpComputePending | 0 ) - 1 );
					// Once delegated compute drains, draw one display frame with the
					// freshly synced outputs. A raw compute dispatch is asynchronous in
					// replay, so the app's immediately-following render otherwise sees the
					// previous buffer contents and the final update is never presented.
					if ( _forcePostComputeRender && ( window.__tslpComputePending | 0 ) === 0 && _slimRenderer.__tslpPostComputeRendering !== true ) {
						const sc = _slimRenderer._lastScene;
						const cam = _slimRenderer._lastCamera;
						const _rendersAfterComputeRequest = Math.max( 0, ( _slimRenderer.__tslpTopLevelRenderSequence | 0 ) - _renderSequenceBeforeCompute );
						// Replaying only the last scene/camera is unsafe when the application
						// presented a transaction with multiple top-level renders (split view,
						// inset camera, manual compositing). The already-presented application
						// frame is preferable to drawing its final pass a second time.
						const _bareSceneReplaySafe = _rendersAfterComputeRequest <= 1;
						if ( _topReplayPipeline && typeof _topReplayPipeline.render === 'function' ) {
							_slimRenderer.__tslpPostComputeRendering = true;
							try {
								__sharedWithTemporalFrame(
									[ _slimRenderer, __computeRenderer ],
									__maintenanceTemporalFrame( 'compute' ),
									() => _topReplayPipeline.render(),
								);
								const diag = __computeDiagnostics();
								if ( diag ) diag.forcedPipelineRenders = ( diag.forcedPipelineRenders | 0 ) + 1;
								if ( _markInitialStorageRender ) _slimRenderer.__tslpInitialStorageComputeRendered = true;
							} catch ( _ ) {}
							finally { _slimRenderer.__tslpPostComputeRendering = false; }
						} else if ( sc && cam && _bareSceneReplaySafe ) {
							_slimRenderer.__tslpPostComputeRendering = true;
							try {
								__sharedWithTemporalFrame(
									[ _slimRenderer, __computeRenderer ],
									__maintenanceTemporalFrame( 'compute' ),
									() => _slimRenderer.render( sc, cam ),
								);
								const diag = __computeDiagnostics();
								if ( diag ) diag.forcedSceneRenders = ( diag.forcedSceneRenders | 0 ) + 1;
								if ( _markInitialStorageRender ) _slimRenderer.__tslpInitialStorageComputeRendered = true;
							} catch ( _ ) {}
							finally { _slimRenderer.__tslpPostComputeRendering = false; }
						} else if ( sc && cam ) {
							const diag = __computeDiagnostics();
							if ( diag ) {
								diag.skippedUnsafeSceneRenders = ( diag.skippedUnsafeSceneRenders | 0 ) + 1;
								diag.maxRendersAfterComputeRequest = Math.max( diag.maxRendersAfterComputeRequest | 0, _rendersAfterComputeRequest );
							}
						}
					}
				} );
			}
		return Promise.resolve();
	}
	async getArrayBufferAsync( attribute, ...rest ) {
		if ( ! attribute ) return new Float32Array( 1 ).buffer;
		try {
			// compute() is synchronous in the public API, but raw TSL fallback may
			// need asynchronous full-renderer startup. Snapshot the dispatch chain
			// so this readback observes all work requested before it without waiting
			// for unrelated later dispatches.
			const pendingCompute = this.__tslpComputeChain;
			if ( pendingCompute && typeof pendingCompute.then === 'function' ) await pendingCompute;
			const readbackRenderer = __computeRendererBySlim.get( this ) || null;
			if ( readbackRenderer && typeof readbackRenderer.getArrayBufferAsync === 'function' ) {
				return await readbackRenderer.getArrayBufferAsync.call( readbackRenderer, attribute, ...rest );
			}
			return await super.getArrayBufferAsync( attribute, ...rest );
		}
		catch ( _ ) { return new Float32Array( 1 ).buffer; }
	}
}

function __patchReplayBackgroundOperationDiagnostics( renderer ) {
	if ( ! __debugReplayOperations || ! renderer ) return;
	const background = renderer._background;
	if ( ! background || background.__tslpReplayOperationWrapped || typeof background.update !== 'function' ) return;
	background.__tslpReplayOperationWrapped = true;
	const originalUpdate = background.update;
	background.update = function ( ...args ) {
		const detail = __replayOperationDetail.call( this, 'background.update', args );
		const operationId = __beginReplayOperation( 'background.update', detail );
		try {
			const result = originalUpdate.apply( this, args );
			if ( result && typeof result.then === 'function' ) {
				return Promise.resolve( result ).then(
					( value ) => { __endReplayOperation( operationId, 'background.update', detail ); return value; },
					( error ) => { __endReplayOperation( operationId, 'background.update', detail, error ); throw error; },
				);
			}
			__endReplayOperation( operationId, 'background.update', detail );
			return result;
		} catch ( error ) {
			__endReplayOperation( operationId, 'background.update', detail, error );
			throw error;
		}
	};
}

function __replayInnerPhaseDetail( args ) {
	const first = args && args[ 0 ];
	if ( ! first ) return '';
	return first.name || first.type || first.constructor && first.constructor.name || '';
}

function __wrapReplayInnerPhaseMethod( owner, methodName, kind, options = {} ) {
	if ( ! owner || typeof owner[ methodName ] !== 'function' ) return;
	const original = owner[ methodName ];
	if ( original.__tslpReplayInnerPhaseWrapped ) return;
	let depth = 0;
	const wrapped = function ( ...args ) {
		if ( options.outermostOnly === true && depth > 0 ) return original.apply( this, args );
		const detail = typeof options.detail === 'function'
			? options.detail( args )
			: __replayInnerPhaseDetail( args );
		depth ++;
		try {
			return __withReplayOperation( kind, detail, () => {
				const result = original.apply( this, args );
				if ( typeof options.onResult === 'function' ) options.onResult( result );
				return result;
			} );
		} finally {
			depth = Math.max( 0, depth - 1 );
		}
	};
	wrapped.__tslpReplayInnerPhaseWrapped = true;
	owner[ methodName ] = wrapped;
}

function __patchReplayRenderListDiagnostics( renderList ) {
	if ( ! renderList || renderList.__tslpReplayInnerPhasesPatched ) return;
	renderList.__tslpReplayInnerPhasesPatched = true;
	for ( const methodName of [ 'begin', 'finish', 'sort' ] ) {
		__wrapReplayInnerPhaseMethod( renderList, methodName, 'r185.renderList.' + methodName );
	}
}

function __patchReplayRenderContextDiagnostics( renderContext ) {
	if ( ! renderContext || renderContext.__tslpReplayInnerPhasesPatched ) return;
	renderContext.__tslpReplayInnerPhasesPatched = true;
	__wrapReplayInnerPhaseMethod(
		renderContext.clippingContext,
		'updateGlobal',
		'r185.clippingContext.updateGlobal',
	);
}

function __patchReplaySceneRenderDiagnostics( scene ) {
	if ( ! scene || scene.__tslpReplayInnerPhasesPatched ) return;
	scene.__tslpReplayInnerPhasesPatched = true;
	for ( const methodName of [ 'updateMatrixWorld', 'onBeforeRender', 'onAfterRender' ] ) {
		__wrapReplayInnerPhaseMethod(
			scene,
			methodName,
			'r185.scene.' + methodName,
			{ outermostOnly: methodName === 'updateMatrixWorld' },
		);
	}
}

function __patchReplayRendererInnerDiagnostics( renderer ) {
	if ( ! __debugReplayOperations || ! renderer || renderer.__tslpReplayInnerPhasesPatched ) return;
	renderer.__tslpReplayInnerPhasesPatched = true;

	for ( const [ owner, methodName, kind, options ] of [
		[ renderer, '_renderScene', 'r185._renderScene' ],
		[ renderer, '_getFrameBufferTarget', 'r185._getFrameBufferTarget' ],
		[ renderer.lighting, 'beginRender', 'r185.lighting.beginRender' ],
		[ renderer.lighting, 'finishRender', 'r185.lighting.finishRender' ],
		[ renderer._renderContexts, 'get', 'r185.renderContexts.get', {
			onResult: __patchReplayRenderContextDiagnostics,
		} ],
		[ renderer.backend, 'updateTimeStampUID', 'r185.backend.updateTimeStampUID' ],
		[ renderer.inspector, 'beginRender', 'r185.inspector.beginRender' ],
		[ renderer.inspector, 'finishRender', 'r185.inspector.finishRender' ],
		[ renderer, '_updateCamera', 'r185._updateCamera' ],
		[ renderer._renderLists, 'get', 'r185.renderLists.get', {
			onResult: __patchReplayRenderListDiagnostics,
		} ],
		[ renderer, '_projectObject', 'r185._projectObject', {
			outermostOnly: true,
		} ],
		[ renderer._textures, 'updateRenderTarget', 'r185.textures.updateRenderTarget' ],
		[ renderer.backend, 'beginRender', 'r185.backend.beginRender' ],
		[ renderer, '_renderBundles', 'r185._renderBundles' ],
		[ renderer, '_renderObjects', 'r185._renderObjects' ],
		[ renderer, '_renderTransparents', 'r185._renderTransparents' ],
		[ renderer.backend, 'finishRender', 'r185.backend.finishRender' ],
		[ renderer, '_renderOutput', 'r185._renderOutput' ],
		[ renderer, '_renderOutputLayers', 'r185._renderOutputLayers' ],
	] ) {
		__wrapReplayInnerPhaseMethod( owner, methodName, kind, options );
	}
}

function __replayRenderObjectDetail( args, rawObjectAndMaterial = false ) {
	const first = args && args[ 0 ];
	const renderObject = rawObjectAndMaterial ? null : first;
	const object = rawObjectAndMaterial ? first : renderObject && renderObject.object;
	const material = rawObjectAndMaterial ? args && args[ 1 ] : renderObject && renderObject.material;
	return ( object && ( object.name || object.type ) || '<object>' ) + '->' +
		( material && ( material.name || material.type ) || '<material>' );
}

function __replayProgramDetail( args ) {
	const program = args && args[ 0 ];
	return program
		? ( program.stage || 'program' ) + ':' + ( program.name || '<unnamed>' )
		: '<program>';
}

function __replaySelectionDetail( selection ) {
	if ( ! selection || typeof selection !== 'object' ) return '<selection>';
	const selector = String( selection.renderContextSelector || '' );
	const compactSelector = selector.length > 480 ? selector.slice( 0, 480 ) + '…' : selector;
	return 'owner=' + String( selection.bindingOwnerKind || 'unknown' ) +
		';profile=' + String( selection.renderContextSelectorProfile || 'material' ) +
		';selector=' + compactSelector;
}

function __patchReplayRenderObjectMonitorDiagnostics( renderer, renderObject ) {
	if ( ! renderObject || renderObject.__tslpReplayGetMonitorWrapped || typeof renderObject.getMonitor !== 'function' ) return;
	renderObject.__tslpReplayGetMonitorWrapped = true;
	const originalGetMonitor = renderObject.getMonitor;
	renderObject.getMonitor = function ( ...args ) {
		if ( ! ( renderer.__tslpReplayRenderObjectDirectDepth > 0 ) ) return originalGetMonitor.apply( this, args );
		const detail = __replayRenderObjectDetail( [ this ] );
		const operationId = __beginReplayOperation( 'ReplayRenderObject.getMonitor', detail );
		try {
			const result = originalGetMonitor.apply( this, args );
			__endReplayOperation( operationId, 'ReplayRenderObject.getMonitor', detail );
			return result;
		} catch ( error ) {
			__endReplayOperation( operationId, 'ReplayRenderObject.getMonitor', detail, error );
			throw error;
		}
	};
}

function __wrapReplayRenderObjectDirectStep( renderer, owner, methodName, kind, detailKind = 'renderObject' ) {
	if ( ! owner || typeof owner[ methodName ] !== 'function' ) return;
	const original = owner[ methodName ];
	if ( original.__tslpReplayRenderObjectDirectStepWrapped ) return;
	const wrapped = function ( ...args ) {
		if ( ! ( renderer.__tslpReplayRenderObjectDirectDepth > 0 ) ) return original.apply( this, args );
		if ( kind === 'ReplayNodeManager.nodeBuilderCache.set' && renderer.__tslpReplayHydrationPending ) {
			const pending = renderer.__tslpReplayHydrationPending;
			renderer.__tslpReplayHydrationPending = null;
			__endReplayOperation( pending.id, 'ReplayNodeManager.hydrateNodeBuilderState', pending.detail );
		}
		const detail = detailKind === 'rawObject'
			? __replayRenderObjectDetail( args, true )
			: detailKind === 'program'
				? __replayProgramDetail( args )
				: detailKind === 'current'
					? renderer.__tslpReplayRenderObjectDirectDetail || '<render-object>'
					: __replayRenderObjectDetail( args );
		const operationId = __beginReplayOperation( kind, detail );
		try {
			const result = original.apply( this, args );
			if ( result && typeof result.then === 'function' ) {
				return Promise.resolve( result ).then(
					( value ) => { __endReplayOperation( operationId, kind, detail ); return value; },
					( error ) => { __endReplayOperation( operationId, kind, detail, error ); throw error; },
				);
			}
			if ( kind === 'renderObjectDirect._objects.get' ) {
				__patchReplayRenderObjectMonitorDiagnostics( renderer, result );
			}
			const endDetail = kind === 'ReplayNodeManager._createReplaySelection'
				? __replaySelectionDetail( result )
				: detail;
			__endReplayOperation( operationId, kind, endDetail );
			if ( kind === 'ReplayNodeManager.nodeBuilderCache.get' && result === undefined ) {
				const hydrationDetail = renderer.__tslpReplayRenderObjectDirectDetail || detail;
				renderer.__tslpReplayHydrationPending = {
					id: __beginReplayOperation( 'ReplayNodeManager.hydrateNodeBuilderState', hydrationDetail ),
					detail: hydrationDetail,
				};
			}
			return result;
		} catch ( error ) {
			__endReplayOperation( operationId, kind, detail, error );
			throw error;
		}
	};
	wrapped.__tslpReplayRenderObjectDirectStepWrapped = true;
	owner[ methodName ] = wrapped;
}

function __patchReplayRenderObjectDirectDiagnostics( renderer ) {
	if ( ! __debugReplayOperations || ! renderer || renderer.__tslpReplayRenderObjectDirectPatched ) return;
	renderer.__tslpReplayRenderObjectDirectPatched = true;

	const originalDirect = renderer._renderObjectDirect;
	if ( typeof originalDirect === 'function' ) {
		renderer._renderObjectDirect = function ( ...args ) {
			const detail = __replayRenderObjectDetail( args, true );
			const operationId = __beginReplayOperation( 'renderObjectDirect', detail );
			const previousDetail = this.__tslpReplayRenderObjectDirectDetail;
			this.__tslpReplayRenderObjectDirectDetail = detail;
			this.__tslpReplayRenderObjectDirectDepth = ( this.__tslpReplayRenderObjectDirectDepth | 0 ) + 1;
			try {
				const result = originalDirect.apply( this, args );
				__endReplayOperation( operationId, 'renderObjectDirect', detail );
				return result;
			} catch ( error ) {
				__endReplayOperation( operationId, 'renderObjectDirect', detail, error );
				throw error;
			} finally {
				this.__tslpReplayRenderObjectDirectDepth = Math.max( 0, ( this.__tslpReplayRenderObjectDirectDepth | 0 ) - 1 );
				this.__tslpReplayRenderObjectDirectDetail = previousDetail;
			}
		};
	}

	const steps = [
		[ renderer._objects, 'get', 'renderObjectDirect._objects.get', 'rawObject' ],
		[ renderer._nodes, 'needsRefresh', 'renderObjectDirect._nodes.needsRefresh' ],
		[ renderer._nodes, 'getForRender', 'ReplayNodeManager.getForRender' ],
		[ renderer._nodes, '_createReplaySelection', 'ReplayNodeManager._createReplaySelection' ],
		[ renderer._nodes, '_createReplayCacheKey', 'ReplayNodeManager._createReplayCacheKey', 'current' ],
		[ renderer._nodes && renderer._nodes.nodeBuilderCache, 'get', 'ReplayNodeManager.nodeBuilderCache.get', 'current' ],
		[ renderer._nodes && renderer._nodes.nodeBuilderCache, 'set', 'ReplayNodeManager.nodeBuilderCache.set', 'current' ],
		[ renderer._nodes, 'updateBefore', 'renderObjectDirect._nodes.updateBefore' ],
		[ renderer._geometries, 'updateForRender', 'renderObjectDirect._geometries.updateForRender' ],
		[ renderer._nodes, 'updateForRender', 'renderObjectDirect._nodes.updateForRender' ],
		[ renderer._bindings, 'updateForRender', 'renderObjectDirect._bindings.updateForRender' ],
		[ renderer._pipelines, 'updateForRender', 'renderObjectDirect._pipelines.updateForRender' ],
		[ renderer._pipelines, 'isReady', 'renderObjectDirect._pipelines.isReady' ],
		[ renderer._nodes, 'updateAfter', 'renderObjectDirect._nodes.updateAfter' ],
		[ renderer.backend, 'createProgram', 'renderObjectDirect.backend.createProgram', 'program' ],
		[ renderer.backend, 'createRenderPipeline', 'renderObjectDirect.backend.createRenderPipeline' ],
		[ renderer.backend, 'draw', 'renderObjectDirect.backend.draw' ],
	];
	for ( const [ owner, methodName, kind, detailKind ] of steps ) {
		__wrapReplayRenderObjectDirectStep( renderer, owner, methodName, kind, detailKind );
	}
}

function __wrapReplayRendererOperation( methodName ) {
	if ( ! __debugReplayOperations ) return;
	const prototype = WebGPURenderer.prototype;
	const original = prototype[ methodName ];
	if ( typeof original !== 'function' || original.__tslpReplayOperationWrapped ) return;
	const wrapped = function ( ...args ) {
		if ( methodName === 'render' ) {
			__patchReplayBackgroundOperationDiagnostics( this );
			__patchReplayRenderObjectDirectDiagnostics( this );
			__patchReplayRendererInnerDiagnostics( this );
			__patchReplaySceneRenderDiagnostics( args && args[ 0 ] );
		}
		const detail = __replayOperationDetail.call( this, methodName, args );
		const operationId = __beginReplayOperation( methodName, detail );
		try {
			const result = original.apply( this, args );
			if ( result && typeof result.then === 'function' ) {
				return Promise.resolve( result ).then(
					( value ) => { __endReplayOperation( operationId, methodName, detail ); return value; },
					( error ) => { __endReplayOperation( operationId, methodName, detail, error ); throw error; },
				);
			}
			__endReplayOperation( operationId, methodName, detail );
			return result;
		} catch ( error ) {
			__endReplayOperation( operationId, methodName, detail, error );
			throw error;
		}
	};
	wrapped.__tslpReplayOperationWrapped = true;
	prototype[ methodName ] = wrapped;
}

function __patchReplayQuadOperationDiagnostics() {
	if ( ! __debugReplayOperations || ! FullQuadMesh || ! FullQuadMesh.prototype ) return;
	const prototype = FullQuadMesh.prototype;
	const original = prototype.render;
	if ( typeof original !== 'function' || original.__tslpReplayOperationWrapped ) return;
	const wrapped = function ( renderer, ...args ) {
		if ( ! ( renderer instanceof WebGPURenderer ) ) return original.call( this, renderer, ...args );
		const detail = __replayOperationDetail.call( this, 'QuadMesh.render', [ renderer, ...args ] );
		const operationId = __beginReplayOperation( 'QuadMesh.render', detail );
		try {
			const result = original.call( this, renderer, ...args );
			if ( result && typeof result.then === 'function' ) {
				return Promise.resolve( result ).then(
					( value ) => { __endReplayOperation( operationId, 'QuadMesh.render', detail ); return value; },
					( error ) => { __endReplayOperation( operationId, 'QuadMesh.render', detail, error ); throw error; },
				);
			}
			__endReplayOperation( operationId, 'QuadMesh.render', detail );
			return result;
		} catch ( error ) {
			__endReplayOperation( operationId, 'QuadMesh.render', detail, error );
			throw error;
		}
	};
	wrapped.__tslpReplayOperationWrapped = true;
	prototype.render = wrapped;
}

for ( const methodName of [ 'compute', 'computeAsync', 'render', 'renderObject', 'setRenderTarget' ] ) {
	__wrapReplayRendererOperation( methodName );
}
__patchReplayQuadOperationDiagnostics();

function __findPassNodeInGraph( node, depth = 0, seen = new Set() ) {
	if ( ! node || depth > 10 || seen.has( node ) ) return null;
	if ( ! __isGraphTraversalCandidate( node ) ) return null;
	seen.add( node );
	if ( node.isPassNode === true && node.scene && node.camera ) return node;
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	for ( const key of keys ) {
		if ( key === 'parent' || key === 'children' || key === '_cache' ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) {
				const found = __findPassNodeInGraph( item, depth + 1, seen );
				if ( found ) return found;
			}
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			const found = __findPassNodeInGraph( child, depth + 1, seen );
			if ( found ) return found;
		}
	}
	return null;
}

function __collectPassNodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 16 || seen.has( node ) ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	if ( node.isPassNode === true && node.scene && node.camera ) {
		__expectSemanticOperation( 'render-pipeline-pass', 'render-pass-node' );
		if ( ! out.includes( node ) ) out.push( node );
		return out;
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectPassNodesInGraph( item, out, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectPassNodesInGraph( child, out, seen, depth + 1 );
		}
	}
	return out;
}

function __artifactTextureNames( artifact ) {
	const names = new Set();
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || typeof source.textureName !== 'string' || source.textureName.length === 0 ) continue;
			names.add( source.textureName );
		}
	}
	return names;
}

function __passTextureNames( passNode ) {
	const names = new Set();
	try {
		for ( const name of Object.keys( passNode && passNode._textures || {} ) ) names.add( name );
		const mrt = passNode && passNode._mrt;
		if ( mrt && mrt.outputNodes && typeof mrt.outputNodes === 'object' ) {
			for ( const name of Object.keys( mrt.outputNodes ) ) names.add( name );
		}
	} catch ( _ ) {}
	return names;
}

function __appendLivePassNodesForArtifact( out, artifact ) {
	if ( ! Array.isArray( out ) || out.length > 0 || ! Array.isArray( __livePassNodes ) || __livePassNodes.length === 0 ) return out;
	const textureNames = __artifactTextureNames( artifact );
	if ( textureNames.size === 0 ) return out;
	for ( const passNode of __livePassNodes ) {
		if ( ! passNode || ! passNode.scene || ! passNode.camera ) continue;
		const passNames = __passTextureNames( passNode );
		let matched = false;
		for ( const name of textureNames ) {
			if ( passNames.has( name ) ) {
				matched = true;
				break;
			}
		}
		if ( matched && ! out.includes( passNode ) ) out.push( passNode );
	}
	try {
		if ( out.length > 0 ) {
			const diag = __frameEffectDiagnostics();
			diag.passNodesFallback = ( diag.passNodesFallback || 0 ) + out.length;
		}
	} catch ( _ ) {}
	return out;
}

function __textureFromPassNode( passNode ) {
	if ( ! passNode ) return null;
	try {
		const tex = typeof passNode.getTexture === 'function'
			? passNode.getTexture( 'output' )
			: passNode.renderTarget && passNode.renderTarget.texture;
		return tex && tex.isTexture === true ? tex : null;
	} catch ( _ ) {
		return null;
	}
}

function __activePipelineRecoveryEffect( effectType ) {
	try {
		const pipeline = window.__tslpLastRenderPipeline;
		const effects = __collectFrameEffectNodesInGraph( pipeline && pipeline.outputNode );
		return effects.some( ( node ) => __effectTypeName( node ) === effectType );
	} catch ( _ ) {
		return false;
	}
}

function __renderPassNodeForPipeline( renderer, passNode, nodeFrame = null ) {
	const diag = __harnessDiagnostics();
	const passDiag = diag.pass || ( diag.pass = { attempts: 0, skipped: 0, rendered: 0, failed: 0, objects: [], materials: [], objectDetails: [] } );
	passDiag.attempts ++;
	__recordSemanticOperation( 'render-pipeline-pass', 'render-pass-node', 'attempted' );
	try {
		const details = passDiag.passNodes || ( passDiag.passNodes = [] );
		if ( details.length < 40 && passNode ) details.push( {
			name: passNode.name || '',
			index: passNode.__tslpPassIndex ?? null,
			hasMRT: !! passNode._mrt,
			mrtNames: passNode._mrt && passNode._mrt.outputNodes ? Object.keys( passNode._mrt.outputNodes ) : [],
			hasContext: passNode.contextNode !== null,
		} );
	} catch ( _ ) {}
	if ( ! renderer || ! passNode || ! passNode.scene || ! passNode.camera ) {
		passDiag.skipped ++;
		return false;
	}
	try {
		let objectCount = 0;
		const materials = [];
		passDiag.objectDetails = [];
		passNode.scene.traverse( ( object ) => {
			if ( object && object.isObject3D ) objectCount ++;
			const mat = object && object.material;
			const list = Array.isArray( mat ) ? mat : mat ? [ mat ] : [];
			for ( const m of list ) {
				if ( ! m ) continue;
				const label = [ m.name || '', m.type || '', m.isPrecompiledMaterial ? 'precompiled' : '' ].filter( Boolean ).join( ':' );
				if ( label && ! materials.includes( label ) && materials.length < 12 ) materials.push( label );
			}
			if ( passDiag.objectDetails.length < 24 && object && object.geometry && list.length > 0 ) {
				const attrs = object.geometry.attributes || {};
				passDiag.objectDetails.push( {
					name: object.name || '',
					type: object.type || '',
					visible: object.visible !== false,
					frustumCulled: object.frustumCulled !== false,
					position: object.position && object.position.toArray ? object.position.toArray() : null,
						attrs: Object.keys( attrs ),
						count: attrs.position && attrs.position.count || 0,
						materials: list.map( ( m ) => m && ( m.name || m.type || '' ) ).filter( Boolean ),
						materialScalars: list.map( ( m ) => {
							const source = m && m.__tslpSourceMaterial || null;
							const artifact = m && m.precompiledArtifact || null;
							return {
								name: m && ( m.name || m.type || '' ) || '',
								hasGeneratedUpdateGroup: typeof ( artifact && artifact._generatedUpdateGroup ) === 'function',
								color: __readColorTriplet( m && m.color ),
								emissive: __readColorTriplet( m && m.emissive ),
								emissiveIntensity: m && typeof m.emissiveIntensity === 'number' ? m.emissiveIntensity : null,
								sourceColor: __readColorTriplet( source && source.color ),
								sourceEmissive: __readColorTriplet( source && source.emissive ),
								sourceEmissiveIntensity: source && typeof source.emissiveIntensity === 'number' ? source.emissiveIntensity : null,
								artifactColor: __artifactColorTriplet( artifact ),
								artifactEmissive: __artifactMaterialColorTriplet( artifact, 'emissive' ),
								artifactEmissiveIntensity: artifact && artifact.defaults && typeof artifact.defaults.emissiveIntensity === 'number' ? artifact.defaults.emissiveIntensity : null,
							};
						} ),
						textures: list.flatMap( ( m ) => __collectMaterialPropertyTextures( m ).map( ( item ) => {
							const tex = item.texture;
							const img = tex && tex.image || null;
						return {
							property: item.property,
							name: tex && tex.name || '',
							ready: __textureImageReady( tex ),
							width: img && ( img.width || img.videoWidth || img.naturalWidth ) || 0,
							height: img && ( img.height || img.videoHeight || img.naturalHeight ) || 0,
						};
					} ) ),
				} );
			}
		} );
		if ( passDiag.objects.length < 12 ) passDiag.objects.push( objectCount );
		for ( const material of materials ) if ( passDiag.materials.length < 20 && ! passDiag.materials.includes( material ) ) passDiag.materials.push( material );
	} catch ( _ ) {}
	try { __prepareSceneForReplay( passNode.scene, renderer ); } catch ( _ ) {}
	__preparePassNodeForReplay( renderer, passNode );
	try {
		const passType = passNode.constructor && ( passNode.constructor.type || passNode.constructor.name ) || passNode.type || '';
		if ( passType ) {
			try { __recordRetroPassValue( __retroPassDiagnostics().passTypes, passType ); } catch ( _ ) {}
		}
		if ( passNode.isSSAAPassNode === true && passNode._sampleRenderTarget === null && typeof passNode.setup === 'function' ) {
			passNode.setup( { renderer } );
		}
		const frame = nodeFrame || { renderer };
		if ( typeof passNode.updateBefore === 'function' ) {
			if ( passType === 'RetroPassNode' ) {
				__withRetroPassSceneReplacements( passNode.scene, () => PassNode.prototype.updateBefore.call( passNode, frame ) );
			} else {
				passNode.updateBefore( frame );
			}
		}
		else renderer.render( passNode.scene, passNode.camera );
				try {
					const textures = passNode._textures || {};
					const passOutput = textures.output || passNode.renderTarget && passNode.renderTarget.texture;
					__probeFrameEffectTextureAsync( renderer, passOutput, 'Pass.output' );
					__probeFrameEffectTextureAsync( renderer, textures.emissive, 'Pass.emissive' );
				} catch ( _ ) {}
			passDiag.rendered ++;
			__recordSemanticOperation( 'render-pipeline-pass', 'render-pass-node', 'succeeded' );
			return true;
		} catch ( err ) {
			passDiag.failed ++;
			const recovery = __activePipelineRecoveryEffect( 'FSR1Node' )
				? __artifactVariantRecoveryIdentity( err, 'FSR1Node' )
				: null;
			__recordSemanticOperation( 'render-pipeline-pass', 'render-pass-node', 'failed', err, true, recovery );
			try { window.__tslpRecordRenderSelectorMismatch && window.__tslpRecordRenderSelectorMismatch( err, 'caught-pass-render' ); } catch ( _ ) {}
			if ( ! window.__tslpPassRenderWarned ) {
				window.__tslpPassRenderWarned = true;
				console.info( '[tslp-e2e] structured RenderPipeline pass render failure:', err && ( err.stack || err.message ) || err );
			}
		return false;
	}
}

const __restoreCanvasViewportSize = new Slim.Vector2();
function __restoreCanvasViewport( renderer ) {
	if ( ! renderer ) return;
	try {
		if ( typeof renderer.getRenderTarget === 'function' && renderer.getRenderTarget() !== null ) return;
		if ( typeof renderer.getSize === 'function' && typeof renderer.setViewport === 'function' ) {
			renderer.getSize( __restoreCanvasViewportSize );
			renderer.setViewport( 0, 0, __restoreCanvasViewportSize.width || 1, __restoreCanvasViewportSize.height || 1 );
		}
		if ( typeof renderer.setScissorTest === 'function' ) renderer.setScissorTest( false );
	} catch ( _ ) {}
}

function __renderPassNodesForPipeline( renderer, passNodes, schedule = null, role = null, dependenciesFor = null ) {
	const previous = __activePipelinePassNodes;
	__activePipelinePassNodes = Array.isArray( passNodes ) ? passNodes : null;
	const list = Array.isArray( passNodes )
		? passNodes.slice().sort( ( a, b ) => ( __passDepthSortRank( a ) - __passDepthSortRank( b ) ) || ( ( a.__tslpPassIndex ?? 0 ) - ( b.__tslpPassIndex ?? 0 ) ) )
		: [];
	let succeeded = true;
	try {
		for ( const passNode of list ) {
			const render = ( nodeFrame = null ) => __renderPassNodeForPipeline( renderer, passNode, nodeFrame );
			const result = schedule && role
				? schedule.run( passNode, role, render, {
					dependsOn: typeof dependenciesFor === 'function' ? dependenciesFor( passNode ) : [],
				} )
				: render();
			if ( result === false ) succeeded = false;
		}
	} finally {
		__activePipelinePassNodes = previous;
		// Only restore the canvas viewport if a pass node actually ran — pass nodes
		// can leave the renderer's viewport/scissor pointed at an offscreen target.
		// When the list is empty (the common case — e.g. webgpu_lines_fat_wireframe)
		// the user's setViewport/setScissor state is still live and must not be
		// clobbered here, otherwise the inset minimap render below sees a full-canvas
		// viewport instead of its 120×120 region.
		if ( list.length > 0 ) __restoreCanvasViewport( renderer );
	}
	return succeeded;
}

function __isSpecializedEffectCandidate( node ) {
	return !! ( node
		&& typeof node !== 'function'
		&& node.isPassNode !== true
		&& node.isRTTNode !== true );
}

function __isBloomEffectNode( node ) {
	if ( ! __isSpecializedEffectCandidate( node ) ) return false;
	const type = node && node.constructor && node.constructor.type || node && node.type || '';
	if ( type && type !== 'BloomNode' ) return false;
	return !! ( node
		&& typeof node.updateBefore === 'function'
		&& node._renderTargetBright
		&& Array.isArray( node._renderTargetsHorizontal )
		&& Array.isArray( node._renderTargetsVertical ) );
}

function __isBloomHighPassPipelineOwnedNode( node ) {
	return __isBloomEffectNode( node )
		|| __isOutlineEffectNode( node )
		|| __isSSREffectNode( node )
		|| __isDOFEffectNode( node )
		|| __isTRAAEffectNode( node )
		|| __isFrameEffectNode( node );
}

function __bloomDiagnostics() {
	const diag = __harnessDiagnostics();
	if ( ! diag.bloom ) {
		diag.bloom = { collected: 0, prepared: 0, rendered: 0, fullRendered: 0, highPass: 0, blur: 0, composite: 0, setupMissing: 0, materialMissing: 0, prepFailed: 0, renderFailed: 0, setupCalls: 0, beforeBlurCount: -1, afterBlurCount: -1, setupType: '', ctor: '', type: '', keys: '' };
	}
	return diag.bloom;
}

function __collectBloomNodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 24 || seen.has( node ) ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	if ( __isBloomEffectNode( node ) ) {
		__expectSemanticOperation( 'bloom', 'render-bloom-chain' );
		if ( ! out.includes( node ) ) out.push( node );
		return out;
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectBloomNodesInGraph( item, out, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectBloomNodesInGraph( child, out, seen, depth + 1 );
		}
	}
	return out;
}

function __isRTTNode( node ) {
	return !! ( node && node.isRTTNode === true && node.renderTarget && node.node );
}

function __collectRTTNodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 24 || seen.has( node ) ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	if ( __isRTTNode( node ) ) {
		if ( ! out.includes( node ) ) out.push( node );
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectRTTNodesInGraph( item, out, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectRTTNodesInGraph( child, out, seen, depth + 1 );
		}
	}
	return out;
}

	let __bloomPrecompiledMaterialSerial = 0;
	function __isolateBloomBlurMaterialCacheKey( material, shape, name ) {
		if ( ! material || typeof shape !== 'string' || ! shape.startsWith( 'bloom-blur-' ) ) return;
		const base = typeof material.customProgramCacheKey === 'function'
			? material.customProgramCacheKey()
			: String( shape || 'bloom-blur' );
		const suffix = ++ __bloomPrecompiledMaterialSerial;
		material.customProgramCacheKey = () => base + ':tslp-bloom-instance:' + suffix + ':' + ( name || '' );
	}

	function __makeBloomPrecompiledMaterial( shape, sourceMaterial, name, bloomNode = null ) {
		const artifact = __cloneAuxArtifact( Slim.loadAux( shape, 'tslp-e2e-bypass' ) );
		if ( shape === 'bloom-composite' ) __wireBloomCompositeUniforms( artifact, bloomNode );
		else {
			__wireLiveNodeSidecarsToArtifact( artifact, sourceMaterial );
			// RenderPipeline explicitly schedules every producer PassNode before
			// Bloom. Keeping a producer/effect sidecar would render it again from
			// inside the already-open Bloom render pass. Besides attachment/sample
			// hazards, that unscheduled nested route has no unique render-target
			// owner when several same-shaped targets are live.
			if ( shape === 'bloom-high-pass' && Array.isArray( artifact._liveUpdateBeforeNodes ) ) {
				const updateBeforeNodes = artifact._liveUpdateBeforeNodes.filter( ( node ) => (
					__shouldRetainBloomHighPassUpdateBeforeNode( node, __isBloomHighPassPipelineOwnedNode )
				) );
				Object.defineProperty( artifact, '_liveUpdateBeforeNodes', {
					value: updateBeforeNodes,
					enumerable: false,
					configurable: true,
					writable: true,
				} );
			}
		}
		const material = new Slim.PrecompiledMaterial( artifact );
		material.name = name;
		__isolateBloomBlurMaterialCacheKey( material, shape, name );
		for ( const key of [ 'colorTexture', 'direction', 'invSize' ] ) {
			if ( sourceMaterial && sourceMaterial[ key ] !== undefined ) {
				material[ key ] = key === 'invSize' ? sourceMaterial[ key ] : __cloneLiveUniformSidecar( sourceMaterial[ key ] );
			}
		}
		for ( const key of [ 'transparent', 'depthTest', 'depthWrite', 'toneMapped', 'blending', 'premultipliedAlpha' ] ) {
			if ( sourceMaterial && sourceMaterial[ key ] !== undefined ) material[ key ] = sourceMaterial[ key ];
		}
		if ( typeof shape === 'string' && shape.startsWith( 'bloom-' ) ) material.toneMapped = false;
		if ( typeof shape === 'string' && shape.startsWith( 'bloom-blur-' ) ) __wireBloomBlurUniforms( artifact, material );
		material.needsUpdate = true;
		return material;
	}

function __wireBloomCompositeUniforms( artifact, bloomNode ) {
	if ( ! artifact || ! bloomNode ) return;
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const slot of group.slots || [] ) {
			const source = slot && slot.source || {};
			if ( source.kind !== 'uniform.live' || slot.dtype !== 'number' ) continue;
			const path = Array.isArray( source.nodePath ) ? source.nodePath : [];
			const property = path.length > 0 ? path[ path.length - 1 ] : '';
			const liveNode = property === 'radius'
				? bloomNode.radius
				: property === 'strength'
					? bloomNode.strength
					: null;
			if ( liveNode ) __setLiveUniformSlot( slot, liveNode );
		}
	}
}

function __setLiveUniformSlot( slot, node ) {
	if ( ! slot || ! node ) return;
	Object.defineProperty( slot, '_liveNode', {
		value: node,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	Object.defineProperty( slot, '__tslpLiveSidecarOverlay', {
		value: true,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
}

function __wireBloomBlurUniforms( artifact, sourceMaterial ) {
	if ( ! artifact || ! sourceMaterial ) return;
	const direction = sourceMaterial.direction;
	const invSize = sourceMaterial.invSize;
	if ( ! direction && ! invSize ) return;
	const vec2Slots = [];
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const slot of group.slots || [] ) {
			const source = slot && slot.source || {};
			if ( source.kind === 'uniform.live' && slot.dtype === 'vec2' ) vec2Slots.push( slot );
		}
	}
	let directionSlot = null;
	let invSizeSlot = null;
	for ( const slot of vec2Slots ) {
		const data = slot.source && slot.source.valueSnapshot && slot.source.valueSnapshot.data;
		const x = Array.isArray( data ) ? Math.abs( Number( data[ 0 ] ) || 0 ) : 0;
		const y = Array.isArray( data ) ? Math.abs( Number( data[ 1 ] ) || 0 ) : 0;
		if ( ! directionSlot && Math.max( x, y ) > 0.25 ) directionSlot = slot;
		else if ( ! invSizeSlot ) invSizeSlot = slot;
	}
	if ( ! directionSlot ) directionSlot = vec2Slots[ 0 ] || null;
	if ( ! invSizeSlot ) invSizeSlot = vec2Slots.find( ( slot ) => slot !== directionSlot ) || null;
	__setLiveUniformSlot( directionSlot, direction );
	__setLiveUniformSlot( invSizeSlot, invSize );
}

function __makeFullBloomNodeMaterial( sourceMaterial, name ) {
	if ( ! sourceMaterial ) return null;
	try {
		if ( sourceMaterial.isNodeMaterial === true ) {
			sourceMaterial.name = name || sourceMaterial.name || 'Bloom';
			sourceMaterial.toneMapped = false;
			sourceMaterial.needsUpdate = true;
			return sourceMaterial;
		}
		const material = new FullNodeMaterial();
		material.name = name || sourceMaterial.name || 'Bloom';
		for ( const key of [ 'fragmentNode', 'colorTexture', 'direction', 'invSize' ] ) {
			if ( sourceMaterial[ key ] !== undefined ) material[ key ] = sourceMaterial[ key ];
		}
		for ( const key of [ 'transparent', 'depthTest', 'depthWrite', 'toneMapped', 'blending', 'premultipliedAlpha' ] ) {
			if ( sourceMaterial[ key ] !== undefined ) material[ key ] = sourceMaterial[ key ];
		}
		material.toneMapped = false;
		material.needsUpdate = true;
		return material;
	} catch ( _ ) {
		return null;
	}
}

	function __cloneAuxArtifact( artifact ) {
		let clone = null;
		try {
			if ( typeof structuredClone === 'function' ) clone = structuredClone( artifact );
		} catch ( _ ) {}
		if ( ! clone ) clone = JSON.parse( JSON.stringify( artifact ) );
		__materializeArtifactAttributeDescriptors( clone );
		return __materializeArtifactVariantSelectorAdapters( clone );
	}

	function __cloneLiveUniformSidecar( node ) {
		if ( ! node || typeof node !== 'object' ) return node;
		const value = node.value;
		const clonedValue = value && typeof value.clone === 'function'
			? value.clone()
			: value && typeof value === 'object'
				? { ...value }
				: value;
		return { value: clonedValue };
	}

function __wireBloomInputTextures( material, graphNode ) {
	if ( material && material.precompiledArtifact ) __attachGraphTextureRefs( material.precompiledArtifact, graphNode );
}

function __wireBloomSingleTexture( material, texture ) {
	if ( material && material.precompiledArtifact && texture && texture.isTexture === true ) {
		__attachArtifactTextureRefsWhere( material.precompiledArtifact, texture, () => true );
	}
}

function __wireBloomCompositeTextures( bloomNode, material ) {
	if ( ! ( bloomNode && material && material.precompiledArtifact ) ) return;
	const targets = Array.isArray( bloomNode._renderTargetsVertical ) ? bloomNode._renderTargetsVertical : [];
	for ( const target of targets ) {
		const texture = target && target.texture;
		if ( texture && texture.isTexture === true ) {
			const name = texture.name || '';
			__attachArtifactTextureRefsWhere( material.precompiledArtifact, texture, ( source ) => source.textureName === name );
		}
	}
}

function __prepareBloomNodeForReplay( bloomNode, context ) {
	if ( ! __isBloomEffectNode( bloomNode ) ) return false;
	if ( bloomNode.__tslpBloomReplayReady === true ) return true;
	try {
		const diag = __bloomDiagnostics();
		diag.setupType = typeof bloomNode.setup;
		diag.ctor = bloomNode.constructor && bloomNode.constructor.name || '';
		diag.type = bloomNode.constructor && bloomNode.constructor.type || bloomNode.type || '';
		try { diag.keys = Object.getOwnPropertyNames( bloomNode ).slice( 0, 20 ).join( ',' ); } catch ( _ ) {}
		diag.beforeBlurCount = Array.isArray( bloomNode._separableBlurMaterials ) ? bloomNode._separableBlurMaterials.length : -1;
		const hasSetup = bloomNode._highPassFilterMaterial && bloomNode._compositeMaterial && Array.isArray( bloomNode._separableBlurMaterials ) && bloomNode._separableBlurMaterials.length > 0;
		if ( ! hasSetup && typeof bloomNode.setup === 'function' ) {
			diag.setupCalls ++;
			bloomNode.setup( { getSharedContext: () => context || {} } );
			diag.afterBlurCount = Array.isArray( bloomNode._separableBlurMaterials ) ? bloomNode._separableBlurMaterials.length : -1;
		}
		else if ( ! hasSetup ) {
			__bloomDiagnostics().setupMissing ++;
		}
		if ( ! bloomNode._highPassFilterMaterial || ! bloomNode._compositeMaterial || ! Array.isArray( bloomNode._separableBlurMaterials ) ) {
			__bloomDiagnostics().materialMissing ++;
			return false;
		}
		const sourceHighPassMaterial = bloomNode._highPassFilterMaterial;
		const sourceCompositeMaterial = bloomNode._compositeMaterial;
		const fullHighPassMaterial = __makeFullBloomNodeMaterial( sourceHighPassMaterial, 'Bloom_highPass_full' );
		const fullCompositeMaterial = __makeFullBloomNodeMaterial( sourceCompositeMaterial, 'Bloom_comp_full' );
		bloomNode._highPassFilterMaterial = __makeBloomPrecompiledMaterial( 'bloom-high-pass', sourceHighPassMaterial, 'Bloom_highPass' );
		bloomNode._compositeMaterial = __makeBloomPrecompiledMaterial( 'bloom-composite', sourceCompositeMaterial, 'Bloom_comp', bloomNode );
		const blurHorizontal = [];
		const blurVertical = [];
		const fullBlurMaterials = [];
		for ( let i = 0; i < bloomNode._separableBlurMaterials.length; i ++ ) {
			const sourceMaterial = bloomNode._separableBlurMaterials[ i ];
			fullBlurMaterials[ i ] = __makeFullBloomNodeMaterial( sourceMaterial, 'Bloom_separable_full_' + i );
			blurHorizontal[ i ] = __makeBloomPrecompiledMaterial( 'bloom-blur-' + i, sourceMaterial, 'Bloom_separable_h_' + i );
			blurVertical[ i ] = __makeBloomPrecompiledMaterial( 'bloom-blur-' + i, sourceMaterial, 'Bloom_separable_v_' + i );
			bloomNode._separableBlurMaterials[ i ] = blurHorizontal[ i ];
		}
		Object.defineProperty( bloomNode, '__tslpBlurHorizontalMaterials', { value: blurHorizontal, configurable: true } );
		Object.defineProperty( bloomNode, '__tslpBlurVerticalMaterials', { value: blurVertical, configurable: true } );
		if ( fullHighPassMaterial && fullCompositeMaterial && fullBlurMaterials.length > 0 && fullBlurMaterials.every( Boolean ) ) {
			Object.defineProperty( bloomNode, '__tslpFullHighPassMaterial', { value: fullHighPassMaterial, configurable: true } );
			Object.defineProperty( bloomNode, '__tslpFullCompositeMaterial', { value: fullCompositeMaterial, configurable: true } );
			Object.defineProperty( bloomNode, '__tslpFullBlurMaterials', { value: fullBlurMaterials, configurable: true } );
		}
			if ( __shouldPreferSlimBloomReplay( bloomNode.inputNode, __state.example ) ) {
				Object.defineProperty( bloomNode, '__tslpPreferSlimBloomReplay', { value: true, configurable: true } );
			}
		__patchBloomNodeUpdateBefore( bloomNode );
		Object.defineProperty( bloomNode, '__tslpBloomReplayReady', { value: true, configurable: true } );
		__bloomDiagnostics().prepared ++;
		return true;
	} catch ( err ) {
		__bloomDiagnostics().prepFailed ++;
		if ( ! window.__tslpBloomPrepWarned ) {
			window.__tslpBloomPrepWarned = true;
			console.warn( '[tslp-e2e] Bloom replay prep failed:', err && err.message || err );
		}
		return false;
	}
}

let __fullBloomRendererState = null;
let __fullBloomQuad = null;
const __fullBloomSize = new FullVector2();
const __fullBloomBlurX = new FullVector2( 1, 0 );
const __fullBloomBlurY = new FullVector2( 0, 1 );
let __fullRTTQuad = null;
let __slimRTTQuad = null;
let __fullRTTRendererState = null;
const __fullRTTSize = new FullVector2();

function __collectOwnedRenderTargetTextures( node, out = new Set(), seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 32 || seen.has( node ) || ( typeof node !== 'object' && typeof node !== 'function' ) ) return out;
	// A sampled Pass texture may retain a .renderTarget backreference. It is
	// an effect input, not ownership evidence for that producer target.
	if ( node.isTexture === true ) return out;
	// Dependency arrays can lead traversal directly into an upstream Pass/RTT
	// node, bypassing the per-property producer check below. Treat both the
	// producer and its texture-node proxy as input boundaries; otherwise the
	// producer target is misclassified as effect-owned and never shared from
	// the slim renderer into the full-renderer effect.
	if ( node.isPassNode === true || node.isRTTNode === true ) return out;
	try {
		if ( node.passNode && ( node.passNode.isPassNode === true || node.passNode.isRTTNode === true ) ) return out;
	} catch ( _ ) {}
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	for ( const key of keys ) {
		if ( key === 'parent' || key === 'children' || key === '_cache' || key === 'scene' || key === 'camera' || key === 'renderer' || key === 'geometry' || key === 'material' || key === 'domElement' ) continue;
		const value = __readGraphOwnValue( node, key );
		if ( ! value || ( typeof value !== 'object' && typeof value !== 'function' ) ) continue;
		// Pass/RTT nodes feed the effect; their textures must be shared into the full renderer.
		if ( value.isPassNode === true || value.isRTTNode === true ) continue;
		if ( typeof value.setSize === 'function' ) {
			if ( value.texture && value.texture.isTexture === true ) out.add( value.texture );
			if ( value.depthTexture && value.depthTexture.isTexture === true ) out.add( value.depthTexture );
			for ( const texture of value.textures || [] ) {
				if ( texture && texture.isTexture === true ) out.add( texture );
			}
			continue;
		}
		if ( Array.isArray( value ) ) {
			for ( const item of value ) __collectOwnedRenderTargetTextures( item, out, seen, depth + 1 );
		} else {
			__collectOwnedRenderTargetTextures( value, out, seen, depth + 1 );
		}
	}
	return out;
}

function __rememberRenderTargetTextureSet( out, value ) {
	if ( ! value || ( typeof value !== 'object' && typeof value !== 'function' ) || typeof value.setSize !== 'function' ) return false;
	if ( value.texture && value.texture.isTexture === true ) out.add( value.texture );
	if ( value.depthTexture && value.depthTexture.isTexture === true ) out.add( value.depthTexture );
	for ( const texture of value.textures || [] ) {
		if ( texture && texture.isTexture === true ) out.add( texture );
	}
	return true;
}

function __collectDirectOwnedRenderTargetTextures( node, out = new Set() ) {
	if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) ) return out;
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) { return out; }
	for ( const key of keys ) {
		if ( key === 'parent' || key === 'children' || key === '_cache' || key === 'scene' || key === 'camera' || key === 'renderer' || key === 'geometry' || key === 'material' || key === 'domElement' ) continue;
		const value = __readGraphOwnValue( node, key );
		if ( ! value || ( typeof value !== 'object' && typeof value !== 'function' ) ) continue;
		if ( __rememberRenderTargetTextureSet( out, value ) ) continue;
		if ( Array.isArray( value ) ) {
			for ( const item of value ) __rememberRenderTargetTextureSet( out, item );
		}
	}
	return out;
}

function __collectNestedFrameEffectOwnedRenderTargetTextures( node, out = new Set() ) {
	const dependency = __selectFrameEffectOwnedPassDependency( node, __isFrameEffectNode );
	return dependency ? __collectDirectOwnedRenderTargetTextures( dependency, out ) : out;
}

function __shareDirectOwnedRenderTargetTexturesBetweenRenderers( targetRenderer, sourceRenderer, node ) {
	const textures = __collectDirectOwnedRenderTargetTextures( node );
	for ( const texture of textures ) __shareGPUTextureEntry( targetRenderer, sourceRenderer, texture );
}

function __frameEffectDiagnosticValue( node ) {
	let value = node;
	try {
		if ( value && ( typeof value === 'object' || typeof value === 'function' ) && 'value' in value ) value = value.value;
	} catch ( _ ) {}
	if ( Number.isFinite( value ) ) return value;
	if ( Array.isArray( value ) || ArrayBuffer.isView( value ) ) {
		const out = Array.from( value ).filter( Number.isFinite );
		return out.length > 0 ? out : null;
	}
	if ( ! value || ( typeof value !== 'object' && typeof value !== 'function' ) ) return null;
	const out = [];
	for ( const key of [ 'x', 'y', 'z', 'w' ] ) {
		let component;
		try { component = value[ key ]; } catch ( _ ) { component = undefined; }
		if ( Number.isFinite( component ) ) out.push( component );
		else break;
	}
	return out.length > 0 ? out : null;
}

function __frameEffectTextureDiagnosticState( renderer, texture ) {
	if ( ! texture || texture.isTexture !== true ) return { identity: null, gpuTexture: null };
	let backendRegistered = false;
	let backendData = null;
	let textureData = null;
	try {
		const backend = renderer && renderer.backend;
		backendRegistered = !! ( backend && typeof backend.has === 'function' && backend.has( texture ) );
		if ( backendRegistered && typeof backend.get === 'function' ) backendData = backend.get( texture );
	} catch ( _ ) {}
	try {
		const textures = renderer && renderer._textures;
		if ( textures && typeof textures.has === 'function' && textures.has( texture ) && typeof textures.get === 'function' ) {
			textureData = textures.get( texture );
		}
	} catch ( _ ) {}
	const image = texture.image || {};
	return {
		identity: {
			name: texture.name || '',
			uuid: texture.uuid || '',
			version: texture.version | 0,
			width: image.width || image.naturalWidth || image.videoWidth || 0,
			height: image.height || image.naturalHeight || image.videoHeight || 0,
			backendRegistered,
			gpuTexturePresent: !! ( backendData && backendData.texture ),
			generation: textureData && Number.isFinite( textureData.generation ) ? textureData.generation : null,
		},
		gpuTexture: backendData && backendData.texture || null,
	};
}

function __runGaussianUpdateWithFrameTextureDiagnostics( node, renderer, effectName, callback ) {
	if ( typeof callback !== 'function' ) return;
	if ( window.__TSLP_DEBUG_FRAME_TEXTURES !== true || effectName !== 'GaussianBlurNode' ) {
		return callback();
	}
	const passDirection = node && node._passDirection && node._passDirection.value;
	const originalSet = passDirection && passDirection.set;
	if ( typeof originalSet !== 'function' ) return callback();
	const ownDescriptor = Object.getOwnPropertyDescriptor( passDirection, 'set' );
	// r185 sets this uniform immediately before each Gaussian quad draw. Wrapping
	// only that live vector gives us the pass boundary without patching Three.
	const wrappedSet = function ( ...args ) {
		const result = originalSet.apply( this, args );
		try {
			const frameEffects = __frameEffectDiagnostics();
			const gaussian = frameEffects.gaussian || ( frameEffects.gaussian = { passes: [], shares: [] } );
			const passes = gaussian.passes || ( gaussian.passes = [] );
			if ( passes.length < 32 ) {
				const pass = this.x === 1 && this.y === 0 ? 'horizontal'
					: this.x === 0 && this.y === 1 ? 'vertical'
					: 'other';
				passes.push( {
					sequence: passes.length,
					pass,
					passDirection: __frameEffectDiagnosticValue( this ),
					directionNode: __frameEffectDiagnosticValue( node.directionNode ),
					invSize: __frameEffectDiagnosticValue( node._invSize ),
					input: __frameEffectTextureDiagnosticState( renderer, node.textureNode && node.textureNode.value ).identity,
				} );
			}
		} catch ( _ ) {}
		return result;
	};
	try {
		passDirection.set = wrappedSet;
	} catch ( _ ) {
		return callback();
	}
	if ( passDirection.set !== wrappedSet ) return callback();
	try {
		return callback();
	} finally {
		try {
			if ( ownDescriptor ) Object.defineProperty( passDirection, 'set', ownDescriptor );
			else delete passDirection.set;
		} catch ( _ ) {}
	}
}

function __recordGaussianTextureShareDiagnostics( node, targetRenderer, sourceRenderer, effectName ) {
	if ( window.__TSLP_DEBUG_FRAME_TEXTURES !== true || effectName !== 'GaussianBlurNode' ) return;
	try {
		const frameEffects = __frameEffectDiagnostics();
		const gaussian = frameEffects.gaussian || ( frameEffects.gaussian = { passes: [], shares: [] } );
		const shares = gaussian.shares || ( gaussian.shares = [] );
		for ( const texture of __collectDirectOwnedRenderTargetTextures( node ) ) {
			if ( shares.length >= 32 ) break;
			const source = __frameEffectTextureDiagnosticState( sourceRenderer, texture );
			const target = __frameEffectTextureDiagnosticState( targetRenderer, texture );
			shares.push( {
				sequence: shares.length,
				texture: source.identity || target.identity,
				source: source.identity,
				target: target.identity,
				sameGPUTexture: !! source.gpuTexture && source.gpuTexture === target.gpuTexture,
			} );
		}
	} catch ( _ ) {}
}

function __shareGraphTexturesBetweenRenderers( targetRenderer, sourceRenderer, graphNode, options = {} ) {
	const byName = __collectGraphTexturesByName( graphNode );
	const skipOwned = options && options.skipOwnedRenderTargets === 'direct'
		? __collectDirectOwnedRenderTargetTextures( graphNode )
		: options && options.skipOwnedRenderTargets ? __collectOwnedRenderTargetTextures( graphNode ) : null;
	const skipTextures = options && options.skipTextures && typeof options.skipTextures.has === 'function' ? options.skipTextures : null;
	const seen = new Set();
	for ( const textures of byName.values() ) {
		const list = Array.isArray( textures ) ? textures : [ textures ];
		for ( const texture of list ) {
			if ( ! texture || texture.isTexture !== true || seen.has( texture ) ) continue;
			if ( skipOwned && skipOwned.has( texture ) ) continue;
			if ( skipTextures && skipTextures.has( texture ) ) continue;
			// A shadow RenderTarget produced by the full renderer is borrowed by
			// slim as one indivisible resource. Sharing its color attachment back
			// into the full renderer can call slim.initRenderTarget(), which
			// reinitializes the target and destroys the already-shared populated
			// depth texture. Nested consumers such as TRAA only need their direct
			// beauty/depth inputs; keep full-owned shadow targets out of this
			// generic graph-sharing path.
			if ( __sharedIsBorrowedShadowRenderTargetTexture( sourceRenderer, texture ) ) continue;
			seen.add( texture );
			__shareGPUTextureEntry( targetRenderer, sourceRenderer, texture );
		}
	}
}

function __probeFrameEffectTextureAsync( renderer, texture, label, options = {} ) {
	const shouldRecord = window.__TSLP_DEBUG_FRAME_TEXTURES === true;
	if ( shouldRecord !== true && options.force !== true ) return;
	if ( ! renderer || ! renderer.backend || typeof renderer.backend.copyTextureToBuffer !== 'function' || ! texture || texture.isTexture !== true ) return;
	if ( texture.isDepthTexture === true ) return;
	const image = texture.image || {};
	const imageWidth = image.width || image.naturalWidth || image.videoWidth || 0;
	const imageHeight = image.height || image.naturalHeight || image.videoHeight || 0;
	const width = Math.max( 1, Math.min( 64, imageWidth ) );
	const height = Math.max( 1, Math.min( 64, imageHeight ) );
	const defaultOffsetX = options.center === true ? Math.floor( ( imageWidth - width ) / 2 ) : 0;
	const defaultOffsetY = options.center === true ? Math.floor( ( imageHeight - height ) / 2 ) : 0;
	const offsetX = Math.max( 0, Math.min( imageWidth - width, Number.isFinite( options.x ) ? options.x : defaultOffsetX ) );
	const offsetY = Math.max( 0, Math.min( imageHeight - height, Number.isFinite( options.y ) ? options.y : defaultOffsetY ) );
	if ( ! width || ! height || ! imageWidth || ! imageHeight ) return;
	window.__tslpComputePending = ( window.__tslpComputePending | 0 ) + 1;
	const summarize = ( buf ) => {
		const sample = ArrayBuffer.isView( buf ) ? buf : new Uint8Array( buf );
		const bytes = new Uint8Array( sample.buffer, sample.byteOffset, sample.byteLength );
		const halfToFloat = ( h ) => {
			const sign = ( h & 0x8000 ) ? -1 : 1;
			const exp = ( h >> 10 ) & 0x1f;
			const frac = h & 0x3ff;
			if ( exp === 0 ) return sign * Math.pow( 2, -14 ) * ( frac / 1024 );
			if ( exp === 31 ) return frac ? NaN : sign * Infinity;
			return sign * Math.pow( 2, exp - 15 ) * ( 1 + frac / 1024 );
		};
		let min = 255;
		let max = 0;
		let sum = 0;
		let nonzero = 0;
		const channelSums = [ 0, 0, 0, 0 ];
		const channelMax = [ 0, 0, 0, 0 ];
		let channelPixels = 0;
		let intermediateRGB = 0;
		let rgbValues = 0;
		let hash = 0x811c9dc5;
		for ( let i = 0; i < bytes.length; i ++ ) {
			hash = Math.imul( hash ^ bytes[ i ], 0x01000193 );
		}
		for ( let i = 0; i < sample.length; i ++ ) {
			const value = sample[ i ];
			min = Math.min( min, value );
			max = Math.max( max, value );
			sum += value;
			if ( value > 0 ) nonzero ++;
			let decoded;
			if ( sample instanceof Uint16Array ) {
				const channel = i & 3;
				decoded = halfToFloat( value );
				if ( Number.isFinite( decoded ) ) {
					channelSums[ channel ] += decoded;
					channelMax[ channel ] = Math.max( channelMax[ channel ], decoded );
				}
				if ( channel === 3 ) channelPixels ++;
			} else if ( sample instanceof Uint8Array || sample instanceof Uint8ClampedArray ) {
				const channel = i & 3;
				decoded = value / 255;
				channelSums[ channel ] += decoded;
				channelMax[ channel ] = Math.max( channelMax[ channel ], decoded );
				if ( channel === 3 ) channelPixels ++;
			} else if ( sample instanceof Float32Array ) {
				const channel = i & 3;
				decoded = value;
				if ( Number.isFinite( decoded ) ) {
					channelSums[ channel ] += decoded;
					channelMax[ channel ] = Math.max( channelMax[ channel ], decoded );
				}
				if ( channel === 3 ) channelPixels ++;
			}
			if ( ( sample instanceof Uint16Array || sample instanceof Uint8Array || sample instanceof Uint8ClampedArray || sample instanceof Float32Array )
				&& ( i & 3 ) !== 3 && Number.isFinite( decoded ) ) {
				rgbValues ++;
				if ( decoded > 0 && decoded < 1 ) intermediateRGB ++;
			}
		}
		return {
			bytes: sample.length,
			hash: 'fnv1a32:' + ( hash >>> 0 ).toString( 16 ).padStart( 8, '0' ),
			min,
			max,
			mean: sum / Math.max( 1, sample.length ),
			nonzero: nonzero / Math.max( 1, sample.length ),
			intermediateRGB,
			intermediateRGBFraction: intermediateRGB / Math.max( 1, rgbValues ),
			channelMean: channelPixels > 0 ? channelSums.map( ( value ) => value / channelPixels ) : undefined,
			channelMax: channelPixels > 0 ? channelMax : undefined,
		};
	};
	Promise.resolve()
		.then( () => renderer.backend.copyTextureToBuffer( texture, offsetX, offsetY, width, height, 0 ) )
		.then( ( buf ) => {
			if ( shouldRecord !== true && options.record !== true ) return;
			const sample = summarize( buf );
			const diag = __harnessDiagnostics();
			const probes = diag.frameTextureProbes || ( diag.frameTextureProbes = [] );
			if ( probes.length < 40 ) {
				probes.push( {
					label,
					name: texture.name || '',
					width: imageWidth,
					height: imageHeight,
					x: offsetX,
					y: offsetY,
					probeWidth: width,
					probeHeight: height,
					bytes: sample.bytes,
					hash: sample.hash,
					min: sample.min,
					max: sample.max,
					mean: sample.mean,
					nonzero: sample.nonzero,
					intermediateRGB: sample.intermediateRGB,
					intermediateRGBFraction: sample.intermediateRGBFraction,
					channelMean: sample.channelMean,
					channelMax: sample.channelMax,
				} );
			}
		} )
		.catch( ( err ) => {
			if ( shouldRecord !== true && options.record !== true ) return;
			const diag = __harnessDiagnostics();
			const probes = diag.frameTextureProbes || ( diag.frameTextureProbes = [] );
			if ( probes.length < 40 ) probes.push( { label, name: texture.name || '', error: err && err.message || String( err ) } );
		} )
		.finally( () => {
			window.__tslpComputePending = Math.max( 0, ( window.__tslpComputePending | 0 ) - 1 );
		} );
}

function __fullBloomStrengthScale( bloomNode ) {
	try {
		const byName = __collectGraphTexturesByName( bloomNode && bloomNode.inputNode );
		for ( const name of byName.keys() ) {
			if ( typeof name === 'string' && name.startsWith( '__' ) ) continue;
			if ( name && name !== 'output' && name !== 'depth' ) return 1;
		}
	} catch ( _ ) {}
	return 1;
}

function __renderBloomNodeWithFullRenderer( bloomNode, slimRenderer, fullRenderer, diag ) {
	if ( ! bloomNode || ! slimRenderer || ! fullRenderer ) return false;
	if ( ! bloomNode.__tslpFullHighPassMaterial || ! bloomNode.__tslpFullCompositeMaterial || ! Array.isArray( bloomNode.__tslpFullBlurMaterials ) ) return false;
	let scaledStrengthNode = null;
	let scaledStrengthValue = null;
	try {
		try {
			const debug = diag.__debug || ( diag.__debug = [] );
			if ( debug.length < 8 ) {
				debug.push( {
					stage: 'bloom-full-before',
					inputNames: Array.from( __collectGraphTexturesByName( bloomNode.inputNode ).entries() ).map( ( [ name, textures ] ) => {
						const texture = Array.isArray( textures ) ? textures[ 0 ] : textures;
						const image = texture && texture.image || {};
						return { name, textureName: texture && texture.name || '', width: image.width || image.naturalWidth || image.videoWidth || 0, height: image.height || image.naturalHeight || image.videoHeight || 0 };
					} ),
				} );
			}
		} catch ( _ ) {}
		if ( ! __fullBloomQuad ) __fullBloomQuad = new FullQuadMesh();
		if ( FullRendererUtils && typeof FullRendererUtils.resetRendererState === 'function' ) {
			__fullBloomRendererState = FullRendererUtils.resetRendererState( fullRenderer, __fullBloomRendererState || undefined );
		}
		try {
			fullRenderer.toneMapping = slimRenderer.toneMapping;
			fullRenderer.toneMappingExposure = slimRenderer.toneMappingExposure;
			fullRenderer.outputColorSpace = slimRenderer.outputColorSpace;
		} catch ( _ ) {}
		const drawingSize = slimRenderer.getDrawingBufferSize( __fullBloomSize );
		if ( typeof fullRenderer.setSize === 'function' ) fullRenderer.setSize( drawingSize.width, drawingSize.height, false );
		bloomNode.setSize( drawingSize.width, drawingSize.height );
		__shareGraphTexturesBetweenRenderers( fullRenderer, slimRenderer, bloomNode.inputNode );

		fullRenderer.setRenderTarget( bloomNode._renderTargetBright );
		__fullBloomQuad.material = bloomNode.__tslpFullHighPassMaterial;
		__fullBloomQuad.name = 'Bloom [ High Pass Full ]';
		__fullBloomQuad.render( fullRenderer );
		diag.highPass ++;

		let inputRenderTarget = bloomNode._renderTargetBright;
		for ( let i = 0; i < bloomNode._nMips; i ++ ) {
			const material = bloomNode.__tslpFullBlurMaterials[ i ];
			if ( ! material ) continue;
			const slimMaterial = bloomNode._separableBlurMaterials && bloomNode._separableBlurMaterials[ i ];
			try {
				if ( material.invSize && material.invSize.value && slimMaterial && slimMaterial.invSize && slimMaterial.invSize.value && typeof material.invSize.value.copy === 'function' ) {
					material.invSize.value.copy( slimMaterial.invSize.value );
				}
			} catch ( _ ) {}

			material.colorTexture.value = inputRenderTarget.texture;
			material.direction.value.copy( __fullBloomBlurX );
			fullRenderer.setRenderTarget( bloomNode._renderTargetsHorizontal[ i ] );
			__fullBloomQuad.material = material;
			__fullBloomQuad.name = 'Bloom [ Blur Horizontal Full - ' + i + ' ]';
			__fullBloomQuad.render( fullRenderer );
			diag.blur ++;

			material.colorTexture.value = bloomNode._renderTargetsHorizontal[ i ].texture;
			material.direction.value.copy( __fullBloomBlurY );
			fullRenderer.setRenderTarget( bloomNode._renderTargetsVertical[ i ] );
			__fullBloomQuad.material = material;
			__fullBloomQuad.name = 'Bloom [ Blur Vertical Full - ' + i + ' ]';
			__fullBloomQuad.render( fullRenderer );
			diag.blur ++;

			inputRenderTarget = bloomNode._renderTargetsVertical[ i ];
		}

		const strengthScale = __fullBloomStrengthScale( bloomNode );
		if ( strengthScale !== 1 && bloomNode.strength && typeof bloomNode.strength.value === 'number' ) {
			scaledStrengthNode = bloomNode.strength;
			scaledStrengthValue = scaledStrengthNode.value;
			scaledStrengthNode.value = scaledStrengthValue * strengthScale;
		}
		fullRenderer.setRenderTarget( bloomNode._renderTargetsHorizontal[ 0 ] );
		__fullBloomQuad.material = bloomNode.__tslpFullCompositeMaterial;
		__fullBloomQuad.name = 'Bloom [ Composite Full ]';
		__fullBloomQuad.render( fullRenderer );
			if ( diag.__probedFullBloom !== true ) {
				diag.__probedFullBloom = true;
				try {
					__probeFrameEffectTextureAsync( fullRenderer, bloomNode._renderTargetBright && bloomNode._renderTargetBright.texture, 'Bloom.full.bright' );
					__probeFrameEffectTextureAsync( fullRenderer, bloomNode._renderTargetsHorizontal && bloomNode._renderTargetsHorizontal[ 0 ] && bloomNode._renderTargetsHorizontal[ 0 ].texture, 'Bloom.full.h0' );
				} catch ( _ ) {}
			}
		diag.composite ++;
		diag.rendered ++;
		diag.fullRendered ++;
		__shareGPUTextureEntry( slimRenderer, fullRenderer, bloomNode._renderTargetsHorizontal[ 0 ].texture );
		return true;
	} catch ( err ) {
		diag.fullError = err && ( err.stack || err.message ) || String( err );
		if ( ! window.__tslpBloomFullRenderWarned ) {
			window.__tslpBloomFullRenderWarned = true;
			console.warn( '[tslp-e2e] Bloom full-renderer replay failed:', diag.fullError );
		}
		return false;
	} finally {
		if ( scaledStrengthNode ) scaledStrengthNode.value = scaledStrengthValue;
		try {
			if ( __fullBloomRendererState && FullRendererUtils && typeof FullRendererUtils.restoreRendererState === 'function' ) FullRendererUtils.restoreRendererState( fullRenderer, __fullBloomRendererState );
		} catch ( _ ) {}
	}
}

function __fullRTTMaterialFragmentForIdentity( rttNode, slimRenderer, fragmentIdentity ) {
	return __rttPrecompiledShape( rttNode ) === 'render-output' && fragmentIdentity && typeof fragmentIdentity.context === 'function'
		? fragmentIdentity.context( {
			toneMapping: slimRenderer.toneMapping,
			outputColorSpace: slimRenderer.outputColorSpace,
		} )
		: fragmentIdentity;
}

function __renderRTTNodeWithFullRenderer( rttNode, slimRenderer, fullRenderer ) {
	if ( ! __isRTTNode( rttNode ) || ! slimRenderer || ! fullRenderer ) return false;
	try {
		if ( ! __fullRTTQuad ) __fullRTTQuad = new FullQuadMesh();
		if ( ! rttNode.__tslpFullRTTMaterial ) {
			const material = new FullNodeMaterial();
			material.name = 'RTT_full';
			const fragmentIdentity = rttNode._rttNode || rttNode.node;
			__refreshRTTMaterialFragmentIdentity(
				material,
				fragmentIdentity,
				__fullRTTMaterialFragmentForIdentity( rttNode, slimRenderer, fragmentIdentity ),
			);
			Object.defineProperty( rttNode, '__tslpFullRTTMaterial', { value: material, configurable: true } );
		}
		if ( FullRendererUtils && typeof FullRendererUtils.resetRendererState === 'function' ) {
			__fullRTTRendererState = FullRendererUtils.resetRendererState( fullRenderer, __fullRTTRendererState || undefined );
		}
		try {
			fullRenderer.toneMapping = slimRenderer.toneMapping;
			fullRenderer.toneMappingExposure = slimRenderer.toneMappingExposure;
			fullRenderer.outputColorSpace = slimRenderer.outputColorSpace;
		} catch ( _ ) {}
		if ( rttNode.autoResize !== false ) {
			const pixelRatio = typeof slimRenderer.getPixelRatio === 'function' ? slimRenderer.getPixelRatio() : 1;
			const size = slimRenderer.getSize( __fullRTTSize );
			const width = Math.max( 1, Math.floor( ( size.width || 1 ) * pixelRatio ) );
			const height = Math.max( 1, Math.floor( ( size.height || 1 ) * pixelRatio ) );
			if ( rttNode.renderTarget.width !== width || rttNode.renderTarget.height !== height ) {
				rttNode.renderTarget.setSize( width, height );
			}
		}
		// convertToTexture( SSRNode ) creates an RTT whose fragment graph is
		// exactly the SSR node's PassTextureNode. Rebuilding that one-edge graph
		// as a second full-renderer material can retain the pre-resize 1x1
		// texture view even though SSR's owned target has already been rendered.
		// Preserve the authored identity directly: render SSR first, then copy
		// its live output into the RTT target that TemporalReproject samples.
		// RTTNode.setup() stores node.context( sharedContext ) in _rttNode.
		// That transparent ContextNode is the preferred render graph, and TSL's
		// toVar() can add a transparent VarNode below it. Unwrap only those two
		// identity-preserving wrappers: arithmetic/color transforms must keep
		// using the regular RTT material path.
		let directRTTNode = rttNode._rttNode || rttNode.node;
		const directRTTSeen = new Set();
		while (
			directRTTNode &&
			( directRTTNode.isContextNode === true || directRTTNode.isVarNode === true ) &&
			directRTTNode.node &&
			! directRTTSeen.has( directRTTNode )
		) {
			directRTTSeen.add( directRTTNode );
			directRTTNode = directRTTNode.node;
		}
		const directSSRNode = __isSSREffectNode( directRTTNode )
			? directRTTNode
			: directRTTNode && directRTTNode.isPassTextureNode === true && __isSSREffectNode( directRTTNode.passNode )
				? directRTTNode.passNode
			: __isSSREffectNode( rttNode.node )
				? rttNode.node
				: null;
		if (
			directSSRNode &&
			__prepareSSRNodeForReplay( directSSRNode, null ) &&
			__renderSSRNodeWithFullRenderer( directSSRNode, slimRenderer, fullRenderer, __ssrDiagnostics() )
		) {
			if ( typeof fullRenderer.initRenderTarget === 'function' ) fullRenderer.initRenderTarget( rttNode.renderTarget );
			fullRenderer.copyTextureToTexture( directSSRNode._ssrRenderTarget.texture, rttNode.renderTarget.texture );
			__shareGPUTextureEntry( slimRenderer, fullRenderer, rttNode.renderTarget.texture );
			try {
				const rttDiag = __harnessDiagnostics().rtt || ( __harnessDiagnostics().rtt = {} );
				rttDiag.directEffectCopies = ( rttDiag.directEffectCopies | 0 ) + 1;
			} catch ( _ ) {}
			return true;
		}
		const ssrDependencies = __collectSSRNodesInGraph( rttNode.node );
		const dofDependencies = __collectDOFNodesInGraph( rttNode.node );
		const traaDependencies = __collectTRAANodesInGraph( rttNode.node );
		if ( ssrDependencies.length > 0 ) {
			try {
				const rttDiag = __harnessDiagnostics().rtt || ( __harnessDiagnostics().rtt = {} );
				const candidates = rttDiag.directCandidateShapes || ( rttDiag.directCandidateShapes = [] );
				if ( candidates.length < 4 ) {
					const describe = ( candidate ) => ( {
						constructorType: candidate && candidate.constructor && ( candidate.constructor.type || candidate.constructor.name ) || '',
						type: candidate && candidate.type || '',
						isContextNode: candidate && candidate.isContextNode === true,
						isSSRNode: candidate && candidate.isSSRNode === true,
						isPassTextureNode: candidate && candidate.isPassTextureNode === true,
						nodeType: candidate && candidate.nodeType || null,
						components: candidate && candidate.components || null,
						method: candidate && candidate.method || null,
						op: candidate && candidate.op || null,
						keys: candidate ? Object.getOwnPropertyNames( candidate ).slice( 0, 24 ) : [],
					} );
					const authoredJoin = rttNode.node && rttNode.node.node;
					candidates.push( {
						authored: describe( rttNode.node ),
						authoredNode: describe( rttNode.node && rttNode.node.node ),
						authoredNodeNode: describe( rttNode.node && rttNode.node.node && rttNode.node.node.node ),
						authoredJoinNodes: Array.isArray( authoredJoin && authoredJoin.nodes )
							? authoredJoin.nodes.map( ( node ) => ( {
								node: describe( node ),
								child: describe( node && node.node ),
								grandchild: describe( node && node.node && node.node.node ),
							} ) )
							: [],
						prepared: describe( rttNode._rttNode ),
						preparedNode: describe( rttNode._rttNode && rttNode._rttNode.node ),
						preparedNodeNode: describe( rttNode._rttNode && rttNode._rttNode.node && rttNode._rttNode.node.node ),
						preparedNodeNodeNode: describe( rttNode._rttNode && rttNode._rttNode.node && rttNode._rttNode.node.node && rttNode._rttNode.node.node.node ),
						ssrDependencyCount: ssrDependencies.length,
					} );
				}
			} catch ( _ ) {}
		}
		const deferredEffectTextures = new Set();
		for ( const effectNode of [
			...ssrDependencies,
			...dofDependencies,
			...traaDependencies,
		] ) {
			__collectDirectOwnedRenderTargetTextures( effectNode, deferredEffectTextures );
		}
		// A full NodeMaterial built from an RTT's ContextNode does not reliably
		// retain specialized effect update hooks after replay graph rewiring.
		// Render those producers explicitly before the copy quad; otherwise the
		// RTT is correctly sized and shared but contains only its clear value.
		for ( const ssrNode of ssrDependencies ) {
			if ( ! __prepareSSRNodeForReplay( ssrNode, null ) ) {
				throw new Error( 'RTT SSR producer was not ready for replay.' );
			}
			if ( ! __renderSSRNodeWithFullRenderer( ssrNode, slimRenderer, fullRenderer, __ssrDiagnostics() ) ) {
				throw new Error( 'RTT SSR producer failed before texture copy.' );
			}
			try {
				const diag = __harnessDiagnostics();
				diag.rtt = diag.rtt || { collected: 0, rendered: 0, failed: 0 };
				diag.rtt.specializedProducers = ( diag.rtt.specializedProducers | 0 ) + 1;
			} catch ( _ ) {}
		}
		// RTTNode.setup() can replace the authored graph with a shared-context
		// _rttNode after this material was allocated. Adopt any such identity
		// transition—not only SSR-shaped graphs—and invalidate exactly once.
		const preparedRTTFragmentIdentity = rttNode._rttNode || rttNode.node;
		if ( __refreshRTTMaterialFragmentIdentity(
			rttNode.__tslpFullRTTMaterial,
			preparedRTTFragmentIdentity,
			__fullRTTMaterialFragmentForIdentity( rttNode, slimRenderer, preparedRTTFragmentIdentity ),
		) ) {
			try {
				const diag = __harnessDiagnostics();
				diag.rtt = diag.rtt || { collected: 0, rendered: 0, failed: 0 };
				diag.rtt.effectMaterialRefreshes = ( diag.rtt.effectMaterialRefreshes | 0 ) + 1;
				diag.rtt.fragmentIdentityTransitions = ( diag.rtt.fragmentIdentityTransitions | 0 ) + 1;
			} catch ( _ ) {}
		}
		__shareGraphTexturesBetweenRenderers( fullRenderer, slimRenderer, rttNode.node, {
			skipTextures: deferredEffectTextures,
		} );
		fullRenderer.setRenderTarget( rttNode.renderTarget );
		__fullRTTQuad.material = rttNode.__tslpFullRTTMaterial;
		__fullRTTQuad.name = rttNode.name ? rttNode.name + ' [ RTT Full ]' : 'RTT Full';
		__fullRTTQuad.render( fullRenderer );
		__shareGPUTextureEntry( slimRenderer, fullRenderer, rttNode.renderTarget.texture );
		return true;
	} catch ( err ) {
		if ( ! window.__tslpRTTFullRenderWarned ) {
			window.__tslpRTTFullRenderWarned = true;
			console.warn( '[tslp-e2e] RTT full-renderer replay failed:', err && ( err.stack || err.message ) || err );
		}
	} finally {
		try {
			if ( __fullRTTRendererState && FullRendererUtils && typeof FullRendererUtils.restoreRendererState === 'function' ) FullRendererUtils.restoreRendererState( fullRenderer, __fullRTTRendererState );
		} catch ( _ ) {}
	}
	return __renderRTTNodeWithPrecompiledSlim( rttNode, slimRenderer );
}

function __rttPrecompiledShape( rttNode ) {
	const node = rttNode && ( rttNode._rttNode || rttNode.node );
	const type = node && node.constructor && ( node.constructor.type || node.constructor.name ) || node && node.type || '';
	if ( type === 'RenderOutputNode' ) return 'render-output';
	return null;
}

function __renderRTTNodeWithPrecompiledSlim( rttNode, renderer ) {
	const shape = __rttPrecompiledShape( rttNode );
	if ( ! shape || ! renderer || ! rttNode || ! rttNode.renderTarget ) return false;
	try {
		if ( ! __slimRTTQuad ) __slimRTTQuad = new Slim.QuadMesh();
		if ( rttNode.autoResize !== false ) {
			const pixelRatio = typeof renderer.getPixelRatio === 'function' ? renderer.getPixelRatio() : 1;
			const size = renderer.getSize( __fullRTTSize );
			const width = Math.max( 1, Math.floor( ( size.width || 1 ) * pixelRatio ) );
			const height = Math.max( 1, Math.floor( ( size.height || 1 ) * pixelRatio ) );
			if ( rttNode.renderTarget.width !== width || rttNode.renderTarget.height !== height ) {
				rttNode.renderTarget.setSize( width, height );
			}
		}
		if ( rttNode.renderTarget.texture && typeof renderer.getOutputBufferType === 'function' ) {
			rttNode.renderTarget.texture.type = renderer.getOutputBufferType();
		}
		const node = rttNode._rttNode || rttNode.node;
		let artifact = Slim.loadAux( shape, 'tslp-e2e-bypass' );
		const passNodes = __collectPassNodesInGraph( node );
		const bloomNodes = __collectBloomNodesInGraph( node );
		for ( const passNode of passNodes ) __preparePassNodeForReplay( renderer, passNode );
		artifact = __attachGraphTextureRefs( artifact, node );
		artifact = __attachPassTextureRefs( artifact, passNodes[ 0 ] || null );
		artifact = __attachBloomCompositeTextureRefs( artifact, bloomNodes );
		const material = new Slim.PrecompiledMaterial( artifact );
		material.name = 'RTT_' + shape;
		material.needsUpdate = true;
		const currentRenderTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
		const currentMRT = typeof renderer.getMRT === 'function' ? renderer.getMRT() : null;
		try {
			renderer.setRenderTarget( rttNode.renderTarget );
				if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( null );
				__slimRTTQuad.material = material;
				__slimRTTQuad.name = 'RTT [ ' + shape + ' ]';
				__slimRTTQuad.render( renderer );
			} finally {
				try { renderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
				try { if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( currentMRT ); } catch ( _ ) {}
		}
		return true;
	} catch ( err ) {
		try { window.__tslpRecordRenderSelectorMismatch && window.__tslpRecordRenderSelectorMismatch( err, 'caught-rtt-render' ); } catch ( _ ) {}
		if ( ! window.__tslpRTTPrecompiledWarned ) {
			window.__tslpRTTPrecompiledWarned = true;
			console.warn( '[tslp-e2e] RTT precompiled replay failed:', err && ( err.stack || err.message ) || err );
		}
		return false;
	}
}

function __patchBloomNodeUpdateBefore( bloomNode ) {
	if ( bloomNode.__tslpBloomUpdatePatched === true ) return;
	const quad = new Slim.QuadMesh();
	const size = new Slim.Vector2();
	const blurX = new Slim.Vector2( 1, 0 );
	const blurY = new Slim.Vector2( 0, 1 );
	let rendererState = null;
		bloomNode.updateBefore = function ( frame = {} ) {
			const renderer = frame && frame.renderer;
			if ( ! renderer ) return;
			__recordSemanticOperation( 'bloom', 'render-bloom-chain', 'attempted' );
			const diag = __bloomDiagnostics();
			const currentRenderTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
			const currentMRT = typeof renderer.getMRT === 'function' ? renderer.getMRT() : null;
			let bloomStage = 'prepare';
			try {
			if ( this.__tslpPreferSlimBloomReplay !== true && __renderBloomNodeWithFullRenderer( this, renderer, __computeRenderer, diag ) ) {
				__recordSemanticOperation( 'bloom', 'render-bloom-chain', 'succeeded' );
				return;
			}
			if ( Slim.RendererUtils && typeof Slim.RendererUtils.resetRendererState === 'function' ) {
				rendererState = Slim.RendererUtils.resetRendererState( renderer, rendererState || undefined );
			}
			const drawingSize = renderer.getDrawingBufferSize( size );
			this.setSize( drawingSize.width, drawingSize.height );

			__wireBloomInputTextures( this._highPassFilterMaterial, this.inputNode );
				renderer.setRenderTarget( this._renderTargetBright );
				quad.material = this._highPassFilterMaterial;
				quad.name = 'Bloom [ High Pass ]';
				bloomStage = 'high-pass';
				quad.render( renderer );
				diag.highPass ++;

			let inputRenderTarget = this._renderTargetBright;
			for ( let i = 0; i < this._nMips; i ++ ) {
				const horizontalMaterial = this.__tslpBlurHorizontalMaterials && this.__tslpBlurHorizontalMaterials[ i ] || this._separableBlurMaterials[ i ];
				const verticalMaterial = this.__tslpBlurVerticalMaterials && this.__tslpBlurVerticalMaterials[ i ] || horizontalMaterial;
				if ( ! horizontalMaterial || ! verticalMaterial ) continue;

				horizontalMaterial.colorTexture.value = inputRenderTarget.texture;
				horizontalMaterial.direction.value = blurX;
				__wireBloomSingleTexture( horizontalMaterial, inputRenderTarget.texture );
				renderer.setRenderTarget( this._renderTargetsHorizontal[ i ] );
				quad.material = horizontalMaterial;
				quad.name = 'Bloom [ Blur Horizontal - ' + i + ' ]';
				bloomStage = 'blur-horizontal-' + i;
				quad.render( renderer );
				diag.blur ++;

				verticalMaterial.colorTexture.value = this._renderTargetsHorizontal[ i ].texture;
				verticalMaterial.direction.value = blurY;
				__wireBloomSingleTexture( verticalMaterial, this._renderTargetsHorizontal[ i ].texture );
				renderer.setRenderTarget( this._renderTargetsVertical[ i ] );
				quad.material = verticalMaterial;
				quad.name = 'Bloom [ Blur Vertical - ' + i + ' ]';
				bloomStage = 'blur-vertical-' + i;
				quad.render( renderer );
				diag.blur ++;

				inputRenderTarget = this._renderTargetsVertical[ i ];
			}

			__wireBloomCompositeTextures( this, this._compositeMaterial );
				renderer.setRenderTarget( this._renderTargetsHorizontal[ 0 ] );
				quad.material = this._compositeMaterial;
				quad.name = 'Bloom [ Composite ]';
				bloomStage = 'composite';
				quad.render( renderer );
				diag.composite ++;
			if ( diag.__probedSlimBloom !== true ) {
				diag.__probedSlimBloom = true;
				try {
					__probeFrameEffectTextureAsync( renderer, this._renderTargetBright && this._renderTargetBright.texture, 'Bloom.slim.bright' );
					__probeFrameEffectTextureAsync( renderer, this._renderTargetsHorizontal && this._renderTargetsHorizontal[ 0 ] && this._renderTargetsHorizontal[ 0 ].texture, 'Bloom.slim.h0' );
				} catch ( _ ) {}
				}
				diag.rendered ++;
				__recordSemanticOperation( 'bloom', 'render-bloom-chain', 'succeeded' );
			} catch ( err ) {
				diag.renderFailed ++;
				const failures = diag.failures || ( diag.failures = [] );
				if ( failures.length < 8 ) failures.push( {
					stage: bloomStage,
					code: err && err.code || null,
					status: err && err.status || null,
					reason: err && err.reason || null,
					bindingName: err && err.bindingName || null,
					observedTargetCount: ( err && err.observedTargetCount ) ?? null,
					candidateCount: ( err && err.candidateCount ) ?? null,
					matchCount: ( err && err.matchCount ) ?? null,
					preferredTargetObserved: ( err && err.preferredTargetObserved ) ?? null,
					preferredTextureRendererOwned: ( err && err.preferredTextureRendererOwned ) ?? null,
				} );
				__recordSemanticOperation(
					'bloom',
					'render-bloom-chain',
					'failed',
					err,
					true,
					__artifactVariantRecoveryIdentity( err, 'BloomNode' ),
				);
				try { window.__tslpRecordRenderSelectorMismatch && window.__tslpRecordRenderSelectorMismatch( err, 'caught-bloom-render' ); } catch ( _ ) {}
				if ( ! window.__tslpBloomRenderWarned ) {
					window.__tslpBloomRenderWarned = true;
					console.info( '[tslp-e2e] structured Bloom replay render failure:', err && err.message || err );
				}
		} finally {
			try {
				if ( rendererState && Slim.RendererUtils && typeof Slim.RendererUtils.restoreRendererState === 'function' ) Slim.RendererUtils.restoreRendererState( renderer, rendererState );
			} catch ( _ ) {}
			try { renderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
			try { if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( currentMRT ); } catch ( _ ) {}
		}
	};
	try { Object.defineProperty( bloomNode, '__tslpBloomReplayUpdateBefore', { value: bloomNode.updateBefore, configurable: true, writable: true } ); } catch ( _ ) {}
	Object.defineProperty( bloomNode, '__tslpBloomUpdatePatched', { value: true, configurable: true } );
}

function __renderBloomNodesForPipeline( renderer, bloomNodes ) {
	for ( const bloomNode of bloomNodes || [] ) {
		if ( __prepareBloomNodeForReplay( bloomNode, null ) ) bloomNode.updateBefore( { renderer } );
	}
}

// --------------------------------------------------------------------------
// Outline-pass replay support (Wedge 1.5-B)
//
// OutlineNode (three/addons/tsl/display/OutlineNode.js) builds 7 internal
// NodeMaterials at setup() time and drives a 7-pass pipeline in
// updateBefore(): non-selected-depth pre-pass, selected-mask pre-pass,
// downsample, edge-detection, two separable blur passes (horizontal +
// vertical at half + quarter resolution), and a final composite. The slim
// three.webgpu bundle has the node-builder stripped so it cannot compile
// any of those live materials at replay time; the captured aux artifacts
// for each shape (outline-depth, outline-depth-sprite, outline-mask,
// outline-mask-sprite, outline-edge, outline-blur, outline-composite) are
// present in the registry, but the depth/mask passes call
// renderer.render(scene, camera) with per-mesh override callbacks — that
// path needs a working node-builder, which only the full WebGPURenderer
// has. So like bloom, the slim path can't carry the whole pass.
//
// The fix mirrors __renderBloomNodeWithFullRenderer: hand the entire
// outline updateBefore to the full renderer with source materials swapped
// back in, then share the resulting _renderTargetComposite.texture into
// the slim renderer so the post-process artifact samples correct pixels.
//
// A subtlety for outline: with empty selectedObjects (the example only
// adds objects on pointermove and the harness never simulates a hover),
// the real updateBefore returns immediately without sizing or clearing
// _renderTargetComposite. The slim post-process artifact then samples a
// 1x1 uninitialized texture stretched to the canvas — that's the source
// of the all-white replay frames. We force-size and clear the composite
// target to (0,0,0,0) before delegating so the post-process composite
// reads a clean black contribution from the outline term.
// --------------------------------------------------------------------------

function __isOutlineEffectNode( node ) {
	if ( ! __isSpecializedEffectCandidate( node ) ) return false;
	const type = node && node.constructor && node.constructor.type || node && node.type || '';
	if ( type && type !== 'OutlineNode' ) return false;
	return !! ( node
		&& typeof node.updateBefore === 'function'
		&& node._depthMaterial
		&& node._edgeDetectionMaterial
		&& node._separableBlurMaterial
		&& node._compositeMaterial
		&& node._renderTargetComposite
		&& node._renderTargetDepthBuffer
		&& node._renderTargetMaskBuffer );
}

function __outlineDiagnostics() {
	const diag = __harnessDiagnostics();
	if ( ! diag.outline ) {
		diag.outline = {
			collected: 0,
			prepared: 0,
			rendered: 0,
			fullRendered: 0,
			cleared: 0,
			prepFailed: 0,
			renderFailed: 0,
			setupCalls: 0,
			ctor: '',
			type: '',
		};
	}
	return diag.outline;
}

function __collectOutlineNodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 24 || seen.has( node ) ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	if ( __isOutlineEffectNode( node ) ) {
		if ( ! out.includes( node ) ) out.push( node );
		return out;
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectOutlineNodesInGraph( item, out, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectOutlineNodesInGraph( child, out, seen, depth + 1 );
		}
	}
	return out;
}

let __fullOutlineRendererState = null;

function __forceClearOutlineComposite( outlineNode, fullRenderer, drawingSize ) {
	// Pre-size every render target and clear the composite buffer so post-process
	// sampling of _renderTargetComposite.texture starts from a clean black slate
	// rather than an uninitialized 1x1 texture. Mirrors what OutlineNode would do
	// on the first non-empty selection frame but is also safe for the empty-
	// selection path (real updateBefore returns early without ever clearing).
	try {
		const width = Math.max( 1, drawingSize && drawingSize.width || 1 );
		const height = Math.max( 1, drawingSize && drawingSize.height || 1 );
		outlineNode.setSize( width, height );
	} catch ( _ ) {}
	try {
		const prevTarget = typeof fullRenderer.getRenderTarget === 'function' ? fullRenderer.getRenderTarget() : null;
		const prevAutoClear = fullRenderer.autoClear;
		try {
			fullRenderer.setRenderTarget( outlineNode._renderTargetComposite );
			fullRenderer.setClearColor( 0x000000, 0 );
			if ( typeof fullRenderer.clear === 'function' ) fullRenderer.clear();
		} finally {
			fullRenderer.autoClear = prevAutoClear;
			try { fullRenderer.setRenderTarget( prevTarget ); } catch ( _ ) {}
		}
	} catch ( _ ) {}
}

function __renderOutlineNodeWithFullRenderer( outlineNode, slimRenderer, fullRenderer, diag ) {
	if ( ! outlineNode || ! slimRenderer || ! fullRenderer ) return false;
	const originalUpdateBefore = outlineNode.__tslpOutlineOriginalUpdateBefore;
	if ( typeof originalUpdateBefore !== 'function' ) return false;
	try {
		if ( FullRendererUtils && typeof FullRendererUtils.resetRendererState === 'function' ) {
			__fullOutlineRendererState = FullRendererUtils.resetRendererState( fullRenderer, __fullOutlineRendererState || undefined );
		}
		try {
			fullRenderer.toneMapping = slimRenderer.toneMapping;
			fullRenderer.toneMappingExposure = slimRenderer.toneMappingExposure;
			fullRenderer.outputColorSpace = slimRenderer.outputColorSpace;
		} catch ( _ ) {}
		const tmpSize = new FullVector2();
		const drawingSize = slimRenderer.getDrawingBufferSize( tmpSize );
		if ( typeof fullRenderer.setSize === 'function' ) fullRenderer.setSize( drawingSize.width, drawingSize.height, false );

		// Guarantee composite target has correct dimensions and is cleared,
		// covering the empty-selection-from-the-start scenario where the real
		// updateBefore would return without ever touching the texture.
		__forceClearOutlineComposite( outlineNode, fullRenderer, drawingSize );
		diag.cleared ++;

		// Run the real (pre-patch) OutlineNode.updateBefore on the full renderer.
		// With an empty selection it's effectively a no-op (returns after the
		// optional clear); with selected objects it drives the 7-pass pipeline
		// using live node materials, which only the full node-builder can compile.
		// Calling __tslpOutlineOriginalUpdateBefore directly (rather than the
		// patched updateBefore) avoids recursion through this same function.
		const runUpdate = () => originalUpdateBefore.call( outlineNode, { renderer: fullRenderer } );
		if ( outlineNode.scene && typeof outlineNode.scene.traverse === 'function' ) {
			__withSourceMaterialsForFullPass( outlineNode.scene, runUpdate );
		} else {
			runUpdate();
		}

		// Hand the final composite texture (and the intermediate buffers, which
		// the OutlineNode's pass-texture node references through setup()) over
		// to the slim renderer's GPU resource map so the post-process composite
		// samples the freshly-rendered pixels.
		__shareGPUTextureEntry( slimRenderer, fullRenderer, outlineNode._renderTargetComposite.texture );
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, outlineNode._renderTargetEdgeBuffer1.texture ); } catch ( _ ) {}
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, outlineNode._renderTargetEdgeBuffer2.texture ); } catch ( _ ) {}
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, outlineNode._renderTargetMaskBuffer.texture ); } catch ( _ ) {}

		diag.fullRendered ++;
		diag.rendered ++;
		return true;
	} catch ( err ) {
		diag.fullError = err && ( err.stack || err.message ) || String( err );
		if ( ! window.__tslpOutlineFullRenderWarned ) {
			window.__tslpOutlineFullRenderWarned = true;
			console.warn( '[tslp-e2e] Outline full-renderer replay failed:', diag.fullError );
		}
		return false;
	} finally {
		try {
			if ( __fullOutlineRendererState && FullRendererUtils && typeof FullRendererUtils.restoreRendererState === 'function' ) FullRendererUtils.restoreRendererState( fullRenderer, __fullOutlineRendererState );
		} catch ( _ ) {}
	}
}

function __patchOutlineNodeUpdateBefore( outlineNode ) {
	if ( outlineNode.__tslpOutlineUpdatePatched === true ) return;
	const originalUpdateBefore = outlineNode.updateBefore;
	Object.defineProperty( outlineNode, '__tslpOutlineOriginalUpdateBefore', { value: originalUpdateBefore, configurable: true } );
	outlineNode.updateBefore = function ( frame = {} ) {
		const slimRenderer = frame && frame.renderer;
		if ( ! slimRenderer ) return;
		const diag = __outlineDiagnostics();
		const currentRenderTarget = typeof slimRenderer.getRenderTarget === 'function' ? slimRenderer.getRenderTarget() : null;
		const currentMRT = typeof slimRenderer.getMRT === 'function' ? slimRenderer.getMRT() : null;
		try {
			if ( __computeRenderer ) {
				if ( __renderOutlineNodeWithFullRenderer( this, slimRenderer, __computeRenderer, diag ) ) return;
			}
			// Fallback: call original updateBefore on the slim renderer. This will
			// most likely fail because the depth/mask passes require a node-builder,
			// but we attempt it for completeness so a missing __computeRenderer
			// doesn't silently swallow the pass.
			if ( typeof originalUpdateBefore === 'function' ) {
				originalUpdateBefore.call( this, frame );
			}
		} catch ( err ) {
			diag.renderFailed ++;
			if ( ! window.__tslpOutlineRenderWarned ) {
				window.__tslpOutlineRenderWarned = true;
				console.warn( '[tslp-e2e] Outline replay render failed:', err && err.message || err );
			}
		} finally {
			try { slimRenderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
			try { if ( typeof slimRenderer.setMRT === 'function' ) slimRenderer.setMRT( currentMRT ); } catch ( _ ) {}
		}
	};
	Object.defineProperty( outlineNode, '__tslpOutlineUpdatePatched', { value: true, configurable: true } );
}

function __prepareOutlineNodeForReplay( outlineNode, context ) {
	if ( ! __isOutlineEffectNode( outlineNode ) ) return false;
	if ( outlineNode.__tslpOutlineReplayReady === true ) return true;
	try {
		const diag = __outlineDiagnostics();
		diag.ctor = outlineNode.constructor && outlineNode.constructor.name || '';
		diag.type = outlineNode.constructor && outlineNode.constructor.type || outlineNode.type || '';
		// Force OutlineNode.setup() so its internal materials carry the live
		// fragmentNodes the full renderer's node-builder will compile during
		// updateBefore. setup() is idempotent w.r.t. registering needsUpdate.
		if ( typeof outlineNode.setup === 'function' ) {
			try {
				outlineNode.setup( context && typeof context.getSharedContext === 'function' ? context : { getSharedContext: () => context || {} } );
				diag.setupCalls ++;
			} catch ( _ ) {}
		}
		__patchOutlineNodeUpdateBefore( outlineNode );
		Object.defineProperty( outlineNode, '__tslpOutlineReplayReady', { value: true, configurable: true } );
		diag.prepared ++;
		return true;
	} catch ( err ) {
		__outlineDiagnostics().prepFailed ++;
		if ( ! window.__tslpOutlinePrepWarned ) {
			window.__tslpOutlinePrepWarned = true;
			console.warn( '[tslp-e2e] Outline replay prep failed:', err && err.message || err );
		}
		return false;
	}
}

function __renderOutlineNodesForPipeline( renderer, outlineNodes ) {
	for ( const outlineNode of outlineNodes || [] ) {
		if ( __prepareOutlineNodeForReplay( outlineNode, null ) ) outlineNode.updateBefore( { renderer } );
	}
}

function __attachBloomCompositeTextureRefs( artifact, bloomNodes ) {
	if ( ! artifact || ! Array.isArray( bloomNodes ) || bloomNodes.length === 0 ) return artifact;
	const byName = new Map();
	for ( const bloomNode of bloomNodes ) {
		if ( ! bloomNode ) continue;
		if ( bloomNode._renderTargetBright && bloomNode._renderTargetBright.texture ) {
			byName.set( bloomNode._renderTargetBright.texture.name || 'UnrealBloomPass.bright', bloomNode._renderTargetBright.texture );
		}
		const horizontal = Array.isArray( bloomNode._renderTargetsHorizontal ) ? bloomNode._renderTargetsHorizontal : [];
		for ( const target of horizontal ) {
			const texture = target && target.texture;
			if ( texture && texture.isTexture === true ) byName.set( texture.name || '', texture );
		}
		const vertical = Array.isArray( bloomNode._renderTargetsVertical ) ? bloomNode._renderTargetsVertical : [];
		for ( const target of vertical ) {
			const texture = target && target.texture;
			if ( texture && texture.isTexture === true ) byName.set( texture.name || '', texture );
		}
	}
	if ( byName.size === 0 ) return artifact;
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	let changed = false;
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid || ! source.textureName ) continue;
			const texture = byName.get( source.textureName );
			if ( ! ( texture && texture.isTexture === true ) ) continue;
			refs.set( source.textureUuid, texture );
			changed = true;
		}
	}
	if ( changed ) {
		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );
	}
	return artifact;
}

// After the outline pass has been rendered, explicitly bind the OutlineNode's
// composite texture (and the scenePass output texture) to the render-output
// artifact's texture slots. The captured aux stores TWO unnamed texture
// sources for OutlineNode (texture + sampler pair sharing one UUID) plus
// TWO 'output' texture sources for scenePass sharing another UUID. Because
// scenePass.renderTarget.depthTexture has an empty name, it pollutes the
// 'output' bucket and __attachGraphTextureRefs ends up routing the second
// 'output' source to the scenePass depth texture instead of the color
// buffer. Force the correct bindings by UUID-matching against
// source.textureName: empty → outline composite, 'output' → scenePass color.
function __attachOutlineCompositeTextureRefs( artifact, outlineNodes, passNodes ) {
	if ( ! artifact || ! Array.isArray( outlineNodes ) || outlineNodes.length === 0 ) return artifact;
	const outlineNode = outlineNodes[ 0 ];
	if ( ! outlineNode || ! outlineNode._renderTargetComposite || ! outlineNode._renderTargetComposite.texture ) return artifact;
	const compositeTexture = outlineNode._renderTargetComposite.texture;
	// Locate the scenePass color texture (the named 'output' texture on the
	// first non-depth pass).
	let scenePassTexture = null;
	if ( Array.isArray( passNodes ) ) {
		for ( const passNode of passNodes ) {
			const target = passNode && passNode.renderTarget;
			const candidate = target && target.texture;
			if ( candidate && candidate.isTexture === true && candidate.isDepthTexture !== true ) {
				scenePassTexture = candidate;
				break;
			}
		}
	}
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	let changed = false;
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid ) continue;
			const name = source.textureName;
			if ( name == null || name === '' ) {
				refs.set( source.textureUuid, compositeTexture );
				changed = true;
			} else if ( name === 'output' && scenePassTexture ) {
				refs.set( source.textureUuid, scenePassTexture );
				changed = true;
			}
		}
	}
	if ( changed ) {
		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );
	}
	return artifact;
}

// =============================================================================
// SSR / DOF / TRAA replay machinery (Wedge 1.5-C)
//
// SSRNode, DepthOfFieldNode, and TRAANode each build a small set of internal
// NodeMaterials at setup() and drive a per-frame quad-mesh pipeline through
// updateBefore. The slim runtime has the node-builder stripped and cannot
// compile those live materials. We mirror the outline pattern: keep the
// original updateBefore, patch the public one to dispatch to the full
// WebGPURenderer, and share the resulting render-target texture(s) back into
// the slim renderer so the post-process artifact reads correct pixels.
//
// Why full-renderer fallback (not in-process like bloom)? Each effect's
// internal materials reference live RenderTarget texture objects whose UUIDs
// don't appear in the captured aux artifacts as stable inputs (they're
// internal scratch). Driving the materials through the full renderer keeps
// the live RT plumbing intact while we only have to share the FINAL output
// texture(s) into slim — exactly like outline.
// =============================================================================

function __ssrDiagnostics() {
	const diag = __harnessDiagnostics();
	if ( ! diag.ssr ) {
		diag.ssr = { collected: 0, prepared: 0, rendered: 0, fullRendered: 0, prepFailed: 0, renderFailed: 0, setupCalls: 0, ctor: '', type: '' };
	}
	return diag.ssr;
}

function __isSSREffectNode( node ) {
	if ( ! __isSpecializedEffectCandidate( node ) ) return false;
	const type = node && node.constructor && node.constructor.type || node && node.type || '';
	if ( type && type !== 'SSRNode' ) return false;
	return !! ( node
		&& typeof node.updateBefore === 'function'
		&& node._ssrMaterial
		&& node._blurMaterial
		&& node._copyMaterial
		&& node._ssrRenderTarget
		&& node._blurRenderTarget );
}

function __collectSSRNodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 96 || seen.has( node ) ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	if ( __isSSREffectNode( node ) ) {
		if ( ! out.includes( node ) ) out.push( node );
		return out;
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectSSRNodesInGraph( item, out, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectSSRNodesInGraph( child, out, seen, depth + 1 );
		}
	}
	return out;
}

let __fullSSRRendererState = null;
let __ssrResourceIdentity = 0;
const __ssrResourceIdentities = new WeakMap();

function __ssrResourceId( resource ) {
	if ( ! resource || ( typeof resource !== 'object' && typeof resource !== 'function' ) ) return null;
	let id = __ssrResourceIdentities.get( resource );
	if ( ! id ) {
		id = ++ __ssrResourceIdentity;
		__ssrResourceIdentities.set( resource, id );
	}
	return id;
}

function __ssrResourceSnapshot( renderer, texture ) {
	if ( ! renderer || ! texture ) return null;
	let backendData = null;
	let textureData = null;
	try {
		const backend = renderer.backend;
		if ( backend && typeof backend.get === 'function' && ( typeof backend.has !== 'function' || backend.has( texture ) ) ) {
			backendData = backend.get( texture );
		}
	} catch ( _ ) {}
	try {
		const textures = renderer._textures;
		if ( textures && typeof textures.get === 'function' && ( typeof textures.has !== 'function' || textures.has( texture ) ) ) {
			textureData = textures.get( texture );
		}
	} catch ( _ ) {}
	return {
		gpu: __ssrResourceId( backendData && backendData.texture ),
		backendVersion: backendData ? backendData.version ?? null : null,
		backendGeneration: backendData ? backendData.generation ?? null : null,
		managerVersion: textureData ? textureData.version ?? null : null,
		managerGeneration: textureData ? textureData.generation ?? null : null,
		initialized: textureData && textureData.initialized === true,
	};
}

function __recordSSRResourceState( ssrNode, stage, slimRenderer, fullRenderer ) {
	if ( window.__TSLP_DEBUG_SSR_RESOURCES !== true || ! ssrNode ) return;
	const diag = __ssrDiagnostics();
	const trace = diag.resourceTrace || ( diag.resourceTrace = [] );
	if ( trace.length >= 96 ) return;
	const target = ssrNode._ssrRenderTarget;
	const texture = target && target.texture;
	const image = texture && texture.image || {};
	trace.push( {
		stage,
		target: target ? { width: target.width, height: target.height } : null,
		image: { width: image.width || 0, height: image.height || 0 },
		textureVersion: texture && texture.version | 0,
		sameRenderer: slimRenderer === fullRenderer,
		slim: __ssrResourceSnapshot( slimRenderer, texture ),
		full: __ssrResourceSnapshot( fullRenderer, texture ),
	} );
}

function __traceSSRBackendDestroy( renderer, ssrNode, label, slimRenderer, fullRenderer ) {
	if ( window.__TSLP_DEBUG_SSR_RESOURCES !== true || ! renderer || ! renderer.backend ) return;
	const backend = renderer.backend;
	if ( backend.__tslpSSRDestroyTraced === true || typeof backend.destroyTexture !== 'function' ) return;
	const original = backend.destroyTexture;
	backend.destroyTexture = function ( texture, ...args ) {
		if ( texture === ssrNode._ssrRenderTarget.texture ) {
			__recordSSRResourceState( ssrNode, label + ':destroyTexture', slimRenderer, fullRenderer );
		}
		return original.call( this, texture, ...args );
	};
	Object.defineProperty( backend, '__tslpSSRDestroyTraced', { value: true, configurable: true } );
}

function __readReplayRendererDrawingSize( renderer ) {
	if ( ! renderer || typeof renderer.getDrawingBufferSize !== 'function' ) return null;
	try {
		const size = renderer.getDrawingBufferSize( new FullVector2() );
		return __selectReplayEffectSize( size );
	} catch ( _ ) {
		return null;
	}
}

function __rememberSSRReplaySize( ssrNode, context, presentationRenderer = null ) {
	if ( ! ssrNode ) return null;
	const contextRenderer = context && context.renderPipeline && context.renderPipeline.renderer;
	const viewportSize = typeof window !== 'undefined'
		? { width: window.innerWidth, height: window.innerHeight }
		: null;
	const size = __selectReplayEffectSize(
		__readReplayRendererDrawingSize( presentationRenderer ),
		__readReplayRendererDrawingSize( contextRenderer ),
		ssrNode.__tslpSSRReplaySize,
		viewportSize,
	);
	if ( ! size ) return null;
	try {
		Object.defineProperty( ssrNode, '__tslpSSRReplaySize', {
			value: size,
			configurable: true,
			writable: true,
		} );
	} catch ( _ ) {
		ssrNode.__tslpSSRReplaySize = size;
	}
	return size;
}

function __renderSSRNodeWithFullRendererCore( ssrNode, slimRenderer, fullRenderer, diag ) {
	if ( ! ssrNode || ! slimRenderer || ! fullRenderer ) return false;
	const originalUpdateBefore = ssrNode.__tslpSSROriginalUpdateBefore;
	if ( typeof originalUpdateBefore !== 'function' ) return false;
	try {
		__traceSSRBackendDestroy( slimRenderer, ssrNode, 'slim', slimRenderer, fullRenderer );
		__traceSSRBackendDestroy( fullRenderer, ssrNode, 'full', slimRenderer, fullRenderer );
		__recordSSRResourceState( ssrNode, 'entry', slimRenderer, fullRenderer );
		if ( FullRendererUtils && typeof FullRendererUtils.resetRendererState === 'function' ) {
			__fullSSRRendererState = FullRendererUtils.resetRendererState( fullRenderer, __fullSSRRendererState || undefined );
		}
		try {
			fullRenderer.toneMapping = slimRenderer.toneMapping;
			fullRenderer.toneMappingExposure = slimRenderer.toneMappingExposure;
			fullRenderer.outputColorSpace = slimRenderer.outputColorSpace;
		} catch ( _ ) {}
		// A nested temporal effect can call SSR with the full renderer as both
		// source and target while that renderer is temporarily 1x1. Retain the
		// real presentation size so SSR's RenderTargets are not resized twice in
		// one command wave, which would destroy a GPUTexture still referenced by
		// an encoded bind group.
		const presentationRenderer = slimRenderer !== fullRenderer ? slimRenderer : null;
		const drawingSize = __rememberSSRReplaySize( ssrNode, null, presentationRenderer )
			|| __selectReplayEffectSize( __readReplayRendererDrawingSize( fullRenderer ) );
		if ( drawingSize && typeof fullRenderer.setSize === 'function' ) {
			fullRenderer.setSize( drawingSize.width, drawingSize.height, false );
		}
		__recordSSRResourceState( ssrNode, 'after-full-size', slimRenderer, fullRenderer );

		// Share live scene textures (depth, beauty, normal) into the full
		// renderer so the SSR fragment node samples them correctly.
		__shareGraphTexturesBetweenRenderers( fullRenderer, slimRenderer, ssrNode, { skipOwnedRenderTargets: true } );
		__recordSSRResourceState( ssrNode, 'after-input-share', slimRenderer, fullRenderer );

		// Run the real updateBefore on the full renderer. SSR drives a 1+N
		// pass pipeline (trace + optional blur mips) through quad-mesh
		// renders; the full node-builder compiles each material's
		// fragmentNode on demand.
		originalUpdateBefore.call( ssrNode, { renderer: fullRenderer } );
		__recordSSRResourceState( ssrNode, 'after-update', slimRenderer, fullRenderer );
		try {
			__probeFrameEffectTextureAsync( fullRenderer, ssrNode._ssrRenderTarget && ssrNode._ssrRenderTarget.texture, 'SSRNode.output' );
			__probeFrameEffectTextureAsync( fullRenderer, ssrNode._blurRenderTarget && ssrNode._blurRenderTarget.texture, 'SSRNode.blur' );
		} catch ( _ ) {}

		// Hand the output texture(s) over to the slim renderer.
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, ssrNode._ssrRenderTarget.texture, { bumpVersion: false } ); } catch ( _ ) {}
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, ssrNode._blurRenderTarget.texture, { bumpVersion: false } ); } catch ( _ ) {}
		__recordSSRResourceState( ssrNode, 'after-output-share', slimRenderer, fullRenderer );

		diag.fullRendered ++;
		diag.rendered ++;
		return true;
	} catch ( err ) {
		diag.fullError = err && ( err.stack || err.message ) || String( err );
		if ( ! window.__tslpSSRFullRenderWarned ) {
			window.__tslpSSRFullRenderWarned = true;
			console.warn( '[tslp-e2e] SSR full-renderer replay failed:', diag.fullError );
		}
		return false;
	} finally {
		try {
			if ( __fullSSRRendererState && FullRendererUtils && typeof FullRendererUtils.restoreRendererState === 'function' ) FullRendererUtils.restoreRendererState( fullRenderer, __fullSSRRendererState );
		} catch ( _ ) {}
	}
}

function __renderSSRNodeWithFullRenderer( ssrNode, slimRenderer, fullRenderer, diag ) {
	const activeSchedule = slimRenderer && slimRenderer.__tslpCurrentPostprocessFrameSchedule
		|| fullRenderer && fullRenderer.__tslpCurrentPostprocessFrameSchedule
		|| null;
	if ( activeSchedule && typeof activeSchedule.run === 'function' ) {
		const reused = activeSchedule.hasSucceeded( ssrNode, __POSTPROCESS_FRAME_ROLES.PRODUCER );
		const result = activeSchedule.run(
			ssrNode,
			__POSTPROCESS_FRAME_ROLES.PRODUCER,
			() => __renderSSRNodeWithFullRendererCore( ssrNode, slimRenderer, fullRenderer, diag ),
		);
		if ( reused ) diag.scheduledReuses = ( diag.scheduledReuses | 0 ) + 1;
		else diag.scheduledClaims = ( diag.scheduledClaims | 0 ) + 1;
		return result !== false;
	}
	const owner = slimRenderer && slimRenderer.__tslpCurrentRenderPipeline
		|| fullRenderer && fullRenderer.__tslpCurrentRenderPipeline
		|| null;
	const scheduler = owner && owner.__tslpPostprocessFrameScheduler;
	if ( ! scheduler || typeof scheduler.begin !== 'function' ) {
		return __renderSSRNodeWithFullRendererCore( ssrNode, slimRenderer, fullRenderer, diag );
	}
	let schedule;
	try {
		schedule = scheduler.begin( slimRenderer, { context: owner._context || {} } );
	} catch ( _ ) {
		return __renderSSRNodeWithFullRendererCore( ssrNode, slimRenderer, fullRenderer, diag );
	}
	const reused = schedule.hasSucceeded( ssrNode, __POSTPROCESS_FRAME_ROLES.PRODUCER );
	const result = schedule.run(
		ssrNode,
		__POSTPROCESS_FRAME_ROLES.PRODUCER,
		() => __renderSSRNodeWithFullRendererCore( ssrNode, slimRenderer, fullRenderer, diag ),
	);
	if ( reused ) diag.scheduledReuses = ( diag.scheduledReuses | 0 ) + 1;
	else diag.scheduledClaims = ( diag.scheduledClaims | 0 ) + 1;
	return result !== false;
}

function __patchSSRNodeUpdateBefore( ssrNode ) {
	if ( ssrNode.__tslpSSRUpdatePatched === true ) return;
	const originalUpdateBefore = ssrNode.updateBefore;
	Object.defineProperty( ssrNode, '__tslpSSROriginalUpdateBefore', { value: originalUpdateBefore, configurable: true } );
	ssrNode.updateBefore = function ( frame = {} ) {
		const slimRenderer = frame && frame.renderer;
		if ( ! slimRenderer ) return;
		const diag = __ssrDiagnostics();
		const currentRenderTarget = typeof slimRenderer.getRenderTarget === 'function' ? slimRenderer.getRenderTarget() : null;
		const currentMRT = typeof slimRenderer.getMRT === 'function' ? slimRenderer.getMRT() : null;
		try {
			if ( __computeRenderer ) {
				if ( __renderSSRNodeWithFullRenderer( this, slimRenderer, __computeRenderer, diag ) ) return;
			}
			if ( typeof originalUpdateBefore === 'function' ) originalUpdateBefore.call( this, frame );
		} catch ( err ) {
			diag.renderFailed ++;
			if ( ! window.__tslpSSRRenderWarned ) {
				window.__tslpSSRRenderWarned = true;
				console.warn( '[tslp-e2e] SSR replay render failed:', err && err.message || err );
			}
		} finally {
			try { slimRenderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
			try { if ( typeof slimRenderer.setMRT === 'function' ) slimRenderer.setMRT( currentMRT ); } catch ( _ ) {}
		}
	};
	Object.defineProperty( ssrNode, '__tslpSSRUpdatePatched', { value: true, configurable: true } );
}

function __prepareSSRNodeForReplay( ssrNode, context ) {
	if ( ! __isSSREffectNode( ssrNode ) ) return false;
	const replaySize = __rememberSSRReplaySize( ssrNode, context );
	if ( ssrNode.__tslpSSRReplayReady === true ) return true;
	try {
		const diag = __ssrDiagnostics();
		diag.ctor = ssrNode.constructor && ssrNode.constructor.name || '';
		diag.type = ssrNode.constructor && ssrNode.constructor.type || ssrNode.type || '';
		// Size both targets before setup can expose them to a renderer backend.
		// Resizing an initialized target makes r185 destroy its existing
		// GPUTexture; doing that while the setup/render wave is encoding leaves
		// cached attachments pointing at a destroyed resource.
		if ( typeof ssrNode.setSize === 'function' ) {
			try {
				if ( replaySize ) ssrNode.setSize( replaySize.width, replaySize.height );
				// RenderTarget.setSize() updates the JavaScript dimensions but
				// leaves each renderer's private target record at the previous
				// allocation until initRenderTarget(). Reconcile both resources
				// here, before any producer/effect command wave can encode a view
				// of the old GPUTexture.
				if ( __computeRenderer && typeof __computeRenderer.initRenderTarget === 'function' ) {
					__computeRenderer.initRenderTarget( ssrNode._ssrRenderTarget );
					__computeRenderer.initRenderTarget( ssrNode._blurRenderTarget );
					diag.preinitializedTargets = 2;
				}
			} catch ( err ) {
				diag.setSizeError = err && ( err.stack || err.message ) || String( err );
			}
		}
		// Drive setup() on the FULL renderer so the SSR/blur/copy materials
		// receive their fragmentNodes through the live TSL builder. Mirrors
		// __prepareFrameEffectNodeForReplay.
		if ( __computeRenderer && typeof ssrNode.setup === 'function' ) {
			try {
				ssrNode.setup( __makeReplayNodeBuilder( __computeRenderer, context || {} ) );
				diag.setupCalls ++;
			} catch ( err ) {
				diag.setupError = err && ( err.stack || err.message ) || String( err );
			}
		}
		__patchSSRNodeUpdateBefore( ssrNode );
		Object.defineProperty( ssrNode, '__tslpSSRReplayReady', { value: true, configurable: true } );
		diag.prepared ++;
		return true;
	} catch ( err ) {
		__ssrDiagnostics().prepFailed ++;
		if ( ! window.__tslpSSRPrepWarned ) {
			window.__tslpSSRPrepWarned = true;
			console.warn( '[tslp-e2e] SSR replay prep failed:', err && err.message || err );
		}
		return false;
	}
}

function __renderSSRNodesForPipeline( renderer, ssrNodes ) {
	for ( const ssrNode of ssrNodes || [] ) {
		if ( __prepareSSRNodeForReplay( ssrNode, null ) ) ssrNode.updateBefore( { renderer } );
	}
}

// -----------------------------------------------------------------------------
// DOF
// -----------------------------------------------------------------------------

function __dofDiagnostics() {
	const diag = __harnessDiagnostics();
	if ( ! diag.dof ) {
		diag.dof = { collected: 0, prepared: 0, rendered: 0, fullRendered: 0, prepFailed: 0, renderFailed: 0, setupCalls: 0, ctor: '', type: '' };
	}
	return diag.dof;
}

function __isDOFEffectNode( node ) {
	if ( ! __isSpecializedEffectCandidate( node ) ) return false;
	const type = node && node.constructor && node.constructor.type || node && node.type || '';
	if ( type && type !== 'DepthOfFieldNode' ) return false;
	return !! ( node
		&& typeof node.updateBefore === 'function'
		&& node._CoCMaterial
		&& node._CoCBlurredMaterial
		&& node._blur64Material
		&& node._blur16Material
		&& node._compositeMaterial
		&& node._compositeRT );
}

function __collectDOFNodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 24 || seen.has( node ) ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	if ( __isDOFEffectNode( node ) ) {
		if ( ! out.includes( node ) ) out.push( node );
		return out;
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectDOFNodesInGraph( item, out, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectDOFNodesInGraph( child, out, seen, depth + 1 );
		}
	}
	return out;
}

let __fullDOFRendererState = null;

function __shareDOFInputTexturesBetweenRenderers( targetRenderer, sourceRenderer, dofNode ) {
	if ( ! targetRenderer || ! sourceRenderer || ! dofNode ) return 0;
	const textures = new Set();
	for ( const inputNode of [ dofNode.textureNode, dofNode.viewZNode ] ) {
		if ( ! inputNode ) continue;
		const byName = __collectGraphTexturesByName( inputNode );
		for ( const values of byName.values() ) {
			for ( const texture of Array.isArray( values ) ? values : [ values ] ) {
				if ( texture && texture.isTexture === true ) textures.add( texture );
			}
		}
	}
	for ( const texture of textures ) __shareGPUTextureEntry( targetRenderer, sourceRenderer, texture );
	return textures.size;
}

function __readDOFUniformValue( node ) {
	if ( ! node ) return null;
	const value = __readGraphOwnValue( node, 'value' ) ?? __readGraphOwnValue( node, '_value' );
	return Number.isFinite( value ) ? value : null;
}

function __renderDOFNodeWithFullRenderer( dofNode, slimRenderer, fullRenderer, diag ) {
	if ( ! dofNode || ! slimRenderer || ! fullRenderer ) return false;
	const originalUpdateBefore = dofNode.__tslpDOFOriginalUpdateBefore;
	if ( typeof originalUpdateBefore !== 'function' ) return false;
	try {
		if ( FullRendererUtils && typeof FullRendererUtils.resetRendererState === 'function' ) {
			__fullDOFRendererState = FullRendererUtils.resetRendererState( fullRenderer, __fullDOFRendererState || undefined );
		}
		try {
			fullRenderer.toneMapping = slimRenderer.toneMapping;
			fullRenderer.toneMappingExposure = slimRenderer.toneMappingExposure;
			fullRenderer.outputColorSpace = slimRenderer.outputColorSpace;
		} catch ( _ ) {}
		const tmpSize = new FullVector2();
		const drawingSize = slimRenderer.getDrawingBufferSize( tmpSize );
		if ( typeof fullRenderer.setSize === 'function' ) fullRenderer.setSize( drawingSize.width, drawingSize.height, false );

		diag.inputTexturesShared = ( diag.inputTexturesShared | 0 )
			+ __shareDOFInputTexturesBetweenRenderers( fullRenderer, slimRenderer, dofNode );
		diag.uniforms = {
			focusDistance: __readDOFUniformValue( dofNode.focusDistanceNode ),
			focalLength: __readDOFUniformValue( dofNode.focalLengthNode ),
			bokehScale: __readDOFUniformValue( dofNode.bokehScaleNode ),
		};

		originalUpdateBefore.call( dofNode, { renderer: fullRenderer } );

		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, dofNode._compositeRT.texture ); } catch ( _ ) {}
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, dofNode._blur16NearRT.texture ); } catch ( _ ) {}
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, dofNode._blur16FarRT.texture ); } catch ( _ ) {}

		diag.fullRendered ++;
		diag.rendered ++;
		return true;
	} catch ( err ) {
		diag.fullError = err && ( err.stack || err.message ) || String( err );
		if ( ! window.__tslpDOFFullRenderWarned ) {
			window.__tslpDOFFullRenderWarned = true;
			console.warn( '[tslp-e2e] DOF full-renderer replay failed:', diag.fullError );
		}
		return false;
	} finally {
		try {
			if ( __fullDOFRendererState && FullRendererUtils && typeof FullRendererUtils.restoreRendererState === 'function' ) FullRendererUtils.restoreRendererState( fullRenderer, __fullDOFRendererState );
		} catch ( _ ) {}
	}
}

function __patchDOFNodeUpdateBefore( dofNode ) {
	if ( dofNode.__tslpDOFUpdatePatched === true ) return;
	const originalUpdateBefore = dofNode.updateBefore;
	Object.defineProperty( dofNode, '__tslpDOFOriginalUpdateBefore', { value: originalUpdateBefore, configurable: true } );
	dofNode.updateBefore = function ( frame = {} ) {
		const slimRenderer = frame && frame.renderer;
		if ( ! slimRenderer ) return;
		const diag = __dofDiagnostics();
		const currentRenderTarget = typeof slimRenderer.getRenderTarget === 'function' ? slimRenderer.getRenderTarget() : null;
		const currentMRT = typeof slimRenderer.getMRT === 'function' ? slimRenderer.getMRT() : null;
		try {
			if ( __computeRenderer ) {
				if ( __renderDOFNodeWithFullRenderer( this, slimRenderer, __computeRenderer, diag ) ) return;
			}
			if ( typeof originalUpdateBefore === 'function' ) originalUpdateBefore.call( this, frame );
		} catch ( err ) {
			diag.renderFailed ++;
			if ( ! window.__tslpDOFRenderWarned ) {
				window.__tslpDOFRenderWarned = true;
				console.warn( '[tslp-e2e] DOF replay render failed:', err && err.message || err );
			}
		} finally {
			try { slimRenderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
			try { if ( typeof slimRenderer.setMRT === 'function' ) slimRenderer.setMRT( currentMRT ); } catch ( _ ) {}
		}
	};
	Object.defineProperty( dofNode, '__tslpDOFUpdatePatched', { value: true, configurable: true } );
}

function __prepareDOFNodeForReplay( dofNode, context ) {
	if ( ! __isDOFEffectNode( dofNode ) ) return false;
	if ( dofNode.__tslpDOFReplayReady === true ) return true;
	try {
		const diag = __dofDiagnostics();
		diag.ctor = dofNode.constructor && dofNode.constructor.name || '';
		diag.type = dofNode.constructor && dofNode.constructor.type || dofNode.type || '';
		if ( __computeRenderer && typeof dofNode.setup === 'function' ) {
			try {
				dofNode.setup( __makeReplayNodeBuilder( __computeRenderer, context || {} ) );
				diag.setupCalls ++;
			} catch ( err ) {
				diag.setupError = err && ( err.stack || err.message ) || String( err );
			}
		}
		__patchDOFNodeUpdateBefore( dofNode );
		Object.defineProperty( dofNode, '__tslpDOFReplayReady', { value: true, configurable: true } );
		diag.prepared ++;
		return true;
	} catch ( err ) {
		__dofDiagnostics().prepFailed ++;
		if ( ! window.__tslpDOFPrepWarned ) {
			window.__tslpDOFPrepWarned = true;
			console.warn( '[tslp-e2e] DOF replay prep failed:', err && err.message || err );
		}
		return false;
	}
}

function __renderDOFNodesForPipeline( renderer, dofNodes ) {
	for ( const dofNode of dofNodes || [] ) {
		if ( __prepareDOFNodeForReplay( dofNode, null ) ) dofNode.updateBefore( { renderer } );
	}
}

// -----------------------------------------------------------------------------
// TRAA
// -----------------------------------------------------------------------------

function __traaDiagnostics() {
	const diag = __harnessDiagnostics();
	if ( ! diag.traa ) {
		diag.traa = { collected: 0, prepared: 0, rendered: 0, fullRendered: 0, prepFailed: 0, renderFailed: 0, setupCalls: 0, ctor: '', type: '' };
	}
	return diag.traa;
}

function __isTRAAEffectNode( node ) {
	if ( ! __isSpecializedEffectCandidate( node ) ) return false;
	const type = node && node.constructor && node.constructor.type || node && node.type || '';
	if ( type && type !== 'TRAANode' ) return false;
	return !! ( node
		&& typeof node.updateBefore === 'function'
		&& node._resolveMaterial
		&& node._historyRenderTarget
		&& node._resolveRenderTarget );
}

function __collectTRAANodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 24 || seen.has( node ) ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	if ( __isTRAAEffectNode( node ) ) {
		if ( ! out.includes( node ) ) out.push( node );
		return out;
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectTRAANodesInGraph( item, out, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectTRAANodesInGraph( child, out, seen, depth + 1 );
		}
	}
	return out;
}

let __fullTRAARendererState = null;
let __slimTRAAQuad = null;
const __scheduledTRAAUpdateToken = Symbol( 'tslp-scheduled-traa-update' );

function __collectTRAASelfTextures( traaNode ) {
	const textures = new Set();
	const addTarget = ( target ) => {
		if ( ! target ) return;
		if ( target.texture && target.texture.isTexture === true ) textures.add( target.texture );
		if ( target.depthTexture && target.depthTexture.isTexture === true ) textures.add( target.depthTexture );
		for ( const texture of target.textures || [] ) {
			if ( texture && texture.isTexture === true ) textures.add( texture );
		}
	};
	addTarget( traaNode && traaNode._resolveRenderTarget );
	addTarget( traaNode && traaNode._historyRenderTarget );
	return textures;
}

function __auxShapeAvailable( shape ) {
	return Array.isArray( __data.aux ) && __data.aux.some( ( entry ) => entry && entry.shape === shape );
}

function __loadAuxArtifactByShape( shape ) {
	try {
		const artifact = Slim.loadAux( shape, 'tslp-e2e-bypass' );
		if ( artifact ) return artifact;
	} catch ( _ ) {}
	const entry = Array.isArray( __data.aux ) ? __data.aux.find( ( item ) => item && ( item.shape === shape || item.artifact && item.artifact.materialShape === shape ) ) : null;
	return entry && ( entry.artifact || entry ) || null;
}

function __nameTRAATextures( traaNode ) {
	try { if ( traaNode && traaNode._resolveRenderTarget && traaNode._resolveRenderTarget.texture ) traaNode._resolveRenderTarget.texture.name = 'TRAANode.resolve'; } catch ( _ ) {}
	try { if ( traaNode && traaNode._historyRenderTarget && traaNode._historyRenderTarget.texture ) traaNode._historyRenderTarget.texture.name = 'TRAANode.history'; } catch ( _ ) {}
	try { if ( traaNode && traaNode._historyRenderTarget && traaNode._historyRenderTarget.depthTexture ) traaNode._historyRenderTarget.depthTexture.name = 'TRAANode.history.depth'; } catch ( _ ) {}
}

function __useTRAAPrecompiledResolve( traaNode ) {
	if ( ! traaNode || typeof __state.example !== 'string' || ! __state.example.startsWith( 'webgpu_volume_' ) ) return false;
	return __auxShapeAvailable( 'traa-resolve' );
}

function __traaBeautyFallbackTexture( traaNode ) {
	try {
		const beauty = traaNode && traaNode.beautyNode;
		const passNode = beauty && beauty.passNode;
		const target = beauty && beauty.isRTTNode === true ? beauty.renderTarget : passNode && passNode.renderTarget;
		let texture = null;
		if ( passNode && typeof passNode.getTexture === 'function' ) texture = passNode.getTexture( 'output' );
		if ( ! texture && target && Array.isArray( target.textures ) ) texture = target.textures[ 0 ];
		if ( ! texture ) texture = target && target.texture;
		return texture && texture.isTexture === true ? texture : null;
	} catch ( _ ) {
		return null;
	}
}

function __useTRAABeautyFallback( traaNode ) {
	if ( typeof __state.example !== 'string' || ! __state.example.startsWith( 'webgpu_volume_' ) ) return false;
	if ( __useTRAAPrecompiledResolve( traaNode ) ) return false;
	return !! __traaBeautyFallbackTexture( traaNode );
}

function __attachTRAATextureRefs( artifact, traaNode, passNodes ) {
	if ( ! artifact || ! traaNode ) return artifact;
	__nameTRAATextures( traaNode );
	let wired = __attachGraphTextureRefs( artifact, traaNode );
	try {
		const beauty = traaNode.beautyNode;
		const passNode = beauty && beauty.passNode;
		const output = passNode && typeof passNode.getTexture === 'function' ? passNode.getTexture( 'output' ) : beauty && beauty.renderTarget && beauty.renderTarget.texture;
		const velocity = passNode && typeof passNode.getTexture === 'function' ? passNode.getTexture( 'velocity' ) : null;
		if ( output && output.isTexture === true ) {
			__attachTextureRefsWhere( wired, output, ( source ) => source.kind === 'artifact.texture' && source.textureName === 'output' );
		}
		if ( velocity && velocity.isTexture === true ) {
			__attachTextureRefsWhere( wired, velocity, ( source ) => source.kind === 'artifact.texture' && source.textureName === 'velocity' );
		}
		const history = traaNode._historyRenderTarget && traaNode._historyRenderTarget.texture;
		if ( history && history.isTexture === true ) {
			__attachTextureRefsWhere( wired, history, ( source ) => source.kind === 'artifact.texture' && source.textureName === 'TRAANode.history' );
			}
		} catch ( _ ) {}
	wired = __attachTRAADepthTextureRefs( wired, traaNode, passNodes || [] );
	return wired;
}

function __collectPassRenderedDepthUuids( artifact ) {
	const uuids = [];
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( ! __isPassRenderedDepthSource( source ) ) continue;
			if ( source.textureUuid && ! uuids.includes( source.textureUuid ) ) uuids.push( source.textureUuid );
		}
	}
	return uuids;
}

function __firstPassDepthTexture( passNodes ) {
	const ordered = Array.isArray( passNodes )
		? passNodes
			.filter( ( node ) => node && typeof node.getTexture === 'function' )
			.slice()
			.sort( ( a, b ) => ( __passDepthSortRank( a ) - __passDepthSortRank( b ) ) || ( ( a.__tslpPassIndex ?? 0 ) - ( b.__tslpPassIndex ?? 0 ) ) )
		: [];
	for ( const passNode of ordered ) {
		try {
			const texture = passNode.getTexture( 'depth' );
			if ( texture && texture.isTexture === true ) return texture;
		} catch ( _ ) {}
	}
	return null;
}

function __traaCurrentDepthTexture( traaNode, passNodes ) {
	try {
		const texture = traaNode && traaNode.depthNode && traaNode.depthNode.value;
		if ( texture && texture.isTexture === true ) return texture;
	} catch ( _ ) {}
	return __firstPassDepthTexture( passNodes );
}

function __attachTRAADepthTextureRefs( artifact, traaNode, passNodes ) {
	if ( ! artifact || ! traaNode ) return artifact;
	const uuids = __collectPassRenderedDepthUuids( artifact );
	if ( uuids.length === 0 ) return artifact;
	const currentDepth = __traaCurrentDepthTexture( traaNode, passNodes );
	const previousDepth = traaNode._historyRenderTarget && traaNode._historyRenderTarget.depthTexture;
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	const mapped = new Map();
	if ( currentDepth && currentDepth.isTexture === true ) mapped.set( uuids[ 0 ], currentDepth );
	if ( uuids.length > 1 && previousDepth && previousDepth.isTexture === true ) mapped.set( uuids[ 1 ], previousDepth );
	if ( mapped.size === 0 ) return artifact;
	for ( const [ uuid, texture ] of mapped ) refs.set( uuid, texture );
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source;
			if ( ! source || ! mapped.has( source.textureUuid ) || source.kind !== 'depth.texture' ) continue;
			source.kind = 'artifact.texture';
			source.textureName = source.textureName || ( source.textureUuid === uuids[ 1 ] ? 'TRAANode.history.depth' : 'depth' );
			source.__tslpPassDepthAttached = true;
		}
	}
	try {
		const diag = __harnessDiagnostics();
		diag.traaDepthRefs = Array.from( mapped.entries() ).map( ( [ uuid, texture ] ) => ( {
			uuid,
			textureName: texture && texture.name || '',
			isDepth: texture && texture.isDepthTexture === true,
			width: texture && texture.image && texture.image.width || null,
			height: texture && texture.image && texture.image.height || null,
		} ) );
	} catch ( _ ) {}
	Object.defineProperty( artifact, '_textureRefs', {
		value: refs,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	return artifact;
}

function __renderTRAANodeWithPrecompiledSlim( traaNode, renderer, passNodes, diag ) {
	if ( ! __useTRAAPrecompiledResolve( traaNode ) || ! renderer ) return false;
	try {
		__nameTRAATextures( traaNode );
		const beautyTexture = __traaBeautyFallbackTexture( traaNode );
		const resolveTarget = traaNode._resolveRenderTarget;
		const historyTarget = traaNode._historyRenderTarget;
		if ( ! resolveTarget || ! historyTarget || ! beautyTexture ) return false;
		const image = beautyTexture.image || {};
		const width = Math.max( 1, image.width || image.videoWidth || image.naturalWidth || resolveTarget.width || 1 );
		const height = Math.max( 1, image.height || image.videoHeight || image.naturalHeight || resolveTarget.height || 1 );
			try { if ( typeof traaNode.setSize === 'function' ) traaNode.setSize( width, height ); } catch ( _ ) {
				try { if ( typeof resolveTarget.setSize === 'function' ) resolveTarget.setSize( width, height ); } catch ( __ ) {}
				try { if ( typeof historyTarget.setSize === 'function' ) historyTarget.setSize( width, height ); } catch ( __ ) {}
			}
			try {
				if ( historyTarget.depthTexture && historyTarget.depthTexture.image ) {
					historyTarget.depthTexture.image.width = width;
					historyTarget.depthTexture.image.height = height;
					historyTarget.depthTexture.image.depth = 1;
				}
			} catch ( _ ) {}
			__nameTRAATextures( traaNode );
		try {
			if ( traaNode.__tslpTRAAHistoryInitialized !== true && typeof renderer.copyTextureToTexture === 'function' ) {
				renderer.copyTextureToTexture( beautyTexture, historyTarget.texture );
				Object.defineProperty( traaNode, '__tslpTRAAHistoryInitialized', { value: true, configurable: true, writable: true } );
			}
		} catch ( _ ) {}
		const loadedArtifact = __loadAuxArtifactByShape( 'traa-resolve' );
		if ( ! loadedArtifact ) return false;
		let artifact = __cloneAuxArtifact( loadedArtifact );
		artifact = __attachTRAATextureRefs( artifact, traaNode, passNodes );
		const material = new Slim.PrecompiledMaterial( artifact );
		material.name = 'TRAA [ Precompiled ]';
		material.needsUpdate = true;
		if ( ! __slimTRAAQuad ) __slimTRAAQuad = new Slim.QuadMesh();
		const currentRenderTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
		const currentMRT = typeof renderer.getMRT === 'function' ? renderer.getMRT() : null;
		try {
			renderer.setRenderTarget( resolveTarget );
			if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( null );
			__slimTRAAQuad.material = material;
			__slimTRAAQuad.name = 'TRAA [ Precompiled ]';
			__slimTRAAQuad.render( renderer );
		} finally {
			try { renderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
			try { if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( currentMRT ); } catch ( _ ) {}
		}
			try { if ( typeof renderer.copyTextureToTexture === 'function' ) renderer.copyTextureToTexture( resolveTarget.texture, historyTarget.texture ); } catch ( _ ) {}
			try {
				const currentDepth = __traaCurrentDepthTexture( traaNode, passNodes );
				if ( currentDepth && historyTarget.depthTexture && typeof renderer.copyTextureToTexture === 'function' ) {
					renderer.copyTextureToTexture( currentDepth, historyTarget.depthTexture );
					if ( traaNode._previousDepthNode ) traaNode._previousDepthNode.value = historyTarget.depthTexture;
				}
			} catch ( _ ) {}
			diag.precompiledRendered = ( diag.precompiledRendered | 0 ) + 1;
			diag.rendered ++;
			return true;
	} catch ( err ) {
		diag.precompiledError = err && ( err.stack || err.message ) || String( err );
		if ( ! window.__tslpTRAAPrecompiledWarned ) {
			window.__tslpTRAAPrecompiledWarned = true;
			console.warn( '[tslp-e2e] TRAA precompiled replay failed:', diag.precompiledError );
		}
		return false;
	}
}

function __renderTRAANodeWithFullRenderer( traaNode, slimRenderer, fullRenderer, diag ) {
	if ( ! traaNode || ! slimRenderer || ! fullRenderer ) return false;
	const originalUpdateBefore = traaNode.__tslpTRAAOriginalUpdateBefore;
	if ( typeof originalUpdateBefore !== 'function' ) return false;
	try {
		if ( FullRendererUtils && typeof FullRendererUtils.resetRendererState === 'function' ) {
			__fullTRAARendererState = FullRendererUtils.resetRendererState( fullRenderer, __fullTRAARendererState || undefined );
		}
		try {
			fullRenderer.toneMapping = slimRenderer.toneMapping;
			fullRenderer.toneMappingExposure = slimRenderer.toneMappingExposure;
			fullRenderer.outputColorSpace = slimRenderer.outputColorSpace;
		} catch ( _ ) {}
		const tmpSize = new FullVector2();
		const drawingSize = slimRenderer.getDrawingBufferSize( tmpSize );
		if ( typeof fullRenderer.setSize === 'function' ) fullRenderer.setSize( drawingSize.width, drawingSize.height, false );

		__shareGraphTexturesBetweenRenderers( fullRenderer, slimRenderer, traaNode, { skipTextures: __collectTRAASelfTextures( traaNode ) } );

		// TRAA's updateBefore calls renderer.initRenderTarget /
		// copyTextureToTexture on first run; these only work on the full
		// renderer. The original handles its own state save/restore.
		originalUpdateBefore.call( traaNode, { renderer: fullRenderer } );
		try {
			__probeFrameEffectTextureAsync( fullRenderer, traaNode._resolveRenderTarget && traaNode._resolveRenderTarget.texture, 'TRAANode.resolve' );
			__probeFrameEffectTextureAsync( fullRenderer, traaNode._historyRenderTarget && traaNode._historyRenderTarget.texture, 'TRAANode.history' );
		} catch ( _ ) {}

		// Share resolve + history textures back into slim. The post-process
		// artifact samples the resolve target via passTexture.
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, traaNode._resolveRenderTarget.texture ); } catch ( _ ) {}
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, traaNode._historyRenderTarget.texture ); } catch ( _ ) {}

		diag.fullRendered ++;
		diag.rendered ++;
		return true;
	} catch ( err ) {
		diag.fullError = err && ( err.stack || err.message ) || String( err );
		if ( ! window.__tslpTRAAFullRenderWarned ) {
			window.__tslpTRAAFullRenderWarned = true;
			console.warn( '[tslp-e2e] TRAA full-renderer replay failed:', diag.fullError );
		}
		return false;
	} finally {
		try {
			if ( __fullTRAARendererState && FullRendererUtils && typeof FullRendererUtils.restoreRendererState === 'function' ) FullRendererUtils.restoreRendererState( fullRenderer, __fullTRAARendererState );
		} catch ( _ ) {}
	}
}

function __patchTRAANodeUpdateBefore( traaNode ) {
	if ( traaNode.__tslpTRAAUpdatePatched === true ) return;
	const originalUpdateBefore = traaNode.updateBefore;
	Object.defineProperty( traaNode, '__tslpTRAAOriginalUpdateBefore', { value: originalUpdateBefore, configurable: true } );
	traaNode.updateBefore = function ( frame = {}, dispatchToken = null ) {
		const diag = __traaDiagnostics();
		// The terminal-effect scheduler drives TRAA after its producer and
		// consumer passes. The slim renderer can also discover this live node
		// while drawing the final quad; letting that automatic update through
		// advances the temporal history a second time with stale inputs.
		if ( dispatchToken !== __scheduledTRAAUpdateToken ) {
			diag.unscheduledBypassed = ( diag.unscheduledBypassed | 0 ) + 1;
			return;
		}
		const slimRenderer = frame && frame.renderer;
		if ( ! slimRenderer ) return;
		const currentRenderTarget = typeof slimRenderer.getRenderTarget === 'function' ? slimRenderer.getRenderTarget() : null;
		const currentMRT = typeof slimRenderer.getMRT === 'function' ? slimRenderer.getMRT() : null;
		try {
			if ( __useTRAAPrecompiledResolve( this ) ) {
				diag.precompiledBypassed = ( diag.precompiledBypassed | 0 ) + 1;
				return;
			}
			if ( __useTRAABeautyFallback( this ) ) {
				diag.beautyBypassed = ( diag.beautyBypassed | 0 ) + 1;
				return;
			}
			if ( __computeRenderer ) {
				if ( __renderTRAANodeWithFullRenderer( this, slimRenderer, __computeRenderer, diag ) ) return;
				diag.fullFailedBypassed = ( diag.fullFailedBypassed | 0 ) + 1;
				return;
			}
			if ( typeof originalUpdateBefore === 'function' ) originalUpdateBefore.call( this, frame );
		} catch ( err ) {
			diag.renderFailed ++;
			if ( ! window.__tslpTRAARenderWarned ) {
				window.__tslpTRAARenderWarned = true;
				console.warn( '[tslp-e2e] TRAA replay render failed:', err && err.message || err );
			}
		} finally {
			try { slimRenderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
			try { if ( typeof slimRenderer.setMRT === 'function' ) slimRenderer.setMRT( currentMRT ); } catch ( _ ) {}
		}
	};
	Object.defineProperty( traaNode, '__tslpTRAAUpdatePatched', { value: true, configurable: true } );
}

function __syncTRAAJitterIndex( traaNode ) {
	__sharedSynchronizeTemporalJitterNode( traaNode, { marker: '__tslpTRAAJitterSynchronized', installVelocityProjectionLifecycle: __installVelocityProjectionLifecycle } );
}

	function __prepareTRAANodeForReplay( traaNode, context ) {
		if ( ! __isTRAAEffectNode( traaNode ) ) return false;
		if ( traaNode.__tslpTRAAReplayReady === true ) return true;
		try {
			const diag = __traaDiagnostics();
			diag.ctor = traaNode.constructor && traaNode.constructor.name || '';
			diag.type = traaNode.constructor && traaNode.constructor.type || traaNode.type || '';
			// Synchronize BEFORE setup() so the setup-registered onBeforeRenderPipeline
			// closure (which does this.setViewOffset(...) dynamically) picks up the
			// patched instance methods on every frame.
			__syncTRAAJitterIndex( traaNode );
			// TRAA's setup() requires builder.renderer + builder.context.renderPipeline.
			// Drive setup on the full renderer so the resolveMaterial gets its colorNode.
		if ( __computeRenderer && typeof traaNode.setup === 'function' ) {
			try {
				traaNode.setup( __makeReplayNodeBuilder( __computeRenderer, context || {} ) );
				diag.setupCalls ++;
			} catch ( err ) {
				diag.setupError = err && ( err.stack || err.message ) || String( err );
			}
		}
		__patchTRAANodeUpdateBefore( traaNode );
		__nameTRAATextures( traaNode );
		Object.defineProperty( traaNode, '__tslpTRAAReplayReady', { value: true, configurable: true } );
		diag.prepared ++;
		return true;
	} catch ( err ) {
		__traaDiagnostics().prepFailed ++;
		if ( ! window.__tslpTRAAPrepWarned ) {
			window.__tslpTRAAPrepWarned = true;
			console.warn( '[tslp-e2e] TRAA replay prep failed:', err && err.message || err );
		}
		return false;
	}
}

function __renderTRAANodesForPipeline( renderer, traaNodes, passNodes, schedule = null, dependsOn = [] ) {
	let succeeded = true;
	for ( const traaNode of traaNodes || [] ) {
		const render = ( nodeFrame = null ) => {
			if ( ! __prepareTRAANodeForReplay( traaNode, null ) ) return false;
			const diag = __traaDiagnostics();
			if ( __renderTRAANodeWithPrecompiledSlim( traaNode, renderer, passNodes, diag ) ) return true;
			diag.scheduledDispatches = ( diag.scheduledDispatches | 0 ) + 1;
			traaNode.updateBefore( nodeFrame || { renderer }, __scheduledTRAAUpdateToken );
			return true;
		};
		const result = schedule
			? schedule.run( traaNode, __POSTPROCESS_FRAME_ROLES.TERMINAL_EFFECT, render, { dependsOn } )
			: render();
		if ( result === false ) succeeded = false;
	}
	return succeeded;
}

function __neutralizeRTTNodeUpdateBefore( rttNode ) {
	// Once we've driven the RTT explicitly via our quad / full renderer, the
	// slim renderer must not re-trigger RTTNode.updateBefore: the RTTNode's
	// internal quad mesh carries a full-renderer NodeMaterial which the slim
	// bundle refuses to build. Stub updateBefore to a no-op and clear the
	// auto-update flag so the slim renderer's node-update walker leaves it alone.
	if ( ! rttNode || rttNode.__tslpRTTUpdateNeutered === true ) return;
	try { rttNode.autoUpdate = false; } catch ( _ ) {}
	try { rttNode.textureNeedsUpdate = false; } catch ( _ ) {}
	try { rttNode.updateBefore = function () {}; } catch ( _ ) {}
	try { Object.defineProperty( rttNode, '__tslpRTTUpdateNeutered', { value: true, configurable: true } ); } catch ( _ ) {}
}

function __renderRTTNodesForPipeline( renderer, rttNodes, schedule = null, role = null, dependenciesFor = null ) {
	try {
		const diag = __harnessDiagnostics();
		diag.rtt = diag.rtt || { collected: 0, rendered: 0, failed: 0 };
		diag.rtt.collected += rttNodes && rttNodes.length || 0;
	} catch ( _ ) {}
	let succeeded = true;
	for ( const rttNode of rttNodes || [] ) {
		const render = () => {
			if ( __renderRTTNodeWithFullRenderer( rttNode, renderer, __computeRenderer ) ) {
				__neutralizeRTTNodeUpdateBefore( rttNode );
				try { __harnessDiagnostics().rtt.rendered ++; } catch ( _ ) {}
				return true;
			}
			try { __harnessDiagnostics().rtt.failed ++; } catch ( _ ) {}
			return false;
		};
		const rendered = schedule && role
			? schedule.run( rttNode, role, render, {
				dependsOn: typeof dependenciesFor === 'function' ? dependenciesFor( rttNode ) : [],
			} )
			: render();
		if ( rendered === false ) succeeded = false;
	}
	return succeeded;
}

function __frameEffectInputRTTProducers( effectNode, producersForEffect = null ) {
	const producers = typeof producersForEffect === 'function'
		? producersForEffect( effectNode )
		: __selectFrameEffectInputRTTProducers( effectNode );
	return Array.from( new Set( ( producers || [] ).filter( __isRTTNode ) ) );
}

function __renderFrameEffectInputRTTProducersForPipeline( renderer, effectNode, schedule = null, producersForEffect = null ) {
	const producers = __frameEffectInputRTTProducers( effectNode, producersForEffect );
	if ( producers.length === 0 ) return { producers, succeeded: true };
	const producerSucceeded = __renderRTTNodesForPipeline(
		renderer,
		producers,
		schedule,
		__POSTPROCESS_FRAME_ROLES.PRODUCER,
	);
	try {
		const diag = __frameEffectDiagnostics();
		diag.inputRTTProducerClaims = ( diag.inputRTTProducerClaims | 0 ) + producers.length;
		if ( producerSucceeded === false ) {
			diag.inputRTTProducerFailures = ( diag.inputRTTProducerFailures | 0 ) + 1;
		}
	} catch ( _ ) {}
	return { producers, succeeded: producerSucceeded !== false };
}

function __rttNodeDependsOnEffect( rttNode, effectNode ) {
	if ( ! rttNode || ! effectNode ) return false;
	const node = rttNode._rttNode || rttNode.node || rttNode;
	return __sharedPostprocessGraphContains( rttNode, effectNode )
		|| __sharedPostprocessGraphContains( node, effectNode );
}

function __effectDependenciesForRTT( rttNode, effectNodes ) {
	return ( effectNodes || [] ).filter( ( effectNode ) => __rttNodeDependsOnEffect( rttNode, effectNode ) );
}

function __postprocessNodeDependsOnAny( node, dependencies ) {
	return ( dependencies || [] ).some( ( dependency ) => __sharedPostprocessGraphContains( node, dependency ) );
}

function __partitionPostprocessNodesByDependency( nodes, dependencies ) {
	const independent = [];
	const dependent = [];
	for ( const node of nodes || [] ) {
		( __postprocessNodeDependsOnAny( node, dependencies ) ? dependent : independent ).push( node );
	}
	return { independent, dependent };
}

function __rttNodeDependsOnBloom( rttNode, bloomNodes ) {
	if ( ! rttNode || ! Array.isArray( bloomNodes ) || bloomNodes.length === 0 ) return false;
	const node = rttNode._rttNode || rttNode.node || rttNode;
	for ( const bloomNode of bloomNodes ) {
		if ( __graphContainsNode( rttNode, bloomNode ) || __graphContainsNode( node, bloomNode ) ) return true;
	}
	return false;
}

function __filterRTTNodesByBloomDependency( rttNodes, bloomNodes, wantDependent ) {
	if ( ! Array.isArray( rttNodes ) || rttNodes.length === 0 ) return [];
	if ( ! Array.isArray( bloomNodes ) || bloomNodes.length === 0 ) return wantDependent ? [] : rttNodes;
	return rttNodes.filter( ( rttNode ) => __rttNodeDependsOnBloom( rttNode, bloomNodes ) === wantDependent );
}

function __renderBloomDependentRTTNodesForPipeline( renderer, rttNodes, bloomNodes, schedule = null ) {
	if ( ! Array.isArray( rttNodes ) || rttNodes.length === 0 || ! Array.isArray( bloomNodes ) || bloomNodes.length === 0 ) return 0;
	const dependent = rttNodes.filter( ( rttNode ) => __rttNodeDependsOnBloom( rttNode, bloomNodes ) );
	const ok = __renderRTTNodesForPipeline(
		renderer,
		dependent,
		schedule,
		__POSTPROCESS_FRAME_ROLES.CONSUMER,
		( rttNode ) => bloomNodes.filter( ( bloomNode ) => __rttNodeDependsOnBloom( rttNode, [ bloomNode ] ) ),
	);
	const rendered = ok === false ? 0 : dependent.length;
	if ( rendered > 0 ) {
		try {
			const diag = __harnessDiagnostics();
			diag.rtt = diag.rtt || { collected: 0, rendered: 0, failed: 0 };
			diag.rtt.bloomDependentRendered = ( diag.rtt.bloomDependentRendered || 0 ) + rendered;
		} catch ( _ ) {}
	}
	return rendered;
}

function __frameEffectDiagnostics() {
	const diag = __harnessDiagnostics();
	if ( ! diag.frameEffects ) {
		diag.frameEffects = { collected: 0, prepared: 0, rendered: 0, failed: 0, setupFailed: 0, names: [] };
	}
	return diag.frameEffects;
}

function __frameEffectFrameId() {
	return __sharedTemporalJitterFrameId( window );
}

let __maintenanceRenderSequence = 0;

function __maintenanceTemporalFrame( kind ) {
	const frameId = __frameEffectFrameId();
	return {
		frameId,
		renderId: 'maintenance:' + kind + ':' + frameId + ':' + ( ++ __maintenanceRenderSequence ),
		advance: false,
	};
}

function __nodeOwnsRenderTarget( node ) {
	if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) ) return false;
	if ( ! __isGraphTraversalCandidate( node ) ) return false;
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	for ( const key of keys ) {
		const value = __readGraphOwnValue( node, key );
		if ( value && value.isRenderTarget === true ) return true;
		if ( value && value.texture && value.texture.isTexture === true && typeof value.setSize === 'function' ) return true;
	}
	return false;
}

function __isFrameEffectNode( node ) {
	if ( ! node || typeof node.updateBefore !== 'function' ) return false;
	// Compute nodes can be reachable from material roots (for example through a
	// geometryNode's deferred material-compute sidecar), but their updateBefore
	// hook belongs to the compute dispatch plane. They are never postprocess
	// effects and setup() requires a real NodeBuilder owned by that dispatcher.
	if ( node.isComputeNode === true ) return false;
	if ( node.isPassNode === true || node.isRTTNode === true || __isBloomEffectNode( node ) || __isOutlineEffectNode( node ) ) return false;
	if ( __isSSREffectNode( node ) || __isDOFEffectNode( node ) || __isTRAAEffectNode( node ) ) return false;
	const proto = Object.getPrototypeOf( node );
	const hasSpecialUpdateBefore = Object.prototype.hasOwnProperty.call( node, 'updateBefore' )
		|| !! ( proto && Object.prototype.hasOwnProperty.call( proto, 'updateBefore' ) );
	if ( ! hasSpecialUpdateBefore && ! __nodeOwnsRenderTarget( node ) ) return false;
	// ReflectorBaseNode renders the scene from a mirrored camera into a per-camera
	// RenderTarget. The hydrator already wires it into the floor material's
	// updateBeforeNodes via __tslpReflectorBaseNodes, so the slim renderer drives
	// it with a proper { scene, camera, renderer } frame. Driving it again here
	// through the full renderer with no scene/camera crashes in getVirtualCamera
	// (camera.clone of undefined).
	const ctorType = node.constructor && node.constructor.type || '';
	if ( ctorType === 'ReflectorBaseNode' || ctorType === 'ReflectorNode' ) return false;
	// PMREMNode setup is already represented in the captured shader and texture
	// refs. Driving it as a frame effect can regenerate/share an unrelated PMREM
	// while replay is settling.
	if ( ctorType === 'PMREMNode' ) return false;
	const kind = __nodeUpdateKind( node, 'before' );
	if ( kind === 'none' || kind === null || kind === undefined ) return false;
	if ( typeof node.setup !== 'function' && typeof node.getTextureNode !== 'function' && ! __nodeOwnsRenderTarget( node ) ) return false;
	return true;
}

function __collectFrameEffectNodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 32 || seen.has( node ) ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	for ( const dependency of __sharedGetLiveNodeDependencies( node ) ) {
		__collectFrameEffectNodesInGraph( dependency.node, out, seen, depth + 1 );
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement', 'renderTarget', '_aoRenderTarget', '_ssgiRenderTarget', '_ssrRenderTarget', '_blurRenderTarget', '_renderTarget', '_compRT', '_oldRT', '_CoCRT', '_CoCBlurredRT', '_blur64RT', '_blur16NearRT', '_blur16FarRT', '_compositeRT' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) {
				if ( item && ( item.isNode === true || typeof item.updateBefore === 'function' ) ) __collectFrameEffectNodesInGraph( item, out, seen, depth + 1 );
			}
		} else if ( child.isNode === true || typeof child.updateBefore === 'function' ) {
			__collectFrameEffectNodesInGraph( child, out, seen, depth + 1 );
		} else if ( Object.getPrototypeOf( child ) === Object.prototype ) {
			for ( const item of Object.values( child ) ) {
				if ( item && ( item.isNode === true || typeof item.updateBefore === 'function' ) ) __collectFrameEffectNodesInGraph( item, out, seen, depth + 1 );
			}
		}
	}
	if ( __isFrameEffectNode( node ) && ! out.includes( node ) ) out.push( node );
	return out;
}

const __frameEffectNodeProperties = new WeakMap();

function __makeReplayNodeBuilder( renderer, context ) {
	const sharedContext = context || {};
	return {
		renderer,
		context: sharedContext,
		getSharedContext() {
			return sharedContext;
		},
		getNodeProperties( node ) {
			if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) ) return {};
			let props = __frameEffectNodeProperties.get( node );
			if ( ! props ) {
				props = {};
				__frameEffectNodeProperties.set( node, props );
			}
			return props;
		},
	};
}

function __refreshPipelineMaterialArtifact( renderer, material, artifact ) {
	if ( ! material || ! artifact ) return artifact;
	material.precompiledArtifact = artifact;
	material.needsUpdate = true;
	try { material.dispose && material.dispose(); } catch ( _ ) {}
	try {
		const cache = renderer && renderer._nodes && renderer._nodes.nodeBuilderCache;
		if ( cache && typeof cache.clear === 'function' ) cache.clear();
	} catch ( _ ) {}
	return artifact;
}

function __configureRenderPipelineQuadMaterial( material ) {
	if ( ! material ) return material;
	material.name = material.name || 'RenderPipeline';
	material.toneMapped = false;
	material.depthTest = false;
	material.depthWrite = false;
	material.fog = false;
	return material;
}

function __attachPrecompiledCameraTarget( material, camera ) {
	if ( ! ( material && material.isPrecompiledMaterial === true && camera ) ) return material;
	try {
		Object.defineProperty( material, '__tslpObject3DTargets', {
			value: { camera },
			configurable: true,
			writable: true,
		} );
	} catch ( _ ) {
		material.__tslpObject3DTargets = { camera };
	}
	return material;
}

function __attachRenderPipelineCameraTarget( material, passNode ) {
	const passType = passNode && ( passNode.constructor && ( passNode.constructor.type || passNode.constructor.name ) || passNode.type || '' );
	if ( passNode && passNode.camera && passType !== 'RetroPassNode' ) __attachPrecompiledCameraTarget( material, passNode.camera );
	return material;
}

function __godraysInputForFrameEffect( node ) {
	if ( __effectTypeName( node ) !== 'BilateralBlurNode' ) return null;
	const textureNode = node && node.textureNode;
	const passNode = textureNode && textureNode.passNode || null;
	return __effectTypeName( passNode ) === 'GodraysNode' ? passNode : null;
}

function __frameEffectNeedsShadowMap( node ) {
	const type = __effectTypeName( node );
	const godraysInput = type === 'GodraysNode' ? null : __godraysInputForFrameEffect( node );
	if ( godraysInput ) {
		if ( __frameEffectNeedsShadowMap( godraysInput ) ) return true;
		return godraysInput.__tslpFrameEffectRenderedOnce !== true;
	}
	if ( type !== 'GodraysNode' ) return false;
	const light = node && node._light;
	if ( ! ( light && light.shadow ) ) return false;
	if ( ! ( light.shadow.map && light.shadow.map.depthTexture ) ) return true;
	// PointLight shadow setup publishes light.shadow.map/depthTexture before the
	// async full-renderer pass has finished drawing and sharing the populated cube
	// depth texture. Keep Godrays deferred until the shadow job fully drains so it
	// does not compile/render once against an all-clear depth cube.
	return ( window.__tslpShadowPending | 0 ) > 0;
}

function __deferFrameEffectUntilShadowReady( node, renderer, context ) {
	if ( ! __frameEffectNeedsShadowMap( node ) ) return false;
	const passNodes = context && Array.isArray( context.passNodes ) ? context.passNodes : [];
	const passNode = passNodes.find( ( candidate ) => candidate && candidate.scene && candidate.camera ) || null;
	if ( passNode && renderer ) {
		try { __kickShadowRenderAsync( context && context.renderPipeline && context.renderPipeline.renderer || renderer, passNode.scene, passNode.camera ); } catch ( _ ) {}
	}
	const diag = __frameEffectDiagnostics();
	diag.shadowDeferred = ( diag.shadowDeferred || 0 ) + 1;
	return true;
}

function __prepareFrameEffectNodeForReplay( node, fullRenderer, context ) {
	if ( ! __isFrameEffectNode( node ) || ! fullRenderer ) return false;
	if ( node.__tslpFrameEffectReady === true ) return true;
	const diag = __frameEffectDiagnostics();
	try {
		if ( __deferFrameEffectUntilShadowReady( node, fullRenderer, context ) ) return false;
		if ( __isTAAUFrameEffectNode( node ) ) __syncTAAUJitterIndex( node );
		const effectType = __effectTypeName( node );
		if ( effectType === 'AfterImageNode' ) {

			// Three normally performs this descriptor-only work at the start of
			// updateBefore(). Compiler-free replay must do it before an exact
			// precompiled sampler selector observes the owned targets.
			__sharedPrepareAfterImageReplayResources( node, fullRenderer );

		}
		if ( effectType === 'SSSNode' ) {

			const handler = __sharedFindEffectHandler( node );
			const result = __sharedPrepareEffectNodeForReplay( handler, node, {
				loadAux: ( shape ) => Slim.loadAux( shape, 'tslp-e2e-bypass' ),
				PrecompiledMaterial: Slim.PrecompiledMaterial,
				renderer: fullRenderer,
				sharedContext: context || {},
				passNodes: context && context.passNodes || [],
			} );
			if ( ! ( result.alreadyPrepared || result.prepared.length > 0 ) ) {

				throw new Error( 'SSS precompiled replay preparation missed: ' + JSON.stringify( result.missed ) );

			}
			Object.defineProperty( node, '__tslpUseSlimEffectReplay', { value: true, configurable: true } );
			const sssDiag = diag.sss || ( diag.sss = { prepared: 0, renderedPrecompiled: 0, missed: 0 } );
			sssDiag.prepared += result.prepared.length;
			sssDiag.missed += result.missed.length;

		} else if ( typeof node.setup === 'function' ) {

			node.setup( __makeReplayNodeBuilder( fullRenderer, context ) );

		}
		Object.defineProperty( node, '__tslpFrameEffectReady', { value: true, configurable: true } );
		diag.prepared ++;
		return true;
	} catch ( err ) {
		diag.setupFailed ++;
		if ( ! window.__tslpFrameEffectSetupWarned ) {
			window.__tslpFrameEffectSetupWarned = true;
			console.warn( '[tslp-e2e] postprocess effect setup failed:', err && ( err.stack || err.message ) || err );
		}
		return false;
	}
}

function __prepareRTTNodeForReplay( rttNode, renderer, context ) {
	if ( ! __isRTTNode( rttNode ) || ! renderer ) return false;
	if ( rttNode.__tslpRTTReplayReady === true || rttNode._rttNode ) return true;
	if ( typeof rttNode.setup !== 'function' ) return false;
	try {
		rttNode.setup( __makeReplayNodeBuilder( renderer, context || {} ) );
		Object.defineProperty( rttNode, '__tslpRTTReplayReady', { value: true, configurable: true } );
		try {
			const diag = __harnessDiagnostics();
			diag.rtt = diag.rtt || { collected: 0, rendered: 0, failed: 0 };
			diag.rtt.eagerPrepared = ( diag.rtt.eagerPrepared | 0 ) + 1;
		} catch ( _ ) {}
		return true;
	} catch ( err ) {
		try {
			const diag = __harnessDiagnostics();
			diag.rtt = diag.rtt || { collected: 0, rendered: 0, failed: 0 };
			diag.rtt.eagerPrepareFailed = ( diag.rtt.eagerPrepareFailed | 0 ) + 1;
		} catch ( _ ) {}
		if ( ! window.__tslpRTTPrepareWarned ) {
			window.__tslpRTTPrepareWarned = true;
			console.warn( '[tslp-e2e] RTT replay prep failed:', err && ( err.stack || err.message ) || err );
		}
		return false;
	}
}

function __prepareHiddenFrameEffectDependenciesForReplay( effectNodes, renderer, context, producersForEffect = null ) {
	const topLevelEffects = new Set( effectNodes || [] );
	const preparedDependencies = new Set();
	const preparedProducers = new Set();
	for ( const effectNode of effectNodes || [] ) {
		const dependency = __selectFrameEffectOwnedPassDependency( effectNode, __isFrameEffectNode );
		if ( ! dependency ) continue;
		for ( const producer of __frameEffectInputRTTProducers( effectNode, producersForEffect ) ) {
			if ( preparedProducers.has( producer ) ) continue;
			preparedProducers.add( producer );
			__prepareRTTNodeForReplay( producer, renderer, context );
		}
		if ( topLevelEffects.has( dependency ) || preparedDependencies.has( dependency ) ) continue;
		preparedDependencies.add( dependency );
		__prepareFrameEffectNodeForReplay( dependency, renderer, context );
	}
	return {
		dependencies: Array.from( preparedDependencies ),
		producers: Array.from( preparedProducers ),
	};
}

function __isTAAUFrameEffectNode( node ) {
	const type = node && node.constructor && ( node.constructor.type || node.constructor.name ) || node && node.type || '';
	return type === 'TAAUNode'
		&& node._historyRenderTarget
		&& node._resolveRenderTarget
		&& node.beautyNode;
}

	function __syncTAAUJitterIndex( taauNode ) {
		__sharedSynchronizeTemporalJitterNode( taauNode, { marker: '__tslpTAAUJitterSynchronized', installVelocityProjectionLifecycle: __installVelocityProjectionLifecycle } );
	}

		function __findOwnedBloomTexture( root, seen = new Set(), depth = 0 ) {
			if ( ! root || depth > 16 || seen.has( root ) ) return null;
			if ( ! __isGraphTraversalCandidate( root ) ) return null;
			seen.add( root );
			if ( __isBloomEffectNode( root ) ) {
				try {
					const textureNode = typeof root.getTextureNode === 'function' ? root.getTextureNode() : root._textureOutput;
					const texture = textureNode && textureNode.value || root._renderTargetsHorizontal && root._renderTargetsHorizontal[ 0 ] && root._renderTargetsHorizontal[ 0 ].texture;
					if ( texture && texture.isTexture === true ) return texture;
				} catch ( _ ) {}
			}
			const keys = [];
			try { keys.push( ...Object.getOwnPropertyNames( root ) ); } catch ( _ ) { return null; }
			const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement', 'renderTarget' ] );
			for ( const key of keys ) {
				if ( skip.has( key ) ) continue;
				const child = __readGraphOwnValue( root, key );
				if ( ! child ) continue;
				if ( Array.isArray( child ) ) {
					for ( const item of child ) {
						const texture = __findOwnedBloomTexture( item, seen, depth + 1 );
						if ( texture ) return texture;
					}
				} else {
					const texture = __findOwnedBloomTexture( child, seen, depth + 1 );
					if ( texture ) return texture;
				}
			}
			return null;
		}

		function __retargetLensflareInputTexture( node ) {
			if ( __effectTypeName( node ) !== 'LensflareNode' || ! node.textureNode ) return null;
			const texture = __findOwnedBloomTexture( node );
			if ( ! texture || texture.isTexture !== true ) return null;
			if ( node.textureNode.value !== texture ) node.textureNode.value = texture;
			return texture;
		}

function __neutralizeFrameEffectNodeUpdateBefore( node ) {
	if ( ! node || node.__tslpFrameEffectUpdateNeutered === true ) return;
	const original = typeof node.updateBefore === 'function' ? node.updateBefore : null;
	if ( original && ! node.__tslpFrameEffectOriginalUpdateBefore ) {
		try { Object.defineProperty( node, '__tslpFrameEffectOriginalUpdateBefore', { value: original, configurable: true } ); } catch ( _ ) {}
	}
	try { node.updateBefore = function () {}; } catch ( _ ) {}
	try { Object.defineProperty( node, '__tslpFrameEffectUpdateNeutered', { value: true, configurable: true } ); } catch ( _ ) {}
}

function __createFrameEffectNodeFrame( effectRenderer, context, scheduledNodeFrame ) {
	const fallbackFrameId = __frameEffectFrameId();
	return __sharedCreateIsolatedFrameEffectNodeFrame( {
		renderer: effectRenderer,
		context: context || {},
		frameId: scheduledNodeFrame ? scheduledNodeFrame.frameId : fallbackFrameId,
		renderId: scheduledNodeFrame ? scheduledNodeFrame.renderId : fallbackFrameId,
		time: scheduledNodeFrame && scheduledNodeFrame.time,
		resolveUpdateBefore: ( dependency ) => {
			// Effects such as RecurrentDenoiseNode schedule a nested
			// TemporalReprojectNode through frame.updateBeforeNode(). That
			// dependency may be reachable only through the live pass-texture
			// sidecar, so it is not necessarily part of the top-level effect
			// preparation list. Running updateBefore() without setup() leaves
			// its seed/resolve NodeMaterials empty and produces an all-zero
			// history target. Prepare at the exact dependency boundary before
			// handing the isolated frame its original update hook.
			const isFrameEffect = __isFrameEffectNode( dependency );
			const dependencyType = __effectTypeName( dependency ) || 'unknown';
			const wasReady = dependency && dependency.__tslpFrameEffectReady === true;
			if ( isFrameEffect && ! wasReady ) {
				__prepareFrameEffectNodeForReplay( dependency, effectRenderer, context || {} );
			}
			const presentationRenderer = context && context.renderPipeline && context.renderPipeline.renderer || effectRenderer;
			if ( dependencyType === 'TemporalReprojectNode' ) {
				try {
					const diag = __frameEffectDiagnostics();
					const temporal = diag.temporalDependencies || ( diag.temporalDependencies = [] );
					if ( temporal.length < 8 ) {
						const beauty = dependency.beautyNode && dependency.beautyNode.value;
						const depth = dependency.depthNode && dependency.depthNode.value;
						const beautyEffectState = __frameEffectTextureDiagnosticState( effectRenderer, beauty );
						const beautyPresentationState = __frameEffectTextureDiagnosticState( presentationRenderer, beauty );
						const depthEffectState = __frameEffectTextureDiagnosticState( effectRenderer, depth );
						const depthPresentationState = __frameEffectTextureDiagnosticState( presentationRenderer, depth );
						temporal.push( {
							resolveFragmentReady: !! ( dependency._resolveMaterial && dependency._resolveMaterial.fragmentNode ),
							seedFragmentReady: !! ( dependency._seedMaterial && dependency._seedMaterial.fragmentNode ),
							beauty: beautyEffectState.identity || beautyPresentationState.identity,
							beautyShared: !! beautyEffectState.gpuTexture && beautyEffectState.gpuTexture === beautyPresentationState.gpuTexture,
							depth: depthEffectState.identity || depthPresentationState.identity,
							depthShared: !! depthEffectState.gpuTexture && depthEffectState.gpuTexture === depthPresentationState.gpuTexture,
							beautyNodeType: __effectTypeName( dependency.beautyNode ),
							beautyIsRTTNode: dependency.beautyNode && dependency.beautyNode.isRTTNode === true,
							beautyProducerType: __effectTypeName( dependency.beautyNode && dependency.beautyNode.node ),
							beautyPreparedType: __effectTypeName( dependency.beautyNode && dependency.beautyNode._rttNode ),
							beautyProducerInnerType: __effectTypeName(
								dependency.beautyNode &&
								dependency.beautyNode.node &&
								dependency.beautyNode.node.node
							),
						} );
					}
				} catch ( _ ) {}
			}
			try {
				const diag = __frameEffectDiagnostics();
				const records = diag.dependencyPreparations || ( diag.dependencyPreparations = [] );
				if ( records.length < 24 ) {
					records.push( {
						type: dependencyType,
						isFrameEffect,
						wasReady,
						ready: dependency && dependency.__tslpFrameEffectReady === true,
						updateKind: dependency ? __nodeUpdateKind( dependency, 'before' ) : null,
						hasResolveFragment: !! ( dependency && dependency._resolveMaterial && dependency._resolveMaterial.fragmentNode ),
						hasSeedFragment: !! ( dependency && dependency._seedMaterial && ( dependency._seedMaterial.fragmentNode || dependency._seedMaterial.outputNode ) ),
						resolveWidth: dependency && dependency._resolveRenderTarget && dependency._resolveRenderTarget.width || null,
						resolveHeight: dependency && dependency._resolveRenderTarget && dependency._resolveRenderTarget.height || null,
					} );
				}
			} catch ( _ ) {}
			const update = dependency && ( dependency.__tslpFrameEffectOriginalUpdateBefore || dependency.updateBefore );
			return update;
		},
	} );
}

function __invokeFrameEffectUpdateBefore( node, frame ) {
	if ( ! node || ! frame || typeof frame.updateBeforeNode !== 'function' ) return;
	return frame.updateBeforeNode( node );
}

function __renderFrameEffectNodeWithFullRenderer( node, slimRenderer, fullRenderer, context, scheduledNodeFrame = null ) {
	if ( ! __isFrameEffectNode( node ) || ! slimRenderer || ! fullRenderer ) return false;
	const diag = __frameEffectDiagnostics();
	const effectName = node.constructor && ( node.constructor.type || node.constructor.name ) || node.type || 'effect';
	try {
		if ( ! __prepareFrameEffectNodeForReplay( node, fullRenderer, context ) ) return false;
		const useSlimEffectReplay = node.__tslpUseSlimEffectReplay === true;
		const effectRenderer = useSlimEffectReplay ? slimRenderer : fullRenderer;
		try {
			const debug = diag.__debug || ( diag.__debug = [] );
			if ( debug.length < 16 ) {
				debug.push( {
					stage: 'effect-before',
					effectName,
					inputNames: Array.from( __collectGraphTexturesByName( node ).entries() ).map( ( [ name, textures ] ) => {
						const texture = Array.isArray( textures ) ? textures[ 0 ] : textures;
						const image = texture && texture.image || {};
						return { name, textureName: texture && texture.name || '', width: image.width || image.naturalWidth || image.videoWidth || 0, height: image.height || image.naturalHeight || image.videoHeight || 0 };
					} ),
				} );
			}
		} catch ( _ ) {}
		if ( scheduledNodeFrame === null && effectName === 'AfterImageNode' && node.__tslpFrameEffectRenderedOnce === true ) {
			diag.reused = ( diag.reused || 0 ) + 1;
			return true;
		}
		if ( ! useSlimEffectReplay ) try {
			fullRenderer.toneMapping = slimRenderer.toneMapping;
			fullRenderer.toneMappingExposure = slimRenderer.toneMappingExposure;
			fullRenderer.outputColorSpace = slimRenderer.outputColorSpace;
		} catch ( _ ) {}
		if ( ! useSlimEffectReplay ) try {
			const size = slimRenderer.getDrawingBufferSize( __fullRTTSize );
			if ( typeof fullRenderer.setSize === 'function' ) fullRenderer.setSize( size.width, size.height, false );
		} catch ( _ ) {}
		if ( effectName === 'GodraysNode' || effectName === 'FSR1Node' ) {
			try {
				for ( const passNode of context && context.passNodes || [] ) {
					if ( __renderPassNodeWithFullRenderer( passNode, slimRenderer, fullRenderer, passNode && passNode.camera, { force: true } ) ) {
						const key = effectName === 'GodraysNode' ? 'godraysFullPassRenders' : 'fsrFullPassRenders';
						diag[ key ] = ( diag[ key ] || 0 ) + 1;
					}
				}
			} catch ( _ ) {}
		}
		const lensflareInputTexture = __retargetLensflareInputTexture( node );
		const nestedFullOwnedTextures = useSlimEffectReplay
			? new Set()
			: __collectNestedFrameEffectOwnedRenderTargetTextures( node );
		if ( ! useSlimEffectReplay ) __shareGraphTexturesBetweenRenderers( fullRenderer, slimRenderer, node, {
			skipOwnedRenderTargets: true,
			skipTextures: nestedFullOwnedTextures,
		} );
		if ( ! useSlimEffectReplay && lensflareInputTexture ) __shareGPUTextureEntry( fullRenderer, slimRenderer, lensflareInputTexture );
		try {
			if ( node._material ) node._material.needsUpdate = true;
			if ( node._resolveMaterial ) node._resolveMaterial.needsUpdate = true;
		} catch ( _ ) {}
			const effectFrame = __createFrameEffectNodeFrame( effectRenderer, context, scheduledNodeFrame );
			const beforeResourceRefresh = __sharedRefreshPreparedPostprocessResources( node, {
				phase: 'before-update',
				frame: effectFrame,
				passNodes: context && context.passNodes || [],
			} );
			if ( beforeResourceRefresh.ready !== true ) {
				throw new Error( 'Postprocess resource refresh failed before update: ' + beforeResourceRefresh.reasons.join( '; ' ) );
			}
			const runUpdate = () => __runGaussianUpdateWithFrameTextureDiagnostics(
				node,
				effectRenderer,
				effectName,
				() => __invokeFrameEffectUpdateBefore( node, effectFrame ),
			);
			if ( node.scene ) __withSourceMaterialsForFullPass( node.scene, runUpdate );
			else runUpdate();
			if ( ! useSlimEffectReplay ) {
				for ( const texture of nestedFullOwnedTextures ) {
					__shareGPUTextureEntry( slimRenderer, fullRenderer, texture, { bumpVersion: false } );
				}
			}
			const afterResourceRefresh = __sharedRefreshPreparedPostprocessResources( node, {
				phase: 'after-update',
				frame: effectFrame,
				passNodes: context && context.passNodes || [],
			} );
			if ( afterResourceRefresh.ready !== true ) {
				throw new Error( 'Postprocess resource refresh failed after update: ' + afterResourceRefresh.reasons.join( '; ' ) );
			}
		__neutralizeFrameEffectNodeUpdateBefore( node );
		try {
			const forceFrameEffectReadback = effectName === 'GodraysNode'
				|| ( effectName === 'BilateralBlurNode' && node.textureNode && node.textureNode.value && node.textureNode.value.name === 'Godrays' );
			const centerFrameEffectReadback = effectName === 'GaussianBlurNode';
			__probeFrameEffectTextureAsync( effectRenderer, node._godraysRenderTarget && node._godraysRenderTarget.texture, effectName + '.godrays', { force: effectName === 'GodraysNode' } );
			__probeFrameEffectTextureAsync( effectRenderer, node.textureNode && node.textureNode.value, effectName + '.input', { force: forceFrameEffectReadback, center: centerFrameEffectReadback } );
			__probeFrameEffectTextureAsync( effectRenderer, node._renderTarget && node._renderTarget.texture, effectName + '.output' );
			__probeFrameEffectTextureAsync( effectRenderer, node._horizontalRT && node._horizontalRT.texture, effectName + '.horizontal', { force: forceFrameEffectReadback, center: centerFrameEffectReadback } );
			__probeFrameEffectTextureAsync( effectRenderer, node._verticalRT && node._verticalRT.texture, effectName + '.vertical', { force: forceFrameEffectReadback, center: centerFrameEffectReadback } );
		} catch ( _ ) {}
		if ( ! useSlimEffectReplay ) {
			__shareDirectOwnedRenderTargetTexturesBetweenRenderers( slimRenderer, fullRenderer, node );
			__recordGaussianTextureShareDiagnostics( node, slimRenderer, fullRenderer, effectName );
		}
		diag.rendered ++;
		if ( useSlimEffectReplay ) {

			const sssDiag = diag.sss || ( diag.sss = { prepared: 0, renderedPrecompiled: 0, missed: 0 } );
			sssDiag.renderedPrecompiled ++;

		}
		if ( scheduledNodeFrame === null || effectName === 'GodraysNode' ) {
			try { Object.defineProperty( node, '__tslpFrameEffectRenderedOnce', { value: true, configurable: true } ); } catch ( _ ) {}
		}
		if ( diag.names.length < 20 ) diag.names.push( effectName );
		return true;
	} catch ( err ) {
		diag.failed ++;
		if ( ! window.__tslpFrameEffectRenderWarned ) {
			window.__tslpFrameEffectRenderWarned = true;
			console.warn( '[tslp-e2e] postprocess effect render failed:', err && ( err.stack || err.message ) || err );
		}
		return false;
	}
}

function __renderFrameEffectNodesForPipeline( renderer, effectNodes, context, schedule = null, role = null, dependenciesFor = null, inputRTTProducersForEffect = null ) {
	try {
		const diag = __frameEffectDiagnostics();
		diag.collected += effectNodes && effectNodes.length || 0;
	} catch ( _ ) {}
	let succeeded = true;
	for ( const node of effectNodes || [] ) {
		const inputRTTs = __renderFrameEffectInputRTTProducersForPipeline(
			renderer,
			node,
			schedule,
			inputRTTProducersForEffect,
		);
		const render = ( nodeFrame = null ) => __renderFrameEffectNodeWithFullRenderer( node, renderer, __computeRenderer, context, nodeFrame );
		const result = schedule && role
			? schedule.run( node, role, render, {
				dependsOn: Array.from( new Set( [
					...( typeof dependenciesFor === 'function' ? dependenciesFor( node ) : [] ),
					...inputRTTs.producers,
				] ) ),
			} )
			: inputRTTs.succeeded ? render() : false;
		if ( result === false ) succeeded = false;
	}
	return succeeded;
}

function __findUserArtifactByMaterialShape( shape ) {
	if ( ! shape || ! __data || ! __data.user ) return null;
	for ( const mod of Object.values( __data.user ) ) {
		const artifact = mod && mod.artifact;
		if ( artifact && artifact.materialShape === shape ) return artifact;
	}
	return null;
}


function __collectScenePassNodes( scene ) {
	const out = [];
	if ( ! scene || typeof scene.traverse !== 'function' ) return out;
	scene.traverse( ( object ) => {
		const material = object && object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const m of list ) {
			if ( ! m ) continue;
			for ( const key of __nodeGraphKeys() ) __collectPassNodesInGraph( m[ key ], out );
		}
	} );
	return out;
}

function __collectSceneRTTNodes( scene ) {
	const out = [];
	if ( ! scene || typeof scene.traverse !== 'function' ) return out;
	scene.traverse( ( object ) => {
		const material = object && object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const m of list ) {
			if ( ! m ) continue;
			for ( const key of __nodeGraphKeys() ) __collectRTTNodesInGraph( m[ key ], out );
		}
	} );
	return out;
}

function __collectSceneFrameEffectNodes( scene ) {
	const out = [];
	if ( ! scene || typeof scene.traverse !== 'function' ) return out;
	scene.traverse( ( object ) => {
		const material = object && object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const m of list ) {
			if ( ! m ) continue;
			for ( const key of __nodeGraphKeys() ) __collectFrameEffectNodesInGraph( m[ key ], out );
		}
	} );
	return out;
}

function __graphContainsNode( root, target, seen = new Set(), depth = 0 ) {
	if ( ! root || ! target || depth > 32 || seen.has( root ) ) return false;
	if ( root === target ) return true;
	if ( ! __isGraphTraversalCandidate( root ) ) return false;
	seen.add( root );
	for ( const dependency of __sharedGetLiveNodeDependencies( root ) ) {
		if ( __graphContainsNode( dependency.node, target, seen, depth + 1 ) ) return true;
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( root ) ); } catch ( _ ) { return false; }
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( root, key );
		if ( ! child ) continue;
		if ( child === target ) return true;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) {
				if ( item && ( typeof item === 'object' || typeof item === 'function' ) && __graphContainsNode( item, target, seen, depth + 1 ) ) return true;
			}
		} else if ( ( typeof child === 'object' || typeof child === 'function' ) && __graphContainsNode( child, target, seen, depth + 1 ) ) {
			return true;
		}
	}
	return false;
}

function __sameNodeSet( first, second ) {
	const a = Array.isArray( first ) ? first : [];
	const b = Array.isArray( second ) ? second : [];
	return a.length === b.length && a.every( ( node ) => b.includes( node ) );
}

function __renderBloomNodeOnceForPipeline( renderer, bloomNode, renderedBloomNodes, context, schedule = null ) {
	if ( ! bloomNode || renderedBloomNodes.has( bloomNode ) ) return true;
	const render = ( nodeFrame = null ) => {
		if ( ! __prepareBloomNodeForReplay( bloomNode, context || null ) ) return false;
		const updateBefore = bloomNode.__tslpBloomReplayUpdateBefore || bloomNode.updateBefore;
		if ( typeof updateBefore === 'function' ) updateBefore.call( bloomNode, nodeFrame || { renderer } );
		__neutralizeBloomNodeAutoUpdate( bloomNode );
		return true;
	};
	const result = schedule
		? schedule.run( bloomNode, __POSTPROCESS_FRAME_ROLES.EFFECT, render )
		: render();
	if ( result !== false ) renderedBloomNodes.add( bloomNode );
	return result !== false;
}

function __neutralizeBloomNodeAutoUpdate( bloomNode ) {
	if ( ! bloomNode || bloomNode.__tslpBloomUpdateNeutered === true ) return;
	try { bloomNode.updateBefore = function () {}; } catch ( _ ) {}
	try { Object.defineProperty( bloomNode, '__tslpBloomUpdateNeutered', { value: true, configurable: true } ); } catch ( _ ) {}
}

function __markBloomForSlimReplay( bloomNode ) {
	if ( ! bloomNode || bloomNode.__tslpPreferSlimBloomReplay === true ) return;
	try {
		Object.defineProperty( bloomNode, '__tslpPreferSlimBloomReplay', {
			value: true,
			configurable: true,
			writable: true,
		} );
	} catch ( _ ) {
		bloomNode.__tslpPreferSlimBloomReplay = true;
	}
}

function __renderOutputFrameEffectsAndBloomForPipeline( renderer, effectNodes, bloomNodes, context, rttNodes = [], schedule = null, dependencyEffectNodes = effectNodes, effectDependenciesForRTT = null, inputRTTProducersForEffect = null ) {
	const renderedBloomNodes = new Set();
	const allEffectNodes = Array.from( new Set( [ ...( dependencyEffectNodes || [] ), ...( effectNodes || [] ) ] ) );
	const inputRTTProducerNodes = new Set(
		allEffectNodes.flatMap( ( effectNode ) => __frameEffectInputRTTProducers( effectNode, inputRTTProducersForEffect ) ),
	);
	const renderedEffectNodes = new Set( allEffectNodes.filter( ( effectNode ) => schedule && schedule.hasSucceeded( effectNode ) ) );
	const renderedDependentRTTNodes = new Set();
	let succeeded = true;
	const resolveEffectDependenciesForRTT = ( rttNode ) => {
		const dependencies = typeof effectDependenciesForRTT === 'function'
			? effectDependenciesForRTT( rttNode )
			: __effectDependenciesForRTT( rttNode, allEffectNodes );
		return ( dependencies || [] ).filter( ( effectNode ) => allEffectNodes.includes( effectNode ) );
	};
	const bloomReadyRTTNodes = () => ( rttNodes || [] ).filter( ( rttNode ) => {
		if ( inputRTTProducerNodes.has( rttNode ) ) return false;
		const dependencies = resolveEffectDependenciesForRTT( rttNode );
		return dependencies.every( ( effectNode ) => renderedEffectNodes.has( effectNode ) );
	} );
	const renderReadyEffectRTTNodes = () => {
		const ready = [];
		for ( const rttNode of rttNodes || [] ) {
			if ( inputRTTProducerNodes.has( rttNode ) ) continue;
			if ( renderedDependentRTTNodes.has( rttNode ) ) continue;
			const dependencies = resolveEffectDependenciesForRTT( rttNode );
			if ( dependencies.length === 0 || ! dependencies.every( ( effectNode ) => renderedEffectNodes.has( effectNode ) ) ) continue;
			ready.push( rttNode );
		}
		if ( ready.length === 0 ) return;
		const rendered = __renderRTTNodesForPipeline(
			renderer,
			ready,
			schedule,
			__POSTPROCESS_FRAME_ROLES.CONSUMER,
			resolveEffectDependenciesForRTT,
		);
		if ( rendered === false ) succeeded = false;
		for ( const rttNode of ready ) {
			if ( ! schedule || schedule.hasSucceeded( rttNode, __POSTPROCESS_FRAME_ROLES.CONSUMER ) ) renderedDependentRTTNodes.add( rttNode );
		}
	};
	try {
		const diag = __frameEffectDiagnostics();
		diag.collected += effectNodes && effectNodes.length || 0;
	} catch ( _ ) {}
	renderReadyEffectRTTNodes();
	for ( const effectNode of effectNodes || [] ) {
		let renderedBloomForEffect = false;
		for ( const bloomNode of bloomNodes || [] ) {
			if ( __graphContainsNode( effectNode, bloomNode ) ) {
				renderedBloomForEffect = __renderBloomNodeOnceForPipeline( renderer, bloomNode, renderedBloomNodes, context, schedule ) || renderedBloomForEffect;
			}
		}
		if ( renderedBloomForEffect ) __renderBloomDependentRTTNodesForPipeline( renderer, bloomReadyRTTNodes(), bloomNodes, schedule );
		const inputRTTs = __renderFrameEffectInputRTTProducersForPipeline(
			renderer,
			effectNode,
			schedule,
			inputRTTProducersForEffect,
		);
		const render = ( nodeFrame = null ) => __renderFrameEffectNodeWithFullRenderer( effectNode, renderer, __computeRenderer, context, nodeFrame );
		const rendered = schedule
			? schedule.run( effectNode, __POSTPROCESS_FRAME_ROLES.EFFECT, render, { dependsOn: inputRTTs.producers } )
			: inputRTTs.succeeded ? render() : false;
		if ( rendered === false ) succeeded = false;
		else renderedEffectNodes.add( effectNode );
		renderReadyEffectRTTNodes();
	}
	renderReadyEffectRTTNodes();
	for ( const bloomNode of bloomNodes || [] ) {
		if ( ! __renderBloomNodeOnceForPipeline( renderer, bloomNode, renderedBloomNodes, context, schedule ) ) succeeded = false;
	}
	if ( renderedBloomNodes.size > 0 ) __renderBloomDependentRTTNodesForPipeline( renderer, bloomReadyRTTNodes(), bloomNodes, schedule );
	return succeeded;
}

// RenderPipeline (and PostProcessing which extends it) calls ng("post-process", ...)
// from its _update() method — the same dual-registry problem as _renderOutput.
// Override _update to pre-set _quadMesh.material from Slim.loadAux before ng fires.
export class RenderPipeline extends Slim.RenderPipeline {
	constructor( ...args ) {
		super( ...args );
		this.__tslpPostprocessFrameScheduler = __sharedCreatePostprocessFrameScheduler( this );
		try {
			const diag = __frameEffectDiagnostics();
			diag.pipelineConstructed = ( diag.pipelineConstructed || 0 ) + 1;
		} catch ( _ ) {}
	}
	render( ...args ) {
		try {
			const diag = __frameEffectDiagnostics();
			diag.pipelineRenderCalls = ( diag.pipelineRenderCalls || 0 ) + 1;
			if ( __debugReplayOperations ) {
				const frames = diag.pipelineFrameIdentities || ( diag.pipelineFrameIdentities = [] );
				if ( frames.length < 32 ) {
					const inherited = __sharedGetTemporalFrameState( this.renderer );
					frames.push( {
						observedFrameId: __frameEffectFrameId(),
						inheritedFrameId: inherited && inherited.frameId,
						inheritedRenderId: inherited && inherited.renderId,
						callbackCount: window.__tslpFrameCallbackCount | 0,
						animationLoopCalls: window.__tslpAnimationLoopCalls | 0,
						renderableObjectCount: window.__tslpRenderableObjectCount | 0,
						loaderPending: window.__tslpLoaderPending | 0,
					} );
				}
			}
		} catch ( _ ) {}
			const renderer = this.renderer;
			const previousRenderPipeline = renderer ? renderer.__tslpCurrentRenderPipeline : null;
			const previousFallbackRenderPipeline = __computeRenderer ? __computeRenderer.__tslpCurrentRenderPipeline : null;
			if ( renderer ) renderer.__tslpInsideRenderPipeline = ( renderer.__tslpInsideRenderPipeline | 0 ) + 1;
			if ( renderer ) renderer.__tslpCurrentRenderPipeline = this;
			if ( __computeRenderer ) __computeRenderer.__tslpCurrentRenderPipeline = this;
			try { window.__tslpLastRenderPipeline = this; } catch ( _ ) {}
			try {
				const inheritedTemporalFrame = __sharedGetTemporalFrameState( renderer );
				const temporalFrame = inheritedTemporalFrame || {
					frameId: __frameEffectFrameId(),
					renderId: __frameEffectFrameId(),
					time: Number.isFinite( globalThis.__tslpPinnedClock ) ? globalThis.__tslpPinnedClock : null,
					advance: true,
				};
				return __sharedWithTemporalFrame( [ renderer, __computeRenderer ], temporalFrame, () => super.render( ...args ) );
			} finally {
			if ( renderer ) renderer.__tslpInsideRenderPipeline = Math.max( 0, ( renderer.__tslpInsideRenderPipeline | 0 ) - 1 );
			if ( renderer ) renderer.__tslpCurrentRenderPipeline = previousRenderPipeline;
			if ( __computeRenderer ) __computeRenderer.__tslpCurrentRenderPipeline = previousFallbackRenderPipeline;
		}
	}
	_update() {
		// Sync renderer state flags (mirrors parent logic) so needsUpdate can
		// be suppressed once we've pre-populated the material.
		if ( this._toneMapping !== this.renderer.toneMapping ) {
			this._toneMapping = this.renderer.toneMapping;
			this.needsUpdate = true;
		}
		if ( this._outputColorSpace !== this.renderer.outputColorSpace ) {
			this._outputColorSpace = this.renderer.outputColorSpace;
			this.needsUpdate = true;
		}
		if ( this.needsUpdate ) {
			try {
				// The post-process capture is now the real RenderPipeline material,
				// including Three's implicit output transform when enabled.
				const shape = 'post-process';
				let artifact = null;
				let auxError = null;
				let usedUserPipelineArtifact = false;
				const boundPostprocessConfigHash = this.outputNode &&
					typeof this.outputNode.__tslpAuxConfigHash === 'string' &&
					this.outputNode.__tslpAuxConfigHash.length > 0
					? this.outputNode.__tslpAuxConfigHash
					: null;
				const metadataEntry = __selectReplayPostprocessAuxEntry( __data.aux, {
					configHash: boundPostprocessConfigHash,
					outputColorTransform: this.outputColorTransform === true,
					toneMapping: this._toneMapping,
					outputColorSpace: this._outputColorSpace,
					logarithmicDepthBuffer: this.renderer && this.renderer.logarithmicDepthBuffer === true,
					reversedDepthBuffer: this.renderer && this.renderer.reversedDepthBuffer === true,
				} );
				usedUserPipelineArtifact = !! ( boundPostprocessConfigHash && metadataEntry );
				try {
					artifact = metadataEntry && metadataEntry.artifact || Slim.loadAux( shape, 'tslp-e2e-bypass' );
				} catch ( err ) {
					auxError = err;
				}
				if ( ! artifact ) throw auxError || new Error( 'no ' + shape + ' artifact available' );
				artifact = __cloneAuxArtifact( artifact );
				artifact = __patchVolumeRenderOutputAlpha( artifact );
				const passNodes = __collectPassNodesInGraph( this.outputNode );
				__appendLivePassNodesForArtifact( passNodes, artifact );
				const rttNodes = __collectRTTNodesInGraph( this.outputNode );
				const passEffectNodes = [];
				for ( const node of passNodes ) __collectFrameEffectNodesInGraph( node, passEffectNodes );
				const outputEffectNodes = __collectFrameEffectNodesInGraph( this.outputNode ).filter( ( node ) => ! passEffectNodes.includes( node ) );
				const effectNodes = [ ...passEffectNodes, ...outputEffectNodes ];
				const passExecutionPlan = __sharedCreatePostprocessExecutionPlan( {
					passNodes,
					outputNode: this.outputNode,
				} );
				try {
					const fxDiag = __frameEffectDiagnostics();
					fxDiag.pipelineUpdates = ( fxDiag.pipelineUpdates || 0 ) + 1;
					fxDiag.pipelineShape = shape;
					fxDiag.usedUserPipelineArtifact = usedUserPipelineArtifact;
					fxDiag.passNodes = ( fxDiag.passNodes || 0 ) + passNodes.length;
					fxDiag.passContextEffects = ( fxDiag.passContextEffects || 0 ) + passEffectNodes.length;
					fxDiag.outputEffects = ( fxDiag.outputEffects || 0 ) + outputEffectNodes.length;
				} catch ( _ ) {}
					const bloomNodes = __collectBloomNodesInGraph( this.outputNode );
					__bloomDiagnostics().collected += bloomNodes.length;
					const traaNodes = __collectTRAANodesInGraph( this.outputNode );
					__traaDiagnostics().collected += traaNodes.length;
					const outputAndTerminalEffectNodes = Array.from( new Set( [ ...effectNodes, ...traaNodes ] ) );
					const inputRTTProducersByEffect = new Map( outputAndTerminalEffectNodes.map( ( effectNode ) => [
						effectNode,
						__selectFrameEffectInputRTTProducers( effectNode ),
					] ) );
					const stableInputRTTProducersForEffect = ( effectNode ) => inputRTTProducersByEffect.get( effectNode ) || [];
					const inputRTTProducerNodes = new Set( Array.from( inputRTTProducersByEffect.values() ).flat() );
					const schedulableRTTNodes = rttNodes.filter( ( rttNode ) => ! inputRTTProducerNodes.has( rttNode ) );
					const effectDependenciesByRTT = new Map( rttNodes.map( ( rttNode ) => [
						rttNode,
						__effectDependenciesForRTT( rttNode, outputAndTerminalEffectNodes ),
					] ) );
					const stableEffectDependenciesForRTT = ( rttNode ) => effectDependenciesByRTT.get( rttNode ) || [];
					const outputEffectTRAAOrder = __partitionPostprocessNodesByDependency( outputEffectNodes, traaNodes );
					const bloomTRAAOrder = __partitionPostprocessNodesByDependency( bloomNodes, traaNodes );
					const rttTRAAOrder = __partitionPostprocessNodesByDependency( schedulableRTTNodes, traaNodes );
					const preTRAAOutputEffectNodes = outputEffectTRAAOrder.independent;
					const postTRAAOutputEffectNodes = outputEffectTRAAOrder.dependent;
					const preTRAABloomNodes = bloomTRAAOrder.independent;
					const postTRAABloomNodes = bloomTRAAOrder.dependent;
					const preBloomRTTNodes = __filterRTTNodesByBloomDependency( schedulableRTTNodes, bloomNodes, false );
					const preTRAARTTNodes = preBloomRTTNodes.filter( ( rttNode ) => rttTRAAOrder.independent.includes( rttNode ) );
					const preEffectRTTNodes = preTRAARTTNodes.filter( ( rttNode ) => stableEffectDependenciesForRTT( rttNode ).every( ( effectNode ) => ! effectNodes.includes( effectNode ) ) );
					const preTRAAEffectDependentRTTNodes = rttTRAAOrder.independent.filter( ( rttNode ) => stableEffectDependenciesForRTT( rttNode ).some( ( effectNode ) => effectNodes.includes( effectNode ) ) );
					try {
						const rttDiag = __harnessDiagnostics();
						rttDiag.rtt = rttDiag.rtt || { collected: 0, rendered: 0, failed: 0 };
						rttDiag.rtt.inputProducerRTTs = inputRTTProducerNodes.size;
						rttDiag.rtt.bloomDependentDeferred = schedulableRTTNodes.length - preBloomRTTNodes.length;
						rttDiag.rtt.traaDependentDeferred = rttTRAAOrder.dependent.length;
						rttDiag.rtt.effectDependentDeferred = preTRAARTTNodes.length - preEffectRTTNodes.length;
					} catch ( _ ) {}
					const outlineNodes = __collectOutlineNodesInGraph( this.outputNode );
				__outlineDiagnostics().collected += outlineNodes.length;
				const ssrNodes = __collectSSRNodesInGraph( this.outputNode );
				__ssrDiagnostics().collected += ssrNodes.length;
				const dofNodes = __collectDOFNodesInGraph( this.outputNode );
				__dofDiagnostics().collected += dofNodes.length;
				try {
					window.__tslpDebugPipelineNodes = Array.from( new Set( [
						...passNodes,
						...rttNodes,
						...effectNodes,
						...bloomNodes,
						...outlineNodes,
						...ssrNodes,
						...dofNodes,
						...traaNodes,
					] ) );
				} catch ( _ ) {}
				const plannedPassEffects = passExecutionPlan.contextEffects.map( ( match ) => match.node );
				const plannedTRAANodes = passExecutionPlan.terminalEffects
					.filter( ( match ) => match.handler && match.handler.name === 'traa' )
					.map( ( match ) => match.node );
				const usePlannedPassWave = passExecutionPlan.supported
					&& __sameNodeSet( passEffectNodes, plannedPassEffects )
					&& __sameNodeSet( traaNodes, plannedTRAANodes );
				const passInputNodes = usePlannedPassWave ? passExecutionPlan.producerPasses : passNodes;
				const passConsumerNodes = usePlannedPassWave
					? passExecutionPlan.consumerPasses
					: passEffectNodes.length > 0 ? passNodes : [];
				try {
					const fxDiag = __frameEffectDiagnostics();
					fxDiag.executionPlan = {
						mode: passExecutionPlan.mode,
						supported: passExecutionPlan.supported,
						used: usePlannedPassWave,
						producerPasses: passInputNodes.length,
						consumerPasses: passConsumerNodes.length,
						issues: passExecutionPlan.issues,
					};
				} catch ( _ ) {}
				const passNode = passNodes[ 0 ] || null;
				const context = {
					renderPipeline: this,
					passNodes,
					onBeforeRenderPipeline: null,
					onAfterRenderPipeline: null,
				};
				if ( this.outputColorTransform !== true ) {
					context.toneMapping = this._toneMapping;
					context.outputColorSpace = this._outputColorSpace;
				}
				this._context = context;
				for ( const node of passNodes ) __preparePassNodeForReplay( this.renderer, node );
				for ( const node of passNodes ) {
					try {
						if ( traaNodes.length > 0 ) Object.defineProperty( node, '__tslpFeedsTRAA', { value: true, configurable: true, writable: true } );
					} catch ( _ ) {
						node.__tslpFeedsTRAA = traaNodes.length > 0;
					}
					}
					for ( const node of passNodes ) __syncPassRenderTargetTextures( node, node && node._mrt || null );
					for ( const node of effectNodes ) __prepareFrameEffectNodeForReplay( node, __computeRenderer, context );
					__prepareHiddenFrameEffectDependenciesForReplay(
						effectNodes,
						__computeRenderer,
						context,
						stableInputRTTProducersForEffect,
					);
					for ( const node of bloomNodes ) {
						__prepareBloomNodeForReplay( node, context );
						// RenderPipeline owns the producer/effect ordering below.
						// Prevent Three's automatic NodeFrame update from running
						// Bloom once before pass textures and selector identities
						// have reached that schedule; the saved replay hook remains
						// available to __renderBloomNodeOnceForPipeline().
						__neutralizeBloomNodeAutoUpdate( node );
					}
				for ( const node of outlineNodes ) __prepareOutlineNodeForReplay( node, context );
				for ( const node of ssrNodes ) __prepareSSRNodeForReplay( node, context );
				for ( const node of dofNodes ) __prepareDOFNodeForReplay( node, context );
				for ( const node of traaNodes ) __prepareTRAANodeForReplay( node, context );
					const effectBeforeRenderPipeline = context.onBeforeRenderPipeline;
					const effectAfterRenderPipeline = context.onAfterRenderPipeline;
					let replayPipelineFrameActive = false;
					const replayAfterRenderPipeline = typeof effectAfterRenderPipeline === 'function'
						? () => {
							if ( replayPipelineFrameActive !== true ) return;
							replayPipelineFrameActive = false;
							try {
								return effectAfterRenderPipeline();
							} finally {
								context.onBeforeRenderPipeline = replayBeforeRenderPipeline;
								context.onAfterRenderPipeline = replayAfterRenderPipeline;
							}
						}
						: null;
					const contextEffectMatchByNode = new Map( passExecutionPlan.contextEffects.map( ( match ) => [ match.node, match ] ) );
					const producerDependenciesForEffect = ( effectNode ) => {
						const match = contextEffectMatchByNode.get( effectNode );
						return match ? match.producerPasses : [];
					};
					const effectDependenciesForConsumer = ( passNode ) => passExecutionPlan.contextEffects
						.filter( ( match ) => match.consumerPasses.includes( passNode ) )
						.map( ( match ) => match.node );
				artifact = __attachGraphTextureRefs( artifact, this.outputNode );
				artifact = __attachOrderedPassOutputRefs( artifact, passNodes );
				artifact = __attachOrderedPassDepthRefs( artifact, passNodes );
				artifact = __attachPassTextureRefs( artifact, passNodes.length === 1 ? passNode : null );
				artifact = __attachRTTTextureRefs( artifact, rttNodes );
				artifact = __attachOutlineCompositeTextureRefs( artifact, outlineNodes, passNodes );
					artifact = __attachBloomCompositeTextureRefs( artifact, bloomNodes );
					artifact = __patchRetroRenderOutputBarrelUV( artifact, passNodes );
					let mat = new Slim.PrecompiledMaterial( artifact );
					__configureRenderPipelineQuadMaterial( mat );
					__attachRenderPipelineCameraTarget( mat, passNode );
				mat.needsUpdate = true;
					this._quadMesh.material = mat;
					this._quadMesh.frustumCulled = false;
				// Set up _context so render() can access onBefore/onAfterRenderPipeline.
					let replayBeforeRenderPipeline = null;
					context.onBeforeRenderPipeline = ( passNodes.length > 0 || rttNodes.length > 0 || effectNodes.length > 0 || bloomNodes.length > 0 || outlineNodes.length > 0 || ssrNodes.length > 0 || dofNodes.length > 0 || traaNodes.length > 0 ) ? ( replayBeforeRenderPipeline = () => {
						if ( __shouldDeferReplayPostprocessForLoader( {
							loaderPending: window.__tslpLoaderPending | 0,
						} ) ) {
							try {
								const diag = __frameEffectDiagnostics();
								diag.loaderDeferredPipelineFrames = ( diag.loaderDeferredPipelineFrames | 0 ) + 1;
							} catch ( _ ) {}
							this.renderer.__tslpPostprocessPresentationDeferred = true;
							__sharedMarkPresentationDeferred( __presentationReadiness );
							context.onBeforeRenderPipeline = replayBeforeRenderPipeline;
							context.onAfterRenderPipeline = replayAfterRenderPipeline;
							return;
						}
						this.renderer.__tslpPostprocessPresentationDeferred = false;
						replayPipelineFrameActive = true;
						const pipelineRenderTarget = typeof this.renderer.getRenderTarget === 'function' ? this.renderer.getRenderTarget() : null;
						const pipelineMRT = typeof this.renderer.getMRT === 'function' ? this.renderer.getMRT() : null;
						const frameSchedule = this.__tslpPostprocessFrameScheduler.begin( this.renderer, { context } );
						const previousPresentationSchedule = this.renderer.__tslpCurrentPostprocessFrameSchedule || null;
						const previousFallbackSchedule = __computeRenderer && __computeRenderer.__tslpCurrentPostprocessFrameSchedule || null;
						this.renderer.__tslpCurrentPostprocessFrameSchedule = frameSchedule;
						if ( __computeRenderer ) __computeRenderer.__tslpCurrentPostprocessFrameSchedule = frameSchedule;
							try {
							if ( typeof effectBeforeRenderPipeline === 'function' ) effectBeforeRenderPipeline();
							__renderPassNodesForPipeline(
								this.renderer,
								passInputNodes,
								usePlannedPassWave ? frameSchedule : null,
								__POSTPROCESS_FRAME_ROLES.PRODUCER,
							);
							__renderRTTNodesForPipeline( this.renderer, preEffectRTTNodes, frameSchedule, __POSTPROCESS_FRAME_ROLES.PRODUCER );
					artifact = __attachGraphTextureRefs( artifact, this.outputNode );
					artifact = __attachOrderedPassOutputRefs( artifact, passNodes );
					artifact = __attachOrderedPassDepthRefs( artifact, passNodes );
						artifact = __attachPassTextureRefs( artifact, passNodes.length === 1 ? passNode : null );
						artifact = __attachRTTTextureRefs( artifact, rttNodes );
						artifact = __attachOutlineCompositeTextureRefs( artifact, outlineNodes, passNodes );
						artifact = __attachBloomCompositeTextureRefs( artifact, bloomNodes );
						artifact = __patchRetroRenderOutputBarrelUV( artifact, passNodes );
						mat.precompiledArtifact = artifact;
						mat.needsUpdate = true;
						try { mat.dispose && mat.dispose(); } catch ( _ ) {}
						try {
							const nc = this.renderer && this.renderer._nodes && this.renderer._nodes.nodeBuilderCache;
							if ( nc && typeof nc.clear === 'function' ) nc.clear();
						} catch ( _ ) {}
						__renderFrameEffectNodesForPipeline(
							this.renderer,
							passEffectNodes,
							context,
							frameSchedule,
							usePlannedPassWave ? __POSTPROCESS_FRAME_ROLES.CONTEXT_EFFECT : __POSTPROCESS_FRAME_ROLES.EFFECT,
							usePlannedPassWave ? producerDependenciesForEffect : null,
							stableInputRTTProducersForEffect,
						);
						if ( passConsumerNodes.length > 0 ) __renderPassNodesForPipeline(
							this.renderer,
							passConsumerNodes,
							usePlannedPassWave ? frameSchedule : null,
							__POSTPROCESS_FRAME_ROLES.CONSUMER,
							effectDependenciesForConsumer,
						);
						__renderOutputFrameEffectsAndBloomForPipeline(
							this.renderer,
							preTRAAOutputEffectNodes,
							preTRAABloomNodes,
							context,
							schedulableRTTNodes,
							frameSchedule,
							outputAndTerminalEffectNodes,
							stableEffectDependenciesForRTT,
							stableInputRTTProducersForEffect,
						);
					__renderOutlineNodesForPipeline( this.renderer, outlineNodes );
					// Wave 5 Phase A3: keep SSR behind the WIP gate. DOF must dispatch
					// here so the final artifact samples a rendered composite RT instead
					// of the DepthOfFieldNode's lazily-constructed 1x1 placeholder.
						const traaDependencies = Array.from( new Set( [
							...preTRAAOutputEffectNodes,
							...preTRAAEffectDependentRTTNodes,
							...( usePlannedPassWave ? passConsumerNodes : [] ),
						] ) );
						__renderTRAANodesForPipeline( this.renderer, traaNodes, passNodes, frameSchedule, traaDependencies );
					__renderDOFNodesForPipeline( this.renderer, dofNodes );
					if ( typeof globalThis !== 'undefined' && globalThis.__tslpEnableWipPostprocessFallbacks === true ) {
						__renderSSRNodesForPipeline( this.renderer, ssrNodes );
					}
						__renderOutputFrameEffectsAndBloomForPipeline(
							this.renderer,
							postTRAAOutputEffectNodes,
							postTRAABloomNodes,
							context,
							schedulableRTTNodes,
							frameSchedule,
							outputAndTerminalEffectNodes,
							stableEffectDependenciesForRTT,
							stableInputRTTProducersForEffect,
						);
							if ( outputEffectNodes.length > 0 || bloomNodes.length > 0 ) {
								artifact = __attachGraphTextureRefs( artifact, this.outputNode );
								artifact = __attachRTTTextureRefs( artifact, rttNodes );
								artifact = __attachOutlineCompositeTextureRefs( artifact, outlineNodes, passNodes );
								artifact = __attachBloomCompositeTextureRefs( artifact, bloomNodes );
							const previousMaterial = mat;
							mat = new Slim.PrecompiledMaterial( artifact );
							__configureRenderPipelineQuadMaterial( mat );
							__attachRenderPipelineCameraTarget( mat, passNode );
							mat.needsUpdate = true;
							this._quadMesh.material = mat;
						try { previousMaterial && previousMaterial.dispose && previousMaterial.dispose(); } catch ( _ ) {}
						try {
							const nc = this.renderer && this.renderer._nodes && this.renderer._nodes.nodeBuilderCache;
							if ( nc && typeof nc.clear === 'function' ) nc.clear();
						} catch ( _ ) {}
					}
					if ( outlineNodes.length > 0 ) {
						// Re-attach graph texture refs so the slim post-process artifact
						// sees the freshly-shared _renderTargetComposite.texture from the
						// full-renderer pass.
						artifact = __attachGraphTextureRefs( artifact, this.outputNode );
						artifact = __attachOutlineCompositeTextureRefs( artifact, outlineNodes, passNodes );
						__refreshPipelineMaterialArtifact( this.renderer, mat, artifact );
					}
					if ( ssrNodes.length > 0 || dofNodes.length > 0 || traaNodes.length > 0 ) {
						// Re-attach graph texture refs so the slim post-process artifact
						// sees the freshly-shared output textures from the full-renderer pass.
						artifact = __attachGraphTextureRefs( artifact, this.outputNode );
						__refreshPipelineMaterialArtifact( this.renderer, mat, artifact );
					}
					} finally {
						this.renderer.__tslpCurrentPostprocessFrameSchedule = previousPresentationSchedule;
						if ( __computeRenderer ) __computeRenderer.__tslpCurrentPostprocessFrameSchedule = previousFallbackSchedule;
						try { this.renderer.setRenderTarget( pipelineRenderTarget ); } catch ( _ ) {}
						try { if ( typeof this.renderer.setMRT === 'function' ) this.renderer.setMRT( pipelineMRT ); } catch ( _ ) {}
						// Full-renderer effect compilation can run setup() again.
						// Several r185 temporal nodes assign these hooks through
						// builder.context.renderPipeline, which is this same live
						// context object. Reclaim the pipeline-owned transaction
						// before RenderPipeline reads onAfter and before the next
						// application frame enters onBefore.
						context.onBeforeRenderPipeline = replayBeforeRenderPipeline;
						context.onAfterRenderPipeline = replayAfterRenderPipeline;
					}
				} ) : effectBeforeRenderPipeline;
				context.onAfterRenderPipeline = replayAfterRenderPipeline;
				this._context = context;
				this.needsUpdate = false;
				// Return early — super._update would call ng() which throws.
				return;
			} catch ( err ) {
				// No post-process artifact captured; fall through to super (will throw).
				console.warn( '[tslp-e2e] RenderPipeline._update pre-populate failed:', err && err.message || err );
			}
		}
		return super._update();
	}
}

export class PostProcessing extends RenderPipeline {}
`;

}
