import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { fingerprintJson, readSafeContainedFile } from './e2e-evidence.mjs';
import { execTrustedGitSync } from '../../../scripts/release-state.mjs';

export const THREE_CHECKOUT_VERSION_MISMATCH = 'TSLP_THREE_CHECKOUT_VERSION_MISMATCH';
export const THREE_SOURCE_INTEGRITY_MISMATCH = 'TSLP_THREE_SOURCE_INTEGRITY_MISMATCH';
export const THREE_R185_OFFICIAL_COMMIT = '2431a09f46f34c560bc8e44b33be0e567723d5b9';
export const THREE_R185_OFFICIAL_TREE = 'db4af93e35bd10c43f957137f7fb44c138e52ea0';

export function fingerprintThreeSourceVerificationRecords( records ) {

	if ( ! Array.isArray( records ) ) throw new TypeError( 'Three source verification records must be an array.' );
	const files = [ ...records ].sort( ( left, right ) => left.path.localeCompare( right.path ) );
	return createHash( 'sha256' )
		.update( files.map( ( entry ) => (
			`${ entry.path }\0${ entry.gitCommit }\0${ entry.gitTree }\0${ entry.gitObjectFormat }\0` +
			`${ entry.gitBlob }\0${ entry.gitMode }\0${ entry.sha256 }\0${ entry.bytes }\n`
		) ).join( '' ) )
		.digest( 'hex' );

}

export class ThreeCheckoutVersionError extends Error {

	constructor( message, options ) {

		super( message, options );
		this.name = 'ThreeCheckoutVersionError';
		this.code = THREE_CHECKOUT_VERSION_MISMATCH;

	}

}

export class ThreeSourceIntegrityError extends Error {

	constructor( message, options ) {

		super( message, options );
		this.name = 'ThreeSourceIntegrityError';
		this.code = THREE_SOURCE_INTEGRITY_MISMATCH;

	}

}

