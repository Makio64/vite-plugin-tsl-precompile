#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import { execTrustedGitSync } from './release-state.mjs';

const SCRIPT_DIR = dirname( fileURLToPath( import.meta.url ) );
const REPO_ROOT = resolve( SCRIPT_DIR, '..' );

const PACKAGED_PLUGIN_SKILL_FILES = Object.freeze( {
	'skill/SKILL.md': '.agents/skills/integrate-tsl-precompile/SKILL.md',
	'skill/agents/openai.yaml': '.agents/skills/integrate-tsl-precompile/agents/openai.yaml',
	'skill/references/advanced-capture.md': '.agents/skills/integrate-tsl-precompile/references/advanced-capture.md',
} );

export const PUBLIC_PACKAGES = Object.freeze( [
	Object.freeze( { directory: 'packages/contract', name: '@tsl-precompile/contract' } ),
	Object.freeze( { directory: 'packages/runtime', name: '@tsl-precompile/runtime' } ),
	Object.freeze( {
		directory: 'packages/plugin',
		name: 'vite-plugin-tsl-precompile',
		generatedFiles: PACKAGED_PLUGIN_SKILL_FILES,
	} ),
] );

const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const NPM_TAR_MTIME_SECONDS = 499162500;
const MANIFEST_DEPENDENCY_FIELDS = Object.freeze( [
	'dependencies',
	'devDependencies',
	'optionalDependencies',
	'peerDependencies',
] );

export function tarballName( packageName, version ) {

	return `${ packageName.replace( /^@/, '' ).replace( '/', '-' ) }-${ version }.tgz`;

}

export function computeTarballIntegrity( path ) {

	const bytes = readFileSync( path );
	return computeBytesIntegrity( bytes );

}

function computeBytesIntegrity( bytes ) {

	return {
		bytes: bytes.byteLength,
		integrity: `sha512-${ createHash( 'sha512' ).update( bytes ).digest( 'base64' ) }`,
		shasum: createHash( 'sha1' ).update( bytes ).digest( 'hex' ),
	};

}

export function collectReleaseTarballIntegrity( {
	repoRoot = REPO_ROOT,
	tarballDirectory,
} = {} ) {

	if ( typeof tarballDirectory !== 'string' || tarballDirectory.length === 0 ) {

		throw new Error( 'an explicit private release tarball directory is required' );

	}
	const absoluteTarballDirectory = resolve( tarballDirectory );
	const packages = PUBLIC_PACKAGES.map( ( pkg ) => {

		const manifest = JSON.parse( readFileSync( resolve( repoRoot, pkg.directory, 'package.json' ), 'utf8' ) );
		if ( manifest.name !== pkg.name ) {

			throw new Error( `${ pkg.directory } must publish as ${ pkg.name }, found ${ JSON.stringify( manifest.name ) }` );

		}
		const file = tarballName( pkg.name, manifest.version );
		return {
			config: pkg,
			manifest,
			name: pkg.name,
			version: manifest.version,
			file,
		};

	} );
	const versions = new Set( packages.map( ( pkg ) => pkg.version ) );
	if ( versions.size !== 1 ) throw new Error( 'public tarball versions are not in lockstep' );
	const expectedFiles = packages.map( ( pkg ) => pkg.file ).sort();
	const actualFiles = readdirSync( absoluteTarballDirectory ).sort();
	if ( JSON.stringify( actualFiles ) !== JSON.stringify( expectedFiles ) ) {

		throw new Error(
			`release tarball directory must contain exactly ${ expectedFiles.join( ', ' ) }; ` +
			`found ${ actualFiles.join( ', ' ) || 'none' }`
		);

	}
	return packages.map( ( pkg ) => {

		const { config, manifest, ...identity } = pkg;
		return {
			...identity,
			...assertRegularTarballAndComputeIntegrity( {
				path: resolve( absoluteTarballDirectory, pkg.file ),
				repoRoot,
				config,
				sourceManifest: manifest,
			} ),
		};

	} );

}

