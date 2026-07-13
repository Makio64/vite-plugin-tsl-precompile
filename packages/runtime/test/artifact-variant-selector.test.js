import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	ArtifactVariantSelectionError,
	selectArtifactVariant,
} from '../src/hydrate/variants/artifact-variant-selector.js';

const SELECTOR_A = JSON.stringify( { version: 'render-object-selector@1', topology: 'a' } );
const SELECTOR_B = JSON.stringify( { version: 'render-object-selector@1', topology: 'b' } );
const SELECTOR_ALIAS = JSON.stringify( { version: 'render-object-selector@1', topology: 'alias' } );

test( 'semantic selector wins when replay cache identity points at another variant', () => {

	const artifact = family();
	const selected = selectArtifactVariant( artifact, {
		renderContextSelector: SELECTOR_B,
		cacheKey: 'capture-a',
	} );
	assert.equal( selected.fragmentShader, 'fragment-b' );
	assert.deepEqual( selected.dynamicBindings, [ { kind: 'variant-b' } ] );

} );

test( 'one captured state can advertise multiple exact render-context aliases', () => {

	const artifact = family();
	artifact.variants[ 'capture-b' ].renderContextSelectors.push( SELECTOR_ALIAS );
	const selected = selectArtifactVariant( artifact, { renderContextSelector: SELECTOR_ALIAS } );
	assert.equal( selected.fragmentShader, 'fragment-b' );

} );

test( 'signed families fail closed on semantic miss', () => {

	const artifact = family();
	assert.throws(
		() => selectArtifactVariant( artifact, {
			renderContextSelector: JSON.stringify( { version: 'render-object-selector@1', topology: 'missing' } ),
			cacheKey: 'capture-a',
		} ),
		( error ) => error instanceof ArtifactVariantSelectionError
			&& error.code === 'TSLP_VARIANT_SELECTOR_MISS'
			&& error.tslPrecompileVariantSelection === true,
	);

} );

