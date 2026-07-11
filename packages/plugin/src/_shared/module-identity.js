import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

const VOLATILE_VITE_QUERY_KEYS = new Set( [ 'direct', 'import', 't', 'v' ] );

/**
 * Return one canonical identity for a Vite module request.
 *
 * The path is root-relative. Meaningful framework subresource query fields
 * are sorted and hashed, while Vite's cache-busting fields are ignored. Both
 * auto-mark naming and marker ownership must use this helper.
 */
export function canonicalModuleIdentity( filename, root = process.cwd() ) {

	const rawFilename = String( filename || 'unknown' ).replace( /^\0/, '' );
	const cleanFilename = rawFilename.split( /[?#]/, 1 )[ 0 ];
	const rootPath = resolve( root );
	const absoluteFile = isAbsolute( cleanFilename ) ? resolve( cleanFilename ) : resolve( rootPath, cleanFilename );
	const relativeFile = relative( rootPath, absoluteFile ).replace( /\\/g, '/' ) || 'unknown';
	const subresourceIdentity = stableSubresourceIdentity( rawFilename );

	return {
		moduleIdentity: `${ relativeFile }${ subresourceIdentity }`,
		relativeFile,
		subresourceIdentity,
	};

}

export function stableSubresourceIdentity( id ) {

	const raw = String( id || '' );
	const queryStart = raw.indexOf( '?' );
	if ( queryStart === - 1 ) return '';
	const hashStart = raw.indexOf( '#', queryStart );
	const rawQuery = raw.slice( queryStart + 1, hashStart === - 1 ? raw.length : hashStart );
	const entries = [ ...new URLSearchParams( rawQuery ).entries() ]
		.filter( ( [ key ] ) => key && ! VOLATILE_VITE_QUERY_KEYS.has( key ) )
		.sort( ( a, b ) => a[ 0 ].localeCompare( b[ 0 ] ) || a[ 1 ].localeCompare( b[ 1 ] ) );
	if ( entries.length === 0 ) return '';
	const canonical = entries.map( ( [ key, value ] ) => `${ key }\0${ value }` ).join( '\0' );
	return `?subresource=${ createHash( 'sha256' ).update( canonical ).digest( 'hex' ) }`;

}

/** Conservative source invalidation: deliberately hashes the whole module. */
export function markerSourceRevision( source ) {

	return createHash( 'sha256' )
		.update( 'tslp-marker-source@1\0' )
		.update( String( source ) )
		.digest( 'hex' );

}
