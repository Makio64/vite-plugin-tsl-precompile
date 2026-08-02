export type ComputeSyncStats = {
	texturesShared: number;
	storageAttrs: number;
	buffersAdopted: number;
	buffersCopied: number;
};

export type ComputeSyncPerPassStats = ComputeSyncStats & {
	pass: number | null;
};

export type ComputeInputShareStats = {
	texturesShared: number;
	skippedStorageTextures: number;
	missingTextures: number;
};

export type ComputeBindingLocation = {
	group: number;
	binding: number;
};

export type ComputeBindingDetail = {
	direction: 'input' | 'output';
	kind: 'sampled-texture' | 'storage-texture' | 'storage-buffer';
	shared?: boolean;
	notSlimOwned?: boolean;
	alreadyAvailable?: boolean;
};

export type ComputeBindingFilter = (
	binding: unknown,
	location: ComputeBindingLocation,
	detail: ComputeBindingDetail,
) => boolean;

export type ComputeResourceHook = (
	resource: unknown,
	binding: unknown,
	location: ComputeBindingLocation,
	detail: ComputeBindingDetail,
) => void;

export type ComputeLocatedResourceHook = (
	resource: unknown,
	binding: unknown,
	location: ComputeBindingLocation,
) => void;

export type ComputeInputShareOptions = {
	diagnostics?: Record<string, unknown>;
	bumpVersion?: boolean;
	bindingFilter?: ComputeBindingFilter;
	initializeBindings?: boolean;
	onSampledTexture?: ComputeResourceHook;
	onStorageTexture?: ComputeResourceHook;
	onStorageAttr?: ComputeResourceHook;
	onInputSynced?: ComputeResourceHook;
	onInputNotSlimOwned?: ComputeResourceHook;
	onError?: ( err: unknown, textureOrBinding?: unknown ) => void;
};

export type ComputeSyncOptions = {
	generateMipmaps?: boolean;
	bindingFilter?: ComputeBindingFilter;
	onStorageTexture?: ComputeLocatedResourceHook;
	onStorageAttr?: ComputeLocatedResourceHook;
	onStorageTextureSynced?: ComputeLocatedResourceHook;
	onStorageAttrSynced?: ComputeLocatedResourceHook;
	onOutputSynced?: ComputeResourceHook;
	onError?: ( err: unknown ) => void;
};

export type ComputeSyncPerPassOptions = ComputeSyncOptions & {
	onPass?: ( passIndex: number, stats: ComputeSyncStats ) => void;
};

export type WireArtifactStorageBufferOptions = {
	bumpVersion?: boolean;
	allowVec3ToVec4?: boolean;
	replaceExisting?: boolean;
};

export type AnonymousStorageResourceIdentity = {
	ordinal: number;
	count: number;
};

export function getComputeBindGroups( computeNode: unknown, fullRenderer: unknown ): unknown[];
export function computeNodeUsesStorageTexture( computeNode: unknown, fullRenderer: unknown ): boolean;
export function computeSyncNeedsPresentation( stats: Partial<ComputeSyncStats> & { storageTextures?: number } | null | undefined ): boolean;
export function hasAnonymousStorageResourceIdentity( entry: unknown ): boolean;
export function storageEntryAnonymousResourceIdentity( entry: unknown ): AnonymousStorageResourceIdentity | null;
export function invokeAlignedFullCompute<T>(
	sourceRenderer: unknown,
	fullRenderer: unknown,
	callback: () => T,
): T;
export function syncComputeRendererSize( fullRenderer: unknown, sourceRenderer: unknown ): boolean;
export function shareComputeSampledInputs(
	computeNode: unknown,
	fullRenderer: unknown,
	slimRenderer: unknown,
	opts?: ComputeInputShareOptions,
): ComputeInputShareStats;
export function syncComputeStorageOutputs(
	computeNode: unknown,
	fullRenderer: unknown,
	slimRenderer: unknown,
	opts?: ComputeSyncOptions,
): ComputeSyncStats;
export function syncComputeStorageOutputsPerPass(
	computeNode: unknown,
	fullRenderer: unknown,
	slimRenderer: unknown,
	passIndex: number | undefined,
	opts?: ComputeSyncPerPassOptions,
): ComputeSyncPerPassStats;
export function wireArtifactStorageBuffersFromAttributes(
	artifact: unknown,
	attributes: unknown | unknown[],
	opts?: WireArtifactStorageBufferOptions,
): number;
export function pingPongInvalidate(
	textureA: unknown,
	textureB: unknown,
	renderers: unknown | unknown[],
): boolean;
export function shareInstancedAttributeBufferIntoSlim(
	attribute: unknown,
	fullRenderer: unknown,
	slimRenderer: unknown,
): boolean;
