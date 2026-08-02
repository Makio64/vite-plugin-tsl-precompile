import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { ESLint } from 'eslint';

import {
	CORRECTNESS_LINT_FILES,
	CORRECTNESS_LINT_IGNORES,
} from '../eslint.config.js';
import {
	assertReleaseState,
	execTrustedGitSync,
	inspectReleaseState,
	PUBLIC_PACKAGE_PATHS,
	trustedGitEnvironment,
} from './release-state.mjs';
import {
	RELEASE_GATES,
	releaseGateEnvironment,
	runReleaseCheck,
} from './release-check.mjs';
import {
	assertDistTagMatchesVersion,
	buildDistTagArgs,
	buildTarballPublishArgs,
	compareSemver,
	NPM_REGISTRY,
	NPM_SCOPE_REGISTRY_OPTION,
	parseDistTag,
	planRegistryPublication,
	preflightNpmAuthority,
	runReleasePublish,
	verifyPublishedRegistryState,
} from './release-publish.mjs';
import {
	assertReleaseTarballArchive,
	collectReleaseTarballIntegrity,
	computeTarballIntegrity,
	parseTarballDirectory,
	PUBLIC_PACKAGES as RELEASE_PUBLIC_PACKAGES,
	tarballName,
} from './release-tarball-integrity.mjs';
import {
	parsePackArgs,
	prepareReleaseTarballDirectory,
} from './release-pack.mjs';

const TEST_REPO_ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );

function git( root, ...args ) {

	return execFileSync( 'git', args, { cwd: root, encoding: 'utf8' } ).trim();

}

function makeRepo( { branch = 'main', version = '0.1.0-alpha.0' } = {} ) {

	const root = mkdtempSync( join( tmpdir(), 'tslp-release-state-' ) );
	git( root, 'init', '-b', branch );
	git( root, 'config', 'user.name', 'Release Guard Test' );
	git( root, 'config', 'user.email', 'release-guard@example.invalid' );
	for ( const path of PUBLIC_PACKAGE_PATHS ) {

		const directory = join( root, path, '..' );
		mkdirSync( directory, { recursive: true } );
		const names = {
			'packages/contract/package.json': '@tsl-precompile/contract',
			'packages/runtime/package.json': '@tsl-precompile/runtime',
			'packages/plugin/package.json': 'vite-plugin-tsl-precompile',
		};
		writeFileSync( join( root, path ), `${ JSON.stringify( {
			name: names[ path ],
			version,
			publishConfig: {
				access: 'public',
				tag: version.includes( '-' ) ? 'alpha' : 'latest',
			},
		}, null, 2 ) }\n` );

	}
	writeFileSync( join( root, 'README.md' ), '# fixture\n' );
	writeFileSync(
		join( root, 'CHANGELOG.md' ),
		`# Changelog\n\n## [Unreleased]\n\n## [${ version }] - 2026-07-30\n`,
	);
	git( root, 'add', '.' );
	git( root, 'commit', '-m', 'fixture' );
	return root;

}

function withRepo( options, fn ) {

	const root = makeRepo( options );
	try {

		fn( root );

	} finally {

		rmSync( root, { recursive: true, force: true } );

	}

}

function withProcessEnvironment( overrides, fn ) {

	const previous = new Map(
		Object.keys( overrides ).map( ( key ) => [ key, process.env[ key ] ] ),
	);
	for ( const [ key, value ] of Object.entries( overrides ) ) {

		if ( value === undefined ) delete process.env[ key ];
		else process.env[ key ] = value;

	}
	try {

		return fn();

	} finally {

		for ( const [ key, value ] of previous ) {

			if ( value === undefined ) delete process.env[ key ];
			else process.env[ key ] = value;

		}

	}

}

function tarField( header, offset, length, value ) {

	const bytes = Buffer.from( value );
	assert.equal( bytes.length <= length, true, `tar field exceeds ${ length } bytes: ${ value }` );
	bytes.copy( header, offset );

}

function tarOctalField( header, offset, length, value ) {

	tarField( header, offset, length, `${ value.toString( 8 ).padStart( length - 1, '0' ) }\0` );

}

function releaseTarGzip( entries ) {

	const blocks = [];
	for ( const entry of entries ) {

		const bytes = Buffer.isBuffer( entry.bytes ) ? entry.bytes : Buffer.from( entry.bytes || '' );
		const header = Buffer.alloc( 512 );
		tarField( header, 0, 100, entry.path );
		tarOctalField( header, 100, 8, entry.mode ?? 0o644 );
		tarOctalField( header, 108, 8, 0 );
		tarOctalField( header, 116, 8, 0 );
		tarOctalField( header, 124, 12, bytes.length );
		tarOctalField( header, 136, 12, 499162500 );
		header.fill( 0x20, 148, 156 );
		header[ 156 ] = String( entry.type || '0' ).charCodeAt( 0 );
		tarField( header, 257, 6, 'ustar\0' );
		tarField( header, 263, 2, '00' );
		tarOctalField( header, 329, 8, 0 );
		tarOctalField( header, 337, 8, 0 );
		const checksum = header.reduce( ( total, byte ) => total + byte, 0 );
		tarField( header, 148, 8, `${ checksum.toString( 8 ).padStart( 6, '0' ) }\0 ` );
		const body = Buffer.alloc( Math.ceil( bytes.length / 512 ) * 512 );
		bytes.copy( body );
		if ( entry.paddingByte !== undefined ) {

			body.fill( entry.paddingByte, bytes.length );

		}
		blocks.push( header, body );

	}
	blocks.push( Buffer.alloc( 1024 ) );
	return gzipSync( Buffer.concat( blocks ) );

}

function releasePackageConfig( name ) {

	const config = RELEASE_PUBLIC_PACKAGES.find( ( entry ) => entry.name === name );
	assert.ok( config, `missing release package configuration for ${ name }` );
	return config;

}

function sourcePackageManifest( root, config ) {

	return JSON.parse( readFileSync( join( root, config.directory, 'package.json' ), 'utf8' ) );

}

test( 'accepts a clean main checkout with lockstep package versions', () => {

	withRepo( {}, ( root ) => {

		const state = inspectReleaseState( { repoRoot: root } );
		assert.equal( state.branch, 'main' );
		assert.equal( state.version, '0.1.0-alpha.0' );
		assert.equal( state.packages.length, 3 );

	} );

} );

test( 'requires a safe version-aware publishConfig channel', () => {

	withRepo( {}, ( root ) => {

		const path = join( root, PUBLIC_PACKAGE_PATHS[ 1 ] );
		const manifest = JSON.parse( readFileSync( path, 'utf8' ) );
		manifest.publishConfig.tag = 'latest';
		writeFileSync( path, `${ JSON.stringify( manifest, null, 2 ) }\n` );
		git( root, 'add', '.' );
		git( root, 'commit', '-m', 'unsafe prerelease publish tag' );
		assert.throws(
			() => inspectReleaseState( { repoRoot: root } ),
			/publishConfig\.tag="alpha"/
		);

	} );

} );

test( 'accepts stable latest releases and rejects noncanonical SemVer', () => {

	withRepo( { version: '0.1.0' }, ( root ) => {

		const state = inspectReleaseState( { repoRoot: root } );
		assert.equal( state.version, '0.1.0' );
		assert.equal( state.packages[ 0 ].publishConfig.tag, 'latest' );

	} );
	withRepo( { version: '0.1.0-alpha.01' }, ( root ) => {

		assert.throws(
			() => inspectReleaseState( { repoRoot: root } ),
			/invalid SemVer version/
		);

	} );

} );

test( 'requires a finalized changelog entry for the package version', () => {

	withRepo( {}, ( root ) => {

		writeFileSync( join( root, 'CHANGELOG.md' ), '# Changelog\n\n## [Unreleased]\n' );
		git( root, 'add', 'CHANGELOG.md' );
		git( root, 'commit', '-m', 'remove finalized entry' );
		assert.throws(
			() => inspectReleaseState( { repoRoot: root } ),
			/finalized .*0\.1\.0-alpha\.0.*YYYY-MM-DD/
		);

	} );

} );

test( 'rejects tracked and untracked worktree changes', () => {

	withRepo( {}, ( root ) => {

		writeFileSync( join( root, 'README.md' ), '# changed\n' );
		assert.throws(
			() => inspectReleaseState( { repoRoot: root } ),
			/release worktree is not clean[\s\S]*README\.md/
		);

		writeFileSync( join( root, 'README.md' ), '# fixture\n' );
		writeFileSync( join( root, 'untracked.txt' ), 'untracked\n' );
		assert.throws(
			() => inspectReleaseState( { repoRoot: root } ),
			/release worktree is not clean[\s\S]*untracked\.txt/
		);

	} );

} );

