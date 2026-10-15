import test from 'node:test';
import assert from 'node:assert/strict';
import { DataTexture, DepthTexture, LessEqualCompare } from 'three';
import WebGPUTextureUtils from 'three/src/renderers/webgpu/utils/WebGPUTextureUtils.js';
import WebGPUBindingUtils from 'three/src/renderers/webgpu/utils/WebGPUBindingUtils.js';

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
	assert.equal( binding.textureNode.isSampleCompare(), true );
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

test( 'texture binding kind preserves regular sampler intent for native and legacy renderers', () => {

	const binding = createSamplerBinding( {
		name: 'nodeSampler0',
		texture: new DataTexture(),
	} );

	assert.ok( binding.textureNode );
	assert.equal( binding.textureNode.compareNode, null );
	assert.equal( binding.textureNode.isSampleCompare(), false );

} );

test( 'native WebGPU sampler creation and bind-group layouts execute captured comparison intent', () => {

	for ( const { comparison, compatible, expectedType } of [
		{ comparison: false, compatible: true, expectedType: 'non-filtering' },
		{ comparison: true, compatible: true, expectedType: 'comparison' },
		{ comparison: true, compatible: false, expectedType: 'non-filtering' },
	] ) {

		const records = new WeakMap();
		const samplers = [];
		const backend = {
			hasCompatibility: () => compatible,
			get( binding ) {

				if ( ! records.has( binding ) ) records.set( binding, {} );
				return records.get( binding );

			},
			device: { createSampler( descriptor ) {

				const snapshot = { ...descriptor };
				samplers.push( snapshot );
				return snapshot;

			} },
		};
		const texture = new DepthTexture( 4, 4 );
		texture.compareFunction = LessEqualCompare;
		const binding = createSamplerBinding( { name: 'shadowSampler', texture, comparison, visibility: 2 } );
		const textureUtils = new WebGPUTextureUtils( backend );
		const bindingUtils = new WebGPUBindingUtils( backend );
		textureUtils.updateSampler( binding );
		const entries = bindingUtils._createLayoutEntries( { bindings: [ binding ] } );
		assert.equal( samplers.length, 1 );
		assert.equal( samplers[ 0 ].compare, expectedType === 'comparison' ? 'less-equal' : undefined );
		assert.equal( entries[ 0 ].sampler.type, expectedType );
		assert.equal( binding.clone().textureNode.isSampleCompare(), comparison );
		textureUtils.dispose();
		bindingUtils.dispose();
		texture.dispose();

	}

} );

for ( const createBinding of [ createSamplerBinding, createSampledTextureBinding ] ) {

	test( `${createBinding.name} restores released render-target owners at binding update`, () => {

		const texture = new DataTexture();
		const binding = createBinding( { name: 'output', texture } );
		const clone = binding.clone();
		for ( const target of [ binding, clone ] ) {

			target.update();
			// Textures._destroyTexture releases and resets all users when a
			// render target resizes, potentially after update-before rebinding.
			target.release();
			target.reset();
			assert.equal( target.texture, null );
			assert.equal( target.update(), true );
			assert.equal( target.texture, texture );
			assert.equal( target.update(), false );

		}
		const replacement = new DataTexture();
		clone.release();
		rebindTextureBindingTargets( binding, replacement );
		clone.update();
		assert.equal( clone.texture, replacement, 'a live rebind wins over the released owner' );
		assert.equal( clone.__tslpReleasedTexture, null );

	} );

}
