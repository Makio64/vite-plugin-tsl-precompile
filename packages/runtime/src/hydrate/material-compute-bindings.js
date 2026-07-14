/**
 * Tiny hydration-side half of material-owned compute attribute wiring.
 *
 * Kept separate from `slim-support/auto-compute.js` so importing the core
 * hydrator does not retain scene traversal and full-renderer orchestration.
 *
 * @module MaterialComputeBindings
 */

export const MATERIAL_COMPUTE_BINDINGS = Symbol.for( '@tsl-precompile/runtime/material-compute-bindings' );

export function isLiveStorageAttribute( value ) {

	return !! value && (
		value.isStorageBufferAttribute === true
		|| value.isStorageInstancedBufferAttribute === true
	) && value.array && ArrayBuffer.isView( value.array );

}

export function materialComputeAttributeEntries( artifact ) {

	if ( artifact && Array.isArray( artifact.attributes ) ) return artifact.attributes;
	return artifact && Array.isArray( artifact.nodeAttributes ) ? artifact.nodeAttributes : [];

}

export function materialComputeAttributeShapeMatches( attribute, entry, allowVec3ToVec4 = true ) {

	if ( ! isLiveStorageAttribute( attribute ) || ! entry ) return false;
	if ( Number.isFinite( entry.count ) && entry.count > 0 && attribute.count !== entry.count ) return false;
	if ( Number.isFinite( entry.itemSize ) && entry.itemSize > 0
		&& attribute.itemSize !== entry.itemSize
		&& ! ( allowVec3ToVec4 && attribute.itemSize === 3 && entry.itemSize === 4 ) ) return false;
	if ( entry.arrayType && attribute.array && attribute.array.constructor
		&& attribute.array.constructor.name !== entry.arrayType ) return false;
	return true;

}

export function materialComputeLayoutKey( entries ) {

	return JSON.stringify( entries.map( ( entry ) => [
		entry && entry.name || '',
		entry && entry.source || '',
		entry && entry.storage === false ? 0 : 1,
		entry && entry.count || 0,
		entry && entry.itemSize || 0,
		entry && entry.arrayType || '',
		entry && entry.type || '',
		entry && entry.instanced === true ? 1 : 0,
		entry && Array.isArray( entry.userPath ) ? entry.userPath : null,
	] ) );

}

export function materialComputeBindingStore( material, create = false ) {

	let store = material && material[ MATERIAL_COMPUTE_BINDINGS ];
	if ( ! store && create && material ) {

		store = { records: new Map() };
		Object.defineProperty( material, MATERIAL_COMPUTE_BINDINGS, {
			value: store,
			enumerable: false,
			configurable: true,
			writable: false,
		} );

	}
	return store || null;

}

/** Apply owner-local assignments to the exact variant cloned by hydration. */
export function applyMaterialComputeAttributeBindings( artifactView, material ) {

	const store = materialComputeBindingStore( material, false );
	if ( ! store || ! material || ! material.precompiledArtifact ) return 0;
	const entries = materialComputeAttributeEntries( artifactView );
	if ( entries.length === 0 ) return 0;
	const key = materialComputeLayoutKey( entries );
	const proposed = new Map();

	for ( const record of store.records.values() ) {

		if ( record.artifact !== material.precompiledArtifact ) continue;
		const assignments = record.layouts.get( key );
		if ( ! assignments ) continue;
		for ( const assignment of assignments ) {

			const entry = entries[ assignment.index ];
			if ( ! entry || ! materialComputeAttributeShapeMatches( assignment.attribute, entry ) ) return 0;
			const previous = proposed.get( assignment.index );
			if ( previous && previous !== assignment.attribute ) return 0;
			proposed.set( assignment.index, assignment.attribute );

		}

	}

	let applied = 0;
	for ( const [ index, attribute ] of proposed ) {

		const entry = entries[ index ];
		if ( isLiveStorageAttribute( entry._liveAttribute ) ) continue;
		Object.defineProperty( entry, '_liveAttribute', {
			value: attribute,
			enumerable: false,
			configurable: true,
			writable: true,
		} );
		Object.defineProperty( entry, '_liveAttributeSource', {
			value: 'material-compute',
			enumerable: false,
			configurable: true,
			writable: true,
		} );
		applied ++;

	}
	return applied;

}
