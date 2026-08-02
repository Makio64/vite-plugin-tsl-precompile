export interface EmitUpdaterOptions {
	writersImport?: string;
	lightWriterImport?: string;
}

export interface UnsupportedUpdaterKind {
	kind: string;
	severity: 'unknown' | 'blocked';
	reason: string;
	byteOffset: number;
	isStaticSnapshot?: boolean;
}

/** Canonical blocked-kind registry shared with the contract package. */
export const DOCUMENTED_BLOCKED_KINDS: typeof import('@tsl-precompile/contract/kinds').BLOCKED_KINDS;

/** Generate one parseable ESM updater for an extracted artifact. */
export function emitUpdaterSource(
	artifact: Record<string, unknown>,
	options?: EmitUpdaterOptions,
): {
	source: string;
	unsupportedKinds: UnsupportedUpdaterKind[];
};
