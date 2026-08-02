export interface SlimRewriteRuntimeModuleRule {
	readonly id: string;
	readonly virtualId: string;
	readonly runtimeFile: string;
}

export interface SlimRewriteResult {
	code: string | null;
	map: object | null;
	warning: string | null;
	noop?: boolean;
}

export function getSlimRewriteRuntimeModuleRule(
	id: string,
): SlimRewriteRuntimeModuleRule | null;

export function rewriteThreeSource(
	code: string,
	id: string,
	options: {
		threeVersion: string;
		pluginVersion?: string;
	},
): SlimRewriteResult | null;
