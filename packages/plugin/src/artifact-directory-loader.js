import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
	INTERNAL_PASS_FAMILY_REQUIREMENTS,
	INTERNAL_PASS_SHAPES,
	validateInternalPassFamily,
} from '@tsl-precompile/contract/internal-pass';

const MANIFEST_FILENAME = 'manifest.json';
const MANIFEST_CONSISTENCY_ERROR = 'TSLP_ARTIFACT_MANIFEST_INCONSISTENT';

/**
 * Load captured artifacts from a directory.
 *
 * A durable manifest is authoritative when present: only its referenced
 * artifacts are exposed. Unreferenced files are ignored: capture writes the
 * new artifact before atomically replacing the manifest, so inspecting that
 * transient file would make a healthy dev recapture fail. Direct directory
 * scanning remains as a legacy fallback, where duplicate identities are errors
 * instead of being resolved nondeterministically by mtime.
 *
 * `manifestConsistencyRetries` is intentionally opt-in. Development watchers
 * may use it to bridge one capture transaction; production builds and verify
 * retain the default zero-retry, fail-closed behavior.
 */
export async function loadArtifactDirectory( artifactsDirectory, opts = {} ) {

	const retries = Number.isInteger( opts.manifestConsistencyRetries ) && opts.manifestConsistencyRetries > 0
		? opts.manifestConsistencyRetries
		: 0;
	const retryDelayMs = Number.isFinite( opts.manifestConsistencyRetryDelayMs ) && opts.manifestConsistencyRetryDelayMs >= 0
		? opts.manifestConsistencyRetryDelayMs
		: 10;
	for ( let attempt = 0; ; attempt ++ ) {

		try {

			return await loadArtifactDirectoryOnce( artifactsDirectory, opts );

		} catch ( error ) {

			if ( error?.code !== MANIFEST_CONSISTENCY_ERROR || attempt >= retries ) throw error;
			await delay( retryDelayMs * ( attempt + 1 ) );

		}

	}

}

async function loadArtifactDirectoryOnce( artifactsDirectory, opts ) {

	const artifactsDir = resolve( artifactsDirectory );
	let files;
	try {

		files = ( await readdir( artifactsDir ) )
			.filter( ( file ) => file.endsWith( '.json' ) )
			.sort();

	} catch ( error ) {

		if ( error && error.code === 'ENOENT' ) return emptyResult();
		throw new Error( `[tsl-precompile] could not read artifact directory ${ artifactsDir }: ${ error.message || String( error ) }` );

	}

	const durableManifest = await readDurableManifest( artifactsDir );
	if ( durableManifest ) return loadManifestArtifacts( artifactsDir, files, durableManifest, opts );
	return loadLegacyArtifacts( artifactsDir, files, opts );

}

function delay( milliseconds ) {

	return new Promise( ( resolveDelay ) => setTimeout( resolveDelay, milliseconds ) );

}

async function readDurableManifest( artifactsDir ) {

	const manifestPath = join( artifactsDir, MANIFEST_FILENAME );
	let source;
	try {

		source = await readFile( manifestPath, 'utf8' );

	} catch ( error ) {

		if ( error && error.code === 'ENOENT' ) return null;
		throw new Error( `[tsl-precompile] could not read artifact manifest ${ manifestPath }: ${ error.message || String( error ) }` );

	}

	let parsed;
	try {

		parsed = JSON.parse( source );

	} catch ( error ) {

		throw new Error( `[tsl-precompile] artifact manifest ${ manifestPath} is invalid JSON: ${ error.message || String( error ) }` );

	}
	if ( ! parsed || typeof parsed !== 'object' || Array.isArray( parsed ) ) {

		throw new Error( `[tsl-precompile] artifact manifest ${ manifestPath } must contain an object.` );

	}
	return parsed;

}

