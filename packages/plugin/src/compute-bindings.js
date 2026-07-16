import {
	COMPUTE_BINDINGS_VERSION,
	compareComputeBindingEntries,
	validateComputeBindingsDescriptor,
} from '@tsl-precompile/contract/compute-bindings';

/**
 * Derive the public binding bag for one already-extracted compute artifact.
 *
 * The caller supplies authored keys mapped to live resources or TSL nodes.
 * Matching is identity-only: generated WGSL names and same-shape resources
 * are never used as evidence.
 */

function isObjectIdentity( value ) {

	return value !== null && ( typeof value === 'object' || typeof value === 'function' );

}

function publicResourceEntries( publicResources ) {

	if ( publicResources instanceof Map ) return [ ...publicResources.entries() ];
	if ( publicResources && typeof publicResources === 'object' && ! Array.isArray( publicResources ) ) {

		const prototype = Object.getPrototypeOf( publicResources );
		if ( prototype === Object.prototype || prototype === null ) return Object.entries( publicResources );

	}
	throw new TypeError( 'deriveComputeBindingsDescriptor: publicResources must be a Map or plain object' );

}

function bindingMatchesResource( binding, resource ) {

	if ( ! binding || ! isObjectIdentity( resource ) ) return false;
	return binding === resource
		|| binding.nodeUniform === resource
		|| binding.attribute === resource
		|| binding.textureNode === resource
		|| binding.texture === resource
		|| binding.nodeUniform && binding.nodeUniform.value === resource;

}

function bindingEntry( key, group, binding, descriptor, ordered ) {

	if ( ! descriptor || ! ordered ) return null;
	if ( descriptor.kind === 'storage-buffer' && ordered.type === 'storage-buffer' ) {

		const ref = ordered.ref || {};
		return {
			key,
			target: 'storage-buffer',
			group,
			binding,
			access: descriptor.access,
			arrayType: ref.arrayType,
			count: ref.count,
			itemSize: ref.itemSize,
			byteLength: descriptor.byteLength,
		};

	}
	if ( descriptor.kind === 'sampled-texture' && ordered.type === 'sampled-texture' ) {

		if ( descriptor.store === true ) return {
			key,
			target: 'storage-texture',
			group,
			binding,
			access: descriptor.access,
			textureType: descriptor.textureType,
		};
		return {
			key,
			target: 'sampled-texture',
			group,
			binding,
			textureType: descriptor.textureType,
		};

	}
	if ( descriptor.kind === 'sampler' && ordered.type === 'sampler' ) return {
		key,
		target: 'sampler',
		group,
		binding,
	};
	return null;

}

function entriesForResource( artifact, state, key, resource ) {

	const matches = [];
	const rawGroups = Array.isArray( state && state.bindings ) ? state.bindings : [];
	const descriptorGroups = Array.isArray( artifact && artifact.bindings ) ? artifact.bindings : [];
	const planGroups = Array.isArray( artifact && artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const groupCount = Math.max( rawGroups.length, descriptorGroups.length, planGroups.length );
	for ( let group = 0; group < groupCount; group ++ ) {

		const rawBindings = Array.isArray( rawGroups[ group ] && rawGroups[ group ].bindings ) ? rawGroups[ group ].bindings : [];
		const descriptors = Array.isArray( descriptorGroups[ group ] && descriptorGroups[ group ].bindings ) ? descriptorGroups[ group ].bindings : [];
		const ordered = Array.isArray( planGroups[ group ] && planGroups[ group ].orderedBindings ) ? planGroups[ group ].orderedBindings : [];
		for ( let binding = 0; binding < rawBindings.length; binding ++ ) {

			if ( ! bindingMatchesResource( rawBindings[ binding ], resource ) ) continue;
			const entry = bindingEntry( key, group, binding, descriptors[ binding ], ordered[ binding ] );
			if ( entry ) matches.push( entry );

		}

		const slots = Array.isArray( planGroups[ group ] && planGroups[ group ].slots ) ? planGroups[ group ].slots : [];
		for ( let slot = 0; slot < slots.length; slot ++ ) {

			const planSlot = slots[ slot ];
			if ( ! planSlot || planSlot._liveNode !== resource ) continue;
			matches.push( {
				key,
				target: 'uniform-slot',
				group,
				slot,
				dtype: planSlot.dtype,
			} );

		}

	}
	return matches;

}

function assertUnambiguousTargets( key, entries ) {

	const byTarget = new Map();
	for ( const entry of entries ) {

		let locations = byTarget.get( entry.target );
		if ( ! locations ) byTarget.set( entry.target, locations = [] );
		locations.push( entry.target === 'uniform-slot'
			? `${ entry.group }:slot:${ entry.slot }`
			: `${ entry.group }:binding:${ entry.binding }` );

	}
	for ( const [ target, locations ] of byTarget ) if ( locations.length > 1 ) {

		throw new Error(
			`deriveComputeBindingsDescriptor: public key ${ JSON.stringify( key ) } ambiguously matches ` +
			`${ target } locations ${ locations.join( ', ' ) }`,
		);

	}

}

/**
 * @param {Object} artifact Extracted standalone compute artifact.
 * @param {Object} state Live NodeBuilderState used to extract the artifact.
 * @param {Map<string,Object>|Record<string,Object>} publicResources Public
 *   keys mapped to exact StorageBufferAttribute, UniformNode, Texture, or the
 *   corresponding authored TSL resource node.
 * @return {{ version: 'compute-bindings@1', entries: Array<Object> }}
 */
export function deriveComputeBindingsDescriptor( artifact, state, publicResources ) {

	if ( ! artifact || artifact.kind !== 'compute' ) throw new TypeError(
		'deriveComputeBindingsDescriptor: artifact must be a standalone compute artifact',
	);
	const entries = [];
	for ( const [ key, resource ] of publicResourceEntries( publicResources ) ) {

		if ( typeof key !== 'string' ) throw new TypeError( 'deriveComputeBindingsDescriptor: public resource keys must be strings' );
		if ( ! isObjectIdentity( resource ) ) throw new TypeError(
			`deriveComputeBindingsDescriptor: resource ${ JSON.stringify( key ) } must be an object identity`,
		);
		const matches = entriesForResource( artifact, state, key, resource );
		if ( matches.length === 0 ) throw new Error(
			`deriveComputeBindingsDescriptor: public key ${ JSON.stringify( key ) } did not match a live compute binding`,
		);
		assertUnambiguousTargets( key, matches );
		entries.push( ...matches );

	}
	entries.sort( compareComputeBindingEntries );
	const descriptor = { version: COMPUTE_BINDINGS_VERSION, entries };
	const errors = validateComputeBindingsDescriptor( descriptor, { artifact } );
	if ( errors.length > 0 ) throw new Error(
		`deriveComputeBindingsDescriptor: derived contract is invalid: ${ errors.map( ( error ) => `${ error.code } at ${ error.path }` ).join( '; ' ) }`,
	);
	return descriptor;

}
