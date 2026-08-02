import test from 'node:test';
import assert from 'node:assert/strict';

import { writeUniformGroup } from '../src/hydrate/material-writers.js';
import { writeTextureUVFlip } from '../src/writers.js';

function makeView() {

	return new DataView( new ArrayBuffer( 16 ) );

}

function makeSource( valueSnapshot = 0 ) {

	return {
		kind: 'texture.uvFlipY',
		textureUuid: 'texture-uuid',
		valueSnapshot: { type: 'uint', data: valueSnapshot },
	};

}

test( 'writeTextureUVFlip mirrors Three r185 TextureNode live-texture rules', () => {

	const previousImageBitmap = Object.getOwnPropertyDescriptor( globalThis, 'ImageBitmap' );
	class TestImageBitmap {}
	Object.defineProperty( globalThis, 'ImageBitmap', {
		value: TestImageBitmap,
		configurable: true,
		writable: true,
	} );
	try {

		const source = makeSource( 1 );
		const cases = [
			{ texture: { image: new TestImageBitmap(), flipY: true }, expected: 1, label: 'flipped ImageBitmap' },
			{ texture: { image: new TestImageBitmap(), flipY: false }, expected: 0, label: 'unflipped ImageBitmap' },
			{ texture: { image: {}, flipY: true }, expected: 0, label: 'ordinary flipped image' },
			{ texture: { isRenderTargetTexture: true }, expected: 1, label: 'render-target texture' },
			{ texture: { isFramebufferTexture: true }, expected: 1, label: 'framebuffer texture' },
			{ texture: { isDepthTexture: true }, expected: 1, label: 'depth texture' },
		];
		for ( const { texture, expected, label } of cases ) {

			const view = makeView();
			writeTextureUVFlip( view, 4, { _textureRefs: new Map( [ [ source.textureUuid, texture ] ] ) }, source );
			assert.equal( view.getUint32( 4, true ), expected, label );

		}

	} finally {

		if ( previousImageBitmap ) Object.defineProperty( globalThis, 'ImageBitmap', previousImageBitmap );
		else delete globalThis.ImageBitmap;

	}

} );

test( 'writeTextureUVFlip uses the captured uint snapshot only when the texture relation is unavailable', () => {

	const source = makeSource( 1 );
	const view = makeView();
	writeTextureUVFlip( view, 0, { _textureRefs: new Map() }, source );
	assert.equal( view.getUint32( 0, true ), 1 );

	writeTextureUVFlip( view, 0, { _textureRefs: new Map( [ [ source.textureUuid, {} ] ] ) }, source );
	assert.equal( view.getUint32( 0, true ), 0, 'a resolved ordinary texture overrides the snapshot' );

} );

test( 'writeUniformGroup dispatches texture.uvFlipY through the selected artifact registry', () => {

	const source = makeSource( 0 );
	const artifact = {
		_textureRefs: new Map( [ [ source.textureUuid, { isFramebufferTexture: true } ] ] ),
	};
	const group = {
		name: 'object',
		slots: [ { offset: 8, dtype: 'uint', source } ],
	};
	const view = makeView();
	writeUniformGroup( group, {}, view, null, null, artifact );
	assert.equal( view.getUint32( 8, true ), 1 );

} );