export function assertOfficialThreeR185SourceVerification(
	sourceVerification,
	{
		sourceSnapshot = null,
		sourceFingerprint = null,
		label = 'Three source verification',
	} = {},
) {

	const fail = ( reason ) => {

		throw new Error(
			`${ label } did not verify served sources against the official Three r185 Git tree: ${ reason }.`,
		);

	};
	if (
		sourceVerification?.commit !== THREE_R185_OFFICIAL_COMMIT ||
		sourceVerification?.tree !== THREE_R185_OFFICIAL_TREE ||
		sourceVerification?.objectFormat !== 'sha1' ||
		! Number.isSafeInteger( sourceVerification.trackedBlobCount ) ||
		sourceVerification.trackedBlobCount <= 0 ||
		! Number.isSafeInteger( sourceVerification.verifiedBlobCount ) ||
		sourceVerification.verifiedBlobCount <= 0 ||
		sourceVerification.verifiedBlobCount > sourceVerification.trackedBlobCount ||
		! Array.isArray( sourceVerification.files ) ||
		sourceVerification.files.length === 0 ||
		sourceVerification.verifiedBlobCount !== sourceVerification.files.length ||
		! /^[a-f0-9]{64}$/.test( sourceVerification.verifiedSourcesSha256 || '' )
	) {

		fail( 'the aggregate verification record is invalid' );

	}
	let previousPath = null;
	for ( const record of sourceVerification.files ) {

		const pathSegments = typeof record?.path === 'string' ? record.path.split( '/' ) : [];
		if (
			typeof record?.path !== 'string' ||
			record.path.length === 0 ||
			isAbsolute( record.path ) ||
			record.path.includes( '\\' ) ||
			pathSegments.some( ( segment ) => segment === '' || segment === '.' || segment === '..' ) ||
			( previousPath !== null && previousPath.localeCompare( record.path ) >= 0 ) ||
			record.gitCommit !== THREE_R185_OFFICIAL_COMMIT ||
			record.gitTree !== THREE_R185_OFFICIAL_TREE ||
			record.gitObjectFormat !== 'sha1' ||
			! /^[0-7]{6}$/.test( record.gitMode || '' ) ||
			! /^[a-f0-9]{40}$/.test( record.gitBlob || '' ) ||
			! Number.isSafeInteger( record.bytes ) ||
			record.bytes < 0 ||
			! /^[a-f0-9]{64}$/.test( record.sha256 || '' )
		) {

			fail( `Three source record ${ JSON.stringify( record?.path ?? null ) } is invalid or out of order` );

		}
		previousPath = record.path;

	}
	if (
		sourceVerification.verifiedSourcesSha256 !==
		fingerprintThreeSourceVerificationRecords( sourceVerification.files )
	) {

		fail( 'the aggregate verification digest does not match the exact Three source records' );

	}
	if ( sourceSnapshot === null && sourceFingerprint === null ) return sourceVerification;
	if ( ! sourceSnapshot || ! Array.isArray( sourceSnapshot.files ) || sourceSnapshot.files.length === 0 ) {

		fail( 'the Three source snapshot is empty or missing' );

	}
	if (
		sourceSnapshot.fileCount !== sourceSnapshot.files.length ||
		sourceSnapshot.sha256 !== fingerprintJson( sourceSnapshot.files )
	) {

		fail( 'the Three source snapshot file count or fingerprint is inconsistent' );

	}
	if ( sourceFingerprint !== sourceSnapshot.sha256 ) {

		fail( 'the checkout source fingerprint is not bound to the Three source snapshot' );

	}
	if ( sourceVerification.verifiedBlobCount !== sourceSnapshot.fileCount ) {

		fail( 'the verified blob count does not equal the Three source snapshot file count' );

	}
	const snapshotProofs = sourceSnapshot.files.map( ( sourceRecord ) => {

		if ( ! sourceRecord || Array.isArray( sourceRecord ) || typeof sourceRecord !== 'object' ) {

			fail( 'the Three source snapshot contains a non-object record' );

		}
		const { domain, ...record } = sourceRecord;
		if ( domain !== 'three' ) fail( `source snapshot record ${ JSON.stringify( record.path ?? null ) } is not in the Three domain` );
		return record;

	} );
	if ( fingerprintJson( snapshotProofs ) !== fingerprintJson( sourceVerification.files ) ) {

		fail( 'the self-contained verification records do not exactly match the Three source snapshot' );

	}
	return sourceVerification;

}

function gitBlobId( bytes, objectFormat ) {

	return createHash( objectFormat )
		.update( `blob ${ bytes.length }\0` )
		.update( bytes )
		.digest( 'hex' );

}

function sourcePathBelowRoot( root, file ) {

	let absoluteFile;
	try {

		absoluteFile = realpathSync( resolve( file ) );

	} catch {

		return null;

	}
	const path = relative( root, absoluteFile );
	if (
		! path ||
		path === '..' ||
		path.startsWith( `..${ sep }` ) ||
		isAbsolute( path )
	) {

		return null;

	}
	return path.replaceAll( sep, '/' );

}

/**
 * Bind every accepted working-tree byte sequence to the blob named by one
 * immutable Git commit. The verifier is sticky: once any attempted source
 * fails, a later restore cannot make the run valid again.
 *
 * This helper is generic enough for an isolated regression fixture; canonical
 * callers use createOfficialThreeR185SourceVerifier() below.
 */
