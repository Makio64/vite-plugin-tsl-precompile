import type { Material, Object3D } from 'three';

export interface PrecompiledBindingDescriptor {
	name: string;
	kind: 'uniform-buffer' | 'storage-buffer' | 'sampled-texture' | 'sampler' | 'unknown';
	visibility: number;
	textureType: string | null;
	byteLength: number | null;
	access: string | null;
	comparison?: boolean;
	[key: string]: unknown;
}

export interface PrecompiledBindGroupDescriptor {
	name: string;
	bindings: PrecompiledBindingDescriptor[];
}

export interface PrecompiledArtifact {
	version?: number;
	kind?: 'compute' | string;
	cacheKey: number | string;
	shaderLanguage?: 'wgsl' | 'glsl';
	variantKey?: string;
	name?: string;
	vertexShader: string;
	fragmentShader: string;
	computeShader: string;
	attributes: Array<{ name: string; type: string; [key: string]: unknown }>;
	bindings: PrecompiledBindGroupDescriptor[];
	uniformPlan: Array<Record<string, unknown>>;
	meta: Record<string, unknown>;
	[key: string]: unknown;
}

export interface CompileTSLOptions extends Record<string, unknown> {
	noGlobalMRT?: boolean;
	computeNodes?: object[];
	computeBindingResources?: Map<object, Map<string, object> | Record<string, object>>
		| WeakMap<object, Map<string, object> | Record<string, object>>;
	renderPipeline?: object;
	mrtNode?: object;
	renderTargetOverride?: object;
	captureRendererOutput?: boolean;
	rendererOutputConfig?: Record<string, unknown>;
	rendererStateOverride?: {
		toneMapping?: unknown;
		currentColorSpace?: unknown;
	};
	skipNodeUpdatesForMaterials?: object[];
	renderObjectHarvest?: RenderObjectHarvestSession | Promise<RenderObjectHarvestResult>;
	skipWarmupRender?: boolean;
}

export interface CompileTSLArtifacts extends Array<PrecompiledArtifact> {
	byComputeNode?: Map<object, PrecompiledArtifact>;
	renderOutputCapture?: Record<string, unknown>;
}

export interface RenderObjectHarvestResult {
	readonly epoch: number;
	readonly supported: boolean;
	readonly renderer: object;
	readonly requests: readonly unknown[];
	readonly familiesByMaterial: Map<object, unknown>;
	readonly familiesByMaterialUuid: Map<string, unknown>;
}

export interface RenderObjectHarvestSession {
	readonly epoch: number;
	readonly supported: boolean;
	readonly active: boolean;
	finish(): Promise<RenderObjectHarvestResult>;
}

export interface ComputeBindingsDescriptor {
	version: 'compute-bindings@1';
	entries: Array<Record<string, unknown>>;
}

export function beginRenderObjectHarvest(
	renderer: object,
	callbacks?: {
		onRequest?: ( event: unknown ) => void;
		onState?: ( event: unknown ) => void;
	},
): RenderObjectHarvestSession;

export function deriveComputeBindingsDescriptor(
	artifact: PrecompiledArtifact,
	state: object,
	publicResources: Map<string, object> | Record<string, object>,
): ComputeBindingsDescriptor;

export function classifyMaterialShape( material: Material | null | undefined ): string;

export function extractArtifact(
	cacheKey: number,
	state: object,
	material?: Material | null,
	object?: Object3D | null,
	extractionContext?: Record<string, unknown> | null,
): PrecompiledArtifact;

export function annotateRenderOnlyStorageBufferSnapshots(
	artifacts: PrecompiledArtifact[],
	computeStates?: object[] | null,
): { resources: number; aliases: number; bytes: number };

export function extractMaterialComputeDescriptor(
	renderArtifact: PrecompiledArtifact,
	renderState: object,
	computeArtifactsByNode: Map<object, PrecompiledArtifact>,
	computeStatesByNode: Map<object, object>,
	sharedComputeNodes?: Set<object> | null,
	material?: Material | null,
): Record<string, unknown> | null;

export function compileTSL(
	renderer: object,
	scene: object,
	camera: object,
	options?: CompileTSLOptions,
): Promise<CompileTSLArtifacts>;

export function extractComputeArtifact(
	cacheKey: number,
	state: object,
	computeNode: object,
	publicResources?: Map<string, object> | Record<string, object>,
): PrecompiledArtifact;

export function dumpArtifact( artifact: PrecompiledArtifact ): string;

export function injectPrecompiled(
	renderer: object,
	states: Map<number, object>,
): void;