async function loadManifestArtifacts( artifactsDir, files, durableManifest, opts ) {

	const rootRealPath = await realpath( artifactsDir );
	const userArtifacts = Object.create( null );
	const auxiliaryArtifacts = Object.create( null );
	const referencedFiles = new Map();
	const identities = new Map();

	for ( const [ name, manifestEntry ] of Object.entries( durableManifest ) ) {

		if ( name === '__aux' ) continue;
		assertManifestEntryObject( manifestEntry, `artifact ${ JSON.stringify( name ) }` );
		const loaded = await loadReferencedEnvelope(
			artifactsDir,
			rootRealPath,
			manifestEntry.file,
			`artifact ${ JSON.stringify( name ) }`,
		);
		if ( loaded.entry.__materialShape !== undefined || loaded.entry.__configHash !== undefined ) {

			throw manifestError( artifactsDir, `artifact ${ JSON.stringify( name ) } references auxiliary envelope ${ JSON.stringify( loaded.file ) }.` );

		}
		if ( loaded.entry.__name !== name ) {

			throw manifestError( artifactsDir, `artifact ${ JSON.stringify( name ) } references ${ JSON.stringify( loaded.file ) }, whose __name is ${ JSON.stringify( loaded.entry.__name ) }.` );

		}
		assertRequiredHashMatch( artifactsDir, manifestEntry.hash, loaded.entry.__hash, `artifact ${ JSON.stringify( name ) }` );
		claimReferencedFile( artifactsDir, referencedFiles, loaded.file, `artifact ${ JSON.stringify( name ) }` );
		claimIdentity( artifactsDir, identities, `user:${ name }`, loaded.file );
		userArtifacts[ name ] = {
			file: loaded.file,
			hash: loaded.entry.__hash,
			entry: loaded.entry,
			mtime: loaded.mtime,
		};

	}

	const aux = durableManifest.__aux;
	if ( aux !== undefined && ( ! aux || typeof aux !== 'object' || Array.isArray( aux ) ) ) {

		throw manifestError( artifactsDir, '`__aux` must contain an object when present.' );

	}
	for ( const [ key, manifestEntry ] of Object.entries( aux || {} ) ) {

		assertManifestEntryObject( manifestEntry, `auxiliary artifact ${ JSON.stringify( key ) }` );
		if ( typeof manifestEntry.shape !== 'string' || manifestEntry.shape.length === 0 ||
			typeof manifestEntry.configHash !== 'string' || manifestEntry.configHash.length === 0 ) {

			throw manifestError( artifactsDir, `auxiliary artifact ${ JSON.stringify( key ) } must declare non-empty shape and configHash values.` );

		}
		const expectedKey = `${ manifestEntry.shape }:${ manifestEntry.configHash }`;
		if ( key !== expectedKey ) {

			throw manifestError( artifactsDir, `auxiliary artifact key ${ JSON.stringify( key ) } does not match ${ JSON.stringify( expectedKey ) }.` );

		}
		const loaded = await loadReferencedEnvelope(
			artifactsDir,
			rootRealPath,
			manifestEntry.file,
			`auxiliary artifact ${ JSON.stringify( key ) }`,
		);
		if ( loaded.entry.__materialShape !== manifestEntry.shape || loaded.entry.__configHash !== manifestEntry.configHash ) {

			throw manifestError(
				artifactsDir,
				`auxiliary artifact ${ JSON.stringify( key ) } references ${ JSON.stringify( loaded.file ) } with mismatched envelope identity.`,
			);

		}
		assertAuxiliaryProvenanceAgreement( artifactsDir, manifestEntry, loaded.entry, `auxiliary artifact ${ JSON.stringify( key ) }` );
		assertOptionalHashMatch(
			artifactsDir,
			manifestEntry.hash,
			loaded.entry.__hash,
			`auxiliary artifact ${ JSON.stringify( key ) }`,
			{ transient: true },
		);
		claimReferencedFile( artifactsDir, referencedFiles, loaded.file, `auxiliary artifact ${ JSON.stringify( key ) }` );
		claimIdentity( artifactsDir, identities, `aux:${ key }`, loaded.file );
		auxiliaryArtifacts[ key ] = {
			file: loaded.file,
			shape: manifestEntry.shape,
			configHash: manifestEntry.configHash,
			hash: loaded.entry.__hash,
			entry: loaded.entry,
			mtime: loaded.mtime,
		};

	}

	if ( opts.rejectUnreferencedDuplicates === true || opts.rejectUnreferencedArtifacts === true ) {

		for ( const file of files ) {

			if ( file === MANIFEST_FILENAME || referencedFiles.has( file ) ) continue;
			const loaded = await readUnreferencedEnvelope( artifactsDir, file, rootRealPath );
			const identity = loaded && envelopeIdentity( loaded.entry );
			if ( identity && identities.has( identity ) ) {

				throw manifestError(
					artifactsDir,
					`duplicate artifact identity ${ JSON.stringify( identity.slice( identity.indexOf( ':' ) + 1 ) ) } in ${ JSON.stringify( identities.get( identity ) ) } and unreferenced ${ JSON.stringify( file ) }. Remove the stale file or recapture.`,
				);

			}
			if ( opts.rejectUnreferencedArtifacts === true ) {

				throw manifestError(
					artifactsDir,
					`unreferenced artifact file ${ JSON.stringify( file ) } is not part of the authoritative manifest. Remove it or recapture.`,
				);

			}

		}

	}
	if ( opts.allowIncompleteInternalPassFamilies !== true ) {

		assertCompleteInternalPassFamilies( artifactsDir, auxiliaryArtifacts );

	}

	return { manifest: userArtifacts, auxManifest: auxiliaryArtifacts, authoritative: true };

}

