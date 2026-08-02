import type { StringRecord } from './types.js';

export const CUBE_RENDER_TARGET_AUX_CONFIG_SCHEMA: 'cube-render-target@1';
export function createCubeRenderTargetAuxConfig(
	texture: object,
	cubeRenderTarget?: object | null,
): StringRecord;
export function assertCubeRenderTargetTextureEvidence(
	artifact: object,
	expectedTexture?: object | string | null,
	owner?: string,
): Set<string>;
