import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@babel/parser';
import { collectArtifactDynamicBindings } from '@tsl-precompile/contract/dynamic-bindings';

import { emitArtifactModule } from '../../src/emit-manifest.js';

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
	assert.match( source, /artifact\.dynamicBindings = \[/, 'derive the root compatibility view after the artifact literal' );
	assert.match( source, /artifact\.variants\["variant"\]\.dynamicBindings = \[/, 'derive each variant compatibility view' );
	assert.match( source, /export const dynamicBindings = artifact\.dynamicBindings;/, 'keep the virtual-module export shape' );
	assert.doesNotThrow( () => parse( source, { sourceType: 'module' } ) );
	assert.doesNotMatch( source, /^import /m, 'the execution fixture is self-contained' );

	const generated = await import( `data:text/javascript;base64,${ Buffer.from( source ).toString( 'base64' ) }` );
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
