import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@babel/parser';
import { collectArtifactDynamicBindings } from '@tsl-precompile/contract/dynamic-bindings';

import { emitArtifactModule, prepareAuxArtifactForEmission } from '../../src/emit-manifest.js';

function textureGroup( name, binding, source, textureType = '2d' ) {

	return {
		name,
		textures: [ { name: binding, textureType, source } ],
		slots: [],
	};

}

test( 'generated artifact modules omit redundant dynamicBindings literals and restore the public API on execution', async () => {

	const renderTargetSelector = {
		schema: 'renderer-render-target-texture@1',
		attachment: { role: 'color', index: 0 },
		target: { topology: 'single', dimension: 'cube', mrtCount: 1 },
		texture: { dimension: 'cube', format: 1023, type: 1009, colorSpace: 'srgb-linear' },
		hints: { name: 'generated-output', extent: { width: 128, height: 128, depth: 6 } },
	};
	const rootGroup = textureGroup( 'root-group', 'mapTexture', { kind: 'material.map', property: 'map' } );
	rootGroup.slots.push( { name: 'liveValue', offset: 16, source: { kind: 'uniform.live', name: 'liveValue' } } );
	rootGroup.storageBuffers = [ { name: 'particles', source: { kind: 'storage.buffer', attributeName: 'particles' } } ];
	const artifact = {
		cacheKey: 'root',
		vertexShader: 'root-vertex',
		fragmentShader: 'root-fragment',
		uniformPlan: [ rootGroup ],
		dynamicBindings: [ { marker: 'redundant-root-binding-payload' } ],
		variants: {
			variant: {
				cacheKey: 'variant',
				vertexShader: 'variant-vertex',
				fragmentShader: 'variant-fragment',
				uniformPlan: [ textureGroup( 'variant-group', 'environmentTexture', {
					kind: 'artifact.texture',
					textureUuid: 'env',
					renderTargetSelector,
				}, 'cube' ) ],
				dynamicBindings: [ { marker: 'redundant-variant-binding-payload' } ],
			},
			empty: {
				cacheKey: 'empty',
				uniformPlan: [],
			},
		},
	};
	const { source } = emitArtifactModule(
		{ hash: 'payload-hash', name: 'payload-diet' },
		{ artifact },
	);

	assert.doesNotMatch( source, /"dynamicBindings":/ );
	assert.doesNotMatch( source, /redundant-(?:root|variant)-binding-payload/ );
	assert.match( source, /artifact\.dynamicBindings = __tslp_collectDynamicBindings\(artifact\);/, 'derive the root compatibility view after the artifact literal' );
	assert.match( source, /artifact\.variants\["variant"\]\.dynamicBindings = __tslp_collectDynamicBindings\(artifact\.variants\["variant"\]\);/, 'derive each variant compatibility view' );
	assert.match( source, /export const dynamicBindings = artifact\.dynamicBindings;/, 'keep the virtual-module export shape' );
	assert.doesNotThrow( () => parse( source, { sourceType: 'module' } ) );
	assert.equal( source.match( /from "@tsl-precompile\/contract\/dynamic-bindings"/g )?.length, 1 );

	const executable = source.replace( '"@tsl-precompile/contract/dynamic-bindings"', JSON.stringify( import.meta.resolve( '@tsl-precompile/contract/dynamic-bindings' ) ) );
	const generated = await import( `data:text/javascript;base64,${ Buffer.from( executable ).toString( 'base64' ) }` );
	assert.equal( generated.dynamicBindings, generated.artifact.dynamicBindings );
	assert.equal( generated.default.dynamicBindings, generated.dynamicBindings );
	assert.equal( generated.default.artifact, generated.artifact );
	assert.deepEqual( generated.dynamicBindings, collectArtifactDynamicBindings( generated.artifact ) );
	assert.deepEqual(
		generated.artifact.variants.variant.dynamicBindings,
		collectArtifactDynamicBindings( generated.artifact.variants.variant ),
	);
	assert.deepEqual( generated.artifact.variants.empty.dynamicBindings, [], 'legacy captures without a stored view retain the historical derived array' );
	assert.equal( generated.dynamicBindings.length, 3, 'slot, texture, and storage descriptors are all restored' );
	assert.equal( generated.dynamicBindings[ 0 ].source, generated.artifact.uniformPlan[ 0 ].slots[ 0 ].source );
	assert.equal( generated.dynamicBindings[ 1 ].source, generated.artifact.uniformPlan[ 0 ].textures[ 0 ].source );
	assert.equal( generated.dynamicBindings[ 2 ].source, generated.artifact.uniformPlan[ 0 ].storageBuffers[ 0 ].source );
	assert.equal(
		generated.artifact.variants.variant.dynamicBindings[ 0 ].source,
		generated.artifact.variants.variant.uniformPlan[ 0 ].textures[ 0 ].source,
	);
	assert.deepEqual(
		generated.artifact.variants.variant.uniformPlan[ 0 ].textures[ 0 ].source.renderTargetSelector,
		renderTargetSelector,
		'codegen retains the exact selector on the authoritative uniform-plan source',
	);
	assert.equal( artifact.dynamicBindings[ 0 ].marker, 'redundant-root-binding-payload', 'emission does not mutate the persisted artifact' );
	assert.equal( artifact.variants.variant.dynamicBindings[ 0 ].marker, 'redundant-variant-binding-payload' );

} );

