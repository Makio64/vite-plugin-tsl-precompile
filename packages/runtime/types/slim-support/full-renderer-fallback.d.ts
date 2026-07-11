export interface FullRendererFallbackOptions {
	slimRenderer: object;
	/** Eager full namespace. Prefer loadThreeFullModule so bundlers split the fallback chunk. */
	threeFullModule?: object;
	WebGPURendererClass?: new ( options?: Record<string, unknown> ) => object;
	loadThreeFullModule?: () => Promise<object>;
	shadowMapEnabled?: boolean;
	reuseDevice?: boolean;
	onError?: ( error: unknown ) => void;
}

export function createFullRendererFallback( opts: FullRendererFallbackOptions ): {
	getRenderer: () => Promise<unknown | null>;
	getModule: () => unknown | null;
	isInitialised: () => boolean;
	dispose: () => void;
};
