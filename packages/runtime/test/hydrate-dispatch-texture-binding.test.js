import test from 'node:test';
import assert from 'node:assert/strict';
import { createUniformPlanIndex } from '../src/hydrate/uniform-plan.js';
import { resolvePlanTextureTypeHint } from '../src/hydrate/texture-resolver.js';

import {
	_resetTextureMissWarnings,
	dispatchTextureBinding,
	setTextureResolutionDebugHook,
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

test( 'dispatchTextureBinding prefers an attached material-graph pass depth texture', () => {

	const source = {
		kind: 'depth.texture',
		textureUuid: 'pass-depth',
		fromMaterialGraph: true,
		lightIndex: - 1,
	};
	const artifact = makeArtifact( source );
	artifact.fragmentShader = 'var nodeTexture0: texture_depth_2d;';
	const liveDepth = { isTexture: true, isDepthTexture: true, name: 'depth' };
	artifact._textureRefs = new Map( [ [ source.textureUuid, liveDepth ] ] );
	const result = dispatchTextureBinding( {
		artifact,
		groupName: 'render',
		bindingName: 'nodeTexture0',
		material: null,
		deps: { fallbacks: makeFallbacks() },
	} );

	assert.equal( result, liveDepth );

} );

test( 'dispatchTextureBinding rejects a color texture merely named depth', () => {

	const source = {
		kind: 'depth.texture',
		textureUuid: 'pass-depth',
		fromMaterialGraph: true,
		lightIndex: - 1,
	};
	const artifact = makeArtifact( source );
	artifact.fragmentShader = 'var nodeTexture0: texture_depth_2d;';
	artifact._textureRefs = new Map( [ [ source.textureUuid, { isTexture: true, name: 'depth' } ] ] );
	const fallbacks = makeFallbacks();
	const result = dispatchTextureBinding( {
		artifact,
		groupName: 'render',
		bindingName: 'nodeTexture0',
		material: null,
		deps: { fallbacks },
	} );

	assert.equal( result, fallbacks.depth );

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

test( 'live material textures skip shader hints and fallback reads but still follow shader changes when absent', () => {

	const artifact = makeArtifact( { kind: 'material.map' } );
	const texture = { isTexture: true };
	const material = { map: texture };
	let shaderReads = 0;
	let shader = artifact.fragmentShader;
	Object.defineProperty( artifact, 'fragmentShader', { get() { shaderReads ++; return shader; } } );
	const fallbacks = makeFallbacks();
	let fallbackReads = 0;
	const trackedFallbacks = new Proxy( fallbacks, { get( target, key ) { fallbackReads ++; return target[ key ]; } } );
	const context = { artifact, groupName: 'render', bindingName: 'nodeTexture0', material, deps: { fallbacks: trackedFallbacks } };
	assert.equal( dispatchTextureBinding( context ), texture );
	assert.equal( shaderReads, 0 );
	assert.equal( fallbackReads, 0 );
	material.map = null;
	shader = 'var nodeTexture0: texture_cube<f32>;';
	assert.equal( dispatchTextureBinding( context ), fallbacks.cube );
	shader = 'var nodeTexture0: texture_2d<f32>;';
	assert.equal( dispatchTextureBinding( context ), fallbacks.texture );
	assert.ok( shaderReads > 0 && fallbackReads > 0 );

} );

test( 'successful artifact resolution only reads diagnostic metadata while a hook is installed', () => {

	const source = { kind: 'artifact.texture', textureUuid: 'diagnostic-live' };
	const artifact = makeArtifact( source );
	let imageReads = 0;
	const texture = { isTexture: true, isRenderTargetTexture: true, uuid: 'live', name: 'output', get image() { imageReads ++; return { width: 64, height: 32 }; } };
	artifact._textureRefs = new Map( [ [ source.textureUuid, texture ] ] );
	const context = { artifact, groupName: 'render', bindingName: 'nodeTexture0', deps: { fallbacks: makeFallbacks() } };
	const previous = setTextureResolutionDebugHook( null );
	try {

		assert.equal( dispatchTextureBinding( context ), texture );
		assert.equal( imageReads, 0 );
		assert.equal( artifact._textureResolutionStrategies.get( 'render:nodeTexture0' ), 'render-target-texture-ref' );
		const events = [];
		setTextureResolutionDebugHook( event => events.push( event ) );
		assert.equal( dispatchTextureBinding( context ), texture );
		assert.equal( imageReads, 1 );
		assert.equal( events[ 0 ].resolvedTextureWidth, 64 );
		assert.equal( events[ 0 ].resolvedTextureHeight, 32 );
		assert.equal( events[ 0 ].resolvedTextureType, 'render-target' );
		assert.equal( events[ 0 ].textureTypeHint, '2d' );
		assert.equal( events[ 0 ].textureUuid, source.textureUuid );
		setTextureResolutionDebugHook( null );
		assert.equal( dispatchTextureBinding( context ), texture );
		assert.equal( imageReads, 1 );

	} finally {

		setTextureResolutionDebugHook( previous );

	}

} );

test( 'builtin dispatch retains live LTC reconstruction and shape fallback for missing or unknown builtins', () => {

	const artifact = makeArtifact( { kind: 'builtin.ltcTexture', ltcIndex: 0 } );
	const fallbacks = makeFallbacks();
	const context = { artifact, groupName: 'render', bindingName: 'nodeTexture0', deps: { fallbacks } };
	assert.equal( dispatchTextureBinding( context ), fallbacks.texture );
	artifact.ltcTextures = [ new Uint16Array( 64 * 64 * 4 ) ];
	const texture = dispatchTextureBinding( context );
	assert.equal( texture.isDataTexture, true );
	assert.equal( dispatchTextureBinding( context ), texture );
	artifact.uniformPlan[ 0 ].textures[ 0 ].source.kind = 'builtin.futureTexture';
	artifact.fragmentShader = 'var nodeTexture0: texture_cube<f32>;';
	assert.equal( dispatchTextureBinding( context ), fallbacks.cube );
	texture.dispose();

} );

test( 'indexed dispatch keeps exact-group behavior and live material/source replacements without scanning', () => {

	const artifact = makeArtifact( { kind: 'material.map' } );
	const exact = artifact.uniformPlan[ 0 ];
	const alias = { name: 'nodeTexture0', textures: [ { name: 'nodeTexture0', source: { kind: 'material.normalMap' } } ] };
	artifact.uniformPlan.unshift( alias );
	const index = createUniformPlanIndex( artifact );
	const material = { map: {}, normalMap: {} };
	const context = { artifact, groupName: 'render', bindingName: 'nodeTexture0', material, deps: { fallbacks: makeFallbacks() } };
	const planBinding = index.textureBinding( context.groupName, context.bindingName );
	assert.equal( dispatchTextureBinding( context ), material.map );
	assert.equal( planBinding.owner, alias.textures[ 0 ] );
	assert.equal( dispatchTextureBinding( { ...context, planBinding } ), material.map );
	const missing = { ...context, groupName: 'missing' };
	assert.equal( dispatchTextureBinding( missing ), dispatchTextureBinding( { ...missing, planBinding: index.textureBinding( 'missing', context.bindingName ) } ) );
	artifact.uniformPlan.find = exact.textures.find = () => { throw new Error( 'repeated texture-plan scan' ); };
	material.map = {};
	assert.equal( dispatchTextureBinding( { ...context, planBinding } ), material.map );
	exact.textures[ 0 ].source = { kind: 'material.normalMap' };
	assert.equal( dispatchTextureBinding( { ...context, planBinding } ), material.normalMap );

} );

test( 'indexed dispatch reads replaced texture refs and paired sampler metadata', () => {

	const artifact = makeArtifact( { kind: 'depth.texture', fromMaterialGraph: true, textureUuid: 'depth' } );
	artifact.fragmentShader = 'var nodeTexture0: texture_depth_2d;';
	artifact._textureRefs = new Map();
	const index = createUniformPlanIndex( artifact );
	const planBinding = index.textureBinding( 'render', 'nodeTexture0' );
	for ( const texture of [ { isTexture: true, isDepthTexture: true }, { isTexture: true, isDepthTexture: true } ] ) {

		artifact._textureRefs.set( 'depth', texture );
		assert.equal( dispatchTextureBinding( { artifact, groupName: 'render', bindingName: 'nodeTexture0', planBinding, deps: { fallbacks: makeFallbacks() } } ), texture );

	}
	const sampler = index.textureBinding( 'render', 'nodeTexture0_sampler' );
	artifact.fragmentShader = '';
	artifact.uniformPlan[ 0 ].textures.find = () => { throw new Error( 'repeated paired-texture scan' ); };
	for ( const type of [ 'cube', '3d', '2d-array' ] ) {

		artifact.uniformPlan[ 0 ].textures[ 0 ].textureType = type;
		assert.equal( resolvePlanTextureTypeHint( artifact, sampler.group, sampler.entry, {}, 'nodeTexture0_sampler', sampler.textures ), type );

	}

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

test( 'dispatchTextureBinding throws when TSLP_STRICT_TEXTURE_MISS is on', () => {

	const artifact = makeArtifact( { kind: 'artifact.texture', textureUuid: 'unknown-uuid' }, 'strict-test' );
	const fallbacks = makeFallbacks();
	const originalStrict = globalThis.__TSLP_STRICT_TEXTURE_MISS;
	const originalWarn = globalThis.__TSLP_WARN_TEXTURE_MISS;
	globalThis.__TSLP_STRICT_TEXTURE_MISS = true;
	globalThis.__TSLP_WARN_TEXTURE_MISS = false;
	_resetTextureMissWarnings();
	try {

		assert.throws( () => dispatchTextureBinding( {
			artifact,
			groupName: 'render',
			bindingName: 'nodeTexture0',
			material: null,
			deps: { fallbacks, makeViewportFallback: () => null },
		} ), /Strict texture miss is enabled/ );

	} finally {

		globalThis.__TSLP_STRICT_TEXTURE_MISS = originalStrict;
		globalThis.__TSLP_WARN_TEXTURE_MISS = originalWarn;
		_resetTextureMissWarnings();

	}

} );
