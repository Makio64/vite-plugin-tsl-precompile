import test from 'node:test';
import assert from 'node:assert/strict';
import { DataTexture } from 'three';

import {
	createSampledTextureBinding,
	createSamplerBinding,
} from '../src/hydrate/kinds/texture-bindings.js';

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
		visibility: 4,
		groupNode,
	} );
	const clone = binding.clone();

	assert.equal( binding.name, 'nodeSampler0' );
	assert.equal( binding.texture, texture );
	assert.equal( binding.visibility, 4 );
	assert.equal( binding.groupNode, groupNode );
	assert.equal( clone.__tslpRebindSource, binding );
	assert.equal( binding.__tslpRebindClones.has( clone ), true );

} );
