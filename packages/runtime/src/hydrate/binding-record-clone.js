/** Rebuild common data records without changing uncommon property descriptors. */
export function cloneBindingRecordFromDescriptors( prototype, descriptors ) {

	if ( prototype !== Object.prototype ) return Object.create( prototype, descriptors );
	const keys = Reflect.ownKeys( descriptors );
	for ( const key of keys ) {

		const descriptor = descriptors[ key ];
		if ( ! ( 'value' in descriptor ) || descriptor.enumerable !== true ||
			descriptor.configurable !== true || descriptor.writable !== true ) {

			return Object.create( prototype, descriptors );

		}

	}
	const clone = {};
	for ( const key of keys ) {

		// Defining inherited names also handles __proto__ and patched setters.
		if ( key in prototype ) Object.defineProperty( clone, key, descriptors[ key ] );
		else clone[ key ] = descriptors[ key ].value;

	}
	return clone;

}
