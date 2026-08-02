import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';

import {
	canonicalModuleIdentity,
	isProjectRootModule,
	markerSourceRevision,
} from './module-identity.js';

const traverse = _traverse.default || _traverse;

export const MARKER_SOURCE_PROVENANCE_SCHEMA = 'marker-source-closure@1';

const MAX_DEPENDENCIES = 4096;
const SCRIPT_EXTENSIONS = new Set( [
	'.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts', '.cjs', '.cts',
] );
const SCRIPT_CONTAINER_EXTENSIONS = new Set( [ '.astro', '.html', '.svelte', '.vue' ] );
const PARSER_PLUGINS = [
	'jsx',
	'typescript',
	'decorators-legacy',
	'importAttributes',
	'deprecatedImportAssert',
	'topLevelAwait',
];

/**
 * Compute the exact project-local static dependency closure used by both the
 * Vite serve and build transforms.
 *
 * Resolution is delegated to Vite so aliases and package-style application
 * imports have one meaning in capture and production. Only filesystem modules
 * canonically contained by the application root are retained. Virtual modules,
 * node_modules, and linked workspaces outside the root are deliberately outside
 * this source-freshness plane.
 */
export async function collectMarkerSourceProvenance( {
	source,
	filename,
	root = process.cwd(),
	resolveDependency,
	addWatchFile = null,
} ) {

	if ( typeof resolveDependency !== 'function' ) {

		throw new TypeError( 'collectMarkerSourceProvenance requires resolveDependency(specifier, importer)' );

	}

	const rootPath = resolve( root );
	const ownerIdentity = canonicalModuleIdentity( filename, rootPath ).moduleIdentity;
	const visited = new Set( [ ownerIdentity ] );
	const dependencies = [];
	const queue = collectStaticModuleSpecifiers( source, filename )
		.map( ( specifier ) => ( { specifier, importer: filename } ) );

	for ( let index = 0; index < queue.length; index ++ ) {

		const request = queue[ index ];
		let resolution;
		try {

			resolution = await resolveDependency( request.specifier, request.importer );

		} catch ( error ) {

			throw provenanceError(
				`could not resolve ${ JSON.stringify( request.specifier ) } imported by ${ displayModule( request.importer, rootPath ) }: ${ error.message || String( error ) }`,
			);

		}

		if ( resolution === null || resolution === undefined || resolution === false ) {

			if ( isLocalSpecifier( request.specifier ) ) {

				throw provenanceError(
					`could not resolve project-local import ${ JSON.stringify( request.specifier ) } from ${ displayModule( request.importer, rootPath ) }`,
				);

			}
			continue;

		}

		const resolved = typeof resolution === 'string' ? { id: resolution } : resolution;
		if ( resolved.external === true ) continue;
		const id = typeof resolved.id === 'string' ? resolved.id : '';
		if ( isVirtualModuleId( id ) ) continue;

		const filesystemId = normalizeFilesystemModuleId( id );
		if ( filesystemId === null ) continue;
		const physicalPath = physicalModulePath( filesystemId );
		if ( physicalPath === null || containsNodeModulesSegment( physicalPath ) ) continue;
		if ( ! isProjectRootModule( filesystemId, rootPath ) ) continue;

		const identity = canonicalModuleIdentity( filesystemId, rootPath ).moduleIdentity;
		if ( visited.has( identity ) ) continue;
		visited.add( identity );
		if ( dependencies.length >= MAX_DEPENDENCIES ) {

			throw provenanceError( `project-local dependency closure exceeds ${ MAX_DEPENDENCIES } modules for ${ displayModule( filename, rootPath ) }` );

		}

		let content;
		try {

			content = await readFile( physicalPath );

		} catch ( error ) {

			throw provenanceError(
				`could not read project-local dependency ${ JSON.stringify( identity ) }: ${ error.message || String( error ) }`,
			);

		}

		const revision = dependencyContentRevision( content );
		dependencies.push( { identity, revision } );
		if ( typeof addWatchFile === 'function' ) addWatchFile( physicalPath );

		if ( isScriptModule( physicalPath ) || isScriptContainerModule( physicalPath ) ) {

			const childSource = content.toString( 'utf8' );
			for ( const specifier of collectModuleDependencySpecifiers( childSource, filesystemId, physicalPath ) ) {

				queue.push( { specifier, importer: filesystemId } );

			}

		}

	}

	dependencies.sort( compareDependencies );
	const provenance = {
		schema: MARKER_SOURCE_PROVENANCE_SCHEMA,
		dependencies: dependencies.map( ( dependency ) => dependency.identity ),
	};
	return {
		revision: markerSourceRevision( source, dependencies ),
		provenance,
	};

}

/**
 * Recompute a captured closure without re-running Vite resolution.
 *
 * The recorded canonical identities are enough for the standalone verify CLI
 * to detect changed, removed, or retargeted project-local files. Production
 * build additionally resolves the graph again, so a changed alias target also
 * changes the closure identity and fails before emission.
 */
