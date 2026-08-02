export type ContractRecord = Record<PropertyKey, unknown>;
export type StringRecord = Record<string, unknown>;

export interface ArtifactModule<TArtifact extends object = StringRecord> {
	artifact: TArtifact;
}

export interface ContractIssue {
	code: string;
	message: string;
	path?: string;
	kind?: string;
	field?: string;
}

export interface ArtifactValidationResult {
	ok: boolean;
	errors: ContractIssue[];
	warnings: ContractIssue[];
	sourceKinds: readonly string[];
}

export type NumericTypedArray =
	| Int8Array
	| Uint8Array
	| Uint8ClampedArray
	| Int16Array
	| Uint16Array
	| Int32Array
	| Uint32Array
	| Float32Array
	| Float64Array;

export interface KindDescriptor {
	kind: string;
	status: 'codegen' | 'runtime-texture' | 'runtime-dynamic' | 'blocked' | 'alias';
	reason?: string;
}

export interface RegisteredBlockedKindDescriptor extends KindDescriptor {
	status: 'blocked';
	reason: string;
}

export interface DynamicBindingDescriptor extends StringRecord {
	kind?: string;
	prefix?: string;
	target: string;
	phase: string;
	owner: string;
	resolver: string;
	required: readonly string[];
	optional: readonly string[];
}

export interface IdentityRemapState {
	identities: Map<string, string>;
	nextByKind: Map<string, number>;
}
