import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';

import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';

import { autoMarkSource, injectMarkerBootstrapSource } from '../auto-mark.js';
import {
	instrumentLiveContextDependencies,
	instrumentLiveUniformIdentities,
} from '../babel-transform.js';
import { canonicalModuleIdentity, markerSourceRevision } from '../_shared/module-identity.js';
import {
	normalizeMarkerSourceProvenance,
	recomputeRecordedMarkerSourceRevision,
} from '../_shared/source-provenance.js';

const traverse = _traverse.default || _traverse;
const SOURCE_EXTENSIONS = new Set( [ '.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts', '.cjs', '.cts' ] );
const SKIPPED_DIRECTORIES = new Set( [ '.git', '.vite', 'artifacts', 'coverage', 'dist', 'node_modules' ] );
const PARSER_PLUGINS = [ 'jsx', 'typescript', 'decorators-legacy', 'importAttributes', 'deprecatedImportAssert', 'topLevelAwait' ];
const SUPPORTED_SOURCE_EXTENSIONS = [ ...SOURCE_EXTENSIONS ].sort().join( ', ' );

export const VERIFY_HELP = `
Usage: tsl-precompile-verify [options] [artifact-directory...]

Artifact directories default to: artifacts
Without --source this checks artifact integrity only. For source-marker
coverage and recorded project-local dependency freshness, use:
  tsl-precompile-verify --source src --source-root . artifacts

Options:
  --json                       Print one machine-readable JSON result.
  -s, --source <path>          Scan a source file or directory for expected
                               authored and auto-generated markers. Repeatable.
  --source-root <path>         Project root used for stable auto-marker names
                               (default: current working directory).
                               Supported source extensions: ${ SUPPORTED_SOURCE_EXTENSIONS }.
  --no-auto-mark               Do not expect implicit *NodeMaterial markers.
  --auto-mark-prefix <prefix>  Prefix used by the plugin's autoMark option
                               (default: auto).
  -h, --help                   Display this help message.
`;

export function parseVerifyArgs( args, cwd = process.cwd() ) {

	const options = {
		dirs: [],
		json: false,
		help: false,
		sources: [],
		sourceRoot: resolve( cwd ),
		autoMark: true,
		autoMarkPrefix: 'auto',
	};
	let positionalOnly = false;

	for ( let index = 0; index < args.length; index ++ ) {

		const arg = args[ index ];
		if ( positionalOnly ) {

			options.dirs.push( arg );
			continue;

		}
		if ( arg === '--' ) {

			positionalOnly = true;
			continue;

		}
		if ( arg === '--json' ) {

			options.json = true;
			continue;

		}
		if ( arg === '--help' || arg === '-h' ) {

			options.help = true;
			continue;

		}
		if ( arg === '--no-auto-mark' ) {

			options.autoMark = false;
			continue;

		}

		const parsed = splitOption( arg );
		if ( [ '--source', '-s', '--source-root', '--auto-mark-prefix' ].includes( parsed.name ) ) {

			let value = parsed.value;
			if ( value === null ) {

				value = args[ index + 1 ];
				if ( value === undefined || value.startsWith( '-' ) ) throw new Error( `${ parsed.name } requires a value.` );
				index ++;

			}
			if ( value.length === 0 ) throw new Error( `${ parsed.name } requires a value.` );
			if ( parsed.name === '--source' || parsed.name === '-s' ) options.sources.push( value );
			else if ( parsed.name === '--source-root' ) options.sourceRoot = resolve( cwd, value );
			else options.autoMarkPrefix = value;
			continue;

		}
		if ( arg.startsWith( '-' ) ) throw new Error( `Unknown verify option: ${ arg }` );
		options.dirs.push( arg );

	}

	if ( options.dirs.length === 0 ) options.dirs.push( 'artifacts' );
	return options;

}

