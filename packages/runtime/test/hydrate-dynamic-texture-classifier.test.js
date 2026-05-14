import test from 'node:test';
import assert from 'node:assert/strict';

import { collectArtifactDynamicBindings } from '@tsl-precompile/contract/dynamic-bindings';

import { classifyDynamicTextureBinding, indexDynamicTextureBindings } from '../src/hydrate/kinds/dynamic-texture-classifier.js';

function freshContext( overrides = {} ) {

	return {
		artifact: { name: 'test-artifact' },
		material: { name: 'test-material' },
		shadowDepthBindings: [],
		materialDepthBindings: [],
		artifactTextureBindings: [],
		materialTextureBindings: [],
		viewportTextureBindings: [],
		reflectorTextureBindings: [],
		recordShadowBindingDiagnostic: () => {},
		findReflectorBaseNodeInMaterial: () => null,
		shaderDeclaresDepthTexture: () => false,
		shouldSkipViewportCopyForZeroThicknessTransmission: () => false,
		...overrides,
	};

}

test( 'indexDynamicTextureBindings only includes texture/sampler entries', () => {

	const artifact = {
		dynamicBindings: [
			{ kind: 'frame.time', target: 'uniform-slot', group: 'render', binding: 'time' },
			{ kind: 'depth.texture', target: 'sampled-texture', group: 'lights', binding: 'shadowMap' },
			{ kind: 'artifact.texture', target: 'sampled-texture', group: 'matgroup', binding: 'envMap' },
			{ kind: 'material.map', target: 'sampler', group: 'matgroup', binding: 'mapSampler' },
		],
	};
	const index = indexDynamicTextureBindings( artifact );
	assert.equal( index.size, 3 );
	assert.equal( index.get( 'lights::shadowMap' ).kind, 'depth.texture' );
	assert.equal( index.get( 'matgroup::envMap' ).kind, 'artifact.texture' );
	assert.equal( index.get( 'matgroup::mapSampler' ).kind, 'material.map' );

} );

test( 'classifier dispatches depth.texture into shadowDepthBindings or materialDepthBindings by fromMaterialGraph', () => {

	const ctx = freshContext();
	const lightEntry = {
		kind: 'depth.texture', target: 'sampled-texture', group: 'lights', binding: 'shadowMap',
		source: { kind: 'depth.texture', lightIndex: 2, lightUuid: 'L', vsm: true },
	};
	const matEntry = {
		kind: 'depth.texture', target: 'sampled-texture', group: 'matgroup', binding: 'depthTex',
		source: { kind: 'depth.texture', lightIndex: -1, fromMaterialGraph: true, textureUuid: 'T' },
	};
	const runtimeBinding = { isSampledTexture: true };
	const descriptor = { kind: 'sampled-texture', name: 'shadowMap' };

	classifyDynamicTextureBinding( lightEntry, runtimeBinding, descriptor, ctx );
	classifyDynamicTextureBinding( matEntry, runtimeBinding, { kind: 'sampled-texture', name: 'depthTex' }, ctx );

	assert.equal( ctx.shadowDepthBindings.length, 1 );
	assert.equal( ctx.materialDepthBindings.length, 1 );
	assert.equal( ctx.shadowDepthBindings[ 0 ].lightIndex, 2 );
	assert.equal( ctx.shadowDepthBindings[ 0 ].vsm, true );
	assert.equal( ctx.materialDepthBindings[ 0 ].textureUuid, 'T' );
	assert.equal( ctx.materialDepthBindings[ 0 ].fromMaterialGraph, true );

} );

test( 'classifier dispatches artifact.texture, picking textureType from the plan group', () => {

	const ctx = freshContext( {
		artifact: {
			name: 'a',
			uniformPlan: [ { name: 'g', textures: [ { name: 'envMap', textureType: 'cube' } ] } ],
		},
	} );
	const entry = {
		kind: 'artifact.texture', target: 'sampled-texture', group: 'g', binding: 'envMap',
		source: { kind: 'artifact.texture', textureUuid: 'u' },
	};
	classifyDynamicTextureBinding( entry, { isSampledTexture: true }, { kind: 'sampled-texture', name: 'envMap' }, ctx );
	assert.equal( ctx.artifactTextureBindings.length, 1 );
	assert.equal( ctx.artifactTextureBindings[ 0 ].textureType, 'cube' );
	assert.equal( ctx.artifactTextureBindings[ 0 ].source.textureUuid, 'u' );

} );