function assertRegularTarballAndComputeIntegrity( {
	path,
	repoRoot,
	config,
	sourceManifest,
} ) {

	const stat = lstatSync( path );
	if ( ! stat.isFile() || stat.isSymbolicLink() ) {

		throw new Error( `release tarball must be a regular non-symlink file: ${ path }` );

	}
	const bytes = readFileSync( path );
	assertReleaseTarballArchive( {
		bytes,
		repoRoot,
		config,
		sourceManifest,
		tarballPath: path,
	} );
	return computeBytesIntegrity( bytes );

}

function readTarPathString( bytes, label ) {

	const terminator = bytes.indexOf( 0 );
	const valueBytes = terminator === -1 ? bytes : bytes.subarray( 0, terminator );
	if ( terminator !== -1 && ! isZeroBlock( bytes.subarray( terminator ) ) ) {

		throw new Error( `${ label } has non-zero bytes after its NUL terminator` );

	}
	const value = valueBytes.toString( 'utf8' );
	if ( value.includes( '\uFFFD' ) ) throw new Error( `${ label } is not valid UTF-8` );
	return value;

}

function readTarOctal( bytes, label ) {

	let valueEnd = bytes.byteLength;
	while (
		valueEnd > 0 &&
		( bytes[ valueEnd - 1 ] === 0 || bytes[ valueEnd - 1 ] === 0x20 )
	) {

		valueEnd --;

	}
	const value = bytes.subarray( 0, valueEnd ).toString( 'ascii' );
	if ( ! /^[0-7]+$/.test( value ) ) {

		throw new Error( `release tarball has invalid ${ label } field` );

	}
	const parsed = Number.parseInt( value, 8 );
	if ( ! Number.isSafeInteger( parsed ) || parsed < 0 ) {

		throw new Error( `release tarball has unsafe ${ label } field` );

	}
	return parsed;

}

function assertZeroTarField( bytes, label ) {

	if ( ! isZeroBlock( bytes ) ) throw new Error( `${ label } must be empty` );

}

function headerChecksum( header ) {

	let checksum = 0;
	for ( let index = 0; index < TAR_BLOCK_BYTES; index ++ ) {

		checksum += index >= 148 && index < 156 ? 0x20 : header[ index ];

	}
	return checksum;

}

function isZeroBlock( block ) {

	for ( const byte of block ) if ( byte !== 0 ) return false;
	return true;

}