test( 'signed singleton artifacts also fail on an uncaptured topology', () => {

	const artifact = {
		cacheKey: 'single',
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		uniformPlan: [],
		bindings: [],
		renderContextSelectors: [ SELECTOR_A ],
	};
	assert.equal( selectArtifactVariant( artifact, { renderContextSelector: SELECTOR_A } ), artifact );
	assert.throws(
		() => selectArtifactVariant( artifact, { renderContextSelector: SELECTOR_B } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
	);
	assert.throws(
		() => selectArtifactVariant( artifact, { cacheKey: 'single' } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_UNAVAILABLE',
	);

} );

test( 'signed families reject unsigned siblings instead of falling through', () => {

	const artifact = family();
	delete artifact.variants[ 'capture-b' ].renderContextSelectors;
	assert.throws(
		() => selectArtifactVariant( artifact, { renderContextSelector: SELECTOR_A } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_PARTIAL_FAMILY',
	);

} );

test( 'ambiguous selector accepts equivalent aliases but rejects different payloads', () => {

	const equivalent = family();
	equivalent.variants[ 'capture-b' ] = {
		...equivalent.variants[ 'capture-a' ],
		cacheKey: 'capture-b',
	};
	assert.equal(
		selectArtifactVariant( equivalent, { renderContextSelector: SELECTOR_A } ).fragmentShader,
		'fragment-a',
	);

	const ambiguous = family();
	ambiguous.variants[ 'capture-b' ].renderContextSelectors = [ SELECTOR_A ];
	assert.throws(
		() => selectArtifactVariant( ambiguous, { renderContextSelector: SELECTOR_A, cacheKey: 'capture-b' } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_AMBIGUOUS',
	);

} );

test( 'payload equivalence ignores root-only provenance outside the shared variant contract', () => {

	const artifact = family();
	delete artifact.variants[ 'capture-a' ];
	artifact.sourceGraphHash = 'root-only-provenance';
	artifact.variants[ 'capture-b' ] = {
		...artifact.variants[ 'capture-b' ],
		cacheKey: 'capture-b',
		vertexShader: artifact.vertexShader,
		fragmentShader: artifact.fragmentShader,
		uniformPlan: artifact.uniformPlan,
		dynamicBindings: artifact.dynamicBindings,
		renderContextSelectors: [ SELECTOR_A ],
	};
	assert.doesNotThrow( () => selectArtifactVariant( artifact, { renderContextSelector: SELECTOR_A } ) );

} );

test( 'variant view memoization is scoped to the artifact root', () => {

	const variants = {
		root: {
			cacheKey: 'root',
			vertexShader: 'vertex',
			fragmentShader: 'fragment',
			uniformPlan: [],
			bindings: [],
			renderContextSelectors: [ SELECTOR_A ],
		},
	};
	const artifactA = { ...variants.root, rootMarker: 'a', variants };
	const artifactB = { ...variants.root, rootMarker: 'b', variants };
	assert.equal( selectArtifactVariant( artifactA, { renderContextSelector: SELECTOR_A } ).rootMarker, 'a' );
	assert.equal( selectArtifactVariant( artifactB, { renderContextSelector: SELECTOR_A } ).rootMarker, 'b' );

} );

test( 'legacy unsigned families retain cache-key and MRT-count fallbacks', () => {

	const artifact = {
		cacheKey: 'root',
		vertexShader: 'vertex-root',
		fragmentShader: 'fragment-root',
		uniformPlan: [],
		bindings: [],
		variants: {
			legacy: {
				cacheKey: 'legacy',
				vertexShader: 'vertex-legacy',
				fragmentShader: 'fragment-legacy',
				uniformPlan: [],
				bindings: [],
				mrtOutputCount: 2,
			},
		},
	};
	assert.equal( selectArtifactVariant( artifact, { cacheKey: 'legacy' } ).fragmentShader, 'fragment-legacy' );
	assert.equal( selectArtifactVariant( artifact, {
		cacheKey: 'different',
		material: { mrtNode: { outputNodes: { output: {}, normal: {} } } },
	} ).fragmentShader, 'fragment-legacy' );

} );

test( 'variant-local plan drops the root updater while preserving live sidecars', () => {

	const artifact = family();
	const updateGroup = () => {};
	const textureRefs = new Map( [ [ 'texture', {} ] ] );
	Object.defineProperty( artifact, '_generatedUpdateGroup', { value: updateGroup, configurable: true } );
	Object.defineProperty( artifact, '_textureRefs', { value: textureRefs, configurable: true } );

	const selectedB = selectArtifactVariant( artifact, { renderContextSelector: SELECTOR_B } );
	assert.equal( selectedB._generatedUpdateGroup, undefined );
	assert.equal( selectedB._textureRefs, textureRefs );

	const selectedA = selectArtifactVariant( artifact, { renderContextSelector: SELECTOR_A } );
	assert.equal( selectedA._generatedUpdateGroup, updateGroup );

} );

function family() {

	const planA = [ { name: 'material', slots: [ { source: { kind: 'material.opacity' }, byteOffset: 0 } ] } ];
	return {
		cacheKey: 'capture-a',
		vertexShader: 'vertex-a',
		fragmentShader: 'fragment-a',
		uniformPlan: planA,
		bindings: [],
		renderContextSelectors: [ SELECTOR_A ],
		dynamicBindings: [ { kind: 'variant-a' } ],
		variants: {
			'capture-a': {
				cacheKey: 'capture-a',
				vertexShader: 'vertex-a',
				fragmentShader: 'fragment-a',
				uniformPlan: planA,
				bindings: [],
				renderContextSelectors: [ SELECTOR_A ],
				dynamicBindings: [ { kind: 'variant-a' } ],
			},
			'capture-b': {
				cacheKey: 'capture-b',
				vertexShader: 'vertex-b',
				fragmentShader: 'fragment-b',
				uniformPlan: [ { name: 'material', slots: [ { source: { kind: 'material.opacity' }, byteOffset: 16 } ] } ],
				bindings: [],
				renderContextSelectors: [ SELECTOR_B ],
				dynamicBindings: [ { kind: 'variant-b' } ],
			},
		},
	};

}
