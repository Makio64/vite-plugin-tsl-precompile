#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runReleaseCheck } from './release-check.mjs';
import {
	collectReleaseTarballIntegrity,
	computeTarballIntegrity,
	PUBLIC_PACKAGES,
} from './release-tarball-integrity.mjs';
import {
	compareReleaseSemver,
	parseReleaseSemver,
} from './release-semver.mjs';
import { assertReleaseState, DEFAULT_REPO_ROOT } from './release-state.mjs';

export const NPM_REGISTRY = 'https://registry.npmjs.org/';
export const NPM_SCOPE_REGISTRY_OPTION = `--@tsl-precompile:registry=${ NPM_REGISTRY }`;

export function parseDistTag( argv ) {

	const values = [];
	for ( let index = 0; index < argv.length; index ++ ) {

		const arg = argv[ index ];
		if ( arg === '--' && index === 0 ) {

			continue;

		} else if ( arg.startsWith( '--tag=' ) ) {

			values.push( arg.slice( '--tag='.length ) );

		} else if ( arg === '--tag' ) {

			values.push( argv[ ++ index ] );

		} else {

			throw new Error( `unknown release-publish option: ${ arg }` );

		}

	}

	if ( values.length !== 1 || ( values[ 0 ] !== 'alpha' && values[ 0 ] !== 'latest' ) ) {

		throw new Error( 'pass exactly one publication channel: --tag=alpha or --tag=latest' );

	}
	return values[ 0 ];

}

export function buildTarballPublishArgs( tarballPath, distTag ) {

	if ( ! isAbsolute( tarballPath ) ) throw new Error( 'release tarball path must be absolute' );
	return [
		'publish',
		tarballPath,
		'--access', 'public',
		'--tag', distTag,
		'--registry', NPM_REGISTRY,
		NPM_SCOPE_REGISTRY_OPTION,
	];

}

export function buildDistTagArgs( packageName, version, distTag ) {

	return [
		'dist-tag',
		'add',
		`${ packageName }@${ version }`,
		distTag,
		'--registry', NPM_REGISTRY,
		NPM_SCOPE_REGISTRY_OPTION,
	];

}

export function assertDistTagMatchesVersion( distTag, version ) {

	const parsed = parseReleaseSemver( version );
	if ( distTag === 'latest' && parsed.prerelease ) {

		throw new Error( `refusing to publish prerelease ${ version } under latest` );

	}
	if ( distTag === 'alpha' && parsed.prerelease?.[ 0 ] !== 'alpha' ) {

		throw new Error( `refusing to publish non-alpha ${ version } under alpha` );

	}

}

export function compareSemver( leftVersion, rightVersion ) {

	return compareReleaseSemver( leftVersion, rightVersion );

}

function run( command, args, options = {}, repoRoot = DEFAULT_REPO_ROOT ) {

	console.log( `[release-publish] ${ command } ${ args.join( ' ' ) }` );
	const result = spawnSync( command, args, {
		cwd: repoRoot,
		env: { ...process.env, ...options.env },
		stdio: 'inherit',
	} );
	if ( result.error ) throw result.error;
	if ( result.signal ) throw new Error( `${ command } terminated by ${ result.signal }` );
	if ( result.status !== 0 ) throw new Error( `${ command } exited ${ result.status }` );

}

function npmJson( args, {
	repoRoot = DEFAULT_REPO_ROOT,
	allowNotFound = false,
} = {} ) {

	const result = spawnSync(
		'npm',
		[ ...args, '--registry', NPM_REGISTRY, NPM_SCOPE_REGISTRY_OPTION ],
		{
		cwd: repoRoot,
		encoding: 'utf8',
		stdio: [ 'ignore', 'pipe', 'pipe' ],
		}
	);
	if ( result.error ) throw result.error;
	if ( result.signal ) throw new Error( `npm ${ args.join( ' ' ) } terminated by ${ result.signal }` );
	if ( result.status !== 0 ) {

		const detail = `${ result.stdout || '' }\n${ result.stderr || '' }`.trim();
		if ( allowNotFound && /\bE404\b|404 Not Found|is not in this registry/i.test( detail ) ) return null;
		throw new Error( `npm ${ args.join( ' ' ) } exited ${ result.status }: ${ detail }` );

	}
	const output = String( result.stdout || '' ).trim();
	if ( ! output ) return null;
	try {

		return JSON.parse( output );

	} catch ( cause ) {

		throw new Error( `npm ${ args.join( ' ' ) } returned invalid JSON`, { cause } );

	}

}

