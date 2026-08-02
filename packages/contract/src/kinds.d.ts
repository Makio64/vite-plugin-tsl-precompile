import type {
	ArtifactModule,
	ArtifactValidationResult,
	KindDescriptor,
	RegisteredBlockedKindDescriptor,
	StringRecord,
} from './types.js';

export const KIND_STATUS: Readonly<{
	CODEGEN: 'codegen';
	RUNTIME_TEXTURE: 'runtime-texture';
	RUNTIME_DYNAMIC: 'runtime-dynamic';
	BLOCKED: 'blocked';
	ALIAS: 'alias';
}>;
export const RUNTIME_BINDING_KINDS: readonly string[];
export const BLOCKED_KINDS: Readonly<Record<string, string>>;
export const LIGHT_SLOT_KINDS: readonly string[];
export const KINDS: Readonly<Record<string, Readonly<KindDescriptor>>>;
export const CODEGEN_KINDS: readonly string[];
export const RUNTIME_TEXTURE_KINDS: readonly string[];

export function registerKind<TDescriptor extends RegisteredBlockedKindDescriptor>(
	entry: TDescriptor,
): Readonly<TDescriptor>;
export function unregisterKind( kind: string ): boolean;
export function listRegisteredKinds(): readonly Readonly<KindDescriptor>[];
export function kindInfo( kind: unknown ): Readonly<KindDescriptor> | null;
export function isKnownKind( kind: unknown ): kind is string;
export function isBlockedKind( kind: unknown ): boolean;
export function blockedKindReason( kind: unknown ): string | null;
export function collectArtifactSourceKinds( input: unknown ): readonly string[];
export function isArtifactModule( value: unknown ): value is ArtifactModule;
export function isArtifactCollection(
	input: unknown,
	options?: { allowEmpty?: boolean },
): boolean;
export function validateArtifact(
	input: unknown,
	options?: StringRecord & { allowEmptyCollection?: boolean; label?: string },
): ArtifactValidationResult;
export function assertValidArtifact<T>(
	input: T,
	options?: StringRecord & { allowEmptyCollection?: boolean; label?: string },
): T;
