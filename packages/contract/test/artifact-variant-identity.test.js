import test from 'node:test';
import assert from 'node:assert/strict';

import {
	collectArtifactVariantCandidates,
	createArtifactVariantPayload,
	mergeArtifactVariantFamily,
} from '../src/artifact-variants.js';
import { validateArtifact } from '../src/kinds.js';
import {
	SHADER_LANGUAGES,
	createBackendAwareVariantKey,
} from '../src/shader-language.js';
import { stableJsonStringify } from '../src/stable-json.js';

const PRIVATE_CACHE_KEY = 'shared-three-cache-key';

function selector( backend ) {

	return stableJsonStringify( {
		version: 'render-object-selector@1',
		renderer: { backend: { kind: backend } },
	} );

}

function artifact( shaderLanguage ) {

	const backend = shaderLanguage === SHADER_LANGUAGES.WGSL ? 'webgpu' : 'webgl';
	const wgsl = shaderLanguage === SHADER_LANGUAGES.WGSL;
	return {
		cacheKey: PRIVATE_CACHE_KEY,
		variantKey: createBackendAwareVariantKey( PRIVATE_CACHE_KEY, shaderLanguage ),
		shaderLanguage,
		materialShape: 'node-material',
		renderContextSelectors: [ selector( backend ) ],
		vertexShader: wgsl
			? '@vertex fn main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }'
			: '#version 300 es\nprecision highp float;\nvoid main() { gl_Position = vec4( 0.0 ); }',
		fragmentShader: wgsl
			? '@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }'
			: '#version 300 es\nprecision highp float;\nout vec4 color;\nvoid main() { color = vec4( 1.0 ); }',
		bindings: [],
		uniformPlan: [],
	};

}

test( 'artifact families retain divergent WebGPU and WebGL payloads sharing one private cache key', () => {

	const webgpu = artifact( SHADER_LANGUAGES.WGSL );
	const webgl = artifact( SHADER_LANGUAGES.GLSL );

	mergeArtifactVariantFamily( webgpu, [ webgpu, webgl ] );

	assert.deepEqual( Object.keys( webgpu.variants ), [
		createBackendAwareVariantKey( PRIVATE_CACHE_KEY, SHADER_LANGUAGES.GLSL ),
		createBackendAwareVariantKey( PRIVATE_CACHE_KEY, SHADER_LANGUAGES.WGSL ),
	] );
	const candidates = collectArtifactVariantCandidates( webgpu );
	assert.equal( candidates.length, 2 );
	assert.deepEqual( candidates.map( ( candidate ) => candidate.cacheKey ), [ PRIVATE_CACHE_KEY, PRIVATE_CACHE_KEY ] );
	assert.deepEqual( candidates.map( ( candidate ) => candidate.shaderLanguage ).sort(), [ 'glsl', 'wgsl' ] );

	const validation = validateArtifact( webgpu, { label: 'dual-backend material', requireShaders: true } );
	assert.equal( validation.ok, true, validation.errors.map( ( error ) => error.message ).join( '\n' ) );

} );

test( 'legacy families continue to use raw cache keys', () => {

	const root = {
		cacheKey: 'legacy-root',
		vertexShader: 'legacy vertex',
		fragmentShader: 'legacy fragment',
		bindings: [],
		uniformPlan: [],
	};
	const sibling = {
		...root,
		cacheKey: 'legacy-sibling',
		fragmentShader: 'legacy sibling fragment',
	};

	mergeArtifactVariantFamily( root, [ root, sibling ] );

	assert.deepEqual( Object.keys( root.variants ), [ 'legacy-root', 'legacy-sibling' ] );
	assert.equal( validateArtifact( root ).ok, true );

} );

test( 'legacy and annotated copies of one shader remain one semantic member', () => {

	const current = artifact( SHADER_LANGUAGES.WGSL );
	const legacy = structuredClone( current );
	delete legacy.variantKey;
	delete legacy.shaderLanguage;

	mergeArtifactVariantFamily( legacy, [ legacy, current ] );

	assert.equal( legacy.variants, undefined );
	assert.equal( legacy.cacheKey, PRIVATE_CACHE_KEY );
	assert.equal( validateArtifact( legacy, { requireShaders: true } ).ok, true );

} );

