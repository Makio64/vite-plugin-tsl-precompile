export interface SlimRenderFallbackHandler {
	( renderObject: unknown ): unknown | null;
	release?( renderObject: unknown ): void;
}

export function setSlimRenderFallback( handler: SlimRenderFallbackHandler | null | undefined, owner?: object | null ): void;
export function getSlimRenderFallback( owner?: object | null ): SlimRenderFallbackHandler | null;