export function readRegistryPackageState( {
	name,
	version,
	distTag,
	repoRoot = DEFAULT_REPO_ROOT,
	query = npmJson,
} ) {

	const summary = query( [ 'view', name, 'versions', 'dist-tags', '--json' ], {
		repoRoot,
		allowNotFound: true,
	} );
	if ( summary === null ) {

		return {
			name,
			version,
			packageExists: false,
			currentTagVersion: null,
			published: false,
			integrity: null,
			shasum: null,
		};

	}
	const versionsValue = summary.versions;
	const versions = Array.isArray( versionsValue )
		? versionsValue
		: ( typeof versionsValue === 'string' ? [ versionsValue ] : [] );
	const currentTagVersion = summary[ 'dist-tags' ]?.[ distTag ] || null;
	const published = versions.includes( version );
	let dist = null;
	if ( published ) {

		dist = query( [ 'view', `${ name }@${ version }`, 'dist.integrity', 'dist.shasum', '--json' ], {
			repoRoot,
		} );

	}
	return {
		name,
		version,
		packageExists: versions.length > 0,
		currentTagVersion,
		published,
		integrity: dist?.[ 'dist.integrity' ] ?? dist?.integrity ?? null,
		shasum: dist?.[ 'dist.shasum' ] ?? dist?.shasum ?? null,
	};

}

function authorizedUserNames( value ) {

	if ( typeof value === 'string' ) return authorizedUserNames( [ value ] );
	if ( Array.isArray( value ) ) {

		return value.flatMap( ( entry ) => {

			if ( typeof entry === 'string' ) {

				const npmPersonName = /^([^\s<]+)(?:\s|<|$)/.exec( entry )?.[ 1 ];
				return npmPersonName && npmPersonName !== entry ? [ entry, npmPersonName ] : [ entry ];

			}
			if ( entry && typeof entry === 'object' ) {

				return [
					...( typeof entry.user === 'string' ? [ entry.user ] : [] ),
					...( typeof entry.name === 'string' ? [ entry.name ] : [] ),
					...Object.keys( entry ),
				];

			}
			return [];

		} );

	}
	if ( value && typeof value === 'object' ) return Object.keys( value );
	return [];

}

function orgRoleAllowsPublish( value, username ) {

	const allowedRoles = new Set( [ 'developer', 'admin', 'owner' ] );
	if ( typeof value === 'string' ) return allowedRoles.has( value );
	if ( Array.isArray( value ) ) {

		return value.some( ( entry ) => (
			entry === username ||
			( entry && typeof entry === 'object' &&
				( entry.user === username || entry.name === username ) &&
				( ! entry.role || allowedRoles.has( entry.role ) ) )
		) );

	}
	if ( value && typeof value === 'object' ) {

		const role = value[ username ];
		if ( typeof role === 'string' ) return allowedRoles.has( role );
		if ( role && typeof role === 'object' ) return ! role.role || allowedRoles.has( role.role );

	}
	return false;

}

export function preflightNpmAuthority( {
	tarballs,
	registryStates,
	repoRoot = DEFAULT_REPO_ROOT,
	query = npmJson,
} ) {

	const whoami = query( [ 'whoami', '--json' ], { repoRoot } );
	const username = typeof whoami === 'string' ? whoami : whoami?.username;
	if ( typeof username !== 'string' || username.length === 0 ) {

		throw new Error( `npm authentication preflight returned no username for ${ NPM_REGISTRY }` );

	}
	for ( let index = 0; index < tarballs.length; index ++ ) {

		const tarball = tarballs[ index ];
		const registry = registryStates[ index ];
		if ( registry.packageExists ) {

			const owners = query( [ 'view', tarball.name, 'maintainers.name', '--json' ], { repoRoot } );
			if ( ! authorizedUserNames( owners ).includes( username ) ) {

				throw new Error(
					`authenticated npm user ${ username } is not a maintainer of existing package ${ tarball.name }`
				);

			}
			continue;

		}
		const scopeMatch = /^@([^/]+)\//.exec( tarball.name );
		if ( scopeMatch ) {

			const organization = scopeMatch[ 1 ];
			const membership = query( [ 'org', 'ls', organization, username, '--json' ], { repoRoot } );
			if ( ! orgRoleAllowsPublish( membership, username ) ) {

				throw new Error(
					`authenticated npm user ${ username } has no publish-capable role in @${ organization } ` +
					`for first publication of ${ tarball.name }`
				);

			}

		} else {

			console.log(
				`[release-publish] first publication preflight: unscoped name ${ tarball.name } is unclaimed; ` +
				`authenticated publisher is ${ username }`
			);

		}

	}
	console.log( `[release-publish] authenticated npm publisher: ${ username }` );
	return username;

}

function sameIntegrity( left, right ) {

	return left.integrity === right.integrity && left.shasum === right.shasum;

}

