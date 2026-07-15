import { stableJsonStringify } from './stable-json.js';

const EPHEMERAL_IDENTITY_FIELDS = Object.freeze( {
	captureUuid: 'light',
	lightUuid: 'light',
	textureUuid: 'texture',
	viewportIdentity: 'viewport',
} );

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
	'materialCompute',
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
	return stableJsonStringify( normalizeVariantFingerprintPayload( payload ), 'artifactVariant' );

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
	const suppliedInputs = Array.isArray( artifacts ) ? artifacts : [ artifacts ];
	const hasSuppliedInput = suppliedInputs.some( ( input ) => input && typeof input === 'object' );
	// A merge extends the target's current family even when the caller passes
	// an equivalent clone as its authoritative first input.
	const inputs = hasSuppliedInput && ! suppliedInputs.includes( target ) ? [ target, ...suppliedInputs ] : suppliedInputs;
	const records = new Map();
	let canonicalTargetKey = null;
	for ( const input of inputs ) {

		if ( ! input || typeof input !== 'object' ) continue;
		// A family map contains the authoritative payload for its represented
		// root cache key. Do not also merge the root envelope: it can carry
		// capture-only metadata that is intentionally absent from variants.
		const canonicalKeys = mergeFamilyCandidates( records, collectArtifactVariantCandidates( input ) );
		if ( input === target ) canonicalTargetKey = canonicalKeys.get( requiredCacheKey( target ) ) || requiredCacheKey( target );

	}
	if ( records.size === 0 ) return target;

	const targetKey = requiredCacheKey( target );
	const targetRecord = records.get( canonicalTargetKey || targetKey );
	if ( targetRecord ) {

		applyArtifactVariantPayload( target, targetRecord.payload );

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

/**
 * Merge one independently captured family into the durable records. UUIDs are
 * capture-session identities, so overlapping equivalent members establish a
 * kind-aware alias from the incoming spelling to the authoritative spelling.
 * The same alias map is then applied to new incoming siblings, preserving
 * whether those siblings share or do not share a texture/light with the
 * overlap. Wholly disjoint identities remain unproven and are not rewritten.
 */
function mergeFamilyCandidates( records, candidates ) {

	const canonicalKeyByInputKey = new Map();
	const prepared = candidates
		.filter( ( candidate ) => candidate && typeof candidate === 'object' )
		.map( prepareFamilyCandidate )
		.sort( ( left, right ) => {

			const leftKey = requiredCacheKey( left.payload );
			const rightKey = requiredCacheKey( right.payload );
			return leftKey < rightKey ? - 1 : leftKey > rightKey ? 1 : 0;

		} );
	if ( prepared.length === 0 ) return canonicalKeyByInputKey;

	const aliases = createIdentityAliasState();
	const authoritativeRecords = [ ...records.entries() ].sort( ( [ left ], [ right ] ) => left < right ? - 1 : left > right ? 1 : 0 );
	for ( const incoming of prepared ) {

		const incomingKey = requiredCacheKey( incoming.payload );
		const sameKey = records.get( incomingKey );
		if ( sameKey ) {

			if ( sameKey.semanticFingerprint !== incoming.semanticFingerprint ) throwCacheKeyCollision( incomingKey );
			alignEphemeralIdentityAliases( incoming.payload, sameKey.payload, aliases );

		}
		for ( const [ , authoritative ] of authoritativeRecords ) {

			if ( authoritative === sameKey || authoritative.semanticFingerprint !== incoming.semanticFingerprint ) continue;
			if ( ! selectorsOverlap( authoritative.payload.renderContextSelectors, incoming.payload.renderContextSelectors ) ) continue;
			alignEphemeralIdentityAliases( incoming.payload, authoritative.payload, aliases );

		}

	}

	for ( const incoming of prepared ) {

		const payload = applyEphemeralIdentityAliases( incoming.payload, aliases );
		const cacheKey = requiredCacheKey( payload );
		if ( records.has( cacheKey ) ) {

			addFamilyCandidate( records, payload );
			canonicalKeyByInputKey.set( cacheKey, cacheKey );
			continue;

		}

		// Signed recaptures can spell the same private Three cache key
		// differently. A shared semantic selector plus equivalent payload proves
		// that this is an alias, so retain the established record and union only
		// its selectors instead of growing a duplicate family member.
		const semanticFingerprint = createSemanticVariantFingerprint( payload );
		const selectorAlias = [ ...records.entries() ]
			.sort( ( [ left ], [ right ] ) => left < right ? - 1 : left > right ? 1 : 0 )
			.find( ( [ , authoritative ] ) =>
				authoritative.semanticFingerprint === semanticFingerprint &&
				selectorsOverlap( authoritative.payload.renderContextSelectors, payload.renderContextSelectors )
			);
		if ( selectorAlias ) {

			mergeFamilySelectors( selectorAlias[ 1 ], payload );
			canonicalKeyByInputKey.set( cacheKey, selectorAlias[ 0 ] );
			continue;

		}
		addFamilyCandidate( records, payload );
		canonicalKeyByInputKey.set( cacheKey, cacheKey );

	}
	return canonicalKeyByInputKey;

}

function applyArtifactVariantPayload( target, payload ) {

	for ( const field of ARTIFACT_VARIANT_FIELDS ) {

		if ( Object.hasOwn( payload, field ) ) target[ field ] = payload[ field ];
		else if ( Object.hasOwn( target, field ) ) delete target[ field ];

	}

}

function prepareFamilyCandidate( candidate ) {

	const payload = createArtifactVariantPayload( candidate );
	const selectors = canonicalSelectors( payload.renderContextSelectors );
	if ( selectors.length > 0 ) payload.renderContextSelectors = selectors;
	else if ( payload.renderContextSelectors !== undefined ) payload.renderContextSelectors = [];
	return {
		payload,
		semanticFingerprint: createSemanticVariantFingerprint( payload ),
	};

}

function addFamilyCandidate( records, candidate ) {

	if ( ! candidate || typeof candidate !== 'object' ) return;
	const cacheKey = requiredCacheKey( candidate );
	const payload = createArtifactVariantPayload( candidate );
	const selectors = canonicalSelectors( payload.renderContextSelectors );
	if ( selectors.length > 0 ) payload.renderContextSelectors = selectors;
	else if ( payload.renderContextSelectors !== undefined ) payload.renderContextSelectors = [];
	const fingerprint = createArtifactVariantPayloadFingerprint( payload );
	const semanticFingerprint = createSemanticVariantFingerprint( payload );
	const existing = records.get( cacheKey );
	if ( ! existing ) {

		records.set( cacheKey, { fingerprint, semanticFingerprint, payload } );
		return;

	}
	if ( existing.fingerprint !== fingerprint ) {

		throwCacheKeyCollision( cacheKey );

	}
	mergeFamilySelectors( existing, payload );

}

function mergeFamilySelectors( record, payload ) {

	const mergedSelectors = canonicalSelectors( [
		...( record.payload.renderContextSelectors || [] ),
		...( payload.renderContextSelectors || [] ),
	] );
	if ( mergedSelectors.length > 0 ) record.payload.renderContextSelectors = mergedSelectors;

}

function throwCacheKeyCollision( cacheKey ) {

	throw new ArtifactVariantFamilyError(
		'TSLP_ARTIFACT_VARIANT_CACHE_KEY_COLLISION',
		`[tsl-precompile] cache key ${ JSON.stringify( cacheKey ) } identifies divergent artifact variant payloads. ` +
		'Recapture with the current toolchain; this family cannot be merged safely.',
		{ cacheKey },
	);

}

function createSemanticVariantFingerprint( artifact ) {

	const payload = createArtifactVariantPayload( artifact );
	delete payload.cacheKey;
	delete payload.renderContextSelectors;
	return stableJsonStringify(
		remapArtifactEphemeralIdentities( normalizeVariantFingerprintPayload( payload ) ),
		'artifactVariantSemantic',
	);

}

/**
 * Normalize only values whose in-memory spelling is known to differ from the
 * durable JSON payload. Camera and render-object snapshots are rewritten from
 * the active frame and are not shader-family identity. JSON.stringify maps
 * non-finite numbers to null, so fingerprint the same representation while
 * preserving legitimate live defaults such as attenuationDistance=Infinity
 * on the authoritative in-process artifact.
 */
function normalizeVariantFingerprintPayload( value ) {

	const seen = new Map();
	const visit = ( current ) => {

		if ( typeof current === 'number' && ! Number.isFinite( current ) ) return null;
		if ( current === null || typeof current !== 'object' ) return current;
		if ( seen.has( current ) ) return seen.get( current );
		const clone = Array.isArray( current ) ? [] : {};
		seen.set( current, clone );
		if ( Array.isArray( current ) ) {

			for ( const item of current ) clone.push( visit( item ) );
			return clone;

		}
		const liveFrameSource = typeof current.kind === 'string' && (
			current.kind.startsWith( 'camera.' ) || current.kind.startsWith( 'object.' )
		);
		for ( const key of Object.keys( current ) ) {

			if ( liveFrameSource && key === 'valueSnapshot' ) continue;
			clone[ key ] = visit( current[ key ] );

		}
		return clone;

	};
	return visit( value );

}

/**
 * Create a reusable identity-token namespace. Pass one state through every
 * member of a family to preserve cross-variant shared-vs-distinct relations.
 */
export function createArtifactIdentityRemapState() {

	return { identities: new Map(), nextByKind: new Map() };

}

/**
 * Replace capture-session light/texture/viewport-reference spelling with
 * deterministic, kind-aware tokens while preserving relational identity.
 */
export function remapArtifactEphemeralIdentities( value, state = createArtifactIdentityRemapState() ) {

	const { identities, nextByKind } = state;
	const seen = new Map();
	const visit = ( current, field = null ) => {

		const kind = field && EPHEMERAL_IDENTITY_FIELDS[ field ];
		if ( kind && typeof current === 'string' && current.length > 0 ) {

			const identityKey = `${ kind }\0${ current }`;
			let token = identities.get( identityKey );
			if ( token === undefined ) {

				const next = nextByKind.get( kind ) || 0;
				nextByKind.set( kind, next + 1 );
				token = `<${ kind }-identity:${ next }>`;
				identities.set( identityKey, token );

			}
			return token;

		}
		if ( current === null || typeof current !== 'object' ) return current;
		if ( seen.has( current ) ) return seen.get( current );
		const clone = Array.isArray( current ) ? [] : {};
		seen.set( current, clone );
		if ( Array.isArray( current ) ) {

			for ( const item of current ) clone.push( visit( item ) );

		} else {

			for ( const key of Object.keys( current ).sort() ) clone[ key ] = visit( current[ key ], key );

		}
		return clone;

	};
	return visit( value );

}

function createIdentityAliasState() {

	return { incomingToAuthoritative: new Map(), authoritativeToIncoming: new Map() };

}

function alignEphemeralIdentityAliases( incoming, authoritative, state ) {

	const incomingPayload = comparableVariantPayload( incoming );
	const authoritativePayload = comparableVariantPayload( authoritative );
	const visit = ( incomingValue, authoritativeValue, field = null ) => {

		const kind = field && EPHEMERAL_IDENTITY_FIELDS[ field ];
		if ( kind && typeof incomingValue === 'string' && incomingValue.length > 0 && typeof authoritativeValue === 'string' && authoritativeValue.length > 0 ) {

			recordIdentityAlias( state, kind, incomingValue, authoritativeValue );
			return;

		}
		if ( incomingValue === null || authoritativeValue === null || typeof incomingValue !== 'object' || typeof authoritativeValue !== 'object' ) return;
		if ( Array.isArray( incomingValue ) || Array.isArray( authoritativeValue ) ) {

			if ( ! Array.isArray( incomingValue ) || ! Array.isArray( authoritativeValue ) ) return;
			for ( let index = 0; index < Math.min( incomingValue.length, authoritativeValue.length ); index ++ ) {

				visit( incomingValue[ index ], authoritativeValue[ index ] );

			}
			return;

		}
		for ( const key of Object.keys( incomingValue ).sort() ) {

			if ( Object.hasOwn( authoritativeValue, key ) ) visit( incomingValue[ key ], authoritativeValue[ key ], key );

		}

	};
	visit( incomingPayload, authoritativePayload );

}

function comparableVariantPayload( artifact ) {

	const payload = createArtifactVariantPayload( artifact );
	delete payload.cacheKey;
	delete payload.renderContextSelectors;
	return payload;

}

function recordIdentityAlias( state, kind, incoming, authoritative ) {

	const incomingKey = `${ kind }\0${ incoming }`;
	const authoritativeKey = `${ kind }\0${ authoritative }`;
	const priorAuthoritative = state.incomingToAuthoritative.get( incomingKey );
	const priorIncoming = state.authoritativeToIncoming.get( authoritativeKey );
	if ( priorAuthoritative !== undefined && priorAuthoritative !== authoritative || priorIncoming !== undefined && priorIncoming !== incoming ) {

		throw new ArtifactVariantFamilyError(
			'TSLP_ARTIFACT_VARIANT_IDENTITY_ALIAS_COLLISION',
			`[tsl-precompile] independently captured ${ kind } identities cannot be aligned without changing shared-resource topology. ` +
			'Recapture the complete variant family in one render epoch.',
			{ kind },
		);

	}
	state.incomingToAuthoritative.set( incomingKey, authoritative );
	state.authoritativeToIncoming.set( authoritativeKey, incoming );

}

function applyEphemeralIdentityAliases( value, state ) {

	const seen = new Map();
	const visit = ( current, field = null ) => {

		const kind = field && EPHEMERAL_IDENTITY_FIELDS[ field ];
		if ( kind && typeof current === 'string' && current.length > 0 ) {

			return state.incomingToAuthoritative.get( `${ kind }\0${ current }` ) || current;

		}
		if ( current === null || typeof current !== 'object' ) return current;
		if ( seen.has( current ) ) return seen.get( current );
		const clone = Array.isArray( current ) ? [] : {};
		seen.set( current, clone );
		if ( Array.isArray( current ) ) {

			for ( const item of current ) clone.push( visit( item ) );

		} else {

			for ( const key of Object.keys( current ) ) clone[ key ] = visit( current[ key ], key );

		}
		return clone;

	};
	return visit( value );

}

function selectorsOverlap( left, right ) {

	if ( ! Array.isArray( left ) || ! Array.isArray( right ) || left.length === 0 || right.length === 0 ) return false;
	const leftSet = new Set( left );
	return right.some( ( selector ) => leftSet.has( selector ) );

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
