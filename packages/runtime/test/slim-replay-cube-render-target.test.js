import test from 'node:test';
import assert from 'node:assert/strict';

import { Texture } from 'three';
import { createCubeRenderTargetAuxConfig } from '@tsl-precompile/contract/cube-render-target';
import { SLIM_THREE_PACKAGE_VERSION } from '@tsl-precompile/contract/slim-three-policy';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import {
	__resetAuxRegistryForTests,
	bindAuxConfig,
	registerAuxArtifact,
	registerAuxArtifacts,
} from '../src/aux-loader.js';
import { hashPlainConfigSync } from '../src/graph-hash.js';
import { createReplayCubeRenderTargetMaterial } from '../src/slim-replay-cube-render-target.js';
import { extractCubeRenderTargetArtifact } from '../../plugin/src/aux-capture.js';

const SHAPE = 'cube-render-target';
const HASH_OPTIONS = {
	threeVersion: SLIM_THREE_PACKAGE_VERSION,
	pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
};

test.afterEach( () => __resetAuxRegistryForTests() );

test( 'offline CubeRenderTarget capture round-trips through the emitted registry hash domain', async () => {

	let sourceTexture;
	let material;
	try {

		const captured = await extractCubeRenderTargetArtifact( ( { core } ) => {

			sourceTexture = new core.DataTexture( new Uint8Array( 8 ), 2, 1 );
			sourceTexture.mapping = core.EquirectangularReflectionMapping;
			sourceTexture.colorSpace = core.LinearSRGBColorSpace;
			sourceTexture.minFilter = core.LinearMipmapLinearFilter;
			sourceTexture.needsUpdate = true;
			return { sourceTexture, name: 'offline-cube-roundtrip' };

		} );

		const expectedConfigHash = hashPlainConfigSync( captured.artifact.replayConfig, {
			shape: SHAPE,
			...HASH_OPTIONS,
		} );
		assert.equal( captured.configHash, expectedConfigHash );

		registerAuxArtifacts( [ {
			shape: SHAPE,
			configHash: captured.configHash,
			artifact: captured.artifact,
			name: captured.artifact.__name,
			...HASH_OPTIONS,
		} ] );

		material = createReplayCubeRenderTargetMaterial( sourceTexture );
		assert.equal( material.precompiledArtifact.fragmentShader, captured.artifact.fragmentShader );
		assert.equal( material.precompiledArtifact._textureRefs.get( sourceTexture.uuid ), sourceTexture );

	} finally {

		material?.dispose();
		sourceTexture?.dispose();

	}

} );

test( 'CubeRenderTarget selects the exact source-texture config and wires two live owners independently', () => {

	const srgbTexture = textureWithColorSpace( 'srgb' );
	const linearTexture = textureWithColorSpace( 'srgb-linear' );
	const srgbConfig = createCubeRenderTargetAuxConfig( srgbTexture );
	const linearConfig = createCubeRenderTargetAuxConfig( linearTexture );
	assert.notDeepEqual( srgbConfig, linearConfig, 'color-space topology must produce distinct configs' );

	const srgbArtifact = artifact( 'srgb', srgbConfig );
	const linearArtifact = artifact( 'linear', linearConfig );
	registerForConfig( srgbConfig, srgbArtifact );
	registerForConfig( linearConfig, linearArtifact );

	const srgbMaterial = createReplayCubeRenderTargetMaterial( srgbTexture );
	const linearMaterial = createReplayCubeRenderTargetMaterial( linearTexture );
	assert.equal( srgbMaterial.name, 'CubeRenderTarget.material' );
	assert.equal( linearMaterial.name, 'CubeRenderTarget.material' );
	assert.equal( srgbMaterial.precompiledArtifact.fragmentShader, 'fragment:srgb' );
	assert.equal( linearMaterial.precompiledArtifact.fragmentShader, 'fragment:linear' );
	assert.notEqual( srgbMaterial.precompiledArtifact, srgbArtifact );
	assert.notEqual( linearMaterial.precompiledArtifact, linearArtifact );
	assert.equal( srgbMaterial.precompiledArtifact._textureRefs.get( 'texture:srgb' ), srgbTexture );
	assert.equal( linearMaterial.precompiledArtifact._textureRefs.get( 'texture:linear' ), linearTexture );
	assert.equal( srgbArtifact._textureRefs, undefined, 'registry template remains owner-independent' );
	assert.equal( linearArtifact._textureRefs, undefined, 'second registry template remains owner-independent' );

} );

