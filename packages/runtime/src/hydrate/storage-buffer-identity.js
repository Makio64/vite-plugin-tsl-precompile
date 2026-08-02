/**
 * Return the validated identity carried by a signed anonymous storage-buffer
 * entry. Capture assigns the ordinal by ranking the exact live attributes'
 * monotonic BufferAttribute IDs.
 *
 * @param {?Object} entry
 * @returns {?{ ordinal: number, count: number }}
 */
export function storageEntryAnonymousResourceIdentity( entry ) {

	const source = entry && entry.source;
	if ( ! source || source.kind !== 'storage.buffer' ) return null;
	const ordinal = source.anonymousResourceOrdinal;
	const count = source.anonymousResourceCount;
	if ( ! Number.isSafeInteger( ordinal ) || ordinal < 0 ) return null;
	if ( ! Number.isSafeInteger( count ) || count < 2 || ordinal >= count ) return null;
	return { ordinal, count };

}

/**
 * Whether an entry attempts to carry an anonymous storage identity. This is
 * kept separate from validation so malformed signed entries can fail closed
 * instead of silently falling back to shape-only matching.
 *
 * @param {?Object} entry
 * @returns {boolean}
 */
export function hasAnonymousStorageResourceIdentity( entry ) {

	const source = entry && entry.source;
	if ( ! source || source.kind !== 'storage.buffer' ) return false;
	return source.anonymousResourceOrdinal !== undefined
		|| source.anonymousResourceCount !== undefined;

}

/**
 * Select one member of a complete compatible anonymous storage family.
 * Callers own shape/semantic filtering; this helper owns identity deduplication,
 * cardinality validation, and construction-ID ranking.
 *
 * @param {Object} entry
 * @param {Object[]} attributes
 * @returns {?Object}
 */
export function selectSignedAnonymousStorageAttribute( entry, attributes ) {

	const identity = storageEntryAnonymousResourceIdentity( entry );
	if ( ! identity ) return null;

	const unique = [ ...new Set( Array.isArray( attributes ) ? attributes.filter( Boolean ) : [] ) ];
	if ( unique.length !== identity.count ) return null;
	if ( unique.some( ( attribute ) => ! Number.isSafeInteger( attribute.id ) || attribute.id < 0 ) ) return null;

	const ranked = unique.slice().sort( ( left, right ) => left.id - right.id );
	if ( new Set( ranked.map( ( attribute ) => attribute.id ) ).size !== identity.count ) return null;
	return ranked[ identity.ordinal ] || null;

}
