import type { PrecompiledComputeArtifact } from './precompiled-compute-runner.js';

export interface ComputeCaptureEntry {
	/** Stable artifact name used by `virtual:tsl-precompile/<name>`. */
	name: string;
	/** Raw development TSL ComputeNode. */
	node: object;
	/** Exact caller-owned resources keyed by the public production API. */
	resources: Map<string, unknown> | Record<string, unknown>;
}

export interface ComputeCapture {
	name: string;
	hash: string;
	artifact: PrecompiledComputeArtifact;
}

export interface PrecompileComputesOptions {
	scene: object;
	camera: object;
	threeVersion?: string;
	pluginVersion?: string;
	three?: { REVISION?: string | number };
	devEndpoint?: string;
	/** Dependency injection seams intended for tests/custom development hosts. */
	compileTSL?: ( renderer: object, scene: object, camera: object, options: Record<string, unknown> ) => Promise<unknown>;
	fetch?: ( input: string, init: Record<string, unknown> ) => Promise<{ ok: boolean; status?: number; text?: () => Promise<string> }>;
}

export interface PrecompileComputeOptions extends PrecompileComputesOptions {
	name: string;
	resources: Map<string, unknown> | Record<string, unknown>;
}

export function precompileComputes(
	renderer: object,
	entries: readonly ComputeCaptureEntry[],
	opts: PrecompileComputesOptions,
): Promise<ComputeCapture[]>;

export function precompileCompute(
	renderer: object,
	node: object,
	opts: PrecompileComputeOptions,
): Promise<ComputeCapture>;
