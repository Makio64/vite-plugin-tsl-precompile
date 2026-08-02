import type { InternalPassDescriptor } from '@tsl-precompile/contract/internal-pass';

export type InternalPassLiveValue<T = unknown> = T | ( () => T );

export interface InternalPassBindings {
	uniforms?: Record<string, InternalPassLiveValue>;
	textures?: Record<string, { isTexture: true } | null>;
	buffers?: Record<string, InternalPassLiveValue<ArrayLike<number>>>;
}

export interface InternalPassBindingController<TMaterial = unknown> {
	artifact: Record<string, unknown> & { internalPass: InternalPassDescriptor };
	descriptor: InternalPassDescriptor;
	material: TMaterial | null;
	setUniform( role: string, value: InternalPassLiveValue ): this;
	setTexture( role: string, texture: { isTexture: true } | null ): this;
	setBuffer( role: string, value: InternalPassLiveValue<ArrayLike<number>> ): this;
}

export interface CreateInternalPassMaterialOptions<TMaterial = unknown> {
	PrecompiledMaterial?: new ( artifact: Record<string, unknown> ) => TMaterial;
	name?: string;
}

export class InternalPassBindingError extends Error {
	code: string;
	details: Record<string, unknown>;
	tslPrecompileInternalPass: true;
}

export function cloneInternalPassArtifact<TArtifact extends Record<string, unknown>>( artifact: TArtifact ): TArtifact;
export function bindInternalPassArtifact<TArtifact extends Record<string, unknown>>(
	artifact: TArtifact,
	bindings?: InternalPassBindings,
): InternalPassBindingController;
export function createInternalPassMaterial<TMaterial = unknown>(
	artifact: Record<string, unknown>,
	bindings?: InternalPassBindings,
	opts?: CreateInternalPassMaterialOptions<TMaterial>,
): InternalPassBindingController<TMaterial>;
