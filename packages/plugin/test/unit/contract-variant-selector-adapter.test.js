import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeArtifactVariantFamily } from '@tsl-precompile/contract/artifact-variants';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';
import { materializeArtifactVariantSelectorAdapters } from '@tsl-precompile/contract/variant-selector-adapter';
import { GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR } from '@tsl-precompile/contract/variant-selector-sidecar';

test( 'generated selector adapters traverse wrappers, variants, and material-compute kernels', () => {

	const selector = stableJsonStringify( {
		version: 'render-object-selector@1',
		object: {
			geometry: {
				attributes: [ [ 'position', { itemSize: 3, normalized: false, stride: 8, offset: 2 } ] ],
				morphAttributes: [],
			},
		},
	}, 'renderObjectSelector' );
	const variant = signedArtifact( 'variant', [ selector ] );
	const kernel = signedArtifact( 'kernel', [ selector ] );
	const root = signedArtifact( 'root', [ selector ], {
		variants: { variant },
		materialCompute: {
			version: 'material-compute@1',
			mode: 'precompiled',
			resources: [],
			renderBindings: [],
			kernels: [ { id: 'kernel', artifact: kernel } ],
		},
	} );

	const wrapper = [ { artifact: root } ];
	assert.equal( materializeArtifactVariantSelectorAdapters( wrapper ), wrapper );
	for ( const artifact of [ root, variant, kernel ] ) {

		const descriptor = Object.getOwnPropertyDescriptor( artifact, GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR );
		assert.equal( typeof descriptor.value.project, 'function' );
		assert.equal( typeof descriptor.value.match, 'function' );
		assert.equal( descriptor.enumerable, false );

	}
	const projected = JSON.parse( root[ GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR ].project( selector, null ) );
	assert.deepEqual( projected.object.geometry.attributes, [ [ 'position', { itemSize: 3, normalized: false } ] ] );

} );

test( 'selector adapters follow live candidates after family merging', () => {

	const front = transparentSelector( 0 );
	const back = transparentSelector( 1 );
	const active = transparentSelector( 2 );
	const target = signedArtifact( 'shared', [ front ] );
	const incoming = signedArtifact( 'shared', [ back ] );
	materializeArtifactVariantSelectorAdapters( [ target, incoming ] );

	mergeArtifactVariantFamily( target, [ target, incoming ] );
	assert.deepEqual( target.renderContextSelectors, [ back, front ].sort() );
	const adapter = target[ GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR ];
	assert.equal( adapter.match( active, null, [ target ] )[ 0 ], target );

} );

test( 'family merging adopts a generated selector adapter from an equivalent input', () => {

	const front = transparentSelector( 0 );
	const back = transparentSelector( 1 );
	const target = signedArtifact( 'shared', [ front ] );
	const generated = signedArtifact( 'shared', [ back ] );
	materializeArtifactVariantSelectorAdapters( generated );

	mergeArtifactVariantFamily( target, generated );
	const adapter = target[ GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR ];
	assert.equal( typeof adapter.project, 'function' );
	assert.equal( adapter.match( transparentSelector( 2 ), null, [ target ] )[ 0 ], target );

} );

function transparentSelector( side ) {

	return stableJsonStringify( {
		version: 'render-object-selector@1',
		material: { side, transparent: true, forceSinglePass: false },
	}, 'renderObjectSelector' );

}

function signedArtifact( cacheKey, renderContextSelectors, overrides = {} ) {

	return {
		cacheKey,
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		uniformPlan: [],
		bindings: [],
		renderContextSelectors,
		...overrides,
	};

}
