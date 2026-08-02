export interface PrecompiledShadowUnsupported {
	light: unknown;
	reason: string;
}

export interface PrecompiledShadowResult {
	complete: boolean;
	rendered: boolean;
	lights: number;
	texturesShared?: number;
	unsupported: PrecompiledShadowUnsupported[];
}

export interface PrecompiledShadowSupport {
	populateShadowMaps( scene: unknown, camera: unknown ): PrecompiledShadowResult;
	dispose(): void;
}

export function createPrecompiledShadowSupport(
	options: { renderer: object },
): PrecompiledShadowSupport;
