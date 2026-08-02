export {
	clearTextureViewCache,
	invalidateTextureResourceBindings,
	markTextureInitialized,
	shareGPUTextureEntry,
	sharePMREMGPUTexture,
	shareShadowGPUTextureIntoSlim,
} from '../index.js';

export function isBorrowedShadowRenderTargetTexture( renderer: unknown, texture: unknown ): boolean;
