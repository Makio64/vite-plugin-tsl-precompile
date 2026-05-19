export type ComputeSyncStats = {
	texturesShared: number;
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

export type ComputeInputShareOptions = {
	diagnostics?: Record<string, unknown>;
	bumpVersion?: boolean;
	onSampledTexture?: ( texture: unknown, binding: unknown ) => void;
	onError?: ( err: unknown, textureOrBinding?: unknown ) => void;
};

export type ComputeSyncOptions = {
	generateMipmaps?: boolean;
	onStorageTexture?: ( texture: unknown, binding: unknown ) => void;
	onStorageAttr?: ( attribute: unknown ) => void;
	onError?: ( err: unknown ) => void;
};

export type ComputeSyncPerPassOptions = ComputeSyncOptions & {
	onPass?: ( passIndex: number, stats: ComputeSyncStats ) => void;
};

export type WireArtifactStorageBufferOptions = {
	bumpVersion?: boolean;
	allowVec3ToVec4?: boolean;
};

export function getComputeBindGroups( computeNode: unknown, fullRenderer: unknown ): unknown[];
export function computeNodeUsesStorageTexture( computeNode: unknown, fullRenderer: unknown ): boolean;
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