export function createThreeGitSourceVerifier( threeRepo, expectedCommit, label = 'Three source' ) {

	if ( typeof expectedCommit !== 'string' || ! /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test( expectedCommit ) ) {

		throw new ThreeSourceIntegrityError( `[${ label }] expected Git commit is invalid.` );

	}
	const root = realpathSync( resolve( threeRepo ) );
	let objectFormat;
	let tree;
	let treeOutput;
	try {

		objectFormat = execTrustedGitSync( root, [ 'rev-parse', '--show-object-format' ], {
			encoding: 'utf8',
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		} ).trim();
		if ( objectFormat !== 'sha1' && objectFormat !== 'sha256' ) {

			throw new Error( `unsupported Git object format ${ JSON.stringify( objectFormat ) }` );

		}
		const resolvedCommit = execTrustedGitSync( root, [ 'rev-parse', `${ expectedCommit }^{commit}` ], {
			encoding: 'utf8',
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		} ).trim();
		if ( resolvedCommit !== expectedCommit ) {

			throw new Error( `commit resolved to ${ resolvedCommit || '<missing>' }` );

		}
		tree = execTrustedGitSync( root, [ 'rev-parse', `${ expectedCommit }^{tree}` ], {
			encoding: 'utf8',
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		} ).trim();
		treeOutput = execTrustedGitSync( root, [ 'ls-tree', '-r', '-z', '--full-tree', expectedCommit ], {
			encoding: 'buffer',
			maxBuffer: 16 * 1024 * 1024,
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		} );

	} catch ( cause ) {

		throw new ThreeSourceIntegrityError(
			`[${ label }] could not read the tracked source tree for Git commit ${ expectedCommit }.`,
			{ cause },
		);

	}

	const blobs = new Map();
	for ( const rawRecord of treeOutput.toString( 'utf8' ).split( '\0' ) ) {

		if ( ! rawRecord ) continue;
		const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec( rawRecord );
		if ( ! match ) {

			throw new ThreeSourceIntegrityError( `[${ label }] Git tree contains an unreadable entry.` );

		}
		if ( match[ 2 ] !== 'blob' ) continue;
		const path = match[ 4 ];
		if ( blobs.has( path ) ) {

			throw new ThreeSourceIntegrityError( `[${ label }] Git tree contains duplicate path ${ JSON.stringify( path ) }.` );

		}
		blobs.set( path, {
			mode: match[ 1 ],
			object: match[ 3 ],
		} );

	}
	if ( blobs.size === 0 ) {

		throw new ThreeSourceIntegrityError( `[${ label }] Git tree contains no tracked blobs.` );

	}

	const verified = new Map();
	let firstFailure = null;
	const fail = ( message ) => {

		if ( ! firstFailure ) firstFailure = new ThreeSourceIntegrityError( `[${ label }] ${ message }` );
		throw firstFailure;

	};
	const verify = ( file, bytes ) => {

		if ( firstFailure ) throw firstFailure;
		if ( ! Buffer.isBuffer( bytes ) ) return fail( 'source verification requires exact Buffer bytes.' );
		const path = sourcePathBelowRoot( root, file );
		if ( ! path ) return fail( `source path ${ resolve( file ) } is outside ${ root }.` );
		const expected = blobs.get( path );
		if ( ! expected ) return fail( `served source ${ path } is not a tracked blob in commit ${ expectedCommit }.` );
		const actualObject = gitBlobId( bytes, objectFormat );
		if ( actualObject !== expected.object ) {

			return fail(
				`served source ${ path } has Git blob ${ actualObject }, expected ${ expected.object } ` +
				`from commit ${ expectedCommit }.`,
			);

		}
		const proof = {
			path,
			bytes: bytes.length,
			gitBlob: expected.object,
			gitMode: expected.mode,
			sha256: createHash( 'sha256' ).update( bytes ).digest( 'hex' ),
		};
		verified.set( path, proof );
		return {
			commit: expectedCommit,
			objectFormat,
			tree,
			...proof,
		};

	};
	const snapshot = () => {

		const files = [ ...verified.values() ]
			.sort( ( left, right ) => left.path.localeCompare( right.path ) )
			.map( ( proof ) => ( {
				...proof,
				gitCommit: expectedCommit,
				gitTree: tree,
				gitObjectFormat: objectFormat,
			} ) );
		return {
			commit: expectedCommit,
			objectFormat,
			tree,
			trackedBlobCount: blobs.size,
			verifiedBlobCount: files.length,
			verifiedSourcesSha256: fingerprintThreeSourceVerificationRecords( files ),
			files,
		};

	};
	return Object.freeze( {
		assertValid() {

			if ( firstFailure ) throw firstFailure;
			return snapshot();

		},
		snapshot,
		verify,
	} );

}

export function createOfficialThreeR185SourceVerifier( threeRepo, label = 'Three r185 source' ) {

	const verifier = createThreeGitSourceVerifier( threeRepo, THREE_R185_OFFICIAL_COMMIT, label );
	if ( verifier.snapshot().tree !== THREE_R185_OFFICIAL_TREE ) {

		throw new ThreeSourceIntegrityError(
			`[${ label }] official commit resolved to unexpected tree ${ verifier.snapshot().tree }.`,
		);

	}
	return verifier;

}