export async function collectExpectedMarkerCoverage( {
	cwd = process.cwd(),
	sourcePaths,
	sourceRoot = cwd,
	autoMark = true,
	autoMarkPrefix = 'auto',
	capturedNames = [],
	capturedMarkers = null,
} ) {

	const files = await resolveSourceFiles( sourcePaths, cwd );
	if ( files.length === 0 ) {

		throw new Error( `expected-marker source scan matched zero supported files (${ SUPPORTED_SOURCE_EXTENSIONS }).` );

	}
	const markers = [];
	const issues = [];
	const captured = normalizeCapturedMarkers( capturedMarkers, capturedNames );

	for ( const filename of files ) {

		let source;
		try {

			source = await readFile( filename, 'utf8' );

		} catch ( error ) {

			issues.push( `could not read expected-marker source ${ displaySource( filename, sourceRoot ) }: ${ error.message || String( error ) }` );
			continue;

		}

		try {

			const fileMarkers = collectAuthoredMarkers( source, filename, sourceRoot );
			let transformedSource = source;
			if ( autoMark ) {

				const marked = autoMarkSource( transformedSource, {
					filename,
					root: sourceRoot,
					namePrefix: autoMarkPrefix,
				} );
				if ( marked.injectedNames.length > 0 ) transformedSource = marked.code;
				for ( const marker of marked.injectedMarkers || [] ) fileMarkers.push( {
					name: marker.name,
					source: displaySource( filename, sourceRoot ),
					line: marker.line,
					column: marker.column,
					autoMarked: true,
				} );

			}
			const markerBootstrap = injectMarkerBootstrapSource( transformedSource, { filename } );
			if ( markerBootstrap.touched ) transformedSource = markerBootstrap.code;
			const liveUniformIdentities = instrumentLiveUniformIdentities( transformedSource, {
				filename,
				root: sourceRoot,
			} );
			if ( liveUniformIdentities.touched ) transformedSource = liveUniformIdentities.code;
			const contextDependencies = instrumentLiveContextDependencies( transformedSource, { filename } );
			if ( contextDependencies.touched ) transformedSource = contextDependencies.code;
			await assignMarkerOwners( fileMarkers, transformedSource, filename, sourceRoot, captured );
			markers.push( ...fileMarkers );

		} catch ( error ) {

			issues.push( `could not inspect expected markers in ${ displaySource( filename, sourceRoot ) }: ${ error.message || String( error ) }` );

		}

	}

	const sortedMarkers = markers
		.map( ( marker ) => markerCoverage( marker, captured.get( marker.name ) ) )
		.sort( compareMarkers );
	const missing = sortedMarkers.filter( ( marker ) => ! marker.covered );

	return {
		enabled: true,
		sourceRoot: resolve( sourceRoot ),
		checkedSourceFiles: files.length,
		total: sortedMarkers.length,
		covered: sortedMarkers.length - missing.length,
		missing,
		markers: sortedMarkers,
		issues,
	};

}

