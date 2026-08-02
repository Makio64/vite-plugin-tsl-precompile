export const RENDERER_RENDER_TARGET_TEXTURE_SELECTOR_SCHEMA: 'renderer-render-target-texture@1';

export interface RendererRenderTargetTextureSelector {
	schema: typeof RENDERER_RENDER_TARGET_TEXTURE_SELECTOR_SCHEMA;
	attachment: {
		role: 'color' | 'depth';
		index: number | null;
	};
	target: {
		topology: 'single' | 'mrt' | 'depth-only';
		dimension: '2d' | 'cube' | '2d-array' | '3d';
		mrtCount: number;
	};
	texture: {
		dimension: '2d' | 'cube' | '2d-array' | '3d';
		format: string | number | null;
		type: string | number | null;
		colorSpace: string | number | null;
	};
	hints: {
		name: string | null;
		extent: {
			width: number | null;
			height: number | null;
			depth: number | null;
		};
	};
}

export interface RendererRenderTargetTextureAttachment {
	target: object;
	texture: object;
	role: 'color' | 'depth';
	index: number | null;
	colors: unknown[];
	depthTexture: object | null;
}

export function rendererRenderTargetTextureAttachments(
	renderTarget: unknown,
): RendererRenderTargetTextureAttachment[];

export function createRendererRenderTargetTextureSelector(
	renderTarget: object,
	options?: {
		texture?: object;
		role?: 'color' | 'depth';
		index?: number;
	},
): RendererRenderTargetTextureSelector;

export function rendererRenderTargetTextureSelectorValidationError(
	selector: unknown,
): string | null;

export function isRendererRenderTargetTextureSelector(
	selector: unknown,
): selector is RendererRenderTargetTextureSelector;

export function rendererRenderTargetTextureSelectorsMatch(
	selector: unknown,
	candidateSelector: unknown,
	options?: {
		matchHints?: boolean;
	},
): boolean;
