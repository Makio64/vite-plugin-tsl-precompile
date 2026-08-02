export function forEachArtifactPayload<T>(
	value: T,
	visitor: ( artifact: Record<string, unknown> ) => void,
): T;
