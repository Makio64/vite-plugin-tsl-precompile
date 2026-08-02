#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { devNull } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseReleaseSemver } from './release-semver.mjs';

const SCRIPT_DIR = dirname( fileURLToPath( import.meta.url ) );
export const DEFAULT_REPO_ROOT = resolve( SCRIPT_DIR, '..' );

export const PUBLIC_PACKAGE_PATHS = Object.freeze( [
	'packages/contract/package.json',
	'packages/runtime/package.json',
	'packages/plugin/package.json',
] );

const EXPECTED_PACKAGE_NAMES = Object.freeze( [
	'@tsl-precompile/contract',
	'@tsl-precompile/runtime',
	'vite-plugin-tsl-precompile',
] );

const SAFE_GIT_ENVIRONMENT_KEYS = Object.freeze( [
	'PATH',
	'PATHEXT',
	'SystemRoot',
	'SYSTEMROOT',
	'WINDIR',
	'ComSpec',
	'TMPDIR',
	'TMP',
	'TEMP',
	'SSH_AUTH_SOCK',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'ALL_PROXY',
	'NO_PROXY',
	'http_proxy',
	'https_proxy',
	'all_proxy',
	'no_proxy',
] );

/**
 * Git accepts repository, index, object-store, replacement-ref, namespace,
 * config, and executable overrides through its environment. Release checks
 * must not inherit any of those inputs from the caller.
 */
export function trustedGitEnvironment( baseEnvironment = process.env ) {

	const environment = {};
	for ( const key of SAFE_GIT_ENVIRONMENT_KEYS ) {

		if ( baseEnvironment[ key ] !== undefined ) environment[ key ] = baseEnvironment[ key ];

	}
	return {
		...environment,
		LANG: 'C',
		LC_ALL: 'C',
		GIT_ATTR_NOSYSTEM: '1',
		GIT_CONFIG_COUNT: '0',
		GIT_CONFIG_GLOBAL: devNull,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_SYSTEM: devNull,
		GIT_NO_REPLACE_OBJECTS: '1',
		GIT_OPTIONAL_LOCKS: '0',
		GIT_TERMINAL_PROMPT: '0',
	};

}

function resolveTrustedGitRepository( repoRoot ) {

	const workTree = realpathSync( resolve( repoRoot ) );
	const dotGitPath = resolve( workTree, '.git' );
	const dotGitStat = lstatSync( dotGitPath );
	if ( dotGitStat.isSymbolicLink() ) {

		throw new Error( `${ dotGitPath } must not be a symbolic link` );

	}
	let gitDirectoryPath;
	if ( dotGitStat.isDirectory() ) {

		gitDirectoryPath = dotGitPath;

	} else if ( dotGitStat.isFile() ) {

		const pointer = readFileSync( dotGitPath, 'utf8' );
		const match = /^gitdir: ([^\0\r\n]+)\r?\n?$/.exec( pointer );
		if ( ! match ) throw new Error( `${ dotGitPath } is not a valid Git worktree pointer` );
		gitDirectoryPath = resolve( dirname( dotGitPath ), match[ 1 ] );

	} else {

		throw new Error( `${ dotGitPath } is not a Git directory or worktree pointer` );

	}
	const gitDirectory = realpathSync( gitDirectoryPath );
	if ( ! statSync( gitDirectory ).isDirectory() ) {

		throw new Error( `${ gitDirectory } is not a Git directory` );

	}
	return { gitDirectory, workTree };

}

export function execTrustedGitSync( repoRoot, args, options = {} ) {

	const { cwd: ignoredCwd, env: ignoredEnvironment, ...safeOptions } = options;
	void ignoredCwd;
	void ignoredEnvironment;
	const repository = resolveTrustedGitRepository( repoRoot );
	return execFileSync(
		'git',
		[
			`--git-dir=${ repository.gitDirectory }`,
			`--work-tree=${ repository.workTree }`,
			'-c',
			'core.fsmonitor=false',
			'-c',
			'core.untrackedCache=false',
			...args,
		],
		{
			...safeOptions,
			cwd: repository.workTree,
			env: trustedGitEnvironment(),
		},
	);

}

function git( repoRoot, args, { optional = false } = {} ) {

	try {

		return execTrustedGitSync( repoRoot, args, {
			encoding: 'utf8',
			stdio: [ 'ignore', 'pipe', optional ? 'ignore' : 'pipe' ],
		} ).trim();

	} catch ( error ) {

		if ( optional ) return null;
		const detail = String( error?.stderr || error?.message || error ).trim();
		throw new Error( `git ${ args.join( ' ' ) } failed${ detail ? `: ${ detail }` : '' }` );

	}

}

