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
				uniformPlan: [ textureGroup( 'variant-group', 'environmentTexture', { kind: 'artifact.texture', textureUuid: 'env' }, 'cube' ) ],
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
	assert.equal( artifact.dynamicBindings[ 0 ].marker, 'redundant-root-binding-payload', 'emission does not mutate the persisted artifact' );
	assert.equal( artifact.variants.variant.dynamicBindings[ 0 ].marker, 'redundant-variant-binding-payload' );

} );