test( 'release state binds Git to the requested checkout despite a clean shadow repository environment', () => {

	const root = makeRepo();
	const shadow = makeRepo();
	try {

		writeFileSync( join( root, 'README.md' ), '# shadow-matched dirty bytes\n' );
		writeFileSync( join( shadow, 'README.md' ), '# shadow-matched dirty bytes\n' );
		git( shadow, 'add', 'README.md' );
		git( shadow, 'commit', '-m', 'make the shadow index match dirty target bytes' );
		const hostileEnvironment = {
			GIT_DIR: join( shadow, '.git' ),
			GIT_WORK_TREE: root,
		};
		const shadowStatus = execFileSync(
			'git',
			[ 'status', '--porcelain=v1', '--untracked-files=all' ],
			{
				cwd: root,
				encoding: 'utf8',
				env: { ...process.env, ...hostileEnvironment },
			},
		).trim();
		assert.equal( shadowStatus, '', 'fixture must prove the inherited shadow repository looks clean' );

		withProcessEnvironment( hostileEnvironment, () => {

			assert.throws(
				() => inspectReleaseState( { repoRoot: root } ),
				/release worktree is not clean[\s\S]*README\.md/,
			);

		} );

	} finally {

		rmSync( root, { recursive: true, force: true } );
		rmSync( shadow, { recursive: true, force: true } );

	}

} );

test( 'trusted Git children receive only explicit operational environment and fixed security overrides', () => {

	const attackEnvironment = {
		PATH: '/trusted/bin',
		SSH_AUTH_SOCK: '/trusted/agent.sock',
		HOME: '/hostile/home',
		GIT_DIR: '/hostile/repository',
		GIT_WORK_TREE: '/hostile/worktree',
		GIT_COMMON_DIR: '/hostile/common',
		GIT_INDEX_FILE: '/hostile/index',
		GIT_OBJECT_DIRECTORY: '/hostile/objects',
		GIT_ALTERNATE_OBJECT_DIRECTORIES: '/hostile/alternates',
		GIT_CONFIG_GLOBAL: '/hostile/config',
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: 'core.fsmonitor',
		GIT_CONFIG_VALUE_0: '/hostile/hook',
		GIT_REPLACE_REF_BASE: 'refs/hostile-replacements/',
		GIT_NAMESPACE: 'hostile',
	};
	const environment = trustedGitEnvironment( attackEnvironment );
	assert.equal( environment.PATH, '/trusted/bin' );
	assert.equal( environment.SSH_AUTH_SOCK, '/trusted/agent.sock' );
	assert.equal( Object.hasOwn( environment, 'HOME' ), false );
	for ( const key of [
		'GIT_DIR',
		'GIT_WORK_TREE',
		'GIT_COMMON_DIR',
		'GIT_INDEX_FILE',
		'GIT_OBJECT_DIRECTORY',
		'GIT_ALTERNATE_OBJECT_DIRECTORIES',
		'GIT_CONFIG_KEY_0',
		'GIT_CONFIG_VALUE_0',
		'GIT_REPLACE_REF_BASE',
		'GIT_NAMESPACE',
	] ) {

		assert.equal( Object.hasOwn( environment, key ), false, `${ key } reached trusted Git` );

	}
	assert.equal( environment.GIT_CONFIG_COUNT, '0' );
	assert.equal( environment.GIT_NO_REPLACE_OBJECTS, '1' );
	assert.equal( environment.GIT_TERMINAL_PROMPT, '0' );

} );

test( 'trusted Git rejects a symlinked repository entry and disables local status caches', () => {

	withRepo( {}, ( root ) => {

		git( root, 'config', 'core.fsmonitor', '/hostile/fsmonitor-hook' );
		git( root, 'config', 'core.untrackedCache', 'true' );
		assert.equal(
			execTrustedGitSync( root, [ 'config', '--get', 'core.fsmonitor' ], {
				encoding: 'utf8',
			} ).trim(),
			'false',
		);
		assert.equal(
			execTrustedGitSync( root, [ 'config', '--get', 'core.untrackedCache' ], {
				encoding: 'utf8',
			} ).trim(),
			'false',
		);

		const gitDirectory = join( root, '.git' );
		const movedGitDirectory = join( root, '.git-real' );
		renameSync( gitDirectory, movedGitDirectory );
		symlinkSync( '.git-real', gitDirectory, 'dir' );
		assert.throws(
			() => inspectReleaseState( { repoRoot: root } ),
			/\.git must not be a symbolic link/,
		);

	} );

} );

test( 'rejects the wrong branch and package version drift', () => {

	withRepo( { branch: 'release' }, ( root ) => {

		assert.throws(
			() => inspectReleaseState( { repoRoot: root } ),
			/release must run from branch main/
		);

	} );

	withRepo( {}, ( root ) => {

		const path = join( root, PUBLIC_PACKAGE_PATHS[ 0 ] );
		const manifest = JSON.parse( readFileSync( path, 'utf8' ) );
		manifest.version = '0.1.0-alpha.1';
		writeFileSync( path, `${ JSON.stringify( manifest, null, 2 ) }\n` );
		git( root, 'add', '.' );
		git( root, 'commit', '-m', 'drift one version' );
		assert.throws(
			() => inspectReleaseState( { repoRoot: root } ),
			/public package versions must move in lockstep/
		);

	} );

	withRepo( {}, ( root ) => {

		const path = join( root, PUBLIC_PACKAGE_PATHS[ 2 ] );
		const manifest = JSON.parse( readFileSync( path, 'utf8' ) );
		manifest.name = 'lookalike-plugin';
		writeFileSync( path, `${ JSON.stringify( manifest, null, 2 ) }\n` );
		git( root, 'add', '.' );
		git( root, 'commit', '-m', 'rename package' );
		assert.throws(
			() => inspectReleaseState( { repoRoot: root } ),
			/must publish as vite-plugin-tsl-precompile/
		);

	} );

} );

test( 'requires an annotated exact-commit release tag for publication', () => {

	withRepo( {}, ( root ) => {

		assert.throws(
			() => inspectReleaseState( { repoRoot: root, requireTag: true } ),
			/must exist as an annotated or signed tag/
		);

		git( root, 'tag', 'v0.1.0-alpha.0' );
		assert.throws(
			() => inspectReleaseState( { repoRoot: root, requireTag: true } ),
			/must exist as an annotated or signed tag/
		);

		git( root, 'tag', '-d', 'v0.1.0-alpha.0' );
		git( root, 'tag', '-a', 'v0.1.0-alpha.0', '-m', 'release' );
		assert.doesNotThrow(
			() => assertReleaseState( { repoRoot: root, requireTag: true } )
		);

	} );

} );

test( 'requires publication to use the exact configured upstream commit', () => {

	const remote = mkdtempSync( join( tmpdir(), 'tslp-release-remote-' ) );
	const root = makeRepo();
	try {

		git( remote, 'init', '--bare' );
		git( root, 'remote', 'add', 'origin', remote );
		git( root, 'push', '--set-upstream', 'origin', 'main' );
		assert.doesNotThrow(
			() => inspectReleaseState( { repoRoot: root, requireUpstream: true } )
		);

		writeFileSync( join( root, 'README.md' ), '# second commit\n' );
		git( root, 'add', '.' );
		git( root, 'commit', '-m', 'unpushed release candidate' );
		assert.throws(
			() => inspectReleaseState( { repoRoot: root, requireUpstream: true } ),
			/release commit is not synchronized with origin\/main/
		);

	} finally {

		rmSync( root, { recursive: true, force: true } );
		rmSync( remote, { recursive: true, force: true } );

	}

} );