export async function recomputeRecordedMarkerSourceRevision( {
	source,
	provenance,
	root = process.cwd(),
} ) {

	const normalized = normalizeMarkerSourceProvenance( provenance );
	const dependencies = [];
	for ( const identity of normalized.dependencies ) {

		const physicalPath = recordedDependencyPath( identity, root );
		let content;
		try {

			content = await readFile( physicalPath );

		} catch ( error ) {

			throw provenanceError(
				`could not read recorded project-local dependency ${ JSON.stringify( identity ) }: ${ error.message || String( error ) }`,
			);

		}
		dependencies.push( {
			identity,
			revision: dependencyContentRevision( content ),
		} );

	}
	return {
		revision: markerSourceRevision( source, dependencies ),
		provenance: {
			schema: MARKER_SOURCE_PROVENANCE_SCHEMA,
			dependencies: normalized.dependencies,
		},
	};

}

export function normalizeMarkerSourceProvenance( value, label = 'marker source provenance' ) {

	if ( ! value || typeof value !== 'object' || Array.isArray( value ) ) {

		throw provenanceError( `${ label } must be an object` );

	}
	if ( value.schema !== MARKER_SOURCE_PROVENANCE_SCHEMA ) {

		throw provenanceError( `${ label }.schema must be ${ JSON.stringify( MARKER_SOURCE_PROVENANCE_SCHEMA ) }` );

	}
	if ( ! Array.isArray( value.dependencies ) ) {

		throw provenanceError( `${ label }.dependencies must be an array` );

	}
	if ( value.dependencies.length > MAX_DEPENDENCIES ) {

		throw provenanceError( `${ label }.dependencies exceeds ${ MAX_DEPENDENCIES } entries` );

	}

	const dependencies = [];
	const identities = new Set();
	for ( let index = 0; index < value.dependencies.length; index ++ ) {

		const entry = value.dependencies[ index ];
		const entryLabel = `${ label }.dependencies[${ index }]`;
		if ( typeof entry !== 'string' || entry.length === 0 || entry.length > 1024 ) {

			throw provenanceError( `${ entryLabel } must be a non-empty module identity of at most 1024 characters` );

		}
		assertSafeRecordedIdentity( entry, entryLabel );
		if ( identities.has( entry ) ) {

			throw provenanceError( `${ label } contains duplicate dependency identity ${ JSON.stringify( entry ) }` );

		}
		identities.add( entry );
		dependencies.push( entry );

	}
	dependencies.sort( compareCodeUnits );
	return {
		schema: MARKER_SOURCE_PROVENANCE_SCHEMA,
		dependencies,
	};

}

export function dependencyContentRevision( content ) {

	return createHash( 'sha256' )
		.update( 'tslp-marker-dependency@1\0' )
		.update( content )
		.digest( 'hex' );

}

function collectStaticModuleSpecifiers( source, filename ) {

	let ast;
	try {

		ast = parse( String( source ), {
			sourceType: 'unambiguous',
			sourceFilename: filename,
			plugins: PARSER_PLUGINS,
			errorRecovery: false,
		} );

	} catch ( error ) {

		throw provenanceError( `could not parse ${ displayModule( filename ) } while collecting static imports: ${ error.message || String( error ) }` );

	}

	const specifiers = new Set();
	const add = ( node ) => {

		if ( t.isStringLiteral( node ) ) specifiers.add( node.value );
		else if ( t.isTemplateLiteral( node ) && node.expressions.length === 0 ) specifiers.add( node.quasis[ 0 ].value.cooked || '' );

	};
	traverse( ast, {
		ImportDeclaration( path ) {

			add( path.node.source );

		},
		ExportNamedDeclaration( path ) {

			add( path.node.source );

		},
		ExportAllDeclaration( path ) {

			add( path.node.source );

		},
		CallExpression( path ) {

			if ( path.node.callee.type === 'Import' ) {

				if ( path.node.arguments.length > 0 ) add( path.node.arguments[ 0 ] );
				return;

			}
			if ( path.node.arguments.length !== 1 ) return;
			if ( ! t.isIdentifier( path.node.callee, { name: 'require' } ) ) return;
			const binding = path.scope.getBinding( 'require' );
			if ( binding ) return;
			add( path.node.arguments[ 0 ] );

		},
		ImportExpression( path ) {

			add( path.node.source );

		},
		TSImportEqualsDeclaration( path ) {

			const reference = path.node.moduleReference;
			if ( t.isTSExternalModuleReference( reference ) ) add( reference.expression );

		},
	} );
	return [ ...specifiers ].sort();

}

