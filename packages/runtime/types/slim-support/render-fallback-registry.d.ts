export interface SlimRenderFallbackHandler {
	( renderObject: unknown ): unknown | null;
	release?( renderObject: unknown ): void;
}

export function setSlimRenderFallback( handler: SlimRenderFallbackHandler | null | undefined ): void;
export function getSlimRenderFallback(): SlimRenderFallbackHandler | null;
