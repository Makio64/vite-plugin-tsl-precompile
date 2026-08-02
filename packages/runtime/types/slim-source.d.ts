/**
 * Exact public surface shared by the prebuilt and guarded-source slim entries.
 *
 * This list is deliberately explicit. Re-exporting the complete
 * `three/webgpu` or root runtime barrels would promise compiler and capture
 * APIs that are not present in the compiler-free JavaScript module.
 */
export {
	ACESFilmicToneMapping, AdditiveBlending, AgXToneMapping, AmbientLight, AnimationClip,
	AnimationMixer, ArrayCamera, BackSide, BasicShadowMap, BatchedMesh,
	Bone, Box2, Box3, BoxGeometry, BoxHelper,
	BufferAttribute, BufferGeometry, BufferGeometryLoader, BundleGroup, CameraHelper,
	CanvasTarget, CanvasTexture, CapsuleGeometry, CatmullRomCurve3, CineonToneMapping,
	CircleGeometry, ClampToEdgeWrapping, ClippingGroup, Color, ColorManagement,
	Compatibility, CompressedTexture, ConeGeometry, Controls, CubeCamera,
	CubeDepthTexture, CubeMapNode, CubeReflectionMapping, CubeRefractionMapping, CubeRenderTarget,
	CubeTexture, CubeTextureLoader, CylinderGeometry, Data3DTexture, DataArrayTexture,
	DataTexture, DataTextureLoader, DataUtils, DefaultLoadingManager, DepthFormat,
	DepthStencilFormat, DepthTexture, DirectionalLight, DirectionalLightHelper, DodecahedronGeometry,
	DoubleSide, DynamicDrawUsage, EquirectangularReflectionMapping, EquirectangularRefractionMapping, Euler,
	EventDispatcher, FileLoader, Float32BufferAttribute, FloatType, Fog,
	FogExp2, FramebufferTexture, FrontSide, Frustum, GLSL3,
	GreaterEqualCompare, GridHelper, Group, HalfFloatType, HemisphereLight,
	IESSpotLight, IcosahedronGeometry, ImageBitmapLoader, IndirectStorageBufferAttribute, InspectorBase,
	InstancedBufferAttribute, InstancedBufferGeometry, InstancedInterleavedBuffer, InstancedMesh, InterleavedBuffer,
	InterleavedBufferAttribute, Interpolant, InterpolateDiscrete, InterpolateLinear, InterpolationSamplingMode,
	InterpolationSamplingType, KeyframeTrack, Layers, LessCompare, LessEqualCompare,
	LightProbe, Lighting, LightingModel, LightsNode, Line,
	Line2NodeMaterial, Line3, LineBasicMaterial, LineBasicNodeMaterial, LineDashedMaterial,
	LineDashedNodeMaterial, LineLoop, LineSegments, LinearFilter, LinearMipMapLinearFilter,
	LinearMipmapLinearFilter, LinearMipmapNearestFilter, LinearSRGBColorSpace, LinearToneMapping, Loader,
	LoaderUtils, LoadingManager, MOUSE, Material, MathUtils,
	Matrix3, Matrix4, Mesh, MeshBasicMaterial, MeshBasicNodeMaterial,
	MeshLambertMaterial, MeshLambertNodeMaterial, MeshMatcapMaterial, MeshMatcapNodeMaterial, MeshNormalMaterial,
	MeshNormalNodeMaterial, MeshPhongMaterial, MeshPhongNodeMaterial, MeshPhysicalMaterial, MeshPhysicalNodeMaterial,
	MeshSSSNodeMaterial, MeshStandardMaterial, MeshStandardNodeMaterial, MeshToonMaterial, MeshToonNodeMaterial,
	MirroredRepeatWrapping, NearestFilter, NearestMipmapLinearFilter, NearestMipmapNearestFilter, NeutralToneMapping,
	NoColorSpace, NoToneMapping, Node, NodeAccess, NodeMaterial,
	NodeUpdateType, NodeUtils, NormalBlending, NumberKeyframeTrack, Object3D,
	ObjectLoader, OctahedronGeometry, OrthographicCamera, PCFShadowMap, PCFSoftShadowMap,
	PMREMGenerator, PassNode, Path, PerspectiveCamera, Plane,
	PlaneGeometry, PointLight, Points, PointsMaterial, PointsNodeMaterial,
	PolyhedronGeometry, PostProcessing, ProjectorLight, PropertyBinding, QuadMesh,
	Quaternion, QuaternionKeyframeTrack, R11_EAC_Format, REVISION, RG11_EAC_Format,
	RGBAFormat, RGFormat, Ray, Raycaster, RectAreaLight,
	RectAreaLightNode, RedFormat, ReinhardToneMapping, RenderPipeline, RenderTarget,
	RenderTarget3D, RendererUtils, RepeatWrapping, RingGeometry, SRGBColorSpace,
	Scene, ShadowBaseNode, ShadowMaterial, ShadowNodeMaterial, Skeleton,
	SkeletonHelper, SkinnedMesh, Sphere, SphereGeometry, Spherical,
	SpotLight, SpotLightHelper, Sprite, SpriteNodeMaterial, StereoCamera,
	Storage3DTexture, StorageArrayTexture, StorageBufferAttribute, StorageInstancedBufferAttribute, StorageTexture,
	TOUCH, TSL, TempNode, TetrahedronGeometry, Texture,
	TextureLoader, Timer, TimestampQuery, TorusGeometry, TorusKnotGeometry,
	TriangleFanDrawMode, TriangleStripDrawMode, TrianglesDrawMode, UVMapping, UniformsGroup,
	UnsignedByteType, UnsignedIntType, VSMShadowMap, Vector2, Vector3,
	Vector4, VectorKeyframeTrack, VideoFrameTexture, VideoTexture, VolumeNodeMaterial,
	WebGLBackend, WebGLCoordinateSystem, WebGPUCoordinateSystem, WebGPURenderer, WireframeGeometry,
	error, warn, warnOnce,
} from 'three/webgpu';

