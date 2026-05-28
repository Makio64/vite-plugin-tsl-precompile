export const TRAA_RESOLVE_TEXTURE_NAME: 'TRAANode.resolve';
export const TRAA_HISTORY_TEXTURE_NAME: 'TRAANode.history';
export const TRAA_HISTORY_DEPTH_TEXTURE_NAME: 'TRAANode.history.depth';

export type WireTRAAResolveArtifactStats = {
	outputAttached: number;
	velocityAttached: number;
	historyAttached: number;
	depthAttached: number;
};

export type WireTRAAResolveArtifactOptions = {
	passNodes?: unknown[];
};

export function nameTRAATextures( traaNode: unknown ): void;
export function collectTRAASelfTextures( traaNode: unknown ): Set<unknown>;
export function getTRAABeautyTexture( traaNode: unknown ): unknown | null;
export function getTRAAVelocityTexture( traaNode: unknown ): unknown | null;
export function getTRAACurrentDepthTexture( traaNode: unknown, passNodes?: unknown[] ): unknown | null;
export function wireTRAAResolveArtifact(
	artifact: unknown,
	traaNode: unknown,
	opts?: WireTRAAResolveArtifactOptions,
): WireTRAAResolveArtifactStats;
