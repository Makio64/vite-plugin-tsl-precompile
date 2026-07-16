import {
	MATERIAL_COMPUTE_ACCESS_MODES,
	MATERIAL_COMPUTE_STORAGE_TEXTURE_TYPES,
} from './material-compute.js';

/**
 * Exact caller-owned inputs for one standalone compute artifact.
 *
 * `key` is the stable public key accepted by a future compute runner. Every
 * entry points at one exact artifact location, so extraction and hydration do
 * not need to recover resource identity from generated WGSL names or matching
 * resource shapes.
 *
 * @module Contract.ComputeBindings
 */

export const COMPUTE_BINDINGS_VERSION = 'compute-bindings@1';

export const COMPUTE_BINDING_TARGETS = Object.freeze( [
	'storage-buffer',
	'storage-texture',
	'sampled-texture',
	'sampler',
	'uniform-slot',
] );

export const COMPUTE_BINDING_TEXTURE_TYPES = Object.freeze( [
	'2d',
	'2d-array',
	'3d',
	'cube',
] );

const TARGET_SET = new Set( COMPUTE_BINDING_TARGETS );
const TEXTURE_TYPE_SET = new Set( COMPUTE_BINDING_TEXTURE_TYPES );
const STORAGE_TEXTURE_TYPE_SET = new Set( MATERIAL_COMPUTE_STORAGE_TEXTURE_TYPES );
const ACCESS_MODE_SET = new Set( MATERIAL_COMPUTE_ACCESS_MODES );
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const UNSAFE_KEYS = new Set( [ '__proto__', 'constructor', 'prototype' ] );

function issue( code, message, path ) {

	return Object.freeze( { code, message, path } );

}

function isRecord( value ) {

	return !! value && typeof value === 'object' && ! Array.isArray( value );

}

function isIndex( value ) {

	return Number.isSafeInteger( value ) && value >= 0;

}

function compareTuple( left, right ) {

	const length = Math.max( left.length, right.length );
	for ( let index = 0; index < length; index ++ ) {

		const a = left[ index ];
		const b = right[ index ];
		if ( a === b ) continue;
		return a < b ? - 1 : 1;

	}
	return 0;

}

function entryTuple( entry ) {

	return [
		entry && typeof entry.key === 'string' ? entry.key : '',
		COMPUTE_BINDING_TARGETS.indexOf( entry && entry.target ),
		entry && isIndex( entry.group ) ? entry.group : - 1,
		entry && isIndex( entry.binding ) ? entry.binding : - 1,
		entry && isIndex( entry.slot ) ? entry.slot : - 1,
	];

}

/** Compare two entries using the canonical serialized order. */
export function compareComputeBindingEntries( left, right ) {

	return compareTuple( entryTuple( left ), entryTuple( right ) );

}

function bindingDescriptorAt( artifact, group, binding ) {

	const descriptorGroup = artifact && Array.isArray( artifact.bindings ) ? artifact.bindings[ group ] : null;
	return descriptorGroup && Array.isArray( descriptorGroup.bindings ) ? descriptorGroup.bindings[ binding ] : null;

}

function orderedBindingAt( artifact, group, binding ) {

	const planGroup = artifact && Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan[ group ] : null;
	return planGroup && Array.isArray( planGroup.orderedBindings ) ? planGroup.orderedBindings[ binding ] : null;

}

function uniformSlotAt( artifact, group, slot ) {

	const planGroup = artifact && Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan[ group ] : null;
	return planGroup && Array.isArray( planGroup.slots ) ? planGroup.slots[ slot ] : null;

}

function validateStorageBufferEntry( entry, path, errors ) {

	if ( ! ACCESS_MODE_SET.has( entry.access ) ) errors.push( issue(
		'compute-bindings.entry.access',
		`${ path }.access must be one of ${ MATERIAL_COMPUTE_ACCESS_MODES.join( ', ' ) }`,
		`${ path }.access`,
	) );
	if ( typeof entry.arrayType !== 'string' || entry.arrayType.length === 0 ) errors.push( issue(
		'compute-bindings.entry.array-type',
		`${ path }.arrayType must be a non-empty typed-array constructor name`,
		`${ path }.arrayType`,
	) );
	if ( ! isIndex( entry.count ) ) errors.push( issue(
		'compute-bindings.entry.count',
		`${ path }.count must be a non-negative integer`,
		`${ path }.count`,
	) );
	if ( ! Number.isSafeInteger( entry.itemSize ) || entry.itemSize <= 0 ) errors.push( issue(
		'compute-bindings.entry.item-size',
		`${ path }.itemSize must be a positive integer`,
		`${ path }.itemSize`,
	) );
	if ( ! isIndex( entry.byteLength ) ) errors.push( issue(
		'compute-bindings.entry.byte-length',
		`${ path }.byteLength must be a non-negative integer`,
		`${ path }.byteLength`,
	) );

}

