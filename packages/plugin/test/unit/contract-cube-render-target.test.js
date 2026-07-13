import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	CUBE_RENDER_TARGET_AUX_CONFIG_SCHEMA,
	assertCubeRenderTargetTextureEvidence,
	createCubeRenderTargetAuxConfig,
} from '@tsl-precompile/contract/cube-render-target';

test( 'cube-render-target config captures canonical 2D texture and sampler topology', () => {

	const config = createCubeRenderTargetAuxConfig( {
		isTexture: true,
		type: 1016,
		format: 1023,
		internalFormat: 'rgba16float',
		colorSpace: 'srgb-linear',
		mapping: 303,
		minFilter: 1003,
		magFilter: 1006,
		wrapS: 1001,
		wrapT: 1002,
		anisotropy: 4,
		compareFunction: 515,
		generateMipmaps: true,
		isDepthTexture: false,
		isRenderTargetTexture: true,
		isFramebufferTexture: true,
		isStorageTexture: true,
	} );

	assert.deepEqual( config, {
		schema: CUBE_RENDER_TARGET_AUX_CONFIG_SCHEMA,
		dimension: '2d',
		type: 1016,
		format: 1023,
		internalFormat: 'rgba16float',
		colorSpace: 'srgb-linear',
		mapping: 303,
		sampler: {
			minFilter: 1003,
			magFilter: 1006,
			wrapS: 1001,
			wrapT: 1002,
			anisotropy: 4,
			compareFunction: 515,
			generateMipmaps: true,
		},
		depth: false,
		renderTarget: true,
		framebuffer: true,
		storage: true,
		target: {
			format: 1023,
			internalFormat: null,
			colorCount: 1,
			sampleCount: 1,
			depth: true,
			stencil: false,
			resolveDepth: true,
			resolveStencil: true,
			multiview: false,
			depthTexture: null,
		},
	} );
	assert.deepEqual( JSON.parse( JSON.stringify( config ) ), config, 'descriptor is plain JSON-safe data' );

} );

test( 'cube-render-target config signs custom destination attachment topology', () => {

	const source = { isTexture: true, type: 1016, format: 1023 };
	const customTarget = {
		isCubeRenderTarget: true,
		texture: { format: 1022, internalFormat: 'rgba16float' },
		textures: [ {}, {} ],
		samples: 8,
		depthBuffer: false,
		stencilBuffer: true,
		resolveDepthBuffer: false,
		resolveStencilBuffer: false,
		multiview: true,
		depthTexture: { format: 1026, internalFormat: 'depth32float', type: 1014 },
	};
	const config = createCubeRenderTargetAuxConfig( source, customTarget );
	assert.deepEqual( config.target, {
		format: 1022,
		internalFormat: 'rgba16float',
		colorCount: 2,
		sampleCount: 4,
		depth: false,
		stencil: true,
		resolveDepth: false,
		resolveStencil: false,
		multiview: true,
		depthTexture: { format: 1026, internalFormat: 'depth32float', type: 1014 },
	} );
	assert.notDeepEqual( config, createCubeRenderTargetAuxConfig( source ) );
	assert.throws(
		() => createCubeRenderTargetAuxConfig( source, { isRenderTarget: true } ),
		/destination must be a CubeRenderTarget/,
	);

} );

