/**
 * Node-only provenance contract for the checked prebuilt slim renderer.
 *
 * This module is deliberately not re-exported from the browser-safe contract
 * barrel. Build tooling and the Vite plugin import its explicit package
 * subpath so filesystem and crypto dependencies cannot leak into runtime
 * bundles.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';

import { stableJsonStringify } from './stable-json.js';

export const SLIM_BUNDLE_SOURCE_SCHEMA = 'tslp-slim-bundle-sources@1';
export const SLIM_BUNDLE_PROVENANCE_SCHEMA = 'tslp-slim-bundle-provenance@1';
export const SLIM_BUNDLE_BUILD_TOOLCHAIN_VERSION = 'tslp-slim-rollup@1';
export const SLIM_BUNDLE_FILE_NAME = 'three.webgpu.slim.js';
export const SLIM_BUNDLE_METADATA_FILE_NAME = 'three.webgpu.slim.meta.json';

const STAMP_PREFIX = '/*!@tsl-precompile/slim-bundle:';
const STAMP_SUFFIX = '*/';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_KEYS = [ 'three', 'policy', 'artifactToolchain', 'buildToolchain' ];

export const SLIM_BUNDLE_PROVENANCE_ERROR_CODES = Object.freeze( {
	INPUT_MISSING: 'SLIM_BUNDLE_INPUT_MISSING',
	METADATA_INVALID: 'SLIM_BUNDLE_METADATA_INVALID',
	STAMP_MISSING: 'SLIM_BUNDLE_STAMP_MISSING',
	INTEGRITY_MISMATCH: 'SLIM_BUNDLE_INTEGRITY_MISMATCH',
	SOURCE_STALE: 'SLIM_BUNDLE_SOURCE_STALE',
	VERSION_MISMATCH: 'SLIM_BUNDLE_VERSION_MISMATCH',
} );

export class SlimBundleProvenanceError extends Error {

	constructor( code, message, options ) {

		super( message, options );
		this.name = 'SlimBundleProvenanceError';
		this.code = code;

	}

}

/**
 * Build the exact, shared input scope used by both the Rollup producer and
 * the Vite startup verifier. Absolute roots are intentionally excluded from
 * persisted data; only stable logical paths feed the hashes.
 */
export function createSlimBundleSourceInputs( {
	threePackageRoot,
	runtimePackageRoot,
	contractPackageRoot,
	pluginPackageRoot,
} ) {

	for ( const [ name, value ] of Object.entries( {
		threePackageRoot,
		runtimePackageRoot,
		contractPackageRoot,
		pluginPackageRoot,
	} ) ) {

		if ( typeof value !== 'string' || value.length === 0 ) {

			throw new TypeError( `${ name } must be a non-empty path string` );

		}

	}

	return {
		threeSourceDirectory: resolve( threePackageRoot, 'src' ),
		runtimeSourceDirectory: resolve( runtimePackageRoot, 'src' ),
		contractSourceDirectory: resolve( contractPackageRoot, 'src' ),
		rewriteImplementationFile: resolve( pluginPackageRoot, 'src/three-rewrite.js' ),
		rewriteVendorDirectory: resolve( pluginPackageRoot, 'src/vendor' ),
		// pnpm/npm rewrite workspace protocols, scripts, property order, and
		// formatting while packing. Hash the shipped build recipe itself; exact
		// Three/policy/artifact/build-toolchain identities are framed separately.
		rollupRecipeFiles: [
			{ name: 'runtime/rollup.config.js', file: resolve( runtimePackageRoot, 'rollup.config.js' ) },
			{ name: 'runtime/build-tools/slim-bundle-analysis.js', file: resolve( runtimePackageRoot, 'build-tools/slim-bundle-analysis.js' ) },
		],
	};

}

export function createSlimBundleVersionIdentity( {
	threeVersion,
	policyVersion,
	artifactToolchainVersion,
	buildToolchainVersion = SLIM_BUNDLE_BUILD_TOOLCHAIN_VERSION,
} ) {

	return normalizeVersions( {
		three: threeVersion,
		policy: policyVersion,
		artifactToolchain: artifactToolchainVersion,
		buildToolchain: buildToolchainVersion,
	} );

}

