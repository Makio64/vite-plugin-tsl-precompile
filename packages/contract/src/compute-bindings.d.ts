import type { ContractIssue, StringRecord } from './types.js';

export const COMPUTE_BINDINGS_VERSION: 'compute-bindings@1';
export const COMPUTE_BINDING_TARGETS: readonly string[];
export const COMPUTE_BINDING_TEXTURE_TYPES: readonly string[];
export function compareComputeBindingEntries( left: StringRecord, right: StringRecord ): number;
export function validateComputeBindingsDescriptor(
	descriptor: unknown,
	options?: { root?: string; artifact?: unknown },
): readonly ContractIssue[];
