/**
 * Attach variant-local light identity records to their serialized sources.
 *
 * The serialized artifact keeps the compact integer `source.lightIdentity`.
 * Runtime consumers need both the selected record and the owning table: the
 * record supplies complete capture evidence, while the table scopes the
 * resolver's one-to-one live-light claims. Keep both as non-enumerable
 * sidecars so hashing, validation, and artifact serialization stay stable.
 */

const linkedLightIdentities = new WeakMap();

function defineSidecar( source, key, value ) {

	try {

		if ( source[ key ] === value ) return;
		Object.defineProperty( source, key, {
			value,
			enumerable: false,
			configurable: true,
			writable: true,
		} );

	} catch ( _ ) {

		// Generated constants may deliberately be frozen. The WeakMap below
		// preserves the exact same semantics for those sources.

	}

}

/**
 * Link one serialized source to its selected variant's identity table.
 * This narrow helper is also used by generated updater modules.
 */
export function linkLightIdentitySource( source, lightIdentities ) {

	if ( ! source || typeof source !== 'object' || ! Array.isArray( lightIdentities ) ) return null;
	const index = source.lightIdentity;
	if ( ! Number.isInteger( index ) || index < 0 || index >= lightIdentities.length ) return null;
	const record = lightIdentities[ index ];
	if ( ! record || typeof record !== 'object' ) return null;

	const link = { record, table: lightIdentities };
	linkedLightIdentities.set( source, link );
	defineSidecar( source, 'lightIdentityRecord', record );
	defineSidecar( source, 'lightIdentityTable', lightIdentities );
	return record;

}

/** Link every source owned by one effective artifact/variant payload. */
export function linkArtifactLightIdentities( artifact ) {

	if ( ! artifact || ! Array.isArray( artifact.lightIdentities ) ) return artifact;
	const table = artifact.lightIdentities;
	const seen = new Set();
	const link = ( source ) => {

		if ( ! source || typeof source !== 'object' || seen.has( source ) ) return;
		seen.add( source );
		linkLightIdentitySource( source, table );

	};

	for ( const group of artifact.uniformPlan || [] ) {

		if ( ! group || typeof group !== 'object' ) continue;
		for ( const value of Object.values( group ) ) {

			if ( ! Array.isArray( value ) ) continue;
			for ( const entry of value ) {

				link( entry && entry.source );
				link( entry && entry.ref && entry.ref.source );
				for ( const slot of entry && entry.slots || [] ) link( slot && slot.source );

			}

		}

	}
	for ( const entry of artifact.dynamicBindings || [] ) link( entry && entry.source );
	return artifact;

}

export function linkedLightIdentityForSource( source ) {

	if ( ! source || typeof source !== 'object' ) return null;
	const record = source.lightIdentityRecord;
	const table = source.lightIdentityTable;
	if ( record && typeof record === 'object' ) return {
		record,
		table: Array.isArray( table ) ? table : record,
	};
	return linkedLightIdentities.get( source ) || null;

}
