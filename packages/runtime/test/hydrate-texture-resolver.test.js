import test from 'node:test';
import assert from 'node:assert/strict';

import {
	inferTextureTypeFromShader,
	resolvePlanTextureTypeHint,
	selectFallbackTextureForBinding,
	shaderDeclaresArrayTexture,
	shaderDeclaresComparisonSampler,
	shaderDeclaresCubeTexture,
	shaderDeclaresDepthTexture,
	shaderDeclaresMultisampledTexture,
	textureBindingNameForSampler,
	textureMatchesShaderBinding,
} from '../src/hydrate/texture-resolver.js';

test( 'texture resolver derives paired sampler texture type hints', () => {

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
			'var depthArrayTex: texture_depth_2d_array;',
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
	assert.equal( inferTextureTypeFromShader( artifact, 'depthArrayTex' ), '2d-array' );

	assert.equal( textureMatchesShaderBinding( artifact, 'depthTex', { isTexture: true, isDepthTexture: true } ), true );
	assert.equal( textureMatchesShaderBinding( artifact, 'depthTex', { isTexture: true } ), false );
	assert.equal( textureMatchesShaderBinding( artifact, 'depthArrayTex', { isTexture: true, isDepthTexture: true, image: { depth: 1 } } ), false );
	assert.equal( textureMatchesShaderBinding( artifact, 'depthArrayTex', { isTexture: true, isDepthTexture: true, image: { depth: 4 } } ), true );
	assert.equal( textureMatchesShaderBinding( artifact, 'cubeTex', { isTexture: true, isCubeTexture: true } ), true );
	assert.equal( textureMatchesShaderBinding( artifact, 'cubeTex', { isTexture: true } ), false );
	assert.equal( textureMatchesShaderBinding( artifact, 'volumeTex', { isTexture: true, isData3DTexture: true } ), true );
	assert.equal( textureMatchesShaderBinding( artifact, 'msTex', { isTexture: true, renderTarget: { samples: 4 } } ), true );
	assert.equal( textureMatchesShaderBinding( artifact, 'msTex', { isTexture: true, renderTarget: { samples: 1 } } ), false );

} );

test( 'texture resolver infers combined GLSL sampler shapes', () => {

	const artifact = {
		fragmentShader: `#version 300 es
precision highp float;
uniform sampler2D plainTex;
uniform sampler2DArray arrayTex;
uniform highp samplerCube cubeTex;
uniform isampler3D volumeTex;
uniform sampler2DShadow shadowTex;
uniform samplerCubeShadow shadowCubeTex;
uniform sampler2DArrayShadow shadowArrayTex;
uniform sampler2DMS msTex;
layout( location = 0 ) out vec4 fragColor;
void main() { fragColor = texture( plainTex, vec2( 0.5 ) ); }
`,
	};
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

	assert.equal( inferTextureTypeFromShader( artifact, 'arrayTex' ), '2d-array' );
	assert.equal( inferTextureTypeFromShader( artifact, 'arrayTex_sampler' ), '2d-array' );
	assert.equal( inferTextureTypeFromShader( artifact, 'cubeTex' ), 'cube' );
	assert.equal( inferTextureTypeFromShader( artifact, 'volumeTex' ), '3d' );
	assert.equal( shaderDeclaresArrayTexture( artifact, 'arrayTex' ), true );
	assert.equal( shaderDeclaresCubeTexture( artifact, 'cubeTex' ), true );
	assert.equal( shaderDeclaresDepthTexture( artifact, 'shadowTex' ), true );
	assert.equal( shaderDeclaresComparisonSampler( artifact, 'shadowTex' ), true );
	assert.equal( shaderDeclaresMultisampledTexture( artifact, 'msTex' ), true );

	assert.equal( selectFallbackTextureForBinding( artifact, 'arrayTex', fallbacks ).id, 'array' );
	assert.equal( selectFallbackTextureForBinding( artifact, 'cubeTex', fallbacks ).id, 'cube' );
	assert.equal( selectFallbackTextureForBinding( artifact, 'volumeTex', fallbacks ).id, '3d' );
	assert.equal( selectFallbackTextureForBinding( artifact, 'shadowTex', fallbacks ).id, 'comparison-depth' );
	assert.equal( selectFallbackTextureForBinding( artifact, 'shadowCubeTex', fallbacks ).id, 'depth-cube' );
	assert.equal( selectFallbackTextureForBinding( artifact, 'shadowArrayTex', fallbacks ).id, 'depth-array' );
	assert.equal( textureMatchesShaderBinding( artifact, 'arrayTex', { isTexture: true, isDataArrayTexture: true } ), true );
	assert.equal( textureMatchesShaderBinding( artifact, 'arrayTex', { isTexture: true } ), false );

	const group = { textures: [] };
	assert.equal(
		resolvePlanTextureTypeHint( artifact, group, { textureType: '2d' }, {}, 'arrayTex' ),
		'2d-array',
		'GLSL declaration overrides stale captured 2d metadata',
	);

} );

