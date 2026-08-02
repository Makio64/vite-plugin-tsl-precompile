export {
	PMREM_CUBE_UV_MAPPING,
	isCubeTextureSource,
	isEnvironmentTextureSource,
	isPMREMTexture,
	isPMREMArtifactTextureSource,
	artifactNeedsPMREM,
	artifactPMREMSourceUuids,
	attachPMREMRefsByOrder,
	collectPMREMSourceTexturesInNode,
	collectPMREMSourceTexturesFromMaterial,
	selectPMREMTexturesForArtifact,
	createPMREMSupport,
} from '../index.js';

export const CUBE_REFLECTION_MAPPING: 301;
export const CUBE_REFRACTION_MAPPING: 302;
export const EQUIRECTANGULAR_REFLECTION_MAPPING: 303;
export const EQUIRECTANGULAR_REFRACTION_MAPPING: 304;

export function pushUniqueTexture<TTexture>(
	out: TTexture[],
	texture: TTexture | null | undefined,
): boolean;

export function pmremTexturesForSources<TSource, TTexture>(
	sources: Iterable<TSource> | null | undefined,
	getCachedPMREMForSource: ( source: TSource ) => TTexture | null | undefined,
): TTexture[];

export function textureListSignature(
	textures: readonly unknown[] | null | undefined,
	count?: number,
): string;
