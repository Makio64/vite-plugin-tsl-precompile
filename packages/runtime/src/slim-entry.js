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

// Sentinel: lets `setupPrecompile()` (and any future helper) detect that
// the namespace being passed is the slim bundle, so it can short-circuit
// work that's pointless without the node builder. Plain boolean keeps the
// check trivial: `if ( three.__TSLP_SLIM__ ) ...`.
export const __TSLP_SLIM__ = true;

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
import WebGPURenderer from 'three/src/renderers/webgpu/WebGPURenderer.js';
WebGPURenderer.__TSLP_SLIM__ = true;
WebGPURenderer.prototype.__TSLP_SLIM__ = true;
export { WebGPURenderer };
export { default as Lighting } from 'three/src/renderers/common/Lighting.js';
export { default as QuadMesh } from 'three/src/renderers/common/QuadMesh.js';
export { default as PostProcessing } from 'three/src/renderers/common/PostProcessing.js';
export { default as RenderPipeline } from 'three/src/renderers/common/RenderPipeline.js';
export { default as BundleGroup } from 'three/src/renderers/common/BundleGroup.js';
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
export { getTextureResolutionDebugHook, setTextureResolutionDebugHook } from './hydrate/artifact-texture-resolver.js';
export { registerAuxArtifact, registerAuxArtifacts, loadAux, hasAux, listAux, findAux, bindAuxConfig, bindAuxByName, attachArtifactTextureRefs, wireViewportTextureRefs, setupViewportTextureClasses } from './aux-loader.js';
export { hashNodeGraphSync } from './graph-hash.js';
export { MaterialVariantSet, createMaterialVariants, applyMaterialVariant } from './material-variants.js';
export { clearTextureViewCache, markTextureInitialized, shareGPUTextureEntry, sharePMREMGPUTexture, shareShadowGPUTextureIntoSlim } from './slim-support/gpu-texture-share.js';
export { textureMatchesSource, textureMatchesArtifactSource, artifactHasTextureSource, countArtifactTextureSources, singleArtifactTextureUuid, attachTextureRefsWhere, attachArtifactTextureRefsWhere } from './slim-support/artifact-texture-wiring.js';
export { getComputeBindGroups, computeNodeUsesStorageTexture, syncComputeStorageOutputs } from './slim-support/compute-sync.js';
export { createFullRendererFallback } from './slim-support/full-renderer-fallback.js';
export { createSlimSceneSupport } from './slim-support/scene-support.js';
export { setSlimRenderFallback, getSlimRenderFallback } from './slim-support/render-fallback-registry.js';
export { renderPassWithFullRenderer, sharePassRenderTargetTextures } from './slim-support/pass-render-fallback.js';
export * from './writers.js';

// ---- viewport texture class registration --------------------------------
// Wire DepthTexture + FramebufferTexture into aux-loader at bundle
// initialization time so wireViewportTextureRefs() can create proper
// fallback instances for viewportSharedTexture() bindings (mapping === 300).
// The classes come from Three.Core.js which is already in this bundle;
// rollup deduplicates — no additional bundle cost.
// Called here rather than in aux-loader.js itself to avoid any import of
// 'three' from aux-loader (which would create a second module instance).
import { DepthTexture, FramebufferTexture, HalfFloatType, RedFormat, RGBAFormat, UnsignedByteType } from 'three/src/Three.Core.js';
import WebGPUTextureUtils from 'three/src/renderers/webgpu/utils/WebGPUTextureUtils.js';
import { setupViewportTextureClasses as _setupVTC } from './aux-loader.js';
_setupVTC( { DepthTexture, FramebufferTexture } );

const _createDefaultTexture = WebGPUTextureUtils.prototype.createDefaultTexture;
const _createTexture = WebGPUTextureUtils.prototype.createTexture;
const _updateTexture = WebGPUTextureUtils.prototype.updateTexture;

function _default3DTextureFormat( texture ) {

	if ( typeof texture.internalFormat === 'string' ) return texture.internalFormat;
	if ( texture.format === RGBAFormat && texture.type === UnsignedByteType ) return 'rgba8unorm';
	if ( texture.format === RGBAFormat && texture.type === HalfFloatType ) return 'rgba16float';
	if ( texture.format === RedFormat && texture.type === UnsignedByteType ) return 'r8unorm';
	return null;

}

