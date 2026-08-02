import test from 'node:test';
import assert from 'node:assert/strict';

import { validateDynamicBindingSource } from '@tsl-precompile/contract/dynamic-bindings';
import {
	RENDERER_RENDER_TARGET_TEXTURE_SELECTOR_SCHEMA,
	createRendererRenderTargetTextureSelector,
	isRendererRenderTargetTextureSelector,
	rendererRenderTargetTextureSelectorValidationError,
	rendererRenderTargetTextureSelectorsMatch,
} from '@tsl-precompile/contract/render-target-texture';

function texture( options = {} ) {

	return {
		isTexture: true,
		isRenderTargetTexture: true,
		isDepthTexture: options.depth === true,
		isData3DTexture: options.dimension === '3d',
		name: options.name || '',
		format: options.format ?? 1023,
		type: options.type ?? 1009,
		colorSpace: options.colorSpace ?? 'srgb-linear',
		image: {
			width: options.width || 16,
			height: options.height || 8,
			depth: options.imageDepth || 1,
		},
	};

}

test( 'render-target texture contract addresses MRT color and depth attachments exactly', () => {

	const color0 = texture( { name: 'albedo' } );
	const color1 = texture( { name: 'gather', format: 1028, type: 1016 } );
	const depth = texture( { name: 'depth', depth: true, format: 1026, type: 1014, colorSpace: '' } );
	const target = {
		width: 320,
		height: 180,
		depth: 1,
		texture: color0,
		textures: [ color0, color1 ],
		depthTexture: depth,
	};
	for ( const attachment of [ color0, color1, depth ] ) attachment.renderTarget = target;

	const colorSelector = createRendererRenderTargetTextureSelector( target, { texture: color1 } );
	const depthSelector = createRendererRenderTargetTextureSelector( target, { texture: depth } );
	assert.equal( colorSelector.schema, RENDERER_RENDER_TARGET_TEXTURE_SELECTOR_SCHEMA );
	assert.deepEqual( colorSelector.attachment, { role: 'color', index: 1 } );
	assert.deepEqual( colorSelector.target, { topology: 'mrt', dimension: '2d', mrtCount: 2 } );
	assert.deepEqual( depthSelector.attachment, { role: 'depth', index: null } );
	assert.equal( isRendererRenderTargetTextureSelector( colorSelector ), true );
	assert.equal( rendererRenderTargetTextureSelectorsMatch( colorSelector, structuredClone( colorSelector ) ), true );
	assert.equal( rendererRenderTargetTextureSelectorsMatch( colorSelector, depthSelector ), false );

} );

test( 'render-target texture structural matching ignores only identity hints', () => {

	const captured = texture( { name: 'UnrealBloomPass.bright', width: 256, height: 128 } );
	const live = texture( { name: 'UnrealBloomPass.h0', width: 128, height: 64 } );
	const capturedTarget = {
		width: 256,
		height: 128,
		depth: 1,
		texture: captured,
		textures: [ captured ],
		depthTexture: null,
	};
	const liveTarget = {
		width: 128,
		height: 64,
		depth: 1,
		texture: live,
		textures: [ live ],
		depthTexture: null,
	};
	const capturedSelector = createRendererRenderTargetTextureSelector( capturedTarget );
	const liveSelector = createRendererRenderTargetTextureSelector( liveTarget );

	assert.equal( rendererRenderTargetTextureSelectorsMatch( capturedSelector, liveSelector ), false );
	assert.equal(
		rendererRenderTargetTextureSelectorsMatch( capturedSelector, liveSelector, { matchHints: false } ),
		true,
	);
	assert.equal(
		rendererRenderTargetTextureSelectorsMatch(
			capturedSelector,
			{
				...liveSelector,
				texture: { ...liveSelector.texture, type: 1016 },
			},
			{ matchHints: false },
		),
		false,
		'structural matching must retain executable texture compatibility',
	);

} );

test( 'render-target texture contract rejects stale attachment claims and malformed selectors', () => {

	const attached = texture();
	const detached = texture();
	const target = {
		width: 16,
		height: 8,
		depth: 1,
		texture: attached,
		textures: [ attached ],
		depthTexture: null,
	};
	assert.throws(
		() => createRendererRenderTargetTextureSelector( target, { texture: detached } ),
		/not a current attachment/,
	);

	const malformed = {
		schema: RENDERER_RENDER_TARGET_TEXTURE_SELECTOR_SCHEMA,
		attachment: { role: 'color', index: 2 },
		target: { topology: 'single', dimension: '2d', mrtCount: 1 },
		texture: { dimension: '2d', format: 1023, type: 1009, colorSpace: '' },
		hints: { name: null, extent: { width: 16, height: 8, depth: 1 } },
	};
	assert.equal( rendererRenderTargetTextureSelectorValidationError( malformed ), 'color-attachment-index-out-of-range' );
	assert.equal( isRendererRenderTargetTextureSelector( malformed ), false );

} );

test( 'dynamic source validation accepts selectors only on authoritative artifact/non-light depth sources', () => {

	const color = texture( { name: 'producer-output' } );
	const target = {
		width: 16,
		height: 8,
		depth: 1,
		texture: color,
		textures: [ color ],
		depthTexture: null,
	};
	const selector = createRendererRenderTargetTextureSelector( target, { texture: color } );

	assert.deepEqual( validateDynamicBindingSource( {
		kind: 'artifact.texture',
		textureUuid: 'captured',
		renderTargetSelector: selector,
	} ), [] );
	assert.deepEqual( validateDynamicBindingSource( {
		kind: 'depth.texture',
		textureUuid: 'captured-depth',
		lightIndex: -1,
		fromMaterialGraph: true,
		renderTargetSelector: selector,
	} ), [] );

	const lightErrors = validateDynamicBindingSource( {
		kind: 'depth.texture',
		textureUuid: 'shadow-depth',
		lightIndex: 0,
		lightUuid: 'light',
		renderTargetSelector: selector,
	} );
	assert.ok( lightErrors.some( ( error ) => error.code === 'dynamic-binding.render-target-selector-owner' ) );

	const malformedErrors = validateDynamicBindingSource( {
		kind: 'artifact.texture',
		renderTargetSelector: { ...selector, schema: 'future@9' },
	} );
	assert.ok( malformedErrors.some( ( error ) => error.code === 'dynamic-binding.render-target-selector' ) );

} );
