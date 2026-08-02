export { registerArtifact, getArtifact, listUserArtifacts } from './index.js';

/** @internal Development-only artifact replacement seam. */
export function __upsertArtifactForDev( name: string, artifactModule: unknown ): void;

/** @internal Test-only registry reset. */
export function __resetRegistry(): void;