test( 'rejects a stale tracking ref when the live remote branch advanced', () => {

	const remote = mkdtempSync( join( tmpdir(), 'tslp-release-live-remote-' ) );
	const root = makeRepo();
	const other = mkdtempSync( join( tmpdir(), 'tslp-release-other-' ) );
	try {

		git( remote, 'init', '--bare' );
		git( root, 'remote', 'add', 'origin', remote );
		git( root, 'push', '--set-upstream', 'origin', 'main' );
		execFileSync( 'git', [ 'clone', '--branch', 'main', remote, other ], { stdio: 'ignore' } );
		git( other, 'config', 'user.name', 'Other Release Actor' );
		git( other, 'config', 'user.email', 'other-release@example.invalid' );
		writeFileSync( join( other, 'README.md' ), '# advanced remotely\n' );
		git( other, 'add', '.' );
		git( other, 'commit', '-m', 'advance live remote' );
		git( other, 'push', 'origin', 'main' );

		assert.equal( git( root, 'rev-parse', 'origin/main' ), git( root, 'rev-parse', 'HEAD' ) );
		assert.throws(
			() => inspectReleaseState( { repoRoot: root, requireUpstream: true } ),
			/release commit is not synchronized with live origin refs\/heads\/main/
		);

	} finally {

		rmSync( root, { recursive: true, force: true } );
		rmSync( other, { recursive: true, force: true } );
		rmSync( remote, { recursive: true, force: true } );

	}

} );

test( 'requires the exact annotated release tag to exist on the configured remote', () => {

	const remote = mkdtempSync( join( tmpdir(), 'tslp-release-tag-remote-' ) );
	const root = makeRepo();
	try {

		git( remote, 'init', '--bare' );
		git( root, 'remote', 'add', 'origin', remote );
		git( root, 'push', '--set-upstream', 'origin', 'main' );
		git( root, 'tag', '-a', 'v0.1.0-alpha.0', '-m', 'release' );
		assert.throws(
			() => inspectReleaseState( {
				repoRoot: root,
				requireTag: true,
				requireUpstream: true,
				requireRemoteTag: true,
			} ),
			/remote origin must contain annotated\/signed tag/
		);

		git( root, 'push', 'origin', 'v0.1.0-alpha.0' );
		assert.doesNotThrow(
			() => inspectReleaseState( {
				repoRoot: root,
				requireTag: true,
				requireUpstream: true,
				requireRemoteTag: true,
			} )
		);

	} finally {

		rmSync( root, { recursive: true, force: true } );
		rmSync( remote, { recursive: true, force: true } );

	}

} );

test( 'pins a multi-step release check to its starting commit', () => {

	withRepo( {}, ( root ) => {

		assert.throws(
			() => inspectReleaseState( { repoRoot: root, expectedHead: '0'.repeat( 40 ) } ),
			/HEAD moved during the release gate/
		);

	} );

	const commands = RELEASE_GATES.map( ( gate ) => [ gate.command, ...gate.args ].join( ' ' ) );
	assert.ok( commands.some( ( command ) => command.includes( 'sync-agent-skill.mjs' ) ) );
	assert.ok( commands.some( ( command ) => command.endsWith( 'pnpm lint:correctness' ) ) );
	assert.ok( commands.some( ( command ) => command.includes( 'test:fresh-project:vite8' ) ) );
	assert.ok( commands.some( ( command ) => command.includes( 'test:fresh-project:vite7' ) ) );
	assert.ok( commands.some( ( command ) => command.includes( 'test:fresh-project:vite6' ) ) );
	assert.ok( commands.some( ( command ) => command.includes( 'release-pack.mjs' ) ) );
	assert.ok( commands.some( ( command ) => command.includes( 'release-tarball-integrity.mjs' ) ) );

} );

test( 'correctness lint has an exact command, authored scope, and generated exclusions', async () => {

	const manifest = JSON.parse( readFileSync( join( TEST_REPO_ROOT, 'package.json' ), 'utf8' ) );
	assert.equal( manifest.scripts.lint, 'pnpm lint:correctness' );
	assert.equal(
		manifest.scripts[ 'lint:correctness' ],
		'eslint --max-warnings=0 packages/contract/src packages/plugin/src packages/runtime/src packages/examples/batch packages/site/src packages/site/scripts scripts',
	);
	assert.equal( manifest.devDependencies.eslint, '9.39.4' );
	assert.deepEqual( CORRECTNESS_LINT_FILES, [
		'packages/contract/src/**/*.js',
		'packages/plugin/src/**/*.js',
		'packages/runtime/src/**/*.js',
		'packages/examples/batch/**/*.{js,mjs}',
		'packages/site/src/**/*.js',
		'packages/site/scripts/**/*.{js,mjs}',
		'scripts/**/*.{js,mjs}',
	] );
	assert.deepEqual( CORRECTNESS_LINT_IGNORES, [
		'**/node_modules/**',
		'**/dist/**',
		'**/build/**',
		'**/artifacts/**',
		'**/results/**',
		'packages/site/public/**',
		'packages/plugin/src/vendor/**',
		'.claude/worktrees/**',
		'**/.claude/worktrees/**',
		'.worktrees/**',
		'**/.worktrees/**',
	] );

	const eslint = new ESLint( { cwd: TEST_REPO_ROOT } );
	for ( const relativePath of [
		'packages/contract/src/index.js',
		'packages/plugin/src/index.js',
		'packages/runtime/src/index.js',
		'packages/examples/batch/run-e2e.mjs',
		'packages/examples/batch/test/e2e-evidence.test.mjs',
		'packages/site/src/main.js',
		'packages/site/scripts/check-content.mjs',
		'scripts/release-check.mjs',
	] ) {

		assert.equal(
			await eslint.isPathIgnored( join( TEST_REPO_ROOT, relativePath ) ),
			false,
			`${ relativePath } must be linted`,
		);

	}
	for ( const relativePath of [
		'node_modules/example/index.js',
		'packages/example/dist/generated.js',
		'packages/runtime/build/generated.js',
		'packages/example/artifacts/generated.js',
		'packages/examples/batch/results/generated.mjs',
		'packages/site/public/generated.js',
		'packages/plugin/src/vendor/compileTSL.js',
		'.claude/worktrees/fixture/packages/runtime/src/index.js',
		'.worktrees/fixture/packages/runtime/src/index.js',
	] ) {

		assert.equal(
			await eslint.isPathIgnored( join( TEST_REPO_ROOT, relativePath ) ),
			true,
			`${ relativePath } must stay outside the authored-source gate`,
		);

	}
	const config = await eslint.calculateConfigForFile(
		join( TEST_REPO_ROOT, 'packages/runtime/src/index.js' ),
	);
	assert.equal( config.rules[ 'no-undef' ][ 0 ], 2 );
	assert.equal( config.rules[ 'no-duplicate-imports' ][ 0 ], 2 );
	assert.equal( config.rules[ 'no-constant-binary-expression' ][ 0 ], 2 );

} );

test( 'declared Vite 6, 7, and 8 support has exact packed-consumer lanes', () => {

	const rootPackage = JSON.parse( readFileSync( join( TEST_REPO_ROOT, 'package.json' ), 'utf8' ) );
	assert.equal(
		rootPackage.scripts[ 'test:fresh-project:vite6' ],
		'pnpm test:fresh-project -- --vite-version=6.4.3 --typescript-version=5.6.3',
	);
	assert.equal(
		rootPackage.scripts[ 'test:fresh-project:vite7' ],
		'pnpm test:fresh-project -- --vite-version=7.3.6 --typescript-version=5.9.3',
	);
	assert.equal(
		rootPackage.scripts[ 'test:fresh-project:vite8' ],
		'pnpm test:fresh-project -- --vite-version=8.0.16 --typescript-version=5.9.3',
	);
	assert.equal( rootPackage.scripts[ 'test:fresh-project:minimum' ], 'pnpm test:fresh-project:vite6' );

	const ci = readFileSync( join( TEST_REPO_ROOT, '.github/workflows/ci.yml' ), 'utf8' );
	for ( const version of [ '6.4.3', '7.3.6', '8.0.16' ] ) {

		assert.match( ci, new RegExp( `vite:\\s+${ version.replaceAll( '.', '\\.' ) }` ) );

	}
	assert.match( ci, /Node 22\.12 \/ Vite 7\.3\.6/ );

} );

test( 'release orchestration rejects a tracked byte regenerated by a gate', () => {

	withRepo( {}, ( root ) => {

		assert.throws(
			() => runReleaseCheck( {
				repoRoot: root,
				resultsRoot: join( root, '.isolated-results' ),
				gates: [ { label: 'fixture generator' } ],
				executeGate: () => writeFileSync( join( root, 'README.md' ), '# regenerated\n' ),
			} ),
			/release worktree is not clean[\s\S]*README\.md/
		);

	} );

} );

