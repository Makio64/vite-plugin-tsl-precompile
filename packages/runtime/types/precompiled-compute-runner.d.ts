/** One public location in a `compute-bindings@1` descriptor. */
export interface PrecompiledComputeBindingEntry {
	key: string;
	target: 'storage-buffer' | 'storage-texture' | 'sampled-texture' | 'sampler' | 'uniform-slot';
	group: number;
	binding?: number;
	slot?: number;
	access?: 'readOnly' | 'readWrite' | 'writeOnly';
	arrayType?: string;
	count?: number;
	itemSize?: number;
	byteLength?: number;
	textureType?: '2d' | '2d-array' | '3d' | 'cube';
	dtype?: string;
}

export interface PrecompiledComputeBindingsDescriptor {
	version: 'compute-bindings@1';
	entries: readonly PrecompiledComputeBindingEntry[];
}

export interface PrecompiledComputeArtifact {
	kind: 'compute';
	computeShader: string;
	computeBindings: PrecompiledComputeBindingsDescriptor;
	bindings: readonly unknown[];
	uniformPlan: readonly unknown[];
	dispatchSize?: number | readonly number[] | null;
	workgroupSize?: readonly number[];
	[key: string]: unknown;
}

/** Shape exported by generated `virtual:tsl-precompile/*` modules. */
export interface GeneratedPrecompiledComputeModule<TArtifact extends PrecompiledComputeArtifact = PrecompiledComputeArtifact> {
	artifact: TArtifact;
	updateGroup?: ( frame: unknown, material: unknown, view: DataView, byteOffset: number, groupName: string | null ) => void;
	[key: string]: unknown;
}

/** Mutable holder for scalar uniforms that should change between dispatches. */
export interface PrecompiledComputeUniform<T = unknown> {
	value: T;
}

/**
 * Resources are keyed by `computeBindings.entries[].key`. Storage bindings
 * accept caller-owned Three storage attributes/textures; sampled and sampler
 * bindings accept a caller-owned Three Texture; uniforms accept a raw value
 * or a mutable `{ value }` holder.
 */
export type PrecompiledComputeResources = Record<string, unknown>;

export type PrecompiledComputeDispatchSize = number | readonly number[] | { readonly isIndirectStorageBufferAttribute: true };

export interface PrecompiledComputeRunner<TResources extends PrecompiledComputeResources = PrecompiledComputeResources> {
	readonly renderer: unknown;
	readonly artifact: PrecompiledComputeArtifact;
	readonly resources: TResources;
	readonly node: unknown;
	readonly disposed: boolean;
	dispatch( dispatchSize?: PrecompiledComputeDispatchSize ): unknown;
	dispatchAsync( dispatchSize?: PrecompiledComputeDispatchSize ): Promise<unknown>;
	dispose(): void;
}

/**
 * Bind one generated standalone compute artifact to fixed caller-owned
 * resource identities and dispatch it through a compiler-free slim renderer.
 */
export function createPrecompiledComputeRunner<TResources extends PrecompiledComputeResources = PrecompiledComputeResources>(
	renderer: unknown,
	artifactOrModule: PrecompiledComputeArtifact | GeneratedPrecompiledComputeModule,
	resources: TResources,
): PrecompiledComputeRunner<TResources>;

export default createPrecompiledComputeRunner;