function readPackageVersion( repoRoot, relativePath ) {

	let manifest;
	try {

		manifest = JSON.parse( readFileSync( resolve( repoRoot, relativePath ), 'utf8' ) );

	} catch ( error ) {

		throw new Error( `cannot read ${ relativePath}: ${ error.message }` );

	}

	let parsedVersion;
	try {

		parsedVersion = parseReleaseSemver( manifest.version );

	} catch {

		throw new Error( `${ relativePath} has invalid SemVer version ${ JSON.stringify( manifest.version ) }` );

	}

	const expectedPublishTag = parsedVersion.prerelease
		? ( parsedVersion.prerelease[ 0 ] === 'alpha' ? 'alpha' : null )
		: 'latest';
	if ( ! expectedPublishTag ) {

		throw new Error(
			`${ relativePath } uses unsupported prerelease channel in ${ manifest.version }; ` +
			'release publishing supports only alpha or stable versions'
		);

	}
	if (
		manifest.publishConfig?.access !== 'public' ||
		manifest.publishConfig?.tag !== expectedPublishTag
	) {

		throw new Error(
			`${ relativePath } must set publishConfig.access="public" and ` +
			`publishConfig.tag="${ expectedPublishTag }" for ${ manifest.version }`
		);

	}

	return {
		name: manifest.name,
		path: relativePath,
		version: manifest.version,
		publishConfig: manifest.publishConfig,
	};

}

function summarizeDirtyStatus( status ) {

	const lines = status.split( '\n' ).filter( Boolean );
	const shown = lines.slice( 0, 20 );
	const suffix = lines.length > shown.length ? `\n... and ${ lines.length - shown.length } more path(s)` : '';
	return `${ shown.join( '\n' ) }${ suffix }`;

}

function assertVersionedChangelogEntry( repoRoot, version ) {

	let changelog;
	try {

		changelog = readFileSync( resolve( repoRoot, 'CHANGELOG.md' ), 'utf8' );

	} catch ( error ) {

		throw new Error( `cannot read CHANGELOG.md: ${ error.message }` );

	}
	const escapedVersion = version.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	const entry = new RegExp( `^## \\[${ escapedVersion }\\] - (\\d{4}-\\d{2}-\\d{2})$`, 'm' ).exec( changelog );
	if ( ! entry ) {

		throw new Error(
			`CHANGELOG.md must contain a finalized "## [${ version }] - YYYY-MM-DD" entry before release`
		);

	}
	const parsedDate = new Date( `${ entry[ 1 ] }T00:00:00Z` );
	if ( Number.isNaN( parsedDate.valueOf() ) || parsedDate.toISOString().slice( 0, 10 ) !== entry[ 1 ] ) {

		throw new Error( `CHANGELOG.md has an invalid release date for ${ version }: ${ entry[ 1 ] }` );

	}

}

