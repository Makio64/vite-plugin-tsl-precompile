/**
 * Slim redirect target for three's WebGL fallback backend.
 *
 * `WebGPURenderer.js` statically imports `WebGLBackend` from
 * `renderers/webgl-fallback/WebGLBackend.js`, which transitively pulls the
 * entire WebGL fallback subtree into the bundle: `GLSLNodeBuilder` (a second,
 * GLSL shader compiler), every `WebGL*Utils`, and the legacy GLSL ShaderChunk
 * strings. The slim bundle is WebGPU-only — that backend is never instantiated
 * (it is referenced only under `forceWebGL` or the WebGPU-unavailable fallback
 * closure in `WebGPURenderer.js`, neither of which a precompiled WebGPU app
 * reaches). The rollup config redirects that import here so the whole subtree
 * is severed at its single entry point.
 *
 * A precompiled app cannot run without WebGPU anyway (there is no WebGL TSL
 * path in slim), so constructing this throws loudly per our failure policy.
 *
 * @module SlimStubWebGLBackend
 */

export default class WebGLBackend {

	constructor() {

		throw new Error( '[tsl-precompile/slim] WebGLBackend is stripped from the slim bundle (WebGPU-only). Remove `forceWebGL: true`, ensure WebGPU is available, or use the full three.webgpu.js.' );

	}

}
