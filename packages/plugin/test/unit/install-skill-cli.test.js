import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const INSTALL_SKILL_CLI = resolve( import.meta.dirname, '../../src/cli/install-skill.js' );

function runCli( cwd, args ) {

	return spawnSync(
		process.execPath,
		[ INSTALL_SKILL_CLI, ...args ],
		{ cwd, encoding: 'utf8' },
	);

}

test( 'install-skill JSON command is stable, idempotent, and directly executable by doctor clients', () => {

	const project = mkdtempSync( join( tmpdir(), 'tslp-install-skill-cli-' ) );
	try {

		const first = runCli( project, [ '--json', '--target', 'codex' ] );
		assert.equal( first.status, 0, first.stderr );
		assert.equal( first.stderr, '' );
		const installed = JSON.parse( first.stdout );
		assert.deepEqual( {
			schemaVersion: installed.schemaVersion,
			ok: installed.ok,
			status: installed.status,
			destination: installed.destination,
		}, {
			schemaVersion: 1,
			ok: true,
			status: 'installed',
			destination: '.codex/skills/integrate-tsl-precompile',
		} );
		assert.match( installed.digest, /^[a-f0-9]{64}$/ );
		assert.match( installed.suggestedAgentPrompt, /integrate TSL precompilation/ );
		assert.match( installed.suggestedAgentPrompt, /production WebGPURenderer preview \(WebGPU or WebGL backend\)/ );
		assert.equal( installed.command, 'tsl-precompile-install-skill' );
		assert.equal( installed.nextActions[ 0 ].kind, 'command' );
		assert.equal( installed.nextActions[ 0 ].code, 'run-doctor' );
		assert.equal( installed.nextActions[ 0 ].cwd, realpathSync( project ) );
		assert.equal( installed.nextActions[ 0 ].argv.includes( '--compact' ), true );
		const [ doctorCommand, ...doctorArgs ] = installed.nextActions[ 0 ].argv;
		const doctor = spawnSync( doctorCommand, doctorArgs, {
			cwd: installed.nextActions[ 0 ].cwd,
			encoding: 'utf8',
		} );
		assert.equal( doctor.status, 1 );
		assert.equal( doctor.stderr, '' );
		assert.equal( JSON.parse( doctor.stdout ).command, 'tsl-precompile-doctor' );

		const second = runCli( project, [ '--target=codex', '--json' ] );
		assert.equal( second.status, 0, second.stderr );
		const current = JSON.parse( second.stdout );
		assert.equal( current.status, 'current' );
		assert.equal( current.digest, installed.digest );

		appendFileSync(
			resolve( project, '.codex/skills/integrate-tsl-precompile/SKILL.md' ),
			'\nLocal project guidance.\n',
		);
		const conflictRun = runCli( project, [ '--json', '--target', 'codex' ] );
		assert.equal( conflictRun.status, 1 );
		assert.equal( conflictRun.stderr, '' );
		const conflict = JSON.parse( conflictRun.stdout );
		assert.equal( conflict.status, 'conflict' );
		assert.equal( conflict.nextActions[ 0 ].kind, 'manual' );
		assert.equal( conflict.nextActions[ 0 ].code, 'resolve-skill-conflict' );
		assert.equal( conflict.nextActions[ 0 ].argv, null );
		assert.deepEqual(
			conflict.nextActions[ 0 ].requiresInput,
			[ 'replaceLocallyModifiedSkill' ],
		);
		assert.deepEqual(
			conflict.nextActions[ 0 ].commandTemplate.slice( - 4 ),
			[ '--target', 'codex', '--force', '--json' ],
		);
		const [ replaceCommand, ...replaceArgs ] = conflict.nextActions[ 0 ].commandTemplate;
		const replaced = spawnSync( replaceCommand, replaceArgs, {
			cwd: conflict.nextActions[ 0 ].cwd,
			encoding: 'utf8',
		} );
		assert.equal( replaced.status, 0, replaced.stderr );
		assert.equal( JSON.parse( replaced.stdout ).status, 'installed' );

	} finally {

		rmSync( project, { recursive: true, force: true } );

	}

} );

test( 'install-skill JSON keeps invalid invocations machine-readable', () => {

	const project = mkdtempSync( join( tmpdir(), 'tslp-install-skill-cli-error-' ) );
	try {

		const run = runCli( project, [ '--json', '--target' ] );
		assert.equal( run.status, 1 );
		assert.equal( run.stderr, '' );
		const result = JSON.parse( run.stdout );
		assert.equal( result.schemaVersion, 1 );
		assert.equal( result.ok, false );
		assert.equal( result.status, 'failed' );
		assert.equal( result.command, 'tsl-precompile-install-skill' );
		assert.match( result.issues[ 0 ], /--target requires a value/ );
		assert.equal( result.nextActions[ 0 ].kind, 'command' );
		assert.equal( result.nextActions[ 0 ].code, 'show-help' );
		assert.equal( result.nextActions[ 0 ].cwd, realpathSync( project ) );
		const [ command, ...args ] = result.nextActions[ 0 ].argv;
		const help = spawnSync( command, args, {
			cwd: result.nextActions[ 0 ].cwd,
			encoding: 'utf8',
		} );
		assert.equal( help.status, 0 );
		assert.match( help.stdout, /Usage:\s+tsl-precompile-install-skill/ );

	} finally {

		rmSync( project, { recursive: true, force: true } );

	}

} );

test( 'install-skill JSON help remains one machine-readable result', () => {

	const project = mkdtempSync( join( tmpdir(), 'tslp-install-skill-cli-help-' ) );
	try {

		const run = runCli( project, [ '--help', '--json' ] );
		assert.equal( run.status, 0 );
		assert.equal( run.stderr, '' );
		const result = JSON.parse( run.stdout );
		assert.equal( result.schemaVersion, 1 );
		assert.equal( result.ok, true );
		assert.equal( result.status, 'help' );
		assert.equal( result.command, 'tsl-precompile-install-skill' );
		assert.deepEqual( result.nextActions, [] );
		assert.match( result.help, /--target/ );

	} finally {

		rmSync( project, { recursive: true, force: true } );

	}

} );
