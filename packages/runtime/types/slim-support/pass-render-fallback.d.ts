export type RenderPassWithFullRendererArgs = {
	passNode: unknown;
	slimRenderer: unknown;
	fullRenderer: unknown;
	camera?: unknown;
	beforeRender?: () => void;
	onError?: ( err: unknown ) => void;
};

export type SharePassRenderTargetTexturesArgs = {
	passNode: unknown;
	slimRenderer: unknown;
	fullRenderer: unknown;
	shareDepth?: boolean;
	diagnostics?: Record<string, unknown>;
	onError?: ( err: unknown, texture?: unknown ) => void;
};

export type SharePassRenderTargetTexturesStats = {
	texturesShared: number;
	depthShared: boolean;
};

export function renderPassWithFullRenderer( args: RenderPassWithFullRendererArgs ): boolean;
export function sharePassRenderTargetTextures( args: SharePassRenderTargetTexturesArgs ): SharePassRenderTargetTexturesStats;
