export interface SlimThreeModuleRule {
	readonly id: string;
	readonly sourcePath: string;
	readonly role: string;
	readonly label?: string;
	readonly rewriteFamily?: string;
}

export const SLIM_THREE_POLICY_VERSION: 'slim-three-policy@12';
export const SLIM_THREE_PACKAGE_VERSION: '0.185.1';
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
