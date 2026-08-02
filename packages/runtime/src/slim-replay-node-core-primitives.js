/**
 * Replay-owned replacements for the final Three Node-core primitives retained
 * by the compiler-free bundle. Keep these values in exact parity with Three
 * r185; focused tests compare every exported primitive with the installed
 * implementation so a Three upgrade fails before the slim rewrite can drift.
 */

// cyrb53 (c) 2018 bryc (github.com/bryc). License: Public domain.
// This is the exact implementation used by three@0.185.1 NodeUtils.js.
function cyrb53( value, seed = 0 ) {

	let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;

	if ( Array.isArray( value ) ) {

		for ( let i = 0, val; i < value.length; i ++ ) {

			val = value[ i ];
			h1 = Math.imul( h1 ^ val, 2654435761 );
			h2 = Math.imul( h2 ^ val, 1597334677 );

		}

	} else {

		for ( let i = 0, ch; i < value.length; i ++ ) {

			ch = value.charCodeAt( i );
			h1 = Math.imul( h1 ^ ch, 2654435761 );
			h2 = Math.imul( h2 ^ ch, 1597334677 );

		}

	}

	h1 = Math.imul( h1 ^ ( h1 >>> 16 ), 2246822507 );
	h1 ^= Math.imul( h2 ^ ( h2 >>> 13 ), 3266489909 );
	h2 = Math.imul( h2 ^ ( h2 >>> 16 ), 2246822507 );
	h2 ^= Math.imul( h1 ^ ( h1 >>> 13 ), 3266489909 );

	return 4294967296 * ( 2097151 & h2 ) + ( h1 >>> 0 );

}

export const hashString = ( str ) => cyrb53( str );
export const hashArray = ( array ) => cyrb53( array );
export const hash = ( ...params ) => cyrb53( params );

export const NodeAccess = {
	READ_ONLY: 'readOnly',
	WRITE_ONLY: 'writeOnly',
	READ_WRITE: 'readWrite',
};

export const NodeUpdateType = {
	NONE: 'none',
	FRAME: 'frame',
	RENDER: 'render',
	OBJECT: 'object',
};
