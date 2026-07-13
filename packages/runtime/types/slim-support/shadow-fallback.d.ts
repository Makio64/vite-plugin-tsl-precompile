export type ShadowFallbackUnsupported = {
	kind: string;
	reason: string;
	uuid: string | null;
	name: string;
	type: string;
	detail?: string;
};

export type ShadowFallbackResult = {
	rendered: boolean;
	complete: boolean;
	reused: boolean;
	proxyReused: boolean;
	lightsConsidered: number;
	lightsPopulated: number;
	castersMirrored: number;
	receiversMirrored: number;
	texturesShared: number;
	unsupported: ShadowFallbackUnsupported[];
};

export type PopulateShadowMapsWithFullRendererOptions = {
	scene: unknown;
	camera: unknown;
	slimRenderer: unknown;
	fullRenderer: unknown;
	threeFullModule: Record<string, unknown>;
	resolveShadowMaterial?: ( material: unknown, object: unknown, context: { threeFullModule: Record<string, unknown>; originalMaterial: unknown } ) => unknown;
	cache?: WeakMap<object, unknown> | Map<object, unknown>;
	renderTarget?: unknown;
	discardSize?: number;
	onUnsupported?: ( unsupported: ShadowFallbackUnsupported, value: unknown ) => void;
	onError?: ( err: unknown, detail: { where: string } ) => void;
};

export function populateShadowMapsWithFullRenderer( options: PopulateShadowMapsWithFullRendererOptions ): Promise<ShadowFallbackResult>;