async function assignMarkerOwners( markers, transformedSource, filename, sourceRoot, captured ) {

	const ast = parse( transformedSource, {
		sourceType: 'module',
		sourceFilename: filename,
		plugins: PARSER_PLUGINS,
		errorRecovery: false,
	} );
	const { moduleIdentity } = canonicalModuleIdentity( filename, sourceRoot );
	const legacyRevision = markerSourceRevision( transformedSource );
	const callIndexesByName = new Map();
	const ownersByName = new Map();
	traverse( ast, {
		CallExpression( path ) {

			const callee = path.node.callee;
			if ( ! t.isMemberExpression( callee ) || callee.computed || ! t.isIdentifier( callee.property, { name: 'precompile' } ) ) return;
			const nameArg = path.node.arguments[ 0 ];
			if ( ! t.isStringLiteral( nameArg ) ) return;
			const callIndex = callIndexesByName.get( nameArg.value ) || 0;
			callIndexesByName.set( nameArg.value, callIndex + 1 );
			const owners = ownersByName.get( nameArg.value ) || [];
			owners.push( {
				identity: `${ moduleIdentity }:precompile:${ callIndex }`,
				revision: legacyRevision,
			} );
			ownersByName.set( nameArg.value, owners );

		},
	} );
	for ( const marker of markers.slice().sort( compareMarkers ) ) {

		const owners = ownersByName.get( marker.name ) || [];
		const owner = owners.shift();
		if ( ! owner ) throw new Error( `could not derive transformed call-site ownership for marker ${ JSON.stringify( marker.name ) }` );
		marker.sourceIdentity = owner.identity;
		const capturedOwner = captured.get( marker.name )?.owners.find( ( candidate ) => candidate.identity === owner.identity );
		if ( capturedOwner?.provenanceError ) {

			marker.sourceProvenanceIssue = capturedOwner.provenanceError;
			marker.sourceRevision = owner.revision;
			continue;

		}
		if ( capturedOwner?.provenance ) {

			try {

				const recomputed = await recomputeRecordedMarkerSourceRevision( {
					source: transformedSource,
					provenance: capturedOwner.provenance,
					root: sourceRoot,
				} );
				marker.sourceRevision = recomputed.revision;

			} catch ( error ) {

				marker.sourceProvenanceIssue = error.message || String( error );
				marker.sourceRevision = owner.revision;

			}
			continue;

		}
		marker.sourceRevision = owner.revision;

	}

}

function normalizeCapturedMarkers( capturedMarkers, capturedNames ) {

	const normalized = new Map();
	const add = ( name, owners = [], nameOnly = false ) => {

		if ( typeof name !== 'string' || name.length === 0 ) return;
		const current = normalized.get( name ) || { name, owners: [], nameOnly: false };
		const byIdentity = new Map( current.owners.map( ( owner ) => [ owner.identity, owner ] ) );
		for ( const owner of Array.isArray( owners ) ? owners : [] ) {

			if ( ! owner || typeof owner.identity !== 'string' || owner.identity.length === 0 ) continue;
			const normalizedOwner = {
				identity: owner.identity,
				revision: typeof owner.revision === 'string' ? owner.revision.toLowerCase() : null,
			};
			if ( owner.provenance !== undefined ) {

				try {

					normalizedOwner.provenance = normalizeMarkerSourceProvenance(
						owner.provenance,
						`captured marker ${ JSON.stringify( name ) } owner ${ JSON.stringify( owner.identity ) } provenance`,
					);

				} catch ( error ) {

					normalizedOwner.provenanceError = error.message || String( error );

				}

			}
			byIdentity.set( owner.identity, normalizedOwner );

		}
		current.owners = [ ...byIdentity.values() ].sort( ( a, b ) => a.identity.localeCompare( b.identity ) );
		current.nameOnly ||= nameOnly;
		normalized.set( name, current );

	};
	if ( capturedMarkers instanceof Map ) {

		for ( const [ name, value ] of capturedMarkers ) add( name, value?.sourceOwners || value?.owners || value );

	} else if ( Array.isArray( capturedMarkers ) ) {

		for ( const value of capturedMarkers ) add( value?.name, value?.sourceOwners || value?.owners );

	} else if ( capturedMarkers && typeof capturedMarkers === 'object' ) {

		for ( const [ name, value ] of Object.entries( capturedMarkers ) ) add( name, value?.sourceOwners || value?.owners || value );

	}
	for ( const name of capturedNames || [] ) add( name, [], true );
	return normalized;

}

function markerCoverage( marker, capture ) {

	if ( ! capture ) return { ...marker, covered: false, coverageReason: 'missing-artifact' };
	if ( capture.owners.length === 0 ) {

		return {
			...marker,
			covered: capture.nameOnly,
			coverageReason: capture.nameOnly ? 'name-only-legacy-input' : 'missing-source-owners',
		};

	}
	const owner = capture.owners.find( ( candidate ) => candidate.identity === marker.sourceIdentity );
	if ( ! owner ) return { ...marker, covered: false, coverageReason: 'wrong-callsite' };
	if ( marker.sourceProvenanceIssue ) {

		return {
			...marker,
			covered: false,
			coverageReason: 'invalid-source-provenance',
		};

	}
	if ( owner.revision !== marker.sourceRevision ) return { ...marker, covered: false, coverageReason: 'stale-source-revision' };
	return {
		...marker,
		covered: true,
		coverageReason: owner.provenance ? 'exact-owner-dependency-revision' : 'exact-owner-revision',
	};

}