test( 'renderer-output recaptures ignore live target identity and extent while retaining topology', () => {

	const first = artifact( SHADER_LANGUAGES.WGSL );
	first.materialShape = 'render-output';
	first.uniformPlan = [ {
		name: 'object',
		textures: [ rendererTargetSource( 'first-texture', 1280, 720, 1023 ) ],
		orderedBindings: [ {
			type: 'sampled-texture',
			ref: rendererTargetSource( 'first-texture', 1280, 720, 1023 ),
		} ],
	} ];
	const resized = structuredClone( first );
	resized.uniformPlan[ 0 ].textures[ 0 ] = rendererTargetSource( 'second-texture', 2952, 1612, 1023 );
	resized.uniformPlan[ 0 ].orderedBindings[ 0 ].ref = rendererTargetSource( 'second-texture', 2952, 1612, 1023 );

	mergeArtifactVariantFamily( first, [ first, resized ] );

	assert.equal( first.variants, undefined );
	assert.equal( first.uniformPlan[ 0 ].textures[ 0 ].source.textureUuid, 'first-texture' );
	assert.equal( first.uniformPlan[ 0 ].textures[ 0 ].source.imageWidth, 1280 );

	const incompatible = structuredClone( resized );
	incompatible.uniformPlan[ 0 ].textures[ 0 ] = rendererTargetSource( 'third-texture', 640, 480, 1024 );
	incompatible.uniformPlan[ 0 ].orderedBindings[ 0 ].ref = rendererTargetSource( 'third-texture', 640, 480, 1024 );
	assert.throws(
		() => mergeArtifactVariantFamily( first, incompatible ),
		( error ) => error && error.code === 'TSLP_ARTIFACT_VARIANT_KEY_COLLISION',
	);

} );

function rendererTargetSource( textureUuid, width, height, format ) {

	return {
		source: {
			kind: 'artifact.texture',
			textureUuid,
			imageWidth: width,
			imageHeight: height,
			imageDepth: 1,
			renderTargetSelector: {
				schema: 'renderer-render-target-texture@1',
				attachment: { role: 'color', index: 0 },
				target: { topology: 'single', dimension: '2d', mrtCount: 1 },
				texture: { dimension: '2d', format, type: 1016, colorSpace: 'srgb-linear' },
				hints: { name: null, extent: { width, height, depth: 1 } },
			},
		},
	};

}

test( 'family validation uses variantKey when it is present', () => {

	const value = artifact( SHADER_LANGUAGES.GLSL );
	value.variants = {
		[ value.cacheKey ]: createArtifactVariantPayload( value ),
	};

	const validation = validateArtifact( value, { label: 'mis-keyed WebGL family' } );
	assert.equal( validation.ok, false );
	assert.ok( validation.errors.some( ( error ) => error.code === 'artifact.variant.variantKey' ) );

} );

test( 'declared shader language and canonical variant identity are validated', () => {

	const value = artifact( SHADER_LANGUAGES.GLSL );
	value.shaderLanguage = SHADER_LANGUAGES.WGSL;
	value.variantKey = createBackendAwareVariantKey( value.cacheKey, SHADER_LANGUAGES.GLSL );

	const validation = validateArtifact( value, { label: 'mislabeled WebGL artifact' } );
	assert.equal( validation.ok, false );
	assert.ok( validation.errors.some( ( error ) => error.code === 'artifact.shaderLanguage.mismatch' ) );
	assert.ok( validation.errors.some( ( error ) => error.code === 'artifact.variantKey.canonical' ) );

} );

test( 'an explicit variant-key collision fails without regressing legacy cache-key diagnostics', () => {

	const first = artifact( SHADER_LANGUAGES.WGSL );
	const second = artifact( SHADER_LANGUAGES.GLSL );
	second.variantKey = first.variantKey;

	assert.throws(
		() => mergeArtifactVariantFamily( first, [ first, second ] ),
		( error ) => error && error.code === 'TSLP_ARTIFACT_VARIANT_KEY_COLLISION',
	);

	const legacyA = { cacheKey: 'legacy', vertexShader: 'a', fragmentShader: 'a', uniformPlan: [] };
	const legacyB = { cacheKey: 'legacy', vertexShader: 'b', fragmentShader: 'b', uniformPlan: [] };
	assert.throws(
		() => mergeArtifactVariantFamily( legacyA, [ legacyA, legacyB ] ),
		( error ) => error && error.code === 'TSLP_ARTIFACT_VARIANT_CACHE_KEY_COLLISION',
	);

} );