test( 'release Node gates ignore hostile --test-only injection and execute nested test cases', () => {

	const childRoot = mkdtempSync( join( tmpdir(), 'tslp-release-node-gate-' ) );
	try {

		const childTest = join( childRoot, 'sentinel.test.mjs' );
		const marker = join( childRoot, 'nested-test-ran.txt' );
		writeFileSync(
			childTest,
			[
				"import { writeFileSync } from 'node:fs';",
				"import test from 'node:test';",
				`test( 'release sentinel', () => writeFileSync( ${ JSON.stringify( marker ) }, 'ran\\n' ) );`,
				'',
			].join( '\n' ),
		);
		withRepo( {}, ( root ) => {

			withProcessEnvironment( { NODE_OPTIONS: '--test-only' }, () => {

				runReleaseCheck( {
					repoRoot: root,
					resultsRoot: join( childRoot, 'results' ),
					gates: [ {
						label: 'nested Node test sentinel',
						command: process.execPath,
						args: [ '--test', childTest ],
					} ],
				} );

			} );

		} );
		assert.equal( existsSync( marker ), true, 'nested node:test callback must execute' );
		assert.equal( readFileSync( marker, 'utf8' ), 'ran\n' );

	} finally {

		rmSync( childRoot, { recursive: true, force: true } );

	}

} );

test( 'release gates route browser evidence and tarballs through one isolated results root', () => {

	const resultsRoot = '/isolated/release-evidence';
	const byCommand = new Map( RELEASE_GATES.map( ( gate ) => [ gate.args.join( ' ' ), gate ] ) );
	const examplesEnvironment = releaseGateEnvironment(
		byCommand.get( 'test:examples:ci' ),
		resultsRoot,
		{ SENTINEL: 'preserved' },
	);
	assert.equal( examplesEnvironment.SENTINEL, 'preserved' );
	assert.equal( examplesEnvironment.TSLP_PREVIEW_RESULTS, `${ resultsRoot }/example-preview` );
	assert.equal( examplesEnvironment.TSLP_WOW_RESULTS, `${ resultsRoot }/wow-showcase` );

	const currentEnvironment = releaseGateEnvironment(
		byCommand.get( 'test:fresh-project:vite8' ),
		resultsRoot,
		{},
	);
	const vite7Environment = releaseGateEnvironment(
		byCommand.get( 'test:fresh-project:vite7' ),
		resultsRoot,
		{},
	);
	const minimumEnvironment = releaseGateEnvironment(
		byCommand.get( 'test:fresh-project:vite6' ),
		resultsRoot,
		{},
	);
	assert.equal( currentEnvironment.TSLP_FRESH_RESULTS, `${ resultsRoot }/fresh-current` );
	assert.equal( vite7Environment.TSLP_FRESH_RESULTS, `${ resultsRoot }/fresh-vite7` );
	assert.equal( minimumEnvironment.TSLP_FRESH_RESULTS, `${ resultsRoot }/fresh-minimum` );
	const visualEnvironment = releaseGateEnvironment(
		byCommand.get( 'test:e2e:tier1' ),
		resultsRoot,
		{},
	);
	assert.equal( visualEnvironment.TSLP_E2E_OUT, `${ resultsRoot }/tier1-visual` );
	const packEnvironment = releaseGateEnvironment(
		byCommand.get( 'scripts/release-pack.mjs' ),
		resultsRoot,
		{},
	);
	const integrityEnvironment = releaseGateEnvironment(
		byCommand.get( 'scripts/release-tarball-integrity.mjs' ),
		resultsRoot,
		{},
	);
	assert.equal( packEnvironment.TSLP_RELEASE_TARBALL_DIR, `${ resultsRoot }/release-tarballs` );
	assert.equal( integrityEnvironment.TSLP_RELEASE_TARBALL_DIR, `${ resultsRoot }/release-tarballs` );
	assert.equal(
		packEnvironment.TSLP_RELEASE_TARBALL_DIR,
		integrityEnvironment.TSLP_RELEASE_TARBALL_DIR
	);

} );

test( 'release gates scrub hostile TSLP selectors and only pass through the exact Three checkout', () => {

	const resultsRoot = '/isolated/release-evidence';
	const byCommand = new Map( RELEASE_GATES.map( ( gate ) => [ gate.args.join( ' ' ), gate ] ) );
	const hostileEnvironment = {
		PATH: '/usr/bin',
		NODE_OPTIONS: '--test-only',
		NODE_TEST_CONTEXT: 'hostile-test-context',
		GIT_DIR: '/hostile/repository',
		GIT_WORK_TREE: '/hostile/worktree',
		TSLP_E2E_OUT: '/hostile/evidence',
		TSLP_E2E_INPUT: '/hostile/evidence-input',
		TSLP_E2E_SLIM_BUNDLE: '/hostile/slim.js',
		TSLP_SLIM_BUNDLE: '/hostile/other-slim.js',
		TSLP_STOCK_OUT: '/hostile/stock-output',
		TSLP_STOCK_REPORT: '/hostile/stock-report.json',
		TSLP_SITE_PUBLIC_OUT: '/hostile/site-public',
		TSLP_PREVIEW_RESULTS: '/hostile/preview',
		TSLP_WOW_RESULTS: '/hostile/showcase',
		TSLP_FRESH_RESULTS: '/hostile/fresh',
		TSLP_RELEASE_TARBALL_DIR: '/hostile/tarballs',
		TSLP_TEST_CHECKED_SLIM_DIR: '/hostile/test-slim',
		TSLP_THREE_REPO: '/trusted/exact-three',
	};

	const buildEnvironment = releaseGateEnvironment(
		byCommand.get( 'build' ),
		resultsRoot,
		hostileEnvironment,
	);
	assert.equal( buildEnvironment.PATH, '/usr/bin' );
	assert.equal( Object.hasOwn( buildEnvironment, 'NODE_OPTIONS' ), false );
	assert.equal( Object.hasOwn( buildEnvironment, 'NODE_TEST_CONTEXT' ), false );
	assert.equal( Object.hasOwn( buildEnvironment, 'GIT_DIR' ), false );
	assert.equal( Object.hasOwn( buildEnvironment, 'GIT_WORK_TREE' ), false );
	assert.throws(
		() => releaseGateEnvironment(
			{ passthroughEnvironment: [ 'NODE_OPTIONS' ] },
			resultsRoot,
			hostileEnvironment,
		),
		/cannot pass through hostile environment key NODE_OPTIONS/,
	);
	for ( const key of Object.keys( hostileEnvironment ).filter( ( key ) => key.startsWith( 'TSLP_' ) ) ) {

		assert.equal(
			Object.hasOwn( buildEnvironment, key ),
			false,
			`site/package build inherited ${ key }`,
		);

	}

	const catalogueEnvironment = releaseGateEnvironment(
		byCommand.get( '--filter examples-batch catalogue:check:corpus' ),
		resultsRoot,
		hostileEnvironment,
	);
	assert.equal( catalogueEnvironment.TSLP_THREE_REPO, '/trusted/exact-three' );
	assert.equal( Object.hasOwn( catalogueEnvironment, 'TSLP_E2E_OUT' ), false );
	assert.equal( Object.hasOwn( catalogueEnvironment, 'TSLP_STOCK_REPORT' ), false );
	assert.equal( Object.hasOwn( catalogueEnvironment, 'TSLP_SITE_PUBLIC_OUT' ), false );

	const visualEnvironment = releaseGateEnvironment(
		byCommand.get( 'test:e2e:tier1' ),
		resultsRoot,
		hostileEnvironment,
	);
	assert.equal( visualEnvironment.TSLP_THREE_REPO, '/trusted/exact-three' );
	assert.equal( visualEnvironment.TSLP_E2E_OUT, `${ resultsRoot }/tier1-visual` );
	assert.equal( Object.hasOwn( visualEnvironment, 'TSLP_E2E_INPUT' ), false );
	assert.equal( Object.hasOwn( visualEnvironment, 'TSLP_E2E_SLIM_BUNDLE' ), false );
	assert.equal( Object.hasOwn( visualEnvironment, 'TSLP_SLIM_BUNDLE' ), false );

} );

test( 'records npm-compatible integrity for the exact packed bytes', () => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-release-integrity-' ) );
	try {

		const path = join( root, 'fixture.tgz' );
		writeFileSync( path, 'abc' );
		assert.deepEqual( computeTarballIntegrity( path ), {
			bytes: 3,
			integrity: 'sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==',
			shasum: 'a9993e364706816aba3e25717850c26c9cd0d89d',
		} );
		assert.equal(
			tarballName( '@tsl-precompile/runtime', '0.1.0-alpha.0' ),
			'tsl-precompile-runtime-0.1.0-alpha.0.tgz'
		);

	} finally {

		rmSync( root, { recursive: true, force: true } );

	}

} );