function validateEntryShape( entry, index, root, errors ) {

	const path = `${ root }.entries[${ index }]`;
	if ( ! isRecord( entry ) ) {

		errors.push( issue( 'compute-bindings.entry', `${ path } must be an object`, path ) );
		return false;

	}
	if ( typeof entry.key !== 'string' || ! KEY_PATTERN.test( entry.key ) || UNSAFE_KEYS.has( entry.key ) ) errors.push( issue(
		'compute-bindings.entry.key',
		`${ path }.key must be a safe canonical binding key`,
		`${ path }.key`,
	) );
	if ( ! TARGET_SET.has( entry.target ) ) errors.push( issue(
		'compute-bindings.entry.target',
		`${ path }.target must be one of ${ COMPUTE_BINDING_TARGETS.join( ', ' ) }`,
		`${ path }.target`,
	) );
	if ( ! isIndex( entry.group ) ) errors.push( issue(
		'compute-bindings.entry.group',
		`${ path }.group must be a non-negative integer`,
		`${ path }.group`,
	) );

	if ( entry.target === 'uniform-slot' ) {

		if ( ! isIndex( entry.slot ) ) errors.push( issue(
			'compute-bindings.entry.slot',
			`${ path }.slot must be a non-negative integer`,
			`${ path }.slot`,
		) );
		if ( entry.binding !== undefined ) errors.push( issue(
			'compute-bindings.entry.binding',
			`${ path }.binding is not valid for a uniform-slot target`,
			`${ path }.binding`,
		) );
		if ( typeof entry.dtype !== 'string' || entry.dtype.length === 0 ) errors.push( issue(
			'compute-bindings.entry.dtype',
			`${ path }.dtype must be a non-empty uniform data type`,
			`${ path }.dtype`,
		) );

	} else if ( TARGET_SET.has( entry.target ) ) {

		if ( ! isIndex( entry.binding ) ) errors.push( issue(
			'compute-bindings.entry.binding',
			`${ path }.binding must be a non-negative integer`,
			`${ path }.binding`,
		) );
		if ( entry.slot !== undefined ) errors.push( issue(
			'compute-bindings.entry.slot',
			`${ path }.slot is only valid for a uniform-slot target`,
			`${ path }.slot`,
		) );

	}

	if ( entry.target === 'storage-buffer' ) validateStorageBufferEntry( entry, path, errors );
	if ( entry.target === 'storage-texture' ) {

		if ( ! ACCESS_MODE_SET.has( entry.access ) ) errors.push( issue(
			'compute-bindings.entry.access',
			`${ path }.access must be one of ${ MATERIAL_COMPUTE_ACCESS_MODES.join( ', ' ) }`,
			`${ path }.access`,
		) );
		if ( ! STORAGE_TEXTURE_TYPE_SET.has( entry.textureType ) ) errors.push( issue(
			'compute-bindings.entry.texture-type',
			`${ path }.textureType must be one of ${ MATERIAL_COMPUTE_STORAGE_TEXTURE_TYPES.join( ', ' ) }`,
			`${ path }.textureType`,
		) );

	}
	if ( entry.target === 'sampled-texture' && ! TEXTURE_TYPE_SET.has( entry.textureType ) ) errors.push( issue(
		'compute-bindings.entry.texture-type',
		`${ path }.textureType must be one of ${ COMPUTE_BINDING_TEXTURE_TYPES.join( ', ' ) }`,
		`${ path }.textureType`,
	) );
	return true;

}

function validateStorageBufferArtifact( entry, descriptor, ordered, path, errors ) {

	if ( ! descriptor || descriptor.kind !== 'storage-buffer' || ! ordered || ordered.type !== 'storage-buffer' ) {

		errors.push( issue( 'compute-bindings.artifact.kind', `${ path } does not identify an exact storage-buffer binding`, path ) );
		return;

	}
	if ( descriptor.access !== entry.access ) errors.push( issue(
		'compute-bindings.artifact.access',
		`${ path }.access must match the compute binding descriptor`,
		`${ path }.access`,
	) );
	const ref = ordered.ref;
	for ( const field of [ 'arrayType', 'count', 'itemSize' ] ) {

		if ( ! ref || ref[ field ] !== entry[ field ] ) errors.push( issue(
			`compute-bindings.artifact.${ field }`,
			`${ path }.${ field } must match the compute uniform plan`,
			`${ path }.${ field }`,
		) );

	}
	if ( descriptor.byteLength !== entry.byteLength ) errors.push( issue(
		'compute-bindings.artifact.byteLength',
		`${ path }.byteLength must match the compute binding descriptor`,
		`${ path }.byteLength`,
	) );

}

