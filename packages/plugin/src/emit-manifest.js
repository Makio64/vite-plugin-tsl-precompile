/**
 * Manifest codegen — turns one captured artifact into a virtual ES module
 * that the Vite plugin serves at `virtual:tsl-precompile/<name>`.
 *
 * The virtual module always inlines the artifact JSON. Slim material modules
 * and standalone compute modules also inline the generated updater source
 * (renamed-export to sidestep a separate file emission). Full-Three material
 * modules are passive metadata: codegen still runs for build diagnostics, but
 * replay-only updater/light-helper imports are omitted from the consumer graph.
 *
 * @module EmitManifest
 */

import { isRendererRegistryShape } from '@tsl-precompile/contract/artifact-variants';
import { slimRuntimeEntryForMode } from './slim-source.js';
import { collectArtifactDynamicBindings } from '@tsl-precompile/contract/dynamic-bindings';
import { forEachArtifactPayload } from '@tsl-precompile/contract/artifact-traversal';
import { normalizeArtifactLightIdentitiesDeep } from '@tsl-precompile/contract/light-identities';
import { emitUpdaterSource } from './emit-updater.js';
import { emitSharedUniformGroupKeys } from './shared-uniform-groups.js';
import { VIRTUAL_WGSL_POOL_MODULE_ID } from './_shared/constants.js';
import { emitOptimizedJsonExpression, getExternalWgslRefIdentifiers } from './wgsl-optimize.js';

