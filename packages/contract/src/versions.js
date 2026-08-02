/**
 * Version of the artifact hash schema and every tool that reads or writes it.
 *
 * Keep this as the single schema-version source for capture, plugin codegen,
 * and the browser runtime. It is deliberately decoupled from public package
 * SemVer: npm prereleases of the same compatible schema must not invalidate
 * artifacts. Bump it only for an incompatible artifact-contract change.
 */
export const ARTIFACT_TOOLCHAIN_VERSION = '0.1.0';