export {
	PrecompiledComputeNode, PrecompiledMaterial, __applyPrecompiled,
	attachArtifactTextureRefs, attachLiveNodeDependency, attachPostprocessObject3DTargets,
	attachPostprocessTextureRefs, attachPostprocessUpdateBeforeNodes, bindAuxByName,
	bindAuxConfig, clearLiveTextureIndex, dumpPrecompiledRegistry,
	findAux, getArtifact, getLiveNodeDependencies,
	getOutputArtifact, getPipelineArtifact, getShadowArtifact,
	getTextureResolutionDebugHook, hasAux, hashNodeGraphSync,
	hydrateNodeBuilderState, installTextureLoaderTracking, listAux,
	loadAux, registerArtifact, registerAuxArtifact,
	registerAuxArtifacts, registerLiveTexture, registerPrecompiledArtifact,
	registerPrecompiledArtifacts, setSlimRenderFallback, setTextureResolutionDebugHook,
	unregisterPrecompiledArtifacts, writeBytes, writeColor,
	writeColorRGBA, writeF32, writeI32,
	writeMat3, writeMat4, writeMat4FromEuler, writeEnvironmentRotation, writePMREMScalar, writeTextureUVFlip,
	writeU32, writeVec2, writeVec3,
	writeVec4,
} from './index.js';

export {
	linkGeneratedLightIdentitySource,
	writeGeneratedLightValue,
} from './generated/light-writer.js';

export { registerLiveUniformNode } from './slim-support/live-uniform-registry.js';

export const __TSLP_SLIM__: true;
export const R_EAC_Signed_Format: number;
export const RG_EAC_Signed_Format: number;

export function builtinAOContext( aoNode: unknown, node?: unknown ): import('three/webgpu').Node;
export function builtinShadowContext(
	shadowNode: unknown,
	light?: unknown,
	node?: unknown,
): import('three/webgpu').Node;

export function setupViewportTextureClasses( classes: {
	DepthTexture: typeof import('three').DepthTexture;
	FramebufferTexture: typeof import('three').FramebufferTexture;
} ): void;

export function wireViewportTextureRefs<TArtifact>( artifact: TArtifact ): TArtifact;
