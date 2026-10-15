import assert from 'node:assert/strict';
import test from 'node:test';
import { DirectionalLight } from 'three';
import ShadowNode from 'three/src/nodes/lighting/ShadowNode.js';
import { withFreshShadowCaptureFrame } from '../../src/vendor/capture-shadow-frame.js';

test( 'a repeated capture redraws a Three shadow already painted in the host frame', () => {

	const light = new DirectionalLight();
	const node = new ShadowNode( light );
	node.shadowMap = { depthTexture: { version: 0 } };
	let draws = 0;
	node.updateShadow = () => { draws ++; };
	const frame = { camera: {}, frameId: 12, time: 3.5 };
	const renderer = { _nodes: { nodeFrame: frame } };
	frame.renderer = renderer;
	node.updateBefore( frame );
	light.shadow.needsUpdate = true;
	node.updateBefore( frame );
	assert.equal( draws, 1, "needsUpdate alone cannot bypass Three's frame guard" );
	for ( let i = 0; i < 2; i ++ ) {

		withFreshShadowCaptureFrame( renderer, () => node.updateBefore( frame ) );
		assert.equal( frame.frameId, 12 );
		assert.equal( frame.time, 3.5 );

	}
	assert.equal( draws, 3 );
	assert.throws( () => withFreshShadowCaptureFrame( renderer, () => { throw new Error( 'draw failed' ); } ), /draw failed/ );
	assert.equal( frame.frameId, 12 );

} );
