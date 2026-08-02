export type RendererLightingStats = {
	updated: boolean;
	cpuTiled: boolean;
	cpuClustered: boolean;
	storageAttrs: number;
	artifactsWired: number;
	textureRefsWired: number;
};

export type RendererLightingOptions = {
	diagnostics?: Record<string, unknown>;
	cpuTiledLighting?: boolean;
	cpuClusteredLighting?: boolean;
	wireSceneArtifacts?: boolean;
	wireSceneTextures?: boolean;
	bumpVersion?: boolean;
	allowVec3ToVec4?: boolean;
	guardKey?: string;
	artifactPredicate?: ( artifact: unknown, material: unknown, object: unknown ) => boolean;
	onMaterial?: ( material: unknown, artifact: unknown, count: number ) => void;
	onStorageAttribute?: ( attribute: unknown, node: unknown ) => void;
	onError?: ( err: unknown, where: string ) => void;
};

export type WireStorageAttributesOptions = {
	renderer?: unknown;
	diagnostics?: Record<string, unknown>;
	bumpVersion?: boolean;
	allowVec3ToVec4?: boolean;
	replaceExisting?: boolean;
	artifactPredicate?: ( artifact: unknown, material: unknown, object: unknown ) => boolean;
	onMaterial?: ( material: unknown, artifact: unknown, count: number ) => void;
};

export type WireTiledLightingTextureOptions = {
	renderer?: unknown;
	diagnostics?: Record<string, unknown>;
};

export function collectSceneLights( scene: unknown, camera?: unknown ): unknown[];
export function wireStorageAttributesToSceneArtifacts(
	scene: unknown,
	attributes: unknown | unknown[],
	opts?: WireStorageAttributesOptions,
): number;
export function wireTiledLightingTextureToScene(
	scene: unknown,
	texture: unknown,
	opts?: WireTiledLightingTextureOptions,
): number;
export function updateRendererLightingForSlim(
	renderer: unknown,
	scene: unknown,
	camera: unknown,
	opts?: RendererLightingOptions,
): RendererLightingStats;