test( 'release archive validation accepts only exact tracked package bytes', () => {

	withRepo( {}, ( root ) => {

		const config = releasePackageConfig( '@tsl-precompile/runtime' );
		const sourceManifest = sourcePackageManifest( root, config );
		const bytes = releaseTarGzip( [
			{
				path: 'package/package.json',
				bytes: readFileSync( join( root, config.directory, 'package.json' ) ),
			},
		] );
		assert.doesNotThrow( () => assertReleaseTarballArchive( {
			bytes,
			repoRoot: root,
			config,
			sourceManifest,
			tarballPath: 'tracked fixture',
		} ) );
		const changedManifest = { ...sourceManifest, description: 'not reviewed' };
		assert.throws(
			() => assertReleaseTarballArchive( {
				bytes: releaseTarGzip( [
					{ path: 'package/package.json', bytes: JSON.stringify( changedManifest ) },
				] ),
				repoRoot: root,
				config,
				sourceManifest,
				tarballPath: 'changed manifest fixture',
			} ),
			/does not match the reviewed source manifest/,
		);

	} );

} );

test( 'release archive validation requires the exact committed package publish surface', () => {

	withRepo( {}, ( root ) => {

		const config = releasePackageConfig( '@tsl-precompile/runtime' );
		const manifestPath = join( root, config.directory, 'package.json' );
		const manifest = JSON.parse( readFileSync( manifestPath, 'utf8' ) );
		manifest.main = './src/index.js';
		manifest.files = [ 'src' ];
		writeFileSync( manifestPath, `${ JSON.stringify( manifest, null, 2 ) }\n` );
		const sourceDirectory = join( root, config.directory, 'src' );
		const excludedDirectory = join( root, config.directory, 'test' );
		mkdirSync( sourceDirectory, { recursive: true } );
		mkdirSync( excludedDirectory, { recursive: true } );
		writeFileSync( join( sourceDirectory, 'index.js' ), 'export const value = 1;\n' );
		writeFileSync( join( excludedDirectory, 'internal.js' ), 'must not publish\n' );
		git( root, 'add', config.directory );
		git( root, 'commit', '-m', 'add an explicit package surface' );

		const sourceManifest = sourcePackageManifest( root, config );
		const packageJson = readFileSync( manifestPath );
		const indexSource = readFileSync( join( sourceDirectory, 'index.js' ) );
		const validEntries = [
			{ path: 'package/package.json', bytes: packageJson },
			{ path: 'package/src/index.js', bytes: indexSource },
		];
		assert.doesNotThrow( () => assertReleaseTarballArchive( {
			bytes: releaseTarGzip( validEntries ),
			repoRoot: root,
			config,
			sourceManifest,
			tarballPath: 'exact-surface fixture',
		} ) );
		assert.throws(
			() => assertReleaseTarballArchive( {
				bytes: releaseTarGzip( [ validEntries[ 0 ] ] ),
				repoRoot: root,
				config,
				sourceManifest,
				tarballPath: 'omitted-source fixture',
			} ),
			/omits required committed publish entries: src\/index\.js/,
		);
		assert.throws(
			() => assertReleaseTarballArchive( {
				bytes: releaseTarGzip( [
					...validEntries,
					{
						path: 'package/test/internal.js',
						bytes: readFileSync( join( excludedDirectory, 'internal.js' ) ),
					},
				] ),
				repoRoot: root,
				config,
				sourceManifest,
				tarballPath: 'excluded-source fixture',
			} ),
			/entries outside the committed publish surface: test\/internal\.js/,
		);

	} );

} );

test( 'release archive validation compares tracked content to committed HEAD bytes', () => {

	withRepo( {}, ( root ) => {

		const config = releasePackageConfig( '@tsl-precompile/runtime' );
		const sourceDirectory = join( root, config.directory, 'src' );
		const sourcePath = join( sourceDirectory, 'index.js' );
		mkdirSync( sourceDirectory, { recursive: true } );
		writeFileSync( sourcePath, 'export const provenance = "committed";\n' );
		git( root, 'add', config.directory );
		git( root, 'commit', '-m', 'add committed runtime source' );
		const committedBytes = readFileSync( sourcePath );
		const sourceManifest = sourcePackageManifest( root, config );
		const packageJson = readFileSync( join( root, config.directory, 'package.json' ) );

		writeFileSync( sourcePath, 'export const provenance = "dirty worktree";\n' );
		assert.match( git( root, 'status', '--short' ), /packages\/runtime\/src\/index\.js/ );
		assert.throws(
			() => assertReleaseTarballArchive( {
				bytes: releaseTarGzip( [
					{ path: 'package/package.json', bytes: packageJson },
					{ path: 'package/src/index.js', bytes: readFileSync( sourcePath ) },
				] ),
				repoRoot: root,
				config,
				sourceManifest,
				tarballPath: 'dirty-tracked fixture',
			} ),
			/differs from committed source packages\/runtime\/src\/index\.js/,
		);
		assert.doesNotThrow( () => assertReleaseTarballArchive( {
			bytes: releaseTarGzip( [
				{ path: 'package/package.json', bytes: packageJson },
				{ path: 'package/src/index.js', bytes: committedBytes },
			] ),
			repoRoot: root,
			config,
			sourceManifest,
			tarballPath: 'committed-byte fixture',
		} ) );

	} );

} );

test( 'release archive validation ignores a shadow Git object store and index from the environment', () => {

	const root = makeRepo();
	const shadow = makeRepo();
	try {

		const config = releasePackageConfig( '@tsl-precompile/runtime' );
		const relativeSourcePath = `${ config.directory }/src/index.js`;
		const rootSourcePath = join( root, relativeSourcePath );
		const shadowSourcePath = join( shadow, relativeSourcePath );
		mkdirSync( dirname( rootSourcePath ), { recursive: true } );
		mkdirSync( dirname( shadowSourcePath ), { recursive: true } );
		writeFileSync( rootSourcePath, 'export const provenance = "reviewed target";\n' );
		writeFileSync( shadowSourcePath, 'export const provenance = "hostile shadow";\n' );
		git( root, 'add', relativeSourcePath );
		git( root, 'commit', '-m', 'add reviewed target source' );
		git( shadow, 'add', relativeSourcePath );
		git( shadow, 'commit', '-m', 'add hostile shadow source' );

		const hostileEnvironment = {
			GIT_DIR: join( shadow, '.git' ),
			GIT_WORK_TREE: root,
		};
		const inheritedBytes = execFileSync(
			'git',
			[ 'show', `HEAD:${ relativeSourcePath }` ],
			{
				cwd: root,
				encoding: 'utf8',
				env: { ...process.env, ...hostileEnvironment },
			},
		);
		assert.equal(
			inheritedBytes,
			'export const provenance = "hostile shadow";\n',
			'fixture must prove inherited Git variables redirect committed bytes',
		);

		withProcessEnvironment( hostileEnvironment, () => {

			assert.throws(
				() => assertReleaseTarballArchive( {
					bytes: releaseTarGzip( [
						{
							path: 'package/package.json',
							bytes: readFileSync( join( root, config.directory, 'package.json' ) ),
						},
						{
							path: 'package/src/index.js',
							bytes: readFileSync( shadowSourcePath ),
						},
					] ),
					repoRoot: root,
					config,
					sourceManifest: sourcePackageManifest( root, config ),
					tarballPath: 'shadow-object-store fixture',
				} ),
				/differs from committed source packages\/runtime\/src\/index\.js/,
			);

		} );

	} finally {

		rmSync( root, { recursive: true, force: true } );
		rmSync( shadow, { recursive: true, force: true } );

	}

} );

