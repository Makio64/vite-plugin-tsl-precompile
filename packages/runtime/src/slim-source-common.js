/**
 * Shared compiler-free Three/WebGPU surface.
 *
 * Every core re-export names its exact `three/src/**` owner. In contrast to
 * `Three.Core.js`, this lets a consumer build keep only the constructors it
 * imports and avoids the barrel's loaders/geometries/animation fan-out and
 * global devtools registration side effects.
 */

import './slim-bootstrap.js';

export const __TSLP_SLIM__ = true;

// Constants.
export {
	ACESFilmicToneMapping,
	AdditiveBlending,
	AgXToneMapping,
	BackSide,
	BasicShadowMap,
	CineonToneMapping,
	ClampToEdgeWrapping,
	Compatibility,
	CubeReflectionMapping,
	CubeRefractionMapping,
	DepthFormat,
	DepthStencilFormat,
	DoubleSide,
	DynamicDrawUsage,
	EquirectangularReflectionMapping,
	EquirectangularRefractionMapping,
	FloatType,
	FrontSide,
	GLSL3,
	GreaterEqualCompare,
	HalfFloatType,
	InterpolateDiscrete,
	InterpolateLinear,
	InterpolationSamplingMode,
	InterpolationSamplingType,
	LessCompare,
	LessEqualCompare,
	LinearFilter,
	LinearMipMapLinearFilter,
	LinearMipmapLinearFilter,
	LinearMipmapNearestFilter,
	LinearSRGBColorSpace,
	LinearToneMapping,
	MOUSE,
	MirroredRepeatWrapping,
	NearestFilter,
	NearestMipmapLinearFilter,
	NearestMipmapNearestFilter,
	NeutralToneMapping,
	NoColorSpace,
	NoToneMapping,
	NormalBlending,
	PCFShadowMap,
	PCFSoftShadowMap,
	REVISION,
	RedFormat,
	ReinhardToneMapping,
	RepeatWrapping,
	RGBAFormat,
	RGFormat,
	SRGBColorSpace,
	TimestampQuery,
	TOUCH,
	TriangleFanDrawMode,
	TriangleStripDrawMode,
	TrianglesDrawMode,
	UnsignedByteType,
	UnsignedIntType,
	UVMapping,
	VSMShadowMap,
	WebGLCoordinateSystem,
	WebGPUCoordinateSystem,
} from 'three/src/constants.js';

// Scene graph, cameras, objects, lights, and textures.
export { Scene } from 'three/src/scenes/Scene.js';
export { Fog } from 'three/src/scenes/Fog.js';
export { FogExp2 } from 'three/src/scenes/FogExp2.js';
export { Object3D } from 'three/src/core/Object3D.js';
export { Group } from 'three/src/objects/Group.js';
export { Mesh } from 'three/src/objects/Mesh.js';
export { InstancedMesh } from 'three/src/objects/InstancedMesh.js';
export { BatchedMesh } from 'three/src/objects/BatchedMesh.js';
export { SkinnedMesh } from 'three/src/objects/SkinnedMesh.js';
export { Skeleton } from 'three/src/objects/Skeleton.js';
export { Bone } from 'three/src/objects/Bone.js';
export { Line } from 'three/src/objects/Line.js';
export { LineLoop } from 'three/src/objects/LineLoop.js';
export { LineSegments } from 'three/src/objects/LineSegments.js';
export { Points } from 'three/src/objects/Points.js';
export { Sprite } from 'three/src/objects/Sprite.js';
export { ArrayCamera } from 'three/src/cameras/ArrayCamera.js';
export { CubeCamera } from 'three/src/cameras/CubeCamera.js';
export { OrthographicCamera } from 'three/src/cameras/OrthographicCamera.js';
export { PerspectiveCamera } from 'three/src/cameras/PerspectiveCamera.js';
export { StereoCamera } from 'three/src/cameras/StereoCamera.js';
export { AmbientLight } from 'three/src/lights/AmbientLight.js';
export { DirectionalLight } from 'three/src/lights/DirectionalLight.js';
export { HemisphereLight } from 'three/src/lights/HemisphereLight.js';
export { LightProbe } from 'three/src/lights/LightProbe.js';
export { PointLight } from 'three/src/lights/PointLight.js';
export { RectAreaLight } from 'three/src/lights/RectAreaLight.js';
export { SpotLight } from 'three/src/lights/SpotLight.js';
export { Texture } from 'three/src/textures/Texture.js';
export { CanvasTexture } from 'three/src/textures/CanvasTexture.js';
export { CompressedTexture } from 'three/src/textures/CompressedTexture.js';
export { CubeDepthTexture } from 'three/src/textures/CubeDepthTexture.js';
export { CubeTexture } from 'three/src/textures/CubeTexture.js';
export { Data3DTexture } from 'three/src/textures/Data3DTexture.js';
export { DataArrayTexture } from 'three/src/textures/DataArrayTexture.js';
export { DataTexture } from 'three/src/textures/DataTexture.js';
export { DepthTexture } from 'three/src/textures/DepthTexture.js';
export { FramebufferTexture } from 'three/src/textures/FramebufferTexture.js';
export { VideoFrameTexture } from 'three/src/textures/VideoFrameTexture.js';
export { VideoTexture } from 'three/src/textures/VideoTexture.js';

