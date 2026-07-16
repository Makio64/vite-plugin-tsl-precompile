import { MATERIAL_TEXTURE_PROPS } from './texture-props.js';
import { isRenderBindingOwnerKind } from './render-selector.js';

const UNSAFE_NODE_PATH_SEGMENTS = new Set( [ '__proto__', 'prototype', 'constructor' ] );

export const LIVE_UNIFORM_CALLSITE_IDENTITY_SCHEMA = 'uniform-callsite@1';
export const LIVE_UNIFORM_NODE_IDENTITY_SYMBOL_KEY = '@tsl-precompile/runtime/live-uniform-node-identity@1';

export function createLiveUniformCallsiteIdentity( moduleIdentity, callIndex ) {

	if ( typeof moduleIdentity !== 'string' || moduleIdentity.length === 0 || /[\r\n#]/.test( moduleIdentity ) ) return null;
	if ( ! Number.isInteger( callIndex ) || callIndex < 0 ) return null;
	return `${ LIVE_UNIFORM_CALLSITE_IDENTITY_SCHEMA }#${ moduleIdentity }#${ callIndex }`;

}

export function createLiveUniformNodeIdentity( callsiteIdentity, occurrence ) {

	if ( ! isLiveUniformCallsiteIdentity( callsiteIdentity ) ) return null;
	if ( ! Number.isInteger( occurrence ) || occurrence < 0 ) return null;
	return `${ callsiteIdentity }#${ occurrence }`;

}

export function isLiveUniformCallsiteIdentity( identity ) {

	if ( typeof identity !== 'string' || identity.length === 0 || /[\r\n]/.test( identity ) ) return false;
	const parts = identity.split( '#' );
	if ( parts.length < 3 || parts[ 0 ] !== LIVE_UNIFORM_CALLSITE_IDENTITY_SCHEMA ) return false;
	const callIndex = parts.pop();
	parts.shift();
	return parts.join( '#' ).length > 0 && /^(?:0|[1-9]\d*)$/.test( callIndex );

}

export function isLiveUniformNodeIdentity( identity ) {

	if ( typeof identity !== 'string' ) return false;
	const separator = identity.lastIndexOf( '#' );
	if ( separator <= 0 || separator === identity.length - 1 ) return false;
	const occurrence = identity.slice( separator + 1 );
	return /^(?:0|[1-9]\d*)$/.test( occurrence ) && isLiveUniformCallsiteIdentity( identity.slice( 0, separator ) );

}

export const DYNAMIC_BINDING_TARGET = Object.freeze( {
	UNIFORM_SLOT: 'uniform-slot',
	SAMPLED_TEXTURE: 'sampled-texture',
	STORAGE_TEXTURE: 'storage-texture',
	STORAGE_BUFFER: 'storage-buffer',
	SAMPLER: 'sampler',
} );

export const DYNAMIC_BINDING_PHASE = Object.freeze( {
	CODEGEN_UPDATE: 'codegen-update',
	HYDRATE: 'hydrate',
	UPDATE_BEFORE: 'update-before',
	LATE_REBIND: 'late-rebind',
} );

// Capture-time spelling for the live reference returned by a viewport node's
// updateReference(). The token is ephemeral, but equality is meaningful:
// Three's NodeFrame uses that same reference to deduplicate framebuffer copies.
export const VIEWPORT_TEXTURE_IDENTITY_SCHEMA = 'viewport-reference@1';

export function createViewportTextureIdentity( captureReference ) {

	if ( typeof captureReference !== 'string' || captureReference.length === 0 || /[\s#]/.test( captureReference ) ) return null;
	return `${ VIEWPORT_TEXTURE_IDENTITY_SCHEMA }#${ captureReference }`;

}

export function isViewportTextureIdentity( identity ) {

	if ( typeof identity !== 'string' ) return false;
	const separator = identity.indexOf( '#' );
	if ( separator <= 0 || separator === identity.length - 1 ) return false;
	const schema = identity.slice( 0, separator );
	const captureReference = identity.slice( separator + 1 );
	return schema === VIEWPORT_TEXTURE_IDENTITY_SCHEMA && ! /[\s#]/.test( captureReference );

}

function freezeDescriptor( descriptor ) {

	return Object.freeze( {
		...descriptor,
		required: Object.freeze( [ ...descriptor.required || [] ] ),
		optional: Object.freeze( [ ...descriptor.optional || [] ] ),
	} );

}

function textureDescriptor( kind, property ) {

	return freezeDescriptor( {
		kind,
		target: DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE,
		phase: DYNAMIC_BINDING_PHASE.LATE_REBIND,
		owner: 'material',
		resolver: 'hydrator/material-texture',
		required: [ 'property' ],
		optional: [ 'bindingOwner', 'textureUuid', 'textureName', 'imageSrc', 'snapshot', 'matrix' ],
		property,
	} );

}

function materialMatrixDescriptor( kind, property ) {

	return freezeDescriptor( {
		kind,
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'material',
		resolver: 'emit-updater/material-texture-matrix',
		required: [ 'property' ],
		optional: [ 'bindingOwner', 'valueSnapshot' ],
		property,
	} );

}

const exactDescriptors = {
	'uniform.live': freezeDescriptor( {
		kind: 'uniform.live',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.UPDATE_BEFORE,
		owner: 'material',
		resolver: 'hydrator/live-node',
		required: [],
		optional: [ 'bindingOwner', 'name', 'property', 'nodePath', 'liveNodeId', 'liveNodeIdentity', 'valueType', 'valueSnapshot' ],
	} ),
	'object3d.nodeUniform': freezeDescriptor( {
		kind: 'object3d.nodeUniform',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'object3d',
		resolver: 'emit-updater/object-node-uniform',
		required: [ 'property' ],
		optional: [ 'uniformType', 'valueType', 'valueSnapshot' ],
	} ),
	'object3d.userData': freezeDescriptor( {
		kind: 'object3d.userData',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.UPDATE_BEFORE,
		owner: 'object3d',
		resolver: 'hydrator/object-user-data',
		required: [ 'property' ],
		optional: [ 'uniformType', 'valueSnapshot' ],
	} ),
	'artifact.texture': freezeDescriptor( {
		kind: 'artifact.texture',
		target: DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE,
		phase: DYNAMIC_BINDING_PHASE.LATE_REBIND,
		owner: 'artifact',
		resolver: 'hydrator/artifact-texture',
		required: [],
		optional: [ 'textureUuid', 'textureName', 'imageSrc', 'snapshot', 'mapping', 'textureType', 'textureDimension', 'generateMipmaps', 'colorSpace', 'flipY', 'imageWidth', 'imageHeight', 'imageDepth' ],
	} ),
	'depth.texture': freezeDescriptor( {
		kind: 'depth.texture',
		target: DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE,
		phase: DYNAMIC_BINDING_PHASE.UPDATE_BEFORE,
		owner: 'light-or-material-graph',
		resolver: 'hydrator/shadow-depth-rebinder',
		required: [],
		optional: [ 'lightIdentity', 'lightIndex', 'lightUuid', 'textureUuid', 'fromMaterialGraph', 'vsm' ],
	} ),
	'viewport.texture': freezeDescriptor( {
		kind: 'viewport.texture',
		target: DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE,
		phase: DYNAMIC_BINDING_PHASE.UPDATE_BEFORE,
		owner: 'renderer',
		resolver: 'hydrator/viewport-texture-rebinder',
		required: [],
		optional: [ 'viewportIdentity', 'generateMipmaps', 'isDepth', 'shared', 'textureType', 'textureDimension' ],
	} ),
	'reflector.texture': freezeDescriptor( {
		kind: 'reflector.texture',
		target: DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE,
		phase: DYNAMIC_BINDING_PHASE.UPDATE_BEFORE,
		owner: 'reflector',
		resolver: 'hydrator/reflector-texture-rebinder',
		required: [],
		optional: [ 'reflectorIndex', 'textureUuid', 'generateMipmaps', 'resolutionScale', 'samples', 'bounces', 'depth' ],
	} ),
	'builtin.dfgLUT': freezeDescriptor( {
		kind: 'builtin.dfgLUT',
		target: DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE,
		phase: DYNAMIC_BINDING_PHASE.HYDRATE,
		owner: 'runtime',
		resolver: 'hydrator/dfg-lut',
		required: [],
		optional: [],
	} ),
	'builtin.ltcTexture': freezeDescriptor( {
		kind: 'builtin.ltcTexture',
		target: DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE,
		phase: DYNAMIC_BINDING_PHASE.HYDRATE,
		owner: 'runtime',
		resolver: 'hydrator/ltc-texture',
		required: [ 'ltcIndex' ],
		optional: [ 'magFilter', 'minFilter', 'wrapS', 'wrapT' ],
	} ),
	// Named StorageBufferNodes retain their authored name as a stable identity;
	// the backend-facing binding name is generated and cannot relink a freshly
	// created application graph.
	'storage.buffer': freezeDescriptor( {
		kind: 'storage.buffer',
		target: DYNAMIC_BINDING_TARGET.STORAGE_BUFFER,
		phase: DYNAMIC_BINDING_PHASE.UPDATE_BEFORE,
		owner: 'compute',
		resolver: 'hydrator/storage-buffer',
		required: [],
		optional: [ 'itemSize', 'count', 'usage', 'attributeName', 'elementType', 'computeNodeUuid', 'snapshot' ],
	} ),
};

for ( const prop of MATERIAL_TEXTURE_PROPS ) {

	exactDescriptors[ `material.${ prop }` ] = textureDescriptor( `material.${ prop }`, prop );
	exactDescriptors[ `material.${ prop }.matrix` ] = materialMatrixDescriptor( `material.${ prop }.matrix`, prop );

}

export const DYNAMIC_BINDING_DESCRIPTORS = Object.freeze( exactDescriptors );

const PREFIX_DESCRIPTORS = Object.freeze( [
	freezeDescriptor( {
		prefix: 'camera.',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'camera',
		resolver: 'emit-updater/camera',
		required: [],
		optional: [ 'valueSnapshot' ],
	} ),
	freezeDescriptor( {
		prefix: 'object.',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'object',
		resolver: 'emit-updater/object',
		required: [],
		optional: [ 'valueSnapshot' ],
	} ),
	freezeDescriptor( {
		prefix: 'object3d.',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.UPDATE_BEFORE,
		owner: 'object3d',
		resolver: 'emit-updater-or-hydrator/object3d',
		required: [],
		optional: [ 'property', 'target', 'uniformType', 'valueSnapshot' ],
	} ),
	freezeDescriptor( {
		prefix: 'frame.',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'frame',
		resolver: 'emit-updater/frame',
		required: [],
		optional: [ 'valueSnapshot' ],
	} ),
	freezeDescriptor( {
		prefix: 'renderer.',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'renderer',
		resolver: 'emit-updater/renderer',
		required: [],
		optional: [ 'valueSnapshot' ],
	} ),
	freezeDescriptor( {
		prefix: 'scene.',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'scene',
		resolver: 'emit-updater/scene',
		required: [],
		optional: [ 'valueSnapshot' ],
	} ),
	freezeDescriptor( {
		prefix: 'light.',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.UPDATE_BEFORE,
		owner: 'light',
		resolver: 'emit-updater/light',
		required: [],
		optional: [ 'lightIdentity', 'lightIndex', 'lightUuid', 'property', 'valueSnapshot' ],
	} ),
	freezeDescriptor( {
		prefix: 'material.',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'material',
		resolver: 'emit-updater/material',
		required: [ 'property' ],
		optional: [ 'bindingOwner', 'valueSnapshot' ],
	} ),
] );

export function dynamicBindingDescriptor( kind ) {

	if ( typeof kind !== 'string' || kind.length === 0 ) return null;
	if ( Object.prototype.hasOwnProperty.call( DYNAMIC_BINDING_DESCRIPTORS, kind ) ) return DYNAMIC_BINDING_DESCRIPTORS[ kind ];
	for ( const descriptor of PREFIX_DESCRIPTORS ) {

		if ( kind.startsWith( descriptor.prefix ) ) return freezeDescriptor( { ...descriptor, kind } );

	}
	return null;

}

export function isDynamicBindingKind( kind ) {

	return dynamicBindingDescriptor( kind ) !== null;

}

export function validateDynamicBindingSource( source ) {

	const kind = source && source.kind;
	const descriptor = dynamicBindingDescriptor( kind );
	const errors = [];
	if ( source && source.bindingOwner !== undefined && ! isRenderBindingOwnerKind( source.bindingOwner ) ) {

		errors.push( {
			code: 'dynamic-binding.binding-owner',
			kind,
			field: 'bindingOwner',
			message: `${ kind } source "bindingOwner" must be a known render binding owner`,
		} );

	} else if ( source && source.bindingOwner !== undefined && descriptor && descriptor.owner !== 'material' ) {

		errors.push( {
			code: 'dynamic-binding.binding-owner-target',
			kind,
			field: 'bindingOwner',
			message: `${ kind } source "bindingOwner" is only valid for material-owned bindings`,
		} );

	}
	if ( ! descriptor ) return errors;
	for ( const field of descriptor.required ) {

		if ( source[ field ] === undefined || source[ field ] === null || source[ field ] === '' ) {

			errors.push( {
				code: 'dynamic-binding.required',
				kind,
				field,
				message: `${ kind } source is missing required field "${ field }"`,
			} );

		}

	}
	if ( kind === 'uniform.live' && source.nodePath !== undefined ) {

		const validPath = Array.isArray( source.nodePath )
			&& source.nodePath.length > 0
			&& source.nodePath.every( ( segment ) => typeof segment === 'string' && segment.length > 0 && ! UNSAFE_NODE_PATH_SEGMENTS.has( segment ) );
		if ( ! validPath ) {

			errors.push( {
				code: 'dynamic-binding.node-path',
				kind,
				field: 'nodePath',
				message: `${ kind } source "nodePath" must be a non-empty array of non-empty property names`,
			} );

		}

	}
	if ( kind === 'uniform.live' && source.liveNodeId !== undefined && ( ! Number.isInteger( source.liveNodeId ) || source.liveNodeId < 0 ) ) {

		errors.push( {
			code: 'dynamic-binding.live-node-id',
			kind,
			field: 'liveNodeId',
			message: `${ kind } source "liveNodeId" must be a non-negative integer`,
		} );

	}
	if ( kind === 'uniform.live' && source.liveNodeIdentity !== undefined && isLiveUniformNodeIdentity( source.liveNodeIdentity ) === false ) {

		errors.push( {
			code: 'dynamic-binding.live-node-identity',
			kind,
			field: 'liveNodeIdentity',
			message: `${ kind } source "liveNodeIdentity" must be a stable uniform call-site instance identity`,
		} );

	}
	if ( kind === 'uniform.live' && source.liveNodeIdentity !== undefined && source.liveNodeId === undefined ) {

		errors.push( {
			code: 'dynamic-binding.live-node-identity-owner',
			kind,
			field: 'liveNodeId',
			message: `${ kind } source with "liveNodeIdentity" must also carry its artifact-local "liveNodeId"`,
		} );

	}
	if ( kind === 'viewport.texture' && source.viewportIdentity !== undefined && isViewportTextureIdentity( source.viewportIdentity ) === false ) {

		errors.push( {
			code: 'dynamic-binding.viewport-identity',
			kind,
			field: 'viewportIdentity',
			message: `${ kind } source "viewportIdentity" must be a known viewport copy-source identity`,
		} );

	}
	return errors;

}

/**
 * Walk `artifact.uniformPlan` and emit one descriptor entry per dynamic
 * binding (uniform slot, sampled texture, storage buffer, storage texture,
 * sampler) that
 * carries a `source.kind` in the registry. The output is a stable,
 * serializable view of "which slots need per-frame resolution and from
 * where" — the artifact section consumers like the dynamic-binding
 * resolver read.
 *
 * Each entry: `{ kind, target, phase, owner, resolver, group, binding,
 * source }`. Slots whose `source.kind` is missing or unknown are skipped
 * silently (the codegen build-time gate is responsible for rejecting
 * unknown kinds; this function is a non-throwing reader).
 *
 * Pure function. Idempotent. Does not mutate the artifact.
 *
 * @param {Object} artifact
 * @returns {Array<Object>}
 */
export function collectArtifactDynamicBindings( artifact ) {

	const out = [];
	if ( ! artifact || ! Array.isArray( artifact.uniformPlan ) ) return out;

	for ( const group of artifact.uniformPlan ) {

		const groupName = group && group.name || '';

		for ( const slot of group && group.slots || [] ) {

			const source = slot && slot.source || null;
			const descriptor = source && dynamicBindingDescriptor( source.kind );
			if ( ! descriptor ) continue;
			out.push( {
				kind: source.kind,
				target: descriptor.target,
				phase: descriptor.phase,
				owner: descriptor.owner,
				resolver: descriptor.resolver,
				group: groupName,
				binding: slot.name || null,
				offset: slot.offset ?? slot.byteOffset ?? null,
				source,
			} );

		}

		for ( const textureEntry of group && group.textures || [] ) {

			const source = textureEntry && textureEntry.source || null;
			const descriptor = source && dynamicBindingDescriptor( source.kind );
			if ( ! descriptor ) continue;
			out.push( {
				kind: source.kind,
				target: descriptor.target,
				phase: descriptor.phase,
				owner: descriptor.owner,
				resolver: descriptor.resolver,
				group: groupName,
				binding: textureEntry.name || null,
				textureType: textureEntry.textureType || null,
				source,
			} );

		}

		for ( const storageEntry of group && group.storageBuffers || [] ) {

			const source = storageEntry && storageEntry.source || null;
			const descriptor = source && dynamicBindingDescriptor( source.kind );
			if ( ! descriptor ) continue;
			out.push( {
				kind: source.kind,
				target: descriptor.target,
				phase: descriptor.phase,
				owner: descriptor.owner,
				resolver: descriptor.resolver,
				group: groupName,
				binding: storageEntry.name || null,
				source,
			} );

		}

	}
	return out;

}