test( 'release archive validation ignores local Git replacement objects', () => {

	withRepo( {}, ( root ) => {

		const config = releasePackageConfig( '@tsl-precompile/runtime' );
		const sourceDirectory = join( root, config.directory, 'src' );
		const sourcePath = join( sourceDirectory, 'index.js' );
		mkdirSync( sourceDirectory, { recursive: true } );
		writeFileSync( sourcePath, 'export const provenance = "reviewed";\n' );
		git( root, 'add', config.directory );
		git( root, 'commit', '-m', 'add reviewed runtime source' );

		const replacementBytes = Buffer.from( 'export const provenance = "replacement";\n' );
		const replacementPath = join( root, 'replacement-object.js' );
		writeFileSync( replacementPath, replacementBytes );
		const replacementOid = git( root, 'hash-object', '-w', replacementPath );
		rmSync( replacementPath );
		const reviewedOid = git( root, 'rev-parse', `HEAD:${ config.directory }/src/index.js` );
		git( root, 'replace', reviewedOid, replacementOid );
		assert.equal(
			git( root, 'cat-file', 'blob', reviewedOid ),
			replacementBytes.toString( 'utf8' ).trim(),
			'the fixture must prove ordinary Git reads are replaced',
		);
		assert.equal( git( root, 'status', '--short' ), '' );

		assert.throws(
			() => assertReleaseTarballArchive( {
				bytes: releaseTarGzip( [
					{
						path: 'package/package.json',
						bytes: readFileSync( join( root, config.directory, 'package.json' ) ),
					},
					{ path: 'package/src/index.js', bytes: replacementBytes },
				] ),
				repoRoot: root,
				config,
				sourceManifest: sourcePackageManifest( root, config ),
				tarballPath: 'replacement-object fixture',
			} ),
			/differs from committed source packages\/runtime\/src\/index\.js/,
		);

	} );

} );

test( 'release archive validation rejects hidden padding and noncanonical or mismatched modes', () => {

	withRepo( {}, ( root ) => {

		const config = releasePackageConfig( '@tsl-precompile/contract' );
		const sourceManifest = sourcePackageManifest( root, config );
		const packageJson = readFileSync( join( root, config.directory, 'package.json' ) );
		const validatePackageJson = ( entry, tarballPath ) => assertReleaseTarballArchive( {
			bytes: releaseTarGzip( [ {
				path: 'package/package.json',
				bytes: packageJson,
				...entry,
			} ] ),
			repoRoot: root,
			config,
			sourceManifest,
			tarballPath,
		} );
		const noncanonicalGzip = releaseTarGzip( [ {
			path: 'package/package.json',
			bytes: packageJson,
		} ] );
		noncanonicalGzip[ 9 ] ^= 1;
		assert.throws(
			() => assertReleaseTarballArchive( {
				bytes: noncanonicalGzip,
				repoRoot: root,
				config,
				sourceManifest,
				tarballPath: 'gzip-metadata fixture',
			} ),
			/canonical pnpm gzip encoding/,
		);
		assert.throws(
			() => validatePackageJson( { paddingByte: 0x41 }, 'padding fixture' ),
			/non-zero tar padding/,
		);
		assert.throws(
			() => validatePackageJson( { mode: 0o600 }, 'unsupported-mode fixture' ),
			/unsupported noncanonical mode 600/,
		);
		assert.throws(
			() => validatePackageJson( { mode: 0o755 }, 'mismatched-mode fixture' ),
			/mode 755 does not match committed publish mode 644/,
		);

	} );

} );

test( 'release archive validation rejects an ignored file packed from a whitelisted source tree', () => {

	withRepo( {}, ( root ) => {

		writeFileSync( join( root, '.gitignore' ), '*.log\n' );
		git( root, 'add', '.gitignore' );
		git( root, 'commit', '-m', 'ignore local logs' );
		const config = releasePackageConfig( '@tsl-precompile/runtime' );
		const sourceManifest = sourcePackageManifest( root, config );
		const sourceDirectory = join( root, config.directory, 'src' );
		mkdirSync( sourceDirectory, { recursive: true } );
		const ignoredPath = join( sourceDirectory, 'secret.log' );
		writeFileSync( ignoredPath, 'local token accidentally captured by package files whitelist\n' );
		assert.equal( git( root, 'status', '--short' ), '', 'ignored fixture must remain invisible to the clean-tree guard' );
		assert.throws(
			() => assertReleaseTarballArchive( {
				bytes: releaseTarGzip( [
					{
						path: 'package/package.json',
						bytes: readFileSync( join( root, config.directory, 'package.json' ) ),
					},
					{ path: 'package/src/secret.log', bytes: readFileSync( ignoredPath ) },
				] ),
				repoRoot: root,
				config,
				sourceManifest,
				tarballPath: 'ignored-entry fixture',
			} ),
			/entries outside the committed publish surface: src\/secret\.log/,
		);

	} );

} );

test( 'release archive validation rejects duplicate, non-regular, and path-traversal entries', () => {

	withRepo( {}, ( root ) => {

		const config = releasePackageConfig( '@tsl-precompile/contract' );
		const sourceManifest = sourcePackageManifest( root, config );
		const packageJson = readFileSync( join( root, config.directory, 'package.json' ) );
		const validate = ( entries, tarballPath ) => assertReleaseTarballArchive( {
			bytes: releaseTarGzip( entries ),
			repoRoot: root,
			config,
			sourceManifest,
			tarballPath,
		} );
		assert.throws(
			() => validate(
				[
					{ path: 'package/package.json', bytes: packageJson },
					{ path: 'package/package.json', bytes: packageJson },
				],
				'duplicate fixture',
			),
			/duplicate entry package\.json/,
		);
		assert.throws(
			() => validate(
				[
					{ path: 'package/package.json', bytes: packageJson },
					{ path: 'package/src/link.js', type: '2' },
				],
				'symlink fixture',
			),
			/non-regular entry src\/link\.js/,
		);
		assert.throws(
			() => validate(
				[
					{ path: 'package/package.json', bytes: packageJson },
					{ path: 'package/../outside.txt', bytes: 'escape' },
				],
				'traversal fixture',
			),
			/path-traversal or non-canonical entry/,
		);

	} );

} );

test( 'release archive validation permits only the exact synchronized generated plugin skill', () => {

	withRepo( {}, ( root ) => {

		const config = releasePackageConfig( 'vite-plugin-tsl-precompile' );
		for ( const [ packagePath, sourcePath ] of Object.entries( config.generatedFiles ) ) {

			const source = join( root, sourcePath );
			mkdirSync( dirname( source ), { recursive: true } );
			writeFileSync( source, `canonical ${ packagePath }\n` );

		}
		git( root, 'add', '.agents' );
		git( root, 'commit', '-m', 'add canonical packaged skill' );
		const sourceManifest = sourcePackageManifest( root, config );
		const entries = [
			{
				path: 'package/package.json',
				bytes: readFileSync( join( root, config.directory, 'package.json' ) ),
			},
			...Object.entries( config.generatedFiles ).map( ( [ packagePath, sourcePath ] ) => ( {
				path: `package/${ packagePath }`,
				bytes: readFileSync( join( root, sourcePath ) ),
			} ) ),
		];
		assert.doesNotThrow( () => assertReleaseTarballArchive( {
			bytes: releaseTarGzip( entries ),
			repoRoot: root,
			config,
			sourceManifest,
			tarballPath: 'generated-skill fixture',
		} ) );
		assert.throws(
			() => assertReleaseTarballArchive( {
				bytes: releaseTarGzip( [
					...entries,
					{ path: 'package/skill/unreviewed.md', bytes: 'not canonical\n' },
				] ),
				repoRoot: root,
				config,
				sourceManifest,
				tarballPath: 'extra-skill fixture',
			} ),
			/entries outside the committed publish surface: skill\/unreviewed\.md/,
		);

	} );

} );

test( 'release tarball staging requires an exact private set instead of shared /tmp names', () => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-release-private-tarballs-' ) );
	try {

		assert.throws( () => parseTarballDirectory( [], {} ), /explicit|pass --directory/ );
		assert.equal(
			parseTarballDirectory( [], { TSLP_RELEASE_TARBALL_DIR: root } ),
			root
		);
		assert.equal( parsePackArgs( [ `--directory=${ root }` ] ), root );
		assert.throws( () => parsePackArgs( [ '--wat' ] ), /unknown option/ );

		const privateDirectory = join( root, 'fresh' );
		assert.equal(
			prepareReleaseTarballDirectory( { requestedDirectory: privateDirectory } ),
			privateDirectory
		);
		writeFileSync( join( privateDirectory, 'stale.tgz' ), 'stale' );
		assert.throws(
			() => prepareReleaseTarballDirectory( { requestedDirectory: privateDirectory } ),
			/not empty/
		);
		assert.throws(
			() => collectReleaseTarballIntegrity( {
				repoRoot: root,
				tarballDirectory: privateDirectory,
			} ),
			/ENOENT|cannot read|must contain exactly/
		);

	} finally {

		rmSync( root, { recursive: true, force: true } );

	}

} );