export function parseReleaseTarArchive( compressedBytes, label = 'release tarball' ) {

	let archive;
	try {

		archive = gunzipSync( compressedBytes );

	} catch ( cause ) {

		throw new Error( `${ label } is not a valid gzip archive`, { cause } );

	}
	if ( ! gzipSync( archive ).equals( compressedBytes ) ) {

		throw new Error( `${ label } does not use the canonical pnpm gzip encoding` );

	}
	if ( archive.byteLength < TAR_END_BYTES || archive.byteLength % TAR_BLOCK_BYTES !== 0 ) {

		throw new Error( `${ label } has a truncated or non-block-aligned tar payload` );

	}

	const entries = [];
	const paths = new Set();
	let sawEnd = false;
	for ( let offset = 0; offset + TAR_BLOCK_BYTES <= archive.byteLength; ) {

		const header = archive.subarray( offset, offset + TAR_BLOCK_BYTES );
		if ( isZeroBlock( header ) ) {

			const secondEndBlock = archive.subarray(
				offset + TAR_BLOCK_BYTES,
				offset + TAR_END_BYTES,
			);
			if ( secondEndBlock.byteLength !== TAR_BLOCK_BYTES || ! isZeroBlock( secondEndBlock ) ) {

				throw new Error( `${ label } is missing the second tar end marker` );

			}
			if ( ! isZeroBlock( archive.subarray( offset ) ) ) {

				throw new Error( `${ label } contains non-zero bytes after its tar end marker` );

			}
			sawEnd = true;
			break;

		}

		const storedChecksum = readTarOctal( header.subarray( 148, 156 ), 'header checksum' );
		if ( storedChecksum !== headerChecksum( header ) ) {

			throw new Error( `${ label } has an invalid tar header checksum` );

		}
		if (
			readTarOctal( header.subarray( 108, 116 ), 'owner id' ) !== 0 ||
			readTarOctal( header.subarray( 116, 124 ), 'group id' ) !== 0
		) {

			throw new Error( `${ label } contains a tar entry with a non-zero owner or group id` );

		}
		if ( readTarOctal( header.subarray( 136, 148 ), 'modification time' ) !== NPM_TAR_MTIME_SECONDS ) {

			throw new Error( `${ label } contains a tar entry with a noncanonical npm modification time` );

		}
		if (
			! header.subarray( 257, 263 ).equals( Buffer.from( 'ustar\0' ) ) ||
			! header.subarray( 263, 265 ).equals( Buffer.from( '00' ) )
		) {

			throw new Error( `${ label } contains a noncanonical ustar header` );

		}
		assertZeroTarField( header.subarray( 157, 257 ), `${ label } tar link target` );
		assertZeroTarField( header.subarray( 265, 297 ), `${ label } tar owner name` );
		assertZeroTarField( header.subarray( 297, 329 ), `${ label } tar group name` );
		if (
			readTarOctal( header.subarray( 329, 337 ), 'device major' ) !== 0 ||
			readTarOctal( header.subarray( 337, 345 ), 'device minor' ) !== 0
		) {

			throw new Error( `${ label } contains a tar entry with non-zero device metadata` );

		}
		assertZeroTarField( header.subarray( 500, 512 ), `${ label } reserved tar header bytes` );
		const name = readTarPathString( header.subarray( 0, 100 ), `${ label } entry name` );
		const prefix = readTarPathString( header.subarray( 345, 500 ), `${ label } entry prefix` );
		const archivePath = `${ prefix ? `${ prefix }/` : '' }${ name }`;
		if ( ! archivePath.startsWith( 'package/' ) ) {

			throw new Error( `${ label } entry must stay below package/: ${ JSON.stringify( archivePath ) }` );

		}
		const packagePath = archivePath.slice( 'package/'.length );
		const segments = packagePath.split( '/' );
		if (
			packagePath.length === 0 ||
			packagePath.includes( '\\' ) ||
			segments.some( ( segment ) => segment === '' || segment === '.' || segment === '..' )
		) {

			throw new Error( `${ label } contains a path-traversal or non-canonical entry: ${ JSON.stringify( archivePath ) }` );

		}
		if ( paths.has( packagePath ) ) {

			throw new Error( `${ label } contains duplicate entry ${ packagePath }` );

		}
		paths.add( packagePath );

		const mode = readTarOctal( header.subarray( 100, 108 ), `mode for ${ packagePath }` );
		if ( mode !== 0o644 && mode !== 0o755 ) {

			throw new Error(
				`${ label } entry ${ packagePath } has unsupported noncanonical mode ${ mode.toString( 8 ) }`,
			);

		}
		const typeByte = header[ 156 ];
		const type = typeByte === 0 ? '\0' : String.fromCharCode( typeByte );
		if ( type !== '\0' && type !== '0' ) {

			throw new Error( `${ label } contains non-regular entry ${ packagePath } (type ${ JSON.stringify( type ) })` );

		}
		const size = readTarOctal( header.subarray( 124, 136 ), `size for ${ packagePath }` );
		const bodyOffset = offset + TAR_BLOCK_BYTES;
		const bodyEnd = bodyOffset + size;
		if ( bodyEnd > archive.byteLength ) {

			throw new Error( `${ label } entry ${ packagePath } extends beyond the tar payload` );

		}
		const paddedBodyEnd = bodyOffset + Math.ceil( size / TAR_BLOCK_BYTES ) * TAR_BLOCK_BYTES;
		if ( paddedBodyEnd > archive.byteLength ) {

			throw new Error( `${ label } entry ${ packagePath } has truncated tar padding` );

		}
		if ( ! isZeroBlock( archive.subarray( bodyEnd, paddedBodyEnd ) ) ) {

			throw new Error( `${ label } entry ${ packagePath } has non-zero tar padding` );

		}
		entries.push( {
			path: packagePath,
			mode,
			bytes: Buffer.from( archive.subarray( bodyOffset, bodyEnd ) ),
		} );
		offset = paddedBodyEnd;

	}
	if ( ! sawEnd ) throw new Error( `${ label } is missing tar end markers` );
	if ( entries.length === 0 ) throw new Error( `${ label } contains no package files` );
	return entries;

}