async function loadLegacyArtifacts( artifactsDir, files, opts ) {

	const rootRealPath = await realpath( artifactsDir );
	const userArtifacts = Object.create( null );
	const auxiliaryArtifacts = Object.create( null );
	const identities = new Map();

	for ( const file of files ) {

		if ( file === MANIFEST_FILENAME ) continue;
		const loaded = await readUnreferencedEnvelope( artifactsDir, file, rootRealPath );
		if ( ! loaded ) continue;
		const { entry, mtime } = loaded;
		const identity = envelopeIdentity( entry );
		if ( ! identity ) continue;
		claimIdentity( artifactsDir, identities, identity, file );

		if ( entry.__materialShape && entry.__configHash ) {

			const key = `${ entry.__materialShape }:${ entry.__configHash }`;
			auxiliaryArtifacts[ key ] = {
				file,
				shape: entry.__materialShape,
				configHash: entry.__configHash,
				hash: entry.__hash,
				entry,
				mtime,
			};
			continue;

		}

		userArtifacts[ entry.__name ] = {
			file,
			hash: entry.__hash,
			entry,
			mtime,
		};

	}

	if ( opts.allowIncompleteInternalPassFamilies !== true ) {

		assertCompleteInternalPassFamilies( artifactsDir, auxiliaryArtifacts );

	}
	return { manifest: userArtifacts, auxManifest: auxiliaryArtifacts, authoritative: false };

}

function assertCompleteInternalPassFamilies( artifactsDir, auxiliaryArtifacts ) {

	const groups = new Map();
	for ( const entry of Object.values( auxiliaryArtifacts ) ) {

		const descriptor = entry?.entry?.artifact?.internalPass;
		if ( ! descriptor || typeof descriptor !== 'object' || Array.isArray( descriptor ) ) {

			if ( INTERNAL_PASS_SHAPES.includes( entry.shape ) ) throw manifestError(
				artifactsDir,
				`auxiliary shape ${ JSON.stringify( entry.shape ) } must carry an internalPass descriptor.`,
			);
			continue;

		}
		const family = typeof descriptor.family === 'string' ? descriptor.family : '<invalid>';
		const groupKey = JSON.stringify( [ family, entry.configHash ] );
		let group = groups.get( groupKey );
		if ( ! group ) {

			group = { family, configHash: entry.configHash, envelopes: [] };
			groups.set( groupKey, group );

		}
		group.envelopes.push( entry.entry );

	}

	for ( const group of groups.values() ) {

		const family = group.family === '<invalid>' ? undefined : group.family;
		const familyIssues = validateInternalPassFamily(
			group.envelopes,
			family ? { family } : {},
		);
		if ( familyIssues.length === 0 ) continue;
		throw manifestError(
			artifactsDir,
			`internal-pass family ${ JSON.stringify( `${ group.family }:${ group.configHash }` ) } is incomplete or invalid: ${ familyIssues[ 0 ].message }`,
		);

	}
	const availableShapes = new Set( Object.values( auxiliaryArtifacts ).map( ( entry ) => entry.shape ) );
	for ( const group of groups.values() ) {

		const requiredShapes = INTERNAL_PASS_FAMILY_REQUIREMENTS[ group.family ]?.requiredAuxiliaryShapes || [];
		const missingShapes = requiredShapes.filter( ( shape ) => ! availableShapes.has( shape ) );
		if ( missingShapes.length > 0 ) throw manifestError(
			artifactsDir,
			`internal-pass family ${ JSON.stringify( `${ group.family }:${ group.configHash }` ) } is missing required auxiliary support: ${ missingShapes.join( ', ' ) }.`,
		);

	}

}

