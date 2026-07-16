import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';
import { materializeArtifactVariantSelectorAdapters } from '@tsl-precompile/contract/variant-selector-adapter';

import {
	ArtifactVariantSelectionError,
	selectArtifactVariant as selectArtifactVariantRuntime,
} from '../src/hydrate/variants/artifact-variant-selector.js';

const SELECTOR_A = JSON.stringify( { version: 'render-object-selector@1', topology: 'a' } );
const SELECTOR_B = JSON.stringify( { version: 'render-object-selector@1', topology: 'b' } );
const SELECTOR_ALIAS = JSON.stringify( { version: 'render-object-selector@1', topology: 'alias' } );

function selectArtifactVariant( artifact, selection ) {

	materializeArtifactVariantSelectorAdapters( artifact );
	return selectArtifactVariantRuntime( artifact, selection );

}

test( 'signed manual artifacts fail loudly when selector adaptation was not materialized', () => {

	const artifact = {
		cacheKey: 'manual',
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		uniformPlan: [],
		bindings: [],
		renderContextSelectors: [ SELECTOR_A ],
	};
	assert.equal( selectArtifactVariantRuntime( artifact, { renderContextSelector: SELECTOR_A } ), artifact );
	assert.throws(
		() => selectArtifactVariantRuntime( artifact, { renderContextSelector: SELECTOR_B } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_ADAPTER_UNAVAILABLE',
	);

} );

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

test( 'signed material artifacts alias pipeline-only sample counts when alpha-to-coverage is disabled', () => {

	const captured = opaqueSelector( 4 );
	const replay = opaqueSelector( 1 );
	const artifact = signedArtifact( [ captured ], { materialShape: 'mesh-standard' } );
	assert.equal( selectArtifactVariant( artifact, { renderContextSelector: replay } ), artifact );

	assert.throws(
		() => selectArtifactVariant( artifact, {
			renderContextSelector: opaqueSelector( 1, { target: { colors: [ { format: 1022 } ] } } ),
		} ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
		'attachment topology remains signed',
	);

} );

test( 'signed material artifacts retain sample counts for alpha-to-coverage shader branches', () => {

	const artifact = signedArtifact( [ opaqueSelector( 4, { material: { alphaToCoverage: true } } ) ] );
	assert.throws(
		() => selectArtifactVariant( artifact, {
			renderContextSelector: opaqueSelector( 1, { material: { alphaToCoverage: true } } ),
		} ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
	);

} );

test( 'signed material artifacts reuse WGSL across physical vertex-buffer layouts', () => {

	const capturedAttributes = {
		position: { itemSize: 3, normalized: false, stride: 13, offset: 0 },
		normal: { itemSize: 3, normalized: false, stride: 13, offset: 3 },
		uv: { itemSize: 2, normalized: false, stride: 13, offset: 6 },
		skinIndex: { itemSize: 4, normalized: false, stride: 52, offset: 32 },
	};
	const liveAttributes = {
		position: { itemSize: 3, normalized: false, stride: 9, offset: 0 },
		normal: { itemSize: 3, normalized: false, stride: 9, offset: 3 },
		uv: { itemSize: 2, normalized: false, stride: 9, offset: 6 },
		skinIndex: { itemSize: 4, normalized: false, stride: 36, offset: 32 },
	};
	const captured = vertexLayoutSelector( capturedAttributes );
	const liveLayout = vertexLayoutSelector( liveAttributes );
	const artifact = signedArtifact( [ captured ], { materialShape: 'mesh-standard' } );
	assert.equal( selectArtifactVariant( artifact, { renderContextSelector: liveLayout } ), artifact );

	assert.throws(
		() => selectArtifactVariant( artifact, {
			renderContextSelector: vertexLayoutSelector( {
				...liveAttributes,
				position: { ...liveAttributes.position, itemSize: 4 },
			} ),
		} ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
		'WGSL-facing item size still fails closed',
	);
	assert.throws(
		() => selectArtifactVariant( artifact, {
			renderContextSelector: vertexLayoutSelector( {
				...liveAttributes,
				position: { ...liveAttributes.position, normalized: true },
			} ),
		} ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
		'WGSL-facing normalization still fails closed',
	);

} );

test( 'signed singleton material-compute artifacts alias WebGPU vec3 storage padding only with bounded contract proof', () => {

	const captured = computeStorageSelector( { position: 4, storagePosition: 4, normal: 3 } );
	const replay = computeStorageSelector( { position: 3, storagePosition: 3, normal: 3 } );
	const artifact = signedArtifact( [ captured ], computeStorageArtifactFields() );
	assert.equal( selectArtifactVariant( artifact, { renderContextSelector: replay } ), artifact );

	const withoutProof = { ...artifact };
	delete withoutProof.materialCompute;
	assert.throws(
		() => selectArtifactVariant( withoutProof, { renderContextSelector: replay } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
		'storage-looking geometry is insufficient without material-compute ownership',
	);
	const insufficientProof = {
		...artifact,
		materialCompute: {
			...artifact.materialCompute,
			resources: artifact.materialCompute.resources.slice( 0, 1 ),
			reasons: [ 'resource:0:render-binding-unavailable' ],
		},
	};
	assert.throws(
		() => selectArtifactVariant( insufficientProof, { renderContextSelector: replay } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
		'the number of padded differences cannot exceed the proven itemSize=4 resources',
	);
	const partialExactBindings = {
		...artifact,
		materialCompute: {
			...artifact.materialCompute,
			renderBindings: [ { resource: 'resource:0', kind: 'attribute', attribute: 0 } ],
		},
	};
	assert.throws(
		() => selectArtifactVariant( partialExactBindings, { renderContextSelector: replay } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
		'partial exact render-binding proof cannot alias an unbound sibling attribute',
	);
	assert.throws(
		() => selectArtifactVariant( artifact, {
			renderContextSelector: computeStorageSelector( { position: 3, storagePosition: 3, normal: 4 } ),
		} ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
		'unrelated geometry widths remain signed',
	);
	assert.throws(
		() => selectArtifactVariant( artifact, {
			renderContextSelector: computeStorageSelector( { position: 3, storagePosition: 3, normal: 3 }, 'webgl' ),
		} ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_MISS',
		'the alias is specific to WebGPU storage-buffer padding',
	);

} );

test( 'signed material-compute families select and disambiguate WebGPU storage-padding siblings', () => {

	const captured = computeStorageSelector( { position: 4, storagePosition: 4, normal: 3 } );
	const replay = computeStorageSelector( { position: 3, storagePosition: 3, normal: 3 } );
	const other = computeStorageSelector( { position: 4, storagePosition: 4, normal: 3 }, 'webgpu', { instanced: true } );
	const fields = computeStorageArtifactFields();
	const first = signedArtifact( [ captured ], { ...fields, cacheKey: 'first', fragmentShader: 'first' } );
	const second = signedArtifact( [ other ], { ...fields, cacheKey: 'second', fragmentShader: 'second' } );
	const artifact = { ...first, variants: { first, second } };
	assert.equal( selectArtifactVariant( artifact, { renderContextSelector: replay } ).fragmentShader, 'first' );

	const ambiguous = {
		...first,
		variants: {
			first,
			second: { ...first, cacheKey: 'second', fragmentShader: 'second' },
		},
	};
	assert.throws(
		() => selectArtifactVariant( ambiguous, { renderContextSelector: replay } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_AMBIGUOUS',
		'divergent payloads with the same padding proof remain ambiguous',
	);

} );

test( 'pipeline-only sample aliases retain fail-closed family ambiguity', () => {

	const captured = opaqueSelector( 4 );
	const artifact = signedArtifact( [ captured ], {
		variants: {
			first: signedArtifact( [ captured ], { cacheKey: 'first', fragmentShader: 'first' } ),
			second: signedArtifact( [ captured ], { cacheKey: 'second', fragmentShader: 'second' } ),
		},
	} );
	assert.throws(
		() => selectArtifactVariant( artifact, { renderContextSelector: opaqueSelector( 1 ) } ),
		( error ) => error.code === 'TSLP_VARIANT_SELECTOR_AMBIGUOUS',
	);

} );

test( 'signed background artifacts ignore scene and target samples but retain attachment topology', () => {

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

	const replayDescriptor = JSON.parse( replaySelector );
	const otherSampleCount = JSON.stringify( {
		...replayDescriptor,
		target: { ...replayDescriptor.target, sampleCount: 4 },
	} );
	assert.equal( selectArtifactVariant( artifact, {
		renderContextSelector: otherSampleCount,
		renderContextSelectorProfile: 'background',
	} ), artifact );

	const cubeTarget = JSON.stringify( {
		...replayDescriptor,
		target: { ...replayDescriptor.target, colors: [ { kind: 'cube', format: 1023 } ] },
	} );
	assert.equal( selectArtifactVariant( artifact, {
		renderContextSelector: cubeTarget,
		renderContextSelectorProfile: 'background',
	} ), artifact );

	const otherFaceAndMip = JSON.stringify( {
		...replayDescriptor,
		target: { ...replayDescriptor.target, activeCubeFace: 4, activeMipmapLevel: 2 },
	} );
	assert.equal( selectArtifactVariant( artifact, {
		renderContextSelector: otherFaceAndMip,
		renderContextSelectorProfile: 'background',
	} ), artifact );

	const wrongTarget = JSON.stringify( {
		...replayDescriptor,
		target: { ...replayDescriptor.target, colors: [ { kind: 'render-target', format: 1022 } ] },
	} );
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

function opaqueSelector( sampleCount, overrides = {} ) {

	const descriptor = {
		version: 'render-object-selector@1',
		renderer: { backend: { kind: 'webgpu' } },
		target: { surface: 'offscreen-2d', sampleCount, colors: [ { format: 1023 } ] },
		object: { instanced: true },
		material: { side: 0, transparent: false, forceSinglePass: false, alphaToCoverage: false },
	};
	return stableJsonStringify( {
		...descriptor,
		...overrides,
		target: { ...descriptor.target, ...( overrides.target || {} ) },
		material: { ...descriptor.material, ...( overrides.material || {} ) },
	}, 'renderObjectSelector' );

}

function vertexLayoutSelector( attributes ) {

	return stableJsonStringify( {
		version: 'render-object-selector@1',
		object: {
			geometry: {
				attributes: Object.entries( attributes ).sort( ( left, right ) => left[ 0 ].localeCompare( right[ 0 ] ) ),
				morphAttributes: [],
			},
		},
	}, 'renderObjectSelector' );

}

function computeStorageSelector( itemSizes, backend = 'webgpu', objectOverrides = {} ) {

	return stableJsonStringify( {
		version: 'render-object-selector@1',
		renderer: { backend: { kind: backend } },
		object: {
			instanced: false,
			...objectOverrides,
			geometry: {
				attributes: Object.entries( itemSizes )
					.sort( ( left, right ) => left[ 0 ].localeCompare( right[ 0 ] ) )
					.map( ( [ name, itemSize ] ) => [ name, { itemSize, normalized: false } ] ),
				morphAttributes: [],
			},
		},
	}, 'renderObjectSelector' );

}

function computeStorageArtifactFields() {

	return {
		attributes: [
			{ name: 'position', type: 'vec4', source: 'geometry' },
			{ name: 'storagePosition', type: 'vec3', source: 'geometry' },
			{ name: 'normal', type: 'vec3', source: 'geometry' },
		],
		materialCompute: {
			version: 'material-compute@1',
			mode: 'hybrid-required',
			reasons: [
				'resource:0:render-binding-unavailable',
				'resource:1:render-binding-unavailable',
				'resource:2:render-binding-unavailable',
			],
			resources: [
				{ id: 'resource:0', kind: 'storage-buffer', itemSize: 4 },
				{ id: 'resource:1', kind: 'storage-buffer', itemSize: 4 },
				{ id: 'resource:2', kind: 'storage-buffer', itemSize: 4 },
			],
			renderBindings: [],
		},
	};

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
