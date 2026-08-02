import { MATERIAL_TEXTURE_PROPS } from './texture-props.js';
import { isRenderBindingOwnerKind } from './render-selector.js';
import { rendererRenderTargetTextureSelectorValidationError } from './render-target-texture.js';

const UNSAFE_NODE_PATH_SEGMENTS = new Set( [ '__proto__', 'prototype', 'constructor' ] );

export const LIVE_UNIFORM_CALLSITE_IDENTITY_SCHEMA = 'uniform-callsite@1';
export const LIVE_UNIFORM_NODE_IDENTITY_SYMBOL_KEY = '@tsl-precompile/runtime/live-uniform-node-identity@1';
export const STORAGE_BUFFER_SNAPSHOT_HASH_SCHEMA = 'storage-buffer-snapshot@1';

/**
 * Canonical durable spelling for texture image sources captured in a browser.
 *
 * DOM image URLs are exposed as absolute URLs, which would otherwise make an
 * artifact depend on the dev server's host/port. Only URLs proven to share the
 * supplied page origin are rewritten; cross-origin sources remain absolute
 * because their origin is part of resource identity.
 */
export function canonicalTextureImageSource( value, baseHref = currentLocationHref() ) {

	if ( typeof value !== 'string' || value.length === 0 ) return value;
	if ( typeof baseHref !== 'string' || baseHref.length === 0 ) return value;
	try {

		const base = new URL( baseHref );
		if ( base.protocol !== 'http:' && base.protocol !== 'https:' ) return value;
		const resolved = new URL( value, base );
		if (
			( resolved.protocol !== 'http:' && resolved.protocol !== 'https:' )
			|| resolved.username.length > 0
			|| resolved.password.length > 0
			|| resolved.origin !== base.origin
		) return value;
		return `${ resolved.pathname }${ resolved.search }${ resolved.hash }`;

	} catch ( _ ) {

		return value;

	}

}

/**
 * Exact lookup keys for a live/captured texture source in the current page.
 * A live same-origin absolute URL therefore registers both its absolute and
 * durable root-relative spelling.
 */
export function textureImageSourceAliases( value, baseHref = currentLocationHref() ) {

	if ( typeof value !== 'string' || value.length === 0 ) return [];
	const canonical = canonicalTextureImageSource( value, baseHref );
	return canonical === value ? [ value ] : [ value, canonical ];

}

export function textureImageSourcesMatch( left, right, baseHref = currentLocationHref() ) {

	const leftAliases = new Set( textureImageSourceAliases( left, baseHref ) );
	return textureImageSourceAliases( right, baseHref ).some( ( alias ) => leftAliases.has( alias ) );

}

function currentLocationHref() {

	const location = typeof globalThis !== 'undefined' ? globalThis.location : null;
	return location && typeof location.href === 'string' ? location.href : null;

}

const STORAGE_BUFFER_ARRAY_TYPES = Object.freeze( {
	Int8Array: Object.freeze( { bytes: 1, setter: 'setInt8', getter: 'getInt8' } ),
	Uint8Array: Object.freeze( { bytes: 1, setter: 'setUint8', getter: 'getUint8' } ),
	Uint8ClampedArray: Object.freeze( { bytes: 1, setter: 'setUint8', getter: 'getUint8' } ),
	Int16Array: Object.freeze( { bytes: 2, setter: 'setInt16', getter: 'getInt16' } ),
	Uint16Array: Object.freeze( { bytes: 2, setter: 'setUint16', getter: 'getUint16' } ),
	Int32Array: Object.freeze( { bytes: 4, setter: 'setInt32', getter: 'getInt32' } ),
	Uint32Array: Object.freeze( { bytes: 4, setter: 'setUint32', getter: 'getUint32' } ),
	Float32Array: Object.freeze( { bytes: 4, setter: 'setFloat32', getter: 'getFloat32' } ),
	Float64Array: Object.freeze( { bytes: 8, setter: 'setFloat64', getter: 'getFloat64' } ),
} );

function exactStorageBufferSnapshotBytes( entry ) {

	const info = entry && STORAGE_BUFFER_ARRAY_TYPES[ entry.arrayType ];
	const count = entry && entry.count;
	const itemSize = entry && entry.itemSize;
	const snapshot = entry && entry.arraySnapshot;
	if ( ! info
		|| ! Number.isSafeInteger( count ) || count <= 0
		|| ! Number.isSafeInteger( itemSize ) || itemSize <= 0 ) return null;
	const length = count * itemSize;
	if ( ! Number.isSafeInteger( length ) || ! Array.isArray( snapshot ) || snapshot.length !== length ) return null;
	const bytes = new Uint8Array( length * info.bytes );
	const view = new DataView( bytes.buffer );
	for ( let index = 0; index < snapshot.length; index ++ ) {

		const rawValue = snapshot[ index ];
		if ( typeof rawValue !== 'number' || ! Number.isFinite( rawValue ) ) return null;
		// JSON.stringify normalizes negative zero. Hash that durable value at
		// capture too so the persisted snapshot still verifies after parsing.
		const value = Object.is( rawValue, -0 ) ? 0 : rawValue;
		const offset = index * info.bytes;
		view[ info.setter ]( offset, value, true );
		if ( ! Object.is( view[ info.getter ]( offset, true ), value ) ) return null;

	}
	return bytes;

}