test( 'release tarball integrity rejects unrelated directory entries', () => {

	withRepo( {}, ( root ) => {

		const tarballDirectory = join( root, 'release-tarballs' );
		mkdirSync( tarballDirectory );
		for ( const relativePath of PUBLIC_PACKAGE_PATHS ) {

			const manifest = JSON.parse( readFileSync( join( root, relativePath ), 'utf8' ) );
			writeFileSync(
				join( tarballDirectory, tarballName( manifest.name, manifest.version ) ),
				'tarball fixture',
			);

		}
		writeFileSync( join( tarballDirectory, 'unexpected.txt' ), 'must fail closed' );
		assert.throws(
			() => collectReleaseTarballIntegrity( { repoRoot: root, tarballDirectory } ),
			/must contain exactly[\s\S]*unexpected\.txt/
		);

	} );

} );

test( 'publication pins exact tarballs/registry and requires an explicit channel', () => {

	assert.equal( parseDistTag( [ '--tag=alpha' ] ), 'alpha' );
	assert.equal( parseDistTag( [ '--tag', 'latest' ] ), 'latest' );
	assert.equal( parseDistTag( [ '--', '--tag=alpha' ] ), 'alpha' );
	assert.throws( () => parseDistTag( [] ), /pass exactly one publication channel/ );
	assert.throws( () => parseDistTag( [ '--tag=beta' ] ), /pass exactly one publication channel/ );
	assert.throws(
		() => parseDistTag( [ '--tag=alpha', '--tag=latest' ] ),
		/pass exactly one publication channel/
	);
	assert.doesNotThrow( () => assertDistTagMatchesVersion( 'alpha', '0.1.0-alpha.4' ) );
	assert.doesNotThrow( () => assertDistTagMatchesVersion( 'latest', '0.1.0' ) );
	assert.throws(
		() => assertDistTagMatchesVersion( 'latest', '0.1.0-alpha.4' ),
		/refusing to publish prerelease/
	);
	assert.throws(
		() => assertDistTagMatchesVersion( 'alpha', '0.1.0-beta.1' ),
		/refusing to publish non-alpha/
	);

	const args = buildTarballPublishArgs( '/private/release/contract.tgz', 'alpha' );
	assert.deepEqual( args, [
		'publish',
		'/private/release/contract.tgz',
		'--access',
		'public',
		'--tag',
		'alpha',
		'--registry',
		NPM_REGISTRY,
		NPM_SCOPE_REGISTRY_OPTION,
	] );
	assert.deepEqual(
		buildDistTagArgs( '@tsl-precompile/contract', '0.1.0-alpha.0', 'alpha' ),
		[
			'dist-tag',
			'add',
			'@tsl-precompile/contract@0.1.0-alpha.0',
			'alpha',
			'--registry',
			NPM_REGISTRY,
			NPM_SCOPE_REGISTRY_OPTION,
		]
	);
	assert.throws( () => buildTarballPublishArgs( 'relative.tgz', 'alpha' ), /must be absolute/ );

} );

test( 'the explicit scoped registry option overrides a hostile user npmrc', () => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-release-npmrc-' ) );
	try {

		const userConfig = join( root, 'user.npmrc' );
		writeFileSync( userConfig, '@tsl-precompile:registry=https://example.invalid/\n' );
		const effective = execFileSync(
			'npm',
			[
				'config',
				'get',
				'@tsl-precompile:registry',
				'--registry',
				NPM_REGISTRY,
				NPM_SCOPE_REGISTRY_OPTION,
			],
			{
				encoding: 'utf8',
				env: { ...process.env, NPM_CONFIG_USERCONFIG: userConfig },
			},
		).trim();
		assert.equal( effective, NPM_REGISTRY );

	} finally {

		rmSync( root, { recursive: true, force: true } );

	}

} );

test( 'SemVer ordering and registry planning reject downgrades and byte drift', () => {

	assert.equal( compareSemver( '0.1.0-alpha.2', '0.1.0-alpha.1' ), 1 );
	assert.equal( compareSemver( '0.1.0-alpha.10', '0.1.0-alpha.2' ), 1 );
	assert.equal( compareSemver( '0.1.0', '0.1.0-alpha.99' ), 1 );
	assert.equal( compareSemver( '1.0.0+build.2', '1.0.0+build.1' ), 0 );
	assert.equal( compareSemver( '999999999999999999999.0.0', '2.0.0' ), 1 );
	assert.throws( () => compareSemver( '1.0.0-alpha.01', '1.0.0-alpha.1' ), /invalid SemVer/ );

	const tarballs = [
		{ name: '@tsl-precompile/contract', version: '0.1.0-alpha.2', integrity: 'sha512-a', shasum: 'a' },
		{ name: '@tsl-precompile/runtime', version: '0.1.0-alpha.2', integrity: 'sha512-b', shasum: 'b' },
		{ name: 'vite-plugin-tsl-precompile', version: '0.1.0-alpha.2', integrity: 'sha512-c', shasum: 'c' },
	];
	const registryStates = tarballs.map( ( tarball ) => ( {
		name: tarball.name,
		version: tarball.version,
		currentTagVersion: '0.1.0-alpha.1',
		published: false,
		integrity: null,
		shasum: null,
	} ) );
	assert.deepEqual(
		planRegistryPublication( tarballs, 'alpha', registryStates ).map( ( entry ) => entry.action ),
		[ 'publish', 'publish', 'publish' ]
	);
	const downgrade = registryStates.map( ( entry ) => ( {
		...entry,
		currentTagVersion: '0.1.0-alpha.3',
	} ) );
	assert.throws(
		() => planRegistryPublication( tarballs, 'alpha', downgrade ),
		/refusing to move .* backward/
	);
	const drift = registryStates.map( ( entry, index ) => ( {
		...entry,
		published: index === 0,
		integrity: index === 0 ? 'sha512-other' : null,
		shasum: index === 0 ? 'other' : null,
	} ) );
	assert.throws(
		() => planRegistryPublication( tarballs, 'alpha', drift ),
		/registry bytes that do not match/
	);
	const resume = tarballs.map( ( tarball, index ) => ( {
		name: tarball.name,
		version: tarball.version,
		currentTagVersion: index === 0 ? tarball.version : '0.1.0-alpha.1',
		published: true,
		integrity: tarball.integrity,
		shasum: tarball.shasum,
	} ) );
	assert.deepEqual(
		planRegistryPublication( tarballs, 'alpha', resume ).map( ( entry ) => entry.action ),
		[ 'none', 'tag', 'tag' ]
	);

} );

test( 'npm authority is checked for every existing name and new scope before writes', () => {

	const tarballs = [
		{ name: '@tsl-precompile/contract', version: '0.1.0-alpha.0' },
		{ name: '@tsl-precompile/runtime', version: '0.1.0-alpha.0' },
		{ name: 'vite-plugin-tsl-precompile', version: '0.1.0-alpha.0' },
	];
	const registryStates = [
		{ packageExists: true },
		{ packageExists: false },
		{ packageExists: false },
	];
	const queries = [];
	const query = ( args ) => {

		queries.push( args );
		if ( args[ 0 ] === 'whoami' ) return 'release-owner';
		if ( args[ 0 ] === 'view' ) return [ 'release-owner <owner@example.invalid>' ];
		if ( args[ 0 ] === 'org' ) return { 'release-owner': 'owner' };
		throw new Error( `unexpected query ${ args.join( ' ' ) }` );

	};
	assert.equal(
		preflightNpmAuthority( { tarballs, registryStates, query, repoRoot: '/fixture' } ),
		'release-owner'
	);
	assert.equal( queries.filter( ( args ) => args[ 0 ] === 'whoami' ).length, 1 );
	assert.equal( queries.filter( ( args ) => args[ 0 ] === 'view' ).length, 1 );
	assert.equal( queries.filter( ( args ) => args[ 0 ] === 'org' ).length, 1 );
	assert.throws(
		() => preflightNpmAuthority( {
			tarballs,
			registryStates,
			repoRoot: '/fixture',
			query: ( args ) => {

				if ( args[ 0 ] === 'whoami' ) return 'intruder';
				if ( args[ 0 ] === 'view' ) return [ 'release-owner <owner@example.invalid>' ];
				return { intruder: 'developer' };

			},
		} ),
		/not a maintainer/
	);

} );

