import { forEachArtifactPayload } from './artifact-traversal.js';
import { projectRenderObjectContextSelector } from './render-selector.js';
import { stableJsonStringify } from './stable-json.js';
import { GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR } from './variant-selector-sidecar.js';

/**
 * Install the static selector adapter at the generated-module boundary.
 * Projection and bounded sibling proofs depend only on captured artifact
 * data, so keeping them behind this sidecar avoids shipping their analysis in
 * the checked prebuilt renderer. The adapter always receives the live family
 * candidates because registries may replace `artifact.variants` after module
 * initialization.
 */
export function materializeArtifactVariantSelectorAdapters( value ) {

	forEachArtifactPayload( value, ( artifact ) => {

		if ( ! hasRenderContextSelectors( artifact ) ) return;
		Object.defineProperty( artifact, GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR, {
			value: GENERATED_VARIANT_SELECTOR_ADAPTER,
			configurable: true,
			writable: true,
		} );

	} );
	return value;

}

const GENERATED_VARIANT_SELECTOR_ADAPTER = Object.freeze( {
	project: projectRenderObjectContextSelector,
	match: matchArtifactVariantCandidates,
} );

function hasRenderContextSelectors( artifact ) {

	return !! artifact && Array.isArray( artifact.renderContextSelectors )
		&& artifact.renderContextSelectors.some( ( selector ) => typeof selector === 'string' && selector.length > 0 );

}

function matchArtifactVariantCandidates( selector, profile, candidates ) {

	if ( typeof selector !== 'string' || selector.length === 0 || ! Array.isArray( candidates ) ) return [];
	const exact = candidates.filter( ( candidate ) => candidateSelectors( candidate, profile ).includes( selector ) );
	if ( exact.length > 0 ) return exact;
	const layeredTargetLayer = layeredTargetLayerSiblingCandidates( selector, candidates, profile );
	if ( layeredTargetLayer.length > 0 ) return layeredTargetLayer;
	const transparent = transparentDoubleSideSiblingCandidates( selector, candidates, profile );
	if ( transparent.length > 0 ) return transparent;
	const sampleCount = pipelineSampleCountSiblingCandidates( selector, candidates, profile );
	if ( sampleCount.length > 0 ) return sampleCount;
	return materialComputeStoragePaddingSiblingCandidates( selector, candidates, profile );

}

function candidateSelectors( candidate, profile ) {

	if ( ! candidate || ! Array.isArray( candidate.renderContextSelectors ) ) return [];
	return candidate.renderContextSelectors
		.filter( ( selector ) => typeof selector === 'string' && selector.length > 0 )
		.map( ( selector ) => projectRenderObjectContextSelector( selector, profile ) );

}

function layeredTargetLayerSiblingCandidates( selector, candidates, profile ) {

	if ( profile !== null && profile !== 'mesh-basic' ) return [];
	const projected = projectLayeredTargetLayer( selector );
	if ( projected === null ) return [];
	return candidates.filter( ( candidate ) => candidateSelectors( candidate, profile ).some( ( capturedSelector ) => (
		projectLayeredTargetLayer( capturedSelector ) === projected
	) ) );

}

function projectLayeredTargetLayer( selector ) {

	const descriptor = parseCanonicalRenderSelector( selector );
	const target = descriptor && descriptor.target;
	if ( ! target || typeof target !== 'object' || Array.isArray( target )
		|| ( target.surface !== 'offscreen-array' && target.surface !== 'offscreen-3d' )
		|| ! Number.isSafeInteger( target.activeCubeFace ) || target.activeCubeFace < 0
		|| renderSelectorBackendKind( descriptor ) !== 'webgpu' ) return null;
	const projectedTarget = { ...target };
	// In Three r185 the active array layer / 3D depth slice only selects the
	// attachment view. It is absent from RenderObject's node-builder cache key
	// and cannot alter ordinary material WGSL. Keep every other attachment and
	// pipeline axis signed, including the array-versus-3D surface distinction.
	delete projectedTarget.activeCubeFace;
	return stableJsonStringify( { ...descriptor, target: projectedTarget }, 'renderObjectSelector' );

}

