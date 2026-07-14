/**
 * Artifact loader — resolves material identity to a pre-bundled artifact.
 *
 * At build time the Vite plugin emits `manifest.js`, which imports every
 * artifact module this bundle needs and calls `registerArtifact(name, mod)`.
 *
 * At runtime, the renderer (or PrecompiledMaterial wrapper) calls
 * `getArtifact(name)` to look up the shader + bindings.
 *
 * @module ArtifactLoader
 */

const registry = new Map();

export function registerArtifact( name, artifactModule ) {

	if ( registry.has( name ) ) {

		// Multiple entry points referencing the same name are legal (chunk
		// duplication during code-splitting). We keep the first registration
		// but assert the hash matches — inconsistent hashes would mean the
		// transform emitted two different bakes under the same name.
		const prev = registry.get( name );
		if ( prev.__hash !== artifactModule.__hash ) {

			throw new Error( `[tsl-precompile] artifact "${ name }" registered twice with different hashes (${ prev.__hash } vs ${ artifactModule.__hash }). This is a plugin bug — please report.` );

		}
		return;

	}

	registry.set( name, artifactModule );

}

/**
 * Replace a live development capture after the capture endpoint accepts it.
 * Production registrations remain fail-closed through registerArtifact().
 *
 * @internal
 */
export function __upsertArtifactForDev( name, artifactModule ) {

	registry.set( name, artifactModule );

}

export function getArtifact( name ) {

	return registry.get( name ) || null;

}

/**
 * Enumerate every registered user-material artifact. Used by the inspector
 * panel to render the live captures list.
 *
 * @return {Array<{ name: string, artifact: Object }>}
 */
export function listUserArtifacts() {

	const out = [];
	for ( const [ name, artifactModule ] of registry ) out.push( { name, artifact: artifactModule } );
	return out;

}

export function __resetRegistry() {

	registry.clear();

}