test( 'cube-render-target config excludes texture identity, pixels, dimensions, and live transforms', () => {

	const topology = {
		isTexture: true,
		type: 1009,
		format: 1023,
		internalFormat: null,
		colorSpace: '',
		mapping: 303,
		minFilter: 1008,
		magFilter: 1006,
		wrapS: 1001,
		wrapT: 1001,
		anisotropy: 1,
		compareFunction: null,
		generateMipmaps: true,
	};
	const first = createCubeRenderTargetAuxConfig( {
		...topology,
		uuid: 'capture-texture',
		name: 'capture',
		image: { width: 2048, height: 1024, data: new Uint8Array( 4 ) },
		flipY: true,
		offset: { x: 0, y: 0 },
	} );
	const second = createCubeRenderTargetAuxConfig( {
		...topology,
		uuid: 'replay-texture',
		name: 'replay',
		image: { width: 4, height: 2, data: new Float32Array( 32 ) },
		flipY: false,
		offset: { x: 0.5, y: 0.25 },
	} );

	assert.deepEqual( second, first );
	assert.notDeepEqual( createCubeRenderTargetAuxConfig( { ...topology, colorSpace: 'srgb' } ), first );
	assert.notDeepEqual( createCubeRenderTargetAuxConfig( { ...topology, type: 1016 } ), first );
	assert.notDeepEqual( createCubeRenderTargetAuxConfig( { ...topology, minFilter: 1003 } ), first );

} );

test( 'cube-render-target config signs Three r184 effective mipmap state', () => {

	const topology = {
		isTexture: true,
		type: 1009,
		format: 1023,
		minFilter: 1008,
		magFilter: 1006,
	};
	const beforeCall = createCubeRenderTargetAuxConfig( { ...topology, generateMipmaps: false } );
	const afterForcedMutation = createCubeRenderTargetAuxConfig( { ...topology, minFilter: 1006, generateMipmaps: true } );
	assert.deepEqual( beforeCall, afterForcedMutation );
	assert.equal( beforeCall.sampler.minFilter, 1006, 'LinearMipmapLinearFilter is sampled as LinearFilter during the cube draw' );
	assert.equal( beforeCall.sampler.generateMipmaps, true, 'fromEquirectangularTexture forces mipmap generation before the draw' );

} );

test( 'cube-render-target config rejects non-2D and external source families', () => {

	for ( const flag of [
		'isCubeTexture',
		'isCompressedCubeTexture',
		'isDataArrayTexture',
		'isCompressedArrayTexture',
		'isArrayTexture',
		'isData3DTexture',
		'is3DTexture',
	] ) {

		assert.throws(
			() => createCubeRenderTargetAuxConfig( { isTexture: true, [ flag ]: true } ),
			/expected a 2D texture/,
			flag,
		);

	}

	for ( const flag of [ 'isVideoTexture', 'isVideoFrameTexture', 'isExternalTexture' ] ) {

		assert.throws(
			() => createCubeRenderTargetAuxConfig( { isTexture: true, [ flag ]: true } ),
			/not supported/,
			flag,
		);

	}
	assert.throws( () => createCubeRenderTargetAuxConfig( null ), /expected a Three Texture/ );
	assert.throws( () => createCubeRenderTargetAuxConfig( { isTexture: true, type: Infinity } ), /must be finite/ );
	assert.throws( () => createCubeRenderTargetAuxConfig( { isTexture: true, format: {} } ), /JSON-safe scalar/ );

} );

test( 'cube-render-target config rejects depth sources until a depth sampling artifact is supported', () => {

	assert.throws(
		() => createCubeRenderTargetAuxConfig( { isTexture: true, isDepthTexture: true } ),
		/depth texture sources are not supported/,
	);

} );

test( 'cube-render-target evidence rejects texture identity drift across an artifact family', () => {

	const texturePlan = ( textureUuid ) => [ {
		textures: [ {
			source: { kind: 'artifact.texture', textureUuid },
		} ],
	} ];
	const artifact = {
		cacheKey: 'root',
		uniformPlan: texturePlan( 'texture:root' ),
		variants: {
			root: { cacheKey: 'root', uniformPlan: texturePlan( 'texture:root' ) },
			other: { cacheKey: 'other', uniformPlan: texturePlan( 'texture:other' ) },
		},
	};

	assert.throws(
		() => assertCubeRenderTargetTextureEvidence( artifact ),
		/artifact family artifact\.texture UUID domain.*must contain exactly one source texture/,
	);
	artifact.variants.other.uniformPlan = texturePlan( 'texture:root' );
	assert.deepEqual( [ ...assertCubeRenderTargetTextureEvidence( artifact ) ], [ 'texture:root' ] );

} );