export function readThreeGitIdentity( threeRepo ) {

	try {

		const head = execTrustedGitSync( threeRepo, [ 'rev-parse', 'HEAD' ], {
			encoding: 'utf8',
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		} ).trim();
		const status = execTrustedGitSync( threeRepo, [ 'status', '--porcelain=v1', '--untracked-files=all' ], {
			encoding: 'utf8',
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		} ).trim();
		return {
			available: true,
			head,
			clean: status.length === 0,
			statusSha256: createHash( 'sha256' ).update( status ).digest( 'hex' ),
			statusEntryCount: status ? status.split( '\n' ).length : 0,
		};

	} catch ( error ) {

		return {
			available: false,
			error: String( error?.stderr || error?.message || error ).trim(),
		};

	}

}

/**
 * Read both identities exposed by a three.js source checkout. The package
 * version alone is insufficient: development checkouts can retain an older
 * package.json while src/constants.js has already advanced to the next
 * REVISION.
 */
export function readThreeCheckoutVersion( threeRepo, label = 'batch' ) {

	const constantsPath = join( threeRepo, 'src/constants.js' );
	if ( ! existsSync( constantsPath ) ) {

		throw new ThreeCheckoutVersionError( `[${ label }] cannot verify three.js revision: ${ constantsPath } not found.` );

	}

	const packagePath = join( threeRepo, 'package.json' );
	if ( ! existsSync( packagePath ) ) {

		throw new ThreeCheckoutVersionError( `[${ label }] cannot verify three.js package version: ${ packagePath } not found.` );

	}

	let constantsSource;
	try {

		constantsSource = readSafeContainedFile( threeRepo, constantsPath, {
			label: `${ label } three.js constants`,
		} ).toString( 'utf8' );

	} catch ( cause ) {

		throw new ThreeCheckoutVersionError( `[${ label }] could not read three.js revision from ${ constantsPath }.`, { cause } );

	}

	const revisionMatch = constantsSource.match( /^\s*export\s+const\s+REVISION\s*=\s*['"](\d+)([^'"]*)['"]\s*;/m );
	if ( ! revisionMatch ) {

		throw new ThreeCheckoutVersionError( `[${ label }] could not parse REVISION from ${ constantsPath }.` );

	}

	let packageJson;
	try {

		packageJson = JSON.parse( readSafeContainedFile( threeRepo, packagePath, {
			label: `${ label } three.js package metadata`,
		} ).toString( 'utf8' ) );

	} catch ( cause ) {

		throw new ThreeCheckoutVersionError( `[${ label }] could not parse three.js package metadata from ${ packagePath }.`, { cause } );

	}

	if ( ! packageJson || typeof packageJson.version !== 'string' || packageJson.version.length === 0 ) {

		throw new ThreeCheckoutVersionError( `[${ label }] three.js package metadata at ${ packagePath } has no version.` );

	}

	return {
		revision: `${ revisionMatch[ 1 ] }${ revisionMatch[ 2 ] }`,
		revisionNumber: parseInt( revisionMatch[ 1 ], 10 ),
		packageVersion: packageJson.version,
		constantsPath,
		packagePath,
	};

}

/**
 * Ensure capture/example source and compiler-free replay use the same exact
 * stable three.js release. This is deliberately a release-identity gate, not
 * a source-tree-integrity check: local modifications inside an otherwise
 * matching release remain outside the signed slim-bundle provenance domain.
 * Artifact hashes cannot make one revision's WGSL/runtime topology safe to
 * replay through a bundle built from another revision.
 */
