import type {
	ComputeInputShareOptions,
	ComputeInputShareStats,
	ComputeSyncOptions,
	ComputeSyncPerPassOptions,
	ComputeSyncStats,
	ComputeSyncPerPassStats,
} from './compute-sync.d.ts';
import type { AutoComputeDispatchOptions, AutoComputeDispatchStats } from './auto-compute.d.ts';
import type { SharePassRenderTargetTexturesStats } from './pass-render-fallback.d.ts';
import type { RendererLightingOptions, RendererLightingStats } from './renderer-lighting.d.ts';
import type { TemporalFrameState } from './temporal-frame.d.ts';
import type { PopulateShadowMapsWithFullRendererOptions, ShadowFallbackResult } from './shadow-fallback.d.ts';

export type SlimSceneSupportDiagnostics = Record<string, unknown> & {
	pmrem?: Record<string, unknown>;
	textureShare?: Record<string, unknown>;
	compute?: Record<string, unknown>;
	loader?: Record<string, unknown>;
	shadow?: Record<string, unknown>;
};

export interface SlimSceneSupportErrorContext {
	where: string;
	detail?: unknown;
	texture?: unknown;
	material?: unknown;
	[ key: string ]: unknown;
}

export interface SlimSceneSupportOptions {
	/** The slim WebGPURenderer. */
	renderer: object;
	/** Eager full `three/webgpu` namespace. Prefer `loadThreeFullModule` so bundlers can split the fallback chunk. */
	threeFullModule?: object;
	/** Optional three namespace whose texture-loader classes should be tracked. */
	threeModule?: object;
	/** Lazy loader for the full `three/webgpu` namespace. */
	loadThreeFullModule?: () => Promise<object>;
	/**
	 * Enable the on-the-side full renderer, or enable it only when a full-three
	 * namespace/loader is configured.
	 * @default 'auto'
	 */
	fullRendererFallback?: boolean | 'auto';
	/** Track textures created by loader classes from the configured three namespaces. @default true */
	textureLoaderTracking?: boolean;
	/** Create the PMREM support helper. @default true */
	pmrem?: boolean;
	/** Enable compute-output synchronization helpers. @default true */
	computeSync?: boolean;
	/** Enable texture-sharing convenience helpers. @default true */
	textureSharing?: boolean;
	/** Mutable diagnostics bag populated by the support helpers. */
	diagnostics?: SlimSceneSupportDiagnostics;
	/** PMREM generator used by `generatePMREMAsync()`. */
	pmremGenerator?: ( renderer: unknown, sourceTexture: unknown ) => Promise<unknown> | unknown;
	/** Optional readiness predicate for PMREM source textures. */
	textureImageReady?: ( sourceTexture: unknown ) => boolean;
	/** Receives non-fatal errors together with the helper operation that raised them. */
	onError?: ( error: unknown, context: SlimSceneSupportErrorContext ) => void;
}

export type RenderPassWithFallbackOptions = {
	fullRenderer?: unknown;
	camera?: unknown;
	beforeRender?: () => void;
	shareTextures?: boolean;
	shareDepth?: boolean;
	onError?: ( err: unknown, texture?: unknown ) => void;
};

export type RenderOffscreenOverrideWithFallbackOptions = {
	fullRenderer?: unknown;
	renderTarget?: unknown;
	beforeRender?: () => void;
	withSourceMaterials?: ( scene: unknown, render: () => void ) => void;
	materialMapper?: ( material: unknown ) => unknown;
	shareTextures?: boolean;
	shareDepth?: boolean;
	onError?: ( err: unknown, texture?: unknown ) => void;
};

export type RenderPassWithFallbackStats = SharePassRenderTargetTexturesStats & {
	rendered: boolean;
};

export type PopulateShadowMapsOptions = Omit<PopulateShadowMapsWithFullRendererOptions, 'scene' | 'camera' | 'slimRenderer' | 'fullRenderer' | 'threeFullModule'> & {
	fullRenderer?: unknown;
	threeFullModule?: Record<string, unknown>;
};

export type MaterialComputeDispatchStats = AutoComputeDispatchStats & ComputeSyncStats & {
	inputTexturesShared: number;
	presentationNeeded: boolean;
};

