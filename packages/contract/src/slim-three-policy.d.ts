export interface SlimThreeModuleRule {
	readonly id: string;
	readonly sourcePath: string;
	readonly role: string;
	readonly label?: string;
	readonly rewriteFamily?: string;
}

export interface ThreeReleaseProfile {
	readonly id: string;
	readonly channel: 'stable' | 'development';
	readonly packageVersion: string;
	readonly revision: string;
	readonly gitCommit: string;
	readonly gitTree: string;
	readonly objectFormat: 'sha1';
	readonly ref: string;
	readonly sourceFingerprint: string;
}
export const SLIM_THREE_POLICY_VERSION: 'slim-three-policy@13';
export const SLIM_THREE_PACKAGE_VERSION: '0.186.1';
export const SLIM_THREE_TYPES_PACKAGE_VERSION: '0.186.0';
export const SLIM_THREE_PEER_RANGE: '0.186.0 || 0.186.1';
export const THREE_RELEASE_PROFILES: Readonly<{
	stable: Readonly<ThreeReleaseProfile>;
	development: Readonly<ThreeReleaseProfile>;
}>;
export function resolveSlimThreeRelease( identity?: {
	packageVersion?: string;
	revision?: string;
	sourceCommit?: string;
} ): Readonly<ThreeReleaseProfile> | null;
export const SLIM_THREE_RUNTIME_ENTRIES: Readonly<{
	PREBUILT: '@tsl-precompile/runtime/slim';
	SOURCE: '@tsl-precompile/runtime/slim/source';
	STUBS: '@tsl-precompile/runtime/slim-stubs';
}>;
export const SLIM_THREE_SOURCE_GUARD_MODULE_ID: 'virtual:tsl-precompile/__slim-source';
export const SLIM_THREE_MODULE_ROLES: Readonly<{
	REWRITE: 'rewrite';
	COMPILER: 'compiler';
	REPLAY_ADAPTER: 'replay-adapter';
}>;
export const SLIM_THREE_REWRITE_TARGETS: readonly Readonly<SlimThreeModuleRule>[];
export const SLIM_THREE_COMPILER_MODULES: readonly Readonly<SlimThreeModuleRule>[];
export const SLIM_THREE_REPLAY_ADAPTER_MODULES: readonly Readonly<SlimThreeModuleRule>[];

export function normalizeSlimThreeSourceModuleId( id: unknown ): string | null;
export function isSlimThreeSourceModule( id: unknown ): boolean;
export function isSlimThreeRetainedNodeRuntimeModule( id: unknown ): boolean;
export function isSlimThreeBareBuildModule( id: unknown ): boolean;
export function resolveSlimThreeSourceModuleId( id: unknown, importer?: unknown ): string | null;
export function getSlimThreeRewriteTarget(
	id: unknown,
	importer?: unknown,
): Readonly<SlimThreeModuleRule> | null;
export function getSlimThreeCompilerModule(
	id: unknown,
	importer?: unknown,
): Readonly<SlimThreeModuleRule> | null;
export function getSlimThreeReplayAdapterModule(
	id: unknown,
	importer?: unknown,
): Readonly<SlimThreeModuleRule> | null;
export function getSlimThreeCompilerModuleById( id: unknown ): Readonly<SlimThreeModuleRule> | null;
export function getSlimThreeReplayAdapterModuleById( id: unknown ): Readonly<SlimThreeModuleRule> | null;