test( 'classifier dispatches material.* prefixed kinds into materialTextureBindings', () => {

	const ctx = freshContext();
	const entry = {
		kind: 'material.map', target: 'sampled-texture', group: 'g', binding: 'mapTex',
		source: { kind: 'material.map', property: 'map' },
	};
	classifyDynamicTextureBinding( entry, { isSampledTexture: true }, { kind: 'sampled-texture', name: 'mapTex' }, ctx );
	assert.equal( ctx.materialTextureBindings.length, 1 );
	assert.equal( ctx.materialTextureBindings[ 0 ].source.property, 'map' );

} );

test( 'classifier dispatches reflector.texture only when a base node is found', () => {

	const baseNode = { isReflectorBaseNode: true };
	const ctxWith = freshContext( { findReflectorBaseNodeInMaterial: () => baseNode } );
	const ctxWithout = freshContext( { findReflectorBaseNodeInMaterial: () => null } );
	const entry = {
		kind: 'reflector.texture', target: 'sampled-texture', group: 'g', binding: 'rt',
		source: { kind: 'reflector.texture', reflectorIndex: 0 },
	};
	const runtimeBinding = { isSampledTexture: true };
	const descriptor = { kind: 'sampled-texture', name: 'rt' };
	classifyDynamicTextureBinding( entry, runtimeBinding, descriptor, ctxWith );
	classifyDynamicTextureBinding( entry, runtimeBinding, descriptor, ctxWithout );
	assert.equal( ctxWith.reflectorTextureBindings.length, 1 );
	assert.equal( ctxWith.reflectorTextureBindings[ 0 ].baseNode, baseNode );
	assert.equal( ctxWithout.reflectorTextureBindings.length, 0 );

} );

test( 'classifier dispatches viewport.texture and forwards isDepth from shader probe when needed', () => {

	const ctx = freshContext( { shaderDeclaresDepthTexture: () => true } );
	const entry = {
		kind: 'viewport.texture', target: 'sampled-texture', group: 'g', binding: 'vp',
		source: { kind: 'viewport.texture', generateMipmaps: false },
	};
	const runtimeBinding = { isSampledTexture: true, texture: { id: 'fb' } };
	classifyDynamicTextureBinding( entry, runtimeBinding, { kind: 'sampled-texture', name: 'vp' }, ctx );
	assert.equal( ctx.viewportTextureBindings.length, 1 );
	assert.equal( ctx.viewportTextureBindings[ 0 ].generateMipmaps, false );
	assert.equal( ctx.viewportTextureBindings[ 0 ].isDepth, true );
	assert.equal( ctx.viewportTextureBindings[ 0 ].fallbackTexture.id, 'fb' );

} );

test( 'classifier ignores entries whose runtime binding is not a sampled texture/sampler (except depth which is unconditional)', () => {

	const ctx = freshContext();
	const entry = {
		kind: 'artifact.texture', target: 'sampled-texture', group: 'g', binding: 'envMap',
		source: { kind: 'artifact.texture' },
	};
	classifyDynamicTextureBinding( entry, { isUniformBuffer: true }, { kind: 'uniform-buffer', name: 'envMap' }, ctx );
	assert.equal( ctx.artifactTextureBindings.length, 0 );

} );

test( 'classifier integrates with collectArtifactDynamicBindings end-to-end', () => {

	const artifact = {
		uniformPlan: [
			{
				name: 'lights',
				textures: [ { name: 'shadowMap', textureType: 'depth', source: { kind: 'depth.texture', lightIndex: 0 } } ],
			},
			{
				name: 'matgroup',
				textures: [
					{ name: 'envMap', textureType: '2d', source: { kind: 'artifact.texture', textureUuid: 'u' } },
					{ name: 'mapTex', textureType: '2d', source: { kind: 'material.map', property: 'map' } },
				],
			},
		],
	};
	artifact.dynamicBindings = collectArtifactDynamicBindings( artifact );
	const index = indexDynamicTextureBindings( artifact );
	const ctx = freshContext( { artifact } );

	for ( const [ key, entry ] of index ) {

		const [ groupName, bindingName ] = key.split( '::' );
		void groupName;
		classifyDynamicTextureBinding( entry, { isSampledTexture: true }, { kind: 'sampled-texture', name: bindingName }, ctx );

	}

	assert.equal( ctx.shadowDepthBindings.length, 1 );
	assert.equal( ctx.artifactTextureBindings.length, 1 );
	assert.equal( ctx.materialTextureBindings.length, 1 );

} );
