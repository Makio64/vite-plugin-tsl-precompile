export const SHADER_LANGUAGES: Readonly<{
	WGSL: 'wgsl';
	GLSL: 'glsl';
}>;

export type ShaderLanguage = typeof SHADER_LANGUAGES[keyof typeof SHADER_LANGUAGES];
export type ShaderBackend = 'webgpu' | 'webgl';

export const SHADER_LANGUAGE_BACKENDS: Readonly<Record<ShaderLanguage, ShaderBackend>>;

export function detectShaderLanguage( source: unknown ): ShaderLanguage | null;
export function stabilizeWgslBufferIdentifiers( source: string ): string;
export function detectArtifactShaderLanguage( artifact: object | null | undefined ): ShaderLanguage | null;
export function shaderLanguageBackend( shaderLanguage: unknown ): ShaderBackend | null;
export function createBackendAwareVariantKey(
	cacheKey: string | number,
	shaderLanguage: ShaderLanguage,
	layout?: { fragmentShader?: string; mrtOutputCount?: number; mrtOutputNames?: readonly string[]; mrtBlendModes?: Record<string, number> } | null,
): string;
export function resolveArtifactVariantKey( artifact: object | null | undefined ): string | null;
