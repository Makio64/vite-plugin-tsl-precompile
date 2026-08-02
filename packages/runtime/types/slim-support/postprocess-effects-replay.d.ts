import type { EffectHandler, EffectSubPass } from './postprocess-effects.js';

export type PostprocessMiss = {
	shape: string;
	reason: string;
};

export type PreparedEffectSubPass = {
	handler: string;
	shape: string;
	config: Record<string, unknown> | null;
	sourceMaterial: unknown;
	replacement: unknown;
};

export type PreparePrecompiledPostprocessArgs = {
	postProcessing?: { outputNode?: unknown };
	outputNode?: unknown;
	loadAux: ( shape: string, configHash: string ) => unknown;
	PrecompiledMaterial: new ( artifact: unknown ) => unknown;
	auxConfigHash?: string;
	sharedContext?: unknown;
	renderer?: unknown;
	passNodes?: unknown[];
	diagnostics?: { byHandler?: Record<string, { prepared: number; missed: number }> } & Record<string, unknown>;
};

export type PreparePrecompiledPostprocessResult = {
	effects: number;
	prepared: PreparedEffectSubPass[];
	missed: PostprocessMiss[];
};

export type PrepareEffectNodeForReplayOptions = {
	loadAux: ( shape: string, configHash: string ) => unknown;
	PrecompiledMaterial: new ( artifact: unknown ) => unknown;
	auxConfigHash?: string;
	sharedContext?: unknown;
	renderer?: unknown;
	passNodes?: unknown[];
	effectIndex?: number;
};

export type PrepareEffectNodeForReplayResult = {
	prepared: PreparedEffectSubPass[];
	missed: PostprocessMiss[];
	alreadyPrepared: boolean;
};

export type LiveSidecarWireStats = {
	uniformsMatched: number;
	updateNodes: number;
	updateBeforeNodes: number;
	updateAfterNodes: number;
};

export function preparePrecompiledPostprocess( args: PreparePrecompiledPostprocessArgs ): PreparePrecompiledPostprocessResult;
export function prepareEffectNodeForReplay( handler: EffectHandler, node: unknown, opts: PrepareEffectNodeForReplayOptions ): PrepareEffectNodeForReplayResult;
export { refreshPreparedPostprocessResources } from './postprocess-resource-refresh.js';
export type { RefreshPreparedPostprocessResourcesOptions, RefreshPreparedPostprocessResourcesResult } from './postprocess-resource-refresh.js';
export function makePrecompiledAuxMaterial( shape: string, sourceMaterial: unknown, opts: PrepareEffectNodeForReplayOptions ): unknown | null;
export function cloneAuxArtifact<T = unknown>( artifact: T ): T;
export function wireLiveNodeSidecarsToArtifact( artifact: unknown, sourceMaterial: unknown, opts?: { overlay?: boolean } ): LiveSidecarWireStats;
export function artifactLooksLikeRetroPassMaterial( artifact: unknown ): boolean;

export { listAux, findAux } from '../index.js';
export { collectEffectNodes, findEffectHandler, getEffectHandlers } from './postprocess-effects.js';
export type { EffectHandler, EffectSubPass };
