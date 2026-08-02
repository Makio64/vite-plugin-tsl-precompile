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