function transparentDoubleSideSiblingCandidates( selector, candidates, profile ) {

	const siblings = transparentDoubleSideSiblingSelectors( selector );
	if ( ! siblings ) return [];
	return candidates.filter( ( candidate ) => {

		const available = new Set( candidateSelectors( candidate, profile ) );
		return siblings.every( ( sibling ) => available.has( sibling ) );

	} );

}

function transparentDoubleSideSiblingSelectors( selector ) {

	const descriptor = parseCanonicalRenderSelector( selector );
	const material = descriptor && descriptor.material;
	if ( ! material || typeof material !== 'object' || Array.isArray( material )
		|| material.side !== 2
		|| material.transparent !== true
		|| material.forceSinglePass !== false ) return null;
	return [ 0, 1 ].map( ( side ) => stableJsonStringify( {
		...descriptor,
		material: { ...material, side },
	}, 'renderObjectSelector' ) );

}

function pipelineSampleCountSiblingCandidates( selector, candidates, profile ) {

	if ( profile !== null && profile !== 'mesh-basic' ) return [];
	const projected = projectPipelineSampleCount( selector );
	if ( projected === null ) return [];
	return candidates.filter( ( candidate ) => candidateSelectors( candidate, profile ).some( ( capturedSelector ) => (
		projectPipelineSampleCount( capturedSelector ) === projected
	) ) );

}

function projectPipelineSampleCount( selector ) {

	const descriptor = parseCanonicalRenderSelector( selector );
	const material = descriptor && descriptor.material;
	const target = descriptor && descriptor.target;
	const backend = descriptor && descriptor.renderer && descriptor.renderer.backend;
	if ( ! material || typeof material !== 'object' || Array.isArray( material ) || material.alphaToCoverage !== false
		|| ! target || typeof target !== 'object' || Array.isArray( target )
		|| ( target.sampleCount !== 1 && target.sampleCount !== 4 )
		|| ! backend || backend.kind !== 'webgpu' ) return null;
	const projectedTarget = { ...target };
	delete projectedTarget.sampleCount;
	// r185 may realize the renderer-owned working-color target twice for the
	// same ordinary material: the live antialiased output pass uses Three's
	// private output-intermediate target (4x MSAA, LinearSRGBColorSpace), while
	// a replay/compile pass uses an ordinary single-sample 2D RenderTarget with
	// NoColorSpace. Both attachments are in the same linear shader-output
	// domain; the surface label, sample count, and color-space tag affect the
	// render pipeline/attachment, not the emitted WGSL. Keep this proof bounded
	// to one WebGPU color attachment and preserve format, type, depth, and every
	// other signed target axis.
	if ( isLinearOutputIntermediateSibling( target ) ) {

		projectedTarget.surface = 'linear-2d-intermediate';
		projectedTarget.colors = [ {
			...target.colors[ 0 ],
			colorSpace: 'linear',
		} ];

	}
	return stableJsonStringify( { ...descriptor, target: projectedTarget }, 'renderObjectSelector' );

}

function isLinearOutputIntermediateSibling( target ) {

	if ( target.surface !== 'output-intermediate' && target.surface !== 'offscreen-2d' ) return false;
	if ( ! Array.isArray( target.colors ) || target.colors.length !== 1 ) return false;
	const color = target.colors[ 0 ];
	if ( ! color || typeof color !== 'object' || Array.isArray( color ) ) return false;
	return color.colorSpace === '' || color.colorSpace === 'srgb-linear';

}

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
			return stableJsonStringify( {
				...captured,
				object: {
					...captured.object,
					geometry: { ...geometry, attributes },
				},
			}, 'renderObjectSelector' ) === selector;

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