function sameRegistryState( left, right ) {

	return (
		left.name === right.name &&
		left.version === right.version &&
		left.packageExists === right.packageExists &&
		left.currentTagVersion === right.currentTagVersion &&
		left.published === right.published &&
		left.integrity === right.integrity &&
		left.shasum === right.shasum
	);

}

function sleepSync( milliseconds ) {

	Atomics.wait( new Int32Array( new SharedArrayBuffer( 4 ) ), 0, 0, milliseconds );

}

export function verifyPublishedRegistryState( {
	entry,
	distTag,
	readRegistryState,
	repoRoot,
	retryDelays = [ 1000, 2000, 4000, 8000 ],
	wait = sleepSync,
} ) {

	let lastError = null;
	for ( let attempt = 0; attempt <= retryDelays.length; attempt ++ ) {

		try {

			const registry = readRegistryState( {
				name: entry.name,
				version: entry.version,
				distTag,
				repoRoot,
			} );
			assertPublishedRegistryState( entry, registry, distTag );
			return registry;

		} catch ( error ) {

			lastError = error;
			if ( attempt === retryDelays.length ) break;
			const delay = retryDelays[ attempt ];
			console.log(
				`[release-publish] registry verification for ${ entry.name } not visible yet; ` +
				`retrying in ${ delay }ms`
			);
			wait( delay );

		}

	}
	throw lastError;

}

export function planRegistryPublication( tarballs, distTag, registryStates ) {

	if ( tarballs.length !== PUBLIC_PACKAGES.length || registryStates.length !== tarballs.length ) {

		throw new Error( 'registry preflight must cover every public package before publication' );

	}
	return tarballs.map( ( tarball, index ) => {

		const registry = registryStates[ index ];
		if ( registry.name !== tarball.name || registry.version !== tarball.version ) {

			throw new Error( `registry preflight identity drifted for ${ tarball.name }` );

		}
		if ( registry.currentTagVersion && compareSemver( tarball.version, registry.currentTagVersion ) < 0 ) {

			throw new Error(
				`refusing to move ${ tarball.name } ${ distTag } backward from ` +
				`${ registry.currentTagVersion } to ${ tarball.version }`
			);

		}
		if ( registry.published && ! sameIntegrity( tarball, registry ) ) {

			throw new Error(
				`${ tarball.name }@${ tarball.version } already exists with registry bytes that do not match ` +
				'the verified release tarball'
			);

		}
		let action = 'publish';
		if ( registry.published ) {

			action = registry.currentTagVersion === tarball.version ? 'none' : 'tag';

		} else if ( registry.currentTagVersion === tarball.version ) {

			throw new Error( `${ tarball.name } ${ distTag } points to an unavailable candidate version` );

		}
		return { ...tarball, action, registry };

	} );

}

export function verifyCheckedTarballs( releaseCheck, initial, repoRoot ) {

	if (
		! releaseCheck ||
		typeof releaseCheck.resultsRoot !== 'string' ||
		typeof releaseCheck.tarballDirectory !== 'string' ||
		! Array.isArray( releaseCheck.tarballs )
	) {

		throw new Error( 'complete release check did not return its verified private tarball set' );

	}
	const resultsRoot = resolve( releaseCheck.resultsRoot );
	const tarballDirectory = resolve( releaseCheck.tarballDirectory );
	const nested = relative( resultsRoot, tarballDirectory );
	if ( ! nested || nested === '..' || nested.startsWith( `..${ sep }` ) || isAbsolute( nested ) ) {

		throw new Error( 'verified release tarballs must be inside the unique release-check result root' );

	}
	const repoRelative = relative( resolve( repoRoot ), tarballDirectory );
	if ( ! repoRelative || ( repoRelative !== '..' && ! repoRelative.startsWith( `..${ sep }` ) && ! isAbsolute( repoRelative ) ) ) {

		throw new Error( 'verified release tarballs must not be staged inside the repository' );

	}
	const actual = collectReleaseTarballIntegrity( { repoRoot, tarballDirectory } );
	if ( JSON.stringify( actual ) !== JSON.stringify( releaseCheck.tarballs ) ) {

		throw new Error( 'release tarball bytes changed after the release integrity gate' );

	}
	for ( let index = 0; index < actual.length; index ++ ) {

		const expected = PUBLIC_PACKAGES[ index ];
		const tarball = actual[ index ];
		if ( tarball.name !== expected.name || tarball.version !== initial.version ) {

			throw new Error( `release tarball identity/version drifted for ${ expected.name }` );

		}

	}
	return actual.map( ( tarball ) => ( {
		...tarball,
		path: resolve( tarballDirectory, tarball.file ),
	} ) );

}

export function assertTarballBytesUnchanged( tarball ) {

	const actual = computeTarballIntegrity( tarball.path );
	if ( actual.bytes !== tarball.bytes || ! sameIntegrity( actual, tarball ) ) {

		throw new Error( `verified release tarball changed before publication: ${ tarball.path }` );

	}

}

