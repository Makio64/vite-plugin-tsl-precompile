#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertReleaseState, DEFAULT_REPO_ROOT } from './release-state.mjs';
import { collectReleaseTarballIntegrity } from './release-tarball-integrity.mjs';

export const RELEASE_GATES = Object.freeze( [
	{
		label: 'synchronize the published integration skill',
		command: process.execPath,
		args: [ 'packages/plugin/scripts/sync-agent-skill.mjs' ],
	},
	{
		label: 'verify the checked catalogue against the exact Three corpus',
		command: 'pnpm',
		args: [ '--filter', 'examples-batch', 'catalogue:check:corpus' ],
		passthroughEnvironment: [ 'TSLP_THREE_REPO' ],
	},
	{ label: 'lint authored JavaScript for correctness', command: 'pnpm', args: [ 'lint:correctness' ] },
	{ label: 'build public packages and site', command: 'pnpm', args: [ 'build' ] },
	{ label: 'run complete package suites', command: 'pnpm', args: [ 'test:full' ] },
	{ label: 'check strict public declarations', command: 'pnpm', args: [ 'test:types' ] },
	{ label: 'enforce slim production budgets', command: 'pnpm', args: [ 'test:slim:budget' ] },
	{ label: 'enforce module concentration budgets', command: 'pnpm', args: [ 'test:module:budget' ] },
	{ label: 'enforce the declared diagnostic-global registry', command: 'pnpm', args: [ 'test:diagnostic:globals' ] },
	{
		label: 'run the live tier-1 capture/replay visual gate',
		command: 'pnpm',
		args: [ 'test:e2e:tier1' ],
		passthroughEnvironment: [ 'TSLP_THREE_REPO' ],
		resultEnvironment: { TSLP_E2E_OUT: 'tier1-visual' },
	},
	{
		label: 'build and preview example applications',
		command: 'pnpm',
		args: [ 'test:examples:ci' ],
		resultEnvironment: {
			TSLP_PREVIEW_RESULTS: 'example-preview',
			TSLP_WOW_RESULTS: 'wow-showcase',
		},
	},
	{ label: 'verify committed artifacts and manifests', command: 'pnpm', args: [ 'verify' ] },
	{
		label: 'smoke Vite 8 packed consumer toolchain',
		command: 'pnpm',
		args: [ 'test:fresh-project:vite8' ],
		resultEnvironment: { TSLP_FRESH_RESULTS: 'fresh-current' },
	},
	{
		label: 'smoke Vite 7 packed consumer toolchain',
		command: 'pnpm',
		args: [ 'test:fresh-project:vite7' ],
		resultEnvironment: { TSLP_FRESH_RESULTS: 'fresh-vite7' },
	},
	{
		label: 'smoke minimum Vite 6 packed consumer toolchain',
		command: 'pnpm',
		args: [ 'test:fresh-project:vite6' ],
		resultEnvironment: { TSLP_FRESH_RESULTS: 'fresh-minimum' },
	},
	{
		label: 'create dry release tarballs',
		command: process.execPath,
		args: [ 'scripts/release-pack.mjs' ],
		resultEnvironment: { TSLP_RELEASE_TARBALL_DIR: 'release-tarballs' },
	},
	{
		label: 'record exact release tarball integrity',
		command: process.execPath,
		args: [ 'scripts/release-tarball-integrity.mjs' ],
		resultEnvironment: { TSLP_RELEASE_TARBALL_DIR: 'release-tarballs' },
	},
] );

function isForbiddenReleasePassthrough( key ) {

	return (
		key === 'NODE_OPTIONS' ||
		key.startsWith( 'NODE_TEST_' ) ||
		key.startsWith( 'GIT_' )
	);

}

