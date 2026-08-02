export interface RenderContextInput {
	renderer?: unknown;
	scene?: unknown;
	camera?: unknown;
	object?: unknown;
	material?: unknown;
	geometry?: unknown;
	renderTarget?: unknown;
	[key: string]: unknown;
}

export function describeRenderContext( context?: RenderContextInput ): Record<string, unknown>;
export function createRenderContextSignature( context?: RenderContextInput ): string;