export const ATTRIBUTE_DESCRIPTOR_MATERIALIZER_IMPORT = '@tsl-precompile/contract/attribute-generators';
export const VARIANT_SELECTOR_ADAPTER_MATERIALIZER_IMPORT = '@tsl-precompile/contract/variant-selector-adapter';
export const DYNAMIC_BINDINGS_MATERIALIZER_IMPORT = '@tsl-precompile/contract/dynamic-bindings';

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
	// Both compiler-free slim modes replace application TSL nodes with inert
	// runtime carriers, so a browser-side graph re-hash cannot equal the full
	// graph captured in dev. Only opt into the call-site validation policy when
	// the capture envelope contains the owners that the Babel transform already
	// verified for this build.
	const sourceValidationMode = Boolean( opts.slim ) &&
		Array.isArray( artifactJson.__sourceOwners ) && artifactJson.__sourceOwners.length > 0
		? 'callsite'
		: null;

	// Standalone compute modules are consumed directly by the compute runner,
	// including in an otherwise full-Three build, and still require updateGroup.
	// Passive emission is therefore limited to marker-owned material artifacts.
	const replayEmission = opts.replay !== false || artifact.kind === 'compute';

	// `dynamicBindings` is a validated, derived view of `uniformPlan`. Persisted
	// captures keep it as a convergence guard, but serializing the same source
	// records twice makes generated modules larger and slower to parse. Drop the
	// redundant literal, then let the shared contract reconstruct the public
	// root/variant views once from the emitted plan. This preserves the virtual-
	// module API without repeating descriptor metadata or source snapshots.
	const normalizedArtifact = normalizeArtifactLightIdentitiesDeep( artifact );
	const artifactForEmission = replayEmission ? omitDynamicBindingsDeep( normalizedArtifact ) : normalizedArtifact;
	const dynamicBindingRestorations = replayEmission ? emitDynamicBindingRestorations( artifactForEmission ) : [];
	const materializeAttributeDescriptors = artifactNeedsAttributeDescriptorMaterialization( artifactForEmission );
	const materializeVariantSelectorAdapter = artifactNeedsVariantSelectorAdapterMaterialization( artifactForEmission );

	const {
		declarations: artifactDeclarations,
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
	const mangledUpdater = replayEmission
		? updaterSource
			.replace( /export function update\(/, 'function __generatedUpdate(' )
			.replace( /export function updateGroup\(/, 'function __generatedUpdateGroup(' )
			.replace( /export const __unsupportedKinds/, 'const __codegenUnsupportedKinds' )
		: null;

	const registerAuxiliary = sourceValidationMode === 'callsite' && isRendererRegistryShape( artifact.materialShape );
	const lines = [];
	if ( registerAuxiliary ) {

		lines.push( `import { registerPrecompiledArtifacts as __registerAuxiliary } from ${ JSON.stringify( slimRuntimeEntryForMode( opts.slim === true ? 'prebuilt' : opts.slim ) ) };` );
		lines.push( 'export { __registerAuxiliary };' );

	}
	if ( dynamicBindingRestorations.some( line => line.includes( '__tslp_collectDynamicBindings(' ) ) ) {

		lines.push( `import { collectArtifactDynamicBindings as __tslp_collectDynamicBindings } from ${ JSON.stringify( DYNAMIC_BINDINGS_MATERIALIZER_IMPORT ) };` );

	}
	if ( materializeAttributeDescriptors ) {

		lines.push( `import { materializeArtifactAttributeDescriptors as __tslp_materializeAttributes } from ${ JSON.stringify( ATTRIBUTE_DESCRIPTOR_MATERIALIZER_IMPORT ) };` );

	}
	if ( materializeVariantSelectorAdapter ) {

		lines.push( `import { materializeArtifactVariantSelectorAdapters as __tslp_materializeVariantSelectors } from ${ JSON.stringify( VARIANT_SELECTOR_ADAPTER_MATERIALIZER_IMPORT ) };` );

	}
	if ( usedWgslPoolRefs.length > 0 ) {

		lines.push( `import { ${ usedWgslPoolRefs.join( ', ' ) } } from ${ JSON.stringify( VIRTUAL_WGSL_POOL_MODULE_ID ) };` );
		lines.push( '' );

	}
	if ( ! replayEmission ) {

		lines.push(
			`export const __hash = ${ JSON.stringify( hash ) };`,
			`export const name = ${ JSON.stringify( name ) };`,
			`export const __sourceValidationMode = ${ JSON.stringify( sourceValidationMode ) };`,
			...artifactDeclarations,
			`export const artifact = ${ artifactLiteral };`,
			...( materializeAttributeDescriptors ? [ '__tslp_materializeAttributes( artifact );' ] : [] ),
			...( materializeVariantSelectorAdapter ? [ '__tslp_materializeVariantSelectors( artifact );' ] : [] ),
			`export const __unsupportedKinds = ${ JSON.stringify( unsupportedKinds ) };`,
			`export const dynamicBindings = artifact.dynamicBindings;`,
			`export const update = null;`,
			`export const updateGroup = null;`,
			'',
			`export default { __hash, name, __sourceValidationMode, artifact, update, updateGroup, __unsupportedKinds, dynamicBindings${ registerAuxiliary ? ', __registerAuxiliary' : '' } };`,
			'',
		);
		return { source: lines.join( '\n' ), unsupportedKinds };

	}
	lines.push(
		mangledUpdater,
		'',
		`export const __hash = ${ JSON.stringify( hash ) };`,
		`export const name = ${ JSON.stringify( name ) };`,
		`export const __sourceValidationMode = ${ JSON.stringify( sourceValidationMode ) };`,
		...artifactDeclarations,
		`export const artifact = ${ artifactLiteral };`,
		...( materializeAttributeDescriptors ? [ '__tslp_materializeAttributes( artifact );' ] : [] ),
		...( materializeVariantSelectorAdapter ? [ '__tslp_materializeVariantSelectors( artifact );' ] : [] ),
		...dynamicBindingRestorations,
		...emitSharedUniformGroupKeys( artifactForEmission ),
		`export const update = __generatedUpdate;`,
		`export const updateGroup = __generatedUpdateGroup;`,
		`export const __unsupportedKinds = ${ JSON.stringify( unsupportedKinds ) };`,
		`export const dynamicBindings = artifact.dynamicBindings;`,
		'',
		`export default { __hash, name, __sourceValidationMode, artifact, update, updateGroup, __unsupportedKinds, dynamicBindings${ registerAuxiliary ? ', __registerAuxiliary' : '' } };`,
		'',
	);

	return { source: lines.join( '\n' ), unsupportedKinds };

}

export function artifactNeedsAttributeDescriptorMaterialization( value ) {

	return artifactPayloadSome( value, ( artifact ) => {

		for ( const list of [ artifact.attributes, artifact.nodeAttributes ] ) {

			if ( ! Array.isArray( list ) ) continue;
			if ( list.some( ( descriptor ) => descriptor && typeof descriptor === 'object' && (
				descriptor.arrayGenerator !== undefined || descriptor.objectAttribute !== undefined
			) ) ) return true;

		}
		return false;

	} );

}

export function artifactNeedsVariantSelectorAdapterMaterialization( value ) {

	return artifactPayloadSome( value, ( artifact ) => Array.isArray( artifact.renderContextSelectors )
		&& artifact.renderContextSelectors.some( ( selector ) => typeof selector === 'string' && selector.length > 0 ) );

}

function artifactPayloadSome( value, predicate ) {

	let result = false;
	forEachArtifactPayload( value, ( artifact ) => {

		if ( ! result && predicate( artifact ) ) result = true;

	} );
	return result;

}

function emitDynamicBindingRestorations( artifact ) {

	const lines = [];
	const visit = ( member, memberExpression ) => {

		if ( ! member || typeof member !== 'object' || Array.isArray( member ) ) return;
		const bindings = collectArtifactDynamicBindings( member ).length > 0
			? `__tslp_collectDynamicBindings(${ memberExpression })`
			: '[]';
		lines.push( `${ memberExpression }.dynamicBindings = ${ bindings };` );
		if ( ! member.variants || typeof member.variants !== 'object' || Array.isArray( member.variants ) ) return;
		for ( const [ key, variant ] of Object.entries( member.variants ) ) {

			visit( variant, `${ memberExpression }.variants[${ JSON.stringify( key ) }]` );

		}

	};
	visit( artifact, 'artifact' );
	return lines;

}

function omitDynamicBindingsDeep( artifact ) {

	if ( ! artifact || typeof artifact !== 'object' ) return artifact;
	let changed = Object.prototype.hasOwnProperty.call( artifact, 'dynamicBindings' );
	let variants = artifact.variants;
	if ( variants && typeof variants === 'object' ) {

		const nextVariants = {};
		for ( const [ key, variant ] of Object.entries( variants ) ) {

			const next = omitDynamicBindingsDeep( variant );
			nextVariants[ key ] = next;
			if ( next !== variant ) changed = true;

		}
		if ( changed ) variants = nextVariants;

	}
	if ( ! changed ) return artifact;
	const next = { ...artifact, ...( variants !== artifact.variants ? { variants } : {} ) };
	delete next.dynamicBindings;
	return next;

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
