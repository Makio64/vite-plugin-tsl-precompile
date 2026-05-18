export type SlimDiagnosticsBag = Record<string, unknown> & {
	colorTransferFallbacks?: Record<string, unknown>;
	healedNullTextureImages?: number;
};

export function getSlimDiagnosticsBag(): SlimDiagnosticsBag | null;
export function isDiagnosticChannelEnabled( channel: string ): boolean;
export function recordDiagnostic( channel: string, event: unknown ): boolean;
export function resetSlimDiagnostics(): void;
export function snapshotSlimDiagnostics(): SlimDiagnosticsBag | null;