function assertPublishedRegistryState( entry, registry, distTag ) {

	if (
		! registry.published ||
		registry.currentTagVersion !== entry.version ||
		! sameIntegrity( entry, registry )
	) {

		throw new Error(
			`registry verification failed for ${ entry.name }@${ entry.version } under ${ distTag }`
		);

	}

}

export function runReleasePublish( argv, {
	repoRoot = DEFAULT_REPO_ROOT,
	assertState = assertReleaseState,
	executeReleaseCheck = runReleaseCheck,
	execute = run,
	readRegistryState = readRegistryPackageState,
	verifyTarballs = verifyCheckedTarballs,
	verifyTarball = assertTarballBytesUnchanged,
	verifyAuthority = preflightNpmAuthority,
	verifyPublished = verifyPublishedRegistryState,
} = {} ) {

	const distTag = parseDistTag( argv );
	const initial = assertState( {
		repoRoot,
		requireTag: true,
		requireUpstream: true,
		requireRemoteTag: true,
	} );
	assertDistTagMatchesVersion( distTag, initial.version );

	// A direct call to release:publish must be just as safe as following the
	// documented preflight. The check creates one private tarball set and
	// returns the exact integrity descriptors used below.
	const releaseCheck = executeReleaseCheck( { repoRoot } );
	let tarballs = verifyTarballs( releaseCheck, initial, repoRoot );
	assertState( {
		repoRoot,
		requireTag: true,
		requireUpstream: true,
		requireRemoteTag: true,
		expectedHead: initial.head,
	} );

	// Run every tracked release generator once more before the first registry
	// write, then prove both the commit and already-verified tarballs are stable.
	execute(
		'pnpm',
		[ '--filter', '@tsl-precompile/runtime', 'build:slim' ],
		{ env: { TSLP_FAIL_ON_REWRITE_WARNING: '1' } },
		repoRoot
	);
	execute( process.execPath, [ 'packages/plugin/scripts/sync-agent-skill.mjs' ], {}, repoRoot );
	assertState( {
		repoRoot,
		requireTag: true,
		requireUpstream: true,
		requireRemoteTag: true,
		expectedHead: initial.head,
	} );
	tarballs = verifyTarballs( releaseCheck, initial, repoRoot );

	// Resolve all registry state before any write. This prevents a version/tag
	// typo from partially publishing the lockstep set and supports only an
	// integrity-identical resume of an already-started release.
	console.log( `[release-publish] pinned registry: ${ NPM_REGISTRY }` );
	const registryStates = tarballs.map( ( tarball ) => readRegistryState( {
		name: tarball.name,
		version: tarball.version,
		distTag,
		repoRoot,
	} ) );
	const plan = planRegistryPublication( tarballs, distTag, registryStates );
	verifyAuthority( {
		tarballs,
		registryStates,
		repoRoot,
	} );

	for ( const entry of plan ) {

		verifyTarball( entry );
		assertState( {
			repoRoot,
			requireTag: true,
			requireUpstream: true,
			requireRemoteTag: true,
			expectedHead: initial.head,
		} );
		const justBeforeWrite = readRegistryState( {
			name: entry.name,
			version: entry.version,
			distTag,
			repoRoot,
		} );
		if ( ! sameRegistryState( entry.registry, justBeforeWrite ) ) {

			throw new Error(
				`registry state changed after preflight for ${ entry.name }; rerun the complete publication guard`
			);

		}
		if ( entry.action === 'publish' ) {

			execute( 'npm', buildTarballPublishArgs( entry.path, distTag ), {}, repoRoot );

		} else if ( entry.action === 'tag' ) {

			execute( 'npm', buildDistTagArgs( entry.name, entry.version, distTag ), {}, repoRoot );

		} else {

			console.log(
				`[release-publish] ${ entry.name }@${ entry.version } already has identical bytes under ${ distTag }`
			);

		}
		verifyPublished( {
			entry,
			distTag,
			repoRoot,
			readRegistryState,
		} );

	}

	assertState( {
		repoRoot,
		requireTag: true,
		requireUpstream: true,
		requireRemoteTag: true,
		expectedHead: initial.head,
	} );
	console.log(
		`[release-publish] published ${ initial.version } from ${ initial.tag } under ${ distTag }; ` +
		`registry bytes verified at ${ NPM_REGISTRY }`
	);

}

if ( process.argv[ 1 ] && resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {

	try {

		runReleasePublish( process.argv.slice( 2 ) );

	} catch ( error ) {

		console.error( `[release-publish] FAILED: ${ error.message }` );
		process.exitCode = 1;

	}

}