export type DispatchMaterialComputesOptions = Omit<AutoComputeDispatchOptions, 'dispatchNode'> & {
	shareOptions?: ComputeInputShareOptions;
	syncOptions?: ComputeSyncOptions;
	computeArgs?: unknown[] | ( ( computeNode: object, owners: unknown[] ) => unknown[] );
};

export function createSlimSceneSupport( opts: SlimSceneSupportOptions ): {
	liveSceneIndex: unknown;
	pmrem: unknown;
	fallback: unknown;
	materialCompute: ReturnType<typeof import('./auto-compute.d.ts').createAutoComputeDispatcher>;
	diagnostics: Record<string, unknown>;
	indexScene: ( scene: unknown ) => void;
	rememberLiveTexture: ( texture: unknown ) => void;
	getFullRenderer: () => Promise<unknown | null>;
	ensureFallback: () => Promise<void>;
	installComputeFallback: ( sourceRenderer?: unknown ) => boolean;
	generatePMREMAsync: ( sourceTexture: unknown, generator?: ( renderer: unknown, sourceTexture: unknown ) => Promise<unknown> | unknown ) => Promise<unknown | null>;
	setPMREMGenerator: ( generator: ( renderer: unknown, sourceTexture: unknown ) => Promise<unknown> | unknown ) => void;
	syncComputeOutputs: ( computeNode: unknown, fullRenderer: unknown, syncOpts?: ComputeSyncOptions ) => ComputeSyncStats;
	dispatchMaterialComputes: ( scene: unknown, computeOpts?: DispatchMaterialComputesOptions ) => Promise<MaterialComputeDispatchStats>;
	shareComputeInputs: ( computeNode: unknown, fullRenderer: unknown, shareOpts?: ComputeInputShareOptions ) => ComputeInputShareStats;
	syncComputeOutputsPerPass: ( computeNode: unknown, fullRenderer: unknown, passIndex: number | undefined, syncOpts?: ComputeSyncPerPassOptions ) => ComputeSyncPerPassStats;
	pingPongInvalidate: ( textureA: unknown, textureB: unknown, extraRenderer?: unknown ) => boolean;
	shareInstancedAttributeBuffer: ( attribute: unknown, sourceRenderer: unknown ) => boolean;
	computeNodeUsesStorageTexture: ( computeNode: unknown, sourceRenderer: unknown ) => boolean;
	shareTexture: ( sourceRenderer: unknown, texture: unknown ) => boolean;
	shareShadowTexture: ( texture: unknown, sourceRenderer: unknown ) => boolean;
	populateShadowMaps: ( scene: unknown, camera: unknown, shadowOpts?: PopulateShadowMapsOptions ) => Promise<ShadowFallbackResult>;
	disposeShadowMaps: ( scene?: object ) => Promise<number>;
	updateRendererLighting: ( scene: unknown, camera: unknown, lightingOpts?: RendererLightingOptions ) => RendererLightingStats;
	preparePostprocess: ( prepArgs?: Record<string, unknown> ) => { effects: number; prepared: unknown[]; missed: unknown[] };
	wirePostprocess: ( wireArgs?: Record<string, unknown> ) => { effects: number; wired: unknown[]; missed: unknown[] };
	renderPassWithFallback: ( passNode: unknown, passOpts?: RenderPassWithFallbackOptions ) => Promise<RenderPassWithFallbackStats>;
	renderOffscreenOverrideWithFallback: ( scene: unknown, camera: unknown, offscreenOpts?: RenderOffscreenOverrideWithFallbackOptions ) => Promise<RenderPassWithFallbackStats>;
	pinClock: ( t: number | null | undefined ) => void;
	unpinClock: () => void;
	withTemporalFrame: <T>( options: { frameId?: number | string; renderId?: number | string; time?: number; advance?: boolean }, callback: ( state: TemporalFrameState ) => T, extraRenderers?: unknown | unknown[] ) => T;
	dispose: () => Promise<void>;
};

export function pinClock( t: number | null | undefined ): void;
export function unpinClock(): void;
