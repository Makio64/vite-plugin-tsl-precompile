import test from 'node:test';
import assert from 'node:assert/strict';
import { DataTexture } from 'three';

import {
	createSampledTextureBinding,
	createSamplerBinding,
} from '../src/hydrate/kinds/texture-bindings.js';
import { rebindTextureBindingTargets } from '../src/hydrate/rebinders/texture-binding-targets.js';

test( 'texture binding kind creates sampled texture bindings with metadata and clone tracking', () => {

	const texture = new DataTexture();
	const groupNode = { id: 'group' };
	const binding = createSampledTextureBinding( {
		name: 'nodeTexture0',
		texture,
		textureType: '3d',
		visibility: 2,
		store: true,
		access: 'writeOnly',
		mipLevel: 2,
		groupNode,
	} );
	const clone = binding.clone();

	assert.equal( binding.name, 'nodeTexture0' );
	assert.equal( binding.texture, texture );
	assert.equal( binding.isSampledTexture3D, true );
	assert.equal( binding.visibility, 2 );
	assert.equal( binding.store, true );
	assert.equal( binding.access, 'writeOnly' );
	assert.equal( binding.mipLevel, 2 );
	assert.equal( binding.groupNode, groupNode );
	assert.equal( clone.__tslpRebindSource, binding );
	assert.equal( binding.__tslpRebindClones.has( clone ), true );

} );

test( 'texture binding kind creates sampler bindings with metadata and clone tracking', () => {

	const texture = new DataTexture();
	const groupNode = { id: 'group' };
	const binding = createSamplerBinding( {
		name: 'nodeSampler0',
		texture,
		comparison: true,
		visibility: 4,
		groupNode,
	} );
	const clone = binding.clone();
	const replacement = new DataTexture();

	assert.equal( binding.name, 'nodeSampler0' );
	assert.equal( binding.texture, texture );
	assert.ok( binding.textureNode );
	assert.ok( binding.textureNode.compareNode );
	assert.equal( binding.visibility, 4 );
	assert.equal( binding.groupNode, groupNode );
	assert.equal( clone.__tslpRebindSource, binding );
	assert.equal( binding.__tslpRebindClones.has( clone ), true );
	assert.equal( clone.textureNode, binding.textureNode );
	assert.equal( rebindTextureBindingTargets( binding, replacement ), true );
	assert.equal( binding.texture, replacement );
	assert.equal( clone.texture, replacement );
	assert.ok( binding.textureNode.compareNode, 'dynamic rebinding preserves comparison intent' );

} );

test( 'texture binding kind gives regular samplers the r185 textureNode shape', () => {

	const binding = createSamplerBinding( {
		name: 'nodeSampler0',
		texture: new DataTexture(),
	} );

	assert.ok( binding.textureNode );
	assert.equal( binding.textureNode.compareNode, null );

} );
