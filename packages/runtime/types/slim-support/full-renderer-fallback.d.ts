export function createFullRendererFallback( opts: Record<string, unknown> ): {
	getRenderer: () => Promise<unknown | null>;
	getModule: () => unknown | null;
	isInitialised: () => boolean;
	dispose: () => void;
};
