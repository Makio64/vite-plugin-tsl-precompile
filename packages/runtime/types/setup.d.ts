/** Options for the conditional `@tsl-precompile/runtime/setup` entry. */
export interface SetupPrecompileOptions {
	/** The `WebGPURenderer` instance. May be passed before or after `init()`. */
	renderer: unknown;
	/** Advanced namespace override. The entry imports the active `three/webgpu` namespace by default. */
	three?: unknown;
	/** Custom dev-capture endpoint. Default: `'/__tsl-precompile/capture'`. */
	devEndpoint?: string;
	/** Automatically capture renderer-output topologies after real renders. Default: `true`; disable only for named manual output capture. */
	captureRendererOutput?: boolean;
	/** `true` exposes `captureAux()`; an object is forwarded as auxiliary capture options. */
	aux?: boolean | Record<string, unknown>;
	/** Required only when `aux` is truthy. */
	scene?: unknown;
	/** Required only when `aux` is truthy. */
	camera?: unknown;
}

export interface SetupPrecompileResult {
	/** Resolves after dev marker registration; already resolved in production. */
	ready: Promise<void>;
	/** Captures auxiliary artifacts in development and resolves to `[]` in production. */
	captureAux: ( extraOpts?: Record<string, unknown> ) => Promise<unknown[]>;
	/** Return a synchronous snapshot of development capture activity. */
	captureStatus: () => import('./index.js').DevCaptureStatus;
	/** Resolve when a new capture wave has completed and remained idle. */
	waitForCaptureSettled: ( opts?: import('./index.js').WaitForCaptureSettledOptions ) => Promise<import('./index.js').DevCaptureStatus>;
	/** Replaces the active development renderer; a no-op in production. */
	setRenderer: ( renderer: unknown ) => void;
}

/**
 * Install development capture synchronously. Vite resolves this call to a
 * compiler-free no-op in production builds.
 */
export function setupPrecompile( opts: SetupPrecompileOptions ): SetupPrecompileResult;

// Apply the Material.precompile() module augmentation without changing the
// JavaScript dependency boundary of this subpath.
export type {
	DevCaptureStatus,
	PrecompileCaptureContext,
	WaitForCaptureSettledOptions,
} from './index.js';