function gitHeadFiles( repoRoot, pathspecs ) {

	const output = execTrustedGitSync(
		repoRoot,
		[ 'ls-tree', '-r', '-z', 'HEAD', '--', ...new Set( pathspecs ) ],
		{
			encoding: null,
			maxBuffer: 256 * 1024 * 1024,
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		},
	);
	const files = new Map();
	for ( const rawRecord of output.toString( 'utf8' ).split( '\0' ).filter( Boolean ) ) {

		const match = /^([0-7]{6}) ([^ ]+) ([0-9a-f]+)\t([\s\S]+)$/.exec( rawRecord );
		if ( ! match ) throw new Error( `cannot parse Git HEAD tree entry: ${ JSON.stringify( rawRecord ) }` );
		const [ , mode, type, oid, path ] = match;
		if ( files.has( path ) ) throw new Error( `Git HEAD returned duplicate tree entry: ${ path }` );
		files.set( path, { mode, type, oid, path } );

	}

	const blobsByOid = new Map();
	const oids = [ ...new Set(
		[ ...files.values() ]
			.filter( ( entry ) => entry.type === 'blob' )
			.map( ( entry ) => entry.oid ),
	) ];
	if ( oids.length > 0 ) {

		const batch = execTrustedGitSync(
			repoRoot,
			[ 'cat-file', '--batch' ],
			{
				encoding: null,
				input: `${ oids.join( '\n' ) }\n`,
				maxBuffer: 256 * 1024 * 1024,
				stdio: [ 'pipe', 'pipe', 'pipe' ],
			},
		);
		let offset = 0;
		for ( const oid of oids ) {

			const headerEnd = batch.indexOf( 0x0a, offset );
			if ( headerEnd === -1 ) throw new Error( `Git omitted the blob header for ${ oid }` );
			const header = batch.subarray( offset, headerEnd ).toString( 'ascii' );
			const match = /^([0-9a-f]+) blob ([0-9]+)$/.exec( header );
			if ( ! match || match[ 1 ] !== oid ) {

				throw new Error( `Git returned an invalid blob header for ${ oid }: ${ header }` );

			}
			const size = Number( match[ 2 ] );
			if ( ! Number.isSafeInteger( size ) || size < 0 ) {

				throw new Error( `Git returned an unsafe blob size for ${ oid }` );

			}
			const bodyOffset = headerEnd + 1;
			const bodyEnd = bodyOffset + size;
			if ( bodyEnd >= batch.byteLength || batch[ bodyEnd ] !== 0x0a ) {

				throw new Error( `Git returned a truncated blob for ${ oid }` );

			}
			blobsByOid.set( oid, Buffer.from( batch.subarray( bodyOffset, bodyEnd ) ) );
			offset = bodyEnd + 1;

		}
		if ( offset !== batch.byteLength ) throw new Error( 'Git returned unexpected trailing blob bytes' );

	}
	for ( const entry of files.values() ) entry.bytes = blobsByOid.get( entry.oid );
	return files;

}

