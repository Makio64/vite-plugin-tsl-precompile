import type { ContractIssue, StringRecord } from './types.js';

export const MATERIAL_COMPUTE_VERSION: 'material-compute@1';
export const MATERIAL_COMPUTE_DEFERRED_NODES_PROPERTY: '_tslpMaterialComputeNodes';
export const MATERIAL_COMPUTE_MODES: readonly string[];
export const MATERIAL_COMPUTE_RESOURCE_KINDS: readonly string[];
export const MATERIAL_COMPUTE_STORAGE_TEXTURE_TYPES: readonly string[];
export const MATERIAL_COMPUTE_RENDER_BINDING_KINDS: readonly string[];
export const MATERIAL_COMPUTE_UPDATE_TYPES: readonly string[];
export const MATERIAL_COMPUTE_LIFECYCLE_PHASES: readonly string[];
export const MATERIAL_COMPUTE_ACCESS_MODES: readonly string[];
export function findMaterialComputeNodePath(
	material: unknown,
	target: unknown,
): readonly string[] | null;
export function attachDeferredMaterialComputeNodes(
	rootNode: object,
	nodes: readonly unknown[],
): readonly object[];
export function attachDeferredMaterialComputeStatePaths(
	material: object,
	state: unknown,
): readonly ( readonly string[] )[];
export function isSerializableMaterialComputeTextureSource(
	artifact: unknown,
	source: unknown,
): boolean;
export function hasUnresolvedMaterialComputeTexture( artifact: unknown ): boolean;
export function inspectMaterialComputeFamily( artifact: unknown ): StringRecord;
export function validateMaterialComputeDescriptor(
	value: unknown,
	options?: StringRecord & { artifact?: unknown; path?: string },
): readonly ContractIssue[];
