import { stableJsonStringify } from './stable-json.js';
import { detectArtifactShaderLanguage, resolveArtifactVariantKey } from './shader-language.js';
import { RENDERER_RENDER_TARGET_TEXTURE_SELECTOR_SCHEMA } from './render-target-texture.js';
import { GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR } from './variant-selector-sidecar.js';

const EPHEMERAL_IDENTITY_FIELDS = Object.freeze( {
	captureUuid: 'light',
	lightUuid: 'light',
	textureUuid: 'texture',
	viewportIdentity: 'viewport',
} );

const VSM_INTERNAL_PASS_SHAPES = new Set( [
	'shadow-vsm-vertical',
	'shadow-vsm-horizontal',
] );

const VSM_INTERNAL_PASS_ROLE_SOURCE_KINDS = new Set( [
	'depth.texture',
	'light.shadowBlurSamples',
	'light.shadowMapSize',
	'light.shadowRadius',
] );

const INTERNAL_PASS_SOURCE_CAPTURE_FIELDS = new Set( [
	'lightIdentity',
	'lightIndex',
	'lightUuid',
	'valueSnapshot',
] );

const VARIANT_COLLISION_DIFFERENCE_PATH_LIMIT = 12;
const VARIANT_COLLISION_STRING_DETAIL_LIMIT = 2;
const VARIANT_COLLISION_STRING_EXCERPT_RADIUS = 32;
const SHADER_SOURCE_FIELDS = new Set( [ 'vertexShader', 'fragmentShader', 'computeShader' ] );
const CAPTURE_GENERATED_IDENTIFIER_PATTERN = /\b(?:NodeBuffer_\d+(?=\b|Struct\b)|buffer\d+\b)/g;
const CAPTURE_GENERATED_SHADER_NODE_BUFFER_ID_PATTERN = /\bNodeBuffer_(\d+)(?=\b|Struct\b)/g;
const CAPTURE_GENERATED_SHADER_NODE_ID_PATTERN = /\b(?:(NodeBuffer_)(\d+)(?=\b|Struct\b)|(buffer)(\d+)\b)/g;
const CAPTURE_GENERATED_WEBGL_BUFFER_NAME_PATTERN = /^NodeBuffer_(\d+)$/;
const CAPTURE_GENERATED_UNIFORM_BUFFER_NAME_PATTERN = /^UniformBuffer_(\d+)$/;
const CAPTURE_GENERATED_STORAGE_BUFFER_NAME_PATTERN = /^StorageBuffer_(\d+)$/;

/**
 * Runtime fields that may differ between members of one captured material
 * family. Capture, manifest emission, registry merging, and hydration all use
 * this list so a newly-added variant field cannot drift between packages.
 */