function updateStorageBufferSnapshotHash( state, byte ) {

	state[ 0 ] = Math.imul( state[ 0 ] ^ byte, 16777619 ) >>> 0;
	state[ 1 ] = Math.imul( state[ 1 ] ^ byte, 2246822519 ) >>> 0;

}

/**
 * Content identity for a JSON-safe storage-buffer initial-state snapshot.
 *
 * The artifact's outer SHA-256 remains the security/integrity boundary. This
 * compact synchronous digest is an inner typed-byte checksum used to reject a
 * malformed snapshot before hydration and to recognize exact alias records.
 */
export function createStorageBufferSnapshotHash( entry ) {

	const bytes = exactStorageBufferSnapshotBytes( entry );
	if ( ! bytes ) return null;
	const state = [ 2166136261, 0x9e3779b9 ];
	const header = `${ entry.arrayType }\0${ entry.count }\0${ entry.itemSize }\0`;
	for ( let index = 0; index < header.length; index ++ ) updateStorageBufferSnapshotHash( state, header.charCodeAt( index ) & 0xff );
	for ( const byte of bytes ) updateStorageBufferSnapshotHash( state, byte );
	return `${ STORAGE_BUFFER_SNAPSHOT_HASH_SCHEMA }:${ state.map( ( value ) => value.toString( 16 ).padStart( 8, '0' ) ).join( '' ) }`;

}

export function validateStorageBufferSnapshot( entry ) {

	const snapshot = entry && entry.arraySnapshot;
	const hash = entry && entry.arraySnapshotHash;
	if ( snapshot === undefined && hash === undefined ) return [];
	const errors = [];
	if ( snapshot === undefined || hash === undefined ) errors.push( {
		code: 'dynamic-binding.storage-snapshot-pair',
		field: snapshot === undefined ? 'arraySnapshot' : 'arraySnapshotHash',
		message: 'storage-buffer initial state must carry both "arraySnapshot" and "arraySnapshotHash"',
	} );
	const computed = createStorageBufferSnapshotHash( entry );
	if ( snapshot !== undefined && computed === null ) errors.push( {
		code: 'dynamic-binding.storage-snapshot-shape',
		field: 'arraySnapshot',
		message: 'storage-buffer "arraySnapshot" must exactly match its finite typed count × itemSize payload',
	} );
	if ( hash !== undefined && ( typeof hash !== 'string' || ! new RegExp( `^${ STORAGE_BUFFER_SNAPSHOT_HASH_SCHEMA }:[a-f0-9]{16}$` ).test( hash ) ) ) errors.push( {
		code: 'dynamic-binding.storage-snapshot-hash',
		field: 'arraySnapshotHash',
		message: 'storage-buffer "arraySnapshotHash" must be a canonical storage snapshot checksum',
	} );
	else if ( computed !== null && hash !== computed ) errors.push( {
		code: 'dynamic-binding.storage-snapshot-integrity',
		field: 'arraySnapshotHash',
		message: 'storage-buffer "arraySnapshotHash" does not match its typed snapshot bytes',
	} );
	return errors;

}

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

function isExactLiveUniformNodePath( nodePath ) {

	return Array.isArray( nodePath )
		&& nodePath.length > 0
		&& nodePath.every( ( segment ) => typeof segment === 'string' && segment.length > 0 && ! UNSAFE_NODE_PATH_SEGMENTS.has( segment ) );

}

/**
 * Whether a serialized uniform.live source has an exact runtime overlay
 * address. Material-relative node paths resolve directly; closure-only nodes
 * require both their artifact-local ID and stable call-site identity.
 */
