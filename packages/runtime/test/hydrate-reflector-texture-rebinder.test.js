import test from 'node:test';
import assert from 'node:assert/strict';

import { LinearMipmapLinearFilter } from 'three/src/constants.js';

import {
	collectMaterialReflectorBaseNodes,
	createReflectorTextureRebinder,
	findReflectorBaseNodeInMaterial,
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

test( 'reflector texture rebinder applies captured render-target settings', () => {

	const fallbackTexture = { uuid: 'fallback' };
	const liveTexture = { uuid: 'mirror', generateMipmaps: false, minFilter: 1006, needsUpdate: false };
	const binding = createBinding( fallbackTexture );
	const camera = { id: 'camera' };
	const baseNode = {
		generateMipmaps: false,
		resolutionScale: 1,
		samples: 0,
		bounces: true,
		depth: false,
		renderTargets: new Map( [ [ camera, { texture: liveTexture } ] ] ),
	};
	const rebinder = createReflectorTextureRebinder( [ {
		binding,
		baseNode,
		source: { generateMipmaps: true, resolutionScale: 0.5, samples: 4, bounces: false, depth: true },
	} ] );

	assert.equal( baseNode.generateMipmaps, true );
	assert.equal( baseNode.resolutionScale, 0.5 );
	assert.equal( baseNode.samples, 4 );
	assert.equal( baseNode.bounces, false );
	assert.equal( baseNode.depth, true );

	rebinder.updateBefore( { camera } );

	assert.equal( binding.texture, liveTexture );
	assert.equal( liveTexture.generateMipmaps, true );
	assert.equal( liveTexture.minFilter, LinearMipmapLinearFilter );
	assert.equal( liveTexture.needsUpdate, true );

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

test( 'reflector material helpers prefer stashed base nodes and reflector index', () => {

	const first = {
		constructor: { type: 'ReflectorBaseNode' },
		renderTargets: new Map(),
		updateBefore() {},
	};
	const second = {
		constructor: { type: 'ReflectorBaseNode' },
		renderTargets: new Map(),
		updateBefore() {},
	};
	const invalid = {
		constructor: { type: 'ReflectorBaseNode' },
		renderTargets: new Map(),
	};
	const material = {
		__tslpReflectorBaseNodes: [ first, invalid, second, first ],
	};

	assert.deepEqual( collectMaterialReflectorBaseNodes( material ), [ first, second ] );
	assert.equal( findReflectorBaseNodeInMaterial( material, 1 ), second );
	assert.equal( findReflectorBaseNodeInMaterial( material, - 1 ), first );

} );
