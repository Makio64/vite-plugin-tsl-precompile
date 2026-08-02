export type RefreshPreparedPostprocessResourcesResult = {
	phase: 'before-update' | 'after-update';
	ready: boolean;
	changed: number;
	invalidated: number;
	relinked: number;
	rewired: number;
	resources: number;
	reasons: string[];
};

export type RefreshPreparedPostprocessResourcesOptions = {
	phase?: 'before-update' | 'after-update';
	frame?: { renderer?: unknown; context?: { passNodes?: unknown[] } };
	renderer?: unknown;
	passNodes?: unknown[];
};

/** @internal Records replacement state consumed by the public refresh helper. */
export function rememberPreparedPostprocessResources(
	node: unknown,
	state: {
		handler?: unknown;
		entries?: unknown[];
		opts?: Record<string, unknown>;
	},
): void;

export function refreshPreparedPostprocessResources(
	node: unknown,
	opts?: RefreshPreparedPostprocessResourcesOptions,
): RefreshPreparedPostprocessResourcesResult;
