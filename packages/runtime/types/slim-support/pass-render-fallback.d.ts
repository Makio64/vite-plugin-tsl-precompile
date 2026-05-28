export type RenderPassWithFullRendererArgs = {
	passNode: unknown;
	slimRenderer: unknown;
	fullRenderer: unknown;
	camera?: unknown;
	beforeRender?: () => void;
	onError?: ( err: unknown ) => void;
};

export type RenderOffscreenOverrideWithFullRendererArgs = {
	scene: unknown;
	camera: unknown;
	slimRenderer: unknown;
	fullRenderer: unknown;
	renderTarget?: unknown;
	beforeRender?: () => void;
	withSourceMaterials?: ( scene: unknown, render: () => void ) => void;
	materialMapper?: ( material: unknown ) => unknown;
	shareTextures?: boolean;
	shareDepth?: boolean;
	diagnostics?: Record<string, unknown>;
	onError?: ( err: unknown, texture?: unknown ) => void;
};

export type ShareRenderTargetTexturesArgs = {
	renderTarget: unknown;
	slimRenderer: unknown;
	fullRenderer: unknown;
	shareDepth?: boolean;
	diagnostics?: Record<string, unknown>;
	onError?: ( err: unknown, texture?: unknown ) => void;
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

export type RenderOffscreenOverrideWithFullRendererStats = SharePassRenderTargetTexturesStats & {
	rendered: boolean;
};

export type ShareRenderTargetTexturesStats = SharePassRenderTargetTexturesStats;

export function renderOffscreenOverrideWithFullRenderer( args: RenderOffscreenOverrideWithFullRendererArgs ): RenderOffscreenOverrideWithFullRendererStats;
export function renderPassWithFullRenderer( args: RenderPassWithFullRendererArgs ): boolean;
export function shareRenderTargetTextures( args: ShareRenderTargetTexturesArgs ): ShareRenderTargetTexturesStats;
export function sharePassRenderTargetTextures( args: SharePassRenderTargetTexturesArgs ): SharePassRenderTargetTexturesStats;
