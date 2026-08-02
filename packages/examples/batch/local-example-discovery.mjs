import {
	existsSync,
	lstatSync,
	readdirSync,
	realpathSync,
} from 'node:fs';
import {
	basename,
	isAbsolute,
	relative,
	resolve,
	sep,
} from 'node:path';

import { readSafeContainedFile } from './e2e-evidence.mjs';
import {
	assertCanonicalExampleId,
	assertCanonicalExampleName,
} from './output-path-safety.mjs';

function routeFilename( route ) {

	return String( route || '' ).split( /[?#]/, 1 )[ 0 ];

}

function isContained( root, file ) {

	const rel = relative( resolve( root ), resolve( file ) );
	return rel !== '' &&
		rel !== '..' &&
		! rel.startsWith( `..${ sep }` ) &&
		! isAbsolute( rel );

}

function assertCanonicalLocalRoute( root, route, manifestPath, name ) {

	const routePath = routeFilename( route );
	if (
		routePath.length === 0 ||
		isAbsolute( routePath ) ||
		routePath.includes( '\\' ) ||
		! /^[A-Za-z0-9._/-]+\.html$/.test( routePath )
	) {

		throw new Error( `${ manifestPath }: ${ name } requires a canonical relative HTML route` );

	}
	const segments = routePath.split( '/' );
	if ( segments.some( ( segment ) => segment === '' || segment === '.' || segment === '..' ) ) {

		throw new Error( `${ manifestPath }: ${ name } requires a canonical relative HTML route` );

	}
	for ( const segment of segments.slice( 0, - 1 ) ) {

		assertCanonicalExampleId( segment, `${ manifestPath }: route directory` );

	}
	assertCanonicalExampleName( segments.at( - 1 ), `${ manifestPath }: route basename` );
	const canonicalRoot = resolve( root );
	const rootStat = lstatSync( canonicalRoot );
	if ( rootStat.isSymbolicLink() || ! rootStat.isDirectory() ) {

		throw new Error( `${ manifestPath }: local example root must be a real directory` );

	}
	const physicalPath = resolve( canonicalRoot, ...segments );
	if ( ! isContained( canonicalRoot, physicalPath ) ) {

		throw new Error( `${ manifestPath }: ${ name } route escapes the local example root` );

	}
	let current = canonicalRoot;
	for ( let index = 0; index < segments.length; index ++ ) {

		current = resolve( current, segments[ index ] );
		let stat;
		try {

			stat = lstatSync( current );

		} catch ( error ) {

			if ( error?.code === 'ENOENT' ) {

				throw new Error( `${ manifestPath }: ${ name } references missing route ${ route }` );

			}
			throw error;

		}
		if ( stat.isSymbolicLink() ) {

			throw new Error( `${ manifestPath }: ${ name } route must not traverse a symbolic link` );

		}
		const final = index === segments.length - 1;
		if ( final ? ! stat.isFile() : ! stat.isDirectory() ) {

			throw new Error( `${ manifestPath }: ${ name } route is not a regular HTML file` );

		}

	}
	const resolvedPhysicalPath = realpathSync( physicalPath );
	if ( ! isContained( realpathSync( canonicalRoot ), resolvedPhysicalPath ) ) {

		throw new Error( `${ manifestPath }: ${ name } route resolves outside the local example root` );

	}
	return route;

}

/**
 * Discover local harness cases with one shared additive manifest policy.
 *
 * Named manifest variants are included first. Physical non-index HTML routes
 * that do not already have the same case name are included as ordinary cases,
 * so catalogue, runner, and evidence refresh see the same route set.
 */
export function discoverLocalExampleCases( root, {
	readFile = ( file, options ) => readSafeContainedFile( root, file, options ),
} = {} ) {

	const byName = new Map();
	const manifestPath = resolve( root, 'e2e-cases.json' );
	if ( existsSync( manifestPath ) ) {

		const parsed = JSON.parse( readFile( manifestPath, {
			label: 'local example manifest',
		} ).toString( 'utf8' ) );
		const entries = Array.isArray( parsed ) ? parsed : parsed.cases;
		if ( ! Array.isArray( entries ) ) throw new Error( `${ manifestPath }: expected an array or { cases: [] }` );
		for ( const entry of entries ) {

			const path = typeof entry === 'string' ? entry : entry?.path;
			const name = typeof entry === 'string' ? basename( routeFilename( entry ) ) : entry?.name;
			if ( typeof path !== 'string' || path.length === 0 || typeof name !== 'string' || name.length === 0 ) {

				throw new Error( `${ manifestPath }: every case requires non-empty name and path strings` );

			}
			assertCanonicalExampleName( name, `${ manifestPath}: case name` );
			assertCanonicalLocalRoute( root, path, manifestPath, name );
			if ( byName.has( name ) ) throw new Error( `${ manifestPath }: duplicate case name ${ name }` );
			byName.set( name, {
				name,
				path,
				options: entry && typeof entry === 'object' ? entry : null,
			} );

		}

	}

	for ( const filename of readdirSync( root ).sort() ) {

		if ( filename === 'index.html' || ! filename.endsWith( '.html' ) || byName.has( filename ) ) continue;
		assertCanonicalExampleName( filename, 'Discovered local example name' );
		assertCanonicalLocalRoute( root, filename, root, filename );
		byName.set( filename, { name: filename, path: filename, options: null } );

	}

	return [ ...byName.values() ];

}