/**
 * Hash every source input using logical group/relative names. Moving an
 * otherwise identical installation therefore does not invalidate the bundle,
 * while changing any file byte, recipe, or declared toolchain identity does.
 */
export async function computeSlimBundleSourceFingerprint( inputs, versions ) {

	const normalizedVersions = normalizeVersions( versions );
	const groups = await Promise.all( [
		hashDirectoryGroup( 'three/src', inputs && inputs.threeSourceDirectory ),
		hashDirectoryGroup( 'runtime/src', inputs && inputs.runtimeSourceDirectory ),
		hashDirectoryGroup( 'contract/src', inputs && inputs.contractSourceDirectory ),
		hashExplicitFileGroup( 'plugin/rewrite', [ {
			name: 'src/three-rewrite.js',
			file: inputs && inputs.rewriteImplementationFile,
		} ] ),
		hashDirectoryGroup( 'plugin/vendor', inputs && inputs.rewriteVendorDirectory ),
		hashExplicitFileGroup( 'rollup/recipe', inputs && inputs.rollupRecipeFiles ),
	] );

	groups.sort( ( a, b ) => compareCodeUnits( a.name, b.name ) );
	const descriptor = {
		schema: SLIM_BUNDLE_SOURCE_SCHEMA,
		groups,
		versions: normalizedVersions,
	};

	return {
		...descriptor,
		fingerprint: sha256Bytes( stableJsonStringify( descriptor ) ),
	};

}

export function formatSlimBundleStamp( { sourceFingerprint, versions } ) {

	assertSha256( sourceFingerprint, 'sourceFingerprint', SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID );
	const stamp = {
		schema: SLIM_BUNDLE_PROVENANCE_SCHEMA,
		sourceFingerprint,
		versions: normalizeVersions( versions ),
	};
	return `${ STAMP_PREFIX }${ stableJsonStringify( stamp ) }${ STAMP_SUFFIX }`;

}

export function parseSlimBundleStamp( bundleSource ) {

	const text = toBuffer( bundleSource, 'bundleSource' ).toString( 'utf8' );
	if ( ! text.startsWith( STAMP_PREFIX ) ) {

		throw provenanceError(
			SLIM_BUNDLE_PROVENANCE_ERROR_CODES.STAMP_MISSING,
			'the slim bundle does not begin with its required embedded provenance stamp',
		);

	}

	const end = text.indexOf( STAMP_SUFFIX, STAMP_PREFIX.length );
	if ( end === - 1 ) {

		throw provenanceError(
			SLIM_BUNDLE_PROVENANCE_ERROR_CODES.STAMP_MISSING,
			'the slim bundle provenance stamp is truncated',
		);

	}

	let stamp;
	try {

		stamp = JSON.parse( text.slice( STAMP_PREFIX.length, end ) );

	} catch ( cause ) {

		throw provenanceError(
			SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID,
			'the slim bundle provenance stamp is not valid JSON',
			cause,
		);

	}

	if ( ! stamp || stamp.schema !== SLIM_BUNDLE_PROVENANCE_SCHEMA ) {

		throw provenanceError(
			SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID,
			`the slim bundle stamp schema must be ${ JSON.stringify( SLIM_BUNDLE_PROVENANCE_SCHEMA ) }`,
		);

	}
	assertSha256( stamp.sourceFingerprint, 'stamp.sourceFingerprint', SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID );
	return {
		schema: stamp.schema,
		sourceFingerprint: stamp.sourceFingerprint,
		versions: normalizeVersions( stamp.versions, SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID, 'stamp.versions' ),
	};

}