function assertCommittedRegularSource( headFiles, sourcePath, label ) {

	const source = headFiles.get( sourcePath );
	if ( ! source ) throw new Error( `${ label } is not committed in Git HEAD: ${ sourcePath }` );
	if (
		source.type !== 'blob' ||
		( source.mode !== '100644' && source.mode !== '100755' ) ||
		! Buffer.isBuffer( source.bytes )
	) {

		throw new Error(
			`${ label } must be a regular committed Git blob, found ${ source.mode } ${ source.type }: ${ sourcePath }`,
		);

	}
	return source;

}

function parseCommittedManifest( headFiles, sourcePath, label ) {

	const source = assertCommittedRegularSource( headFiles, sourcePath, label );
	try {

		return {
			manifest: JSON.parse( source.bytes.toString( 'utf8' ) ),
			source,
		};

	} catch ( cause ) {

		throw new Error( `${ label } is not valid JSON: ${ sourcePath }`, { cause } );

	}

}

function expectedPackedManifest( sourceManifest, workspaceManifests ) {

	const expected = structuredClone( sourceManifest );
	if ( expected.scripts ) {

		delete expected.scripts.prepack;
		delete expected.scripts.prepublishOnly;

	}
	const workspaceVersions = new Map(
		workspaceManifests.map( ( manifest ) => [ manifest.name, manifest.version ] ),
	);
	for ( const field of MANIFEST_DEPENDENCY_FIELDS ) {

		for ( const [ name, range ] of Object.entries( expected[ field ] || {} ) ) {

			if ( typeof range !== 'string' || ! range.startsWith( 'workspace:' ) ) continue;
			const version = workspaceVersions.get( name );
			if ( ! version ) throw new Error( `cannot resolve packed workspace dependency ${ name }` );
			if ( range === 'workspace:*' ) {

				expected[ field ][ name ] = version;

			} else if ( range === 'workspace:^' ) {

				expected[ field ][ name ] = `^${ version }`;

			} else if ( range === 'workspace:~' ) {

				expected[ field ][ name ] = `~${ version }`;

			} else {

				throw new Error( `unsupported release workspace dependency range ${ name }: ${ range }` );

			}

		}

	}
	return expected;

}

function normalizeManifestPackagePath( value, label ) {

	if ( typeof value !== 'string' || value.length === 0 ) {

		throw new Error( `${ label } must be a non-empty relative path` );

	}
	let normalized = value;
	while ( normalized.startsWith( './' ) ) normalized = normalized.slice( 2 );
	while ( normalized.endsWith( '/' ) ) normalized = normalized.slice( 0, -1 );
	const segments = normalized.split( '/' );
	if (
		normalized.length === 0 ||
		normalized.startsWith( '/' ) ||
		normalized.includes( '\\' ) ||
		segments.some( ( segment ) => segment === '' || segment === '.' || segment === '..' )
	) {

		throw new Error( `${ label } must be a canonical relative package path: ${ JSON.stringify( value ) }` );

	}
	return normalized;

}

function manifestBinPaths( manifest ) {

	const values = typeof manifest.bin === 'string' ?
		[ manifest.bin ] :
		Object.values( manifest.bin || {} );
	return new Set(
		values.map( ( value ) => normalizeManifestPackagePath( value, 'package.json bin target' ) ),
	);

}

function explicitManifestTargets( manifest ) {

	const targets = manifestBinPaths( manifest );
	if ( manifest.main ) {

		targets.add( normalizeManifestPackagePath( manifest.main, 'package.json main target' ) );

	}
	return targets;

}

function manifestFileRules( manifest ) {

	if ( manifest.files === undefined ) return null;
	if ( ! Array.isArray( manifest.files ) ) throw new Error( 'package.json files must be an array' );
	return manifest.files.map( ( value ) => {

		const normalized = normalizeManifestPackagePath( value, 'package.json files entry' );
		if ( /[*?[\]{}!]/.test( normalized ) ) {

			throw new Error(
				`release integrity requires explicit package.json files paths, found pattern ${ JSON.stringify( value ) }`,
			);

		}
		return normalized;

	} );

}

