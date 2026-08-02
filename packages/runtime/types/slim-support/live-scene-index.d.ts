export {
	createLiveSceneIndex,
	collectMaterialNodeTextures,
	textureImageReady,
	textureImageSrc,
	healTextureImage,
} from '../index.js';

export function newFallbackTextureImage(): {
	data: Uint8Array;
	width: 1;
	height: 1;
};

export function basenameFromUrl( value: unknown ): string;
