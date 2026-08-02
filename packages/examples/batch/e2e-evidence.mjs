import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { assertCanonicalExampleId } from './output-path-safety.mjs';

export const E2E_EVIDENCE_SCHEMA_VERSION = 2;
export const E2E_EVIDENCE_MANIFEST = 'evidence-manifest.json';
export const E2E_COVERAGE_JSON = 'coverage-summary.json';
export const E2E_EVIDENCE_SET_JSON = 'coverage-evidence-set.json';
export const E2E_EVIDENCE_AFFECTING_ENV_KEYS = Object.freeze( [
	'TSLP_DEBUG_CLOCK',
	'TSLP_DEBUG_FRAME_TEXTURES',
	'TSLP_DEBUG_FRAME_TEXTURE_SNAPSHOT',
	'TSLP_DEBUG_IBL_BINDINGS',
	'TSLP_DEBUG_LIGHT_LINKAGE',
	'TSLP_DEBUG_OBJECT_UBO',
	'TSLP_DEBUG_PMREM_READBACK',
	'TSLP_DEBUG_REFLECTOR_BINDINGS',
	'TSLP_DEBUG_REPLAY_OPS',
	'TSLP_DEBUG_SHADOW_BINDINGS',
	'TSLP_DEBUG_SHADOW_COVERAGE',
	'TSLP_DEBUG_SSR_RESOURCES',
	'TSLP_E2E_BROWSER_RESPAWN_DELAY_MS',
	'TSLP_E2E_MAX_RUNS_PER_BROWSER',
] );

/**
 * Non-import inputs and top-level graders that define one E2E evidence run.
 * Repository-local static imports are expanded recursively from these entries
 * by resolveE2EHarnessSourceFiles(), so a newly introduced helper cannot be
 * omitted from provenance merely because this list was not hand-maintained.
 */
export const E2E_HARNESS_ENTRY_PATHS = Object.freeze( [
	'package.json',
	'pnpm-lock.yaml',
	'packages/examples/batch/package.json',
	'packages/examples/batch/run-e2e.mjs',
	'packages/examples/batch/example-catalogue.json',
	'packages/examples/batch/coverage-config.json',
	'packages/examples/batch/cube-capture-prearm.mjs',
	'packages/examples/batch/layered-capture-prearm.mjs',
	'packages/examples/batch/e2e-capture-setup-adapter.js',
	'packages/examples/batch/run-coverage-summary.mjs',
	'packages/plugin/src/babel-transform.js',
	'scripts/release-semver.mjs',
	'scripts/release-state.mjs',
] );

const STATIC_MODULE_SPECIFIER_PATTERNS = Object.freeze( [
	/(?:^|[;\n])\s*import\s+(?:[^"'`;]*?\s+from\s*)?(["'])([^"']+)\1/gm,
	/(?:^|[;\n])\s*export\s+[^"'`;]*?\s+from\s*(["'])([^"']+)\1/gm,
	/\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g,
] );

function staticModuleSpecifiers( source ) {

	const found = new Set();
	for ( const pattern of STATIC_MODULE_SPECIFIER_PATTERNS ) {

		pattern.lastIndex = 0;
		for ( let match = pattern.exec( source ); match; match = pattern.exec( source ) ) {

			found.add( match[ 2 ] );

		}

	}
	return [ ...found ];

}

function repositoryFileIdentity( repositoryRoot, file ) {

	let realFile;
	try {

		realFile = realpathSync( resolve( file ) );

	} catch {

		return null;

	}
	const path = relative( repositoryRoot, realFile );
	if (
		! path ||
		path === '..' ||
		path.startsWith( `..${ sep }` ) ||
		isAbsolute( path ) ||
		path === 'node_modules' ||
		path.startsWith( `node_modules${ sep }` )
	) return null;
	return { file: realFile, path };

}

