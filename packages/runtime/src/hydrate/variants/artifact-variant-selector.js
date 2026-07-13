import { countArtifactFragmentOutputs } from '@tsl-precompile/contract/fragment-outputs';
import { createArtifactVariantPayload } from '@tsl-precompile/contract/artifact-variants';
import { createRenderObjectContextSelector } from '@tsl-precompile/contract/render-selector';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';

// The registry replaces `artifact.variants` whenever a family grows, so a
// per-artifact cache cannot observe a stale member list or leak root sidecars
// between two artifacts that happen to share the same variants object.
const variantViewCache = new WeakMap();

export class ArtifactVariantSelectionError extends Error {

	constructor( code, message, details = {} ) {

		super( message );
		this.name = 'ArtifactVariantSelectionError';
		this.code = code;
		this.details = details;
		this.tslPrecompileVariantSelection = true;

	}

}

/**
 * Select a captured shader/binding variant by reproducible render topology.
 * Private Three cache keys and MRT count remain compatibility fallbacks only
 * for unsigned legacy families.
 *
 * @param {Object} artifact
 * @param {{
 *   material?: Object|null,
 *   cacheKey?: number|string|null,
 *   renderObject?: Object|null,
 *   renderContextSelector?: string|null,
 * }} [selection]
 * @return {Object}
 */
export function selectArtifactVariant( artifact, selection = {} ) {

	const variants = artifact && artifact.variants && typeof artifact.variants === 'object' ? artifact.variants : null;
	if ( ! variants ) return selectSingletonArtifact( artifact, selection );

	const material = selection.material || null;
	const cacheKey = selection.cacheKey ?? null;
	const targetCount = renderObjectOutputCount( selection.renderObject ) || materialMRTOutputCount( material );
	const selector = resolveSelector( selection );
	const memoKey = `${ selector }::${ cacheKey === null ? '' : String( cacheKey ) }::${ targetCount }`;
	let cacheState = variantViewCache.get( artifact );
	if ( ! cacheState || cacheState.variants !== variants ) {

		cacheState = { variants, views: new Map() };
		variantViewCache.set( artifact, cacheState );

	}
	const cache = cacheState.views;
	if ( cache.has( memoKey ) ) return cache.get( memoKey );

	const candidate = computeArtifactVariant( artifact, variants, { selector, cacheKey, targetCount } );
	const view = candidate && candidate !== artifact ? mergeArtifactVariantView( artifact, candidate ) : artifact;
	cache.set( memoKey, view );
	return view;

}

function selectSingletonArtifact( artifact, selection ) {

	if ( ! hasSelectors( artifact ) ) return artifact;
	const selector = resolveSelector( selection );
	if ( selector ) {

		if ( artifact.renderContextSelectors.includes( selector ) ) return artifact;
		throw selectorMiss( selector, [ artifact ] );

	}
	throw new ArtifactVariantSelectionError(
		'TSLP_VARIANT_SELECTOR_UNAVAILABLE',
		'[tsl-precompile/slim] This signed artifact requires an active RenderObject selector. Recapture it with the current toolchain if this topology should be supported.',
		{ selectorCount: artifact.renderContextSelectors.length },
	);

}

function resolveSelector( selection ) {

	if ( typeof selection.renderContextSelector === 'string' && selection.renderContextSelector.length > 0 ) return selection.renderContextSelector;
	if ( ! selection.renderObject ) return '';
	try {

		return createRenderObjectContextSelector( selection.renderObject );

	} catch ( _ ) {

		// Proxies and custom objects may refuse reflection. An exact legacy key
		// can still serve an unsigned artifact; signed families fail closed.
		return '';

	}

}

