import {
	ARTIFACT_TOOLCHAIN_VERSION,
	canonicalTextureImageSource,
	createRangeAttributeGenerator,
	createRenderContextSignature,
	registerMaterial,
	stableJsonStringify,
	validateArtifact,
} from '@tsl-precompile/contract';
import {
	ARTIFACT_CONTENT_HASH_VERSION,
	createArtifactContentHashPayload,
} from '@tsl-precompile/contract/artifact-content';
import { fingerprintArtifactShape } from '@tsl-precompile/contract/artifact-shape';
import { forEachArtifactPayload } from '@tsl-precompile/contract/artifact-traversal';
import {
	ARTIFACT_VARIANT_FIELDS,
	createArtifactVariantPayload,
} from '@tsl-precompile/contract/artifact-variants';
import { generateRangeAttributeArray } from '@tsl-precompile/contract/attribute-generators';
import { AUXILIARY_MATERIAL_SHAPES } from '@tsl-precompile/contract/auxiliary-shapes';
import {
	COMPUTE_BINDINGS_VERSION,
	validateComputeBindingsDescriptor,
} from '@tsl-precompile/contract/compute-bindings';
import {
	CUBE_RENDER_TARGET_AUX_CONFIG_SCHEMA,
	assertCubeRenderTargetTextureEvidence,
} from '@tsl-precompile/contract/cube-render-target';
import {
	DIAGNOSTIC_GLOBAL_SCHEMA,
	type DiagnosticGlobalEntry,
	getDiagnosticGlobal,
	isProductDiagnosticGlobal,
	listDiagnosticGlobals,
} from '@tsl-precompile/contract/diagnostic-globals';
import {
	DYNAMIC_BINDING_TARGET,
	createLiveUniformCallsiteIdentity,
	createStorageBufferSnapshotHash,
	hasExactLiveUniformOverlayAddress,
	validateStorageBufferSnapshot,
} from '@tsl-precompile/contract/dynamic-bindings';
import { countFragmentOutputsFromShader } from '@tsl-precompile/contract/fragment-outputs';
import { MAX_GRAPH_DEPTH } from '@tsl-precompile/contract/graph-normalize';
import { KIND_STATUS, kindInfo } from '@tsl-precompile/contract/kinds';
import { LIGHT_IDENTITY_SCHEMA } from '@tsl-precompile/contract/light-identities';
import {
	SHADER_LANGUAGES,
	createBackendAwareVariantKey,
	detectArtifactShaderLanguage,
	type ShaderLanguage,
} from '@tsl-precompile/contract/shader-language';
import {
	INTERNAL_PASS_SCHEMA,
	type InternalPassDescriptor,
	validateInternalPassDescriptor,
} from '@tsl-precompile/contract/internal-pass';
import { MATERIAL_COMPUTE_VERSION } from '@tsl-precompile/contract/material-compute';
import { createRendererOutputConfig } from '@tsl-precompile/contract/output-config';
import { describeRenderContext } from '@tsl-precompile/contract/render-context';
import {
	RENDER_BINDING_OWNER_KINDS,
	createBackgroundCaptureTargetTopologyKey,
	describeBackgroundCaptureTargetTopology,
	describeSceneRenderTopology,
	projectRenderObjectContextSelector,
	resolveArtifactSourceBindingOwner,
} from '@tsl-precompile/contract/render-selector';
import {
	createRendererRenderTargetTextureSelector,
	type RendererRenderTargetTextureSelector,
} from '@tsl-precompile/contract/render-target-texture';
import {
	SLIM_BUNDLE_FILE_NAME,
	computeSlimBundleSourceFingerprint,
	createSlimBundleSourceInputs,
	createSlimBundleVersionIdentity,
	sha256Bytes,
	type SlimBundleComputedSourceDescriptor,
} from '@tsl-precompile/contract/slim-bundle-provenance-node';
import {
	SLIM_THREE_PACKAGE_VERSION,
	SLIM_THREE_RUNTIME_ENTRIES,
} from '@tsl-precompile/contract/slim-three-policy';
import { MATERIAL_TEXTURE_PROPS } from '@tsl-precompile/contract/texture-props';
import { materializeArtifactVariantSelectorAdapters } from '@tsl-precompile/contract/variant-selector-adapter';
import { GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR } from '@tsl-precompile/contract/variant-selector-sidecar';
import { VIRTUAL_FULL_THREE_MODULE_ID } from '@tsl-precompile/contract/virtual-modules';
import { createVSMSupportConfig } from '@tsl-precompile/contract/vsm-config';

