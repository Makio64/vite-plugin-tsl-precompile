import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadAux, registerAuxArtifact, __resetAuxRegistryForTests } from '../src/aux-loader.js';
import { selectArtifactVariant } from '../src/hydrate/variants/artifact-variant-selector.js';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';
import {
	dumpPrecompiledRegistry,
	getShadowArtifact,
	registerPrecompiledArtifacts,
	unregisterPrecompiledArtifacts,
} from '../src/_vendor-PrecompiledArtifactRegistry.js';

function artifact( cacheKey, fragmentShader ) {

	return {
		materialShape: 'shadow-depth',
		cacheKey,
		renderContextSelectors: [ JSON.stringify( { version: 'render-object-selector@1', cacheKey } ) ],
		vertexShader: `vertex:${ fragmentShader }`,
		fragmentShader,
		bindings: [],
		uniformPlan: [],
	};

}

test( 'precompiled registry: shadow-depth artifacts merge cache-key variants', () => {

	unregisterPrecompiledArtifacts();
	const base = artifact( 'base-key', 'base-shadow' );
	const custom = artifact( 'custom-key', 'custom-shadow' );
	custom.ltcTextures = { float: 'ltc-float', half: 'ltc-half' };
	const texture = { isTexture: true, uuid: 'tex-1' };
	Object.defineProperty( custom, '_textureRefs', {
		value: new Map( [ [ 'tex-1', texture ] ] ),
		enumerable: false,
		configurable: true,
		writable: true,
	} );

	registerPrecompiledArtifacts( [ base, custom ] );

	const registered = getShadowArtifact();
	assert.equal( registered, base );
	assert.equal( registered.variants[ 'base-key' ].fragmentShader, 'base-shadow' );
	assert.equal( registered.variants[ 'custom-key' ].fragmentShader, 'custom-shadow' );
	assert.equal( registered.variants[ 'custom-key' ].renderContextSelectors[ 0 ], custom.renderContextSelectors[ 0 ] );
	assert.deepEqual( registered.variants[ 'custom-key' ].ltcTextures, custom.ltcTextures );
	assert.equal( registered._textureRefs.get( 'tex-1' ), texture );

} );

test( 'precompiled registry unions semantic selectors for equivalent cross-family cache keys', () => {

	unregisterPrecompiledArtifacts();
	const directionalSelector = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'offscreen-2d' } } );
	const pointSelector = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'offscreen-cube' } } );
	const shared = artifact( 'shared-key', 'shared-shadow' );
	shared.renderContextSelectors = [ directionalSelector ];
	const unique = artifact( 'directional-key', 'directional-shadow' );
	const pointAlias = artifact( 'shared-key', 'shared-shadow' );
	pointAlias.renderContextSelectors = [ pointSelector ];

	registerPrecompiledArtifacts( [ shared, unique, pointAlias ] );

	const registered = getShadowArtifact();
	assert.equal( registered, shared, 'registry keeps the original root identity stable' );
	assert.deepEqual( registered.variants[ 'shared-key' ].renderContextSelectors, [ directionalSelector, pointSelector ].sort() );
	assert.equal( registered.variants[ 'directional-key' ].fragmentShader, 'directional-shadow' );
	const selectedPoint = selectArtifactVariant( registered, {
		renderContextSelector: pointSelector,
		renderContextSelectorProfile: 'shadow-depth',
	} );
	assert.equal( selectedPoint.fragmentShader, 'shared-shadow' );
	unregisterPrecompiledArtifacts();

} );

test( 'precompiled registry fails closed for divergent payloads sharing one cache key', () => {

	unregisterPrecompiledArtifacts();
	const first = artifact( 'collision-key', 'first-shadow' );
	const divergent = artifact( 'collision-key', 'different-shadow' );
	assert.throws(
		() => registerPrecompiledArtifacts( [ first, divergent ] ),
		( error ) => error && error.code === 'TSLP_ARTIFACT_VARIANT_CACHE_KEY_COLLISION',
	);
	unregisterPrecompiledArtifacts();

} );

test( 'aux loader: shadow-depth aux entries populate the shadow registry', () => {

	__resetAuxRegistryForTests();
	const shadowArtifact = artifact( 'aux-key', 'aux-shadow' );

	registerAuxArtifact( 'shadow-depth', 'hash-shadow', shadowArtifact );

	assert.equal( getShadowArtifact(), shadowArtifact );
	assert.equal( dumpPrecompiledRegistry().defaultShadow, shadowArtifact );
	__resetAuxRegistryForTests();

} );

test( 'aux loader: rejected shadow family replacement leaves both registries unchanged', () => {

	__resetAuxRegistryForTests();
	const first = artifact( 'collision-key', 'first-shadow' );
	const divergent = artifact( 'collision-key', 'different-shadow' );
	registerAuxArtifact( 'shadow-depth', 'shared-config', first );

	assert.throws(
		() => registerAuxArtifact( 'shadow-depth', 'shared-config', divergent ),
		( error ) => error && error.code === 'TSLP_ARTIFACT_VARIANT_CACHE_KEY_COLLISION',
	);
	assert.equal( getShadowArtifact(), first );
	assert.equal( loadAux( 'shadow-depth', 'shared-config' ), first );
	__resetAuxRegistryForTests();

} );