function computeArtifactVariant( artifact, variants, selection ) {

	const { selector, cacheKey, targetCount } = selection;
	const candidates = collectCandidates( artifact, variants );
	const signedCandidates = candidates.filter( hasSelectors );

	if ( signedCandidates.length > 0 ) {

		if ( signedCandidates.length !== candidates.length ) {

			throw new ArtifactVariantSelectionError(
				'TSLP_VARIANT_SELECTOR_PARTIAL_FAMILY',
				'[tsl-precompile/slim] This artifact family mixes signed and unsigned variants. Recapture the material with one toolchain version.',
				{ signedCount: signedCandidates.length, candidateCount: candidates.length },
			);

		}

		if ( selector ) {

			const matches = signedCandidates.filter( ( candidate ) => candidate.renderContextSelectors.includes( selector ) );
			if ( matches.length === 0 ) throw selectorMiss( selector, signedCandidates );
			return chooseSemanticCandidate( matches, targetCount, selector );

		}

		throw new ArtifactVariantSelectionError(
			'TSLP_VARIANT_SELECTOR_UNAVAILABLE',
			'[tsl-precompile/slim] This material has multiple signed render variants, but the active RenderObject could not be described. Recapture it with the current toolchain.',
			{ selectorCount: uniqueSelectors( signedCandidates ).length },
		);

	}

	// Legacy family: retain the previous private-key and output-count behavior.
	const exact = exactCacheKeyCandidate( candidates, cacheKey );
	if ( exact ) return exact;
	if ( targetCount > 1 ) {

		const outputVariant = selectVariantForOutputCount( candidates, targetCount );
		if ( outputVariant ) return outputVariant;

	}
	return artifact;

}

function collectCandidates( artifact, variants ) {

	const candidates = Object.values( variants ).filter( Boolean );
	const rootKey = artifact && artifact.cacheKey;
	const rootAlreadyPresent = rootKey !== undefined && rootKey !== null
		&& candidates.some( ( candidate ) => String( candidate.cacheKey ) === String( rootKey ) );
	if ( ! rootAlreadyPresent ) candidates.unshift( artifact );
	return candidates;

}

function hasSelectors( candidate ) {

	return !! candidate && Array.isArray( candidate.renderContextSelectors )
		&& candidate.renderContextSelectors.some( ( selector ) => typeof selector === 'string' && selector.length > 0 );

}

function chooseSemanticCandidate( candidates, targetCount, selector ) {

	if ( candidates.length === 1 ) return candidates[ 0 ];

	let narrowed = candidates;
	if ( targetCount > 1 ) {

		const bestCount = bestOutputCount( candidates, targetCount );
		if ( bestCount !== null ) narrowed = candidates.filter( ( candidate ) => countArtifactFragmentOutputs( candidate, 1 ) === bestCount );

	}
	if ( narrowed.length === 1 ) return narrowed[ 0 ];
	if ( variantsEquivalent( narrowed ) ) return narrowed[ 0 ];

	throw new ArtifactVariantSelectionError(
		'TSLP_VARIANT_SELECTOR_AMBIGUOUS',
		`[tsl-precompile/slim] ${ narrowed.length } non-equivalent artifact variants match the active render topology. Recapture the material so each topology has one payload.`,
		{ selector, cacheKeys: narrowed.map( ( candidate ) => candidate.cacheKey ?? null ) },
	);

}

function exactCacheKeyCandidate( candidates, cacheKey ) {

	if ( cacheKey === null || cacheKey === undefined ) return null;
	const key = String( cacheKey );
	return candidates.find( ( candidate ) => candidate && String( candidate.cacheKey ) === key ) || null;

}

function selectVariantForOutputCount( candidates, targetCount ) {

	const count = bestOutputCount( candidates, targetCount );
	return count === null ? null : candidates.find( ( candidate ) => countArtifactFragmentOutputs( candidate, 1 ) === count ) || null;

}

function bestOutputCount( candidates, targetCount ) {

	if ( targetCount <= 1 ) return null;
	let bestCount = Infinity;
	for ( const candidate of candidates ) {

		const count = countArtifactFragmentOutputs( candidate, 1 );
		if ( count >= targetCount && count < bestCount ) bestCount = count;

	}
	return bestCount === Infinity ? null : bestCount;

}

