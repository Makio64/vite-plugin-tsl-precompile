// Inspector's r186 Settings module reads persisted state at import time.
// Each isolated Node test file gets its own in-memory browser storage.
if ( typeof globalThis.localStorage === 'undefined' ) {

	const values = new Map();
	globalThis.localStorage = {
		getItem: key => values.get( String( key ) ) ?? null,
		setItem: ( key, value ) => { values.set( String( key ), String( value ) ); },
		removeItem: key => { values.delete( String( key ) ); },
		clear: () => { values.clear(); },
	};

}
