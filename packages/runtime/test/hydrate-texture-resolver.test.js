import test from 'node:test';
import assert from 'node:assert/strict';

import {
	findPlanTextureSource,
	inferTextureTypeFromShader,
	resolvePlanTextureTypeHint,
	selectFallbackTextureForBinding,
	shaderDeclaresComparisonSampler,
	shaderDeclaresDepthTexture,
	shaderDeclaresMultisampledTexture,
	textureBindingNameForSampler,
	textureMatchesShaderBinding,
} from '../src/hydrate/texture-resolver.js';

test( 'texture resolver finds plan sources and paired sampler texture type hints', () => {

	const artifact = {
		uniformPlan: [
			{
				name: 'group',
				textures: [
					{ name: 'nodeTexture0', textureType: '2d-array', source: { kind: 'artifact.texture', textureUuid: 'tex' } },
					{ name: 'nodeTexture0_sampler', source: { kind: 'artifact.sampler' } },
				],
			},
		],
		fragmentShader: 'var nodeTexture0: texture_2d_array<f32>;\nvar nodeTexture0_sampler: sampler;',
	};

	assert.equal( textureBindingNameForSampler( 'nodeTexture0_sampler' ), 'nodeTexture0' );
	assert.deepEqual( findPlanTextureSource( artifact, 'group', 'nodeTexture0' ), { kind: 'artifact.texture', textureUuid: 'tex' } );
	assert.equal( resolvePlanTextureTypeHint( artifact, artifact.uniformPlan[ 0 ], artifact.uniformPlan[ 0 ].textures[ 1 ], artifact.uniformPlan[ 0 ].textures[ 1 ].source, 'nodeTexture0_sampler' ), '2d-array' );

} );

test( 'texture resolver selects shader-compatible fallback textures', () => {

	const fallbacks = {
		texture: { id: 'plain' },
		comparisonDepth: { id: 'comparison-depth' },
		depth: { id: 'depth' },
		depthCube: { id: 'depth-cube' },
		depthArray: { id: 'depth-array' },
		multisampledDepth: { id: 'multisampled-depth' },
		cube: { id: 'cube' },
		texture3D: { id: '3d' },
		array: { id: 'array' },
	};
	const artifact = {
		fragmentShader: [
			'var plainTex: texture_2d<f32>;',
			'var depthTex: texture_depth_2d;',
			'var depthCubeTex: texture_depth_cube;',
			'var depthArrayTex: texture_depth_2d_array;',
			'var msDepthTex: texture_depth_multisampled_2d;',
			'var cubeTex: texture_cube<f32>;',
			'var volumeTex: texture_3d<f32>;',
			'var arrayTex: texture_2d_array<f32>;',
			'var depthTex_sampler: sampler;',
			'var compareSampler: sampler_comparison;',
		].join( '\n' ),
	};

	assert.equal( selectFallbackTextureForBinding( artifact, 'plainTex', fallbacks ).id, 'plain' );
	assert.equal( selectFallbackTextureForBinding( artifact, 'depthTex', fallbacks ).id, 'depth' );
	assert.equal( selectFallbackTextureForBinding( artifact, 'depthCubeTex', fallbacks ).id, 'depth-cube' );
	assert.equal( selectFallbackTextureForBinding( artifact, 'depthArrayTex', fallbacks ).id, 'depth-array' );
	assert.equal( selectFallbackTextureForBinding( artifact, 'msDepthTex', fallbacks ).id, 'multisampled-depth' );
	assert.equal( selectFallbackTextureForBinding( artifact, 'cubeTex', fallbacks ).id, 'cube' );
	assert.equal( selectFallbackTextureForBinding( artifact, 'volumeTex', fallbacks ).id, '3d' );
	assert.equal( selectFallbackTextureForBinding( artifact, 'arrayTex', fallbacks ).id, 'array' );
	assert.equal( selectFallbackTextureForBinding( artifact, 'depthTex_sampler', fallbacks ).id, 'depth' );
	assert.equal( selectFallbackTextureForBinding( artifact, 'compareSampler', fallbacks ).id, 'comparison-depth' );

} );

test( 'texture resolver infers shader binding shape and validates live textures', () => {

	const artifact = {
		fragmentShader: [
			'var depthTex: texture_depth_2d;',
			'var depthSampler: sampler_comparison;',
			'var cubeTex: texture_cube<f32>;',
			'var volumeTex: texture_3d<f32>;',
			'var msTex: texture_multisampled_2d<f32>;',
		].join( '\n' ),
	};

	assert.equal( shaderDeclaresDepthTexture( artifact, 'depthTex' ), true );
	assert.equal( shaderDeclaresComparisonSampler( artifact, 'depthSampler' ), true );
	assert.equal( shaderDeclaresMultisampledTexture( artifact, 'msTex' ), true );
	assert.equal( inferTextureTypeFromShader( artifact, 'cubeTex' ), 'cube' );
	assert.equal( inferTextureTypeFromShader( artifact, 'volumeTex' ), '3d' );

	assert.equal( textureMatchesShaderBinding( artifact, 'depthTex', { isTexture: true, isDepthTexture: true } ), true );
	assert.equal( textureMatchesShaderBinding( artifact, 'depthTex', { isTexture: true } ), false );
	assert.equal( textureMatchesShaderBinding( artifact, 'cubeTex', { isTexture: true, isCubeTexture: true } ), true );
	assert.equal( textureMatchesShaderBinding( artifact, 'cubeTex', { isTexture: true } ), false );
	assert.equal( textureMatchesShaderBinding( artifact, 'volumeTex', { isTexture: true, isData3DTexture: true } ), true );
	assert.equal( textureMatchesShaderBinding( artifact, 'msTex', { isTexture: true, renderTarget: { samples: 4 } } ), true );
	assert.equal( textureMatchesShaderBinding( artifact, 'msTex', { isTexture: true, renderTarget: { samples: 1 } } ), false );

} );
