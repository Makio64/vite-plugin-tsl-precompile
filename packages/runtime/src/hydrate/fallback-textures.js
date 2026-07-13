/**
 * Per-shape fallback texture singletons + a per-binding viewport fallback
 * factory. Consumed by the texture-resolver dispatcher when no live or
 * captured texture can be resolved for a binding — the fallback satisfies
 * WebGPU bind-group validation so the pipeline keeps progressing instead
 * of failing silently.
 *
 * Keep keys in sync with `selectFallbackTextureForBinding` in
 * [./texture-resolver.js](./texture-resolver.js); that selector keys off
 * the shader-declared texture type to pick which of these to return.
 *
 * @module Hydrate.FallbackTextures
 */

import { CubeDepthTexture } from 'three/src/textures/CubeDepthTexture.js';
import { CubeTexture } from 'three/src/textures/CubeTexture.js';
import { Data3DTexture } from 'three/src/textures/Data3DTexture.js';
import { DataArrayTexture } from 'three/src/textures/DataArrayTexture.js';
import { DataTexture } from 'three/src/textures/DataTexture.js';
import { DepthTexture } from 'three/src/textures/DepthTexture.js';
import { FramebufferTexture } from 'three/src/textures/FramebufferTexture.js';
import {
	DepthFormat,
	LessEqualCompare,
	LinearMipmapLinearFilter,
	RGBAFormat,
	UnsignedByteType,
	UnsignedIntType,
} from 'three/src/constants.js';

import { shaderDeclaresDepthTexture } from './texture-resolver.js';

// Plain 1×1 white texture. Default fallback for any 2D `texture<f32>`
// binding the dispatcher can't otherwise satisfy.
const fallbackTexture = new DataTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1, RGBAFormat );
fallbackTexture.needsUpdate = true;

// Cube fallback: a six-face neutral grey cube. Supplied to texture_cube
// bindings whose live cubemap could not be resolved (e.g. capture-side
// uuids no longer match anything on replay). Without this fallback a
// pipeline that declares texture_cube<f32> ends up bound to a 2D fallback
// texture, the WebGPU validator silently rejects the bind group, and the
// draw is skipped — producing an empty canvas with no error surfaced.
function makeCubeFallback() {

	const faces = [];
	for ( let i = 0; i < 6; i ++ ) {

		const data = new Uint8Array( [ 128, 128, 128, 255 ] );
		const tex = new DataTexture( data, 1, 1, RGBAFormat );
		tex.needsUpdate = true;
		faces.push( tex.image );

	}
	const cube = new CubeTexture( faces );
	cube.format = RGBAFormat;
	cube.type = UnsignedByteType;
	cube.needsUpdate = true;
	return cube;

}

const fallbackCubeTexture = makeCubeFallback();

const fallback3DTexture = new Data3DTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1, 1 );
fallback3DTexture.format = RGBAFormat;
fallback3DTexture.type = UnsignedByteType;
fallback3DTexture.needsUpdate = true;

const fallbackArrayTexture = new DataArrayTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1, 1 );
fallbackArrayTexture.format = RGBAFormat;
fallbackArrayTexture.type = UnsignedByteType;
fallbackArrayTexture.needsUpdate = true;

const fallbackDepthTexture = new DepthTexture( 1, 1 );
fallbackDepthTexture.format = DepthFormat;
fallbackDepthTexture.type = UnsignedIntType;
fallbackDepthTexture.renderTarget = { samples: 1 };

const fallbackDepthArrayTexture = new DepthTexture( 1, 1, UnsignedIntType, undefined, undefined, undefined, undefined, undefined, undefined, DepthFormat, 1 );
fallbackDepthArrayTexture.format = DepthFormat;
fallbackDepthArrayTexture.type = UnsignedIntType;
fallbackDepthArrayTexture.isArrayTexture = true;
fallbackDepthArrayTexture.image.depth = 1;
fallbackDepthArrayTexture.renderTarget = { samples: 1 };

const fallbackComparisonDepthTexture = new DepthTexture( 1, 1 );
fallbackComparisonDepthTexture.format = DepthFormat;
fallbackComparisonDepthTexture.type = UnsignedIntType;
fallbackComparisonDepthTexture.compareFunction = LessEqualCompare;
fallbackComparisonDepthTexture.renderTarget = { samples: 1 };

const fallbackMultisampledDepthTexture = new DepthTexture( 1, 1 );
fallbackMultisampledDepthTexture.format = DepthFormat;
fallbackMultisampledDepthTexture.type = UnsignedIntType;
fallbackMultisampledDepthTexture.renderTarget = { samples: 4 };

const fallbackDepthCubeTexture = new CubeDepthTexture( 1 );
fallbackDepthCubeTexture.format = DepthFormat;
fallbackDepthCubeTexture.type = UnsignedIntType;
fallbackDepthCubeTexture.compareFunction = LessEqualCompare;
fallbackDepthCubeTexture.renderTarget = { samples: 1 };

/**
 * One bag, passed through to `dispatchTextureBinding` whenever the
 * dispatcher needs a shape-appropriate fallback. `selectFallbackTextureForBinding`
 * (texture-resolver.js) keys off the shader-declared type to pick which of
 * these to return — keep keys in sync with that selector.
 */
export const textureBindingFallbacks = Object.freeze( {
	texture: fallbackTexture,
	comparisonDepth: fallbackComparisonDepthTexture,
	depth: fallbackDepthTexture,
	depthCube: fallbackDepthCubeTexture,
	depthArray: fallbackDepthArrayTexture,
	multisampledDepth: fallbackMultisampledDepthTexture,
	cube: fallbackCubeTexture,
	texture3D: fallback3DTexture,
	array: fallbackArrayTexture,
} );

/**
 * Per-binding 1×1 fallback for `viewport.texture` bindings. The live
 * viewport texture is swapped in by `createViewportTextureRebinder` on the
 * first render-before; this fallback only exists so WebGPU bind-group
 * validation passes before that runs. Allocate fresh instances (rather than
 * a module singleton) so that aux-bg / postprocess paths whose own viewport
 * fallbacks are seeded by `wireViewportTextureRefs` aren't accidentally
 * pointed at the same texture.
 *
 * @param {Object} artifact
 * @param {string} bindingName
 * @param {?Object} [source=null] - dynamic-binding source descriptor (for `isDepth` hint).
 * @returns {DepthTexture|FramebufferTexture}
 */
export function makeViewportFallback( artifact, bindingName, source = null ) {

	const isDepth = source && source.isDepth === true ||
		( artifact && bindingName && shaderDeclaresDepthTexture( artifact, bindingName ) );
	if ( isDepth ) {

		const tex = new DepthTexture( 1, 1 );
		tex.format = DepthFormat;
		tex.type = UnsignedIntType;
		tex.renderTarget = { samples: 1 };
		tex.needsUpdate = true;
		return tex;

	}

	const tex = new FramebufferTexture( 1, 1 );
	tex.minFilter = LinearMipmapLinearFilter;
	tex.needsUpdate = true;
	return tex;

}
