// A hydration owns this index alongside its cloned artifact view. Values stay
// live: indexes retain plan entries, never snapshots of mutable sidecars.
export function createUniformPlanIndex( artifact ) {

	const groups = new Map();
	const textureBindings = new Map();
	const plan = Array.isArray( artifact?.uniformPlan ) ? artifact.uniformPlan : [];
	for ( const [ order, group ] of plan.entries() ) {

		if ( groups.has( group.name ) ) continue;
		const textures = firstByName( group.textures );
		const storage = firstByName( group.storageBuffers );
		const uniforms = new Map();
		for ( const [ bindingOrder, binding ] of ( group.orderedBindings || [] ).entries() ) {

			if ( ! binding.ref ) continue;
			if ( binding.type === 'storage-buffer' && ! storage.has( binding.ref.name ) ) storage.set( binding.ref.name, binding.ref );
			if ( binding.type === 'buffer-uniform' && ! uniforms.has( binding.ref.name ) ) uniforms.set( binding.ref.name, { order: bindingOrder, value: binding.ref } );

		}
		groups.set( group.name, { order, value: group, textures, storage, uniforms, requiredByteLength: requiredByteLength( group ) } );

	}
	const find = ( groupName, bindingName ) => firstInPlan( groups.get( groupName ), groups.get( bindingName ) );
	return {
		group: ( groupName, bindingName ) => find( groupName, bindingName )?.value || null,
		texture: ( groupName, bindingName ) => find( groupName, bindingName )?.textures.get( bindingName ) || null,
		textureBinding( groupName, bindingName ) {

			let bindings = textureBindings.get( groupName );
			if ( ! bindings ) textureBindings.set( groupName, bindings = new Map() );
			let binding = bindings.get( bindingName );
			if ( ! binding ) {

				const exact = groups.get( groupName );
				binding = {
					group: exact?.value,
					entry: exact?.textures.get( bindingName ),
					textures: exact?.textures,
					// Owner selection supports ordered aliases; dispatch is exact.
					owner: find( groupName, bindingName )?.textures.get( bindingName ),
				};
				bindings.set( bindingName, binding );

			}
			return binding;

		},
		storageBuffer: ( groupName, bindingName ) => groups.get( groupName )?.storage.get( bindingName ) || null,
		bufferUniform( groupName, bindingName ) {

			const uniforms = find( groupName, bindingName )?.uniforms;
			return firstInPlan( uniforms?.get( groupName ), uniforms?.get( bindingName ) )?.value || null;

		},
		byteLength: ( groupName, bindingName ) => find( groupName, bindingName )?.value.byteLength || 16,
		requiredByteLength: ( groupName, bindingName ) => find( groupName, bindingName )?.requiredByteLength || 16,
	};

}

function firstInPlan( a, b ) {

	return ! a ? b : ! b || a.order <= b.order ? a : b;

}

function firstByName( entries ) {

	const out = new Map();
	for ( const entry of entries || [] ) if ( entry && ! out.has( entry.name ) ) out.set( entry.name, entry );
	return out;

}

function requiredByteLength( group ) {

	if ( ! Array.isArray( group.slots ) ) return 16;
	let byteLength = group.byteLength || 16;
	for ( const slot of group.slots ) {

		const offset = slot.offset ?? slot.byteOffset ?? 0;
		const source = slot.source || {};
		const snapshot = source.valueSnapshot || ( source.valueType ? { type: source.valueType, data: source.value } : null );
		const snapshotSize = snapshot && Array.isArray( snapshot.data ) ? snapshot.data.length * 4 : 0;
		const slotSize = slot.byteLength || snapshotSize || uniformSlotByteLength( slot.type || slot.valueType || source.valueType );
		byteLength = Math.max( byteLength, offset + slotSize );

	}
	return Math.ceil( byteLength / 16 ) * 16;

}

function uniformSlotByteLength( type ) {

	switch ( type ) {

		case 'float':
		case 'int':
		case 'uint':
		case 'bool':
			return 4;
		case 'vec2':
			return 8;
		case 'vec3':
		case 'vec4':
			return 16;
		case 'mat3':
			return 48;
		case 'mat4':
			return 64;
		default:
			return 64;

	}

}
