/**
 * Stable public barrel for real-app slim runtime support.
 *
 * Importing from `@tsl-precompile/runtime/slim-support` gives adopters the
 * productized helpers for the "slim + full-renderer fallback" mode without
 * depending on individual internal file paths.
 *
 * @module SlimSupport
 */

export {
	createLiveSceneIndex,
	collectMaterialNodeTextures,
	textureImageReady,
	textureImageSrc,
	healTextureImage,
} from './live-scene-index.js';

export {
	PMREM_CUBE_UV_MAPPING,
	isCubeTextureSource,
	isEnvironmentTextureSource,
	isPMREMTexture,
	isPMREMArtifactTextureSource,
	artifactNeedsPMREM,
	artifactPMREMSourceUuids,
	attachPMREMRefsByOrder,
	collectPMREMSourceTexturesInNode,
	collectPMREMSourceTexturesFromMaterial,
	selectPMREMTexturesForArtifact,
	createPMREMSupport,
} from './pmrem.js';

export {
	clearTextureViewCache,
	invalidateTextureResourceBindings,
	isBorrowedShadowRenderTargetTexture,
	markTextureInitialized,
	shareGPUTextureEntry,
	sharePMREMGPUTexture,
	shareShadowGPUTextureIntoSlim,
} from './gpu-texture-share.js';

export {
	textureMatchesSource,
	textureMatchesArtifactSource,
	artifactHasTextureSource,
	countArtifactTextureSources,
	singleArtifactTextureUuid,
	attachArtifactTextureRefsByShapeOrder,
	attachTextureRefsWhere,
	attachArtifactTextureRefsWhere,
	attachExactMaterialGraphDepthTextureRefs,
	rewritePassDepthTextureSources,
} from './artifact-texture-wiring.js';

export {
	getComputeBindGroups,
	computeNodeUsesStorageTexture,
	computeSyncNeedsPresentation,
	hasAnonymousStorageResourceIdentity,
	invokeAlignedFullCompute,
	storageEntryAnonymousResourceIdentity,
	syncComputeRendererSize,
	shareComputeSampledInputs,
	syncComputeStorageOutputs,
	syncComputeStorageOutputsPerPass,
	wireArtifactStorageBuffersFromAttributes,
	pingPongInvalidate,
	shareInstancedAttributeBufferIntoSlim,
} from './compute-sync.js';

export {
	InternalPassBindingError,
	cloneInternalPassArtifact,
	bindInternalPassArtifact,
	createInternalPassMaterial,
} from './internal-pass.js';

export {
	AUTO_COMPUTE_MATERIAL_PROPERTIES,
	MATERIAL_COMPUTE_BINDINGS,
	AutoComputeBindingError,
	collectMaterialComputeBindings,
	collectMaterialComputeOwners,
	collectWritableComputeStorageAttributes,
	artifactHasUnwiredAnonymousComputeAttribute,
	prepareMaterialComputeAttributes,
	applyMaterialComputeAttributeBindings,
	invalidateMaterialComputeBindings,
	createAutoComputeDispatcher,
} from './auto-compute.js';

export { createFullRendererFallback } from './full-renderer-fallback.js';
export { createPrecompiledShadowSupport } from './precompiled-shadows.js';
export { createSlimSceneSupport, pinClock, unpinClock } from './scene-support.js';
export { TemporalFrameIdentityError, createTemporalNodeFrame, getTemporalFrameState, logicalFrameKey, shouldAdvanceTemporalState, withTemporalFrame } from './temporal-frame.js';
export { POSTPROCESS_FRAME_ROLES, createPostprocessFrameScheduler } from './postprocess-frame-scheduler.js';
export { attachLiveNodeDependency, getLiveNodeDependencies } from './node-dependencies.js';
export { clearLiveTextureIndex, installTextureLoaderTracking, registerLiveTexture } from '../hydrate/live-texture-registry.js';
export { collectSceneLights, updateRendererLightingForSlim, wireStorageAttributesToSceneArtifacts, wireTiledLightingTextureToScene } from './renderer-lighting.js';
export { setSlimRenderFallback, getSlimRenderFallback } from './render-fallback-registry.js';
export { renderOffscreenOverrideWithFullRenderer, renderPassWithFullRenderer, sharePassRenderTargetTextures, shareRenderTargetTextures } from './pass-render-fallback.js';
export { disposeShadowMapsWithFullRenderer, populateShadowMapsWithFullRenderer } from './shadow-fallback.js';

export {
	collectLiveBloomNodes,
	wireBloomNode,
	wirePrecompiledPostprocess,
	wireRegisteredEffectNode,
	findPostprocessAux,
} from './postprocess-wire.js';

export {
	registerEffectHandler,
	unregisterEffectHandler,
	getEffectHandlers,
	findEffectHandler,
	collectEffectNodes,
} from './postprocess-effects.js';
export { createPostprocessExecutionPlan, postprocessGraphContains } from './postprocess-execution-plan.js';

export {
	preparePrecompiledPostprocess,
	prepareEffectNodeForReplay,
	refreshPreparedPostprocessResources,
	makePrecompiledAuxMaterial,
	cloneAuxArtifact,
	wireLiveNodeSidecarsToArtifact,
	artifactLooksLikeRetroPassMaterial,
	listAux,
	findAux,
} from './postprocess-effects-replay.js';

export {
	TRAA_RESOLVE_TEXTURE_NAME,
	TRAA_HISTORY_TEXTURE_NAME,
	TRAA_HISTORY_DEPTH_TEXTURE_NAME,
	nameTRAATextures,
	collectTRAASelfTextures,
	getTRAABeautyTexture,
	getTRAAVelocityTexture,
	getTRAACurrentDepthTexture,
	wireTRAAResolveArtifact,
} from './traa-replay.js';

export {
	AFTERIMAGE_HISTORY_TEXTURE_NAME,
	AFTERIMAGE_OUTPUT_TEXTURE_NAME,
	AfterImageReplayResourceError,
	getAfterImageReplayTextures,
	prepareAfterImageReplayResources,
} from './afterimage-replay.js';

export {
	getSlimDiagnosticsBag,
	isDiagnosticChannelEnabled,
	recordDiagnostic,
	resetSlimDiagnostics,
	snapshotSlimDiagnostics,
} from './diagnostics.js';
