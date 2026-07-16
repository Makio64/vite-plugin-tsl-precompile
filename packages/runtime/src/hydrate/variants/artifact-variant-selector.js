import { countArtifactFragmentOutputs } from '@tsl-precompile/contract/fragment-outputs';
import { collectArtifactVariantCandidates, createArtifactVariantPayloadFingerprint } from '@tsl-precompile/contract/artifact-variants';
import { createRenderObjectContextSelector, projectRenderObjectContextSelector } from '@tsl-precompile/contract/render-selector';
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
	const selector = projectRenderObjectContextSelector( resolveSelector( selection ), profile );
	const memoKey = `${ profile || '' }::${ selector }::${ cacheKey === null ? '' : String( cacheKey ) }::${ targetCount }`;
	let cacheState = variantViewCache.get( artifact );
	if ( ! cacheState || cacheState.variants !== variants ) {

		cacheState = { variants, views: new Map() };
		variantViewCache.set( artifact, cacheState );

	}
	const cache = cacheState.views;
	if ( cache.has( memoKey ) ) return cache.get( memoKey );

	const candidate = computeArtifactVariant( artifact, variants, { selector, cacheKey, targetCount, profile } );
	const view = candidate && candidate !== artifact ? mergeArtifactVariantView( artifact, candidate ) : artifact;
	cache.set( memoKey, view );
	return view;

}

function selectSingletonArtifact( artifact, selection ) {

	if ( ! hasSelectors( artifact ) ) return artifact;
	const profile = selection.renderContextSelectorProfile || null;
	const selector = projectRenderObjectContextSelector( resolveSelector( selection ), profile );
	if ( selector ) {

		if ( candidateSelectors( artifact, profile ).includes( selector ) ) return artifact;
		if ( transparentDoubleSideSiblingCandidates( selector, [ artifact ], profile ).length === 1 ) return artifact;
		if ( pipelineSampleCountSiblingCandidates( selector, [ artifact ], profile ).length === 1 ) return artifact;
		if ( materialComputeStoragePaddingSiblingCandidates( selector, [ artifact ], profile ).length === 1 ) return artifact;
		throw selectorMiss( selector, [ artifact ], profile );

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

	const { selector, cacheKey, targetCount, profile } = selection;
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

			const matches = signedCandidates.filter( ( candidate ) => candidateSelectors( candidate, profile ).includes( selector ) );
			if ( matches.length > 0 ) return chooseSemanticCandidate( matches, targetCount, selector );
			const siblingMatches = transparentDoubleSideSiblingCandidates( selector, signedCandidates, profile );
			if ( siblingMatches.length > 0 ) return chooseSemanticCandidate( siblingMatches, targetCount, selector );
			const sampleCountMatches = pipelineSampleCountSiblingCandidates( selector, signedCandidates, profile );
			if ( sampleCountMatches.length > 0 ) return chooseSemanticCandidate( sampleCountMatches, targetCount, selector );
			const storagePaddingMatches = materialComputeStoragePaddingSiblingCandidates( selector, signedCandidates, profile );
			if ( storagePaddingMatches.length > 0 ) return chooseSemanticCandidate( storagePaddingMatches, targetCount, selector );
			throw selectorMiss( selector, signedCandidates, profile );

		}

		throw new ArtifactVariantSelectionError(
			'TSLP_VARIANT_SELECTOR_UNAVAILABLE',
			'[tsl-precompile/slim] This material has multiple signed render variants, but the active RenderObject could not be described. Recapture it with the current toolchain.',
			{ selectorCount: uniqueSelectors( signedCandidates, profile ).length },
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

		return createArtifactVariantPayloadFingerprint( candidate );

	} catch ( _ ) {

		return null;

	}

}

function selectorMiss( selector, candidates, profile = null ) {

	const selectors = uniqueSelectors( candidates, profile );
	return new ArtifactVariantSelectionError(
		'TSLP_VARIANT_SELECTOR_MISS',
		`[tsl-precompile/slim] No captured artifact variant matches the active render topology (${ shortSelector( selector ) }). Captured ${ selectors.length } topology selector(s). Recapture this material with the missing topology.`,
		{ selector, availableSelectors: selectors },
	);

}

function uniqueSelectors( candidates, profile = null ) {

	return [ ...new Set( candidates.flatMap( ( candidate ) => candidateSelectors( candidate, profile ) ) ) ].sort();

}

function candidateSelectors( candidate, profile ) {

	if ( ! candidate || ! Array.isArray( candidate.renderContextSelectors ) ) return [];
	return candidate.renderContextSelectors
		.filter( ( selector ) => typeof selector === 'string' && selector.length > 0 )
		.map( ( selector ) => projectRenderObjectContextSelector( selector, profile ) );

}

/**
 * Three's transparent DoubleSide compile path builds the actual FrontSide and
 * BackSide RenderObjects asynchronously. compileAsync can restore the live
 * material to DoubleSide before those queued objects are described, even
 * though the captured payload is valid for both real draw passes. Treat that
 * restored state as an alias only when one payload proves both exact siblings;
 * every other selector axis remains byte-for-byte identical and fail-closed.
 */
