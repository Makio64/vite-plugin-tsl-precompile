export { installPrecompileMarker, setDevRenderer, clearDevRenderer } from './precompile-marker.js';
export { setupPrecompile } from './setup.js';
export { __applyPrecompiled } from './apply-precompiled.js';
export { registerArtifact, getArtifact, listUserArtifacts } from './artifact-loader.js';
export { default as PrecompiledMaterial } from './_vendor-PrecompiledMaterial.js';
export { default as PrecompiledComputeNode } from './precompiled-compute-node.js';
export { registerPrecompiledArtifact, registerPrecompiledArtifacts, unregisterPrecompiledArtifacts, getShadowArtifact, getPipelineArtifact, getOutputArtifact, dumpPrecompiledRegistry } from './_vendor-PrecompiledArtifactRegistry.js';
export * from './writers.js';
export {
	hashNodeGraph,
	hashNodeGraphSync,
	hashPlainConfigSync,
	normalizeMaterialGraph,
	hashMaterialSync,
	hashArtifactContentSync,
} from './graph-hash.js';
export { precompileAuxiliary } from './aux-marker.js';
export { registerAuxArtifact, registerAuxArtifacts, loadAux, hasAux, listAux, findAux, bindAuxConfig, bindAuxByName, attachArtifactTextureRefs, __resetAuxRegistryForTests } from './aux-loader.js';
export { hydrateNodeBuilderState, registerLiveTexture, clearLiveTextureIndex } from './hydrator.js';
export { getTextureResolutionDebugHook, setTextureResolutionDebugHook } from './hydrate/artifact-texture-resolver.js';
export { getDFGLUT } from './dfg-lut.js';
export { createLiveSceneIndex, collectMaterialNodeTextures, textureImageReady, textureImageSrc, healTextureImage } from './slim-support/live-scene-index.js';
export { PMREM_CUBE_UV_MAPPING, isPMREMTexture, isPMREMArtifactTextureSource, artifactNeedsPMREM, artifactPMREMSourceUuids, attachPMREMRefsByOrder, selectPMREMTexturesForArtifact, createPMREMSupport } from './slim-support/pmrem.js';
export { clearTextureViewCache, markTextureInitialized, shareGPUTextureEntry, sharePMREMGPUTexture, shareShadowGPUTextureIntoSlim } from './slim-support/gpu-texture-share.js';
export { textureMatchesSource, textureMatchesArtifactSource, artifactHasTextureSource, countArtifactTextureSources, singleArtifactTextureUuid, attachTextureRefsWhere, attachArtifactTextureRefsWhere } from './slim-support/artifact-texture-wiring.js';
export { getComputeBindGroups, computeNodeUsesStorageTexture, syncComputeStorageOutputs } from './slim-support/compute-sync.js';
export { createFullRendererFallback } from './slim-support/full-renderer-fallback.js';
export { createSlimSceneSupport } from './slim-support/scene-support.js';
export { setSlimRenderFallback, getSlimRenderFallback } from './slim-support/render-fallback-registry.js';
export { collectLiveBloomNodes, wireBloomNode, wirePrecompiledPostprocess, findPostprocessAux } from './slim-support/postprocess-wire.js';
export { registerEffectHandler, unregisterEffectHandler, getEffectHandlers, findEffectHandler, collectEffectNodes } from './slim-support/postprocess-effects.js';
export { preparePrecompiledPostprocess, prepareEffectNodeForReplay, makePrecompiledAuxMaterial, cloneAuxArtifact, wireLiveNodeSidecarsToArtifact } from './slim-support/postprocess-effects-replay.js';
export { renderPassWithFullRenderer } from './slim-support/pass-render-fallback.js';
export { loadInspectorOptional } from './inspector-loader.js';
export { MaterialVariantSet, createMaterialVariants, applyMaterialVariant } from './material-variants.js';
