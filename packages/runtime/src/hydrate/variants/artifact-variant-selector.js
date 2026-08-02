import { countArtifactFragmentOutputs } from '@tsl-precompile/contract/fragment-outputs';
import { collectArtifactVariantCandidates, createArtifactVariantSemanticFingerprint } from '@tsl-precompile/contract/artifact-variants';
import { createRenderObjectContextSelector } from '@tsl-precompile/contract/render-selector';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';
import { GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR } from '@tsl-precompile/contract/variant-selector-sidecar';

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
 *   renderContextSelectorProfile?: string|null,
 * }} [selection]
 * @return {Object}
 */
export function selectArtifactVariant( artifact, selection = {} ) {

	const variants = artifact && artifact.variants && typeof artifact.variants === 'object' ? artifact.variants : null;
	if ( ! variants ) return selectSingletonArtifact( artifact, selection );

	const material = selection.material || null;
	const cacheKey = selection.cacheKey ?? null;
	const targetCount = renderObjectOutputCount( selection.renderObject ) || materialMRTOutputCount( material );
	const profile = selection.renderContextSelectorProfile || null;
	const adapter = variantSelectorAdapter( artifact );
	const selector = projectSelector( adapter, resolveSelector( selection ), profile );
	const memoKey = `${ profile || '' }::${ selector }::${ cacheKey === null ? '' : String( cacheKey ) }::${ targetCount }`;
	let cacheState = variantViewCache.get( artifact );
	if ( ! cacheState || cacheState.variants !== variants ) {

		cacheState = { variants, views: new Map() };
		variantViewCache.set( artifact, cacheState );

	}
	const cache = cacheState.views;
	if ( cache.has( memoKey ) ) return cache.get( memoKey );

	const candidate = computeArtifactVariant( artifact, variants, { selector, cacheKey, targetCount, profile, adapter } );
	const view = candidate && candidate !== artifact ? mergeArtifactVariantView( artifact, candidate ) : artifact;
	cache.set( memoKey, view );
	return view;

}

