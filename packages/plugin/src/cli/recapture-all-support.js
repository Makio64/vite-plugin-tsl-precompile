import { createHash, randomUUID } from 'node:crypto';
import {
	cpSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const EXAMPLE_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const DEFAULT_RECAPTURE_PORT = 8999;
const RECAPTURE_LOCK_SCHEMA_VERSION = 1;

export const RECAPTURE_ALL_HELP = `Recapture every configured example, or a selected transactional subset.

Usage:
  node packages/plugin/src/cli/recapture-all.js [options]

Only one recapture transaction may own a repository at a time. A concurrent
invocation exits before staging and reports the active owner.

Options:
  --example <name>  Recapture only this example. May be repeated.
  --port <number>   Strict local Vite port (default: ${ DEFAULT_RECAPTURE_PORT }).
  --allow-prune     Allow previously captured material/aux identities to disappear.
  --skip-build      Skip production build and configured preview gates (diagnostics only).
  --help            Show this help.
`;

export function recaptureDevServerArgs( example, port ) {

	if ( ! example || typeof example.filter !== 'string' || example.filter.length === 0 ) {

		throw new TypeError( 'Recapture example is missing its package filter.' );

	}
	if ( ! Number.isInteger( port ) || port < 1 || port > 65535 ) {

		throw new RangeError( 'Recapture dev-server port must be an integer between 1 and 65535.' );

	}
	const args = [
		'--filter', example.filter,
		'dev',
		'--host', '127.0.0.1',
		'--port', String( port ),
		'--strictPort',
		// Example configs commonly use server.open for humans. The recapture
		// transaction must have exactly one browser owner or that unsolicited
		// page can race the controlled viewport and publish a divergent family.
		'--open=false',
	];
	if ( example.mode ) args.push( '--mode', example.mode );
	return args;

}

function recaptureRepositoryLockPath( repoRoot, temporaryRoot ) {

	const canonicalRepoRoot = realpathSync( repoRoot );
	const repoHash = createHash( 'sha256' ).update( canonicalRepoRoot ).digest( 'hex' ).slice( 0, 24 );
	return {
		canonicalRepoRoot,
		lockPath: resolve( temporaryRoot, `tslp-recapture-lock-${ repoHash }` ),
	};

}

function readRecaptureLockOwner( lockPath ) {

	try {

		const parsed = JSON.parse( readFileSync( resolve( lockPath, 'owner.json' ), 'utf8' ) );
		if (
			parsed?.schemaVersion !== RECAPTURE_LOCK_SCHEMA_VERSION ||
			! Number.isInteger( parsed.pid ) ||
			parsed.pid <= 0 ||
			typeof parsed.startedAt !== 'string' ||
			typeof parsed.repoRoot !== 'string' ||
			typeof parsed.token !== 'string'
		) return null;
		return parsed;

	} catch ( _ ) {

		return null;

	}

}

/**
 * Hold one repository-wide recapture transaction at a time.
 *
 * Artifact staging is intentionally destructive while its rollback backup is
 * active. A repository-scoped lock must therefore be acquired before any
 * selected artifact directory is copied or cleared. The lock lives in the OS
 * temporary directory so it never dirties a consumer repository.
 */
export function acquireRecaptureRepositoryLock( repoRoot, opts = {} ) {

	const temporaryRoot = resolve( opts.temporaryRoot || tmpdir() );
	const { canonicalRepoRoot, lockPath } = recaptureRepositoryLockPath( repoRoot, temporaryRoot );
	const owner = Object.freeze( {
		schemaVersion: RECAPTURE_LOCK_SCHEMA_VERSION,
		pid: Number.isInteger( opts.pid ) ? opts.pid : process.pid,
		startedAt: typeof opts.startedAt === 'string' ? opts.startedAt : new Date().toISOString(),
		repoRoot: canonicalRepoRoot,
		token: typeof opts.token === 'string' ? opts.token : randomUUID(),
	} );
	try {

		mkdirSync( lockPath );

	} catch ( error ) {

		if ( error?.code !== 'EEXIST' ) throw error;
		const existingOwner = readRecaptureLockOwner( lockPath );
		const publicOwner = existingOwner ? Object.freeze( {
			schemaVersion: existingOwner.schemaVersion,
			pid: existingOwner.pid,
			startedAt: existingOwner.startedAt,
			repoRoot: existingOwner.repoRoot,
		} ) : null;
		const ownerLabel = existingOwner
			? `PID ${ existingOwner.pid }, started ${ existingOwner.startedAt }`
			: 'owner metadata is not yet available';
		const lockError = new Error(
			`Another recapture transaction already owns this repository (${ ownerLabel }). ` +
			`Wait for it to finish before retrying. Lock: ${ lockPath }`,
		);
		lockError.code = 'RECAPTURE_ALREADY_RUNNING';
		lockError.lockPath = lockPath;
		lockError.owner = publicOwner;
		throw lockError;

	}
	try {

		writeFileSync(
			resolve( lockPath, 'owner.json' ),
			`${ JSON.stringify( owner, null, 2 ) }\n`,
			{ encoding: 'utf8', flag: 'wx', mode: 0o600 },
		);

	} catch ( error ) {

		rmSync( lockPath, { recursive: true, force: true } );
		throw error;

	}

	let state = 'active';
	return {
		get state() {

			return state;

		},
		get path() {

			return lockPath;

		},
		get owner() {

			return owner;

		},
		release() {

			if ( state !== 'active' ) return;
			const currentOwner = readRecaptureLockOwner( lockPath );
			if ( currentOwner?.token !== owner.token ) {

				state = 'release-conflict';
				const releaseError = new Error(
					`Refusing to release a recapture lock now owned by another process: ${ lockPath }`,
				);
				releaseError.code = 'RECAPTURE_LOCK_OWNERSHIP_CHANGED';
				throw releaseError;

			}
			rmSync( lockPath, { recursive: true, force: true } );
			state = 'released';

		},
	};

}

export function selectRecaptureExamples( examples, args ) {

	const requested = [];
	let port = DEFAULT_RECAPTURE_PORT;
	let allowPrune = false;
	let build = true;
	for ( let index = 0; index < args.length; index ++ ) {

		const arg = args[ index ];
		if ( arg === '--help' || arg === '-h' ) return {
			examples: [],
			help: true,
			port,
			allowPrune,
			build,
		};
		if ( arg === '--allow-prune' ) {

			allowPrune = true;
			continue;

		}
		if ( arg === '--skip-build' ) {

			build = false;
			continue;

		}
		if ( arg === '--example' ) {

			const name = args[ index + 1 ];
			if ( ! name || name.startsWith( '-' ) ) throw new Error( '--example requires a configured example name.' );
			requested.push( name );
			index ++;
			continue;

		}
		if ( arg.startsWith( '--example=' ) ) {

			const name = arg.slice( '--example='.length );
			if ( name.length === 0 ) throw new Error( '--example requires a configured example name.' );
			requested.push( name );
			continue;

		}
		if ( arg === '--port' || arg.startsWith( '--port=' ) ) {

			const inline = arg.startsWith( '--port=' ) ? arg.slice( '--port='.length ) : null;
			const value = inline === null ? args[ index + 1 ] : inline;
			if ( value === undefined || value === '' || ( inline === null && value.startsWith( '-' ) ) ) {

				throw new Error( '--port requires a TCP port number.' );

			}
			if ( inline === null ) index ++;
			port = Number( value );
			if ( ! Number.isSafeInteger( port ) || port < 1 || port > 65535 ) {

				throw new Error( '--port must be an integer between 1 and 65535.' );

			}
			continue;

		}
		throw new Error( `Unknown recapture-all option: ${ arg }` );

	}
	if ( requested.length === 0 ) return {
		examples: examples.slice(),
		help: false,
		port,
		allowPrune,
		build,
	};

	const byName = new Map( examples.map( ( example ) => [ example.name, example ] ) );
	const unknown = [ ...new Set( requested.filter( ( name ) => ! byName.has( name ) ) ) ];
	if ( unknown.length > 0 ) throw new Error(
		`Unknown recapture example${ unknown.length === 1 ? '' : 's' }: ${ unknown.join( ', ' ) }. ` +
		`Configured examples: ${ [ ...byName.keys() ].join( ', ' ) }.`,
	);
	return {
		examples: [ ...new Set( requested ) ].map( ( name ) => byName.get( name ) ),
		help: false,
		port,
		allowPrune,
		build,
	};

}

export function recaptureVerificationDirectories( examples ) {

	return examples.map( ( example ) => {

		if ( ! example || typeof example.name !== 'string' || ! EXAMPLE_NAME.test( example.name ) ) {

			throw new Error( `Invalid recapture example name: ${ JSON.stringify( example && example.name ) }` );

		}
		return `packages/examples/${ example.name }/artifacts`;

	} );

}

export function recaptureVerificationArgs( example ) {

	if ( ! example || typeof example.name !== 'string' || ! EXAMPLE_NAME.test( example.name ) ) {

		throw new Error( `Invalid recapture example name: ${ JSON.stringify( example && example.name ) }` );

	}
	if ( typeof example.sourceRoot !== 'string' || example.sourceRoot.length === 0 ) {

		throw new Error( `Recapture example ${ example.name } is missing sourceRoot metadata.` );

	}
	if ( ! Array.isArray( example.sources ) || example.sources.length === 0 ) {

		throw new Error( `Recapture example ${ example.name } is missing source coverage paths.` );

	}
	const args = [
		`packages/examples/${ example.name }/artifacts`,
		'--source-root',
		example.sourceRoot,
	];
	for ( const source of example.sources ) args.push( '--source', source );
	if ( example.autoMark === false ) args.push( '--no-auto-mark' );
	return args;

}

export async function waitForRecaptureServerReady( url, opts = {} ) {

	const timeoutMs = Number.isFinite( opts.timeoutMs ) && opts.timeoutMs > 0 ? opts.timeoutMs : 30_000;
	const intervalMs = Number.isFinite( opts.intervalMs ) && opts.intervalMs >= 0 ? opts.intervalMs : 100;
	const fetchImpl = opts.fetchImpl || globalThis.fetch;
	const wait = opts.wait || waitForDelay;
	const signal = opts.signal || null;
	const now = opts.now || Date.now;
	if ( typeof fetchImpl !== 'function' ) throw new Error( 'waitForRecaptureServerReady requires fetch support.' );
	const parsed = new URL( url );
	if ( parsed.protocol !== 'http:' && parsed.protocol !== 'https:' ) {

		throw new Error( `Recapture readiness URL must use HTTP(S): ${ url }` );

	}
	const startedAt = now();
	let lastFailure = 'server did not respond';
	while ( now() - startedAt < timeoutMs ) {

		if ( signal?.aborted ) throw signal.reason instanceof Error ? signal.reason : new Error( 'Recapture interrupted.' );
		try {

			const remainingMs = Math.max( 1, timeoutMs - ( now() - startedAt ) );
			const response = await fetchWithDeadline( fetchImpl, parsed, signal, remainingMs );
			if ( response && Number.isInteger( response.status ) && response.status >= 200 && response.status < 400 ) {

				try {

					if ( response.body && typeof response.body.cancel === 'function' ) await response.body.cancel();

				} catch ( _ ) { /* readiness was already established */ }
				return response;

			}
			lastFailure = `HTTP ${ response?.status ?? '<unknown>' }`;

		} catch ( error ) {

			if ( signal?.aborted ) throw signal.reason instanceof Error ? signal.reason : error;
			lastFailure = error && error.message || String( error );

		}
		if ( now() - startedAt >= timeoutMs ) break;
		await wait( intervalMs, signal );

	}
	throw new Error( `Dev server did not become ready at ${ parsed.href } within ${ timeoutMs }ms (${ lastFailure }).` );

}

function fetchWithDeadline( fetchImpl, url, signal, timeoutMs ) {

	const controller = new AbortController();
	let timer = null;
	let settled = false;
	let rejectDeadline;
	const deadline = new Promise( ( _resolveDeadline, rejectPromise ) => {

		rejectDeadline = rejectPromise;

	} );
	const finish = () => {

		if ( settled ) return;
		settled = true;
		if ( timer !== null ) clearTimeout( timer );
		if ( signal ) signal.removeEventListener( 'abort', onAbort );

	};
	const abort = ( reason ) => {

		if ( settled ) return;
		const error = reason instanceof Error ? reason : new Error( String( reason || 'Recapture readiness request aborted.' ) );
		controller.abort( error );
		rejectDeadline( error );

	};
	const onAbort = () => abort(
		signal.reason instanceof Error ? signal.reason : new Error( 'Recapture interrupted.' ),
	);
	if ( signal?.aborted ) onAbort();
	else if ( signal ) signal.addEventListener( 'abort', onAbort, { once: true } );
	timer = setTimeout( () => abort(
		new Error( `Readiness request timed out after ${ timeoutMs }ms.` ),
	), timeoutMs );

	let request;
	try {

		request = Promise.resolve( fetchImpl( url, { signal: controller.signal } ) );

	} catch ( error ) {

		request = Promise.reject( error );

	}
	return Promise.race( [ request, deadline ] ).finally( finish );

}

function waitForDelay( milliseconds, signal ) {

	return new Promise( ( resolvePromise, rejectPromise ) => {

		if ( signal?.aborted ) {

			rejectPromise( signal.reason instanceof Error ? signal.reason : new Error( 'Recapture interrupted.' ) );
			return;

		}
		let settled = false;
		let timer = null;
		const onAbort = () => {

			if ( settled ) return;
			settled = true;
			if ( timer !== null ) clearTimeout( timer );
			signal.removeEventListener( 'abort', onAbort );
			rejectPromise( signal.reason instanceof Error ? signal.reason : new Error( 'Recapture interrupted.' ) );

		};
		timer = setTimeout( () => {

			if ( settled ) return;
			settled = true;
			if ( signal ) signal.removeEventListener( 'abort', onAbort );
			resolvePromise();

		}, milliseconds );
		if ( ! signal ) return;
		signal.addEventListener( 'abort', onAbort, { once: true } );

	} );

}

export function installRecaptureSignalHandlers( processTarget, abortController ) {

	let receivedSignal = null;
	const handlers = new Map(
		[ 'SIGINT', 'SIGTERM', 'SIGHUP' ].map( ( signal ) => [
			signal,
			() => {

				if ( receivedSignal !== null ) return;
				receivedSignal = signal;
				abortController.abort( new Error( `Recapture interrupted by ${ signal }.` ) );

			},
		] ),
	);
	for ( const [ signal, handler ] of handlers ) processTarget.on( signal, handler );
	return {
		get receivedSignal() {

			return receivedSignal;

		},
		dispose() {

			for ( const [ signal, handler ] of handlers ) processTarget.removeListener( signal, handler );

		},
	};

}

/**
 * Ask a child to stop cleanly, then force termination after a bounded grace
 * period. Recapture holds the artifact rollback transaction open until every
 * child closes, so an ignored SIGTERM must not strand the original artifacts
 * in the temporary backup indefinitely.
 */
export function terminateRecaptureChild( child, opts = {} ) {

	if ( ! child || child.exitCode !== null || child.signalCode !== null ) return () => {};
	const graceMs = Number.isFinite( opts.graceMs ) && opts.graceMs >= 0 ? opts.graceMs : 5_000;
	const setTimer = opts.setTimer || setTimeout;
	const clearTimer = opts.clearTimer || clearTimeout;
	const killProcess = opts.killProcess || process.kill.bind( process );
	const sendSignal = ( signal ) => {

		if ( child.__tslpProcessGroup === true && Number.isInteger( child.pid ) && child.pid > 0 ) {

			try {

				killProcess( - child.pid, signal );
				return;

			} catch ( error ) {

				if ( error?.code === 'ESRCH' ) return;
				// Fall through to the direct-child API when the platform or
				// process host cannot address POSIX process groups.

			}

		}
		child.kill( signal );

	};
	let timer = null;
	let disposed = false;
	const dispose = () => {

		if ( disposed ) return;
		disposed = true;
		if ( timer !== null ) clearTimer( timer );
		if ( typeof child.removeListener === 'function' ) child.removeListener( 'close', dispose );

	};
	if ( typeof child.once === 'function' ) child.once( 'close', dispose );
	sendSignal( 'SIGTERM' );
	if ( child.exitCode === null && child.signalCode === null ) {

		timer = setTimer( () => {

			timer = null;
			if ( child.exitCode === null && child.signalCode === null ) sendSignal( 'SIGKILL' );

		}, graceMs );
		if ( timer && typeof timer.unref === 'function' ) timer.unref();

	}
	return dispose;

}

function isContainedPath( root, candidate ) {

	const fromRoot = relative( root, candidate );
	return fromRoot === '' || (
		fromRoot !== '..' &&
		! fromRoot.startsWith( `..${ sep }` ) &&
		! isAbsolute( fromRoot )
	);

}

function lstatIfPresent( path ) {

	try {

		return lstatSync( path );

	} catch ( error ) {

		if ( error && error.code === 'ENOENT' ) return null;
		throw error;

	}

}

function assertSafeExistingComponents( root, candidate, label ) {

	if ( ! isContainedPath( root, candidate ) ) throw new Error( `Refusing to access ${ label } outside ${ root }: ${ candidate }` );
	const relativePath = relative( root, candidate );
	const components = relativePath === '' ? [] : relativePath.split( sep );
	let current = root;
	for ( const component of [ '', ...components ] ) {

		if ( component ) current = resolve( current, component );
		const stat = lstatIfPresent( current );
		if ( ! stat ) break;
		if ( stat.isSymbolicLink() ) throw new Error( `Refusing to stage a symbolic-link path component: ${ current }` );
		if ( current !== candidate && ! stat.isDirectory() ) {

			throw new Error( `Expected recapture path component to be a directory: ${ current }` );

		}

	}

}

function assertRealPathContained( rootRealPath, candidate, label ) {

	const candidateRealPath = realpathSync( candidate );
	if ( ! isContainedPath( rootRealPath, candidateRealPath ) ) {

		throw new Error( `Refusing to stage ${ label } outside the real repository path: ${ candidateRealPath }` );

	}
	return candidateRealPath;

}

function assertTreeHasNoSymlinks( directory ) {

	for ( const entry of readdirSync( directory, { withFileTypes: true } ) ) {

		const path = resolve( directory, entry.name );
		const stat = lstatSync( path );
		if ( stat.isSymbolicLink() ) throw new Error( `Refusing to stage a symbolic link inside an artifact directory: ${ path }` );
		if ( stat.isDirectory() ) assertTreeHasNoSymlinks( path );

	}

}

function validateArtifactEntryPath( entry ) {

	assertSafeExistingComponents( entry.repoRoot, entry.artifactsDir, 'artifact directory' );
	const exampleRealPath = assertRealPathContained( entry.examplesRootRealPath, entry.exampleDir, 'example directory' );
	const stat = lstatIfPresent( entry.artifactsDir );
	if ( ! stat ) return null;
	if ( stat.isSymbolicLink() ) throw new Error( `Refusing to stage a symbolic-link artifact directory: ${ entry.artifactsDir }` );
	if ( ! stat.isDirectory() ) throw new Error( `Expected artifact path to be a directory: ${ entry.artifactsDir }` );
	assertRealPathContained( exampleRealPath, entry.artifactsDir, 'artifact directory' );
	return stat;

}

function artifactDirectoryEntry( repoRoot, backupRoot, example ) {

	if ( ! example || typeof example.name !== 'string' || ! EXAMPLE_NAME.test( example.name ) ) {

		throw new Error( `Invalid recapture example name: ${ JSON.stringify( example && example.name ) }` );

	}
	const resolvedRepoRoot = resolve( repoRoot );
	const examplesRoot = resolve( resolvedRepoRoot, 'packages/examples' );
	const exampleDir = resolve( examplesRoot, example.name );
	const artifactsDir = resolve( exampleDir, 'artifacts' );
	if ( ! isContainedPath( examplesRoot, artifactsDir ) ) throw new Error(
		`Refusing to stage an artifact directory outside packages/examples: ${ artifactsDir }`,
	);
	assertSafeExistingComponents( resolvedRepoRoot, exampleDir, 'example directory' );
	const repoRootRealPath = realpathSync( resolvedRepoRoot );
	const examplesRootRealPath = assertRealPathContained( repoRootRealPath, examplesRoot, 'examples directory' );
	assertRealPathContained( examplesRootRealPath, exampleDir, 'example directory' );
	const backupDir = resolve( backupRoot, example.name, 'artifacts' );
	const entry = {
		repoRoot: resolvedRepoRoot,
		repoRootRealPath,
		examplesRootRealPath,
		exampleDir,
		artifactsDir,
		backupDir,
		existed: false,
	};
	const stat = validateArtifactEntryPath( entry );
	const existed = stat !== null;
	entry.existed = existed;
	if ( existed ) {

		assertTreeHasNoSymlinks( artifactsDir );

	}
	return entry;

}

function readArtifactInventory( entry ) {

	const stat = validateArtifactEntryPath( entry );
	if ( ! stat ) return Object.freeze( {
		name: entry.exampleName,
		identities: Object.freeze( [] ),
		auxiliaryShapes: Object.freeze( [] ),
	} );
	assertTreeHasNoSymlinks( entry.artifactsDir );
	const manifestPath = resolve( entry.artifactsDir, 'manifest.json' );
	const manifestStat = lstatIfPresent( manifestPath );
	if ( ! manifestStat ) return Object.freeze( {
		name: entry.exampleName,
		identities: Object.freeze( [] ),
		auxiliaryShapes: Object.freeze( [] ),
	} );
	if ( manifestStat.isSymbolicLink() || ! manifestStat.isFile() ) {

		throw new Error( `Expected a regular artifact manifest file: ${ manifestPath }` );

	}
	let manifest;
	try {

		manifest = JSON.parse( readFileSync( manifestPath, 'utf8' ) );

	} catch ( error ) {

		throw new Error( `Could not read recapture inventory from ${ manifestPath}: ${ error.message || String( error ) }` );

	}
	if ( ! manifest || typeof manifest !== 'object' || Array.isArray( manifest ) ) {

		throw new Error( `Expected an object artifact manifest in ${ manifestPath}` );

	}
	const identities = [];
	const auxiliaryShapes = [];
	for ( const name of Object.keys( manifest ) ) {

		if ( name !== '__aux' ) identities.push( `material:${ name }` );

	}
	if ( manifest.__aux !== undefined ) {

		if ( ! manifest.__aux || typeof manifest.__aux !== 'object' || Array.isArray( manifest.__aux ) ) {

			throw new Error( `Expected manifest.__aux to be an object in ${ manifestPath}` );

		}
		for ( const [ key, manifestEntry ] of Object.entries( manifest.__aux ) ) {

			identities.push( `aux:${ key }` );
			const shape = manifestEntry && typeof manifestEntry.shape === 'string'
				? manifestEntry.shape
				: key.slice( 0, key.lastIndexOf( ':' ) );
			if ( shape.length === 0 ) throw new Error( `Could not identify auxiliary shape ${ JSON.stringify( key ) } in ${ manifestPath}` );
			auxiliaryShapes.push( shape );

		}

	}
	identities.sort();
	auxiliaryShapes.sort();
	return Object.freeze( {
		name: entry.exampleName,
		identities: Object.freeze( identities ),
		auxiliaryShapes: Object.freeze( auxiliaryShapes ),
	} );

}

export function readRecaptureArtifactInventories( repoRoot, examples ) {

	const inventoryRoot = resolve( repoRoot, '.tslp-inventory-read-only' );
	return Object.freeze( examples.map( ( example ) => {

		const entry = artifactDirectoryEntry( repoRoot, inventoryRoot, example );
		entry.exampleName = example.name;
		return readArtifactInventory( entry );

	} ) );

}

export function compareRecaptureArtifactInventories( previous, current ) {

	const currentByName = new Map( ( current || [] ).map( ( entry ) => [ entry.name, entry ] ) );
	return Object.freeze( ( previous || [] ).map( ( before ) => {

		const after = currentByName.get( before.name ) || { identities: [] };
		const beforeSet = new Set( before.identities || [] );
		const afterSet = new Set( after.identities || [] );
		const unmatchedBefore = [ ...beforeSet ].filter( ( identity ) => ! afterSet.has( identity ) );
		const unmatchedAfter = [ ...afterSet ].filter( ( identity ) => ! beforeSet.has( identity ) );
		const availableReplacements = new Map();
		for ( const identity of unmatchedAfter ) {

			const semantic = auxiliarySemanticIdentity( identity );
			if ( ! semantic ) continue;
			const candidates = availableReplacements.get( semantic ) || [];
			candidates.push( identity );
			availableReplacements.set( semantic, candidates );

		}
		const replaced = [];
		const replacedBefore = new Set();
		const replacedAfter = new Set();
		for ( const identity of unmatchedBefore ) {

			const semantic = auxiliarySemanticIdentity( identity );
			const candidates = semantic && availableReplacements.get( semantic );
			const replacement = candidates && candidates.shift();
			if ( ! replacement ) continue;
			replacedBefore.add( identity );
			replacedAfter.add( replacement );
			replaced.push( Object.freeze( {
				semantic,
				previous: identity,
				current: replacement,
			} ) );

		}
		return Object.freeze( {
			name: before.name,
			missing: Object.freeze( unmatchedBefore.filter( ( identity ) => ! replacedBefore.has( identity ) ).sort() ),
			added: Object.freeze( unmatchedAfter.filter( ( identity ) => ! replacedAfter.has( identity ) ).sort() ),
			replaced: Object.freeze( replaced.sort( ( left, right ) =>
				left.previous.localeCompare( right.previous )
			) ),
		} );

	} ) );

}

function auxiliarySemanticIdentity( identity ) {

	if ( typeof identity !== 'string' || ! identity.startsWith( 'aux:' ) ) return null;
	const separatorIndex = identity.lastIndexOf( ':' );
	if ( separatorIndex <= 'aux:'.length ) return null;
	return identity.slice( 0, separatorIndex );

}

export function assertRecaptureAuxiliaryObligations( inventories, examples ) {

	const byName = new Map( ( inventories || [] ).map( ( inventory ) => [ inventory.name, inventory ] ) );
	const report = [];
	for ( const example of examples || [] ) {

		const required = [ ...new Set( example.requiredAuxiliaryShapes || [] ) ].sort();
		const inventory = byName.get( example.name );
		const present = new Set( inventory?.auxiliaryShapes || [] );
		const missing = required.filter( ( shape ) => ! present.has( shape ) );
		report.push( Object.freeze( {
			name: example.name,
			required: Object.freeze( required ),
			missing: Object.freeze( missing ),
		} ) );

	}
	const incomplete = report.filter( ( entry ) => entry.missing.length > 0 );
	if ( incomplete.length > 0 ) {

		const summary = incomplete.map( ( entry ) =>
			`${ entry.name }: ${ entry.missing.join( ', ' ) }`
		).join( '; ' );
		throw new Error(
			`Recapture did not produce required auxiliary support (${ summary }). ` +
			'Visit every configured route and resolve failed internal-pass capture before committing artifacts.',
		);

	}
	return Object.freeze( report );

}

export function assertRecaptureArtifactInventoryCoverage( previous, current, opts = {} ) {

	const report = compareRecaptureArtifactInventories( previous, current );
	const incomplete = report.filter( ( entry ) => entry.missing.length > 0 );
	if ( incomplete.length > 0 && opts.allowPrune !== true ) {

		const summary = incomplete.map( ( entry ) =>
			`${ entry.name }: ${ entry.missing.join( ', ' ) }`
		).join( '; ' );
		throw new Error(
			`Recapture omitted previously supported artifact identities (${ summary }). ` +
			'Visit the missing render paths, or pass --allow-prune when removing support intentionally.',
		);

	}
	return report;

}

function restoreArtifactDirectories( entries ) {

	const errors = [];
	for ( const entry of entries ) {

		try {

			const { artifactsDir, backupDir, existed } = entry;
			validateArtifactEntryPath( entry );
			rmSync( artifactsDir, { recursive: true, force: true } );
			if ( existed ) {

				mkdirSync( resolve( artifactsDir, '..' ), { recursive: true } );
				assertTreeHasNoSymlinks( backupDir );
				cpSync( backupDir, artifactsDir, {
					recursive: true,
					dereference: false,
					verbatimSymlinks: true,
				} );

			}

		} catch ( error ) {

			errors.push( error );

		}

	}
	if ( errors.length > 0 ) throw new AggregateError( errors, 'Could not restore every recapture artifact directory.' );

}

export function stageFreshArtifactDirectories( repoRoot, examples, opts = {} ) {

	const backupRoot = mkdtempSync( resolve( opts.temporaryRoot || tmpdir(), 'tslp-recapture-all-' ) );
	let entries = [];
	let previousInventories = Object.freeze( [] );
	let cleared = false;
	try {

		entries = examples.map( ( example ) => artifactDirectoryEntry( repoRoot, backupRoot, example ) );
		for ( let index = 0; index < entries.length; index ++ ) entries[ index ].exampleName = examples[ index ].name;
		previousInventories = Object.freeze( entries.map( readArtifactInventory ) );
		for ( const entry of entries ) {

			const { artifactsDir, backupDir, existed } = entry;
			if ( ! existed ) continue;
			if ( ! validateArtifactEntryPath( entry ) ) throw new Error( `Artifact directory disappeared during staging: ${ artifactsDir }` );
			assertTreeHasNoSymlinks( artifactsDir );
			mkdirSync( resolve( backupDir, '..' ), { recursive: true } );
			cpSync( artifactsDir, backupDir, {
				recursive: true,
				dereference: false,
				verbatimSymlinks: true,
			} );
			assertTreeHasNoSymlinks( backupDir );

		}
		cleared = true;
		for ( const entry of entries ) {

			const { artifactsDir, existed } = entry;
			const current = validateArtifactEntryPath( entry );
			if ( existed !== Boolean( current ) ) throw new Error( `Artifact directory changed during staging: ${ artifactsDir }` );
			rmSync( artifactsDir, { recursive: true, force: true } );

		}

	} catch ( stageError ) {

		let rollbackError = null;
		if ( cleared ) {

			try {

				restoreArtifactDirectories( entries );

			} catch ( error ) {

				rollbackError = error;

			}

		}
		if ( rollbackError ) throw new AggregateError(
			[ stageError, rollbackError ],
			`Recapture staging failed and rollback was incomplete. Backups remain at ${ backupRoot }.`,
		);
		rmSync( backupRoot, { recursive: true, force: true } );
		throw stageError;

	}

	let state = 'active';
	return {
		get state() {

			return state;

		},
		get previousInventories() {

			return previousInventories;

		},
			commit() {

				if ( state !== 'active' ) return;
				state = 'committing';
				try {

					rmSync( backupRoot, { recursive: true, force: true } );

				} catch ( error ) {

					state = 'commit-cleanup-failed';
					throw new Error(
						`Fresh artifacts were verified and retained, but the recapture backup could not be removed: ${ backupRoot }`,
						{ cause: error },
					);

				}
				state = 'committed';

		},
		rollback() {

			if ( state !== 'active' ) return;
			try {

				restoreArtifactDirectories( entries );

			} catch ( error ) {

				state = 'rollback-failed';
				throw new AggregateError(
					[ error ],
					`Could not restore every artifact directory. Backups remain at ${ backupRoot }.`,
				);

			}
			rmSync( backupRoot, { recursive: true, force: true } );
			state = 'rolled-back';

		},
	};

}
