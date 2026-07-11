/**
 * Version of the artifact contract and every tool that reads or writes it.
 *
 * Keep this as the single version source for capture, plugin codegen, and the
 * browser runtime.  It intentionally matches the public package versions: an
 * artifact produced by a different toolchain version must be recaptured rather
 * than interpreted optimistically.
 */
export const ARTIFACT_TOOLCHAIN_VERSION = '0.1.0';