export function createSlimBundleMetadata( {
	bundleSource,
	bundleFile = SLIM_BUNDLE_FILE_NAME,
	source,
	versions,
} ) {

	const bytes = toBuffer( bundleSource, 'bundleSource' );
	const normalizedSource = normalizeSourceDescriptor( source );
	return {
		schema: SLIM_BUNDLE_PROVENANCE_SCHEMA,
		source: normalizedSource,
		bundle: {
			file: assertNonEmptyString( bundleFile, 'bundleFile' ),
			bytes: bytes.length,
			sha256: sha256Bytes( bytes ),
		},
		versions: normalizeVersions( versions ),
	};

}

export function serializeSlimBundleMetadata( metadata ) {

	return `${ stableJsonStringify( parseSlimBundleMetadata( metadata ) ) }\n`;

}

export function parseSlimBundleMetadata( value ) {

	let metadata = value;
	if ( typeof value === 'string' || value instanceof Uint8Array ) {

		try {

			metadata = JSON.parse( toBuffer( value, 'metadata' ).toString( 'utf8' ) );

		} catch ( cause ) {

			throw provenanceError(
				SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID,
				'the slim bundle provenance sidecar is not valid JSON',
				cause,
			);

		}

	}

	if ( ! metadata || typeof metadata !== 'object' || Array.isArray( metadata ) ) {

		throw provenanceError( SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID, 'the slim bundle provenance sidecar must contain an object' );

	}
	if ( metadata.schema !== SLIM_BUNDLE_PROVENANCE_SCHEMA ) {

		throw provenanceError(
			SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID,
			`the slim bundle sidecar schema must be ${ JSON.stringify( SLIM_BUNDLE_PROVENANCE_SCHEMA ) }`,
		);

	}

	const bundle = metadata.bundle;
	if ( ! bundle || typeof bundle !== 'object' ) {

		throw provenanceError( SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID, 'the slim bundle sidecar is missing bundle identity' );

	}
	const file = assertNonEmptyString( bundle.file, 'metadata.bundle.file' );
	if ( ! Number.isSafeInteger( bundle.bytes ) || bundle.bytes < 0 ) {

		throw provenanceError( SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID, 'metadata.bundle.bytes must be a non-negative safe integer' );

	}
	assertSha256( bundle.sha256, 'metadata.bundle.sha256', SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID );

	return {
		schema: metadata.schema,
		source: normalizeSourceDescriptor( metadata.source ),
		bundle: { file, bytes: bundle.bytes, sha256: bundle.sha256 },
		versions: normalizeVersions( metadata.versions, SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID, 'metadata.versions' ),
	};

}

/**
 * Verify a final stamped bundle against its sidecar and the source tree that
 * is installed beside it. The final bundle SHA lives only in the sidecar so
 * the embedded stamp never attempts a circular self-hash.
 */
export function verifySlimBundleProvenance( {
	bundleSource,
	metadata,
	expectedSource,
	expectedVersions,
	expectedBundleFile = SLIM_BUNDLE_FILE_NAME,
} ) {

	const bytes = toBuffer( bundleSource, 'bundleSource' );
	const parsedMetadata = parseSlimBundleMetadata( metadata );
	const stamp = parseSlimBundleStamp( bytes );
	const versions = normalizeVersions( expectedVersions );
	const source = normalizeSourceDescriptor( expectedSource );

	if ( parsedMetadata.bundle.file !== expectedBundleFile ) {

		throw provenanceError(
			SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID,
			`the sidecar describes ${ JSON.stringify( parsedMetadata.bundle.file ) }, expected ${ JSON.stringify( expectedBundleFile ) }`,
		);

	}
	if ( parsedMetadata.bundle.bytes !== bytes.length || parsedMetadata.bundle.sha256 !== sha256Bytes( bytes ) ) {

		throw provenanceError(
			SLIM_BUNDLE_PROVENANCE_ERROR_CODES.INTEGRITY_MISMATCH,
			'the slim bundle bytes do not match the size and SHA-256 recorded by its sidecar',
		);

	}
	if ( parsedMetadata.source.fingerprint !== stamp.sourceFingerprint ) {

		throw provenanceError(
			SLIM_BUNDLE_PROVENANCE_ERROR_CODES.INTEGRITY_MISMATCH,
			'the embedded source fingerprint does not match the provenance sidecar',
		);

	}
	assertVersionIdentity( parsedMetadata.versions, stamp.versions, 'embedded stamp and sidecar', SLIM_BUNDLE_PROVENANCE_ERROR_CODES.INTEGRITY_MISMATCH );
	assertVersionIdentity( parsedMetadata.versions, versions, 'installed build inputs', SLIM_BUNDLE_PROVENANCE_ERROR_CODES.VERSION_MISMATCH );

	if ( parsedMetadata.source.schema !== source.schema || parsedMetadata.source.fingerprint !== source.fingerprint ) {

		throw provenanceError(
			SLIM_BUNDLE_PROVENANCE_ERROR_CODES.SOURCE_STALE,
			`the slim bundle source fingerprint ${ parsedMetadata.source.fingerprint } is stale; installed inputs produce ${ source.fingerprint }`,
		);

	}

	return { metadata: parsedMetadata, stamp };

}

