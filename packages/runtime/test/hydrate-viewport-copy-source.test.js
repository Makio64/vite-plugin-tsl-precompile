import test from 'node:test';
import assert from 'node:assert/strict';

import {
	viewportDepthTexture,
	viewportMipTexture,
	viewportSharedTexture,
	viewportTexture,
} from '../src/hydrate/rebinders/viewport-copy-source.js';

function frameFor( reference, onCopy = () => {} ) {

	return {
		renderer: {
			getRenderTarget: () => reference,
			getCanvasTarget: () => null,
			getDrawingBufferSize: ( size ) => size.set( 320, 180 ),
			copyFramebufferToTexture: onCopy,
		},
	};

}

test( 'viewport copy source caches one texture per render reference', () => {

	const source = viewportTexture();
	const first = { width: 64, height: 32 };
	const second = { width: 128, height: 64 };

	source.updateReference( frameFor( first ) );
	const firstTexture = source.value;
	source.updateReference( frameFor( second ) );
	const secondTexture = source.value;
	source.updateReference( frameFor( first ) );

	assert.notEqual( firstTexture, source.defaultFramebuffer );
	assert.notEqual( firstTexture, secondTexture );
	assert.equal( source.value, firstTexture );

} );

test( 'viewport mip source resizes and enables mipmaps only during the copy', () => {

	const source = viewportMipTexture();
	const reference = { width: 96, height: 48 };
	let copied = null;
	let copiedWithMipmaps = false;

	source.updateBefore( frameFor( reference, ( texture ) => {

		copied = texture;
		copiedWithMipmaps = texture.generateMipmaps;

	} ) );

	assert.equal( copied, source.value );
	assert.equal( copied.image.width, 96 );
	assert.equal( copied.image.height, 48 );
	assert.equal( copiedWithMipmaps, true );
	assert.equal( copied.generateMipmaps, false );

} );

test( 'viewport copy passes a full Vector2 to CanvasTarget drawing-buffer sizing', () => {

	const source = viewportTexture();
	let copied = null;
	const canvasTarget = {
		getDrawingBufferSize( target ) {

			assert.equal( target.isVector2, true );
			return target.set( 96.75, 48.5 ).floor();

		},
	};
	const frame = {
		renderer: {
			getRenderTarget: () => null,
			getCanvasTarget: () => canvasTarget,
			copyFramebufferToTexture: ( texture ) => { copied = texture; },
		},
	};

	source.updateReference( frame );
	source.updateBefore( frame );

	assert.equal( copied, source.value );
	assert.equal( copied.image.width, 96 );
	assert.equal( copied.image.height, 48 );

} );

test( 'viewport depth and shared sources preserve Three resource semantics', () => {

	const depthA = viewportDepthTexture();
	const depthB = viewportDepthTexture();
	assert.equal( depthA.defaultFramebuffer, depthB.defaultFramebuffer );
	assert.equal( depthA.value.isDepthTexture, true );

	const sharedA = viewportSharedTexture();
	const sharedB = viewportSharedTexture();
	const initial = sharedA.value;
	sharedA.updateReference( frameFor( { width: 10, height: 10 } ) );

	assert.equal( sharedA.value, initial );
	assert.equal( sharedA.value, sharedB.value );

} );
