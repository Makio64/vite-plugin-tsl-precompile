import test from 'node:test';
import assert from 'node:assert/strict';

import {
	createReflectorTextureRebinder,
	resolveReflectorRenderTarget,
} from '../src/hydrate/rebinders/reflector-texture-rebinder.js';

function createBinding( texture ) {

	return {
		texture,
		groupNode: { version: 0 },
		version: 0,
		generation: 1,
	};

}

test( 'reflector texture rebinder resolves render targets through virtual cameras', () => {

	const camera = { id: 'camera' };
	const virtualCamera = { id: 'virtual-camera' };
	const renderTarget = { texture: { uuid: 'mirror' } };
	const baseNode = {
		renderTargets: new Map( [ [ virtualCamera, renderTarget ] ] ),
		getVirtualCamera: ( receivedCamera ) => {

			assert.equal( receivedCamera, camera );
			return virtualCamera;

		},
	};

	assert.equal( resolveReflectorRenderTarget( baseNode, camera ), renderTarget );

} );

test( 'reflector texture rebinder falls back to any keyed render target', () => {

	const renderTarget = { texture: { uuid: 'mirror' } };
	const baseNode = {
		renderTargets: new Map( [ [ { id: 'other-camera' }, renderTarget ] ] ),
	};

	assert.equal( resolveReflectorRenderTarget( baseNode, { id: 'camera' } ), renderTarget );

} );

test( 'reflector texture rebinder rebinds to the live reflector texture', () => {

	const fallbackTexture = { uuid: 'fallback' };
	const liveTexture = { uuid: 'mirror' };
	const binding = createBinding( fallbackTexture );
	const camera = { id: 'camera' };
	const baseNode = {
		renderTargets: new Map( [ [ camera, { texture: liveTexture } ] ] ),
	};
	const rebinder = createReflectorTextureRebinder( [ { binding, baseNode } ] );

	assert.equal( rebinder.getUpdateBeforeType(), 'render' );
	assert.equal( rebinder.updateReference(), rebinder );

	rebinder.updateBefore( { camera } );

	assert.equal( binding.texture, liveTexture );
	assert.equal( binding.groupNode.version, 1 );
	assert.equal( binding.version, -1 );
	assert.equal( binding.generation, null );

} );

test( 'reflector texture rebinder can use textureNode.value when no render target exists yet', () => {

	const fallbackTexture = { uuid: 'fallback' };
	const liveTexture = { uuid: 'mirror-node-value' };
	const binding = createBinding( fallbackTexture );
	const baseNode = {
		renderTargets: new Map(),
		textureNode: { value: liveTexture },
	};
	const rebinder = createReflectorTextureRebinder( [ { binding, baseNode } ] );

	rebinder.updateBefore( { camera: { id: 'camera' } } );

	assert.equal( binding.texture, liveTexture );

} );
