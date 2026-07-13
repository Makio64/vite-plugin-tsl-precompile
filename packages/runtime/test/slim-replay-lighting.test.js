import test from 'node:test';
import assert from 'node:assert/strict';

import ReplayLighting, { ReplayLightsNode } from '../src/slim-replay-lighting.js';

test( 'replay LightsNode sorts and exposes the active light state', () => {

	const lights = [
		{ id: 8, castShadow: false },
		{ id: 2, castShadow: true },
		{ id: 5, isSpotLight: true, castShadow: false, map: { id: 12 }, colorNode: { getCacheKey: () => 99 } },
	];
	const node = new ReplayLightsNode().setLights( lights );

	assert.equal( node.isLightsNode, true );
	assert.equal( node.hasLights, true );
	assert.equal( node.getLights(), lights );
	assert.deepEqual( lights.map( ( light ) => light.id ), [ 2, 5, 8 ] );
	assert.equal( typeof node.getCacheKey( true ), 'number' );
	assert.match( node.getHash(), /^slim-lights-node:/ );
	assert.equal( node.applyCustomFiltering().isNode, true );

} );

test( 'replay LightsNode cache key follows shader-topology light inputs', () => {

	const light = { id: 1, isSpotLight: true, castShadow: false, map: null, colorNode: null };
	const node = new ReplayLightsNode().setLights( [ light ] );
	const base = node.getCacheKey();
	light.castShadow = true;
	assert.notEqual( node.getCacheKey(), base );
	const shadow = node.getCacheKey();
	light.map = { id: 7 };
	assert.notEqual( node.getCacheKey(), shadow );

} );

test( 'replay Lighting retains one node per scene and a shared postprocess node', () => {

	const lighting = new ReplayLighting();
	const sceneA = {};
	const sceneB = {};
	assert.equal( lighting.getNode( sceneA ), lighting.getNode( sceneA ) );
	assert.notEqual( lighting.getNode( sceneA ), lighting.getNode( sceneB ) );
	assert.equal( lighting.getNode( { isQuadMesh: true } ), lighting.getNode( { isQuadMesh: true } ) );

	class CustomLighting extends ReplayLighting {

		createNode() {

			const node = super.createNode();
			node.custom = true;
			return node;

		}

	}
	assert.equal( new CustomLighting().getNode( {} ).custom, true );

} );
