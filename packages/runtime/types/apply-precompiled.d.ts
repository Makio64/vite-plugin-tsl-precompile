export { __applyPrecompiled } from './index.js';

/** @internal Development validation bridge. */
export function __applyPrecompiledWithValidation(
	material: unknown,
	artifactModule: unknown,
	expectedHash: string,
	validateArtifactHook: ( artifact: unknown, label: string ) => void,
): unknown;

export function collectLiveMaterialTextures( sourceMaterial: unknown ): Map<string, unknown>;
export function catalogueArtifactTextureRefs( artifact: unknown, sourceMaterial: unknown ): number;
export function collectReflectorBaseNodes( material: unknown ): unknown[];
