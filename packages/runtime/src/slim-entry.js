/**
 * Slim three.webgpu entry.
 *
 * Explicit allowlist of three.js symbols the slim bundle re-exports.
 * `Three.Core.js` fans out to loaders, animation, geometry primitives,
 * skeletal-mesh infra, curves, batched meshes — all great, all optional
 * for a precompile-only app. Users who need extras import them from
 * `three` directly (our Vite alias only replaces `three/webgpu`).
 *
 * The three.js node builder (`src/nodes/**`), every `*NodeMaterial`,
 * the TSL namespace, and (via our plugin rewrites) `StandardNodeLibrary` +
 * `WGSLNodeBuilder` + `GLSLNodeBuilder` + the WebGL fallback are NOT
 * re-exported AND are unreachable through this entry after transform.
 *
 * @module SlimEntry
 */

// ---- three.js core (scene graph, math, cameras, geometries, materials,
//      lights, helpers, loaders, animation) ----------------------------
// Three.Core.js is the big barrel of all non-TSL / non-renderer exports.
// It brings ~120 classes. Earlier we tried an allowlist to shrink this,
// but every real example ends up needing obscure symbols (InterleavedBuffer,
// EventDispatcher, Controls base, CylinderGeometry, …). The size cost of
// `export *` here is bounded — tree-shaking still drops classes nobody
// imports because `Three.Core.js` is ESM-re-export-style.
export * from 'three/src/Three.Core.js';
export { warnOnce } from 'three/src/utils.js';

// ---- three.js WebGPU renderer + common surface --------------------------
export { default as WebGPURenderer } from 'three/src/renderers/webgpu/WebGPURenderer.js';
export { default as Lighting } from 'three/src/renderers/common/Lighting.js';
export { default as QuadMesh } from 'three/src/renderers/common/QuadMesh.js';
export { default as PostProcessing } from 'three/src/renderers/common/PostProcessing.js';
export { default as RenderPipeline } from 'three/src/renderers/common/RenderPipeline.js';
export { default as PMREMGenerator } from 'three/src/renderers/common/extras/PMREMGenerator.js';
export { default as CanvasTarget } from 'three/src/renderers/common/CanvasTarget.js';
export { default as InspectorBase } from 'three/src/renderers/common/InspectorBase.js';
export { default as CubeRenderTarget } from 'three/src/renderers/common/CubeRenderTarget.js';
export { default as StorageTexture } from 'three/src/renderers/common/StorageTexture.js';
export { default as Storage3DTexture } from 'three/src/renderers/common/Storage3DTexture.js';
export { default as StorageArrayTexture } from 'three/src/renderers/common/StorageArrayTexture.js';
export { default as StorageBufferAttribute } from 'three/src/renderers/common/StorageBufferAttribute.js';
export { default as StorageInstancedBufferAttribute } from 'three/src/renderers/common/StorageInstancedBufferAttribute.js';
export { default as IndirectStorageBufferAttribute } from 'three/src/renderers/common/IndirectStorageBufferAttribute.js';
export { default as IESSpotLight } from 'three/src/lights/webgpu/IESSpotLight.js';
export { default as ProjectorLight } from 'three/src/lights/webgpu/ProjectorLight.js';
export { ClippingGroup } from 'three/src/objects/ClippingGroup.js';

// ---- slim stubs for dropped TSL/inspector exports ----------------------
// These are Proxy / no-op classes that preserve the module's export
// surface so `import { TSL, InspectorBase, PassNode, NodeMaterial }
// from 'three/webgpu'` keeps loading. Any runtime USE throws a clear
// loud-failure error.
export {
	TSL, PassNode, NodeMaterial,
	Node, NodeUpdateType, TempNode, CubeMapNode, RendererUtils,
	MeshBasicNodeMaterial, MeshStandardNodeMaterial, MeshPhysicalNodeMaterial,
	MeshLambertNodeMaterial, MeshPhongNodeMaterial, MeshToonNodeMaterial,
	MeshNormalNodeMaterial, MeshMatcapNodeMaterial, MeshSSSNodeMaterial,
	LineBasicNodeMaterial, LineDashedNodeMaterial, Line2NodeMaterial,
	PointsNodeMaterial, SpriteNodeMaterial, ShadowNodeMaterial,
	WebGLBackend, LightsNode, LightingModel, ShadowBaseNode, RectAreaLightNode, NodeUtils,
	R11_EAC_Format, RG11_EAC_Format, R_EAC_Signed_Format, RG_EAC_Signed_Format,
} from './slim-stubs.js';

// ---- our precompile layer ----------------------------------------------
export { default as PrecompiledMaterial } from './_vendor-PrecompiledMaterial.js';
export { default as PrecompiledComputeNode } from './precompiled-compute-node.js';
export {
	registerPrecompiledArtifact,
	registerPrecompiledArtifacts,
	unregisterPrecompiledArtifacts,
	getShadowArtifact,
	getPipelineArtifact,
	getOutputArtifact,
	dumpPrecompiledRegistry,
} from './_vendor-PrecompiledArtifactRegistry.js';
export { __applyPrecompiled } from './apply-precompiled.js';
export { registerArtifact, getArtifact } from './artifact-loader.js';
export { hydrateNodeBuilderState, registerLiveTexture, clearLiveTextureIndex } from './hydrator.js';
export { registerAuxArtifact, registerAuxArtifacts, loadAux, hasAux, listAux, attachArtifactTextureRefs, wireViewportTextureRefs, setupViewportTextureClasses } from './aux-loader.js';
export * from './writers.js';

// ---- viewport texture class registration --------------------------------
// Wire DepthTexture + FramebufferTexture into aux-loader at bundle
// initialization time so wireViewportTextureRefs() can create proper
// fallback instances for viewportSharedTexture() bindings (mapping === 300).
// The classes come from Three.Core.js which is already in this bundle;
// rollup deduplicates — no additional bundle cost.
// Called here rather than in aux-loader.js itself to avoid any import of
// 'three' from aux-loader (which would create a second module instance).
import { DepthTexture, FramebufferTexture } from 'three/src/Three.Core.js';
import { setupViewportTextureClasses as _setupVTC } from './aux-loader.js';
_setupVTC( { DepthTexture, FramebufferTexture } );