const recipe = createRangeAttributeGenerator(
	42,
	[ 0, 0, 0, 0 ],
	[ 1, 1, 1, 1 ],
);
const generated: Float32Array = generateRangeAttributeArray( recipe, 2 );
const signature: string = createRenderContextSignature();
const payload: string = createArtifactContentHashPayload(
	{ uniformPlan: [] },
	{
		shape: 'typed-contract',
		threeVersion: SLIM_THREE_PACKAGE_VERSION,
		toolchainVersion: ARTIFACT_TOOLCHAIN_VERSION,
	},
);
const validation: boolean = validateArtifact( { uniformPlan: [] } ).ok;
const canonicalTextureSource: string = canonicalTextureImageSource(
	'http://localhost:5173/textures/albedo.png',
	'http://localhost:5173/',
);
const callsite: string | null = createLiveUniformCallsiteIdentity( 'fixture.ts', 0 );
const liveUniformHasAddress: boolean = hasExactLiveUniformOverlayAddress( {
	nodePath: [ 'material', 'colorNode' ],
} );
const storageSnapshot = {
	arrayType: 'Uint32Array',
	count: 1,
	itemSize: 1,
	arraySnapshot: [ 7 ],
};
const storageSnapshotHash: string | null = createStorageBufferSnapshotHash( storageSnapshot );
const storageSnapshotValid: boolean = validateStorageBufferSnapshot( {
	...storageSnapshot,
	arraySnapshotHash: storageSnapshotHash,
} ).length === 0;
const digest: string = sha256Bytes( payload );
const shaderLanguage: ShaderLanguage | null = detectArtifactShaderLanguage( {
	vertexShader: '@vertex fn main() {}',
} );
const variantKey: string = createBackendAwareVariantKey( 'typed-cache-key', SHADER_LANGUAGES.WGSL );
class FixtureMaterial {}
const registeredMaterial: string = registerMaterial( FixtureMaterial, { type: 'FixtureMaterial' } );
const materialOwner: 'render-material' = RENDER_BINDING_OWNER_KINDS.MATERIAL;
const bindingOwner: 'render-material' | 'shadow-caster' = resolveArtifactSourceBindingOwner( null, null );
const sceneTopology: Record<string, unknown> | null = describeSceneRenderTopology( null );
const backgroundTargetTopology: Record<string, unknown> = describeBackgroundCaptureTargetTopology( null, null );
const backgroundTargetKey: string = createBackgroundCaptureTargetTopologyKey( null, null );
declare const rendererRenderTarget: object;
const renderTargetTextureSelector: RendererRenderTargetTextureSelector =
	createRendererRenderTargetTextureSelector( rendererRenderTarget );
const projectedSelector: string = projectRenderObjectContextSelector( '{}', null );
const runtimeDiagnosticGlobals: readonly DiagnosticGlobalEntry[] = listDiagnosticGlobals( { surface: 'runtime' } );
const harnessDiagnosticEntry: DiagnosticGlobalEntry | null = getDiagnosticGlobal( '__tslpHarnessDiagnostics' );
const harnessDiagnosticIsProduct: boolean = isProductDiagnosticGlobal( '__tslpHarnessDiagnostics' );
declare const cubeArtifact: object;
const textureEvidence: Set<string> = assertCubeRenderTargetTextureEvidence( cubeArtifact );
const internalPassDescriptor = {
	schema: INTERNAL_PASS_SCHEMA,
	family: 'shadow-vsm',
	stage: 'vertical',
	shape: 'shadow-vsm-vertical',
	config: createVSMSupportConfig(),
	uniforms: [],
	inputs: [],
	output: { topology: { dimension: '2d', depth: false } },
} satisfies InternalPassDescriptor;
const internalPassIssues = validateInternalPassDescriptor( internalPassDescriptor );
const slimVersions = createSlimBundleVersionIdentity( {
	threeVersion: SLIM_THREE_PACKAGE_VERSION,
	policyVersion: 'policy',
	artifactToolchainVersion: ARTIFACT_TOOLCHAIN_VERSION,
} );
const slimInputs = createSlimBundleSourceInputs( {
	threePackageRoot: '/three',
	runtimePackageRoot: '/runtime',
	contractPackageRoot: '/contract',
	pluginPackageRoot: '/plugin',
} );
const slimSource: Promise<SlimBundleComputedSourceDescriptor> =
	computeSlimBundleSourceFingerprint( slimInputs, slimVersions );

forEachArtifactPayload( { uniformPlan: [] }, ( artifact ) => {
	const shape: readonly string[] = fingerprintArtifactShape( artifact );
	void shape;
} );

void [
	ARTIFACT_CONTENT_HASH_VERSION,
	ARTIFACT_VARIANT_FIELDS,
	AUXILIARY_MATERIAL_SHAPES,
	COMPUTE_BINDINGS_VERSION,
	CUBE_RENDER_TARGET_AUX_CONFIG_SCHEMA,
	DIAGNOSTIC_GLOBAL_SCHEMA,
	DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE,
	GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR,
	KIND_STATUS.CODEGEN,
	INTERNAL_PASS_SCHEMA,
	internalPassIssues,
	LIGHT_IDENTITY_SCHEMA,
	SHADER_LANGUAGES.GLSL,
	MATERIAL_COMPUTE_VERSION,
	MATERIAL_TEXTURE_PROPS,
	MAX_GRAPH_DEPTH,
	RENDER_BINDING_OWNER_KINDS.MATERIAL,
	SLIM_BUNDLE_FILE_NAME,
	SLIM_THREE_RUNTIME_ENTRIES.PREBUILT,
	VIRTUAL_FULL_THREE_MODULE_ID,
	callsite,
	liveUniformHasAddress,
	storageSnapshotValid,
	bindingOwner,
	materialOwner,
	projectedSelector,
	renderTargetTextureSelector,
	sceneTopology,
	slimSource,
	countFragmentOutputsFromShader( '' ),
	createArtifactVariantPayload( null ),
	createRendererOutputConfig( null, null ),
	describeRenderContext(),
	digest,
	generated,
	harnessDiagnosticEntry,
	harnessDiagnosticIsProduct,
	runtimeDiagnosticGlobals,
	kindInfo( 'frame.time' ),
	materializeArtifactVariantSelectorAdapters( {} ),
	registeredMaterial,
	signature,
	shaderLanguage,
	stableJsonStringify( {} ),
	textureEvidence,
	variantKey,
	validateComputeBindingsDescriptor( null ),
	validation,
];