function validateTextureArtifact( entry, descriptor, ordered, path, errors ) {

	const storage = entry.target === 'storage-texture';
	if ( ! descriptor || descriptor.kind !== 'sampled-texture' || ! ordered || ordered.type !== 'sampled-texture'
		|| storage && descriptor.store !== true || ! storage && descriptor.store === true ) {

		errors.push( issue(
			'compute-bindings.artifact.kind',
			`${ path } does not identify an exact ${ entry.target } binding`,
			path,
		) );
		return;

	}
	if ( descriptor.textureType !== entry.textureType || ! ordered.ref || ordered.ref.textureType !== entry.textureType ) errors.push( issue(
		'compute-bindings.artifact.texture-type',
		`${ path }.textureType must match the compute binding descriptor and uniform plan`,
		`${ path }.textureType`,
	) );
	if ( storage && descriptor.access !== entry.access ) errors.push( issue(
		'compute-bindings.artifact.access',
		`${ path }.access must match the compute binding descriptor`,
		`${ path }.access`,
	) );

}

function validateEntryArtifact( entry, index, artifact, root, errors ) {

	const path = `${ root }.entries[${ index }]`;
	if ( ! isIndex( entry.group ) || ! TARGET_SET.has( entry.target ) ) return;
	if ( entry.target === 'uniform-slot' ) {

		if ( ! isIndex( entry.slot ) ) return;
		const slot = uniformSlotAt( artifact, entry.group, entry.slot );
		if ( ! slot ) errors.push( issue(
			'compute-bindings.artifact.location',
			`${ path } does not identify a uniform slot in the compute artifact`,
			`${ path }.slot`,
		) );
		else if ( slot.dtype !== entry.dtype ) errors.push( issue(
			'compute-bindings.artifact.dtype',
			`${ path }.dtype must match the compute uniform plan`,
			`${ path }.dtype`,
		) );
		return;

	}
	if ( ! isIndex( entry.binding ) ) return;
	const descriptor = bindingDescriptorAt( artifact, entry.group, entry.binding );
	const ordered = orderedBindingAt( artifact, entry.group, entry.binding );
	if ( entry.target === 'storage-buffer' ) validateStorageBufferArtifact( entry, descriptor, ordered, path, errors );
	else if ( entry.target === 'storage-texture' || entry.target === 'sampled-texture' ) validateTextureArtifact( entry, descriptor, ordered, path, errors );
	else if ( entry.target === 'sampler' && ( ! descriptor || descriptor.kind !== 'sampler' || ! ordered || ordered.type !== 'sampler' ) ) errors.push( issue(
		'compute-bindings.artifact.kind',
		`${ path } does not identify an exact sampler binding`,
		path,
	) );

}

/**
 * Validate one optional `compute-bindings@1` descriptor.
 *
 * Pass the owning compute artifact to verify every public key against its
 * exact runtime binding or uniform slot.
 */
export function validateComputeBindingsDescriptor( descriptor, opts = {} ) {

	const root = opts.root || 'computeBindings';
	const errors = [];
	if ( ! isRecord( descriptor ) ) return Object.freeze( [ issue(
		'compute-bindings.type',
		`${ root } must be an object`,
		root,
	) ] );
	if ( descriptor.version !== COMPUTE_BINDINGS_VERSION ) errors.push( issue(
		'compute-bindings.version',
		`${ root }.version must be ${ COMPUTE_BINDINGS_VERSION }`,
		`${ root }.version`,
	) );
	if ( ! Array.isArray( descriptor.entries ) ) {

		errors.push( issue( 'compute-bindings.entries', `${ root }.entries must be an array`, `${ root }.entries` ) );
		return Object.freeze( errors );

	}

	let previous = null;
	const publicTargets = new Set();
	const artifactLocations = new Set();
	for ( let index = 0; index < descriptor.entries.length; index ++ ) {

		const entry = descriptor.entries[ index ];
		const path = `${ root }.entries[${ index }]`;
		const validRecord = validateEntryShape( entry, index, root, errors );
		if ( ! validRecord ) continue;
		const tuple = entryTuple( entry );
		if ( previous && compareTuple( previous, tuple ) > 0 ) errors.push( issue(
			'compute-bindings.entries.order',
			`${ root }.entries must be in canonical key/target/location order`,
			path,
		) );
		previous = tuple;

		if ( typeof entry.key === 'string' && TARGET_SET.has( entry.target ) ) {

			const publicTarget = `${ entry.key }|${ entry.target }`;
			if ( publicTargets.has( publicTarget ) ) errors.push( issue(
				'compute-bindings.entries.key-duplicate',
				`${ path } duplicates an earlier public key/target`,
				path,
			) );
			publicTargets.add( publicTarget );

		}
		if ( isIndex( entry.group ) ) {

			const location = entry.target === 'uniform-slot'
				? isIndex( entry.slot ) && `slot|${ entry.group }|${ entry.slot }`
				: isIndex( entry.binding ) && `binding|${ entry.group }|${ entry.binding }`;
			if ( location ) {

				if ( artifactLocations.has( location ) ) errors.push( issue(
					'compute-bindings.entries.location-duplicate',
					`${ path } claims an artifact location already owned by an earlier entry`,
					path,
				) );
				artifactLocations.add( location );

			}

		}
		if ( opts.artifact ) validateEntryArtifact( entry, index, opts.artifact, root, errors );

	}
	return Object.freeze( errors );

}
