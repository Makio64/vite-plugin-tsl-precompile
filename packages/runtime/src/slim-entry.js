/**
 * Checked prebuilt slim entry.
 *
 * Rollup consumes this unguarded wrapper to publish
 * `build/three.webgpu.slim.js`. Applications select it with `slim: true`.
 * The shared source surface keeps prebuilt and tree-shaken modes identical.
 */

export * from './slim-source-common.js';
