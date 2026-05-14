export type EffectSubPass = {
	material?: unknown;
	shape: string;
	config?: Record<string, unknown>;
};

export type EffectHandler = {
	name: string;
	detect: ( node: unknown ) => boolean;
	subPasses: ( node: unknown, index: number ) => EffectSubPass[];
	forceSetup?: ( node: unknown, context?: Record<string, unknown> ) => void;
	wireSubPassUniforms?: ( subPass: EffectSubPass, sourceMaterial: unknown, opts?: Record<string, unknown> ) => void;
	wireSubPassTextures?: ( subPass: EffectSubPass, node: unknown, opts?: Record<string, unknown> ) => void;
	patchUpdateBefore?: ( node: unknown, result: { prepared: unknown[]; missed: unknown[] }, opts?: Record<string, unknown> ) => void;
};

export type EffectNodeMatch = {
	handler: EffectHandler;
	node: unknown;
};

export function registerEffectHandler( handler: EffectHandler ): void;
export function unregisterEffectHandler( name: string ): boolean;
export function getEffectHandlers(): EffectHandler[];
export function findEffectHandler( node: unknown ): EffectHandler | null;
export function collectEffectNodes( root: unknown, opts?: { depthCap?: number } ): EffectNodeMatch[];