async function loadReferencedEnvelope( artifactsDir, rootRealPath, filename, label ) {

	assertCanonicalFilename( artifactsDir, filename, label );
	const artifactPath = join( artifactsDir, filename );
	let fileRealPath;
	try {

		fileRealPath = await realpath( artifactPath );

	} catch ( error ) {

		throw manifestError(
			artifactsDir,
			`${ label } references unreadable file ${ JSON.stringify( filename ) }: ${ error.message || String( error ) }`,
			{ transient: true },
		);

	}
	assertContainedRealPath( artifactsDir, rootRealPath, fileRealPath, label );

	let source;
	let metadata;
	try {

		[ source, metadata ] = await Promise.all( [
			readFile( fileRealPath, 'utf8' ),
			stat( fileRealPath ),
		] );

	} catch ( error ) {

		throw manifestError(
			artifactsDir,
			`${ label } references unreadable file ${ JSON.stringify( filename ) }: ${ error.message || String( error ) }`,
			{ transient: true },
		);

	}

	let entry;
	try {

		entry = JSON.parse( source );

	} catch ( error ) {

		throw manifestError( artifactsDir, `${ label } references invalid JSON ${ JSON.stringify( filename ) }: ${ error.message || String( error ) }` );

	}
	if ( ! entry || typeof entry !== 'object' || Array.isArray( entry ) ) {

		throw manifestError( artifactsDir, `${ label } references ${ JSON.stringify( filename ) }, which must contain an object envelope.` );

	}
	return { file: filename, entry, mtime: metadata.mtimeMs };

}

async function readUnreferencedEnvelope( artifactsDir, file, rootRealPath ) {

	assertCanonicalFilename( artifactsDir, file, `unreferenced artifact ${ JSON.stringify( file ) }` );
	const fileRealPath = await realpath( join( artifactsDir, file ) );
	assertContainedRealPath( artifactsDir, rootRealPath, fileRealPath, `unreferenced artifact ${ JSON.stringify( file ) }` );

	try {

		const [ source, metadata ] = await Promise.all( [
			readFile( fileRealPath, 'utf8' ),
			stat( fileRealPath ),
		] );
		const parsed = JSON.parse( source );
		return parsed && typeof parsed === 'object' && ! Array.isArray( parsed )
			? { entry: parsed, mtime: metadata.mtimeMs }
			: null;

	} catch ( _error ) {

		// Preserve the legacy scan's tolerance for unrelated/unreadable JSON.
		return null;

	}

}

function envelopeIdentity( entry ) {

	if ( typeof entry.__materialShape === 'string' && entry.__materialShape.length > 0 &&
		typeof entry.__configHash === 'string' && entry.__configHash.length > 0 ) {

		return `aux:${ entry.__materialShape }:${ entry.__configHash }`;

	}
	if ( typeof entry.__name === 'string' && entry.__name.length > 0 ) return `user:${ entry.__name }`;
	return null;

}

function assertManifestEntryObject( manifestEntry, label ) {

	if ( ! manifestEntry || typeof manifestEntry !== 'object' || Array.isArray( manifestEntry ) ) {

		throw new Error( `[tsl-precompile] ${ label } manifest entry must be an object.` );

	}

}

function assertCanonicalFilename( artifactsDir, filename, label ) {

	if ( typeof filename !== 'string' || filename.length === 0 ||
		filename !== basename( filename ) || filename.includes( '\\' ) ||
		filename === MANIFEST_FILENAME || ! filename.endsWith( '.json' ) ) {

		throw manifestError( artifactsDir, `${ label } has unsafe artifact filename ${ JSON.stringify( filename ) }.` );

	}

}

function assertContainedRealPath( artifactsDir, rootRealPath, fileRealPath, label ) {

	const rel = relative( rootRealPath, fileRealPath );
	if ( rel === '' || rel === '..' || rel.startsWith( `..${ sep }` ) || isAbsolute( rel ) ) {

		throw manifestError( artifactsDir, `${ label } resolves outside the artifact directory.` );

	}

}