test( 'full-mode artifact emission is passive while retaining codegen diagnostics', () => {

	const artifact = {
		vertexShader: 'captured vertex',
		fragmentShader: 'captured fragment',
		attributes: [ {
			name: 'nodeAttribute0',
			type: 'vec4',
			arrayGenerator: { kind: 'range@1', seed: 7, min: [ 0, 0, 0, 0 ], max: [ 1, 1, 1, 1 ] },
		} ],
		renderContextSelectors: [ '{"version":"render-object-selector@1","topology":"passive"}' ],
		uniformPlan: [ {
			name: 'material',
			slots: [
				{ name: 'opacity', offset: 0, type: 'float', source: { kind: 'material.opacity', valueSnapshot: 1 } },
				{ name: 'future', offset: 4, type: 'float', source: { kind: 'future.passive.kind', valueSnapshot: 0 } },
			],
		} ],
		dynamicBindings: [ { kind: 'diagnostic-only' } ],
	};
	const { source, unsupportedKinds } = emitArtifactModule(
		{ hash: 'passive-hash', name: 'passive-full' },
		{ artifact },
		{ replay: false },
	);

	assert.ok( unsupportedKinds.some( ( entry ) => entry.kind === 'future.passive.kind' ) );
	assert.match( source, /export const artifact =/ );
	assert.match( source, /"diagnostic-only"/ );
	assert.doesNotMatch( source, /@tsl-precompile\/runtime\/writers|generated\/light-writer/ );
	assert.match( source, /materializeArtifactAttributeDescriptors|materializeArtifactVariantSelectorAdapters/ );
	assert.doesNotMatch( source, /__generatedUpdate/ );
	assert.match( source, /export const update = null;/ );
	assert.match( source, /export const updateGroup = null;/ );
	assert.doesNotThrow( () => parse( source, { sourceType: 'module' } ) );

} );

test( 'full-mode emission retains generated updateGroup for standalone compute artifacts', () => {

	const { source } = emitArtifactModule(
		{ hash: 'compute-hash', name: 'compute-module' },
		{ artifact: { kind: 'compute', computeShader: 'captured compute', uniformPlan: [] } },
		{ replay: false },
	);
	assert.match( source, /function __generatedUpdateGroup/ );
	assert.match( source, /export const updateGroup = __generatedUpdateGroup;/ );
	assert.doesNotMatch( source, /export const updateGroup = null;/ );

} );


test( 'only generated renderer-owned callsites retain an auxiliary registration hook', () => {

	for ( const slim of [ 'source', true, false ] ) for ( const shape of [ 'shadow-depth', 'render-pipeline', 'output-transform', 'mesh-basic', 'post-process' ] ) {

		const { source } = emitArtifactModule( { name: 'registry-routing', hash: 'x' }, {
			__sourceOwners: [ { path: 'scene.js' } ],
			artifact: { materialShape: shape, uniformPlan: [] },
		}, { slim } );
		parse( source, { sourceType: 'module' } );
		const auxiliary = !! slim && [ 'shadow-depth', 'render-pipeline', 'output-transform' ].includes( shape );
		assert.equal( source.includes( 'registerPrecompiledArtifacts as __registerAuxiliary' ), auxiliary );
		assert.equal( source.includes( 'dynamicBindings, __registerAuxiliary }' ), auxiliary );
		if ( auxiliary ) assert.ok( source.includes( `from "@tsl-precompile/runtime/slim${ slim === 'source' ? '/source' : '' }"` ) );

	}

} );

test( 'prepareAuxArtifactForEmission strips live-bound PMREM and cube-render-target texture snapshots without mutating the input', () => {

	const snapshot = { width: 4, height: 4, arrayType: 'Uint8Array', data: new Array( 64 ).fill( 255 ) };
	const pmremArtifact = {
		internalPass: {
			family: 'pmrem',
			pass: 'equirect',
			inputs: [ { kind: 'texture', group: 'object', binding: 'envMap' } ],
		},
		dynamicBindings: [ { marker: 'redundant' } ],
		uniformPlan: [ {
			name: 'object',
			slots: [],
			textures: [
				{ name: 'envMap', source: { kind: 'artifact.texture', snapshot } },
				{ name: 'lutMap', source: { kind: 'artifact.texture', snapshot } },
			],
		} ],
	};
	const preparedPmrem = prepareAuxArtifactForEmission( pmremArtifact, 'pmrem-equirect' );
	assert.equal( preparedPmrem.dynamicBindings, undefined );
	assert.equal( preparedPmrem.uniformPlan[ 0 ].textures[ 0 ].source.snapshot, undefined );
	assert.deepEqual( preparedPmrem.uniformPlan[ 0 ].textures[ 1 ].source.snapshot, snapshot );
	assert.deepEqual( pmremArtifact.uniformPlan[ 0 ].textures[ 0 ].source.snapshot, snapshot, 'persisted artifact stays intact' );

	const cubeArtifact = {
		uniformPlan: [ {
			name: 'object',
			slots: [],
			textures: [
				{ name: 'nodeUniform0', source: { kind: 'artifact.texture', snapshot } },
				{ name: 'userMap', source: { kind: 'material.map', snapshot } },
			],
		} ],
	};
	const preparedCube = prepareAuxArtifactForEmission( cubeArtifact, 'cube-render-target' );
	assert.equal( preparedCube.uniformPlan[ 0 ].textures[ 0 ].source.snapshot, undefined );
	assert.deepEqual( preparedCube.uniformPlan[ 0 ].textures[ 1 ].source.snapshot, snapshot );

} );
