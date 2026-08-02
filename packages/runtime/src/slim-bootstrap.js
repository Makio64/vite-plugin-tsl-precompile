/**
 * Required one-time initialization for both slim entries.
 *
 * Keep these effects in one package-declared side-effect module: source-mode
 * consumers can tree-shake unused constructors without losing renderer
 * sentinels, viewport texture factories, or the 3D texture upload
 * compatibility patch. The checked Three Loader rewrite installs texture
 * tracking lazily on each concrete loader instead of retaining them here.
 */

import WebGPURenderer from 'three/src/renderers/webgpu/WebGPURenderer.js';
import WebGPUTextureUtils from 'three/src/renderers/webgpu/utils/WebGPUTextureUtils.js';
import { DepthTexture } from 'three/src/textures/DepthTexture.js';
import { FramebufferTexture } from 'three/src/textures/FramebufferTexture.js';
import { HalfFloatType, RedFormat, RGBAFormat, UnsignedByteType } from 'three/src/constants.js';
import { setupViewportTextureClasses } from './aux-loader.js';

const TEXTURE_UTILS_PATCH = Symbol.for( '@tsl-precompile/runtime/slim-webgpu-texture-utils@1' );

WebGPURenderer.__TSLP_SLIM__ = true;
WebGPURenderer.prototype.__TSLP_SLIM__ = true;

setupViewportTextureClasses( { DepthTexture, FramebufferTexture } );

function default3DTextureFormat( texture ) {

	if ( typeof texture.internalFormat === 'string' ) return texture.internalFormat;
	if ( texture.format === RGBAFormat && texture.type === UnsignedByteType ) return 'rgba8unorm';
	if ( texture.format === RGBAFormat && texture.type === HalfFloatType ) return 'rgba16float';
	if ( texture.format === RedFormat && texture.type === UnsignedByteType ) return 'r8unorm';
	return null;

}

const textureUtilsPrototype = WebGPUTextureUtils.prototype;
if ( textureUtilsPrototype[ TEXTURE_UTILS_PATCH ] !== true ) {

	Object.defineProperty( textureUtilsPrototype, TEXTURE_UTILS_PATCH, { value: true } );
	const createDefaultTexture = textureUtilsPrototype.createDefaultTexture;
	const createTexture = textureUtilsPrototype.createTexture;
	const updateTexture = textureUtilsPrototype.updateTexture;

	textureUtilsPrototype.createDefaultTexture = function ( texture ) {

		if (
			texture &&
			texture.isRenderTargetTexture !== true &&
			( texture.isData3DTexture === true || texture.is3DTexture === true )
		) {

			const usage = typeof globalThis !== 'undefined' ? globalThis.GPUTextureUsage : null;
			const format = default3DTextureFormat( texture );
			if ( usage && format && this.backend && this.backend.device ) {

				try {

					this.backend.get( texture ).texture = this.backend.device.createTexture( {
						label: texture.name,
						size: { width: 1, height: 1, depthOrArrayLayers: 1 },
						mipLevelCount: 1,
						sampleCount: 1,
						dimension: '3d',
						format,
						usage: usage.TEXTURE_BINDING | usage.COPY_DST | usage.COPY_SRC,
					} );
					return;

				} catch ( _ ) {}

			}

		}

		return createDefaultTexture.call( this, texture );

	};

	textureUtilsPrototype.createTexture = function ( texture, options = {} ) {

		if (
			texture &&
			texture.isRenderTargetTexture !== true &&
			( texture.isData3DTexture === true || texture.is3DTexture === true )
		) {

			const usage = typeof globalThis !== 'undefined' ? globalThis.GPUTextureUsage : null;
			const format = default3DTextureFormat( texture );
			const image = texture.image || {};
			const width = options.width || image.width || 1;
			const height = options.height || image.height || 1;
			const depth = options.depth || image.depth || image.depthOrArrayLayers || 1;
			const levels = options.levels || 1;
			if ( usage && format && this.backend && this.backend.device ) {

				const textureData = this.backend.get( texture );
				if ( textureData.initialized ) throw new Error( 'WebGPUTextureUtils: Texture already initialized.' );
				const descriptor = {
					label: texture.name,
					size: { width, height, depthOrArrayLayers: depth },
					mipLevelCount: levels,
					sampleCount: 1,
					dimension: '3d',
					format,
					usage: usage.TEXTURE_BINDING | usage.COPY_DST | usage.COPY_SRC | ( texture.isStorageTexture === true ? usage.STORAGE_BINDING : 0 ),
				};

				try {

					textureData.format = format;
					textureData.texture = this.backend.device.createTexture( descriptor );
					textureData.initialized = true;
					textureData.textureDescriptorGPU = descriptor;
					return;

				} catch ( _ ) {}

			}

		}

		return createTexture.call( this, texture, options );

	};

	textureUtilsPrototype.updateTexture = function ( texture, options = {} ) {

		if (
			texture &&
			texture.isRenderTargetTexture !== true &&
			( texture.isData3DTexture === true || texture.is3DTexture === true ) &&
			texture.flipY !== true
		) {

			const image = options.image || texture.image || null;
			const data = image && image.data || null;
			const textureData = this.backend && this.backend.get( texture );
			const descriptor = textureData && textureData.textureDescriptorGPU;
			const textureGPU = textureData && textureData.texture;
			if ( image && data && descriptor && textureGPU && this.backend.device ) {

				try {

					const bytesPerTexel = this._getBytesPerTexel( descriptor.format );
					const sourceBytesPerRow = image.width * bytesPerTexel;
					const bytesPerRow = Math.ceil( sourceBytesPerRow / 256 ) * 256;
					const source = new Uint8Array( data.buffer, data.byteOffset, data.byteLength );
					let upload = source;

					if ( bytesPerRow !== sourceBytesPerRow ) {

						upload = new Uint8Array( bytesPerRow * image.height * image.depth );
						for ( let z = 0; z < image.depth; z ++ ) {

							for ( let y = 0; y < image.height; y ++ ) {

								const srcOffset = ( z * image.height + y ) * sourceBytesPerRow;
								const dstOffset = ( z * image.height + y ) * bytesPerRow;
								upload.set( source.subarray( srcOffset, srcOffset + sourceBytesPerRow ), dstOffset );

							}

						}

					}

					this.backend.device.queue.writeTexture(
						{ texture: textureGPU, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
						upload,
						{ offset: 0, bytesPerRow, rowsPerImage: image.height },
						{ width: image.width, height: image.height, depthOrArrayLayers: image.depth }
					);
					return;

				} catch ( _ ) {}

			}

		}

		return updateTexture.call( this, texture, options );

	};

}