function collectModuleDependencySpecifiers( source, filename, physicalPath ) {

	if ( isScriptModule( physicalPath ) ) return collectStaticModuleSpecifiers( source, filename );

	const snippets = [];
	const specifiers = new Set();
	if ( extname( physicalPath ).toLowerCase() === '.astro' ) {

		const frontmatter = String( source ).match( /^\s*---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/ );
		if ( frontmatter ) snippets.push( frontmatter[ 1 ] );

	}

	const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
	for ( const match of String( source ).matchAll( scriptPattern ) ) {

		const attributes = match[ 1 ] || '';
		const src = attributes.match( /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i );
		if ( src ) specifiers.add( src[ 1 ] || src[ 2 ] );
		if ( match[ 2 ].trim().length > 0 ) snippets.push( match[ 2 ] );

	}
	for ( let index = 0; index < snippets.length; index ++ ) {

		for ( const specifier of collectStaticModuleSpecifiers( snippets[ index ], `${ filename }#script-${ index }` ) ) {

			specifiers.add( specifier );

		}

	}
	return [ ...specifiers ].sort();

}

function recordedDependencyPath( identity, root ) {

	assertSafeRecordedIdentity( identity, 'recorded dependency' );
	const queryIndex = identity.indexOf( '?' );
	const relativeFile = queryIndex === - 1 ? identity : identity.slice( 0, queryIndex );
	const rootPath = resolve( root );
	const path = resolve( rootPath, relativeFile );
	if ( ! isProjectRootModule( path, rootPath ) || containsNodeModulesSegment( path ) ) {

		throw provenanceError( `recorded dependency ${ JSON.stringify( identity ) } is outside the project source root` );

	}
	return path;

}

function assertSafeRecordedIdentity( identity, label ) {

	if ( identity.includes( '\0' ) || identity.includes( '\\' ) ) {

		throw provenanceError( `${ label}.identity is not a canonical root-relative module identity` );

	}
	const queryIndex = identity.indexOf( '?' );
	const relativeFile = queryIndex === - 1 ? identity : identity.slice( 0, queryIndex );
	if (
		relativeFile.length === 0
		|| isAbsolute( relativeFile )
		|| relativeFile === '..'
		|| relativeFile.startsWith( '../' )
		|| relativeFile.split( '/' ).includes( '..' )
	) {

		throw provenanceError( `${ label}.identity is not safely contained by the project root` );

	}
	if ( queryIndex !== - 1 && ! /^\?subresource=[a-f0-9]{64}$/.test( identity.slice( queryIndex ) ) ) {

		throw provenanceError( `${ label}.identity has a non-canonical subresource identity` );

	}

}

function physicalModulePath( id ) {

	const raw = String( id || '' ).replace( /^\0/, '' );
	const path = raw.split( /[?#]/, 1 )[ 0 ];
	if ( path.length === 0 || ! isAbsolute( path ) ) return null;
	return resolve( path );

}

function normalizeFilesystemModuleId( id ) {

	const raw = String( id || '' ).replace( /^\0/, '' );
	if ( raw.startsWith( 'file:' ) ) {

		try {

			const url = new URL( raw );
			const path = fileURLToPath( url );
			return `${ path }${ url.search }${ url.hash }`;

		} catch {

			return null;

		}

	}
	return isAbsolute( raw.split( /[?#]/, 1 )[ 0 ] ) ? raw : null;

}

function isVirtualModuleId( id ) {

	const value = String( id || '' );
	return value.length === 0
		|| value.startsWith( '\0' )
		|| value.startsWith( 'virtual:' )
		|| value.startsWith( 'vite:' )
		|| value.startsWith( '/@id/' )
		|| value.startsWith( '/@vite/' );

}

function isLocalSpecifier( specifier ) {

	const value = String( specifier || '' );
	return value.startsWith( './' )
		|| value.startsWith( '../' )
		|| value.startsWith( '/' )
		|| value.startsWith( 'file:' );

}

function isScriptModule( path ) {

	return SCRIPT_EXTENSIONS.has( extname( path ).toLowerCase() );

}

function isScriptContainerModule( path ) {

	return SCRIPT_CONTAINER_EXTENSIONS.has( extname( path ).toLowerCase() );

}

function containsNodeModulesSegment( path ) {

	const normalized = String( path ).replace( /\\/g, '/' );
	return normalized === 'node_modules'
		|| normalized.startsWith( 'node_modules/' )
		|| normalized.includes( '/node_modules/' );

}

function compareDependencies( a, b ) {

	return compareCodeUnits( a.identity, b.identity ) || compareCodeUnits( a.revision, b.revision );

}

function compareCodeUnits( a, b ) {

	const left = String( a );
	const right = String( b );
	return left < right ? - 1 : left > right ? 1 : 0;

}

function displayModule( filename, root = process.cwd() ) {

	const clean = String( filename || '<unknown>' ).split( /[?#]/, 1 )[ 0 ];
	if ( ! isAbsolute( clean ) ) return String( filename || '<unknown>' );
	const displayed = relative( resolve( root ), clean );
	return displayed && ! displayed.startsWith( '..' + sep ) ? displayed : clean;

}

function provenanceError( message ) {

	const error = new Error( `[tsl-precompile] source provenance: ${ message }` );
	error.code = 'TSLP_SOURCE_PROVENANCE';
	return error;

}
