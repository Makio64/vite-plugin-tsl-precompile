import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';

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

test( 'transparent DoubleSide compile selectors accept one payload with both draw-side aliases', () => {

	const front = transparentSideSelector( 0 );
	const back = transparentSideSelector( 1 );
	const double = transparentSideSelector( 2 );
	const artifact = signedArtifact( [ front, back ] );
	assert.equal( selectArtifactVariant( artifact, { renderContextSelector: double } ), artifact );

} );

test( 'transparent DoubleSide compile selectors require complete sibling proof', () => {

	const front = transparentSideSelector( 0 );
	const back = transparentSideSelector( 1 );
	const double = transparentSideSelector( 2 );
	assert.throws(
		() => selectArtifactVariant( signedArtifact( [ front ] ), { renderContextSelector: double } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
		'a singleton with only one real draw side is insufficient',
	);

	const split = signedArtifact( [ front ], {
		variants: {
			front: signedArtifact( [ front ], { cacheKey: 'front', fragmentShader: 'front' } ),
			back: signedArtifact( [ back ], { cacheKey: 'back', fragmentShader: 'back' } ),
		},
	} );
	assert.throws(
		() => selectArtifactVariant( split, { renderContextSelector: double } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
		'aliases split across divergent payloads do not prove one reusable shader',
	);
	assert.throws(
		() => selectArtifactVariant( signedArtifact( [ '{ malformed', front ] ), { renderContextSelector: double } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
		'malformed captured aliases fail as a typed selector miss',
	);

} );

test( 'transparent DoubleSide compile selectors retain every unrelated topology axis', () => {

	const artifact = signedArtifact( [ transparentSideSelector( 0 ), transparentSideSelector( 1 ) ] );
	assert.throws(
		() => selectArtifactVariant( artifact, {
			renderContextSelector: transparentSideSelector( 2, { target: { surface: 'default', sampleCount: 1 } } ),
		} ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
	);
	assert.throws(
		() => selectArtifactVariant( artifact, { renderContextSelector: transparentSideSelector( 2, { material: { transparent: false } } ) } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
		'opaque DoubleSide is not the transparent two-pass compile race',
	);
	assert.throws(
		() => selectArtifactVariant( artifact, { renderContextSelector: transparentSideSelector( 2, { material: { forceSinglePass: true } } ) } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
		'forced single-pass DoubleSide has no front/back sibling pair',
	);

} );

test( 'transparent DoubleSide compile selectors reject divergent payloads with the same sibling aliases', () => {

	const selectors = [ transparentSideSelector( 0 ), transparentSideSelector( 1 ) ];
	const artifact = signedArtifact( selectors, {
		variants: {
			first: signedArtifact( selectors, { cacheKey: 'first', fragmentShader: 'first' } ),
			second: signedArtifact( selectors, { cacheKey: 'second', fragmentShader: 'second' } ),
		},
	} );
	assert.throws(
		() => selectArtifactVariant( artifact, { renderContextSelector: transparentSideSelector( 2 ) } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_AMBIGUOUS',
	);

} );

test( 'transparent DoubleSide compile selectors accept equivalent sibling-owning candidates', () => {

	const selectors = [ transparentSideSelector( 0 ), transparentSideSelector( 1 ) ];
	const first = signedArtifact( selectors, { cacheKey: 'first' } );
	const artifact = {
		...first,
		variants: {
			first,
			second: { ...first, cacheKey: 'second' },
		},
	};
	assert.equal(
		selectArtifactVariant( artifact, { renderContextSelector: transparentSideSelector( 2 ) } ).fragmentShader,
		'fragment',
	);

} );

test( 'signed background artifacts ignore scene-only topology but retain target topology', () => {

	const captureSelector = JSON.stringify( {
		version: 'render-object-selector@1',
		renderer: { backend: { kind: 'webgpu' }, shadowMap: { enabled: false, type: 0 } },
		target: { sampleCount: 1, colors: [ { kind: 'render-target', format: 1023 } ] },
		scene: { fog: null, environment: null },
		lights: [],
		camera: { array: false },
	} );
	const replaySelector = JSON.stringify( {
		version: 'render-object-selector@1',
		renderer: { backend: { kind: 'webgpu' }, shadowMap: { enabled: true, type: 1 } },
		target: { sampleCount: 1, colors: [ { kind: 'render-target', format: 1023 } ] },
		scene: { fog: 'FogExp2', environment: { kind: 'cube' } },
		lights: [ { type: 'DirectionalLight', castShadow: true } ],
		camera: { array: false },
	} );
	const artifact = {
		cacheKey: 'background',
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		uniformPlan: [],
		bindings: [],
		renderContextSelectors: [ captureSelector ],
	};
	assert.throws(
		() => selectArtifactVariant( artifact, { renderContextSelector: replaySelector } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
	);
	assert.equal( selectArtifactVariant( artifact, {
		renderContextSelector: replaySelector,
		renderContextSelectorProfile: 'background',
	} ), artifact );

	const wrongTarget = JSON.stringify( { ...JSON.parse( replaySelector ), target: { sampleCount: 4 } } );
	assert.throws(
		() => selectArtifactVariant( artifact, {
			renderContextSelector: wrongTarget,
			renderContextSelectorProfile: 'background',
		} ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
	);

} );

test( 'signed render-output artifacts ignore host and attachment identity but retain sample topology', () => {

	const captureSelector = JSON.stringify( {
		version: 'render-object-selector@1',
		renderer: { backend: { kind: 'webgpu' } },
		target: { surface: 'default', sampleCount: 1, colors: [], depthTexture: null },
		scene: { environment: { kind: '2d', colorSpace: 'srgb-linear' } },
		lights: [ { type: 'DirectionalLight', castShadow: true } ],
		camera: { array: false },
	} );
	const replaySelector = JSON.stringify( {
		version: 'render-object-selector@1',
		renderer: { backend: { kind: 'webgpu' } },
		target: {
			surface: 'offscreen-2d',
			sampleCount: 1,
			colors: [ { kind: 'render-target', format: 1023, dataType: 1016 } ],
			depthTexture: { kind: 'depth', format: 1026 },
		},
		scene: null,
		lights: [],
		camera: { array: false },
	} );
	const artifact = {
		cacheKey: 'render-output',
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		uniformPlan: [],
		bindings: [],
		renderContextSelectors: [ captureSelector ],
	};
	assert.throws(
		() => selectArtifactVariant( artifact, { renderContextSelector: replaySelector } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
	);
	assert.equal( selectArtifactVariant( artifact, {
		renderContextSelector: replaySelector,
		renderContextSelectorProfile: 'render-output',
	} ), artifact );

	const wrongTarget = JSON.stringify( {
		...JSON.parse( replaySelector ),
		target: { ...JSON.parse( replaySelector ).target, sampleCount: 4 },
	} );
	assert.throws(
		() => selectArtifactVariant( artifact, {
			renderContextSelector: wrongTarget,
			renderContextSelectorProfile: 'render-output',
		} ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
	);

} );

test( 'signed post-process artifacts ignore adapter-owned output attachments but retain pipeline topology', () => {

	const captureSelector = JSON.stringify( {
		version: 'render-object-selector@1',
		renderer: { backend: { kind: 'webgpu' } },
		target: {
			surface: 'output-intermediate',
			sampleCount: 1,
			colors: [ { kind: 'render-target', format: 1023 } ],
			depthTexture: { kind: 'depth', format: 1026 },
		},
		camera: { array: false },
		material: { fog: true, transparent: false },
	} );
	const replaySelector = JSON.stringify( {
		version: 'render-object-selector@1',
		renderer: { backend: { kind: 'webgpu' } },
		target: { surface: 'default', sampleCount: 1, colors: [], depthTexture: null },
		camera: { array: false },
		material: { fog: false, transparent: false },
	} );
	const artifact = {
		cacheKey: 'post-process',
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		uniformPlan: [],
		bindings: [],
		renderContextSelectors: [ captureSelector ],
	};
	assert.throws(
		() => selectArtifactVariant( artifact, { renderContextSelector: replaySelector } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
	);
	assert.equal( selectArtifactVariant( artifact, {
		renderContextSelector: replaySelector,
		renderContextSelectorProfile: 'post-process',
	} ), artifact );

	const wrongSampleCount = JSON.stringify( {
		...JSON.parse( replaySelector ),
		target: { ...JSON.parse( replaySelector ).target, sampleCount: 4 },
	} );
	assert.throws(
		() => selectArtifactVariant( artifact, {
			renderContextSelector: wrongSampleCount,
			renderContextSelectorProfile: 'post-process',
		} ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
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

test( 'variant-local light identity tables gate root generated updater forwarding', () => {

	const mismatched = family();
	mismatched.lightIdentities = [ { captureUuid: 'root-light', captureIndex: 0 } ];
	mismatched.variants[ 'capture-b' ].uniformPlan = mismatched.uniformPlan;
	mismatched.variants[ 'capture-b' ].lightIdentities = [ { captureUuid: 'variant-light', captureIndex: 0 } ];
	const updateGroup = () => {};
	Object.defineProperty( mismatched, '_generatedUpdateGroup', { value: updateGroup, configurable: true } );
	assert.equal( selectArtifactVariant( mismatched, { renderContextSelector: SELECTOR_B } )._generatedUpdateGroup, undefined );

	const equivalent = family();
	equivalent.lightIdentities = [ { captureUuid: 'shared-light', captureIndex: 0 } ];
	equivalent.variants[ 'capture-b' ].uniformPlan = equivalent.uniformPlan;
	equivalent.variants[ 'capture-b' ].lightIdentities = [ { captureUuid: 'shared-light', captureIndex: 0 } ];
	Object.defineProperty( equivalent, '_generatedUpdateGroup', { value: updateGroup, configurable: true } );
	assert.equal( selectArtifactVariant( equivalent, { renderContextSelector: SELECTOR_B } )._generatedUpdateGroup, updateGroup );

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

function transparentSideSelector( side, overrides = {} ) {

	const descriptor = {
		version: 'render-object-selector@1',
		target: { surface: 'offscreen-2d', sampleCount: 1 },
		object: { instanced: false },
		material: { side, transparent: true, forceSinglePass: false },
	};
	return stableJsonStringify( {
		...descriptor,
		...overrides,
		material: { ...descriptor.material, ...( overrides.material || {} ) },
	}, 'renderObjectSelector' );

}

function signedArtifact( renderContextSelectors, overrides = {} ) {

	return {
		cacheKey: 'single',
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		uniformPlan: [],
		bindings: [],
		renderContextSelectors,
		...overrides,
	};

}
