export type SlimRenderFallbackHandler = ( renderObject: unknown ) => unknown | null;

export function setSlimRenderFallback( handler: SlimRenderFallbackHandler | null | undefined ): void;
export function getSlimRenderFallback(): SlimRenderFallbackHandler | null;