function isImplicitNpmPackageFile( packagePath ) {

	if ( packagePath.includes( '/' ) ) return false;
	return /^(?:readme|licen[cs]e)(?:\..*)?$/i.test( packagePath );

}

function isPublishablePackagePath( packagePath, fileRules, explicitTargets ) {

	if ( packagePath === 'package.json' || isImplicitNpmPackageFile( packagePath ) ) return true;
	if ( explicitTargets.has( packagePath ) ) return true;
	if ( fileRules === null ) return true;
	return fileRules.some( ( rule ) => packagePath === rule || packagePath.startsWith( `${ rule }/` ) );

}

function expectedPublishEntries( {
	config,
	manifest,
	headFiles,
} ) {

	const fileRules = manifestFileRules( manifest );
	const explicitTargets = explicitManifestTargets( manifest );
	const binPaths = manifestBinPaths( manifest );
	const packagePrefix = `${ config.directory }/`;
	const expected = new Map();
	for ( const [ sourcePath ] of headFiles ) {

		if ( ! sourcePath.startsWith( packagePrefix ) ) continue;
		const packagePath = sourcePath.slice( packagePrefix.length );
		if ( ! isPublishablePackagePath( packagePath, fileRules, explicitTargets ) ) continue;
		expected.set( packagePath, {
			packagePath,
			sourcePath,
			source: assertCommittedRegularSource(
				headFiles,
				sourcePath,
				`publishable package entry ${ packagePath }`,
			),
		} );

	}

	for ( const [ packagePathValue, generatedSource ] of Object.entries( config.generatedFiles || {} ) ) {

		const packagePath = normalizeManifestPackagePath(
			packagePathValue,
			'generated package entry',
		);
		if ( ! isPublishablePackagePath( packagePath, fileRules, explicitTargets ) ) {

			throw new Error(
				`generated package entry ${ packagePath } is excluded by package.json files`,
			);

		}
		if ( expected.has( packagePath ) ) {

			throw new Error( `generated package entry ${ packagePath } conflicts with committed package source` );

		}
		expected.set( packagePath, {
			packagePath,
			sourcePath: generatedSource,
			source: assertCommittedRegularSource(
				headFiles,
				generatedSource,
				`generated package entry ${ packagePath } source`,
			),
			generated: true,
		} );

	}

	if ( ! expected.has( 'package.json' ) ) {

		throw new Error( `${ config.directory }/package.json is not committed in Git HEAD` );

	}
	return { binPaths, expected };

}

