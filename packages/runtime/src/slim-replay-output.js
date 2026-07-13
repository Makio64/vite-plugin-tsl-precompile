/**
 * Compatibility barrel for compiler-free renderer-output replay.
 *
 * Keep the renderer-owned color transform separate from RenderPipeline so a
 * source-mode application that only imports WebGPURenderer does not retain
 * the postprocess replay closure.
 */

export {
	getReplayRenderOutputCacheKey,
	createReplayRenderOutputMaterial,
} from './slim-replay-renderer-output.js';
export { createReplayRenderPipelineMaterial } from './slim-replay-render-pipeline.js';
