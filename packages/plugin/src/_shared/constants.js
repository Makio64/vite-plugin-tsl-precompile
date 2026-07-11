/**
 * Shared constants across the plugin's modules.
 */

import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';

// Backwards-compatible names for plugin internals. Both intentionally point to
// the shared contract version so capture, codegen, and runtime cannot drift.
export const PLUGIN_VERSION = ARTIFACT_TOOLCHAIN_VERSION;
export const HASH_SCHEMA_VERSION = ARTIFACT_TOOLCHAIN_VERSION;
export { ARTIFACT_TOOLCHAIN_VERSION };

// Author-facing API name. If we ever rename `.precompile()` (don't), grep for this constant.
export const MARKER_METHOD_NAME = 'precompile';

// Virtual module prefix consumed by the Vite plugin's `resolveId`/`load` hooks.
export const VIRTUAL_MODULE_PREFIX = 'virtual:tsl-precompile/';

// Virtual module that registers every captured aux-pass artifact at
// app-load time. Imported for side-effects by the Babel-transformed
// three.js source files.
export const VIRTUAL_AUX_MODULE_ID = 'virtual:tsl-precompile/__aux';

// Virtual module that pools repeated WGSL strings across generated artifact
// modules. Imported by per-artifact virtual modules when a large shader source
// appears in more than one artifact.
export const VIRTUAL_WGSL_POOL_MODULE_ID = 'virtual:tsl-precompile/__wgsl';