function selectSingletonArtifact( artifact, selection ) {

	if ( ! hasSelectors( artifact ) ) return artifact;
	const profile = selection.renderContextSelectorProfile || null;
	const adapter = variantSelectorAdapter( artifact );
	const selector = projectSelector( adapter, resolveSelector( selection ), profile );
	if ( selector ) {

		if ( matchCandidates( adapter, selector, profile, [ artifact ] ).length === 1 ) return artifact;
		if ( ! adapter ) throw selectorAdapterUnavailable();
		throw selectorMiss( selector, [ artifact ], profile, adapter );

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

function variantSelectorAdapter( artifact ) {

	const adapter = artifact && artifact[ GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR ];
	return adapter && typeof adapter.project === 'function' && typeof adapter.match === 'function' ? adapter : null;

}

function projectSelector( adapter, selector, profile ) {

	return adapter ? adapter.project( selector, profile ) : selector;

}

function matchCandidates( adapter, selector, profile, candidates ) {

	if ( adapter ) return adapter.match( selector, profile, candidates );
	return candidates.filter( ( candidate ) => candidate && Array.isArray( candidate.renderContextSelectors )
		&& candidate.renderContextSelectors.includes( selector ) );

}

function selectorAdapterUnavailable() {

	return new ArtifactVariantSelectionError(
		'TSLP_VARIANT_SELECTOR_ADAPTER_UNAVAILABLE',
		'[tsl-precompile/slim] This signed artifact was not materialized by its generated module. Recapture it, or call materializeArtifactVariantSelectorAdapters() before manual registration.',
	);

}

function computeArtifactVariant( artifact, variants, selection ) {

	const { selector, cacheKey, targetCount, profile, adapter } = selection;
	const candidates = collectCandidates( artifact );
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

			const matches = matchCandidates( adapter, selector, profile, signedCandidates );
			if ( matches.length > 0 ) return chooseSemanticCandidate( matches, targetCount, selector );
			if ( ! adapter ) throw selectorAdapterUnavailable();
			throw selectorMiss( selector, signedCandidates, profile, adapter );

		}

		throw new ArtifactVariantSelectionError(
			'TSLP_VARIANT_SELECTOR_UNAVAILABLE',
			'[tsl-precompile/slim] This material has multiple signed render variants, but the active RenderObject could not be described. Recapture it with the current toolchain.',
			{ selectorCount: uniqueSelectors( signedCandidates, profile, adapter ).length },
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

function collectCandidates( artifact ) {

	return collectArtifactVariantCandidates( artifact );

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

	try {

		return createArtifactVariantSemanticFingerprint( candidate );

	} catch ( _ ) {

		return null;

	}

}

function selectorMiss( selector, candidates, profile = null, adapter = null ) {

	const selectors = uniqueSelectors( candidates, profile, adapter );
	const differencePaths = closestSelectorDifferencePaths( selector, selectors );
	const differenceHint = differencePaths.length > 0
		? ` Closest capture differs at ${ differencePaths.join( ', ' ) }.`
		: '';
	const artifactContext = {
		names: [ ...new Set( candidates.map( ( candidate ) => candidate && ( candidate.__tslpAuxName || candidate.name || candidate.__name ) ).filter( ( value ) => typeof value === 'string' && value.length > 0 ) ) ],
		materialUuids: [ ...new Set( candidates.map( ( candidate ) => candidate && candidate.materialUuid ).filter( ( value ) => typeof value === 'string' && value.length > 0 ) ) ],
		shapes: [ ...new Set( candidates.map( ( candidate ) => candidate && ( candidate.__tslpAuxShape || candidate.materialShape || candidate.shape ) ).filter( ( value ) => typeof value === 'string' && value.length > 0 ) ) ],
		cacheKeys: [ ...new Set( candidates.map( ( candidate ) => candidate && candidate.cacheKey ).filter( ( value ) => value !== null && value !== undefined ) ) ],
	};
	const remediation = {
		schema: 'tslp-selector-remediation@1',
		code: 'capture-missing-render-topology',
		skill: 'integrate-tsl-precompile',
		nextActions: [
			{
				id: 'capture-missing-render-topology',
				kind: 'manual',
				cwd: null,
				argv: null,
				dependsOn: [],
				requiresInput: [ 'route', 'state' ],
				action: 'Capture the real route and state that exercises closestDifferencePaths.',
			},
			{
				id: 'run-project-doctor',
				kind: 'manual',
				cwd: null,
				argv: null,
				dependsOn: [ 'capture-missing-render-topology' ],
				requiresInput: [ 'packageManager', 'projectRoot' ],
				commandTemplate: '<package-exec> tsl-precompile-doctor --json --compact',
				argvByPackageManager: {
					pnpm: [ 'pnpm', 'exec', 'tsl-precompile-doctor', '--json', '--compact' ],
					npm: [ 'npx', '--no-install', 'tsl-precompile-doctor', '--json', '--compact' ],
					yarn: [ 'yarn', 'exec', 'tsl-precompile-doctor', '--json', '--compact' ],
					bun: [ 'bunx', '--bun', 'tsl-precompile-doctor', '--json', '--compact' ],
				},
				action: 'Run the project-local doctor and execute its emitted verify/build actions in dependency order.',
			},
		],
		repeatedMismatch: 'Run the doctor command and report the selector difference instead of repeating capture.',
		generatedArtifactPolicy: 'Do not hand-edit generated artifacts.',
	};
	return new ArtifactVariantSelectionError(
		'TSLP_VARIANT_SELECTOR_MISS',
		`[tsl-precompile/slim] No captured artifact variant matches the active render topology (${ shortSelector( selector ) }). Captured ${ selectors.length } topology selector(s).${ differenceHint } Use $integrate-tsl-precompile to capture that real route/state, verify, then rebuild slim. If a fresh capture repeats this difference, run the project-local \`tsl-precompile-doctor --json --compact\`; do not hand-edit generated artifacts.`,
		{
			selector,
			availableSelectors: selectors,
			closestDifferencePaths: differencePaths,
			artifactContext,
			cacheKeys: artifactContext.cacheKeys,
			remediation,
		},
	);

}

function closestSelectorDifferencePaths( selector, availableSelectors ) {

	let active;
	try {

		active = JSON.parse( selector );

	} catch ( _ ) {

		return [];

	}
	let closest = [];
	for ( const available of availableSelectors ) {

		let captured;
		try {

			captured = JSON.parse( available );

		} catch ( _ ) {

			continue;

		}
		const paths = [];
		collectSelectorDifferencePaths( active, captured, '', paths, 8 );
		if ( closest.length === 0 || paths.length < closest.length ) closest = paths;

	}
	return closest.slice( 0, 4 );

}

function collectSelectorDifferencePaths( active, captured, path, out, limit ) {

	if ( out.length >= limit ) return;
	if ( Object.is( active, captured ) ) return;
	const activeObject = active !== null && typeof active === 'object';
	const capturedObject = captured !== null && typeof captured === 'object';
	if ( ! activeObject || ! capturedObject || Array.isArray( active ) !== Array.isArray( captured ) ) {

		out.push( path || '<root>' );
		return;

	}
	const keys = Array.isArray( active ) && Array.isArray( captured )
		? Array.from( { length: Math.max( active.length, captured.length ) }, ( _, index ) => String( index ) )
		: [ ...new Set( [ ...Object.keys( active ), ...Object.keys( captured ) ] ) ].sort();
	for ( const key of keys ) {

		const childPath = Array.isArray( active ) ? `${ path }[${ key }]` : path ? `${ path }.${ key }` : key;
		if ( ! Object.prototype.hasOwnProperty.call( active, key ) || ! Object.prototype.hasOwnProperty.call( captured, key ) ) {

			out.push( childPath );

		} else {

			collectSelectorDifferencePaths( active[ key ], captured[ key ], childPath, out, limit );

		}
		if ( out.length >= limit ) return;

	}

}

function uniqueSelectors( candidates, profile = null, adapter = null ) {

	return [ ...new Set( candidates.flatMap( ( candidate ) => (
		candidate && Array.isArray( candidate.renderContextSelectors )
			? candidate.renderContextSelectors
				.filter( ( selector ) => typeof selector === 'string' && selector.length > 0 )
				.map( ( selector ) => projectSelector( adapter, selector, profile ) )
			: []
	) ) ) ].sort();

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
	for ( const sidecar of [ GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR, '_textureRefs', '_liveUpdateNodes', '_liveUpdateBeforeNodes', '_liveUpdateAfterNodes', '_unsupportedKinds', '_textureResolutionStrategies' ] ) {

		forwardSidecar( merged, artifact, sidecar );

	}

	// The generated updater closes over both the root uniformPlan sources and
	// their module-level light identity table. Forward it only when both inputs
	// match the selected variant; otherwise the hydrator's descriptor-driven
	// generic writer is the correct safe path.
	if ( sameGeneratedUpdaterInputs( artifact, variant ) ) forwardSidecar( merged, artifact, '_generatedUpdateGroup' );
	return merged;

}

function sameGeneratedUpdaterInputs( artifact, variant ) {

	return sameSerializedField( artifact.uniformPlan, variant.uniformPlan, 'uniformPlan' )
		&& sameSerializedField( artifact.lightIdentities, variant.lightIdentities, 'lightIdentities' );

}

function sameSerializedField( rootValue, variantValue, label ) {

	if ( rootValue === variantValue ) return true;
	try {

		return stableJsonStringify( rootValue || [], `root${ label }` ) === stableJsonStringify( variantValue || [], `variant${ label }` );

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