/**
 * Resolve the recursive repository-local static import closure of the E2E
 * harness. External dependencies stay bound by the lockfile/toolchain; local
 * workspace package imports resolve through their package exports back into
 * repository source and therefore participate in the evidence fingerprint.
 */
export function resolveRepositoryStaticImportClosure( entryFiles, repositoryRoot ) {

	const root = realpathSync( resolve( repositoryRoot ) );
	const queue = Array.isArray( entryFiles ) ? entryFiles.map( ( file ) => resolve( root, file ) ) : [];
	if ( queue.length === 0 ) throw new Error( 'Repository static import closure requires at least one entry file.' );
	const files = new Map();
	while ( queue.length > 0 ) {

		const candidate = repositoryFileIdentity( root, queue.shift() );
		if ( ! candidate || files.has( candidate.file ) ) continue;
		files.set( candidate.file, candidate.path );
		if ( ! [ '.js', '.mjs', '.cjs' ].includes( extname( candidate.file ) ) ) continue;
		const source = readFileSync( candidate.file, 'utf8' );
		const importerRequire = createRequire( candidate.file );
		for ( const specifier of staticModuleSpecifiers( source ) ) {

			if ( specifier.startsWith( 'node:' ) ) continue;
			let dependency;
			try {

				dependency = importerRequire.resolve( specifier );

			} catch {

				continue;

			}
			const local = repositoryFileIdentity( root, dependency );
			if ( local && ! files.has( local.file ) ) queue.push( local.file );

		}

	}
	return [ ...files.entries() ]
		.sort( ( left, right ) => left[ 1 ].localeCompare( right[ 1 ] ) )
		.map( ( [ file ] ) => file );

}

export function resolveE2EHarnessSourceFiles( repositoryRoot ) {

	return resolveRepositoryStaticImportClosure( E2E_HARNESS_ENTRY_PATHS, repositoryRoot );

}

export function evidenceAffectingEnvironmentOverrides( environment = process.env ) {

	return E2E_EVIDENCE_AFFECTING_ENV_KEYS.filter( ( key ) => {

		const value = environment?.[ key ];
		if ( key.startsWith( 'TSLP_DEBUG_' ) ) return value === '1';
		return value !== undefined && value !== '';

	} );

}

export function sha256( value ) {

	return createHash( 'sha256' ).update( value ).digest( 'hex' );

}

/**
 * Re-derive a recorded source snapshot from current bytes. Callers supply the
 * expected domain root and any behavior inputs that must be present; every
 * recorded file is also checked, so a stale dynamically loaded local asset
 * cannot survive merely because it is not in the minimum required set.
 */
