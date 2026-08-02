/**
 * Compiler-free compatibility values used when `three/tsl` is redirected by
 * the plugin. The names intentionally match the JavaScript stub module
 * exactly; unsupported calls still fail at runtime with the slim diagnostic.
 */
export {
	Break, Fn, If, Loop, NodeAccess,
	NodeUpdateType, OnMaterialUpdate, PI, abs, acos,
	add, atan, attribute, backgroundBlurriness, backgroundIntensity,
	backgroundRotation, bool, bufferAttribute, builtin, builtinAOContext,
	builtinShadowContext, cameraNormalMatrix, cameraPosition, cameraProjectionMatrix, cameraWorldMatrix,
	ceil, clamp, color, context, convertToTexture,
	cos, cross, cubeTexture, dFdx, dFdy,
	densityFogFactor, depth, depthPass, diffuseColor, directionToColor,
	div, dot, emissive, equirectUV, exp,
	exp2, float, floor, fog, fract,
	frameId, fwidth, getNormalFromDepth, getScreenPosition, getViewPosition,
	highpModelNormalViewMatrix, highpModelViewMatrix, instancedArray, instancedBufferAttribute, int,
	ivec2, ivec3, ivec4, length, linearDepth,
	log, log2, logarithmicDepthToViewZ, luminance, mat3,
	mat4, max, min, mix, mod,
	modelPosition, modelScale, modelViewMatrix, modelViewProjection, modelWorldMatrix,
	mrt, mul, negate, nodeObject, normalLocal,
	normalView, normalWorld, normalWorldGeometry, normalize, oneMinus,
	output, pass, passTexture, pmremTexture, positionLocal,
	positionView, positionWorld, pow, pow2, pow3,
	pow4, rangeFogFactor, reference, reflect, reflector,
	renderGroup, renderOutput, saturate, screenSize, screenUV,
	select, sign, sin, smoothstep, sqrt,
	step, storage, sub, tan, texture,
	textureSize, time, uint, uniform, uniformArray,
	uv, uvec2, uvec3, uvec4, varyingProperty,
	vec2, vec3, vec4, viewZToPerspectiveDepth, viewportDepthTexture,
	viewportLinearDepth, viewportSharedTexture, viewportSize, viewportTexture, viewportUV,
} from 'three/tsl';

export {
	CanvasTarget, CubeMapNode, InspectorBase, LightingModel, LightsNode,
	Line2NodeMaterial, LineBasicNodeMaterial, LineDashedNodeMaterial, MeshBasicNodeMaterial, MeshLambertNodeMaterial,
	MeshMatcapNodeMaterial, MeshNormalNodeMaterial, MeshPhongNodeMaterial, MeshPhysicalNodeMaterial, MeshSSSNodeMaterial,
	MeshStandardNodeMaterial, MeshToonNodeMaterial, Node, NodeMaterial, NodeUtils,
	PassNode, PointsNodeMaterial, R11_EAC_Format, RG11_EAC_Format, RectAreaLightNode,
	RendererUtils, ShadowBaseNode, ShadowNodeMaterial, SpriteNodeMaterial, TSL,
	TempNode, VolumeNodeMaterial, WebGLBackend, warnOnce,
} from 'three/webgpu';

export const R_EAC_Signed_Format: number;
export const RG_EAC_Signed_Format: number;

export function __getPmremStubSource( stub: unknown ): unknown;

type CompatNode = import('three/webgpu').Node;
type CompatNodeFactory = ( ...args: unknown[] ) => CompatNode;

export const atan2: CompatNodeFactory;
export const cond: CompatNodeFactory;
export const cubeMapNode: CompatNodeFactory;
export const invert: CompatNodeFactory;
export const storageBufferAttribute: CompatNodeFactory;
export const timerDelta: CompatNode;
export const timerGlobal: CompatNode;
export const timerLocal: CompatNode;
export const viewportTopLeft: CompatNode;