export function releaseGateEnvironment( gate, resultsRoot, baseEnvironment = process.env ) {

	const environment = { ...baseEnvironment };
	// Release gates must not silently consume a caller's diagnostic bundle,
	// evidence input, result directory, Node test selector, or Git repository
	// override. New TSLP_*, NODE_TEST_*, and GIT_* selectors fail closed
	// automatically; a gate must explicitly allow the few TSLP_* inputs it
	// needs before its own isolated outputs are applied below.
	for ( const key of Object.keys( environment ) ) {

		if (
			isForbiddenReleasePassthrough( key ) ||
			key.startsWith( 'TSLP_' )
		) delete environment[ key ];

	}
	for ( const key of gate.passthroughEnvironment || [] ) {

		if ( isForbiddenReleasePassthrough( key ) ) {

			throw new Error( `release gates cannot pass through hostile environment key ${ key }` );

		}
		if ( baseEnvironment[ key ] !== undefined ) environment[ key ] = baseEnvironment[ key ];

	}
	const isolated = Object.fromEntries(
		Object.entries( gate.resultEnvironment || {} ).map( ( [ key, directory ] ) => [
			key,
			join( resultsRoot, directory ),
		] )
	);
	return { ...environment, ...isolated };

}

function runGate( gate, repoRoot, { resultsRoot } ) {

	console.log( `\n[release-check] ${ gate.label }` );
	const result = spawnSync( gate.command, gate.args, {
		cwd: repoRoot,
		env: releaseGateEnvironment( gate, resultsRoot ),
		stdio: 'inherit',
	} );
	if ( result.error ) throw result.error;
	if ( result.signal ) throw new Error( `${ gate.label } terminated by ${ result.signal }` );
	if ( result.status !== 0 ) throw new Error( `${ gate.label } exited ${ result.status }` );

}

export function runReleaseCheck( {
	repoRoot = DEFAULT_REPO_ROOT,
	gates = RELEASE_GATES,
	executeGate = runGate,
	resultsRoot = null,
} = {} ) {

	const initial = assertReleaseState( { repoRoot } );
	const isolatedResultsRoot = resultsRoot || mkdtempSync( join( tmpdir(), 'tslp-release-check-' ) );
	console.log( `[release-check] isolated smoke evidence: ${ isolatedResultsRoot }` );
	for ( const gate of gates ) {

		try {

			executeGate( gate, repoRoot, { resultsRoot: isolatedResultsRoot } );

		} catch ( gateError ) {

			try {

				assertReleaseState( { repoRoot, expectedHead: initial.head } );

			} catch ( stateError ) {

				throw new Error( `${ gateError.message }; release state also changed: ${ stateError.message }` );

			}
			throw gateError;

		}
		// Builds and prepack hooks intentionally regenerate tracked outputs.
		// Requiring the exact starting commit to remain clean after every gate
		// proves those generated bytes were committed before the release.
		assertReleaseState( { repoRoot, expectedHead: initial.head } );

	}
	const tarballDirectory = join( isolatedResultsRoot, 'release-tarballs' );
	const hasReleaseTarballGate = gates.some(
		( gate ) => gate.resultEnvironment?.TSLP_RELEASE_TARBALL_DIR
	);
	const tarballs = hasReleaseTarballGate
		? collectReleaseTarballIntegrity( { repoRoot, tarballDirectory } )
		: null;
	console.log( `\n[release-check] all gates passed for ${ initial.head }` );
	if ( tarballs ) console.log( `[release-check] verified release tarballs: ${ tarballDirectory }` );
	return {
		...initial,
		resultsRoot: isolatedResultsRoot,
		tarballDirectory: tarballs ? tarballDirectory : null,
		tarballs,
	};

}

if ( process.argv[ 1 ] && resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {

	const cliArgs = process.argv.slice( 2 );
	if ( cliArgs.length === 1 && cliArgs[ 0 ] === '--list' ) {

		console.log( JSON.stringify( RELEASE_GATES.map( ( gate ) => ( {
			label: gate.label,
			command: [ gate.command, ...gate.args ].join( ' ' ),
		} ) ), null, 2 ) );

	} else if ( cliArgs.length === 0 ) {

		try {

			runReleaseCheck( { repoRoot: resolve( DEFAULT_REPO_ROOT ) } );

		} catch ( error ) {

			console.error( `\n[release-check] FAILED: ${ error.message }` );
			process.exitCode = 1;

		}

	} else {

		console.error( `[release-check] unknown option(s): ${ cliArgs.join( ' ' ) }` );
		process.exitCode = 1;

	}
}