function transparentDoubleSideSiblingCandidates( selector, candidates, profile ) {

	const siblings = transparentDoubleSideSiblingSelectors( selector );
	if ( ! siblings ) return [];
	return candidates.filter( ( candidate ) => {

		const available = new Set( candidateSelectors( candidate, profile ) );
		return siblings.every( ( sibling ) => available.has( sibling ) );

	} );

}

function transparentDoubleSideSiblingSelectors( selector ) {

	let descriptor;
	try {

		descriptor = JSON.parse( selector );
		if ( stableJsonStringify( descriptor, 'renderObjectSelector' ) !== selector ) return null;

	} catch ( _ ) {

		return null;

	}
	const material = descriptor && ! Array.isArray( descriptor ) && descriptor.version === 'render-object-selector@1' && descriptor.material;
	if ( ! material || typeof material !== 'object' || Array.isArray( material )
		|| material.side !== 2
		|| material.transparent !== true
		|| material.forceSinglePass !== false ) return null;
	return [ 0, 1 ].map( ( side ) => stableJsonStringify( {
		...descriptor,
		material: { ...material, side },
	}, 'renderObjectSelector' ) );

}

/**
 * WebGPU owns output MSAA in the live render pipeline; it is not part of a
 * hydrated shader or binding layout. Three's one stock node-graph exception is
 * the alpha-to-coverage shape path, which branches on renderer.currentSamples
 * while building WGSL. Alias an otherwise exact 1x/4x selector only when that
 * branch is explicitly disabled. Specialized auxiliary profiles keep their
 * own target policies (background already projects samples deliberately).
 */
function pipelineSampleCountSiblingCandidates( selector, candidates, profile ) {

	if ( profile !== null && profile !== 'mesh-basic' ) return [];
	const projected = projectPipelineSampleCount( selector );
	if ( projected === null ) return [];
	return candidates.filter( ( candidate ) => candidateSelectors( candidate, profile ).some( ( capturedSelector ) => (
		projectPipelineSampleCount( capturedSelector ) === projected
	) ) );

}

function projectPipelineSampleCount( selector ) {

	let descriptor;
	try {

		descriptor = JSON.parse( selector );
		if ( stableJsonStringify( descriptor, 'renderObjectSelector' ) !== selector ) return null;

	} catch ( _ ) {

		return null;

	}
	const material = descriptor && ! Array.isArray( descriptor ) && descriptor.version === 'render-object-selector@1'
		? descriptor.material
		: null;
	const target = descriptor && descriptor.target;
	const backend = descriptor && descriptor.renderer && descriptor.renderer.backend;
	if ( ! material || typeof material !== 'object' || Array.isArray( material ) || material.alphaToCoverage !== false
		|| ! target || typeof target !== 'object' || Array.isArray( target )
		|| ( target.sampleCount !== 1 && target.sampleCount !== 4 )
		|| ! backend || backend.kind !== 'webgpu' ) return null;
	const projectedTarget = { ...target };
	delete projectedTarget.sampleCount;
	return stableJsonStringify( { ...descriptor, target: projectedTarget }, 'renderObjectSelector' );

}

/**
 * WebGPUAttributeUtils pads StorageBufferAttribute itemSize=3 data to four
 * components when it creates the GPU buffer, mutating the live attribute in
 * place. Capture can therefore observe itemSize=4 after the first upload while
 * replay describes the same attribute before upload and observes itemSize=3.
 *
 * This is not a general vertex-width alias. Require the candidate's signed
 * material-compute contract to prove itemSize=4 storage resources, preferring
 * exact render-attribute bindings and bounding explicitly unavailable hybrid
 * bindings by resource count. Project only captured 4 -> active 3 differences;
 * canonical equality then retains every other selector axis and ambiguous
 * payloads still fail closed in the caller.
 */
