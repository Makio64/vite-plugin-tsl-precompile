export const DIAGNOSTIC_GLOBAL_SCHEMA: 'tslp-diagnostic-globals@1';

export type DiagnosticGlobalSurface = 'harness' | 'plugin' | 'runtime';
export type DiagnosticGlobalKind = 'counter' | 'flag' | 'state' | 'warning-latch';

export const DIAGNOSTIC_GLOBAL_SURFACES: readonly DiagnosticGlobalSurface[];
export const DIAGNOSTIC_GLOBAL_KINDS: readonly DiagnosticGlobalKind[];
export const PRODUCT_DIAGNOSTIC_GLOBAL_SURFACES: readonly DiagnosticGlobalSurface[];

export interface DiagnosticGlobalEntry {
	readonly name: string;
	readonly surfaces: readonly DiagnosticGlobalSurface[];
	readonly kind: DiagnosticGlobalKind;
	readonly purpose: string | null;
}

export const DIAGNOSTIC_GLOBALS: readonly DiagnosticGlobalEntry[];

export function getDiagnosticGlobal( name: string ): DiagnosticGlobalEntry | null;
export function isDeclaredDiagnosticGlobal( name: string ): boolean;
export function isProductDiagnosticGlobal( name: string ): boolean;
export function listDiagnosticGlobals( options?: { surface?: DiagnosticGlobalSurface | null } ): readonly DiagnosticGlobalEntry[];
export function readDiagnosticGlobal( name: string, scope?: object | null ): unknown;
export function installDiagnosticGlobal<Value>( name: string, value: Value, scope?: object | null ): Value | undefined;