export function sha256Bytes( value ) {

	return createHash( 'sha256' ).update( toBuffer( value, 'value' ) ).digest( 'hex' );

}

async function hashDirectoryGroup( name, directory ) {

	if ( typeof directory !== 'string' || directory.length === 0 ) {

		throw provenanceError( SLIM_BUNDLE_PROVENANCE_ERROR_CODES.INPUT_MISSING, `${ name } source directory is not configured` );

	}

	let files;
	try {

		files = await listFiles( directory );

	} catch ( cause ) {

		throw provenanceError( SLIM_BUNDLE_PROVENANCE_ERROR_CODES.INPUT_MISSING, `cannot read required ${ name } source directory at ${ directory }`, cause );

	}
	return hashFileGroup( name, files.map( ( file ) => ( {
		name: normalizeLogicalPath( relative( directory, file ) ),
		file,
	} ) ) );

}

async function hashExplicitFileGroup( name, entries ) {

	if ( ! Array.isArray( entries ) || entries.length === 0 ) {

		throw provenanceError( SLIM_BUNDLE_PROVENANCE_ERROR_CODES.INPUT_MISSING, `${ name } files are not configured` );

	}
	return hashFileGroup( name, entries );

}

async function hashFileGroup( name, entries ) {

	const normalized = entries.map( ( entry ) => {

		const file = typeof entry === 'string' ? entry : entry && entry.file;
		const logicalName = typeof entry === 'string' ? basename( entry ) : entry && entry.name;
		if ( typeof file !== 'string' || file.length === 0 || typeof logicalName !== 'string' || logicalName.length === 0 ) {

			throw provenanceError( SLIM_BUNDLE_PROVENANCE_ERROR_CODES.INPUT_MISSING, `${ name } contains an invalid file descriptor` );

		}
		return { file, name: normalizeLogicalPath( logicalName ) };

	} ).sort( ( a, b ) => compareCodeUnits( a.name, b.name ) );

	const seen = new Set();
	const hash = createHash( 'sha256' );
	writeHashFrame( hash, `tslp-slim-source-group@1:${ name }` );
	let bytes = 0;

	for ( const entry of normalized ) {

		if ( seen.has( entry.name ) ) {

			throw provenanceError( SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID, `${ name } repeats logical path ${ JSON.stringify( entry.name ) }` );

		}
		seen.add( entry.name );

		let contents;
		try {

			contents = await readFile( entry.file );

		} catch ( cause ) {

			throw provenanceError( SLIM_BUNDLE_PROVENANCE_ERROR_CODES.INPUT_MISSING, `cannot read required ${ name } input ${ entry.file }`, cause );

		}
		bytes += contents.length;
		writeHashFrame( hash, entry.name );
		writeHashFrame( hash, contents );

	}

	return {
		name,
		fileCount: normalized.length,
		bytes,
		sha256: hash.digest( 'hex' ),
	};

}