export function assertCurrentEvidenceSourceSnapshot( snapshot, {
	domain,
	root,
	label = 'Evidence source snapshot',
	requiredPaths = [],
} ) {

	if ( ! snapshot || ! Array.isArray( snapshot.files ) || snapshot.files.length === 0 ) {

		throw new Error( `${ label } has no ${ domain } source snapshot.` );

	}
	if (
		snapshot.fileCount !== snapshot.files.length ||
		snapshot.sha256 !== fingerprintJson( snapshot.files )
	) {

		throw new Error( `${ label } ${ domain } source snapshot fingerprint is inconsistent.` );

	}
	const canonicalRoot = resolve( root );
	const required = new Set( requiredPaths );
	let previousPath = null;
	for ( const record of snapshot.files ) {

		if (
			! record ||
			record.domain !== domain ||
			typeof record.path !== 'string' ||
			record.path.length === 0 ||
			isAbsolute( record.path ) ||
			record.path.includes( '\\' ) ||
			hasControlCharacter( record.path )
		) {

			throw new Error( `${ label } ${ domain } source record has an invalid domain or path.` );

		}
		if ( previousPath !== null && record.path <= previousPath ) {

			throw new Error( `${ label } ${ domain } source records must be unique and sorted.` );

		}
		previousPath = record.path;
		required.delete( record.path );
		if ( typeof record.sha256 !== 'string' || ! /^[a-f0-9]{64}$/.test( record.sha256 ) ) {

			throw new Error( `${ label } ${ domain } source ${ record.path } has an invalid SHA-256 digest.` );

		}
		if ( ! Number.isSafeInteger( record.bytes ) || record.bytes < 0 ) {

			throw new Error( `${ label } ${ domain } source ${ record.path } has an invalid byte count.` );

		}
		const file = resolve( canonicalRoot, record.path );
		const rel = relative( canonicalRoot, file );
		if ( ! rel || rel === '..' || rel.startsWith( `..${ sep }` ) || isAbsolute( rel ) ) {

			throw new Error( `${ label } ${ domain } source ${ record.path } escapes its current root.` );

		}
		const bytes = readSafeContainedFile( canonicalRoot, file, {
			label: `${ label } ${ domain } source ${ record.path }`,
		} );
		if ( bytes.length !== record.bytes || sha256( bytes ) !== record.sha256 ) {

			throw new Error( `${ label } ${ domain } source ${ record.path } is stale.` );

		}

	}
	if ( required.size > 0 ) {

		throw new Error(
			`${ label } ${ domain } source snapshot omits required inputs: ${ [ ...required ].sort().join( ', ' ) }.`,
		);

	}
	return snapshot;

}

export function stableJson( value ) {

	if ( value === null || typeof value !== 'object' ) return JSON.stringify( value );
	if ( Array.isArray( value ) ) return `[${ value.map( stableJson ).join( ',' ) }]`;
	return `{${ Object.keys( value ).sort().map( ( key ) => `${ JSON.stringify( key ) }:${ stableJson( value[ key ] ) }` ).join( ',' ) }}`;

}

export function fingerprintJson( value ) {

	return sha256( stableJson( value ) );

}

export function caseIdsFingerprint( caseIds ) {

	return sha256( [ ...caseIds ].sort().join( '\n' ) + '\n' );

}

export function duplicateValues( values ) {

	const seen = new Set();
	const duplicates = new Set();
	for ( const value of values ) {

		if ( seen.has( value ) ) duplicates.add( value );
		seen.add( value );

	}
	return [ ...duplicates ].sort();

}

export function sameValueSet( left, right ) {

	if ( left.length !== right.length ) return false;
	const leftSet = new Set( left );
	return leftSet.size === left.length && right.every( ( value ) => leftSet.has( value ) );

}

function hasControlCharacter( value ) {

	for ( const character of value ) {

		const code = character.charCodeAt( 0 );
		if ( code <= 0x1f || code === 0x7f ) return true;

	}
	return false;

}

function assertCanonicalRelativeHtmlPath( value, label ) {

	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		isAbsolute( value ) ||
		value.startsWith( '/' ) ||
		value.includes( '\\' ) ||
		hasControlCharacter( value )
	) {

		throw new Error( `${ label } must be a canonical relative POSIX HTML path.` );

	}
	const segments = value.split( '/' );
	if ( segments.some( segment => segment === '' || segment === '.' || segment === '..' ) ) {

		throw new Error( `${ label } must be a canonical relative POSIX HTML path.` );

	}
	for ( const segment of segments.slice( 0, -1 ) ) {

		assertCanonicalExampleId( segment, `${ label } directory segment` );

	}
	const filename = segments.at( -1 );
	if ( ! filename?.endsWith( '.html' ) ) {

		throw new Error( `${ label } must end in a canonical HTML basename.` );

	}
	assertCanonicalExampleId(
		filename.slice( 0, - '.html'.length ),
		`${ label } HTML basename`,
	);
	return value;

}

