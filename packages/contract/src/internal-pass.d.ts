import type { PMREMSupportConfig } from './pmrem-config.js';
import type { VSMSupportConfig } from './vsm-config.js';

export const INTERNAL_PASS_SCHEMA: 'internal-pass@1';

export type InternalPassFamily = 'pmrem' | 'shadow-vsm';
export type PMREMInternalPassStage = 'cubemap' | 'equirect' | 'blur' | 'ggx';
export type VSMInternalPassStage = 'vertical' | 'horizontal';
export type InternalPassStage = PMREMInternalPassStage | VSMInternalPassStage;
export type InternalPassInputKind = 'texture' | 'buffer';

export interface InternalPassBindingAddress {
	role: string;
	group: string;
	binding: string;
}

export interface InternalPassUniformDescriptor extends InternalPassBindingAddress {
	valueType: 'number' | 'float' | 'f32' | 'int' | 'i32' | 'uint' | 'u32' | 'bool'
		| 'vec2' | 'vec3' | 'vec4' | 'color' | 'mat3' | 'mat4';
}

export interface InternalPassTextureTopology {
	dimension: '2d' | '2d-array' | 'cube' | 'cube-array' | '3d';
	format?: string | number | boolean | null;
	internalFormat?: string | number | boolean | null;
	type?: string | number | boolean | null;
	sampleType?: string | number | boolean | null;
	samplingMode?: string | number | boolean | null;
	samplerType?: string | number | boolean | null;
	colorSpace?: string | number | boolean | null;
	layers?: number;
	samples?: number;
	depth?: boolean;
	stencil?: boolean;
	multiview?: boolean;
	comparison?: boolean;
}

export interface InternalPassBufferTopology {
	arrayType: 'Float32Array';
	elementType?: 'f32';
	count?: number;
	itemSize?: number;
	stride?: number;
	byteLength: number;
}

export interface InternalPassTextureInputDescriptor extends InternalPassBindingAddress {
	kind: 'texture';
	topology: InternalPassTextureTopology;
}

export interface InternalPassBufferInputDescriptor extends InternalPassBindingAddress {
	kind: 'buffer';
	topology: InternalPassBufferTopology;
}

export type InternalPassInputDescriptor = InternalPassTextureInputDescriptor | InternalPassBufferInputDescriptor;

export interface InternalPassDescriptorBase {
	schema: typeof INTERNAL_PASS_SCHEMA;
	shape: string;
	uniforms: InternalPassUniformDescriptor[];
	inputs: InternalPassInputDescriptor[];
	output: {
		topology: InternalPassTextureTopology & { depth: boolean };
	};
}

export interface PMREMInternalPassDescriptor extends InternalPassDescriptorBase {
	family: 'pmrem';
	stage: PMREMInternalPassStage;
	config: PMREMSupportConfig;
}

export interface VSMInternalPassDescriptor extends InternalPassDescriptorBase {
	family: 'shadow-vsm';
	stage: VSMInternalPassStage;
	config: VSMSupportConfig;
}

export type InternalPassDescriptor = PMREMInternalPassDescriptor | VSMInternalPassDescriptor;

export interface InternalPassValidationIssue {
	code: string;
	path: string;
	message: string;
}

export interface InternalPassStageDefinition {
	shape: string;
	requiredUniforms: readonly string[];
	optionalUniforms: readonly string[];
	uniformSourceKinds?: Readonly<Record<string, string>>;
	requiredInputs: Readonly<Record<string, InternalPassInputKind>>;
	optionalInputs: Readonly<Record<string, InternalPassInputKind>>;
}

export const INTERNAL_PASS_STAGE_DEFINITIONS: Readonly<Record<InternalPassFamily, Readonly<Record<string, InternalPassStageDefinition>>>>;
export const INTERNAL_PASS_FAMILIES: readonly InternalPassFamily[];
export const INTERNAL_PASS_STAGES: Readonly<Record<InternalPassFamily, readonly string[]>>;
export const INTERNAL_PASS_SHAPES: readonly string[];
export const INTERNAL_PASS_FAMILY_REQUIREMENTS: Readonly<Record<InternalPassFamily, {
	readonly requiredStages: readonly string[];
	readonly oneOfStages: readonly string[];
	readonly requiredAuxiliaryShapes: readonly string[];
}>>;

export class InternalPassContractError extends Error {
	code: string;
	issues: InternalPassValidationIssue[];
	tslPrecompileInternalPass: true;
}

export function internalPassShape( family: string, stage: string ): string | null;
export function getInternalPassStageDefinition( family: string, stage: string ): InternalPassStageDefinition | null;
export function validateInternalPassFamilyStages(
	family: string,
	stages: Iterable<string>,
	options?: { expectedStages?: Iterable<string>, profile?: string, config?: Record<string, unknown> },
): InternalPassValidationIssue[];
export function assertInternalPassFamilyStages(
	family: string,
	stages: Iterable<string>,
	options?: { expectedStages?: Iterable<string>, profile?: string, config?: Record<string, unknown> },
): Set<string>;
export function validateInternalPassDescriptor(
	descriptor: unknown,
	artifact?: Record<string, unknown> | null,
): InternalPassValidationIssue[];
export function assertInternalPassArtifact( artifact: Record<string, unknown> ): InternalPassDescriptor;
export function validateInternalPassFamily(
	artifacts: Iterable<Record<string, unknown>>,
	options?: { family?: string, expectedStages?: Iterable<string>, profile?: string, config?: Record<string, unknown> },
): InternalPassValidationIssue[];
export function assertInternalPassFamily<T extends Record<string, unknown>>(
	artifacts: Iterable<T>,
	options?: { family?: string, expectedStages?: Iterable<string>, profile?: string, config?: Record<string, unknown> },
): T[];