export function inspectReleaseState( {
	repoRoot = DEFAULT_REPO_ROOT,
	requireTag = false,
	requireUpstream = false,
	requireRemoteTag = false,
	expectedHead = null,
} = {} ) {

	const topLevel = git( repoRoot, [ 'rev-parse', '--show-toplevel' ] );
	const canonicalRoot = realpathSync( resolve( repoRoot ) );
	if ( realpathSync( resolve( topLevel ) ) !== canonicalRoot ) {

		throw new Error( `release guard must run at repository root ${ topLevel }, received ${ canonicalRoot }` );

	}

	const branch = git( repoRoot, [ 'symbolic-ref', '--quiet', '--short', 'HEAD' ], { optional: true } );
	if ( branch !== 'main' ) {

		throw new Error( `release must run from branch main (current: ${ branch || 'detached HEAD' })` );

	}

	const head = git( repoRoot, [ 'rev-parse', 'HEAD' ] );
	if ( expectedHead && head !== expectedHead ) {

		throw new Error( `HEAD moved during the release gate: expected ${ expectedHead }, found ${ head }` );

	}

	if ( requireUpstream ) {

		const upstream = git( repoRoot, [ 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}' ], {
			optional: true,
		} );
		if ( ! upstream ) {

			throw new Error( 'release branch main must have a configured upstream before publication' );

		}
		const upstreamHead = git( repoRoot, [ 'rev-parse', '@{upstream}' ] );
		if ( upstreamHead !== head ) {

			throw new Error(
				`release commit is not synchronized with ${ upstream }: local ${ head }, upstream ${ upstreamHead }`
			);

		}
		const remote = git( repoRoot, [ 'config', '--get', `branch.${ branch }.remote` ], { optional: true } );
		const mergeRef = git( repoRoot, [ 'config', '--get', `branch.${ branch }.merge` ], { optional: true } );
		if ( ! remote || remote === '.' || ! mergeRef?.startsWith( 'refs/heads/' ) ) {

			throw new Error( `release branch ${ branch } must track a real remote branch before publication` );

		}
		const liveBranchRefs = git( repoRoot, [ 'ls-remote', '--exit-code', remote, mergeRef ] );
		const liveHead = liveBranchRefs
			.split( '\n' )
			.map( ( line ) => line.trim().split( /\s+/, 2 ) )
			.find( ( [ , ref ] ) => ref === mergeRef )?.[ 0 ];
		if ( liveHead !== head ) {

			throw new Error(
				`release commit is not synchronized with live ${ remote } ${ mergeRef }: local ${ head }, remote ${ liveHead || 'missing' }`
			);

		}

	}

	const status = git( repoRoot, [ 'status', '--porcelain=v1', '--untracked-files=all' ] );
	if ( status ) {

		throw new Error(
			`release worktree is not clean; commit every intended generated byte before continuing:\n${ summarizeDirtyStatus( status ) }`
		);

	}

	const packages = PUBLIC_PACKAGE_PATHS.map( ( path ) => readPackageVersion( repoRoot, path ) );
	for ( let index = 0; index < packages.length; index ++ ) {

		if ( packages[ index ].name !== EXPECTED_PACKAGE_NAMES[ index ] ) {

			throw new Error(
				`${ packages[ index ].path } must publish as ${ EXPECTED_PACKAGE_NAMES[ index ] }, ` +
				`found ${ JSON.stringify( packages[ index ].name ) }`
			);

		}

	}
	const versions = new Set( packages.map( ( pkg ) => pkg.version ) );
	if ( versions.size !== 1 ) {

		throw new Error(
			`public package versions must move in lockstep:\n${ packages.map( ( pkg ) => `${ pkg.path}: ${ pkg.version }` ).join( '\n' ) }`
		);

	}

	const version = packages[ 0 ].version;
	assertVersionedChangelogEntry( repoRoot, version );
	const tag = `v${ version }`;
	if ( requireTag ) {

		const tagType = git( repoRoot, [ 'cat-file', '-t', `refs/tags/${ tag }` ], { optional: true } );
		if ( tagType !== 'tag' ) {

			throw new Error( `release tag ${ tag } must exist as an annotated or signed tag before publication` );

		}

		const taggedCommit = git( repoRoot, [ 'rev-parse', `refs/tags/${ tag }^{commit}` ] );
		if ( taggedCommit !== head ) {

			throw new Error( `release tag ${ tag } points to ${ taggedCommit}, not current HEAD ${ head }` );

		}

	}
	if ( requireRemoteTag ) {

		if ( ! requireTag ) throw new Error( 'remote release-tag verification requires requireTag' );
		const remote = git( repoRoot, [ 'config', '--get', `branch.${ branch }.remote` ], { optional: true } );
		if ( ! remote || remote === '.' ) {

			throw new Error( `release branch ${ branch } must track a real remote before publication` );

		}
		const remoteRefs = git(
			repoRoot,
			[ 'ls-remote', remote, `refs/tags/${ tag }`, `refs/tags/${ tag }^{}` ],
			{ optional: true }
		);
		const peeledRef = `refs/tags/${ tag }^{}`;
		const peeledCommit = String( remoteRefs || '' )
			.split( '\n' )
			.map( ( line ) => line.trim().split( /\s+/, 2 ) )
			.find( ( [ , ref ] ) => ref === peeledRef )?.[ 0 ];
		if ( peeledCommit !== head ) {

			throw new Error(
				`remote ${ remote } must contain annotated/signed tag ${ tag } peeled to ${ head} before publication`
			);

		}

	}

	return {
		branch,
		head,
		packages,
		tag,
		version,
	};

}

export function assertReleaseState( options = {} ) {

	const state = inspectReleaseState( options );
	console.log(
		`[release-state] clean ${ state.branch }@${ state.head.slice( 0, 12 ) }; ` +
		`${ state.packages.length } public packages at ${ state.version }` +
		`${ options.requireTag ? `; ${ state.tag } verified` : '' }`
	);
	return state;

}

function parseCliArgs( argv ) {

	const options = {};
	for ( const arg of argv ) {

		if ( arg === '--require-tag' ) {

			options.requireTag = true;

		} else if ( arg === '--require-upstream' ) {

			options.requireUpstream = true;

		} else if ( arg === '--require-remote-tag' ) {

			options.requireRemoteTag = true;

		} else if ( arg.startsWith( '--expected-head=' ) ) {

			options.expectedHead = arg.slice( '--expected-head='.length );
			if ( ! /^[0-9a-f]{40}$/i.test( options.expectedHead ) ) {

				throw new Error( '--expected-head must be a full 40-character commit SHA' );

			}

		} else if ( arg === '--help' ) {

			console.log(
				'Usage: node scripts/release-state.mjs [--require-tag] [--require-upstream] ' +
				'[--require-remote-tag] [--expected-head=<sha>]'
			);
			process.exit( 0 );

		} else {

			throw new Error( `unknown release-state option: ${ arg }` );

		}

	}
	return options;

}

if ( process.argv[ 1 ] && resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {

	try {

		assertReleaseState( parseCliArgs( process.argv.slice( 2 ) ) );

	} catch ( error ) {

		console.error( `[release-state] ${ error.message }` );
		process.exitCode = 1;

	}

}