export function hasExactLiveUniformOverlayAddress( source ) {

	if ( ! source || source.kind !== 'uniform.live' ) return false;
	if ( isExactLiveUniformNodePath( source.nodePath ) ) return true;
	return Number.isInteger( source.liveNodeId )
		&& source.liveNodeId >= 0
		&& isLiveUniformNodeIdentity( source.liveNodeIdentity );

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
	'environment.intensity': freezeDescriptor( {
		kind: 'environment.intensity',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'material-or-scene',
		resolver: 'emit-updater/environment-intensity',
		required: [],
		optional: [ 'valueSnapshot' ],
	} ),
	'environment.rotation': freezeDescriptor( {
		kind: 'environment.rotation',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'material-or-scene',
		resolver: 'emit-updater/environment-rotation',
		required: [],
		optional: [ 'valueSnapshot' ],
	} ),
	'pmrem.maxMip': freezeDescriptor( {
		kind: 'pmrem.maxMip',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'artifact',
		resolver: 'runtime-writers/pmrem-scalar',
		required: [ 'textureUuid' ],
		optional: [ 'valueSnapshot' ],
	} ),
	'pmrem.texelWidth': freezeDescriptor( {
		kind: 'pmrem.texelWidth',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'artifact',
		resolver: 'runtime-writers/pmrem-scalar',
		required: [ 'textureUuid' ],
		optional: [ 'valueSnapshot' ],
	} ),
	'pmrem.texelHeight': freezeDescriptor( {
		kind: 'pmrem.texelHeight',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'artifact',
		resolver: 'runtime-writers/pmrem-scalar',
		required: [ 'textureUuid' ],
		optional: [ 'valueSnapshot' ],
	} ),
	'texture.uvFlipY': freezeDescriptor( {
		kind: 'texture.uvFlipY',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'artifact',
		resolver: 'runtime-writers/texture-uv-flip',
		required: [ 'textureUuid' ],
		optional: [
			'textureName',
			'imageSrc',
			'mapping',
			'wrapS',
			'wrapT',
			'magFilter',
			'minFilter',
			'anisotropy',
			'generateMipmaps',
			'colorSpace',
			'flipY',
			'imageWidth',
			'imageHeight',
			'imageDepth',
			'valueSnapshot',
		],
	} ),
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
		optional: [ 'textureUuid', 'textureName', 'imageSrc', 'snapshot', 'mapping', 'textureType', 'textureDimension', 'generateMipmaps', 'colorSpace', 'flipY', 'imageWidth', 'imageHeight', 'imageDepth', 'renderTargetSelector' ],
	} ),
	'depth.texture': freezeDescriptor( {
		kind: 'depth.texture',
		target: DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE,
		phase: DYNAMIC_BINDING_PHASE.UPDATE_BEFORE,
		owner: 'light-or-material-graph',
		resolver: 'hydrator/shadow-depth-rebinder',
		required: [],
		optional: [ 'lightIdentity', 'lightIndex', 'lightUuid', 'textureUuid', 'fromMaterialGraph', 'reflectorIndex', 'vsm', 'shadowMapColor', 'renderTargetSelector' ],
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
		optional: [
			'itemSize',
			'count',
			'usage',
			'attributeName',
			'elementType',
			'computeNodeUuid',
			'snapshot',
			'anonymousResourceOrdinal',
			'anonymousResourceCount',
		],
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

		if ( ! isExactLiveUniformNodePath( source.nodePath ) ) {

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
	if ( kind === 'storage.buffer' && (
		source.anonymousResourceOrdinal !== undefined
		|| source.anonymousResourceCount !== undefined
	) ) {

		const ordinal = source.anonymousResourceOrdinal;
		const count = source.anonymousResourceCount;
		if ( ! Number.isSafeInteger( ordinal ) || ordinal < 0 ) errors.push( {
			code: 'dynamic-binding.storage-anonymous-ordinal',
			kind,
			field: 'anonymousResourceOrdinal',
			message: `${ kind } source "anonymousResourceOrdinal" must be a non-negative integer`,
		} );
		if ( ! Number.isSafeInteger( count ) || count < 2 ) errors.push( {
			code: 'dynamic-binding.storage-anonymous-count',
			kind,
			field: 'anonymousResourceCount',
			message: `${ kind } source "anonymousResourceCount" must be an integer greater than one`,
		} );
		if ( Number.isSafeInteger( ordinal ) && Number.isSafeInteger( count ) && ordinal >= count ) errors.push( {
			code: 'dynamic-binding.storage-anonymous-range',
			kind,
			field: 'anonymousResourceOrdinal',
			message: `${ kind } source anonymous resource ordinal must be less than its resource count`,
		} );
		if ( typeof source.attributeName === 'string' && source.attributeName.trim().length > 0 ) errors.push( {
			code: 'dynamic-binding.storage-anonymous-name',
			kind,
			field: 'attributeName',
			message: `${ kind } source cannot combine an authored attribute name with anonymous resource identity`,
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
	if ( source && source.renderTargetSelector !== undefined ) {

		const invalidReason = rendererRenderTargetTextureSelectorValidationError( source.renderTargetSelector );
		if ( invalidReason !== null ) errors.push( {
			code: 'dynamic-binding.render-target-selector',
			kind,
			field: 'renderTargetSelector',
			message: `${ kind } source "renderTargetSelector" is invalid: ${ invalidReason }`,
		} );
		const allowedSource = kind === 'artifact.texture' || kind === 'depth.texture'
			&& source.fromMaterialGraph === true
			&& source.lightUuid == null
			&& ( source.lightIndex === undefined || source.lightIndex < 0 );
		if ( ! allowedSource ) errors.push( {
			code: 'dynamic-binding.render-target-selector-owner',
			kind,
			field: 'renderTargetSelector',
			message: `${ kind } source "renderTargetSelector" is only valid for artifact.texture or non-light material-graph depth.texture bindings`,
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