function variantsEquivalent( candidates ) {

	if ( candidates.length < 2 ) return true;
	const first = variantPayloadFingerprint( candidates[ 0 ] );
	return first !== null && candidates.slice( 1 ).every( ( candidate ) => {

		const fingerprint = variantPayloadFingerprint( candidate );
		return fingerprint !== null && fingerprint === first;

	} );

}

function variantPayloadFingerprint( candidate ) {

	const payload = createArtifactVariantPayload( candidate );
	delete payload.cacheKey;
	delete payload.renderContextSelectors;
	try {

		return stableJsonStringify( payload, 'artifactVariant' );

	} catch ( _ ) {

		return null;

	}

}

function selectorMiss( selector, candidates ) {

	const selectors = uniqueSelectors( candidates );
	return new ArtifactVariantSelectionError(
		'TSLP_VARIANT_SELECTOR_MISS',
		`[tsl-precompile/slim] No captured artifact variant matches the active render topology (${ shortSelector( selector ) }). Captured ${ selectors.length } topology selector(s). Recapture this material with the missing topology.`,
		{ selector, availableSelectors: selectors },
	);

}

function uniqueSelectors( candidates ) {

	return [ ...new Set( candidates.flatMap( ( candidate ) => Array.isArray( candidate.renderContextSelectors ) ? candidate.renderContextSelectors : [] ) ) ].sort();

}

function shortSelector( selector ) {

	let hash = 2166136261;
	for ( let index = 0; index < selector.length; index ++ ) {

		hash ^= selector.charCodeAt( index );
		hash = Math.imul( hash, 16777619 );

	}
	return `selector:${ ( hash >>> 0 ).toString( 36 ) }`;

}

function materialMRTOutputCount( material ) {

	const mrt = material && material.mrtNode;
	const outputMap = mrt && ( mrt.outputNodes || mrt.nodes );
	return outputMap && typeof outputMap === 'object' ? Object.keys( outputMap ).length : 0;

}

function renderObjectOutputCount( renderObject ) {

	const context = renderObject && renderObject.context;
	const mrt = context && context.mrt;
	const outputs = mrt && ( mrt.outputNodes || mrt.nodes );
	if ( outputs && typeof outputs === 'object' ) return Object.keys( outputs ).length;
	const textures = context && context.textures;
	return Array.isArray( textures ) && textures.length > 1 ? textures.length : 0;

}

function mergeArtifactVariantView( artifact, variant ) {

	const merged = Object.assign( Object.create( Object.getPrototypeOf( artifact ) || null ), artifact, variant );
	for ( const sidecar of [ '_textureRefs', '_liveUpdateNodes', '_liveUpdateBeforeNodes', '_liveUpdateAfterNodes', '_unsupportedKinds', '_textureResolutionStrategies' ] ) {

		forwardSidecar( merged, artifact, sidecar );

	}

	// The generated updater is compiled from the root uniformPlan. Forward it
	// only when the selected variant has the same plan; otherwise the hydrator's
	// descriptor-driven generic writer is the correct safe path.
	if ( sameUniformPlan( artifact, variant ) ) forwardSidecar( merged, artifact, '_generatedUpdateGroup' );
	return merged;

}

function sameUniformPlan( artifact, variant ) {

	if ( artifact.uniformPlan === variant.uniformPlan ) return true;
	try {

		return stableJsonStringify( artifact.uniformPlan || [], 'rootUniformPlan' ) === stableJsonStringify( variant.uniformPlan || [], 'variantUniformPlan' );

	} catch ( _ ) {

		return false;

	}

}

function forwardSidecar( merged, artifact, sidecar ) {

	Object.defineProperty( merged, sidecar, {
		get() {

			return artifact[ sidecar ];

		},
		set( value ) {

			Object.defineProperty( artifact, sidecar, {
				value,
				enumerable: false,
				configurable: true,
				writable: true,
			} );

		},
		enumerable: false,
		configurable: true,
	} );

}
