export type LiveNodeDependency = { node: unknown; metadata: unknown };
export function attachLiveNodeDependency<T>( owner: T, dependency: unknown, metadata?: unknown ): T;
export function getLiveNodeDependencies( owner: unknown ): LiveNodeDependency[];