// Geometry, attributes, and render targets.
export { BufferAttribute, Float32BufferAttribute } from 'three/src/core/BufferAttribute.js';
export { BufferGeometry } from 'three/src/core/BufferGeometry.js';
export { InstancedBufferAttribute } from 'three/src/core/InstancedBufferAttribute.js';
export { InstancedBufferGeometry } from 'three/src/core/InstancedBufferGeometry.js';
export { InstancedInterleavedBuffer } from 'three/src/core/InstancedInterleavedBuffer.js';
export { InterleavedBuffer } from 'three/src/core/InterleavedBuffer.js';
export { InterleavedBufferAttribute } from 'three/src/core/InterleavedBufferAttribute.js';
export { RenderTarget } from 'three/src/core/RenderTarget.js';
export { RenderTarget3D } from 'three/src/core/RenderTarget3D.js';
export { UniformsGroup } from 'three/src/core/UniformsGroup.js';
export { BoxGeometry } from 'three/src/geometries/BoxGeometry.js';
export { CapsuleGeometry } from 'three/src/geometries/CapsuleGeometry.js';
export { CircleGeometry } from 'three/src/geometries/CircleGeometry.js';
export { ConeGeometry } from 'three/src/geometries/ConeGeometry.js';
export { CylinderGeometry } from 'three/src/geometries/CylinderGeometry.js';
export { DodecahedronGeometry } from 'three/src/geometries/DodecahedronGeometry.js';
export { IcosahedronGeometry } from 'three/src/geometries/IcosahedronGeometry.js';
export { OctahedronGeometry } from 'three/src/geometries/OctahedronGeometry.js';
export { PlaneGeometry } from 'three/src/geometries/PlaneGeometry.js';
export { PolyhedronGeometry } from 'three/src/geometries/PolyhedronGeometry.js';
export { RingGeometry } from 'three/src/geometries/RingGeometry.js';
export { SphereGeometry } from 'three/src/geometries/SphereGeometry.js';
export { TetrahedronGeometry } from 'three/src/geometries/TetrahedronGeometry.js';
export { TorusGeometry } from 'three/src/geometries/TorusGeometry.js';
export { TorusKnotGeometry } from 'three/src/geometries/TorusKnotGeometry.js';
export { WireframeGeometry } from 'three/src/geometries/WireframeGeometry.js';

// Materials.
export { Material } from 'three/src/materials/Material.js';
export { LineBasicMaterial } from 'three/src/materials/LineBasicMaterial.js';
export { LineDashedMaterial } from 'three/src/materials/LineDashedMaterial.js';
export { MeshBasicMaterial } from 'three/src/materials/MeshBasicMaterial.js';
export { MeshLambertMaterial } from 'three/src/materials/MeshLambertMaterial.js';
export { MeshMatcapMaterial } from 'three/src/materials/MeshMatcapMaterial.js';
export { MeshNormalMaterial } from 'three/src/materials/MeshNormalMaterial.js';
export { MeshPhongMaterial } from 'three/src/materials/MeshPhongMaterial.js';
export { MeshPhysicalMaterial } from 'three/src/materials/MeshPhysicalMaterial.js';
export { MeshStandardMaterial } from 'three/src/materials/MeshStandardMaterial.js';
export { MeshToonMaterial } from 'three/src/materials/MeshToonMaterial.js';
export { PointsMaterial } from 'three/src/materials/PointsMaterial.js';
export { ShadowMaterial } from 'three/src/materials/ShadowMaterial.js';

