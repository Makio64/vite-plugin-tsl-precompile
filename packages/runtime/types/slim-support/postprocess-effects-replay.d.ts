import type { EffectHandler, EffectSubPass } from './postprocess-effects.d.ts';

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
export function makePrecompiledAuxMaterial( shape: string, sourceMaterial: unknown, opts: PrepareEffectNodeForReplayOptions ): unknown | null;
export function cloneAuxArtifact<T = unknown>( artifact: T ): T;
export function wireLiveNodeSidecarsToArtifact( artifact: unknown, sourceMaterial: unknown, replacement?: unknown ): LiveSidecarWireStats;

export { listAux, findAux } from '../index';
export { collectEffectNodes, findEffectHandler, getEffectHandlers } from './postprocess-effects.d.ts';
export type { EffectHandler, EffectSubPass };