function collectAuthoredMarkers( source, filename, sourceRoot ) {

	const ast = parse( source, {
		sourceType: 'module',
		sourceFilename: filename,
		plugins: PARSER_PLUGINS,
		errorRecovery: false,
	} );
	const markers = [];
	traverse( ast, {
		CallExpression( path ) {

			const callee = path.node.callee;
			if ( ! t.isMemberExpression( callee ) || callee.computed || ! t.isIdentifier( callee.property, { name: 'precompile' } ) ) return;
			const nameArg = path.node.arguments[ 0 ];
			const location = markerLocation( path.node );
			if ( ! t.isStringLiteral( nameArg ) ) {

				throw path.buildCodeFrameError( '.precompile(name) requires a string literal before marker coverage can be verified.' );

			}
			markers.push( {
				name: nameArg.value,
				source: displaySource( filename, sourceRoot ),
				...location,
				autoMarked: false,
			} );

		},
	} );
	return markers;

}

export async function resolveSourceFiles( sourcePaths, cwd ) {

	const files = [];
	for ( const sourcePath of sourcePaths || [] ) {

		const absolute = resolve( cwd, sourcePath );
		let sourceStat;
		try {

			sourceStat = await stat( absolute );

		} catch ( error ) {

			throw new Error( `${ sourcePath }: expected-marker source path does not exist (${ error.message || String( error ) })` );

		}
		if ( sourceStat.isFile() ) {

			const extension = extname( absolute ).toLowerCase();
			if ( ! SOURCE_EXTENSIONS.has( extension ) ) {

				throw new Error( `${ sourcePath }: unsupported expected-marker source extension ${ JSON.stringify( extension || '<none>') }; supported extensions: ${ SUPPORTED_SOURCE_EXTENSIONS }` );

			}
			files.push( absolute );
			continue;

		}
		if ( ! sourceStat.isDirectory() ) throw new Error( `${ sourcePath }: expected-marker source path must be a file or directory` );
		await walkSourceDirectory( absolute, files );

	}
	return [ ...new Set( files ) ].sort();

}

async function walkSourceDirectory( directory, files ) {

	const entries = await readdir( directory, { withFileTypes: true } );
	entries.sort( ( a, b ) => a.name.localeCompare( b.name ) );
	for ( const entry of entries ) {

		if ( entry.isSymbolicLink() ) continue;
		const path = resolve( directory, entry.name );
		if ( entry.isDirectory() ) {

			if ( ! SKIPPED_DIRECTORIES.has( entry.name ) ) await walkSourceDirectory( path, files );
			continue;

		}
		if ( entry.isFile() && SOURCE_EXTENSIONS.has( extname( entry.name ).toLowerCase() ) ) files.push( path );

	}

}

function markerLocation( node ) {

	return {
		line: node.loc?.start.line || 1,
		column: ( node.loc?.start.column || 0 ) + 1,
	};

}

function displaySource( filename, sourceRoot ) {

	const fromRoot = relative( resolve( sourceRoot ), resolve( filename ) ).replace( /\\/g, '/' );
	return fromRoot && ! fromRoot.startsWith( '../' ) ? fromRoot : resolve( filename ).replace( /\\/g, '/' );

}

function compareMarkers( a, b ) {

	return a.source.localeCompare( b.source )
		|| a.line - b.line
		|| a.column - b.column
		|| a.name.localeCompare( b.name );

}

function splitOption( arg ) {

	const equals = arg.indexOf( '=' );
	if ( equals === - 1 ) return { name: arg, value: null };
	return { name: arg.slice( 0, equals ), value: arg.slice( equals + 1 ) };

}
