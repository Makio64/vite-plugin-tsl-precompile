export const AUTO_COMPUTE_MATERIAL_PROPERTIES: readonly string[];
export const MATERIAL_COMPUTE_BINDINGS: symbol;

export type MaterialComputeBinding = {
	object: unknown;
	material: Record<string | symbol, unknown>;
	sourceMaterial: Record<string | symbol, unknown>;
	computeNode: object;
	properties: string[];
};

export type AutoComputeCandidateContext = {
	artifact: unknown;
	material: unknown;
	computeNode: unknown;
	entryIndex: number;
	excludedMatches: unknown[];
};

export type AutoComputeCandidateResolver = (
	entry: Record<string, unknown>,
	candidates: unknown[],
	context: AutoComputeCandidateContext,
) => unknown | undefined;

export type AutoComputeDispatchStats = {
	owners: number;
	nodes: number;
	dispatched: number;
	attributesPrepared: number;
	invalidated: number;
	pending: number;
	ambiguous: number;
	incomplete: number;
	irrelevant: number;
	skipped: number;
	errors: number;
	dispatchResults: unknown[];
};

export type AutoComputeDispatchOptions = {
	bindings?: MaterialComputeBinding[];
	fullRenderer?: unknown;
	includeNonPrecompiled?: boolean;
	resolveCandidate?: AutoComputeCandidateResolver;
	onError?: ( error: unknown, detail: unknown ) => void;
	shouldDispatch?: ( computeNode: object, owners: MaterialComputeBinding[] ) => boolean;
	dispatchOnce?: Set<object>;
	dispatchNode?: ( computeNode: object, owners: MaterialComputeBinding[] ) => unknown | Promise<unknown>;
};

export class AutoComputeBindingError extends Error {
	constructor( code: string, message: string, details?: Record<string, unknown> );
	code: string;
	details: Record<string, unknown>;
	tslPrecompileAutoCompute: true;
}

export function collectMaterialComputeBindings( scene: unknown, options?: { includeNonPrecompiled?: boolean } ): MaterialComputeBinding[];
export function collectWritableComputeStorageAttributes( computeNode: unknown, fullRenderer: unknown, options?: { onError?: ( error: unknown, detail: unknown ) => void } ): {
	status: string;
	attributes: unknown[];
	retryable: boolean;
	error?: unknown;
};
export function artifactHasUnwiredAnonymousComputeAttribute( artifact: unknown ): boolean;
export function prepareMaterialComputeAttributes( material: unknown, computeNode: unknown, fullRenderer: unknown, options?: {
	allowVec3ToVec4?: boolean;
	resolveCandidate?: AutoComputeCandidateResolver;
	onError?: ( error: unknown, detail: unknown ) => void;
} ): Record<string, unknown> & { status: string; prepared: number; retryable: boolean };
export function applyMaterialComputeAttributeBindings( artifactView: unknown, material: unknown ): number;
export function invalidateMaterialComputeBindings( material: unknown ): boolean;
export function createAutoComputeDispatcher( options?: {
	renderer?: unknown;
	maxBootstrapAttempts?: number;
	onError?: ( error: unknown, detail: unknown ) => void;
} ): {
	dispatch: ( scene: unknown, options?: AutoComputeDispatchOptions ) => Promise<AutoComputeDispatchStats>;
	resetMaterial: ( material: unknown ) => void;
};
