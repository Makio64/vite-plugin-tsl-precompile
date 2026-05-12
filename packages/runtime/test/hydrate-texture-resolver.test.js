import test from 'node:test';
import assert from 'node:assert/strict';

import {
	findPlanTextureSource,
	inferTextureTypeFromShader,
	resolvePlanTextureTypeHint,
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
