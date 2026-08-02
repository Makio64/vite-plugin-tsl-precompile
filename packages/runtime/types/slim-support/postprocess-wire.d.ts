import type { EffectHandler } from './postprocess-effects.js';

export type PostprocessWireMiss = {
	shape: string;
	reason: string;
};

export type WiredEffectSubPass = {
	shape: string;
	name?: string;
	configHash: string;
};

export type WireRegisteredEffectNodeResult = {
	wired: WiredEffectSubPass[];
	missed: PostprocessWireMiss[];
};

export type WirePrecompiledPostprocessResult = {
	effects: number;
	wired: WiredEffectSubPass[];
	missed: PostprocessWireMiss[];
};

export function wirePrecompiledPostprocess( args?: {
	postProcessing?: { outputNode?: unknown };
	outputNode?: unknown;
} ): WirePrecompiledPostprocessResult;
export function wireRegisteredEffectNode(
	handler: EffectHandler,
	node: unknown,
	effectIndex?: number,
): WireRegisteredEffectNodeResult;
export function findPostprocessAux( shape: string, nameOrConfigHash: string ): unknown;
export function collectLiveBloomNodes( root: unknown ): unknown[];
export function wireBloomNode( bloomNode: unknown, opts?: { bloomIndex?: number } ): WireRegisteredEffectNodeResult;
