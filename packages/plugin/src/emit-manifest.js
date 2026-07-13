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

import { collectArtifactDynamicBindings } from '@tsl-precompile/contract/dynamic-bindings';
import { normalizeArtifactLightIdentitiesDeep } from '@tsl-precompile/contract/light-identities';
import { emitUpdaterSource } from './emit-updater.js';
import { VIRTUAL_WGSL_POOL_MODULE_ID } from './_shared/constants.js';
import { emitOptimizedJsonExpression, getExternalWgslRefIdentifiers } from './wgsl-optimize.js';

/**
 * @param {Object} manifestEntry - e.g. { file: 'ocean-water.abcd.json', hash: 'sha256:...' }
 * @param {Object} artifactJson - the parsed contents of the artifact file — expected to have `artifact`, `__hash`, `__name` keys from the dev capture payload.
 * @param {Object} [opts]
 * @return {{ source: string, unsupportedKinds: Array<{ kind, severity, reason, byteOffset }> }}
 */
export function emitArtifactModule( manifestEntry, artifactJson, opts = {} ) {

	// The dev-capture server stores { name, hash, artifact } at the top level.
	// Some older artifacts may have the artifact fields at the root — tolerate
	// both shapes.
	const artifact = artifactJson.artifact || artifactJson;
	const hash = artifactJson.__hash || artifact.__hash || manifestEntry.hash;
	const name = artifactJson.__name || artifact.__name || manifestEntry.name || '';

	// Every variant owns its own uniformPlan, light identity table, and derived
	// dynamic-binding descriptors. Inheriting any of them can pair the selected
	// shader with light evidence or offsets from a different topology.
	const artifactForEmission = attachDynamicBindingsDeep( normalizeArtifactLightIdentitiesDeep( artifact ) );

	const {
		declarations: wgslDeclarations,
		expression: artifactLiteral,
	} = emitOptimizedJsonExpression( artifactForEmission, opts );
	const usedWgslPoolRefs = getExternalWgslRefIdentifiers( artifactLiteral );

	// Generate the per-frame update function. Writers resolve at Vite bundle
	// time via the runtime's package export.
	const { source: updaterSource, unsupportedKinds: rootUnsupportedKinds } = emitUpdaterSource( artifactForEmission );
	const unsupportedKinds = collectVariantUnsupportedKinds( artifactForEmission, rootUnsupportedKinds );

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

	const lines = [];
	if ( usedWgslPoolRefs.length > 0 ) {

		lines.push( `import { ${ usedWgslPoolRefs.join( ', ' ) } } from ${ JSON.stringify( VIRTUAL_WGSL_POOL_MODULE_ID ) };` );
		lines.push( '' );

	}
	lines.push(
		mangledUpdater,
		'',
		`export const __hash = ${ JSON.stringify( hash ) };`,
		`export const name = ${ JSON.stringify( name ) };`,
		...wgslDeclarations,
		`export const artifact = ${ artifactLiteral };`,
		`export const update = __generatedUpdate;`,
		`export const updateGroup = __generatedUpdateGroup;`,
		`export const __unsupportedKinds = ${ JSON.stringify( unsupportedKinds ) };`,
		`export const dynamicBindings = artifact.dynamicBindings;`,
		'',
		`export default { __hash, name, artifact, update, updateGroup, __unsupportedKinds, dynamicBindings };`,
		'',
	);

	return { source: lines.join( '\n' ), unsupportedKinds };

}

function attachDynamicBindingsDeep( artifact ) {

	if ( ! artifact || typeof artifact !== 'object' ) return artifact;
	let changed = false;
	let variants = artifact.variants;
	if ( variants && typeof variants === 'object' ) {

		const nextVariants = {};
		for ( const [ key, variant ] of Object.entries( variants ) ) {

			const next = attachDynamicBindingsDeep( variant );
			nextVariants[ key ] = next;
			if ( next !== variant ) changed = true;

		}
		if ( changed ) variants = nextVariants;

	}
	// Always derive after light normalization so `source.lightIdentity` is part
	// of the frozen descriptor and strict implied-descriptor validation.
	const dynamicBindings = collectArtifactDynamicBindings( artifact );
	if ( dynamicBindings !== artifact.dynamicBindings ) changed = true;
	if ( ! changed ) return artifact;
	return { ...artifact, dynamicBindings, ...( variants !== artifact.variants ? { variants } : {} ) };

}

function collectVariantUnsupportedKinds( artifact, rootUnsupportedKinds ) {

	const unsupported = [ ...rootUnsupportedKinds ];
	const rootKey = artifact.cacheKey === undefined || artifact.cacheKey === null ? null : String( artifact.cacheKey );
	for ( const variant of Object.values( artifact.variants || {} ) ) {

		if ( rootKey !== null && String( variant && variant.cacheKey ) === rootKey ) continue;
		const result = emitUpdaterSource( variant );
		for ( const entry of result.unsupportedKinds ) unsupported.push( {
			...entry,
			variantCacheKey: variant.cacheKey ?? null,
		} );

	}
	const seen = new Set();
	return unsupported.filter( ( entry ) => {

		const key = JSON.stringify( [ entry.kind, entry.severity, entry.reason, entry.byteOffset, entry.variantCacheKey ?? null ] );
		if ( seen.has( key ) ) return false;
		seen.add( key );
		return true;

	} );

}
