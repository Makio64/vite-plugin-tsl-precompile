import { createStorageBufferBinding } from './storage-buffer.js';
import { createSampledTextureBinding, createSamplerBinding } from './texture-bindings.js';
import { createUniformBufferBinding } from './uniform-buffer.js';

const RUNTIME_BINDING_KIND_ALLOCATORS = Object.freeze( {
	'uniform-buffer': createUniformBufferRuntimeBinding,
	'sampled-texture': createSampledTextureRuntimeBinding,
	'sampler': createSamplerRuntimeBinding,
	'storage-buffer': createStorageBufferRuntimeBinding,
} );

export const RUNTIME_BINDING_KIND_NAMES = Object.freeze( Object.keys( RUNTIME_BINDING_KIND_ALLOCATORS ) );

export function createRuntimeBindingFromKind( {
	artifact,
	group,
	descriptor,
	material,
	groupNode = null,
	deps,
} ) {

	const allocator = descriptor && RUNTIME_BINDING_KIND_ALLOCATORS[ descriptor.kind ];
	if ( ! allocator ) return null;

	const groupName = group && group.name || '';
	const name = descriptor.name || groupName;
	return allocator( { artifact, group, groupName, descriptor, name, material, groupNode, deps } );

}

function createUniformBufferRuntimeBinding( { artifact, group, groupName, descriptor, name, material, groupNode, deps } ) {

	return createUniformBufferBinding( {
		artifact,
		group,
		groupName,
		descriptor,
		name,
		material,
		groupNode,
		deps: {
			attachLiveUniformBufferUpdater: deps.attachLiveUniformBufferUpdater,
			createLiveUniformArrayResolver: deps.createLiveUniformArrayResolver,
			findUniformGroupByteLength: deps.findUniformGroupByteLength,
			findUniformGroupRequiredByteLength: deps.findUniformGroupRequiredByteLength,
			resolvePlanBufferUniform: deps.resolvePlanBufferUniform,
			seedUniformBufferSnapshots: deps.seedUniformBufferSnapshots,
		},
	} );

}

function createSampledTextureRuntimeBinding( { artifact, groupName, descriptor, name, material, groupNode, deps } ) {

	const texture = deps.resolveTextureBinding( artifact, groupName, descriptor.name, material );
	const textureType = descriptor.textureType || deps.inferTextureTypeFromShader( artifact, descriptor.name );
	return createSampledTextureBinding( {
		name,
		texture,
		textureType,
		visibility: descriptor.visibility,
		groupNode,
	} );

}

function createSamplerRuntimeBinding( { artifact, groupName, descriptor, name, material, groupNode, deps } ) {

	const texture = deps.resolveTextureBinding( artifact, groupName, descriptor.name, material );
	return createSamplerBinding( {
		name,
		texture,
		visibility: descriptor.visibility,
		groupNode,
	} );

}

function createStorageBufferRuntimeBinding( { artifact, groupName, descriptor, name, groupNode, deps } ) {

	return createStorageBufferBinding( {
		artifact,
		groupName,
		descriptor,
		name,
		groupNode,
		deps: {
			resolvePlanStorageBuffer: deps.resolvePlanStorageBuffer,
		},
	} );

}
