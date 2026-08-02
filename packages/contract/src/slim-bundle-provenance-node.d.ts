export const SLIM_BUNDLE_SOURCE_SCHEMA: 'tslp-slim-bundle-sources@1';
export const SLIM_BUNDLE_PROVENANCE_SCHEMA: 'tslp-slim-bundle-provenance@1';
export const SLIM_BUNDLE_BUILD_TOOLCHAIN_VERSION: 'tslp-slim-rollup@2';
export const SLIM_BUNDLE_FILE_NAME: 'three.webgpu.slim.js';
export const SLIM_BUNDLE_METADATA_FILE_NAME: 'three.webgpu.slim.meta.json';
export const SLIM_BUNDLE_PROVENANCE_ERROR_CODES: Readonly<{
	INPUT_MISSING: 'SLIM_BUNDLE_INPUT_MISSING';
	METADATA_INVALID: 'SLIM_BUNDLE_METADATA_INVALID';
	STAMP_MISSING: 'SLIM_BUNDLE_STAMP_MISSING';
	INTEGRITY_MISMATCH: 'SLIM_BUNDLE_INTEGRITY_MISMATCH';
	SOURCE_STALE: 'SLIM_BUNDLE_SOURCE_STALE';
	VERSION_MISMATCH: 'SLIM_BUNDLE_VERSION_MISMATCH';
}>;
export type SlimBundleProvenanceErrorCode =
	( typeof SLIM_BUNDLE_PROVENANCE_ERROR_CODES )[ keyof typeof SLIM_BUNDLE_PROVENANCE_ERROR_CODES ];

export interface SlimBundleVersionIdentity {
	three: string;
	policy: string;
	artifactToolchain: string;
	buildToolchain: string;
}

export interface SlimBundleSourceInputs {
	threeSourceDirectory: string;
	runtimeSourceDirectory: string;
	contractSourceDirectory: string;
	rewriteImplementationFiles: Array<{
		name: string;
		file: string;
	}>;
	rewriteVendorDirectory: string;
	rollupRecipeFiles: readonly { name: string; file: string }[];
}

export interface SlimBundleSourceGroup {
	name: string;
	fileCount: number;
	bytes: number;
	sha256: string;
}

export interface SlimBundlePersistedSourceDescriptor {
	schema: typeof SLIM_BUNDLE_SOURCE_SCHEMA;
	groups: readonly SlimBundleSourceGroup[];
	fingerprint: string;
}

export interface SlimBundleComputedSourceDescriptor extends SlimBundlePersistedSourceDescriptor {
	versions: SlimBundleVersionIdentity;
}

export type SlimBundleSourceDescriptor =
	| SlimBundlePersistedSourceDescriptor
	| SlimBundleComputedSourceDescriptor;

export interface SlimBundleStamp {
	schema: typeof SLIM_BUNDLE_PROVENANCE_SCHEMA;
	sourceFingerprint: string;
	versions: SlimBundleVersionIdentity;
}

export interface SlimBundleMetadata {
	schema: typeof SLIM_BUNDLE_PROVENANCE_SCHEMA;
	source: SlimBundlePersistedSourceDescriptor;
	bundle: { file: string; bytes: number; sha256: string };
	versions: SlimBundleVersionIdentity;
}

export class SlimBundleProvenanceError extends Error {
	readonly code: SlimBundleProvenanceErrorCode;
	constructor( code: SlimBundleProvenanceErrorCode, message: string, options?: { cause?: unknown } );
}

export function createSlimBundleSourceInputs( roots: {
	threePackageRoot: string;
	runtimePackageRoot: string;
	contractPackageRoot: string;
	pluginPackageRoot: string;
} ): SlimBundleSourceInputs;
export function createSlimBundleVersionIdentity( versions: {
	threeVersion: string;
	policyVersion: string;
	artifactToolchainVersion: string;
	buildToolchainVersion?: string;
} ): SlimBundleVersionIdentity;
export function computeSlimBundleSourceFingerprint(
	inputs: SlimBundleSourceInputs,
	versions: SlimBundleVersionIdentity,
): Promise<SlimBundleComputedSourceDescriptor>;
export function formatSlimBundleStamp( input: {
	sourceFingerprint: string;
	versions: SlimBundleVersionIdentity;
} ): string;
export function parseSlimBundleStamp( bundleSource: string | Uint8Array ): SlimBundleStamp;
export function createSlimBundleMetadata( input: {
	bundleSource: string | Uint8Array;
	bundleFile?: string;
	source: SlimBundleSourceDescriptor;
	versions: SlimBundleVersionIdentity;
} ): SlimBundleMetadata;
export function serializeSlimBundleMetadata( metadata: SlimBundleMetadata ): string;
export function parseSlimBundleMetadata( value: unknown ): SlimBundleMetadata;
export function verifySlimBundleProvenance( input: {
	bundleSource: string | Uint8Array;
	metadata: unknown;
	expectedSource: SlimBundleSourceDescriptor;
	expectedVersions: SlimBundleVersionIdentity;
	expectedBundleFile?: string;
} ): { metadata: SlimBundleMetadata; stamp: SlimBundleStamp };
export function sha256Bytes( value: string | Uint8Array ): string;
