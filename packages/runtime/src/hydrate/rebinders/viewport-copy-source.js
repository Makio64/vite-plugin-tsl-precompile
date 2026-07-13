/**
 * Replay-native framebuffer copy sources for viewport texture bindings.
 *
 * Three's Viewport*TextureNode classes combine two concerns: a TSL sampling
 * graph and a render-time framebuffer copy. Slim artifacts already contain
 * the sampling shader, so replay only needs the copy/resource lifecycle.
 */

import { DepthTexture } from 'three/src/textures/DepthTexture.js';
import { FramebufferTexture } from 'three/src/textures/FramebufferTexture.js';
import { LinearMipmapLinearFilter } from 'three/src/constants.js';
import { Vector2 } from 'three/src/math/Vector2.js';

// Renderer.getDrawingBufferSize() accepts a Vector2, not merely a structural
// `{ set() }` target. CanvasTarget chains `.set(...).floor()`, which surfaced
// when viewport transmission copied the default framebuffer during MaterialX
// replay. Keep the real Three value object so every renderer target can honor
// the same contract.
const size = new Vector2();

let sharedDepthTexture = null;
let sharedFramebufferTexture = null;

class ViewportCopySource {

	constructor( texture, opts = {} ) {

		this.defaultFramebuffer = texture;
		this.value = texture;
		this.generateMipmaps = opts.generateMipmaps === true;
		this.shared = opts.shared === true;
		this._cacheTextures = new WeakMap();

	}

	getTextureForReference( reference = null ) {

		if ( this.shared || reference === null ) return this.defaultFramebuffer;
		let texture = this._cacheTextures.get( reference );
		if ( texture === undefined ) {

			texture = this.defaultFramebuffer.clone();
			this._cacheTextures.set( reference, texture );

		}
		return texture;

	}

	updateReference( frame ) {

		if ( this.shared ) return this.value;
		const reference = renderReference( frame.renderer );
		this.value = this.getTextureForReference( reference );
		return this.value;

	}

	updateBefore( frame ) {

		const renderer = frame.renderer;
		const reference = renderReference( renderer );
		readDrawingBufferSize( renderer, reference, size );

		const texture = this.getTextureForReference( reference );
		if ( texture.image.width !== size.width || texture.image.height !== size.height ) {

			texture.image.width = size.width;
			texture.image.height = size.height;
			texture.needsUpdate = true;

		}

		const previousMipmaps = texture.generateMipmaps;
		texture.generateMipmaps = this.generateMipmaps;
		try {

			renderer.copyFramebufferToTexture( texture );

		} finally {

			texture.generateMipmaps = previousMipmaps;

		}

		this.value = texture;

	}

}

function renderReference( renderer ) {

	const renderTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
	if ( renderTarget ) return renderTarget;
	return typeof renderer.getCanvasTarget === 'function' ? renderer.getCanvasTarget() : null;

}

function readDrawingBufferSize( renderer, reference, target ) {

	if ( reference === null ) {

		if ( typeof renderer.getDrawingBufferSize !== 'function' ) return target.set( 1, 1 );
		return renderer.getDrawingBufferSize( target );

	}
	if ( typeof reference.getDrawingBufferSize === 'function' ) return reference.getDrawingBufferSize( target );
	return target.set( reference.width || 1, reference.height || 1 );

}

export function viewportTexture() {

	const texture = new FramebufferTexture();
	texture.minFilter = LinearMipmapLinearFilter;
	return new ViewportCopySource( texture );

}

export function viewportMipTexture() {

	const source = viewportTexture();
	source.generateMipmaps = true;
	return source;

}

export function viewportDepthTexture() {

	if ( sharedDepthTexture === null ) sharedDepthTexture = new DepthTexture();
	return new ViewportCopySource( sharedDepthTexture );

}

export function viewportSharedTexture() {

	if ( sharedFramebufferTexture === null ) sharedFramebufferTexture = new FramebufferTexture();
	return new ViewportCopySource( sharedFramebufferTexture, { shared: true } );

}