export const ARTIFACT_VARIANT_FIELDS = Object.freeze( [
	'version',
	'cacheKey',
	'variantKey',
	'shaderLanguage',
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
	'computeBindings',
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
	copyVariantSelectorAdapter( artifact, payload );
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

	const payload = normalizeVariantShaderLanguage( createArtifactVariantPayload( artifact ) );
	delete payload.cacheKey;
	delete payload.variantKey;
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
	const rootKey = resolveArtifactVariantKey( artifact );
	const rootRepresented = rootKey !== null && variants.some( ( candidate ) =>
		resolveArtifactVariantKey( candidate ) === rootKey
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
		if ( input === target ) {

			const targetKey = requiredArtifactVariantKey( target );
			canonicalTargetKey = canonicalKeys.get( targetKey ) || targetKey;

		}

	}
	if ( records.size === 0 ) return target;

	const targetKey = requiredArtifactVariantKey( target );
	const targetRecord = records.get( canonicalTargetKey || targetKey );
	if ( targetRecord ) {

		applyArtifactVariantPayload( target, targetRecord.payload );

	}

	if ( records.size > 1 ) {

		const variants = {};
		const orderedRecords = [ ...records.entries() ].sort( ( [ left ], [ right ] ) => left < right ? - 1 : left > right ? 1 : 0 );
		for ( const [ variantKey, record ] of orderedRecords ) variants[ variantKey ] = record.payload;
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

			const leftKey = requiredArtifactVariantKey( left.payload );
			const rightKey = requiredArtifactVariantKey( right.payload );
			return leftKey < rightKey ? - 1 : leftKey > rightKey ? 1 : 0;

		} );
	if ( prepared.length === 0 ) return canonicalKeyByInputKey;

	const aliases = createIdentityAliasState();
	const authoritativeRecords = [ ...records.entries() ].sort( ( [ left ], [ right ] ) => left < right ? - 1 : left > right ? 1 : 0 );
	for ( const incoming of prepared ) {

		const incomingKey = requiredArtifactVariantKey( incoming.payload );
		const sameKey = records.get( incomingKey );
		if ( sameKey ) {

			if ( sameKey.semanticFingerprint !== incoming.semanticFingerprint ) {

				throwVariantKeyCollision( incomingKey, sameKey.payload, incoming.payload );

			}
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
		const variantKey = requiredArtifactVariantKey( payload );
		if ( records.has( variantKey ) ) {

			addFamilyCandidate( records, payload );
			canonicalKeyByInputKey.set( variantKey, variantKey );
			continue;

		}

		// Signed recaptures can spell the same private Three cache key
		// differently. A shared semantic selector plus equivalent payload proves
		// that this is an alias, so retain the established record and union only
		// its selectors instead of growing a duplicate family member.
		const semanticFingerprint = createArtifactVariantSemanticFingerprint( payload );
		const selectorAlias = [ ...records.entries() ]
			.sort( ( [ left ], [ right ] ) => left < right ? - 1 : left > right ? 1 : 0 )
			.find( ( [ , authoritative ] ) =>
				authoritative.semanticFingerprint === semanticFingerprint &&
				selectorsOverlap( authoritative.payload.renderContextSelectors, payload.renderContextSelectors )
			);
		if ( selectorAlias ) {

			mergeFamilySelectors( selectorAlias[ 1 ], payload );
			canonicalKeyByInputKey.set( variantKey, selectorAlias[ 0 ] );
			continue;

		}
		const selectorCollision = [ ...records.entries() ]
			.sort( ( [ left ], [ right ] ) => left < right ? - 1 : left > right ? 1 : 0 )
			.find( ( [ , authoritative ] ) =>
				selectorsOverlap( authoritative.payload.renderContextSelectors, payload.renderContextSelectors )
			);
		if ( selectorCollision ) {

			throwVariantSelectorCollision( selectorCollision[ 0 ], selectorCollision[ 1 ].payload, variantKey, payload );

		}
		addFamilyCandidate( records, payload );
		canonicalKeyByInputKey.set( variantKey, variantKey );

	}
	return canonicalKeyByInputKey;

}

function applyArtifactVariantPayload( target, payload ) {

	for ( const field of ARTIFACT_VARIANT_FIELDS ) {

		if ( Object.hasOwn( payload, field ) ) target[ field ] = payload[ field ];
		else if ( Object.hasOwn( target, field ) ) delete target[ field ];

	}
	copyVariantSelectorAdapter( payload, target );

}

function prepareFamilyCandidate( candidate ) {

	const payload = createArtifactVariantPayload( candidate );
	const selectors = canonicalSelectors( payload.renderContextSelectors );
	if ( selectors.length > 0 ) payload.renderContextSelectors = selectors;
	else if ( payload.renderContextSelectors !== undefined ) payload.renderContextSelectors = [];
	return {
		payload,
		semanticFingerprint: createArtifactVariantSemanticFingerprint( payload ),
	};

}

function addFamilyCandidate( records, candidate ) {

	if ( ! candidate || typeof candidate !== 'object' ) return;
	const variantKey = requiredArtifactVariantKey( candidate );
	const payload = createArtifactVariantPayload( candidate );
	const selectors = canonicalSelectors( payload.renderContextSelectors );
	if ( selectors.length > 0 ) payload.renderContextSelectors = selectors;
	else if ( payload.renderContextSelectors !== undefined ) payload.renderContextSelectors = [];
	const fingerprint = createArtifactVariantPayloadFingerprint( payload );
	const semanticFingerprint = createArtifactVariantSemanticFingerprint( payload );
	const existing = records.get( variantKey );
	if ( ! existing ) {

		records.set( variantKey, { fingerprint, semanticFingerprint, payload } );
		return;

	}
	if ( existing.fingerprint !== fingerprint ) {

		throwVariantKeyCollision( variantKey, existing.payload, payload );

	}
	mergeFamilySelectors( existing, payload );

}

function mergeFamilySelectors( record, payload ) {

	const mergedSelectors = canonicalSelectors( [
		...( record.payload.renderContextSelectors || [] ),
		...( payload.renderContextSelectors || [] ),
	] );
	if ( mergedSelectors.length > 0 ) record.payload.renderContextSelectors = mergedSelectors;
	if ( ! record.payload[ GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR ]
		&& payload[ GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR ] ) copyVariantSelectorAdapter( payload, record.payload );

}

function throwVariantKeyCollision( variantKey, authoritative = null, incoming = null ) {

	const differences = authoritative && incoming
		? describeArtifactVariantSemanticDifferences( authoritative, incoming )
		: emptyArtifactVariantSemanticDifferences();
	const differingFields = differences.fields;
	const detail = differingFields.length > 0
		? ` Divergent fields: ${ differingFields.join( ', ' ) }.${ formatVariantDifferencePathDetail( differences ) }`
		: '';

	const explicitVariantKey = authoritative && authoritative.variantKey !== undefined || incoming && incoming.variantKey !== undefined;
	const identityName = explicitVariantKey ? 'variant key' : 'cache key';
	throw new ArtifactVariantFamilyError(
		explicitVariantKey ? 'TSLP_ARTIFACT_VARIANT_KEY_COLLISION' : 'TSLP_ARTIFACT_VARIANT_CACHE_KEY_COLLISION',
		`[tsl-precompile] ${ identityName } ${ JSON.stringify( variantKey ) } identifies divergent artifact variant payloads. ` +
		`Recapture with the current toolchain; this family cannot be merged safely.${ detail }`,
		{
			variantKey,
			cacheKey: explicitVariantKey ? authoritative && authoritative.cacheKey : variantKey,
			differingFields,
			differingPaths: differences.paths,
			stringDifferences: differences.stringDifferences,
			differencesTruncated: differences.truncated,
			differencePathLimit: VARIANT_COLLISION_DIFFERENCE_PATH_LIMIT,
		},
	);

}

function throwVariantSelectorCollision( authoritativeVariantKey, authoritative, incomingVariantKey, incoming ) {

	const differences = describeArtifactVariantSemanticDifferences( authoritative, incoming );
	const sharedSelectors = canonicalSelectors( authoritative.renderContextSelectors )
		.filter( ( selector ) => canonicalSelectors( incoming.renderContextSelectors ).includes( selector ) );
	throw new ArtifactVariantFamilyError(
		'TSLP_ARTIFACT_VARIANT_SELECTOR_COLLISION',
		`[tsl-precompile] render-context selector identifies divergent artifact variants ` +
		`${ JSON.stringify( authoritativeVariantKey ) } and ${ JSON.stringify( incomingVariantKey ) }. ` +
		`This family cannot be merged safely.${ formatVariantDifferencePathDetail( differences ) }`,
		{
			authoritativeVariantKey,
			incomingVariantKey,
			selector: sharedSelectors[ 0 ] || null,
			differingFields: differences.fields,
			differingPaths: differences.paths,
			stringDifferences: differences.stringDifferences,
			differencesTruncated: differences.truncated,
			differencePathLimit: VARIANT_COLLISION_DIFFERENCE_PATH_LIMIT,
		},
	);

}

function emptyArtifactVariantSemanticDifferences() {

	return { fields: [], paths: [], stringDifferences: [], truncated: false };

}

function describeArtifactVariantSemanticDifferences( authoritative, incoming ) {

	const authoritativePayload = createArtifactVariantSemanticPayload( authoritative );
	const incomingPayload = createArtifactVariantSemanticPayload( incoming );
	const paths = [];
	const stringDifferences = [];
	collectArtifactVariantSemanticDifferencePaths(
		authoritativePayload,
		incomingPayload,
		'',
		paths,
		stringDifferences,
		VARIANT_COLLISION_DIFFERENCE_PATH_LIMIT + 1,
	);
	const truncated = paths.length > VARIANT_COLLISION_DIFFERENCE_PATH_LIMIT;
	const boundedPaths = paths.slice( 0, VARIANT_COLLISION_DIFFERENCE_PATH_LIMIT );
	const discoveredFields = new Set( [ ...new Set( [
		...Object.keys( authoritativePayload ),
		...Object.keys( incomingPayload ),
	] ) ].filter( ( field ) => artifactVariantSemanticFieldDiffers(
		authoritativePayload,
		incomingPayload,
		field,
	) ) );
	const fields = ARTIFACT_VARIANT_FIELDS.filter( ( field ) => discoveredFields.delete( field ) );
	fields.push( ...[ ...discoveredFields ].sort() );
	return {
		fields,
		paths: boundedPaths,
		stringDifferences: stringDifferences.filter( ( difference ) => boundedPaths.includes( difference.path ) ),
		truncated,
	};

}

function artifactVariantSemanticFieldDiffers( authoritative, incoming, field ) {

	if ( ! Object.hasOwn( authoritative, field ) || ! Object.hasOwn( incoming, field ) ) return true;
	return stableJsonStringify( authoritative[ field ], 'artifactVariantCollisionField' ) !==
		stableJsonStringify( incoming[ field ], 'artifactVariantCollisionField' );

}

function collectArtifactVariantSemanticDifferencePaths( authoritative, incoming, path, out, stringDifferences, limit ) {

	if ( out.length >= limit || Object.is( authoritative, incoming ) ) return;
	const authoritativeObject = authoritative !== null && typeof authoritative === 'object';
	const incomingObject = incoming !== null && typeof incoming === 'object';
	if ( ! authoritativeObject || ! incomingObject || Array.isArray( authoritative ) !== Array.isArray( incoming ) ) {

		const differencePath = path || '<root>';
		out.push( differencePath );
		if ( typeof authoritative === 'string' && typeof incoming === 'string' ) {

			stringDifferences.push( describeVariantStringDifference( differencePath, authoritative, incoming ) );

		}
		return;

	}
	const keys = Array.isArray( authoritative )
		? Array.from( { length: Math.max( authoritative.length, incoming.length ) }, ( _, index ) => String( index ) )
		: [ ...new Set( [ ...Object.keys( authoritative ), ...Object.keys( incoming ) ] ) ].sort();
	for ( const key of keys ) {

		const childPath = appendVariantDifferencePath( path, key, Array.isArray( authoritative ) );
		if ( ! Object.hasOwn( authoritative, key ) || ! Object.hasOwn( incoming, key ) ) {

			out.push( childPath );

		} else {

			collectArtifactVariantSemanticDifferencePaths( authoritative[ key ], incoming[ key ], childPath, out, stringDifferences, limit );

		}
		if ( out.length >= limit ) return;

	}

}

function describeVariantStringDifference( path, authoritative, incoming ) {

	const firstDifferenceOffset = firstStringDifferenceOffset( authoritative, incoming );
	const difference = {
		path,
		firstDifferenceOffset,
		authoritativeLength: authoritative.length,
		incomingLength: incoming.length,
	};
	const authoritativeGeneratedIdentifier = generatedIdentifierNearOffset( authoritative, firstDifferenceOffset );
	const incomingGeneratedIdentifier = generatedIdentifierNearOffset( incoming, firstDifferenceOffset );
	if ( authoritativeGeneratedIdentifier || incomingGeneratedIdentifier ) {

		difference.authoritativeGeneratedIdentifier = authoritativeGeneratedIdentifier;
		difference.incomingGeneratedIdentifier = incomingGeneratedIdentifier;

	}
	const topLevelField = topLevelVariantDifferenceField( path );
	if ( SHADER_SOURCE_FIELDS.has( topLevelField ) ) {

		difference.authoritativeExcerpt = stringDifferenceExcerpt( authoritative, firstDifferenceOffset );
		difference.incomingExcerpt = stringDifferenceExcerpt( incoming, firstDifferenceOffset );

	}
	return difference;

}

function firstStringDifferenceOffset( left, right ) {

	const length = Math.min( left.length, right.length );
	let offset = 0;
	while ( offset < length && left.charCodeAt( offset ) === right.charCodeAt( offset ) ) offset ++;
	return offset;

}

function generatedIdentifierNearOffset( value, offset ) {

	CAPTURE_GENERATED_IDENTIFIER_PATTERN.lastIndex = 0;
	let closest = null;
	let closestDistance = Infinity;
	for ( const match of value.matchAll( CAPTURE_GENERATED_IDENTIFIER_PATTERN ) ) {

		const start = match.index;
		const end = start + match[ 0 ].length;
		const distance = offset < start ? start - offset : offset > end ? offset - end : 0;
		if ( distance < closestDistance ) {

			closest = match[ 0 ];
			closestDistance = distance;

		}
		if ( distance === 0 ) break;

	}
	return closestDistance <= VARIANT_COLLISION_STRING_EXCERPT_RADIUS ? closest : null;

}

function stringDifferenceExcerpt( value, offset ) {

	const start = Math.max( 0, offset - VARIANT_COLLISION_STRING_EXCERPT_RADIUS );
	const end = Math.min( value.length, offset + VARIANT_COLLISION_STRING_EXCERPT_RADIUS );
	return `${ start > 0 ? '…' : '' }${ value.slice( start, end ) }${ end < value.length ? '…' : '' }`;

}

function appendVariantDifferencePath( parent, key, arrayParent ) {

	if ( arrayParent ) return `${ parent }[${ key }]`;
	if ( /^[A-Za-z_$][0-9A-Za-z_$]*$/.test( key ) ) return parent ? `${ parent }.${ key }` : key;
	return `${ parent }[${ JSON.stringify( key ) }]`;

}

function topLevelVariantDifferenceField( path ) {

	if ( typeof path !== 'string' || path.length === 0 || path === '<root>' ) return null;
	const match = /^[A-Za-z_$][0-9A-Za-z_$]*/.exec( path );
	if ( match ) return match[ 0 ];
	if ( ! path.startsWith( '[' ) ) return null;
	try {

		return JSON.parse( path.slice( 1, path.indexOf( ']' ) ) );

	} catch ( _ ) {

		return null;

	}

}

function formatVariantDifferencePathDetail( differences ) {

	if ( differences.paths.length === 0 ) return '';
	const stringDetail = differences.stringDifferences.slice( 0, VARIANT_COLLISION_STRING_DETAIL_LIMIT )
		.map( formatVariantStringDifference )
		.join( '; ' );
	return ` Divergent semantic paths: ${ differences.paths.join( ', ' ) }${ differences.truncated ? ', …' : '' }.` +
		( stringDetail ? ` String differences: ${ stringDetail }.` : '' );

}

function formatVariantStringDifference( difference ) {

	const location = `${ difference.path }@${ difference.firstDifferenceOffset }`;
	if ( difference.authoritativeGeneratedIdentifier || difference.incomingGeneratedIdentifier ) {

		return `${ location } (` +
			`${ difference.authoritativeGeneratedIdentifier || '<none>' } != ` +
			`${ difference.incomingGeneratedIdentifier || '<none>' })`;

	}
	if ( difference.authoritativeExcerpt !== undefined && difference.incomingExcerpt !== undefined ) {

		return `${ location } (${ JSON.stringify( difference.authoritativeExcerpt ) } != ` +
			`${ JSON.stringify( difference.incomingExcerpt ) })`;

	}
	return location;

}

/**
 * Compare independently captured variants by runnable shader/binding meaning.
 * Capture-session resource identities are canonicalized while their shared
 * versus distinct topology remains strict.
 *
 * @param {?Object} artifact
 * @return {string}
 */
export function createArtifactVariantSemanticFingerprint( artifact ) {

	return stableJsonStringify( createArtifactVariantSemanticPayload( artifact ), 'artifactVariantSemantic' );

}

function createArtifactVariantSemanticPayload( artifact ) {

	const payload = normalizeVariantShaderLanguage( createArtifactVariantPayload( artifact ) );
	delete payload.cacheKey;
	delete payload.variantKey;
	delete payload.renderContextSelectors;
	return remapArtifactEphemeralIdentities( normalizeVariantFingerprintPayload( payload ) );

}

/**
 * Normalize only values whose in-memory spelling is known to differ from the
 * durable JSON payload. Camera, clock, renderer, and render-object snapshots
 * are rewritten from the active frame and are not shader-family identity.
 * JSON.stringify maps non-finite numbers to null, so fingerprint the same
 * representation while preserving legitimate live defaults such as
 * attenuationDistance=Infinity on the authoritative in-process artifact.
 */
function normalizeVariantFingerprintPayload( value ) {

	const vsmInternalPass = !! value && VSM_INTERNAL_PASS_SHAPES.has( value.materialShape );
	const generatedShaderNodeIds = new Map();
	const generatedUniformBufferIds = new Map();
	const generatedStorageBufferIds = new Map();
	const seen = new Map();
	const visit = ( current, role = null ) => {

		if ( typeof current === 'number' && ! Number.isFinite( current ) ) return null;
		if ( current === null || typeof current !== 'object' ) return current;
		if ( seen.has( current ) ) return seen.get( current );
		const clone = Array.isArray( current ) ? [] : {};
		seen.set( current, clone );
		if ( Array.isArray( current ) ) {

			for ( const item of current ) clone.push( visit( item, role ) );
			return clone;

		}
		if ( role === 'artifact' ) for ( const field of SHADER_SOURCE_FIELDS ) {

			if ( typeof current[ field ] === 'string' ) collectCaptureGeneratedShaderNodeIds(
				current[ field ],
				generatedShaderNodeIds,
			);

		}
		const liveFrameSource = typeof current.kind === 'string' && (
			current.kind.startsWith( 'camera.' ) ||
			current.kind.startsWith( 'environment.' ) ||
			current.kind.startsWith( 'frame.' ) ||
			current.kind.startsWith( 'object.' ) ||
			current.kind.startsWith( 'pmrem.' ) ||
			current.kind.startsWith( 'renderer.' )
		);
		const livePMREMTextureSource = current.kind === 'artifact.texture' && (
			current.mapping === 306 ||
			current.textureName === 'PMREM.cubeUv'
		);
		const liveRendererTargetTextureSource = current.kind === 'artifact.texture' &&
			current.renderTargetSelector?.schema === RENDERER_RENDER_TARGET_TEXTURE_SELECTOR_SCHEMA;
		const internalPassRoleSource = vsmInternalPass && VSM_INTERNAL_PASS_ROLE_SOURCE_KINDS.has( current.kind );
		for ( const key of Object.keys( current ) ) {

			// VSM's private blur programs are shared by every non-point light.
			// The internal-pass descriptor addresses these values and textures by
			// semantic role, and the replay binder overlays the active LightShadow
			// before drawing. Captured light identity and fallback values therefore
			// prove extraction ownership but cannot distinguish runnable programs.
			// Keep the authoritative evidence in the artifact; omit it only from
			// family fingerprints so directional and spot captures can alias the
			// same backend program and selector.
			if ( vsmInternalPass && current === value && key === 'lightIdentities' ) continue;
			if ( internalPassRoleSource && INTERNAL_PASS_SOURCE_CAPTURE_FIELDS.has( key ) ) continue;
			// Three names buffer uniforms from Node.id, a module-global counter:
			// WGSL emits NodeBuffer_<id>, while WebGL fallback emits both
			// NodeBuffer_<id> and buffer<id> for the same node. Preserve the
			// shared-vs-distinct node topology in one namespace, but remove the
			// capture-order number from fingerprints. Durable shader bytes remain
			// untouched because this visitor always writes into its clone.
			if ( role === 'artifact' && SHADER_SOURCE_FIELDS.has( key ) && typeof current[ key ] === 'string' ) {

				clone[ key ] = normalizeCaptureGeneratedShaderNodeIds( current[ key ], generatedShaderNodeIds );
				continue;

			}
			if ( key === 'name' && typeof current[ key ] === 'string' ) {

				if ( ( role === 'binding-descriptors' && current.kind === 'uniform-buffer' ) || role === 'uniform-buffer-ref' ) {

					clone[ key ] = normalizeCaptureGeneratedUniformBufferName(
						current[ key ],
						generatedUniformBufferIds,
						generatedShaderNodeIds,
					);
					continue;

				}
				if ( ( role === 'binding-descriptors' && current.kind === 'storage-buffer' ) ||
					role === 'storage-buffer-entry' || role === 'storage-buffer-ref' ) {

					clone[ key ] = normalizeCaptureGeneratedStorageBufferName( current[ key ], generatedStorageBufferIds );
					continue;

				}

			}
			if ( role === 'dynamic-bindings' && key === 'binding' &&
				current.target === 'storage-buffer' && typeof current[ key ] === 'string' ) {

				clone[ key ] = normalizeCaptureGeneratedStorageBufferName( current[ key ], generatedStorageBufferIds );
				continue;

			}
			if ( liveFrameSource && key === 'valueSnapshot' ) continue;
			if ( livePMREMTextureSource && (
				key === 'imageSrc' ||
				key === 'textureName' ||
				key === 'imageWidth' ||
				key === 'imageHeight' ||
				key === 'imageDepth'
			) ) continue;
			if ( liveRendererTargetTextureSource && (
				key === 'imageWidth' ||
				key === 'imageHeight' ||
				key === 'imageDepth'
			) ) continue;
			if ( liveRendererTargetTextureSource && key === 'renderTargetSelector' ) {

				const selector = visit( current[ key ] );
				if ( selector?.hints && typeof selector.hints === 'object' ) {

					delete selector.hints.extent;
					if ( Object.keys( selector.hints ).length === 0 ) delete selector.hints;

				}
				clone[ key ] = selector;
				continue;

			}
			if ( key === 'imageSrc' &&
				typeof current.imageSrc === 'string' &&
				typeof current.textureUuid === 'string' &&
				current.textureUuid.length > 0 ) {

				clone[ key ] = normalizeLegacyLoopbackImageSrc( current.imageSrc );

			} else {

				clone[ key ] = visit( current[ key ], variantFingerprintChildRole( role, current, key ) );

			}

		}
		return clone;

	};
	return visit( value, 'artifact' );

}

function variantFingerprintChildRole( role, parent, key ) {

	if ( role === 'artifact' ) {

		if ( key === 'bindings' ) return 'binding-groups';
		if ( key === 'uniformPlan' ) return 'uniform-plan-groups';
		if ( key === 'dynamicBindings' ) return 'dynamic-bindings';
		if ( key === 'materialCompute' ) return 'material-compute';

	}
	if ( role === 'binding-groups' && key === 'bindings' ) return 'binding-descriptors';
	if ( role === 'uniform-plan-groups' ) {

		if ( key === 'storageBuffers' ) return 'storage-buffer-entry';
		if ( key === 'orderedBindings' ) return 'ordered-bindings';

	}
	if ( role === 'ordered-bindings' && key === 'ref' ) {

		if ( parent.type === 'buffer-uniform' ) return 'uniform-buffer-ref';
		if ( parent.type === 'storage-buffer' ) return 'storage-buffer-ref';

	}
	if ( role === 'material-compute' && key === 'kernels' ) return 'material-compute-kernels';
	if ( role === 'material-compute-kernels' && key === 'artifact' ) return 'artifact';
	return null;

}

function normalizeCaptureGeneratedShaderNodeIds( shader, identities ) {

	return shader.replace( CAPTURE_GENERATED_SHADER_NODE_ID_PATTERN, (
		_,
		nodeBufferPrefix,
		nodeBufferId,
		webglBufferPrefix,
		webglBufferId,
	) => {

		const prefix = nodeBufferPrefix || webglBufferPrefix;
		const nodeId = nodeBufferId || webglBufferId;
		const canonicalId = identities.get( nodeId );
		if ( canonicalId === undefined ) return _;
		return `${ prefix }<capture-node-id:${ canonicalId }>`;

	} );

}

function collectCaptureGeneratedShaderNodeIds( shader, identities ) {

	CAPTURE_GENERATED_SHADER_NODE_BUFFER_ID_PATTERN.lastIndex = 0;
	for ( const match of shader.matchAll( CAPTURE_GENERATED_SHADER_NODE_BUFFER_ID_PATTERN ) ) {

		captureGeneratedIdentityId( identities, match[ 1 ] );

	}

}

function normalizeCaptureGeneratedUniformBufferName( value, uniformBufferIdentities, shaderNodeIdentities ) {

	const uniformBufferMatch = CAPTURE_GENERATED_UNIFORM_BUFFER_NAME_PATTERN.exec( value );
	if ( uniformBufferMatch ) {

		const canonicalId = captureGeneratedIdentityId( uniformBufferIdentities, uniformBufferMatch[ 1 ] );
		return `UniformBuffer_<capture-binding-id:${ canonicalId }>`;

	}
	const webglBufferMatch = CAPTURE_GENERATED_WEBGL_BUFFER_NAME_PATTERN.exec( value );
	if ( ! webglBufferMatch ) return value;
	const canonicalId = shaderNodeIdentities.get( webglBufferMatch[ 1 ] );
	if ( canonicalId === undefined ) return value;
	return `NodeBuffer_<capture-node-id:${ canonicalId }>`;

}

function normalizeCaptureGeneratedStorageBufferName( value, identities ) {

	const match = CAPTURE_GENERATED_STORAGE_BUFFER_NAME_PATTERN.exec( value );
	if ( ! match ) return value;
	const canonicalId = captureGeneratedIdentityId( identities, match[ 1 ] );
	return `StorageBuffer_<capture-binding-id:${ canonicalId }>`;

}

function captureGeneratedIdentityId( identities, generatedId ) {

	let canonicalId = identities.get( generatedId );
	if ( canonicalId === undefined ) {

		canonicalId = identities.size;
		identities.set( generatedId, canonicalId );

	}
	return canonicalId;

}

/**
 * Before same-origin texture URLs were captured as origin-free paths, browser
 * recaptures persisted the dev server's loopback origin in `imageSrc`. Moving
 * the same app to another local port then made one unchanged resource look
 * like a divergent shader-family payload. Normalize only those legacy
 * loopback HTTP(S) URLs for comparison; durable payload bytes remain
 * authoritative, while paths, queries, fragments, and external origins stay
 * strict.
 */
function normalizeLegacyLoopbackImageSrc( value ) {

	let parsed;
	try {

		parsed = new URL( value );

	} catch ( _ ) {

		return value;

	}
	if ( parsed.protocol !== 'http:' && parsed.protocol !== 'https:' ) return value;
	if ( parsed.username || parsed.password ) return value;
	if ( ! isLoopbackHostname( parsed.hostname ) ) return value;
	return `${ parsed.pathname }${ parsed.search }${ parsed.hash }`;

}

function isLoopbackHostname( hostname ) {

	if ( typeof hostname !== 'string' || hostname.length === 0 ) return false;
	let normalized = hostname.toLowerCase();
	if ( normalized.startsWith( '[' ) && normalized.endsWith( ']' ) ) normalized = normalized.slice( 1, - 1 );
	if ( normalized.endsWith( '.' ) ) normalized = normalized.slice( 0, - 1 );
	if ( normalized === 'localhost' || normalized === '::1' ) return true;
	const ipv4 = normalized.split( '.' );
	return ipv4.length === 4 &&
		ipv4[ 0 ] === '127' &&
		ipv4.every( ( segment ) => /^\d{1,3}$/.test( segment ) && Number( segment ) <= 255 );

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

	const payload = normalizeVariantShaderLanguage( createArtifactVariantPayload( artifact ) );
	delete payload.cacheKey;
	delete payload.variantKey;
	delete payload.renderContextSelectors;
	return payload;

}

function normalizeVariantShaderLanguage( payload ) {

	if ( payload.shaderLanguage !== undefined ) return payload;
	const detected = detectArtifactShaderLanguage( payload );
	if ( detected ) payload.shaderLanguage = detected;
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
		copyVariantSelectorAdapter( current, clone );
		if ( Array.isArray( current ) ) {

			for ( const item of current ) clone.push( visit( item ) );

		} else {

			for ( const key of Object.keys( current ) ) clone[ key ] = visit( current[ key ], key );

		}
		return clone;

	};
	return visit( value );

}

function copyVariantSelectorAdapter( source, target ) {

	if ( ! source || ! target || typeof source !== 'object' || typeof target !== 'object' ) return;
	const adapter = source[ GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR ];
	if ( adapter && typeof adapter.project === 'function' && typeof adapter.match === 'function' ) {

		Object.defineProperty( target, GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR, {
			value: adapter,
			configurable: true,
			writable: true,
		} );

	} else if ( Object.hasOwn( target, GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR ) ) {

		delete target[ GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR ];

	}

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

function requiredArtifactVariantKey( artifact ) {

	requiredCacheKey( artifact );
	const variantKey = resolveArtifactVariantKey( artifact );
	if ( variantKey === null ) {

		throw new ArtifactVariantFamilyError(
			'TSLP_ARTIFACT_VARIANT_KEY_UNAVAILABLE',
			'[tsl-precompile] artifact variantKey must be a non-empty string when present.',
		);

	}
	return variantKey;

}

function canonicalSelectors( selectors ) {

	if ( ! Array.isArray( selectors ) ) return [];
	return [ ...new Set( selectors.filter( ( selector ) => typeof selector === 'string' && selector.length > 0 ) ) ].sort();

}
