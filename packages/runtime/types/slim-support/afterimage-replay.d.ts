export const AFTERIMAGE_HISTORY_TEXTURE_NAME: 'AfterImageNode.old';
export const AFTERIMAGE_OUTPUT_TEXTURE_NAME: 'AfterImageNode.comp';

export type AfterImageReplayTexture = {
	isTexture: true;
	type: number;
	name?: string;
};

export type AfterImageReplayTextures = {
	historyTexture: AfterImageReplayTexture;
	outputTexture: AfterImageReplayTexture;
};

export type PreparedAfterImageReplayResources = AfterImageReplayTextures & {
	inputTexture: AfterImageReplayTexture;
	width: number;
	height: number;
	textureType: number;
};

export class AfterImageReplayResourceError extends Error {
	code: 'TSLP_AFTERIMAGE_REPLAY_RESOURCES_UNAVAILABLE';
	reason: string;
	details: Record<string, unknown>;
	tslPrecompileAfterImageReplay: true;
	constructor( reason: string, message: string, details?: Record<string, unknown> );
}

export function getAfterImageReplayTextures( node: unknown ): AfterImageReplayTextures;
export function prepareAfterImageReplayResources(
	node: unknown,
	renderer: unknown,
): PreparedAfterImageReplayResources;