export function assertThreeCheckoutMatchesVersion( threeRepo, expectedPackageVersion, label = 'batch' ) {

	const expectedMatch = typeof expectedPackageVersion === 'string'
		? expectedPackageVersion.match( /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/ )
		: null;
	if ( ! expectedMatch ) {

		throw new ThreeCheckoutVersionError( `[${ label }] signed slim bundle reports invalid three.js package version ${ JSON.stringify( expectedPackageVersion ) }; rebuild the slim bundle.` );

	}

	const checkout = readThreeCheckoutVersion( threeRepo, label );
	const expectedRevision = expectedMatch[ 1 ];
	const mismatches = [];
	if ( checkout.revision !== expectedRevision ) {

		mismatches.push( `src/constants.js reports REVISION=${ JSON.stringify( checkout.revision ) }, expected ${ JSON.stringify( expectedRevision ) }` );

	}
	if ( checkout.packageVersion !== expectedPackageVersion ) {

		mismatches.push( `package.json reports version ${ JSON.stringify( checkout.packageVersion ) }, expected ${ JSON.stringify( expectedPackageVersion ) }` );

	}
	if ( mismatches.length > 0 ) {

		throw new ThreeCheckoutVersionError(
			`[${ label }] three.js checkout ${ threeRepo } does not match the signed slim bundle (${ expectedPackageVersion }): ${ mismatches.join( '; ' ) }. ` +
			`Use the stable release checkout with REVISION=${ JSON.stringify( expectedRevision ) } and package version ${ JSON.stringify( expectedPackageVersion ) } via --three-repo=<path>, ` +
			`or build/pass a slim bundle whose signed stable release matches the checkout. Development REVISION suffixes are intentionally rejected.`,
		);

	}

	return checkout;

}

/**
 * Canonical evidence must come from the immutable upstream r185 commit, not a
 * locally modified checkout that happens to retain the same package version.
 * Diagnostic runs can continue to use the version-only assertion above.
 */
export function assertOfficialThreeR185Checkout( threeRepo, label = 'batch' ) {

	const checkout = assertThreeCheckoutMatchesVersion( threeRepo, '0.185.1', label );
	let commit;
	let status;
	try {

		commit = execTrustedGitSync( threeRepo, [ 'rev-parse', 'HEAD' ], {
			encoding: 'utf8',
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		} ).trim();
		status = execTrustedGitSync( threeRepo, [ 'status', '--porcelain=v1', '--untracked-files=all' ], {
			encoding: 'utf8',
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		} ).trim();

	} catch ( cause ) {

		throw new ThreeCheckoutVersionError(
			`[${ label }] canonical evidence requires a Git checkout of the official r185 tag at ${ THREE_R185_OFFICIAL_COMMIT }.`,
			{ cause },
		);

	}
	if ( commit !== THREE_R185_OFFICIAL_COMMIT ) {

		throw new ThreeCheckoutVersionError(
			`[${ label }] checkout HEAD is ${ commit || '<missing>' }, expected official r185 commit ${ THREE_R185_OFFICIAL_COMMIT }.`,
		);

	}
	if ( status.length > 0 ) {

		const firstEntries = status.split( '\n' ).slice( 0, 8 ).join( ', ' );
		throw new ThreeCheckoutVersionError(
			`[${ label }] official r185 checkout has local or untracked changes (${ firstEntries }). Canonical evidence requires a clean checkout.`,
		);

	}
	return {
		...checkout,
		gitCommit: commit,
		clean: true,
	};

}

/**
 * Refuse to run any batch script against a three.js source tree that
 * identifies as anything below r184. The slim bundle, hashes, and runtime
 * are all pinned to >= r184; mixing in an older revision silently produces
 * stale captures and bogus PSNR misses.
 *
 * Reads the shared checkout descriptor above and exits non-zero with a clear
 * message if its revision is missing or below 184.
 */
export function assertThreeAtLeast184( threeRepo, label = 'batch' ) {

	let checkout;
	try {

		checkout = readThreeCheckoutVersion( threeRepo, label );

	} catch ( error ) {

		console.error( error && error.message || error );
		process.exit( 2 );

	}

	if ( checkout.revisionNumber < 184 ) {

		console.error( `[${ label }] three.js at ${ threeRepo } reports REVISION=${ JSON.stringify( checkout.revision ) } (r${ checkout.revisionNumber }); this harness requires >= r184.` );
		process.exit( 2 );

	}

	return checkout.revision;

}