function assertRequiredHashMatch( artifactsDir, expected, actual, label ) {

	if ( typeof expected !== 'string' || expected.length === 0 ) {

		throw manifestError( artifactsDir, `${ label } must declare a non-empty hash.` );

	}
	if ( actual !== expected ) {

		throw manifestError( artifactsDir, `${ label } hash ${ JSON.stringify( expected ) } does not match envelope __hash ${ JSON.stringify( actual ) }.` );

	}

}

function assertOptionalHashMatch( artifactsDir, expected, actual, label, opts = {} ) {

	if ( expected === null || expected === undefined ) return;
	if ( typeof expected !== 'string' || expected.length === 0 || actual !== expected ) {

		throw manifestError(
			artifactsDir,
			`${ label } hash ${ JSON.stringify( expected ) } does not match envelope __hash ${ JSON.stringify( actual ) }.`,
			opts,
		);

	}

}

function assertAuxiliaryProvenanceAgreement( artifactsDir, manifestEntry, envelope, label ) {

	const manifestHasProvenance = manifestEntry.threeVersion !== undefined || manifestEntry.pluginVersion !== undefined;
	const envelopeHasProvenance = envelope.threeVersion !== undefined || envelope.pluginVersion !== undefined;
	if ( ! manifestHasProvenance && ! envelopeHasProvenance ) return; // Legacy capture; build compatibility rejects it later.

	for ( const field of [ 'threeVersion', 'pluginVersion' ] ) {

		if ( typeof manifestEntry[ field ] !== 'string' || manifestEntry[ field ].length === 0 ) {

			throw manifestError(
				artifactsDir,
				`${ label} manifest entry is missing ${ field } provenance.`,
				// Aux envelopes use a stable filename. A freshly signed envelope
				// can therefore be observed just before its matching manifest
				// entry is atomically published.
				{ transient: envelopeHasProvenance },
			);

		}
		if ( envelope[ field ] !== manifestEntry[ field ] ) {

			throw manifestError(
				artifactsDir,
				`${ label } ${ field } ${ JSON.stringify( manifestEntry[ field ] ) } does not match envelope ${ field } ${ JSON.stringify( envelope[ field ] ) }.`,
				{ transient: true },
			);

		}

	}

	const artifact = envelope.artifact;
	if ( ! artifact || typeof artifact !== 'object' || Array.isArray( artifact ) ) {

		throw manifestError( artifactsDir, `${ label } envelope is missing its artifact payload.` );

	}
	if ( artifact.sourceThreeVersion !== envelope.threeVersion ) {

		throw manifestError( artifactsDir, `${ label } envelope threeVersion does not match artifact sourceThreeVersion.` );

	}
	if ( artifact.sourceHashVersion !== envelope.pluginVersion ) {

		throw manifestError( artifactsDir, `${ label } envelope pluginVersion does not match artifact sourceHashVersion.` );

	}

}

function claimReferencedFile( artifactsDir, referencedFiles, file, label ) {

	const existing = referencedFiles.get( file );
	if ( existing ) {

		throw manifestError( artifactsDir, `${ label } and ${ existing } both reference ${ JSON.stringify( file ) }.` );

	}
	referencedFiles.set( file, label );

}

function claimIdentity( artifactsDir, identities, identity, file ) {

	const existing = identities.get( identity );
	if ( existing ) {

		throw manifestError(
			artifactsDir,
			`duplicate artifact identity ${ JSON.stringify( identity.slice( identity.indexOf( ':' ) + 1 ) ) } in ${ JSON.stringify( existing ) } and ${ JSON.stringify( file ) }.`,
		);

	}
	identities.set( identity, file );

}

function manifestError( artifactsDir, message, opts = {} ) {

	const error = new Error( `[tsl-precompile] artifact manifest ${ join( artifactsDir, MANIFEST_FILENAME ) }: ${ message }` );
	if ( opts.transient === true ) error.code = MANIFEST_CONSISTENCY_ERROR;
	return error;

}

function emptyResult() {

	return {
		manifest: Object.create( null ),
		auxManifest: Object.create( null ),
		authoritative: false,
	};

}