function localRoutePathname( route, label ) {

	if ( typeof route !== 'string' || route.length === 0 || hasControlCharacter( route ) ) {

		throw new Error( `${ label } must be a non-empty relative HTML route.` );

	}
	const suffixIndex = route.search( /[?#]/ );
	const pathname = suffixIndex === -1 ? route : route.slice( 0, suffixIndex );
	assertCanonicalRelativeHtmlPath( pathname, `${ label } pathname` );
	return pathname;

}

function assertCatalogueSource( entry, cataloguePath ) {

	const { id, source } = entry;
	const label = `Evidence catalogue case ${ id } source`;
	if ( ! source || Array.isArray( source ) || typeof source !== 'object' ) {

		throw new Error( `${ label } must be an object.` );

	}
	if ( source.kind === 'three' ) {

		const filename = `${ id }.html`;
		if (
			source.path !== `examples/${ filename }` ||
			source.route !== filename ||
			source.originalUrl !== `https://threejs.org/examples/#${ id }`
		) {

			throw new Error(
				`${ label } must use the canonical Three.js path, route, and HTTPS example URL ` +
				`in ${ cataloguePath }.`,
			);

		}
		return;

	}
	if ( source.kind === 'local' ) {

		assertCanonicalExampleId( source.project, `${ label } project` );
		assertCanonicalRelativeHtmlPath( source.path, `${ label } repository path` );
		const expectedPrefix = `packages/examples/${ source.project }/`;
		if ( ! source.path.startsWith( expectedPrefix ) ) {

			throw new Error( `${ label } repository path must be inside ${ expectedPrefix }.` );

		}
		localRoutePathname( source.route, `${ label } route` );
		return;

	}
	throw new Error( `Evidence catalogue case ${ id } has unsupported source kind ${ JSON.stringify( source.kind ) }.` );

}

export function readEvidenceCatalogue( cataloguePath, {
	root = dirname( resolve( cataloguePath ) ),
	label = 'Evidence catalogue',
} = {} ) {

	const bytes = readSafeContainedFile( root, cataloguePath, { label } );
	let catalogue;
	try {

		catalogue = JSON.parse( bytes.toString( 'utf8' ) );

	} catch ( cause ) {

		throw new Error( `Could not parse evidence catalogue ${ cataloguePath }.`, { cause } );

	}
	if ( ! catalogue || ! Array.isArray( catalogue.cases ) ) {

		throw new Error( `Evidence catalogue ${ cataloguePath } must contain a cases array.` );

	}
	const records = catalogue.cases.map( ( entry, index ) => {

		if ( ! entry || typeof entry.id !== 'string' ) {

			throw new Error( `Evidence catalogue ${ cataloguePath} has an invalid case at index ${ index }.` );

		}
		assertCanonicalExampleId( entry.id, `Evidence catalogue case at index ${ index } identifier` );
		assertCatalogueSource( entry, cataloguePath );
		const sourceKind = entry.source.kind;
		return {
			id: entry.id,
			name: `${ entry.id }.html`,
			sourceKind,
			source: entry.source,
		};

	} );
	const duplicateIds = duplicateValues( records.map( ( entry ) => entry.id ) );
	if ( duplicateIds.length > 0 ) {

		throw new Error( `Evidence catalogue contains duplicate IDs: ${ duplicateIds.join( ', ' ) }.` );

	}
	const caseIds = records.map( ( entry ) => entry.id );
	const upstreamCaseNames = records.filter( ( entry ) => entry.sourceKind === 'three' ).map( ( entry ) => entry.name );
	return {
		schemaVersion: catalogue.schemaVersion,
		threeVersion: catalogue.threeVersion,
		sha256: sha256( bytes ),
		caseCount: records.length,
		caseIds,
		caseIdsSha256: caseIdsFingerprint( caseIds ),
		upstreamCaseNames,
		upstreamCaseNamesSha256: caseIdsFingerprint( upstreamCaseNames ),
		records,
	};

}

export function classifyEvidenceRun( {
	canonicalRoot,
	outputRoot,
	catalogueUpstreamCaseNames,
	candidates,
	localExamplesRoot = null,
	tier = '',
	filter = '',
	hasExplicitOffset = false,
	hasExplicitLimit = false,
	hasExplicitPsnrThreshold = false,
	pixelGateEnabled = true,
	saveShots = true,
	replayOnly = false,
	reuseReferenceShot = false,
	defaultSlimBundle = '',
	slimBundle = '',
	reportFile = 'e2e-report.json',
	hasEvidenceAffectingOverrides = false,
	canonicalEvidenceRequested = false,
} ) {

	const duplicateCandidates = duplicateValues( candidates );
	if ( duplicateCandidates.length > 0 ) {

		throw new Error( `Evidence candidates contain duplicate IDs: ${ duplicateCandidates.join( ', ' ) }.` );

	}
	const exactCorpus = ! localExamplesRoot && sameValueSet( candidates, catalogueUpstreamCaseNames );
	const freshDefaultConfiguration = (
		! localExamplesRoot &&
		! tier &&
		! filter &&
		! hasExplicitOffset &&
		! hasExplicitLimit &&
		! hasExplicitPsnrThreshold &&
		! hasEvidenceAffectingOverrides &&
		pixelGateEnabled &&
		saveShots &&
		! replayOnly &&
		! reuseReferenceShot &&
		resolve( slimBundle ) === resolve( defaultSlimBundle ) &&
		reportFile === 'e2e-report.json'
	);
	const writesCanonicalRoot = resolve( outputRoot ) === resolve( canonicalRoot );
	const canonical = writesCanonicalRoot || canonicalEvidenceRequested;
	if ( canonical && ( ! exactCorpus || ! freshDefaultConfiguration ) ) {

		throw new Error(
			'Canonical visual evidence requires the exact full upstream catalogue with fresh stock/capture/replay, ' +
			'the default pixel policy and slim bundle, saved screenshots, and e2e-report.json. ' +
			( writesCanonicalRoot
				? 'Use --output-root=<isolated-directory>'
				: 'Remove --canonical-evidence' ) +
			' for tiers, filters, local suites, replay/reference reuse, custom thresholds/timing, or other diagnostics.',
		);

	}
	return { canonical, writesCanonicalRoot, exactCorpus, freshDefaultConfiguration };

}

export function createRunId() {

	return randomUUID();

}

function normalizedRelativePath( root, file ) {

	const absoluteRoot = resolve( root );
	const absoluteFile = resolve( file );
	const value = relative( absoluteRoot, absoluteFile );
	if ( ! value || value === '..' || value.startsWith( `..${ sep }` ) || isAbsolute( value ) ) {

		throw new Error( `Evidence path ${ absoluteFile } is not a file below ${ absoluteRoot}.` );

	}
	return value.replaceAll( sep, '/' );

}

function checkedLstat( file, label ) {

	try {

		return lstatSync( file );

	} catch ( cause ) {

		throw new Error( `${ label } is missing: ${ file }.`, { cause } );

	}

}

/**
 * Require an existing file/directory to remain physically below its declared
 * root. Lexical containment alone is insufficient because readFileSync() and
 * realpathSync() follow symlinks. Reject the root itself and every descendant
 * path component when it is a symlink, then repeat containment against the
 * resolved filesystem identities.
 */
export function assertSafeContainedPath( root, file, {
	allowRoot = false,
	kind = 'file',
	label = 'Path',
} = {} ) {

	if ( kind !== 'file' && kind !== 'directory' ) throw new TypeError( `Unsupported contained path kind ${ JSON.stringify( kind ) }.` );
	const absoluteRoot = resolve( root );
	const absoluteFile = resolve( file );
	const lexicalRelative = relative( absoluteRoot, absoluteFile );
	if (
		( lexicalRelative === '' && ! allowRoot ) ||
		lexicalRelative === '..' ||
		lexicalRelative.startsWith( `..${ sep }` ) ||
		isAbsolute( lexicalRelative )
	) {

		throw new Error( `${ label } escapes its declared root ${ absoluteRoot }.` );

	}

	const rootStat = checkedLstat( absoluteRoot, `${ label } root` );
	if ( rootStat.isSymbolicLink() ) throw new Error( `${ label } root must not be a symbolic link: ${ absoluteRoot }.` );
	if ( ! rootStat.isDirectory() ) throw new Error( `${ label } root is not a directory: ${ absoluteRoot }.` );

	let current = absoluteRoot;
	let targetStat = rootStat;
	if ( lexicalRelative !== '' ) {

		for ( const segment of lexicalRelative.split( sep ) ) {

			current = join( current, segment );
			targetStat = checkedLstat( current, label );
			if ( targetStat.isSymbolicLink() ) {

				throw new Error( `${ label } must not traverse a symbolic link: ${ current }.` );

			}
			if ( current !== absoluteFile && ! targetStat.isDirectory() ) {

				throw new Error( `${ label } traverses a non-directory path component: ${ current }.` );

			}

		}

	}

	if ( kind === 'file' && ! targetStat.isFile() ) throw new Error( `${ label } is not a regular file: ${ absoluteFile }.` );
	if ( kind === 'directory' && ! targetStat.isDirectory() ) throw new Error( `${ label } is not a directory: ${ absoluteFile }.` );

	const realRoot = realpathSync( absoluteRoot );
	const realFile = realpathSync( absoluteFile );
	const physicalRelative = relative( realRoot, realFile );
	if (
		( physicalRelative === '' && ! allowRoot ) ||
		physicalRelative === '..' ||
		physicalRelative.startsWith( `..${ sep }` ) ||
		isAbsolute( physicalRelative )
	) {

		throw new Error( `${ label } resolves outside its declared root ${ realRoot }.` );

	}
	return absoluteFile;

}

function sameFileIdentity( left, right ) {

	return left.dev === right.dev
		&& left.ino === right.ino
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs
		&& left.ctimeNs === right.ctimeNs;

}

/**
 * Read one existing regular file without accepting a validation/open race.
 *
 * O_NOFOLLOW closes the final-component symlink window where the platform
 * exposes it. Revalidating the full path after the fd read closes ancestor
 * symlink races (and the Windows no-O_NOFOLLOW fallback), while the fd/final
 * path identity comparison prevents an attacker from restoring a different
 * safe file before that second validation.
 */
export function readSafeContainedFile( root, file, {
	label = 'Contained file',
	hooks = null,
	noFollowFlag = constants.O_NOFOLLOW,
} = {} ) {

	const absoluteRoot = resolve( root );
	const absoluteFile = assertSafeContainedPath( absoluteRoot, file, { label } );
	if ( hooks?.afterValidation ) hooks.afterValidation( absoluteFile );
	let descriptor;
	try {

		const safeNoFollowFlag = Number.isInteger( noFollowFlag ) ? noFollowFlag : 0;
		descriptor = openSync( absoluteFile, constants.O_RDONLY | safeNoFollowFlag );
		const before = fstatSync( descriptor, { bigint: true } );
		if ( ! before.isFile() ) throw new Error( `${ label } is not a regular opened file: ${ absoluteFile }.` );
		const bytes = readFileSync( descriptor );
		const after = fstatSync( descriptor, { bigint: true } );
		if ( ! sameFileIdentity( before, after ) || BigInt( bytes.length ) !== after.size ) {

			throw new Error( `${ label } changed while it was being read: ${ absoluteFile }.` );

		}
		if ( hooks?.afterRead ) hooks.afterRead( absoluteFile );
		assertSafeContainedPath( absoluteRoot, absoluteFile, { label } );
		const final = lstatSync( absoluteFile, { bigint: true } );
		if ( ! final.isFile() || ! sameFileIdentity( after, final ) ) {

			throw new Error( `${ label } changed filesystem identity while it was being read: ${ absoluteFile }.` );

		}
		return bytes;

	} catch ( cause ) {

		if ( cause?.message?.startsWith( `${ label } ` ) ) throw cause;
		throw new Error( `${ label } could not be read with a stable filesystem identity: ${ absoluteFile }.`, { cause } );

	} finally {

		if ( descriptor !== undefined ) closeSync( descriptor );

	}

}

export function describeEvidenceBytes( { outputRoot, file, bytes, runId } ) {

	if ( ! Buffer.isBuffer( bytes ) ) throw new TypeError( 'Evidence bytes must be a Buffer.' );
	const relativeFile = normalizedRelativePath( outputRoot, file );
	assertSafeContainedPath( outputRoot, file, { label: 'Evidence file' } );
	return {
		runId,
		file: relativeFile,
		sha256: sha256( bytes ),
		bytes: bytes.length,
	};

}

function resolveEvidenceDescriptorPath( outputRoot, descriptor ) {

	if ( ! descriptor || typeof descriptor.file !== 'string' || descriptor.file.length === 0 ) {

		throw new Error( 'Evidence descriptor has no file.' );

	}
	const file = resolve( outputRoot, descriptor.file );
	normalizedRelativePath( outputRoot, file );
	return file;

}

export function resolveEvidenceDescriptor( outputRoot, descriptor ) {

	const file = resolveEvidenceDescriptorPath( outputRoot, descriptor );
	return assertSafeContainedPath( outputRoot, file, { label: `Evidence file ${ descriptor.file }` } );

}

export function verifyEvidenceDescriptor( outputRoot, descriptor, expectedRunId ) {

	if ( ! descriptor || descriptor.runId !== expectedRunId ) {

		throw new Error( `Evidence descriptor runId does not match ${ expectedRunId }.` );

	}
	if ( ! Number.isSafeInteger( descriptor.bytes ) || descriptor.bytes < 0 || ! /^[a-f0-9]{64}$/.test( descriptor.sha256 || '' ) ) {

		throw new Error( `Evidence descriptor ${ descriptor.file || '<unknown>' } has invalid size or sha256.` );

	}
	const file = resolveEvidenceDescriptorPath( outputRoot, descriptor );
	const bytes = readSafeContainedFile( outputRoot, file, {
		label: `Evidence file ${ descriptor.file }`,
	} );
	if ( bytes.length !== descriptor.bytes ) {

		throw new Error( `Evidence file size drifted for ${ descriptor.file }: ${ bytes.length} != ${ descriptor.bytes }.` );

	}
	const actualHash = sha256( bytes );
	if ( actualHash !== descriptor.sha256 ) {

		throw new Error( `Evidence file hash drifted for ${ descriptor.file}: ${ actualHash } != ${ descriptor.sha256 }.` );

	}
	return { file, bytes };

}

function sourceKey( domain, path ) {

	return `${ domain }\0${ path }`;

}

function classifyEvidenceSource( roots, file, { validate = true } = {} ) {

	const absolute = resolve( file );
	for ( const candidate of roots ) {

		const rel = relative( candidate.root, absolute );
		if ( rel && rel !== '..' && ! rel.startsWith( `..${ sep }` ) && ! isAbsolute( rel ) ) {

			if ( validate ) {

				assertSafeContainedPath( candidate.root, absolute, {
					label: `Evidence source ${ absolute }`,
				} );

			}
			return { domain: candidate.domain, path: rel.replaceAll( sep, '/' ), root: candidate.root };

		}

	}
	throw new Error( `Evidence source ${ absolute } is outside the declared source roots.` );

}

/**
 * Record the immutable bytes that feed one run. Re-reading a path after it
 * changes is a hard failure rather than a report that silently spans two source
 * generations.
 */
export class EvidenceSourceRecorder {

	constructor( { repoRoot, threeRoot, localRoot = null, threeSourceVerifier = null } ) {

		this.roots = [
			{ domain: 'three', root: resolve( threeRoot ) },
			...( localRoot ? [ { domain: 'local', root: resolve( localRoot ) } ] : [] ),
			{ domain: 'repository', root: resolve( repoRoot ) },
		];
		this.records = new Map();
		this.threeSourceVerifier = threeSourceVerifier;

	}

	classify( file ) {

		const classified = classifyEvidenceSource( this.roots, file, { validate: false } );
		return { domain: classified.domain, path: classified.path };

	}

	setThreeSourceVerifier( verifier ) {

		if ( this.records.size > 0 && [ ...this.records.values() ].some( ( record ) => record.domain === 'three' ) ) {

			throw new Error( 'Three source verifier must be installed before recording Three inputs.' );

		}
		if ( this.threeSourceVerifier && this.threeSourceVerifier !== verifier ) {

			throw new Error( 'Three source verifier cannot be replaced during an evidence run.' );

		}
		this.threeSourceVerifier = verifier;

	}

	record( file, bytes = undefined ) {

		const classified = classifyEvidenceSource( this.roots, file );
		const { root, ...identity } = classified;
		const currentBytes = readSafeContainedFile( root, file, {
			label: `Evidence source ${ resolve( file ) }`,
		} );
		const buffer = bytes === undefined
			? currentBytes
			: ( Buffer.isBuffer( bytes ) ? bytes : Buffer.from( bytes ) );
		if ( bytes !== undefined && ! buffer.equals( currentBytes ) ) {

			throw new Error( `Evidence source changed before it was recorded: ${ identity.domain}:${ identity.path }.` );

		}
		const gitProof = identity.domain === 'three' && this.threeSourceVerifier
			? this.threeSourceVerifier.verify( file, buffer )
			: null;
		const sourceSha256 = sha256( buffer );
		if (
			gitProof &&
			(
				gitProof.path !== identity.path ||
				gitProof.bytes !== buffer.length ||
				gitProof.sha256 !== sourceSha256
			)
		) {

			throw new Error( `Three Git proof drifted from served source ${ identity.path }.` );

		}
		const record = {
			...identity,
			sha256: sourceSha256,
			bytes: buffer.length,
			...( gitProof ? {
				gitBlob: gitProof.gitBlob,
				gitCommit: gitProof.commit,
				gitTree: gitProof.tree,
				gitMode: gitProof.gitMode,
				gitObjectFormat: gitProof.objectFormat,
			} : {} ),
		};
		const key = sourceKey( record.domain, record.path );
		const previous = this.records.get( key );
		if ( previous && previous.sha256 !== record.sha256 ) {

			throw new Error( `Evidence source changed during the run: ${ record.domain}:${ record.path }.` );

		}
		this.records.set( key, record );
		return buffer;

	}

	snapshot( domain = null ) {

		const files = [ ...this.records.values() ]
			.filter( ( entry ) => ! domain || entry.domain === domain )
			.sort( ( left, right ) => left.domain.localeCompare( right.domain ) || left.path.localeCompare( right.path ) );
		return {
			sha256: fingerprintJson( files ),
			fileCount: files.length,
			files,
		};

	}

}

export function assertUniqueExactNames( actual, expected, label ) {

	const duplicates = duplicateValues( actual );
	if ( duplicates.length > 0 ) throw new Error( `${ label } contains duplicate names: ${ duplicates.join( ', ' ) }.` );
	const missing = expected.filter( ( name ) => ! actual.includes( name ) );
	const unexpected = actual.filter( ( name ) => ! expected.includes( name ) );
	if ( missing.length > 0 || unexpected.length > 0 ) {

		throw new Error(
			`${ label } does not match its declared corpus ` +
			`(missing: ${ missing.join( ', ' ) || 'none' }; unexpected: ${ unexpected.join( ', ' ) || 'none' }).`,
		);

	}

}