function materialComputeStoragePaddingSiblingCandidates( selector, candidates, profile ) {

	if ( profile !== null ) return [];
	const active = parseCanonicalRenderSelector( selector );
	if ( ! active || renderSelectorBackendKind( active ) !== 'webgpu' ) return [];
	const activeShapes = renderSelectorGeometryAttributeShapes( active );
	if ( ! activeShapes ) return [];
	return candidates.filter( ( candidate ) => {

		const paddingProof = materialComputeStoragePaddingProof( candidate );
		if ( ! paddingProof ) return false;
		return candidateSelectors( candidate, profile ).some( ( capturedSelector ) => {

			const captured = parseCanonicalRenderSelector( capturedSelector );
			if ( ! captured || renderSelectorBackendKind( captured ) !== 'webgpu' ) return false;
			const geometry = captured.object && captured.object.geometry;
			if ( ! geometry || ! Array.isArray( geometry.attributes ) ) return false;
			let projectedCount = 0;
			const attributes = geometry.attributes.map( ( entry ) => {

				if ( ! Array.isArray( entry ) || entry.length < 2 || ! paddingProof.names.has( entry[ 0 ] ) ) return entry;
				const capturedShape = entry[ 1 ];
				const activeShape = activeShapes.get( entry[ 0 ] );
				if ( ! capturedShape || typeof capturedShape !== 'object' || Array.isArray( capturedShape )
					|| ! activeShape || capturedShape.itemSize !== 4 || activeShape.itemSize !== 3 ) return entry;
				projectedCount ++;
				return [ entry[ 0 ], { ...capturedShape, itemSize: 3 } ];

			} );
			if ( projectedCount === 0 || projectedCount > paddingProof.maxChanges ) return false;
			const projected = {
				...captured,
				object: {
					...captured.object,
					geometry: { ...geometry, attributes },
				},
			};
			return stableJsonStringify( projected, 'renderObjectSelector' ) === selector;

		} );

	} );

}

function materialComputeStoragePaddingProof( candidate ) {

	const descriptor = candidate && candidate.materialCompute;
	const attributes = candidate && candidate.attributes;
	if ( ! descriptor || descriptor.version !== 'material-compute@1'
		|| ( descriptor.mode !== 'precompiled' && descriptor.mode !== 'hybrid-required' )
		|| ! Array.isArray( descriptor.resources ) || ! Array.isArray( descriptor.renderBindings )
		|| ! Array.isArray( attributes ) ) return null;
	const resources = new Map();
	for ( const resource of descriptor.resources ) {

		if ( ! resource || typeof resource.id !== 'string' || resources.has( resource.id ) ) return null;
		resources.set( resource.id, resource );

	}
	const names = new Set();
	for ( const binding of descriptor.renderBindings ) {

		if ( ! binding || binding.kind !== 'attribute' || ! Number.isSafeInteger( binding.attribute ) || binding.attribute < 0 ) continue;
		const resource = resources.get( binding.resource );
		const attribute = attributes[ binding.attribute ];
		if ( ! resource || resource.kind !== 'storage-buffer' || resource.itemSize !== 4
			|| ! attribute || attribute.source !== 'geometry'
			|| ( attribute.type !== 'vec3' && attribute.type !== 'vec4' )
			|| typeof attribute.name !== 'string' || attribute.name.length === 0 ) continue;
		names.add( attribute.name );

	}
	if ( names.size > 0 ) return { names, maxChanges: names.size };

	// Some hybrid-required captures prove all storage resources but explicitly
	// report that their live render binding identities were unavailable. Keep
	// that fallback bounded by the number of itemSize=4 storage resources and by
	// geometry attributes actually consumed by the captured vertex shader.
	if ( descriptor.mode !== 'hybrid-required' || descriptor.renderBindings.length !== 0 ) return null;
	const paddedResources = [ ...resources.values() ].filter( ( resource ) => (
		resource.kind === 'storage-buffer' && resource.itemSize === 4
	) );
	if ( paddedResources.length === 0 ) return null;
	const reasons = new Set( Array.isArray( descriptor.reasons ) ? descriptor.reasons : [] );
	if ( ! paddedResources.every( ( resource ) => reasons.has( `${ resource.id }:render-binding-unavailable` ) ) ) return null;
	for ( const attribute of attributes ) {

		if ( attribute && attribute.source === 'geometry'
			&& ( attribute.type === 'vec3' || attribute.type === 'vec4' )
			&& typeof attribute.name === 'string' && attribute.name.length > 0 ) names.add( attribute.name );

	}
	return names.size > 0 ? { names, maxChanges: paddedResources.length } : null;

}

function parseCanonicalRenderSelector( selector ) {

	let descriptor;
	try {

		descriptor = JSON.parse( selector );
		if ( stableJsonStringify( descriptor, 'renderObjectSelector' ) !== selector ) return null;

	} catch ( _ ) {

		return null;

	}
	return descriptor && ! Array.isArray( descriptor ) && descriptor.version === 'render-object-selector@1'
		? descriptor
		: null;

}

function renderSelectorBackendKind( descriptor ) {

	return descriptor && descriptor.renderer && descriptor.renderer.backend && descriptor.renderer.backend.kind || null;

}

function renderSelectorGeometryAttributeShapes( descriptor ) {

	const geometry = descriptor && descriptor.object && descriptor.object.geometry;
	if ( ! geometry || ! Array.isArray( geometry.attributes ) ) return null;
	const shapes = new Map();
	for ( const entry of geometry.attributes ) {

		if ( ! Array.isArray( entry ) || entry.length < 2 || typeof entry[ 0 ] !== 'string' || shapes.has( entry[ 0 ] ) ) return null;
		const shape = entry[ 1 ];
		if ( ! shape || typeof shape !== 'object' || Array.isArray( shape ) ) return null;
		shapes.set( entry[ 0 ], shape );

	}
	return shapes;

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
