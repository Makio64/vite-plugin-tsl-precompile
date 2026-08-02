/**
 * Legacy redirect target retained for package-file compatibility. Current
 * slim profiles keep Three's real WebGL backend and rewrite out only its live
 * GLSL builder. Nothing routes to this module; an old deep import fails with
 * an actionable migration message.
 *
 * @module SlimStubWebGLBackend
 */

export default class WebGLBackend {

	constructor() {

		throw new Error( '[tsl-precompile/slim] This legacy WebGLBackend stub is not a renderer entry. Import WebGLBackend or WebGPURenderer from the normal slim entry.' );

	}

}
