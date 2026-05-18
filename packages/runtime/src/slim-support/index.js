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
	attachTextureRefsWhere,
	attachArtifactTextureRefsWhere,
} from './artifact-texture-wiring.js';

export {
	getComputeBindGroups,
	computeNodeUsesStorageTexture,
	syncComputeStorageOutputs,
	syncComputeStorageOutputsPerPass,
	pingPongInvalidate,
	shareInstancedAttributeBufferIntoSlim,
} from './compute-sync.js';

export { createFullRendererFallback } from './full-renderer-fallback.js';
export { createSlimSceneSupport, pinClock, unpinClock } from './scene-support.js';
export { setSlimRenderFallback, getSlimRenderFallback } from './render-fallback-registry.js';
export { renderPassWithFullRenderer, sharePassRenderTargetTextures } from './pass-render-fallback.js';

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

export {
	preparePrecompiledPostprocess,
	prepareEffectNodeForReplay,
	makePrecompiledAuxMaterial,
	cloneAuxArtifact,
	wireLiveNodeSidecarsToArtifact,
} from './postprocess-effects-replay.js';

export {
	getSlimDiagnosticsBag,
	isDiagnosticChannelEnabled,
	recordDiagnostic,
	resetSlimDiagnostics,
	snapshotSlimDiagnostics,
} from './diagnostics.js';