export function assertReleaseTarballArchive( {
	bytes,
	repoRoot = REPO_ROOT,
	config,
	sourceManifest,
	tarballPath = 'release tarball',
} ) {

	if ( ! config?.directory || ! config?.name ) throw new Error( 'public package configuration is required' );
	const entries = parseReleaseTarArchive( bytes, tarballPath );
	const entryMap = new Map( entries.map( ( entry ) => [ entry.path, entry ] ) );
	const manifestEntry = entryMap.get( 'package.json' );
	if ( ! manifestEntry ) throw new Error( `${ tarballPath } omits package.json` );

	const packageManifestPath = `${ config.directory }/package.json`;
	const generatedSources = Object.values( config.generatedFiles || {} );
	const workspaceManifestPaths = PUBLIC_PACKAGES.map(
		( pkg ) => `${ pkg.directory }/package.json`,
	);
	const headFiles = gitHeadFiles(
		repoRoot,
		[ config.directory, ...generatedSources, ...workspaceManifestPaths ],
	);
	const {
		manifest: committedManifest,
	} = parseCommittedManifest(
		headFiles,
		packageManifestPath,
		'public package manifest',
	);
	if ( ! isDeepStrictEqual( sourceManifest, committedManifest ) ) {

		throw new Error(
			`${ packageManifestPath } differs from the reviewed manifest committed in Git HEAD`,
		);

	}
	const workspaceManifests = workspaceManifestPaths.map(
		( path ) => parseCommittedManifest(
			headFiles,
			path,
			'public workspace package manifest',
		).manifest,
	);
	let packedManifest;
	try {

		packedManifest = JSON.parse( manifestEntry.bytes.toString( 'utf8' ) );

	} catch ( cause ) {

		throw new Error( `${ tarballPath } contains an invalid package.json`, { cause } );

	}
	const expectedManifest = expectedPackedManifest( committedManifest, workspaceManifests );
	if ( ! isDeepStrictEqual( packedManifest, expectedManifest ) ) {

		throw new Error( `${ tarballPath } package.json does not match the reviewed source manifest and pack rewrites` );

	}
	if ( packedManifest.name !== config.name || packedManifest.version !== committedManifest.version ) {

		throw new Error( `${ tarballPath } package identity/version does not match ${ config.directory }` );

	}

	const {
		binPaths,
		expected: expectedEntries,
	} = expectedPublishEntries( {
		config,
		manifest: committedManifest,
		headFiles,
	} );
	const unexpectedPaths = [ ...entryMap.keys() ]
		.filter( ( path ) => ! expectedEntries.has( path ) )
		.sort();
	if ( unexpectedPaths.length > 0 ) {

		throw new Error(
			`${ tarballPath } contains entries outside the committed publish surface: ${ unexpectedPaths.join( ', ' ) }`,
		);

	}
	const omittedPaths = [ ...expectedEntries.keys() ]
		.filter( ( path ) => ! entryMap.has( path ) )
		.sort();
	if ( omittedPaths.length > 0 ) {

		throw new Error(
			`${ tarballPath } omits required committed publish entries: ${ omittedPaths.join( ', ' ) }`,
		);

	}

	for ( const [ packagePath, expectedEntry ] of expectedEntries ) {

		const entry = entryMap.get( packagePath );
		const expectedMode = binPaths.has( packagePath ) || expectedEntry.source.mode === '100755' ?
			0o755 :
			0o644;
		if ( entry.mode !== expectedMode ) {

			throw new Error(
				`${ tarballPath } entry ${ packagePath } mode ${ entry.mode.toString( 8 ) } ` +
				`does not match committed publish mode ${ expectedMode.toString( 8 ) }`,
			);

		}
		if ( packagePath === 'package.json' ) continue;
		if ( ! entry.bytes.equals( expectedEntry.source.bytes ) ) {

			const kind = expectedEntry.generated ? 'generated entry' : 'entry';
			throw new Error(
				`${ tarballPath } ${ kind } ${ packagePath } differs from committed source ${ expectedEntry.sourcePath }`,
			);

		}

	}

}

export function parseTarballDirectory( argv, environment = process.env ) {

	const normalized = argv[ 0 ] === '--' ? argv.slice( 1 ) : argv;
	const directoryArgs = normalized.filter( ( arg ) => arg.startsWith( '--directory=' ) );
	const unknown = normalized.filter( ( arg ) => ! arg.startsWith( '--directory=' ) );
	if ( unknown.length > 0 ) throw new Error( `unknown option(s): ${ unknown.join( ' ' ) }` );
	if ( directoryArgs.length > 1 ) throw new Error( '--directory may be provided only once' );
	const value = directoryArgs[ 0 ]?.slice( '--directory='.length ) ||
		environment.TSLP_RELEASE_TARBALL_DIR ||
		'';
	if ( ! value ) {

		throw new Error(
			'pass --directory=<private-release-tarball-directory> or set TSLP_RELEASE_TARBALL_DIR'
		);

	}
	return resolve( value );

}

if ( process.argv[ 1 ] && resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {

	try {

		const tarballDirectory = parseTarballDirectory( process.argv.slice( 2 ) );
		console.log( JSON.stringify( collectReleaseTarballIntegrity( { tarballDirectory } ), null, 2 ) );

	} catch ( error ) {

		console.error( `[release-integrity] FAILED: ${ error.message }` );
		process.exitCode = 1;

	}

}
