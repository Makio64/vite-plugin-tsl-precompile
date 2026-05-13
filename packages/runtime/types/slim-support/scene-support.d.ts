import type { ComputeSyncStats } from './compute-sync.d.ts';

export function createSlimSceneSupport( opts: Record<string, unknown> ): {
	liveSceneIndex: unknown;
	pmrem: unknown;
	fallback: unknown;
	diagnostics: Record<string, unknown>;
	indexScene: ( scene: unknown ) => void;
	rememberLiveTexture: ( texture: unknown ) => void;
	getFullRenderer: () => Promise<unknown | null>;
	generatePMREMAsync: ( sourceTexture: unknown, generator?: ( renderer: unknown, sourceTexture: unknown ) => Promise<unknown> | unknown ) => Promise<unknown | null>;
	syncComputeOutputs: ( computeNode: unknown, fullRenderer: unknown, syncOpts?: Record<string, unknown> ) => ComputeSyncStats;
	computeNodeUsesStorageTexture: ( computeNode: unknown, sourceRenderer: unknown ) => boolean;
	shareTexture: ( sourceRenderer: unknown, texture: unknown ) => boolean;
	shareShadowTexture: ( texture: unknown, sourceRenderer: unknown ) => boolean;
	dispose: () => void;
};
