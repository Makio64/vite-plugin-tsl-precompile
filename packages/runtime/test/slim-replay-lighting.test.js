import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';

import ReplayLighting, { ReplayLightsNode } from '../src/slim-replay-lighting.js';
import { LightsNode as CompatibilityLightsNode, Node as CompatibilityNode } from '../src/slim-stubs.js';

test( 'replay and compatibility surfaces expose the same LightsNode class', () => {

	assert.equal( ReplayLightsNode, CompatibilityLightsNode );
	assert.equal( new ReplayLightsNode() instanceof CompatibilityLightsNode, true );
	assert.equal( new ReplayLightsNode() instanceof CompatibilityNode, true );
	assert.equal( new ReplayLighting().getNode( { isQuadMesh: true } ) instanceof CompatibilityNode, true );

} );

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
	assert.equal( lighting.enabled, true );
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

test( 'replay Lighting restores scene lights across nested render lifecycles', () => {

	const lighting = new ReplayLighting();
	const scene = {};
	const node = lighting.getNode( scene );
	const beforeRender = [ { id: 1 } ];
	const outerRender = [ { id: 2 } ];
	const nestedRender = [ { id: 3 } ];

	node.setLights( beforeRender );
	lighting.beginRender( scene );
	node.setLights( outerRender );
	lighting.beginRender( scene );
	node.setLights( nestedRender );

	lighting.finishRender( scene );
	assert.equal( node.getLights(), outerRender );

	lighting.finishRender( scene );
	assert.equal( node.getLights(), beforeRender );

} );

test( 'replay Lighting tree-shakes the broad Node/TSL compatibility module', async () => {

	const build = await rollup( {
		input: fileURLToPath( new URL( '../src/slim-replay-lighting.js', import.meta.url ) ),
		external: ( id ) => id.startsWith( 'three/' ),
	} );

	try {

		const generated = await build.generate( { format: 'es', compact: true } );
		const chunk = generated.output.find( ( item ) => item.type === 'chunk' );
		const modules = Object.keys( chunk.modules );
		assert.equal( modules.some( ( id ) => id.endsWith( '/slim-replay-lights-node.js' ) ), true );
		assert.equal( modules.some( ( id ) => id.endsWith( '/slim-stubs.js' ) ), false );
		assert.equal( modules.some( ( id ) => id.endsWith( '/slim-support/node-dependencies.js' ) ), false );

	} finally {

		await build.close();

	}

} );
