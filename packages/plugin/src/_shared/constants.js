/**
 * Shared constants across the plugin's modules.
 */

export const PLUGIN_VERSION = '0.0.0';
export const HASH_SCHEMA_VERSION = 'v1';

// Author-facing API name. If we ever rename `.precompile()` (don't), grep for this constant.
export const MARKER_METHOD_NAME = 'precompile';

// Virtual module prefix consumed by the Vite plugin's `resolveId`/`load` hooks.
export const VIRTUAL_MODULE_PREFIX = 'virtual:tsl-precompile/';
