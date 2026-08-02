import Sampler from 'three/src/renderers/common/Sampler.js';
import { SampledTexture, SampledCubeTexture, Sampled3DTexture, SampledArrayTexture } from 'three/src/renderers/common/SampledTexture.js';

// WebGPUTextureUtils and WebGPUBindingUtils in Three r185 only test whether
// TextureNode.compareNode is null. The precompiled runtime intentionally does
// not retain the authored node graph, so a stable marker carries the captured
// comparison intent without changing the Sampler's direct texture ownership.
const COMPARISON_NODE_MARKER = Object.freeze( { isNode: true } );

export function createSampledTextureBinding( {
	name,
	texture,
	textureType,
	visibility = 0,
	store = false,
	access = null,
	mipLevel = 0,
	groupNode = null,
} ) {

	let binding;
	if ( textureType === 'cube' ) binding = new SampledCubeTexture( name, texture );
	else if ( textureType === '3d' ) {

		binding = new Sampled3DTexture( name, texture );
		binding.isSampledTexture3D = true;

	}
	else if ( textureType === '2d-array' ) binding = new SampledArrayTexture( name, texture );
	else binding = new SampledTexture( name, texture );
	binding.store = store === true;
	binding.access = access;
	binding.mipLevel = Number.isSafeInteger( mipLevel ) && mipLevel >= 0 ? mipLevel : 0;
	return prepareTextureBinding( binding, visibility, groupNode );

}

export function createSamplerBinding( {
	name,
	texture,
	comparison = false,
	visibility = 0,
	groupNode = null,
} ) {

	const binding = new Sampler( name, texture );
	binding.textureNode = {
		compareNode: comparison === true ? COMPARISON_NODE_MARKER : null,
	};
	return prepareTextureBinding( binding, visibility, groupNode );

}

function prepareTextureBinding( binding, visibility, groupNode ) {

	binding.visibility = visibility | 0;
	binding.groupNode = groupNode;
	installRebindableTextureBindingClone( binding );
	return binding;

}

export function installRebindableTextureBindingClone( binding ) {

	if ( ! binding || binding.__tslpRebindableClonePatched === true || typeof binding.clone !== 'function' ) return binding;
	if ( binding.isSampledTexture !== true && binding.isSampler !== true ) return binding;

	const originalClone = binding.clone;
	const clones = new Set();
	Object.defineProperty( binding, '__tslpRebindClones', {
		value: clones,
		configurable: true,
	} );
	Object.defineProperty( binding, '__tslpRebindableClonePatched', {
		value: true,
		configurable: true,
	} );
	binding.clone = function cloneRebindableTextureBinding() {

		const cloned = originalClone.call( this );
		clones.add( cloned );
		Object.defineProperty( cloned, '__tslpRebindSource', {
			value: binding,
			configurable: true,
		} );
		return cloned;

	};
	return binding;

}
