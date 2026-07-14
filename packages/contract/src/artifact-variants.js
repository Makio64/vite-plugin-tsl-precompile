import { stableJsonStringify } from './stable-json.js';

/**
 * Runtime fields that may differ between members of one captured material
 * family. Capture, manifest emission, registry merging, and hydration all use
 * this list so a newly-added variant field cannot drift between packages.
 */
export const ARTIFACT_VARIANT_FIELDS = Object.freeze( [
	'version',
	'cacheKey',
	'renderContextSelectors',
	'materialShape',
	'bindingOwner',
	'sourceMaterial',
	'vertexShader',
	'fragmentShader',
	'computeShader',
	'transforms',
	'attributes',
	'nodeAttributes',
	'bindings',
	'uniformPlan',
	'lightIdentities',
	'dynamicBindings',
	'defaults',
	'renderState',
	'ltcTextures',
	'meta',
	'mrtOutputCount',
	'mrtOutputNames',
	'mrtBlendModes',
] );

/**
 * Return the serializable, variant-local payload shared by artifact families.
 * Undefined fields are omitted to keep generated modules compact.
 *
 * @param {?Object} artifact
 * @return {Object}
 */
export function createArtifactVariantPayload( artifact ) {

	const payload = {};
	for ( const field of ARTIFACT_VARIANT_FIELDS ) {

		if ( artifact && artifact[ field ] !== undefined ) payload[ field ] = artifact[ field ];

	}
	return payload;

}

/**
 * Canonical semantic payload fingerprint used when a private cache key or a
 * render-context selector is only routing metadata. Callers group by cache key
 * separately and use this value to prove that selector aliases share one
 * shader/binding payload.
 *
 * @param {?Object} artifact
 * @return {string}
 */
export function createArtifactVariantPayloadFingerprint( artifact ) {

	const payload = createArtifactVariantPayload( artifact );
	delete payload.cacheKey;
	delete payload.renderContextSelectors;
	return stableJsonStringify( payload, 'artifactVariant' );

}

export class ArtifactVariantFamilyError extends Error {

	constructor( code, message, details = {} ) {

		super( message );
		this.name = 'ArtifactVariantFamilyError';
		this.code = code;
		this.details = details;
		this.tslPrecompileVariantFamily = true;

	}

}

/**
 * Return the authoritative members of an artifact family. Family maps include
 * a payload for the root cache key, so the root object is omitted when that
 * payload exists. This keeps selector unions performed during family merging
 * authoritative without making every downstream consumer rediscover the
 * root/variant duplication rule.
 *
 * @param {?Object} artifact
 * @return {Object[]}
 */
export function collectArtifactVariantCandidates( artifact ) {

	if ( ! artifact || typeof artifact !== 'object' ) return [];
	const variants = artifact.variants && typeof artifact.variants === 'object' && ! Array.isArray( artifact.variants )
		? Object.values( artifact.variants ).filter( ( candidate ) => candidate && typeof candidate === 'object' )
		: [];
	if ( variants.length === 0 ) return [ artifact ];
	const rootKey = artifact.cacheKey === undefined || artifact.cacheKey === null ? null : String( artifact.cacheKey );
	const rootRepresented = rootKey !== null && variants.some( ( candidate ) =>
		candidate.cacheKey !== undefined && candidate.cacheKey !== null && String( candidate.cacheKey ) === rootKey
	);
	return rootRepresented ? variants : [ artifact, ...variants ];

}

/**
 * Merge one or more captured material families into `target` without relying
 * on private cache keys being globally unique. Equivalent payloads that share
 * a cache key are one shader family and receive the canonical union of their
 * semantic selectors. Divergent payloads under one key cannot be represented
 * by the current object-keyed contract, so they fail closed instead of being
 * silently overwritten.
 *
 * Non-serializable sidecars (for example `_textureRefs`) remain package-local
 * responsibilities and are intentionally not handled here.
 *
 * @param {Object} target
 * @param {Object|Object[]} artifacts
 * @return {Object}
 */
export function mergeArtifactVariantFamily( target, artifacts ) {

	if ( ! target || typeof target !== 'object' ) {

		throw new TypeError( 'mergeArtifactVariantFamily: target must be an artifact object.' );

	}
	const inputs = Array.isArray( artifacts ) ? artifacts : [ artifacts ];
	const records = new Map();
	for ( const input of inputs ) {

		if ( ! input || typeof input !== 'object' ) continue;
		const nested = input.variants && typeof input.variants === 'object' && ! Array.isArray( input.variants )
			? Object.values( input.variants )
			: [];
		for ( const candidate of [ input, ...nested ] ) addFamilyCandidate( records, candidate );

	}
	if ( records.size === 0 ) return target;

	const targetKey = requiredCacheKey( target );
	const targetRecord = records.get( targetKey );
	if ( targetRecord && targetRecord.payload.renderContextSelectors !== undefined ) {

		target.renderContextSelectors = targetRecord.payload.renderContextSelectors.slice();

	}

	if ( records.size > 1 ) {

		const variants = {};
		const orderedRecords = [ ...records.entries() ].sort( ( [ left ], [ right ] ) => left < right ? - 1 : left > right ? 1 : 0 );
		for ( const [ cacheKey, record ] of orderedRecords ) variants[ cacheKey ] = record.payload;
		target.variants = variants;

	} else if ( target.variants !== undefined ) {

		delete target.variants;

	}
	return target;

}

function addFamilyCandidate( records, candidate ) {

	if ( ! candidate || typeof candidate !== 'object' ) return;
	const cacheKey = requiredCacheKey( candidate );
	const payload = createArtifactVariantPayload( candidate );
	const selectors = canonicalSelectors( payload.renderContextSelectors );
	if ( selectors.length > 0 ) payload.renderContextSelectors = selectors;
	else if ( payload.renderContextSelectors !== undefined ) payload.renderContextSelectors = [];
	const fingerprint = createArtifactVariantPayloadFingerprint( payload );
	const existing = records.get( cacheKey );
	if ( ! existing ) {

		records.set( cacheKey, { fingerprint, payload } );
		return;

	}
	if ( existing.fingerprint !== fingerprint ) {

		throw new ArtifactVariantFamilyError(
			'TSLP_ARTIFACT_VARIANT_CACHE_KEY_COLLISION',
			`[tsl-precompile] cache key ${ JSON.stringify( cacheKey ) } identifies divergent artifact variant payloads. ` +
			'Recapture with the current toolchain; this family cannot be merged safely.',
			{ cacheKey },
		);

	}
	const mergedSelectors = canonicalSelectors( [
		...( existing.payload.renderContextSelectors || [] ),
		...( payload.renderContextSelectors || [] ),
	] );
	if ( mergedSelectors.length > 0 ) existing.payload.renderContextSelectors = mergedSelectors;

}

function requiredCacheKey( artifact ) {

	if ( artifact.cacheKey === undefined || artifact.cacheKey === null ) {

		throw new ArtifactVariantFamilyError(
			'TSLP_ARTIFACT_VARIANT_CACHE_KEY_UNAVAILABLE',
			'[tsl-precompile] every artifact family member must carry a cacheKey.',
		);

	}
	return String( artifact.cacheKey );

}

function canonicalSelectors( selectors ) {

	if ( ! Array.isArray( selectors ) ) return [];
	return [ ...new Set( selectors.filter( ( selector ) => typeof selector === 'string' && selector.length > 0 ) ) ].sort();

}
