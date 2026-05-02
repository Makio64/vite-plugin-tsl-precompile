/**
 * Manifest codegen — turns one captured artifact into a virtual ES module
 * that the Vite plugin serves at `virtual:tsl-precompile/<name>`.
 *
 * The virtual module inlines the artifact JSON AND the generated updater
 * source directly (renamed-export to sidestep a separate file emission).
 * That way each `import("virtual:tsl-precompile/<name>")` resolves to a
 * self-contained module: the writers import tree-shakes at the bundler,
 * the artifact is a static literal, and the per-frame update function is
 * inlined static JS.
 *
 * @module EmitManifest
 */

import { emitUpdaterSource } from './emit-updater.js';

/**
 * @param {Object} manifestEntry - e.g. { file: 'ocean-water.abcd.json', hash: 'sha256:...' }
 * @param {Object} artifactJson - the parsed contents of the artifact file — expected to have `artifact`, `__hash`, `__name` keys from the dev capture payload.
 * @param {Object} [opts]
 * @return {{ source: string, unsupportedKinds: Array<{ kind, severity, reason, byteOffset }> }}
 */
export function emitArtifactModule( manifestEntry, artifactJson, _opts = {} ) {

	// The dev-capture server stores { name, hash, artifact } at the top level.
	// Some older artifacts may have the artifact fields at the root — tolerate
	// both shapes.
	const artifact = artifactJson.artifact || artifactJson;
	const hash = artifactJson.__hash || artifact.__hash || manifestEntry.hash;
	const name = artifactJson.__name || artifact.__name || manifestEntry.name || '';

	const artifactLiteral = JSON.stringify( artifact );

	// Generate the per-frame update function. Writers resolve at Vite bundle
	// time via the runtime's package export.
	const { source: updaterSource, unsupportedKinds } = emitUpdaterSource( artifact );

	// The updater module declares `export function update(...)` AND
	// `export const __unsupportedKinds = [...]`. Rename it to `__generatedUpdate`
	// locally so the virtual module's own `export const update = ...` doesn't
	// collide. We do this via a small source rewrite — replacing the emitted
	// `export function update` with `function __generatedUpdate` and appending
	// a re-export.
	const mangledUpdater = updaterSource
		.replace( /export function update\(/, 'function __generatedUpdate(' )
		.replace( /export function updateGroup\(/, 'function __generatedUpdateGroup(' )
		.replace( /export const __unsupportedKinds/, 'const __codegenUnsupportedKinds' );

	const lines = [
		mangledUpdater,
		'',
		`export const __hash = ${ JSON.stringify( hash ) };`,
		`export const name = ${ JSON.stringify( name ) };`,
		`export const artifact = ${ artifactLiteral };`,
		`export const update = __generatedUpdate;`,
		`export const updateGroup = __generatedUpdateGroup;`,
		`export const __unsupportedKinds = ${ JSON.stringify( unsupportedKinds ) };`,
		'',
		`export default { __hash, name, artifact, update, updateGroup, __unsupportedKinds };`,
		'',
	];

	return { source: lines.join( '\n' ), unsupportedKinds };

}
