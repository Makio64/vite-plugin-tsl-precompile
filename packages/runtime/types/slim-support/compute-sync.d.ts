export type ComputeSyncStats = {
	texturesShared: number;
	buffersAdopted: number;
	buffersCopied: number;
};

export function getComputeBindGroups( computeNode: unknown, fullRenderer: unknown ): unknown[];
export function computeNodeUsesStorageTexture( computeNode: unknown, fullRenderer: unknown ): boolean;
export function syncComputeStorageOutputs(
	computeNode: unknown,
	fullRenderer: unknown,
	slimRenderer: unknown,
	opts?: Record<string, unknown>,
): ComputeSyncStats;
