import test from 'node:test';
import assert from 'node:assert/strict';

import {
	SHADER_LANGUAGES,
	createBackendAwareVariantKey,
	detectArtifactShaderLanguage,
	detectShaderLanguage,
	resolveArtifactVariantKey,
	shaderLanguageBackend,
} from '../src/shader-language.js';

test( 'shader language detection recognizes native Three stage sources', () => {

	const wgsl = '@vertex fn main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }';
	const glsl = '#version 300 es\nprecision highp float;\nvoid main() { gl_Position = vec4( 0.0 ); }';

	assert.equal( detectShaderLanguage( wgsl ), SHADER_LANGUAGES.WGSL );
	assert.equal( detectShaderLanguage( glsl ), SHADER_LANGUAGES.GLSL );
	assert.equal( detectShaderLanguage( 'uniform-like application text' ), null );
	assert.equal( detectArtifactShaderLanguage( { vertexShader: wgsl, fragmentShader: wgsl } ), SHADER_LANGUAGES.WGSL );
	assert.equal( detectArtifactShaderLanguage( { vertexShader: wgsl, fragmentShader: glsl } ), null );

} );

test( 'backend-aware variant keys preserve the raw cache key as legacy metadata', () => {

	assert.equal( shaderLanguageBackend( SHADER_LANGUAGES.WGSL ), 'webgpu' );
	assert.equal( shaderLanguageBackend( SHADER_LANGUAGES.GLSL ), 'webgl' );
	assert.equal( createBackendAwareVariantKey( 'private:key', SHADER_LANGUAGES.WGSL ), 'webgpu:private:key' );
	assert.equal( createBackendAwareVariantKey( 'private:key', SHADER_LANGUAGES.GLSL ), 'webgl:private:key' );
	assert.equal( resolveArtifactVariantKey( { cacheKey: 'legacy' } ), 'legacy' );
	assert.equal( resolveArtifactVariantKey( { cacheKey: 'legacy', variantKey: 'webgl:legacy' } ), 'webgl:legacy' );
	assert.throws( () => createBackendAwareVariantKey( 'private', 'spirv' ), /shaderLanguage/ );

} );


test( 'MRT variant identity includes fragment component widths and ignores input varyings', () => {

	const layout = { mrtOutputCount: 2, mrtOutputNames: [ 'output', 'metalrough' ] };
	const wgsl = ( outputType, inputType = 'vec2<f32>' ) => `
struct Input { @location(0) uv: ${ inputType }, };
struct Result { @location(0) output: vec4<f32>, @location(1) metalrough: ${ outputType }, };
@fragment fn main(input: Input) -> Result { return Result(); }`;
	const key = source => createBackendAwareVariantKey( 42, 'wgsl', { ...layout, fragmentShader: source } );
	assert.notEqual( key( wgsl( 'vec2<f32>' ) ), key( wgsl( 'vec4<f32>' ) ) );
	assert.equal( key( wgsl( 'vec2<f32>' ) ), key( wgsl( 'vec2<f32>', 'vec4<f32>' ) ) );
	const glsl = type => `#version 300 es\nlayout(location=0) out highp vec4 color;\nlayout(location=1) out ${ type } metalrough;`;
	assert.notEqual(
		createBackendAwareVariantKey( 42, 'glsl', { ...layout, fragmentShader: glsl( 'vec2' ) } ),
		createBackendAwareVariantKey( 42, 'glsl', { ...layout, fragmentShader: glsl( 'vec4' ) } ),
	);

} );