// Math, helpers, loading, and animation compatibility surface.
export { Box2 } from 'three/src/math/Box2.js';
export { Box3 } from 'three/src/math/Box3.js';
export { Color } from 'three/src/math/Color.js';
export { ColorManagement } from 'three/src/math/ColorManagement.js';
export { Euler } from 'three/src/math/Euler.js';
export { Frustum } from 'three/src/math/Frustum.js';
export { Interpolant } from 'three/src/math/Interpolant.js';
export { Line3 } from 'three/src/math/Line3.js';
export { MathUtils } from 'three/src/math/MathUtils.js';
export { Matrix3 } from 'three/src/math/Matrix3.js';
export { Matrix4 } from 'three/src/math/Matrix4.js';
export { Plane } from 'three/src/math/Plane.js';
export { Quaternion } from 'three/src/math/Quaternion.js';
export { Ray } from 'three/src/math/Ray.js';
export { Sphere } from 'three/src/math/Sphere.js';
export { Spherical } from 'three/src/math/Spherical.js';
export { Vector2 } from 'three/src/math/Vector2.js';
export { Vector3 } from 'three/src/math/Vector3.js';
export { Vector4 } from 'three/src/math/Vector4.js';
export { EventDispatcher } from 'three/src/core/EventDispatcher.js';
export { Layers } from 'three/src/core/Layers.js';
export { Raycaster } from 'three/src/core/Raycaster.js';
export { Timer } from 'three/src/core/Timer.js';
export { Controls } from 'three/src/extras/Controls.js';
export { DataUtils } from 'three/src/extras/DataUtils.js';
export { Path } from 'three/src/extras/core/Path.js';
export { CatmullRomCurve3 } from 'three/src/extras/curves/CatmullRomCurve3.js';
export { BoxHelper } from 'three/src/helpers/BoxHelper.js';
export { CameraHelper } from 'three/src/helpers/CameraHelper.js';
export { DirectionalLightHelper } from 'three/src/helpers/DirectionalLightHelper.js';
export { GridHelper } from 'three/src/helpers/GridHelper.js';
export { SkeletonHelper } from 'three/src/helpers/SkeletonHelper.js';
export { SpotLightHelper } from 'three/src/helpers/SpotLightHelper.js';
export { BufferGeometryLoader } from 'three/src/loaders/BufferGeometryLoader.js';
export { CubeTextureLoader } from 'three/src/loaders/CubeTextureLoader.js';
export { DataTextureLoader } from 'three/src/loaders/DataTextureLoader.js';
export { FileLoader } from 'three/src/loaders/FileLoader.js';
export { ImageBitmapLoader } from 'three/src/loaders/ImageBitmapLoader.js';
export { Loader } from 'three/src/loaders/Loader.js';
export { LoaderUtils } from 'three/src/loaders/LoaderUtils.js';
export { DefaultLoadingManager, LoadingManager } from 'three/src/loaders/LoadingManager.js';
export { ObjectLoader } from 'three/src/loaders/ObjectLoader.js';
export { TextureLoader } from 'three/src/loaders/TextureLoader.js';
export { AnimationClip } from 'three/src/animation/AnimationClip.js';
export { AnimationMixer } from 'three/src/animation/AnimationMixer.js';
export { KeyframeTrack } from 'three/src/animation/KeyframeTrack.js';
export { PropertyBinding } from 'three/src/animation/PropertyBinding.js';
export { NumberKeyframeTrack } from 'three/src/animation/tracks/NumberKeyframeTrack.js';
export { QuaternionKeyframeTrack } from 'three/src/animation/tracks/QuaternionKeyframeTrack.js';
export { VectorKeyframeTrack } from 'three/src/animation/tracks/VectorKeyframeTrack.js';
export { error, warn, warnOnce } from 'three/src/utils.js';

// WebGPU renderer surface and replay-owned replacements.
export { default as WebGPURenderer } from 'three/src/renderers/webgpu/WebGPURenderer.js';
export { default as Lighting } from './slim-replay-lighting.js';
export { default as QuadMesh } from 'three/src/renderers/common/QuadMesh.js';
export { default as PostProcessing } from 'three/src/renderers/common/PostProcessing.js';
export { default as RenderPipeline } from 'three/src/renderers/common/RenderPipeline.js';
export { default as BundleGroup } from 'three/src/renderers/common/BundleGroup.js';
export { default as PMREMGenerator } from './slim-stub-pmrem-generator.js';
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

// Inert compatibility surface for TSL/Node APIs removed from production.
export {
	TSL, PassNode, NodeMaterial,
	Node, NodeUpdateType, TempNode, CubeMapNode, RendererUtils,
	builtinAOContext, builtinShadowContext,
	MeshBasicNodeMaterial, MeshStandardNodeMaterial, MeshPhysicalNodeMaterial,
	MeshLambertNodeMaterial, MeshPhongNodeMaterial, MeshToonNodeMaterial,
	MeshNormalNodeMaterial, MeshMatcapNodeMaterial, MeshSSSNodeMaterial,
	VolumeNodeMaterial,
	LineBasicNodeMaterial, LineDashedNodeMaterial, Line2NodeMaterial,
	PointsNodeMaterial, SpriteNodeMaterial, ShadowNodeMaterial,
	WebGLBackend, LightsNode, LightingModel, ShadowBaseNode, RectAreaLightNode, NodeAccess, NodeUtils,
	R11_EAC_Format, RG11_EAC_Format, R_EAC_Signed_Format, RG_EAC_Signed_Format,
} from './slim-stubs.js';

// Precompile runtime surface.
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
export { hydrateNodeBuilderState, registerLiveTexture, clearLiveTextureIndex, installTextureLoaderTracking } from './hydrator.js';
export { getTextureResolutionDebugHook, setTextureResolutionDebugHook } from './hydrate/artifact-texture-resolver.js';
export { registerAuxArtifact, registerAuxArtifacts, loadAux, hasAux, listAux, findAux, bindAuxConfig, bindAuxByName, attachArtifactTextureRefs, attachPostprocessTextureRefs, attachPostprocessUpdateBeforeNodes, attachPostprocessObject3DTargets, wireViewportTextureRefs, setupViewportTextureClasses } from './aux-loader.js';
export { hashNodeGraphSync } from './graph-hash.js';
export { setSlimRenderFallback } from './slim-support/render-fallback-registry.js';
export * from './writers.js';
