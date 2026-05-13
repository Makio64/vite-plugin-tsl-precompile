import test from 'node:test';
import assert from 'node:assert/strict';

import {
	_resetTextureMissWarnings,
	dispatchTextureBinding,
} from '../src/hydrate/artifact-texture-resolver.js';

function makeFallbacks() {

	return {
		texture: { isTexture: true, name: 'fallback-2d' },
		comparisonDepth: { isTexture: true, isDepthTexture: true, name: 'fallback-cmp-depth' },
		depth: { isTexture: true, isDepthTexture: true, name: 'fallback-depth' },
		depthCube: { isTexture: true, isCubeTexture: true, isDepthTexture: true, name: 'fallback-depth-cube' },
		depthArray: { isTexture: true, isDepthTexture: true, isArrayTexture: true, name: 'fallback-depth-array' },
		multisampledDepth: { isTexture: true, isDepthTexture: true, name: 'fallback-ms-depth' },
		cube: { isTexture: true, isCubeTexture: true, name: 'fallback-cube' },
		texture3D: { isTexture: true, isData3DTexture: true, name: 'fallback-3d' },
		array: { isTexture: true, isDataArrayTexture: true, name: 'fallback-array' },
	};

}

function makeArtifact( source, name = 'fixture' ) {

	return {
		name,
		fragmentShader: 'var nodeTexture0: texture_2d<f32>;',
		uniformPlan: [
			{
				name: 'render',
				textures: [
					{ name: 'nodeTexture0', textureType: '2d', source },
				],
			},
		],
	};

}

test( 'dispatchTextureBinding returns the shape-appropriate fallback for depth.texture', () => {

	const artifact = makeArtifact( { kind: 'depth.texture', lightIndex: 0 } );
	const fallbacks = makeFallbacks();
	const result = dispatchTextureBinding( {
		artifact,
		groupName: 'render',
		bindingName: 'nodeTexture0',
		material: null,
		deps: { fallbacks, makeViewportFallback: () => null },
	} );
	// The 2D-default fallback matches because the shader declares `texture_2d`.
	assert.equal( result, fallbacks.texture );

} );

test( 'dispatchTextureBinding hands viewport.texture to makeViewportFallback', () => {

	const artifact = makeArtifact( { kind: 'viewport.texture' } );
	const stub = { isTexture: true, isFramebufferTexture: true };
	const fallbacks = makeFallbacks();
	const result = dispatchTextureBinding( {
		artifact,
		groupName: 'render',
		bindingName: 'nodeTexture0',
		material: null,
		deps: { fallbacks, makeViewportFallback: () => stub },
	} );
	assert.equal( result, stub );

} );

test( 'dispatchTextureBinding returns the live texture for a material.* source', () => {

	const artifact = makeArtifact( { kind: 'material.map' } );
	const tex = { isTexture: true, name: 'diffuse' };
	const material = { map: tex };
	const fallbacks = makeFallbacks();
	const result = dispatchTextureBinding( {
		artifact,
		groupName: 'render',
		bindingName: 'nodeTexture0',
		material,
		deps: { fallbacks, makeViewportFallback: () => null },
	} );
	assert.equal( result, tex );

} );

test( 'dispatchTextureBinding warn-on-miss fires when TSLP_WARN_TEXTURE_MISS is on and artifact.texture has no live match', () => {

	const artifact = makeArtifact( { kind: 'artifact.texture', textureUuid: 'unknown-uuid' }, 'warn-test' );
	const fallbacks = makeFallbacks();
	const originalWarn = console.warn;
	const warned = [];
	console.warn = ( msg ) => warned.push( msg );
	const originalFlag = globalThis.__TSLP_WARN_TEXTURE_MISS;
	globalThis.__TSLP_WARN_TEXTURE_MISS = true;
	_resetTextureMissWarnings();
	try {

		const result = dispatchTextureBinding( {
			artifact,
			groupName: 'render',
			bindingName: 'nodeTexture0',
			material: null,
			deps: { fallbacks, makeViewportFallback: () => null },
		} );
		assert.equal( result, fallbacks.texture, 'falls back to shape texture' );
		assert.equal( warned.length, 1, 'warn fires exactly once' );
		assert.match( warned[ 0 ], /nodeTexture0/ );
		assert.match( warned[ 0 ], /warn-test/ );
		assert.match( warned[ 0 ], /artifact\.texture/ );
		assert.match( warned[ 0 ], /unknown-uuid/ );

		// Second call with the same binding key does not re-warn (dedup).
		dispatchTextureBinding( {
			artifact,
			groupName: 'render',
			bindingName: 'nodeTexture0',
			material: null,
			deps: { fallbacks, makeViewportFallback: () => null },
		} );
		assert.equal( warned.length, 1, 'second call de-duplicates' );

	} finally {

		console.warn = originalWarn;
		globalThis.__TSLP_WARN_TEXTURE_MISS = originalFlag;
		_resetTextureMissWarnings();

	}

} );

