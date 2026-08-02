import test from 'node:test';
import assert from 'node:assert/strict';

import { createBackendAwareVariantKey } from '@tsl-precompile/contract/shader-language';
import { hydrateNodeBuilderState } from '../src/hydrator.js';

const WGSL_VERTEX = '@vertex fn main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }';
const WGSL_FRAGMENT = '@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }';
const GLSL_VERTEX = '#version 300 es\nprecision highp float;\nvoid main() { gl_Position = vec4( 0.0 ); }';
const GLSL_FRAGMENT = '#version 300 es\nprecision highp float;\nout vec4 color;\nvoid main() { color = vec4( 1.0 ); }';

function artifact( shaderLanguage, selector ) {

	const glsl = shaderLanguage === 'glsl';
	return {
		cacheKey: 'shared-private-key',
		variantKey: createBackendAwareVariantKey( 'shared-private-key', shaderLanguage ),
		shaderLanguage,
		renderContextSelectors: [ selector ],
		vertexShader: glsl ? GLSL_VERTEX : WGSL_VERTEX,
		fragmentShader: glsl ? GLSL_FRAGMENT : WGSL_FRAGMENT,
		bindings: [],
		nodeAttributes: [],
		uniformPlan: [],
	};

}

test( 'hydration accepts GLSL on WebGL and rejects it on WebGPU', () => {

	const glsl = artifact( 'glsl', 'webgl-selector' );
	const webglRenderer = { backend: { isWebGLBackend: true } };
	const state = hydrateNodeBuilderState( glsl, null, null, { renderer: webglRenderer, renderContextSelector: 'webgl-selector' } );
	assert.equal( state.vertexShader, GLSL_VERTEX );

	assert.throws(
		() => hydrateNodeBuilderState( glsl, null, null, {
			renderer: { backend: { isWebGPUBackend: true } },
			renderContextSelector: 'webgl-selector',
		} ),
		( error ) => error && error.code === 'TSLP_SHADER_LANGUAGE_MISMATCH'
			&& error.details.capturedBackend === 'webgl'
			&& error.details.activeBackend === 'webgpu',
	);

} );

test( 'one family selects distinct WGSL and GLSL variants before backend validation', () => {

	const wgsl = artifact( 'wgsl', 'webgpu-selector' );
	const glsl = artifact( 'glsl', 'webgl-selector' );
	wgsl.variants = {
		[ wgsl.variantKey ]: { ...wgsl },
		[ glsl.variantKey ]: { ...glsl },
	};
	delete wgsl.variants[ wgsl.variantKey ].variants;
	delete wgsl.variants[ glsl.variantKey ].variants;

	const webglRenderer = { backend: { isWebGLBackend: true } };
	const state = hydrateNodeBuilderState( wgsl, null, null, {
		renderer: webglRenderer,
		renderContextSelector: 'webgl-selector',
	} );
	assert.equal( state.fragmentShader, GLSL_FRAGMENT );

	assert.throws(
		() => hydrateNodeBuilderState( wgsl, null, null, {
			renderer: webglRenderer,
			renderContextSelector: 'webgpu-selector',
		} ),
		( error ) => error && error.code === 'TSLP_SHADER_LANGUAGE_MISMATCH',
	);

} );

test( 'legacy placeholder artifacts remain compatible when language is not detectable', () => {

	assert.doesNotThrow( () => hydrateNodeBuilderState( {
		vertexShader: 'vertex_fixture',
		fragmentShader: 'fragment_fixture',
		bindings: [],
		nodeAttributes: [],
		uniformPlan: [],
	}, null, null, { renderer: { backend: { isWebGLBackend: true } } } ) );

} );
