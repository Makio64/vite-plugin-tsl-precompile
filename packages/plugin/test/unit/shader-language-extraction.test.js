import test from 'node:test';
import assert from 'node:assert/strict';

import { createBackendAwareVariantKey, SHADER_LANGUAGES } from '@tsl-precompile/contract/shader-language';
import { extractArtifact, extractComputeArtifact } from '../../src/vendor/compileTSL.js';

function state( shaders ) {

	return {
		bindings: [],
		nodeAttributes: [],
		updateNodes: [],
		updateBeforeNodes: [],
		updateAfterNodes: [],
		vertexShader: '',
		fragmentShader: '',
		computeShader: '',
		...shaders,
	};

}

test( 'render extraction namespaces one private cache key by native backend language', () => {

	const cacheKey = 'shared-private-key';
	const wgsl = extractArtifact( cacheKey, state( {
		vertexShader: '@vertex fn main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
		fragmentShader: '@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
	} ) );
	const glsl = extractArtifact( cacheKey, state( {
		vertexShader: '#version 300 es\nprecision highp float;\nvoid main() { gl_Position = vec4( 0.0 ); }',
		fragmentShader: '#version 300 es\nprecision highp float;\nout vec4 color;\nvoid main() { color = vec4( 1.0 ); }',
	} ) );

	assert.equal( wgsl.cacheKey, cacheKey );
	assert.equal( glsl.cacheKey, cacheKey );
	assert.equal( wgsl.shaderLanguage, SHADER_LANGUAGES.WGSL );
	assert.equal( glsl.shaderLanguage, SHADER_LANGUAGES.GLSL );
	assert.equal( wgsl.variantKey, createBackendAwareVariantKey( cacheKey, SHADER_LANGUAGES.WGSL ) );
	assert.equal( glsl.variantKey, createBackendAwareVariantKey( cacheKey, SHADER_LANGUAGES.GLSL ) );

} );

test( 'compute extraction records GLSL transform-feedback shader identity', () => {

	const artifact = extractComputeArtifact( 7, state( {
		computeShader: '#version 300 es\nprecision highp float;\nvoid main() {}',
	} ), { name: 'webgl-compute', count: 1 } );

	assert.equal( artifact.shaderLanguage, SHADER_LANGUAGES.GLSL );
	assert.equal( artifact.variantKey, createBackendAwareVariantKey( 7, SHADER_LANGUAGES.GLSL ) );

} );
