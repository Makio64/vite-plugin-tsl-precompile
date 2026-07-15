import {
	ARTIFACT_VARIANT_FIELDS,
	collectArtifactVariantCandidates,
	createArtifactIdentityRemapState,
	createArtifactVariantPayload,
	remapArtifactEphemeralIdentities,
} from './artifact-variants.js';

const ROOT_METADATA_FIELDS = new Set( [
	'__hash',
	'__name',
	'captureClock',
	'materialUuid',
	'sourceGraphHash',
	'sourceHashVersion',
	'sourceMaterial',
	'sourceThreeVersion',
	'userMaterialUuid',
] );

const ARTIFACT_FAMILY_FIELDS = new Set( [ ...ARTIFACT_VARIANT_FIELDS, 'variants' ] );
const SIGNED_ROOT_ROUTING_FIELDS = new Set( [ 'renderContextSignature' ] );

export const ARTIFACT_CONTENT_HASH_VERSION = 'artifact-content@3';

/**
 * Canonical payload for the hard artifact identity gate.
 *
 * Unlike a source fingerprint, this includes the emitted shaders, binding
 * layout, uniform plan, render state, and every captured variant. Capture-only
 * provenance is excluded so the same runtime payload remains content-addressed
 * across sessions.
 */
export function createArtifactContentHashPayload( artifact, opts = {} ) {

	const shape = opts.shape;
	const threeVersion = opts.threeVersion;
	const toolchainVersion = opts.toolchainVersion ?? opts.pluginVersion;
	if ( typeof shape !== 'string' || shape.length === 0 ) throw new TypeError( 'createArtifactContentHashPayload: "shape" must be a non-empty string' );
	if ( typeof threeVersion !== 'string' || threeVersion.length === 0 ) throw new Error( 'createArtifactContentHashPayload: "threeVersion" is required' );
	if ( typeof toolchainVersion !== 'string' || toolchainVersion.length === 0 ) throw new Error( 'createArtifactContentHashPayload: "toolchainVersion" is required' );

	return [
		ARTIFACT_CONTENT_HASH_VERSION,
		`shape=${ JSON.stringify( shape ) }`,
		`three=${ JSON.stringify( threeVersion ) }`,
		`toolchain=${ JSON.stringify( toolchainVersion ) }`,
		stableArtifactValue( canonicalArtifactContent( artifact ), new Set() ),
	].join( '\n' );

}

/**
 * Signed families route by reproducible render-context selectors, not Three's
 * process-private cache keys. Represent them as an ordered set of effective
 * semantic payloads, merging selector aliases for equivalent payloads. This
 * makes singleton/family layout, cache-key spelling, and duplicate captures
 * irrelevant without losing the selector-to-shader relationship.
 *
 * Unsigned and partially-signed artifacts retain their legacy representation:
 * runtime selection still depends on cacheKey for those families, and invalid
 * partial families must not accidentally acquire a signed identity.
 */
function canonicalArtifactContent( artifact ) {

	if ( ! artifact || typeof artifact !== 'object' || Array.isArray( artifact ) ) return artifact;
	const candidates = collectArtifactVariantCandidates( artifact );
	if ( candidates.length === 0 || candidates.some( ( candidate ) => ! hasSemanticSelectors( candidate ) ) ) return artifact;

	const records = candidates.map( ( candidate ) => {

		// Variant views inherit omitted fields from the family root at runtime.
		// Hash that same effective payload so compact and expanded captures agree.
		const effective = createArtifactVariantPayload( { ...artifact, ...candidate } );
		delete effective.cacheKey;
		delete effective.renderContextSelectors;
		// sourceMaterial describes the author-facing capture owner, not a
		// variant payload. It is root metadata and can differ between equivalent
		// instances observed at the same callsite.
		delete effective.sourceMaterial;
		const selectors = [ ...new Set( candidate.renderContextSelectors.filter( ( selector ) => typeof selector === 'string' && selector.length > 0 ) ) ].sort();
		const localPayload = remapArtifactEphemeralIdentities( effective );
		return {
			effective,
			selectors,
			sortKey: `${ stableArtifactValue( localPayload, new Set() ) }\n${ stableArtifactValue( selectors, new Set() ) }`,
		};

	} );
	records.sort( ( left, right ) => left.sortKey < right.sortKey ? - 1 : left.sortKey > right.sortKey ? 1 : 0 );

	// Token allocation is shared across the deterministically ordered family.
	// This preserves whether two variants reference one resource or distinct
	// resources while remaining independent of capture-session UUID spelling.
	const identityState = createArtifactIdentityRemapState();
	const groups = new Map();
	for ( const record of records ) {

		const effective = remapArtifactEphemeralIdentities( record.effective, identityState );
		const fingerprint = stableArtifactValue( effective, new Set() );
		let group = groups.get( fingerprint );
		if ( group === undefined ) {

			group = { payload: effective, selectors: new Set() };
			groups.set( fingerprint, group );

		}
		for ( const selector of record.selectors ) group.selectors.add( selector );

	}

	const variants = [ ...groups.values() ].map( ( { payload, selectors } ) => ( {
		...payload,
		renderContextSelectors: [ ...selectors ].sort(),
	} ) );
	variants.sort( ( left, right ) => {

		const leftValue = stableArtifactValue( left, new Set() );
		const rightValue = stableArtifactValue( right, new Set() );
		return leftValue < rightValue ? - 1 : leftValue > rightValue ? 1 : 0;

	} );

	const canonical = {};
	for ( const key of Object.keys( artifact ) ) {

		if ( ARTIFACT_FAMILY_FIELDS.has( key ) || SIGNED_ROOT_ROUTING_FIELDS.has( key ) ) continue;
		canonical[ key ] = artifact[ key ];

	}
	canonical.variants = variants;
	return canonical;

}

function hasSemanticSelectors( candidate ) {

	return !! candidate && Array.isArray( candidate.renderContextSelectors )
		&& candidate.renderContextSelectors.some( ( selector ) => typeof selector === 'string' && selector.length > 0 );

}

function stableArtifactValue( value, seen ) {

	if ( value === null ) return 'null';
	if ( typeof value === 'number' ) {

		if ( Number.isNaN( value ) ) return '"<NaN>"';
		if ( value === Infinity ) return '"<Infinity>"';
		if ( value === - Infinity ) return '"<-Infinity>"';
		if ( Object.is( value, - 0 ) ) return '"<-0>"';
		return JSON.stringify( value );

	}
	if ( typeof value === 'string' || typeof value === 'boolean' ) return JSON.stringify( value );
	if ( value === undefined ) return '"<undefined>"';
	if ( typeof value !== 'object' ) return JSON.stringify( `<${ typeof value }>` );
	if ( seen.has( value ) ) return '"<cycle>"';
	seen.add( value );

	let result;
	if ( Array.isArray( value ) ) {

		result = `[${ value.map( ( item ) => stableArtifactValue( item, seen ) ).join( ',' ) }]`;

	} else {

		const keys = Object.keys( value )
			.filter( ( key ) => ! key.startsWith( '_' ) && ! ROOT_METADATA_FIELDS.has( key ) )
			.sort();
		result = `{${ keys.map( ( key ) => `${ JSON.stringify( key ) }:${ stableArtifactValue( value[ key ], seen ) }` ).join( ',' ) }}`;

	}
	seen.delete( value );
	return result;

}
