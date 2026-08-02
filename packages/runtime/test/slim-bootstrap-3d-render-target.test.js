import test from 'node:test';
import assert from 'node:assert/strict';

import WebGPUTextureUtils from 'three/src/renderers/webgpu/utils/WebGPUTextureUtils.js';

test( 'slim 3D compatibility allocation delegates render-target textures to Three', async () => {

	const prototype = WebGPUTextureUtils.prototype;
	const originalCreateDefaultTexture = prototype.createDefaultTexture;
	const originalCreateTexture = prototype.createTexture;
	const originalUpdateTexture = prototype.updateTexture;
	const previousUsage = globalThis.GPUTextureUsage;
	const delegated = [];
	const renderAttachment = 0x10;
	try {

		prototype.createDefaultTexture = function ( texture ) {

			delegated.push( [ 'default', texture ] );

		};
		prototype.createTexture = function ( texture ) {

			delegated.push( [ 'create', texture ] );
			this.backend.get( texture ).textureDescriptorGPU = {
				usage: globalThis.GPUTextureUsage.RENDER_ATTACHMENT,
			};

		};
		prototype.updateTexture = function ( texture ) {

			delegated.push( [ 'update', texture ] );

		};
		globalThis.GPUTextureUsage = {
			TEXTURE_BINDING: 0x01,
			COPY_DST: 0x02,
			COPY_SRC: 0x04,
			STORAGE_BINDING: 0x08,
			RENDER_ATTACHMENT: renderAttachment,
		};
		await import( `../src/slim-bootstrap.js?render-target-3d=${ Date.now() }` );

		const textureData = new WeakMap();
		const backend = {
			device: {
				createTexture( descriptor ) {

					return { descriptor };

				},
				queue: { writeTexture() {} },
			},
			get( texture ) {

				let data = textureData.get( texture );
				if ( ! data ) {

					data = {};
					textureData.set( texture, data );

				}
				return data;

			},
		};
		const utils = Object.create( prototype );
		utils.backend = backend;
		const renderTarget3DTexture = {
			isData3DTexture: true,
			isRenderTargetTexture: true,
			image: { width: 8, height: 8, depth: 4 },
		};

		utils.createTexture( renderTarget3DTexture );
		utils.updateTexture( renderTarget3DTexture );
		utils.createDefaultTexture( renderTarget3DTexture );

		assert.deepEqual(
			delegated.map( ( entry ) => entry[ 0 ] ),
			[ 'create', 'update', 'default' ],
			'every render-target-owned 3D lifecycle step stays on Three’s allocator',
		);
		assert.equal(
			backend.get( renderTarget3DTexture ).textureDescriptorGPU.usage & renderAttachment,
			renderAttachment,
			'the delegated descriptor retains render-attachment usage',
		);

		const cpuTexture3D = {
			isData3DTexture: true,
			isRenderTargetTexture: false,
			format: 1023,
			type: 1009,
			image: { width: 2, height: 2, depth: 2 },
		};
		utils.createTexture( cpuTexture3D );
		assert.equal( delegated.length, 3, 'ordinary CPU-upload 3D textures keep the slim compatibility allocator' );
		assert.equal( backend.get( cpuTexture3D ).textureDescriptorGPU.dimension, '3d' );

	} finally {

		prototype.createDefaultTexture = originalCreateDefaultTexture;
		prototype.createTexture = originalCreateTexture;
		prototype.updateTexture = originalUpdateTexture;
		if ( previousUsage === undefined ) delete globalThis.GPUTextureUsage;
		else globalThis.GPUTextureUsage = previousUsage;

	}

} );