test( 'dispatchTextureBinding stays silent when TSLP_WARN_TEXTURE_MISS is off', () => {

	const artifact = makeArtifact( { kind: 'artifact.texture', textureUuid: 'unknown-uuid' }, 'silent-test' );
	const fallbacks = makeFallbacks();
	const originalWarn = console.warn;
	const warned = [];
	console.warn = ( msg ) => warned.push( msg );
	const originalFlag = globalThis.__TSLP_WARN_TEXTURE_MISS;
	delete globalThis.__TSLP_WARN_TEXTURE_MISS;
	_resetTextureMissWarnings();
	try {

		dispatchTextureBinding( {
			artifact,
			groupName: 'render',
			bindingName: 'nodeTexture0',
			material: null,
			deps: { fallbacks, makeViewportFallback: () => null },
		} );
		assert.equal( warned.length, 0 );

	} finally {

		console.warn = originalWarn;
		if ( originalFlag !== undefined ) globalThis.__TSLP_WARN_TEXTURE_MISS = originalFlag;
		_resetTextureMissWarnings();

	}

} );

test( 'dispatchTextureBinding warns for unknown source.kind that asks for a texture', () => {

	const artifact = makeArtifact( { kind: 'mystery.kind' }, 'unknown-kind-test' );
	const fallbacks = makeFallbacks();
	const originalWarn = console.warn;
	const warned = [];
	console.warn = ( msg ) => warned.push( msg );
	const originalFlag = globalThis.__TSLP_WARN_TEXTURE_MISS;
	globalThis.__TSLP_WARN_TEXTURE_MISS = true;
	_resetTextureMissWarnings();
	try {

		dispatchTextureBinding( {
			artifact,
			groupName: 'render',
			bindingName: 'nodeTexture0',
			material: null,
			deps: { fallbacks, makeViewportFallback: () => null },
		} );
		assert.equal( warned.length, 1 );
		assert.match( warned[ 0 ], /mystery\.kind/ );

	} finally {

		console.warn = originalWarn;
		globalThis.__TSLP_WARN_TEXTURE_MISS = originalFlag;
		_resetTextureMissWarnings();

	}

} );

test( 'dispatchTextureBinding records the strategy onto _textureResolutionStrategies', () => {

	const tex = { isTexture: true, uuid: 'tex-a' };
	const artifact = {
		name: 'strategy-test',
		fragmentShader: 'var nodeTexture0: texture_2d<f32>;',
		uniformPlan: [ {
			name: 'render',
			textures: [ { name: 'nodeTexture0', textureType: '2d', source: { kind: 'artifact.texture', textureUuid: 'tex-a' } } ],
		} ],
		_textureRefs: new Map( [ [ 'tex-a', tex ] ] ),
	};
	const fallbacks = makeFallbacks();
	const out = dispatchTextureBinding( {
		artifact,
		groupName: 'render',
		bindingName: 'nodeTexture0',
		material: null,
		deps: { fallbacks, makeViewportFallback: () => null },
	} );
	assert.equal( out, tex );
	const strategies = artifact._textureResolutionStrategies;
	assert.ok( strategies instanceof Map );
	assert.equal( strategies.get( 'render:nodeTexture0' ), 'texture-ref' );

} );
