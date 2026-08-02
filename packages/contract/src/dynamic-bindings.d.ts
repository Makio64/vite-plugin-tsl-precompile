import type {
	ContractIssue,
	DynamicBindingDescriptor,
	StringRecord,
} from './types.js';

export const LIVE_UNIFORM_CALLSITE_IDENTITY_SCHEMA: 'uniform-callsite@1';
export const LIVE_UNIFORM_NODE_IDENTITY_SYMBOL_KEY: '@tsl-precompile/runtime/live-uniform-node-identity@1';
export const STORAGE_BUFFER_SNAPSHOT_HASH_SCHEMA: 'storage-buffer-snapshot@1';
export const VIEWPORT_TEXTURE_IDENTITY_SCHEMA: 'viewport-reference@1';

export function canonicalTextureImageSource(
	value: string,
	baseHref?: string | null,
): string;
export function textureImageSourceAliases(
	value: string,
	baseHref?: string | null,
): string[];
export function textureImageSourcesMatch(
	left: string,
	right: string,
	baseHref?: string | null,
): boolean;

export const DYNAMIC_BINDING_TARGET: Readonly<{
	UNIFORM_SLOT: 'uniform-slot';
	SAMPLED_TEXTURE: 'sampled-texture';
	STORAGE_TEXTURE: 'storage-texture';
	STORAGE_BUFFER: 'storage-buffer';
	SAMPLER: 'sampler';
}>;

export const DYNAMIC_BINDING_PHASE: Readonly<{
	CODEGEN_UPDATE: 'codegen-update';
	HYDRATE: 'hydrate';
	UPDATE_BEFORE: 'update-before';
	LATE_REBIND: 'late-rebind';
}>;

export const DYNAMIC_BINDING_DESCRIPTORS: Readonly<Record<string, DynamicBindingDescriptor>>;

export function createLiveUniformCallsiteIdentity(
	moduleIdentity: string,
	callIndex: number,
): string | null;
export function createLiveUniformNodeIdentity(
	callsiteIdentity: string,
	occurrence: number,
): string | null;
export function isLiveUniformCallsiteIdentity( identity: unknown ): identity is string;
export function isLiveUniformNodeIdentity( identity: unknown ): identity is string;
export function hasExactLiveUniformOverlayAddress(
	source: StringRecord | null | undefined,
): boolean;
export function createViewportTextureIdentity( captureReference: string ): string | null;
export function isViewportTextureIdentity( identity: unknown ): identity is string;
export function dynamicBindingDescriptor( kind: unknown ): DynamicBindingDescriptor | null;
export function isDynamicBindingKind( kind: unknown ): kind is string;
export function validateDynamicBindingSource( source: StringRecord | null | undefined ): ContractIssue[];
export function createStorageBufferSnapshotHash( entry: StringRecord | null | undefined ): string | null;
export function validateStorageBufferSnapshot( entry: StringRecord | null | undefined ): ContractIssue[];
export function collectArtifactDynamicBindings( artifact: StringRecord | null | undefined ): StringRecord[];
