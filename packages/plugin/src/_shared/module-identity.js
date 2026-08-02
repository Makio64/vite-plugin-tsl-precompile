import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

const VOLATILE_VITE_QUERY_KEYS = new Set( [ 'direct', 'import', 't', 'v' ] );

function canonicalFilesystemPath( path ) {

	const unresolved = [];
	let current = resolve( path );
	while ( true ) {

		try {

			const resolvedAncestor = realpathSync( current );
			return resolve( resolvedAncestor, ...unresolved.reverse() );

		} catch ( error ) {

			// Vite normally supplies existing files, but generated ids and
			// unit-level transform calls may name a descendant before it exists.
			// Canonicalize the deepest existing ancestor so platform aliases
			// such as macOS `/var` → `/private/var` cannot split root and file
			// identity. Other filesystem failures stay loud/fail-closed.
			if ( error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR' ) throw error;
			const parent = dirname( current );
			if ( parent === current ) throw error;
			unresolved.push( basename( current ) );
			current = parent;

		}

	}

}

function isWithinRoot( root, file ) {

	const rootRelative = relative( root, file );
	return rootRelative === ''
		|| ( rootRelative !== '..' && ! rootRelative.startsWith( '../' ) && ! rootRelative.startsWith( '..\\' ) && ! isAbsolute( rootRelative ) );

}

/**
 * Return whether a Vite module id resolves to a path owned by the configured
 * application root.
 *
 * Both paths are canonicalized through their deepest existing ancestor. This
 * keeps workspace-linked package sources out even when Vite resolves a
 * node_modules symlink to an absolute path without a `node_modules` segment,
 * accepts a configured project root reached through a symlink, and remains
 * stable for generated descendants that do not exist yet.
 */
export function isProjectRootModule( filename, root = process.cwd() ) {

	if ( typeof filename !== 'string' || filename.length === 0 ) return false;

	const cleanFilename = filename.replace( /^\0/, '' ).split( /[?#]/, 1 )[ 0 ];
	if ( cleanFilename.length === 0 ) return false;

	const rootPath = resolve( root );
	const absoluteFile = isAbsolute( cleanFilename ) ? resolve( cleanFilename ) : resolve( rootPath, cleanFilename );
	return isWithinRoot(
		canonicalFilesystemPath( rootPath ),
		canonicalFilesystemPath( absoluteFile ),
	);

}

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
	const lexicalRoot = resolve( root );
	const absoluteFile = isAbsolute( cleanFilename ) ? resolve( cleanFilename ) : resolve( lexicalRoot, cleanFilename );
	const canonicalRoot = canonicalFilesystemPath( lexicalRoot );
	const canonicalFile = canonicalFilesystemPath( absoluteFile );
	const relativeFile = relative( canonicalRoot, canonicalFile ).replace( /\\/g, '/' ) || 'unknown';
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
		.sort( ( a, b ) => compareCodeUnits( a[ 0 ], b[ 0 ] ) || compareCodeUnits( a[ 1 ], b[ 1 ] ) );
	if ( entries.length === 0 ) return '';
	const canonical = entries.map( ( [ key, value ] ) => `${ key }\0${ value }` ).join( '\0' );
	return `?subresource=${ createHash( 'sha256' ).update( canonical ).digest( 'hex' ) }`;

}

/**
 * Conservative marker-source invalidation.
 *
 * With no dependency proof this preserves the legacy whole-module revision so
 * existing captures remain diagnosable. New captures pass a canonical,
 * deterministic project-local dependency closure and use the v2 domain.
 */
export function markerSourceRevision( source, dependencies = null ) {

	const hash = createHash( 'sha256' );
	if ( dependencies === null || dependencies.length === 0 ) {

		return hash
			.update( 'tslp-marker-source@1\0' )
			.update( String( source ) )
			.digest( 'hex' );

	}

	hash
		.update( 'tslp-marker-source@2\0' )
		.update( String( source ) );
	for ( const dependency of [ ...dependencies ].sort( compareSourceDependencies ) ) {

		hash
			.update( '\0module\0' )
			.update( String( dependency.identity ) )
			.update( '\0revision\0' )
			.update( String( dependency.revision ) );

	}
	return hash.digest( 'hex' );

}

function compareSourceDependencies( a, b ) {

	return compareCodeUnits( a && a.identity, b && b.identity )
		|| compareCodeUnits( a && a.revision, b && b.revision );

}

function compareCodeUnits( a, b ) {

	const left = String( a );
	const right = String( b );
	return left < right ? - 1 : left > right ? 1 : 0;

}
