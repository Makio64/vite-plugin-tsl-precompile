/**
 * `__applyPrecompiled(material, artifactModule, expectedHash)` — injected by
 * the Babel transform in place of every `.precompile(name)` call.
 *
 * Responsibilities:
 *   1. Hash gate: assert `artifactModule.__hash === expectedHash`. Mismatch
 *      means the build somehow shipped a stale artifact — throw with a
 *      clear migration message.
 *   2. Wrap the material in a PrecompiledMaterial shim so three.js's renderer
 *      picks up the baked shader + bindings instead of running the builder.
 *   3. Register the artifact in the module-scoped registry so the renderer's
 *      cache-key resolver can find it.
 *
 * This file is intentionally tiny — heavy lifting is in the vendored
 * `PrecompiledArtifactRegistry` and `PrecompiledMaterial` (Phase 7 vendors
 * them into this package).
 *
 * @module ApplyPrecompiled
 */

// TODO(Phase 4b): the real implementation wraps the material in a
// PrecompiledMaterial and registers the artifact. This stub carries the
// shape of the eventual API so the Babel transform can target it today.

export function __applyPrecompiled( material, artifactModule, expectedHash ) {

	if ( ! artifactModule || typeof artifactModule !== 'object' ) {

		throw new Error( '[tsl-precompile] __applyPrecompiled: artifactModule is missing. Did the virtual module resolver run?' );

	}

	const shipped = artifactModule.__hash || ( artifactModule.artifact && artifactModule.artifact.__hash );
	if ( shipped !== expectedHash ) {

		throw new Error( `[tsl-precompile] stale artifact detected for material "${ artifactModule.name || '<unnamed>' }": expected hash ${ expectedHash }, bundle shipped ${ shipped || '<missing>' }. Rebuild the project — the on-disk artifact is out of sync with the source.` );

	}

	// Phase 4b: wrap material in PrecompiledMaterial + register.
	// For the initial commit, we attach metadata so downstream code can
	// discover artifacts until PrecompiledMaterial lands in this package.
	material.__precompileArtifact = artifactModule.artifact || artifactModule;
	material.__precompileHash = shipped;

	return material;

}