WebGPUTextureUtils.prototype.createDefaultTexture = function ( texture ) {

	if ( texture && ( texture.isData3DTexture === true || texture.is3DTexture === true ) ) {

		const usage = typeof globalThis !== 'undefined' ? globalThis.GPUTextureUsage : null;
		const format = _default3DTextureFormat( texture );
		if ( usage && format && this.backend && this.backend.device ) {

			try {

				this.backend.get( texture ).texture = this.backend.device.createTexture( {
					label: texture.name,
					size: { width: 1, height: 1, depthOrArrayLayers: 1 },
					mipLevelCount: 1,
					sampleCount: 1,
					dimension: '3d',
					format,
					usage: usage.TEXTURE_BINDING | usage.COPY_DST | usage.COPY_SRC,
				} );
				return;

			} catch ( _ ) {}

		}

	}

	return _createDefaultTexture.call( this, texture );

};

WebGPUTextureUtils.prototype.createTexture = function ( texture, options = {} ) {

	if ( texture && ( texture.isData3DTexture === true || texture.is3DTexture === true ) ) {

		const usage = typeof globalThis !== 'undefined' ? globalThis.GPUTextureUsage : null;
		const format = _default3DTextureFormat( texture );
		const image = texture.image || {};
		const width = options.width || image.width || 1;
		const height = options.height || image.height || 1;
		const depth = options.depth || image.depth || image.depthOrArrayLayers || 1;
		const levels = options.levels || 1;
		if ( usage && format && this.backend && this.backend.device ) {

			const textureData = this.backend.get( texture );
			if ( textureData.initialized ) {

				throw new Error( 'WebGPUTextureUtils: Texture already initialized.' );

			}

			const descriptor = {
				label: texture.name,
				size: { width, height, depthOrArrayLayers: depth },
				mipLevelCount: levels,
				sampleCount: 1,
				dimension: '3d',
				format,
				usage: usage.TEXTURE_BINDING | usage.COPY_DST | usage.COPY_SRC | ( texture.isStorageTexture === true ? usage.STORAGE_BINDING : 0 ),
			};

			try {

				textureData.format = format;
				textureData.texture = this.backend.device.createTexture( descriptor );
				textureData.initialized = true;
				textureData.textureDescriptorGPU = descriptor;
				return;

			} catch ( _ ) {}

		}

	}

	return _createTexture.call( this, texture, options );

};

WebGPUTextureUtils.prototype.updateTexture = function ( texture, options = {} ) {

	if ( texture && ( texture.isData3DTexture === true || texture.is3DTexture === true ) && texture.flipY !== true ) {

		const image = options.image || texture.image || null;
		const data = image && image.data || null;
		const textureData = this.backend && this.backend.get( texture );
		const descriptor = textureData && textureData.textureDescriptorGPU;
		const textureGPU = textureData && textureData.texture;
		if ( image && data && descriptor && textureGPU && this.backend.device ) {

			try {

				const bytesPerTexel = this._getBytesPerTexel( descriptor.format );
				const sourceBytesPerRow = image.width * bytesPerTexel;
				const bytesPerRow = Math.ceil( sourceBytesPerRow / 256 ) * 256;
				const source = new Uint8Array( data.buffer, data.byteOffset, data.byteLength );
				let upload = source;

				if ( bytesPerRow !== sourceBytesPerRow ) {

					upload = new Uint8Array( bytesPerRow * image.height * image.depth );
					for ( let z = 0; z < image.depth; z ++ ) {

						for ( let y = 0; y < image.height; y ++ ) {

							const srcOffset = ( z * image.height + y ) * sourceBytesPerRow;
							const dstOffset = ( z * image.height + y ) * bytesPerRow;
							upload.set( source.subarray( srcOffset, srcOffset + sourceBytesPerRow ), dstOffset );

						}

					}

				}

				this.backend.device.queue.writeTexture(
					{ texture: textureGPU, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
					upload,
					{ offset: 0, bytesPerRow, rowsPerImage: image.height },
					{ width: image.width, height: image.height, depthOrArrayLayers: image.depth }
				);
				return;

			} catch ( _ ) {}

		}

	}

	return _updateTexture.call( this, texture, options );

};
