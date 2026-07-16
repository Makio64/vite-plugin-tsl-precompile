import test from 'node:test';
import assert from 'node:assert/strict';

import { attachPostprocessObject3DTargets, attachPostprocessTextureRefs, attachPostprocessUpdateBeforeNodes } from '../src/aux-loader.js';

function makeArtifact() {

	return {
		uniformPlan: [ {
			textures: [
				{ source: { kind: 'artifact.texture', textureUuid: 'captured-output', textureName: 'output' } },
				{ source: { kind: 'artifact.texture', textureUuid: 'captured-normal', textureName: 'normal' } },
				{ source: { kind: 'artifact.texture', textureUuid: 'captured-ao', textureName: 'GTAONode.AO' } },
			],
		} ],
	};

}

test( 'attachPostprocessTextureRefs binds PassNode and effect render-target textures by name', () => {

	const outputTexture = { isTexture: true, name: 'output', uuid: 'live-output' };
	const normalTexture = { isTexture: true, name: 'normal', uuid: 'live-normal' };
	const aoTexture = { isTexture: true, name: 'GTAONode.AO', uuid: 'live-ao' };
	const outputNode = {
		pass: {
			isPassNode: true,
			_textures: { output: outputTexture, normal: normalTexture },
			renderTarget: { textures: [ outputTexture, normalTexture ] },
		},
		gtao: {
			_aoRenderTarget: { isRenderTarget: true, texture: aoTexture },
		},
	};
	const artifact = attachPostprocessTextureRefs( makeArtifact(), outputNode );

	assert.ok( artifact._textureRefs instanceof Map );
	assert.equal( artifact._textureRefs.get( 'captured-output' ), outputTexture );
	assert.equal( artifact._textureRefs.get( 'captured-normal' ), normalTexture );
	assert.equal( artifact._textureRefs.get( 'captured-ao' ), aoTexture );

} );

test( 'attachPostprocessTextureRefs updates PassTextureNode values before matching', () => {

	const liveTexture = { isTexture: true, name: 'output', uuid: 'live-output' };
	const passNode = {
		getTexture( name ) {

			assert.equal( name, 'output' );
			return liveTexture;

		},
	};
	const textureNode = {
		isPassTextureNode: true,
		textureName: 'output',
		passNode,
		value: null,
		updateTexture() { this.value = passNode.getTexture( 'output' ); },
	};
	const artifact = attachPostprocessTextureRefs( makeArtifact(), textureNode );

	assert.equal( artifact._textureRefs.get( 'captured-output' ), liveTexture );

} );

test( 'attachPostprocessTextureRefs binds material-graph pass depth without touching light shadows', () => {

	const depthTexture = { isTexture: true, isDepthTexture: true, name: 'depth', uuid: 'live-depth' };
	const passDepthSource = {
		kind: 'depth.texture',
		textureUuid: 'captured-pass-depth',
		fromMaterialGraph: true,
		lightIndex: - 1,
		lightUuid: null,
	};
	const lightDepthSource = {
		kind: 'depth.texture',
		textureUuid: 'captured-shadow-depth',
		fromMaterialGraph: true,
		lightIndex: 0,
		lightUuid: 'light-0',
	};
	const artifact = {
		uniformPlan: [ {
			textures: [
				{ name: 'passDepth', source: passDepthSource },
				{ name: 'shadowDepth', source: lightDepthSource },
			],
		} ],
	};

	attachPostprocessTextureRefs( artifact, {
		isPassNode: true,
		_textures: { depth: depthTexture },
		renderTarget: { depthTexture },
	} );

	assert.equal( artifact._textureRefs.get( 'captured-pass-depth' ), depthTexture );
	assert.equal( artifact._textureRefs.has( 'captured-shadow-depth' ), false );
	assert.equal( passDepthSource.kind, 'depth.texture' );
	assert.equal( lightDepthSource.kind, 'depth.texture' );

} );

test( 'attachPostprocessUpdateBeforeNodes wires pass and in-process effect nodes', () => {

	const passNode = {
		isPassNode: true,
		updateBefore() {},
	};
	const bloomNode = {
		constructor: { type: 'BloomNode' },
		updateBefore() {},
	};
	const outlineNode = {
		constructor: { type: 'OutlineNode' },
		updateBefore() {},
	};
	const artifact = attachPostprocessUpdateBeforeNodes( {
		_liveUpdateBeforeNodes: [ passNode ],
		uniformPlan: [],
	}, {
		passNode,
		nested: { bloomNode, outlineNode },
	} );

	assert.deepEqual( artifact._liveUpdateBeforeNodes, [ passNode, bloomNode ] );

} );

test( 'attachPostprocessObject3DTargets binds a PassNode camera to the material', () => {

	const camera = { name: 'pass-camera' };
	const material = { __tslpObject3DTargets: { previous: true } };
	const outputNode = {
		nested: {
			passNode: {
				isPassNode: true,
				camera,
				constructor: { type: 'PassNode' },
			},
		},
	};
	const result = attachPostprocessObject3DTargets( material, outputNode );

	assert.equal( result, material );
	assert.equal( material.__tslpObject3DTargets.camera, camera );
	assert.equal( material.__tslpObject3DTargets.previous, true );
	assert.equal( Object.getOwnPropertyDescriptor( material, '__tslpObject3DTargets' ).enumerable, false );

} );

test( 'attachPostprocessObject3DTargets skips RetroPassNode cameras', () => {

	const material = {};
	attachPostprocessObject3DTargets( material, {
		isPassNode: true,
		camera: { name: 'retro-camera' },
		constructor: { type: 'RetroPassNode' },
	} );

	assert.equal( material.__tslpObject3DTargets, undefined );

} );