test( 'CubeRenderTarget clones the artifact and mutable texture-ref map for every call', () => {

	const firstTexture = textureWithColorSpace( 'srgb' );
	const secondTexture = textureWithColorSpace( 'srgb' );
	const config = createCubeRenderTargetAuxConfig( firstTexture );
	const captured = artifact( 'shared', config );
	Object.defineProperty( captured, '_textureRefs', {
		value: new Map( [ [ 'captured-only', { owner: 'registry' } ] ] ),
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	registerForConfig( config, captured );

	const firstArtifact = createReplayCubeRenderTargetMaterial( firstTexture ).precompiledArtifact;
	const secondArtifact = createReplayCubeRenderTargetMaterial( secondTexture ).precompiledArtifact;
	assert.notEqual( firstArtifact, secondArtifact );
	assert.notEqual( firstArtifact._textureRefs, secondArtifact._textureRefs );
	assert.notEqual( firstArtifact._textureRefs, captured._textureRefs );
	assert.equal( firstArtifact._textureRefs.get( 'texture:shared' ), firstTexture );
	assert.equal( secondArtifact._textureRefs.get( 'texture:shared' ), secondTexture );
	firstArtifact._textureRefs.set( 'first-only', firstTexture );
	assert.equal( secondArtifact._textureRefs.has( 'first-only' ), false );
	assert.equal( captured._textureRefs.has( 'first-only' ), false );
	assert.equal( captured._textureRefs.has( 'texture:shared' ), false );

} );

test( 'CubeRenderTarget selects custom destination format and sample topology exactly', () => {

	const sourceTexture = textureWithColorSpace( 'srgb-linear' );
	const customTarget = destinationTarget( {
		texture: { format: 1022, internalFormat: 'rgba16float' },
		samples: 4,
		depthBuffer: false,
		stencilBuffer: true,
	} );
	const customConfig = createCubeRenderTargetAuxConfig( sourceTexture, customTarget );
	registerForConfig( customConfig, artifact( 'custom-target', customConfig ) );

	assert.throws(
		() => createReplayCubeRenderTargetMaterial( sourceTexture ),
		( error ) => error.code === 'AUX_ARTIFACT_NOT_FOUND',
		'default destination must not borrow a custom-target capture',
	);
	const material = createReplayCubeRenderTargetMaterial( sourceTexture, customTarget );
	assert.equal( material.precompiledArtifact.fragmentShader, 'fragment:custom-target' );
	assert.equal( customConfig.target.format, 1022 );
	assert.equal( customConfig.target.sampleCount, 4 );
	assert.equal( customConfig.target.depth, false );

} );

test( 'CubeRenderTarget rejects artifacts without one exact source-texture binding domain', () => {

	const sourceTexture = textureWithColorSpace( 'srgb' );
	const config = createCubeRenderTargetAuxConfig( sourceTexture );
	const invalid = artifact( 'invalid-evidence', config );
	invalid.uniformPlan = [];
	registerForConfig( config, invalid );
	assert.throws(
		() => createReplayCubeRenderTargetMaterial( sourceTexture ),
		/createReplayCubeRenderTargetMaterial: artifact\.texture UUID domain \[\] must contain exactly one source texture/,
	);

} );

test( 'CubeRenderTarget fails closed when no exact artifact is registered and never uses shape fallback', () => {

	const sourceTexture = textureWithColorSpace( 'srgb' );
	assert.throws(
		() => createReplayCubeRenderTargetMaterial( sourceTexture ),
		( error ) => error.name === 'AuxArtifactSelectionError'
			&& error.code === 'AUX_ARTIFACT_NOT_FOUND'
			&& error.shape === SHAPE,
	);

	const config = createCubeRenderTargetAuxConfig( sourceTexture );
	registerAuxArtifact( SHAPE, 'captured-under-the-wrong-hash', artifact( 'wrong', config ), HASH_OPTIONS );
	assert.throws(
		() => createReplayCubeRenderTargetMaterial( sourceTexture ),
		( error ) => error.name === 'AuxArtifactSelectionError'
			&& error.code === 'AUX_ARTIFACT_NOT_FOUND'
			&& /do not guess by shape/.test( error.message ),
	);

} );

test( 'CubeRenderTarget reports an ambiguous uncaptured config when multiple captures exist', () => {

	const srgbTexture = textureWithColorSpace( 'srgb' );
	const linearTexture = textureWithColorSpace( 'srgb-linear' );
	const uncapturedTexture = textureWithColorSpace( 'display-p3' );
	registerForConfig( createCubeRenderTargetAuxConfig( srgbTexture ), artifact( 'srgb', createCubeRenderTargetAuxConfig( srgbTexture ) ) );
	registerForConfig( createCubeRenderTargetAuxConfig( linearTexture ), artifact( 'linear', createCubeRenderTargetAuxConfig( linearTexture ) ) );

	assert.throws(
		() => createReplayCubeRenderTargetMaterial( uncapturedTexture ),
		( error ) => error.name === 'AuxArtifactSelectionError'
			&& error.code === 'AUX_ARTIFACT_AMBIGUOUS'
			&& error.knownCaptures.length === 2,
	);

} );

test( 'CubeRenderTarget validates captured replayConfig after an explicit binding', () => {

	const capturedTexture = textureWithColorSpace( 'srgb' );
	const activeTexture = textureWithColorSpace( 'srgb-linear' );
	const capturedConfig = createCubeRenderTargetAuxConfig( capturedTexture );
	const configHash = registerForConfig( capturedConfig, artifact( 'captured', capturedConfig ) );
	bindAuxConfig( activeTexture, SHAPE, configHash );

	assert.throws(
		() => createReplayCubeRenderTargetMaterial( activeTexture ),
		( error ) => error.name === 'ReplayCubeRenderTargetError'
			&& error.code === 'REPLAY_CUBE_RENDER_TARGET_CONFIG_MISMATCH'
			&& error.config.colorSpace === 'srgb-linear'
			&& error.capturedConfig.colorSpace === 'srgb',
	);

} );

test( 'CubeRenderTarget rejects an exact legacy artifact without replayConfig', () => {

	const sourceTexture = textureWithColorSpace( 'srgb' );
	const config = createCubeRenderTargetAuxConfig( sourceTexture );
	const configHash = hashConfig( config );
	registerAuxArtifact( SHAPE, configHash, artifact( 'legacy' ), HASH_OPTIONS );

	assert.throws(
		() => createReplayCubeRenderTargetMaterial( sourceTexture ),
		( error ) => error.name === 'ReplayCubeRenderTargetError'
			&& error.code === 'REPLAY_CUBE_RENDER_TARGET_CONFIG_REQUIRED'
			&& error.config.schema === 'cube-render-target@1',
	);

} );

function textureWithColorSpace( colorSpace ) {

	const texture = new Texture();
	texture.colorSpace = colorSpace;
	return texture;

}

function destinationTarget( overrides = {} ) {

	const texture = overrides.texture || { format: 1023, internalFormat: null };
	return {
		isCubeRenderTarget: true,
		texture,
		textures: [ texture ],
		samples: 0,
		depthBuffer: true,
		stencilBuffer: false,
		resolveDepthBuffer: true,
		resolveStencilBuffer: true,
		multiview: false,
		depthTexture: null,
		...overrides,
	};

}

function artifact( name, replayConfig = undefined ) {

	const captured = {
		name,
		vertexShader: `vertex:${ name }`,
		fragmentShader: `fragment:${ name }`,
		bindings: [],
		uniformPlan: [ {
			name: 'material',
			textures: [ {
				name: 'sourceTexture',
				bindingKind: 'sampled-texture',
				textureType: '2d',
				source: {
					kind: 'artifact.texture',
					textureUuid: `texture:${ name }`,
				},
			} ],
		} ],
	};
	if ( replayConfig !== undefined ) captured.replayConfig = replayConfig;
	return captured;

}

function registerForConfig( config, captured ) {

	const configHash = hashConfig( config );
	registerAuxArtifact( SHAPE, configHash, captured, HASH_OPTIONS );
	return configHash;

}

function hashConfig( config ) {

	return hashPlainConfigSync( config, { shape: SHAPE, ...HASH_OPTIONS } );

}
