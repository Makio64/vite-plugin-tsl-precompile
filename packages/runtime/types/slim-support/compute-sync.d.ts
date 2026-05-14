export type ComputeSyncStats = {
	texturesShared: number;
	buffersAdopted: number;
	buffersCopied: number;
};

export type ComputeSyncPerPassStats = ComputeSyncStats & {
	pass: number | null;
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

export function getComputeBindGroups( computeNode: unknown, fullRenderer: unknown ): unknown[];
export function computeNodeUsesStorageTexture( computeNode: unknown, fullRenderer: unknown ): boolean;
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
