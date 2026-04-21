export { installPrecompileMarker, setDevRenderer, clearDevRenderer } from './precompile-marker.js';
export { __applyPrecompiled } from './apply-precompiled.js';
export { registerArtifact, getArtifact } from './artifact-loader.js';
export { default as PrecompiledMaterial } from './_vendor-PrecompiledMaterial.js';
export { registerPrecompiledArtifact, registerPrecompiledArtifacts, unregisterPrecompiledArtifacts, getShadowArtifact, getPipelineArtifact, getOutputArtifact, dumpPrecompiledRegistry } from './_vendor-PrecompiledArtifactRegistry.js';
export * from './writers.js';