test( 'binding descriptions invalidate when any shader stage changes or is removed', () => {

	const artifact = {};
	for ( const stage of [ 'vertexShader', 'fragmentShader', 'computeShader' ] ) {

		assert.equal( shaderDeclaresDepthTexture( artifact, 'tex' ), false );
		artifact[ stage ] = 'var tex: texture_depth_cube;';
		assert.equal( inferTextureTypeFromShader( artifact, 'tex' ), 'cube' );
		assert.equal( shaderDeclaresDepthTexture( artifact, 'tex' ), true );
		assert.equal( textureMatchesShaderBinding( artifact, 'tex', { isTexture: true } ), false );
		artifact[ stage ] = 'var tex: texture_3d<f32>;';
		assert.equal( inferTextureTypeFromShader( artifact, 'tex' ), '3d' );
		assert.equal( shaderDeclaresDepthTexture( artifact, 'tex' ), false );
		delete artifact[ stage ];
		assert.equal( inferTextureTypeFromShader( artifact, 'tex' ), null );

	}

} );

test( 'binding descriptions keep sampler comparison separate from paired texture shape', () => {

	const artifact = Object.freeze( {
		vertexShader: 'var tex: texture_depth_2d;',
		fragmentShader: 'var tex: texture_depth_2d; var tex_sampler: sampler_comparison; var tex_extra: texture_cube<f32>;',
	} );
	assert.equal( shaderDeclaresComparisonSampler( artifact, 'tex' ), false );
	assert.equal( shaderDeclaresComparisonSampler( artifact, 'tex_sampler' ), true );
	assert.equal( shaderDeclaresDepthTexture( artifact, 'tex_sampler' ), true );
	assert.equal( shaderDeclaresCubeTexture( artifact, 'tex' ), false );
	assert.equal( shaderDeclaresCubeTexture( artifact, 'tex_extra' ), true );
	assert.equal( shaderDeclaresDepthTexture( artifact, 'constructor' ), false );
	assert.equal( shaderDeclaresDepthTexture( artifact, 'toString' ), false );
	assert.equal( shaderDeclaresDepthTexture( { fragmentShader: 'var tex: texture_2d<f32>;' }, 'tex' ), false );
	assert.equal( shaderDeclaresDepthTexture( artifact, 'tex' ), true );

} );

test( 'binding descriptions combine stage declarations and preserve WGSL inference precedence over GLSL', () => {

	const artifact = {
		vertexShader: 'var tex: texture_depth_2d;',
		fragmentShader: 'var tex: texture_2d_array<f32>; uniform samplerCube tex;',
		computeShader: 'var literal.$[1]: texture_3d<f32>;',
	};
	assert.equal( shaderDeclaresDepthTexture( artifact, 'tex' ), true );
	assert.equal( shaderDeclaresArrayTexture( artifact, 'tex' ), true );
	assert.equal( shaderDeclaresCubeTexture( artifact, 'tex' ), true );
	assert.equal( inferTextureTypeFromShader( artifact, 'tex' ), '2d-array' );
	assert.equal( inferTextureTypeFromShader( artifact, 'literal.$[1]' ), '3d' );
	assert.equal( inferTextureTypeFromShader( artifact, 'literalX1' ), null );

} );

test( 'all binding probes share cached analysis and shader replacement re-runs it', () => {

	const artifact = { fragmentShader: 'var tex: texture_depth_2d_array;' };
	const OriginalRegExp = globalThis.RegExp;
	let constructions = 0;
	globalThis.RegExp = new Proxy( OriginalRegExp, {
		construct( target, args ) {

			constructions ++;
			return Reflect.construct( target, args );

		},
	} );
	try {

		assert.equal( shaderDeclaresDepthTexture( artifact, 'tex' ), true );
		const initial = constructions;
		assert.ok( initial > 0 );
		for ( let i = 0; i < 10; i ++ ) {

			shaderDeclaresArrayTexture( artifact, 'tex' );
			shaderDeclaresComparisonSampler( artifact, 'tex' );
			shaderDeclaresCubeTexture( artifact, 'tex' );
			shaderDeclaresMultisampledTexture( artifact, 'tex' );
			inferTextureTypeFromShader( artifact, 'tex' );
			textureMatchesShaderBinding( artifact, 'tex', { isTexture: true, isDepthTexture: true } );
			selectFallbackTextureForBinding( artifact, 'tex', {} );

		}
		assert.equal( constructions, initial );
		artifact.fragmentShader = 'var tex: texture_3d<f32>;';
		assert.equal( inferTextureTypeFromShader( artifact, 'tex' ), '3d' );
		assert.ok( constructions > initial );

	} finally {

		globalThis.RegExp = OriginalRegExp;

	}

} );
