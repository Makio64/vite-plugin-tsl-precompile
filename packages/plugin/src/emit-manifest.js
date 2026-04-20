/**
 * Manifest codegen — turns the on-disk `artifacts/manifest.json` into a
 * virtual ES module that the Vite plugin serves per-artifact.
 *
 * For `virtual:tsl-precompile/<name>`, emit:
 *
 *   import { update as __update } from './ocean-water.<hash>.updater.js';
 *   const __artifact = { ... };   // inlined artifact JSON
 *   export const __hash = 'sha256:...';
 *   export const name = 'ocean-water';
 *   export const artifact = __artifact;
 *   export const update = __update;
 *
 * The Vite plugin's `load(id)` hook calls this to produce source for each
 * virtual module. This makes each artifact tree-shakeable and lazy-loadable.
 *
 * @module EmitManifest
 */

/**
 * @param {Object} manifestEntry - e.g. { file: 'ocean-water.abcd.json', hash: 'sha256:...' }
 * @param {Object} artifactJson - the parsed contents of the artifact file
 * @param {Object} [opts]
 * @param {string} [opts.updaterImportSpecifier] - relative path to the generated updater module
 * @return {string}
 */
export function emitArtifactModule( manifestEntry, artifactJson, opts = {} ) {

	const { updaterImportSpecifier } = opts;

	const artifactLiteral = JSON.stringify( artifactJson.artifact || artifactJson );
	const hash = artifactJson.__hash || manifestEntry.hash;
	const name = artifactJson.__name || manifestEntry.name || '';

	const lines = [];

	if ( updaterImportSpecifier ) {

		lines.push( `import { update as __update } from ${ JSON.stringify( updaterImportSpecifier ) };` );

	} else {

		lines.push( `const __update = null;  // no updater generated yet (Phase 3 pending for this artifact)` );

	}

	lines.push( '' );
	lines.push( `export const __hash = ${ JSON.stringify( hash ) };` );
	lines.push( `export const name = ${ JSON.stringify( name ) };` );
	lines.push( `export const artifact = ${ artifactLiteral };` );
	lines.push( `export const update = __update;` );
	lines.push( '' );
	// Default export mirrors __hash/name/artifact/update for simpler consumers.
	lines.push( `export default { __hash, name, artifact, update };` );
	lines.push( '' );

	return lines.join( '\n' );

}
