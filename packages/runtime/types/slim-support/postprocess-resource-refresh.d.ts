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

export function refreshPreparedPostprocessResources(
	node: unknown,
	opts?: RefreshPreparedPostprocessResourcesOptions,
): RefreshPreparedPostprocessResourcesResult;