test( 'post-write registry verification tolerates bounded propagation delay', () => {

	const entry = {
		name: '@tsl-precompile/contract',
		version: '0.1.0-alpha.0',
		integrity: 'sha512-exact',
		shasum: 'exact',
	};
	let reads = 0;
	const waits = [];
	const result = verifyPublishedRegistryState( {
		entry,
		distTag: 'alpha',
		repoRoot: '/fixture',
		retryDelays: [ 1, 2, 3 ],
		wait: ( delay ) => waits.push( delay ),
		readRegistryState: () => {

			reads ++;
			if ( reads < 3 ) {

				return {
					published: false,
					currentTagVersion: null,
					integrity: null,
					shasum: null,
				};

			}
			return {
				published: true,
				currentTagVersion: entry.version,
				integrity: entry.integrity,
				shasum: entry.shasum,
			};

		},
	} );
	assert.equal( result.currentTagVersion, entry.version );
	assert.equal( reads, 3 );
	assert.deepEqual( waits, [ 1, 2 ] );

} );

test( 'publication preflights all packages and sends the exact checked tarballs', () => {

	const events = [];
	const state = {
		head: 'a'.repeat( 40 ),
		tag: 'v0.1.0-alpha.0',
		version: '0.1.0-alpha.0',
	};
	const tarballs = [
		{
			name: '@tsl-precompile/contract',
			version: state.version,
			file: 'tsl-precompile-contract-0.1.0-alpha.0.tgz',
			path: '/private/release/tsl-precompile-contract-0.1.0-alpha.0.tgz',
			bytes: 1,
			integrity: 'sha512-a',
			shasum: 'a',
		},
		{
			name: '@tsl-precompile/runtime',
			version: state.version,
			file: 'tsl-precompile-runtime-0.1.0-alpha.0.tgz',
			path: '/private/release/tsl-precompile-runtime-0.1.0-alpha.0.tgz',
			bytes: 1,
			integrity: 'sha512-b',
			shasum: 'b',
		},
		{
			name: 'vite-plugin-tsl-precompile',
			version: state.version,
			file: 'vite-plugin-tsl-precompile-0.1.0-alpha.0.tgz',
			path: '/private/release/vite-plugin-tsl-precompile-0.1.0-alpha.0.tgz',
			bytes: 1,
			integrity: 'sha512-c',
			shasum: 'c',
		},
	];
	const registry = new Map( tarballs.map( ( tarball ) => [ tarball.name, {
		name: tarball.name,
		version: tarball.version,
		currentTagVersion: null,
		published: false,
		integrity: null,
		shasum: null,
	} ] ) );
	runReleasePublish( [ '--tag=alpha' ], {
		repoRoot: '/fixture',
		assertState: ( options ) => {

			events.push( [ 'state', options ] );
			return state;

		},
		executeReleaseCheck: ( options ) => {

			events.push( [ 'full-check', options ] );
			return { resultsRoot: '/private', tarballDirectory: '/private/release', tarballs };

		},
		verifyTarballs: () => tarballs,
		verifyTarball: ( tarball ) => events.push( [ 'verify-tarball', tarball.name ] ),
		verifyAuthority: () => events.push( [ 'authority-preflight' ] ),
		readRegistryState: ( request ) => {

			events.push( [ 'registry-read', request.name ] );
			return { ...registry.get( request.name ) };

		},
		execute: ( command, args ) => {

			events.push( [ 'execute', command, args ] );
			if ( command === 'npm' && args[ 0 ] === 'publish' ) {

				const tarball = tarballs.find( ( entry ) => entry.path === args[ 1 ] );
				registry.set( tarball.name, {
					name: tarball.name,
					version: tarball.version,
					currentTagVersion: tarball.version,
					published: true,
					integrity: tarball.integrity,
					shasum: tarball.shasum,
				} );

			}

		},
	} );

	const fullCheckIndex = events.findIndex( ( event ) => event[ 0 ] === 'full-check' );
	const publishIndex = events.findIndex(
		( event ) => event[ 0 ] === 'execute' && event[ 1 ] === 'npm' && event[ 2 ][ 0 ] === 'publish'
	);
	assert.ok( fullCheckIndex >= 0 );
	assert.ok( publishIndex > fullCheckIndex );
	assert.equal(
		events.slice( 0, publishIndex ).filter( ( event ) => event[ 0 ] === 'registry-read' ).length,
		4,
		'three-package preflight plus the first package just-before-write check must precede publication'
	);
	assert.equal(
		events.slice( 0, publishIndex ).some(
			( event ) => event[ 0 ] === 'execute' && event[ 1 ] === 'npm' && event[ 2 ]?.[ 0 ] === 'publish'
		),
		false
	);
	const publishedPaths = events
		.filter( ( event ) => event[ 0 ] === 'execute' && event[ 1 ] === 'npm' && event[ 2 ][ 0 ] === 'publish' )
		.map( ( event ) => event[ 2 ][ 1 ] );
	assert.deepEqual( publishedPaths, tarballs.map( ( tarball ) => tarball.path ) );
	assert.equal(
		events.filter( ( event ) => event[ 0 ] === 'execute' && event[ 1 ] === 'pnpm' )
			.some( ( event ) => event[ 2 ].includes( 'publish' ) ),
		false
	);
	assert.equal( events[ 0 ][ 1 ].requireTag, true );
	assert.equal( events[ 0 ][ 1 ].requireUpstream, true );
	assert.equal( events[ 0 ][ 1 ].requireRemoteTag, true );

} );

test( 'workflow executables use immutable action SHAs and fixed runtime baselines', () => {

	const workflowsDirectory = join( TEST_REPO_ROOT, '.github/workflows' );
	for ( const file of readdirSync( workflowsDirectory ).filter( ( name ) => /\.ya?ml$/.test( name ) ) ) {

		const path = join( workflowsDirectory, file );
		const source = readFileSync( path, 'utf8' );
		assert.doesNotMatch( source, /\bruns-on:\s*ubuntu-latest\b/, `${ file } uses a moving runner alias` );
		for ( const step of source.split( /(?=^\s*-\s+(?:name|uses):)/m ) ) {

			const externalRepository = /\brepository:\s*([^\s#]+)/.exec( step )?.[ 1 ];
			if ( ! externalRepository ) continue;
			const ref = /\bref:\s*([^\s#]+)/.exec( step )?.[ 1 ];
			assert.match(
				ref || '',
				/^[0-9a-f]{40}$/,
				`${ file } external checkout ${ externalRepository } must use an immutable commit SHA`,
			);

		}
		for ( const line of source.split( '\n' ) ) {

			const uses = /\buses:\s*([^\s#]+)/.exec( line )?.[ 1 ];
			if ( uses && ! uses.startsWith( './' ) && ! uses.startsWith( 'docker://' ) ) {

				const at = uses.lastIndexOf( '@' );
				assert.ok( at > 0, `${ file } action has no ref: ${ uses }` );
				assert.match(
					uses.slice( at + 1 ),
					/^[0-9a-f]{40}$/,
					`${ file } action must be pinned to a full commit SHA: ${ uses }`
				);

			}
			const nodeVersion = /\bnode-version:\s*([^\s#]+)/.exec( line )?.[ 1 ];
			if ( nodeVersion && ! nodeVersion.startsWith( '${{' ) ) {

				assert.match(
					nodeVersion,
					/^\d+\.\d+\.\d+$/,
					`${ file } must pin exact Node versions: ${ nodeVersion }`
				);

			}

		}

	}
	const dependabot = readFileSync( join( TEST_REPO_ROOT, '.github/dependabot.yml' ), 'utf8' );
	assert.match( dependabot, /package-ecosystem:\s*github-actions/ );
	const batchWorkflow = readFileSync( join( workflowsDirectory, 'batch.yml' ), 'utf8' );
	assert.doesNotMatch(
		batchWorkflow,
		/--gate-min-pass(?:=|\s|$)/,
		'batch workflow must not pass the removed stock-renderer gate option',
	);

} );

test( 'production site build and deploy jobs are restricted to main', () => {

	const workflow = readFileSync(
		join( TEST_REPO_ROOT, '.github/workflows/deploy-site.yml' ),
		'utf8',
	);
	const lines = workflow.split( '\n' );
	const jobBlock = ( name ) => {

		const start = lines.findIndex( ( line ) => line === `  ${ name }:` );
		assert.notEqual( start, -1, `deploy-site workflow is missing the ${ name } job` );
		const next = lines.findIndex(
			( line, index ) => index > start && /^ {2}[A-Za-z0-9_-]+:$/.test( line ),
		);
		return lines.slice( start + 1, next === -1 ? lines.length : next );

	};
	for ( const name of [ 'build', 'deploy' ] ) {

		assert.equal(
			jobBlock( name ).filter(
				( line ) => line === "    if: github.ref == 'refs/heads/main'",
			).length,
			1,
			`deploy-site ${ name } must have one job-level main-branch guard`,
		);

	}

} );