async function listFiles( directory ) {

	const entries = await readdir( directory, { withFileTypes: true } );
	const files = [];
	for ( const entry of entries.sort( ( a, b ) => compareCodeUnits( a.name, b.name ) ) ) {

		const path = join( directory, entry.name );
		if ( entry.isDirectory() ) {

			files.push( ...await listFiles( path ) );

		} else if ( entry.isFile() ) {

			files.push( path );

		} else {

			throw new Error( `unsupported non-file input ${ path }` );

		}

	}
	return files;

}

function normalizeSourceDescriptor( source ) {

	if ( ! source || source.schema !== SLIM_BUNDLE_SOURCE_SCHEMA ) {

		throw provenanceError(
			SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID,
			`source provenance schema must be ${ JSON.stringify( SLIM_BUNDLE_SOURCE_SCHEMA ) }`,
		);

	}
	assertSha256( source.fingerprint, 'source.fingerprint', SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID );
	if ( ! Array.isArray( source.groups ) ) {

		throw provenanceError( SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID, 'source.groups must be an array' );

	}

	const groups = source.groups.map( ( group, index ) => {

		if ( ! group || typeof group !== 'object' ) {

			throw provenanceError( SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID, `source.groups[${ index }] must be an object` );

		}
		const name = assertNonEmptyString( group.name, `source.groups[${ index }].name` );
		if ( ! Number.isSafeInteger( group.fileCount ) || group.fileCount < 0 || ! Number.isSafeInteger( group.bytes ) || group.bytes < 0 ) {

			throw provenanceError( SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID, `source group ${ JSON.stringify( name ) } has invalid counts` );

		}
		assertSha256( group.sha256, `source group ${ name } sha256`, SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID );
		return { name, fileCount: group.fileCount, bytes: group.bytes, sha256: group.sha256 };

	} ).sort( ( a, b ) => compareCodeUnits( a.name, b.name ) );

	return { schema: source.schema, fingerprint: source.fingerprint, groups };

}

function normalizeVersions( versions, code = SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID, label = 'versions' ) {

	if ( ! versions || typeof versions !== 'object' || Array.isArray( versions ) ) {

		throw provenanceError( code, `${ label } must be an object` );

	}
	const normalized = {};
	for ( const key of VERSION_KEYS ) normalized[ key ] = assertNonEmptyString( versions[ key ], `${ label }.${ key }`, code );
	return normalized;

}

function assertVersionIdentity( actual, expected, label, code ) {

	for ( const key of VERSION_KEYS ) {

		if ( actual[ key ] === expected[ key ] ) continue;
		throw provenanceError(
			code,
			`${ label } disagree on ${ key }: recorded ${ JSON.stringify( actual[ key ] ) }, expected ${ JSON.stringify( expected[ key ] ) }`,
		);

	}

}

function assertSha256( value, label, code ) {

	if ( typeof value !== 'string' || ! SHA256_PATTERN.test( value ) ) {

		throw provenanceError( code, `${ label } must be a lowercase SHA-256 digest` );

	}

}

function assertNonEmptyString( value, label, code = SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID ) {

	if ( typeof value !== 'string' || value.length === 0 ) throw provenanceError( code, `${ label } must be a non-empty string` );
	return value;

}

function normalizeLogicalPath( value ) {

	return value.split( sep ).join( '/' );

}

function compareCodeUnits( a, b ) {

	return a < b ? - 1 : a > b ? 1 : 0;

}

function writeHashFrame( hash, value ) {

	const bytes = toBuffer( value, 'hash frame' );
	hash.update( Buffer.from( `${ bytes.length }:` ) );
	hash.update( bytes );
	hash.update( ';' );

}

function toBuffer( value, label ) {

	if ( typeof value === 'string' ) return Buffer.from( value );
	if ( value instanceof Uint8Array ) return Buffer.from( value.buffer, value.byteOffset, value.byteLength );
	throw new TypeError( `${ label } must be a string or Uint8Array` );

}

function provenanceError( code, message, cause ) {

	return new SlimBundleProvenanceError( code, message, cause ? { cause } : undefined );

}
