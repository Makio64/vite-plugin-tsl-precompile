import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
	AGENT_SKILL_PROMPT,
	digestAgentSkillTree,
	installAgentSkill,
} from '../../src/agent-skill-installer.js';

const canonicalSkill = resolve( import.meta.dirname, '../../../../.agents/skills/integrate-tsl-precompile' );

test( 'agent skill installer is idempotent and preserves local edits by default', async () => {

	const project = await mkdtemp( join( tmpdir(), 'tslp-agent-skill-' ) );
	const destination = resolve( project, '.agents/skills/integrate-tsl-precompile' );
	try {

		const installed = await installAgentSkill( { cwd: project, sourceDir: canonicalSkill } );
		assert.equal( installed.status, 'installed' );
		assert.match( installed.digest, /^[a-f0-9]{64}$/ );
		assert.equal( installed.prompt, AGENT_SKILL_PROMPT );
		assert.match( installed.prompt, /production WebGPURenderer preview \(WebGPU or WebGL backend\)/ );
		assert.equal( installed.digest, await digestAgentSkillTree( canonicalSkill ) );
		assert.match( await readFile( resolve( destination, 'SKILL.md' ), 'utf8' ), /^---\nname: integrate-tsl-precompile\n/ );
		assert.match( await readFile( resolve( destination, 'agents/openai.yaml' ), 'utf8' ), /display_name: "Integrate TSL Precompile"/ );

		const current = await installAgentSkill( { cwd: project, sourceDir: canonicalSkill } );
		assert.equal( current.status, 'current' );
		assert.equal( current.digest, installed.digest );
		assert.equal( current.prompt, AGENT_SKILL_PROMPT );

		await writeFile( resolve( destination, 'LOCAL.md' ), 'keep me\n' );
		await assert.rejects(
			installAgentSkill( { cwd: project, sourceDir: canonicalSkill } ),
			/already exists with local changes/,
		);

		const replaced = await installAgentSkill( { cwd: project, sourceDir: canonicalSkill, force: true } );
		assert.equal( replaced.status, 'installed' );
		await assert.rejects( readFile( resolve( destination, 'LOCAL.md' ), 'utf8' ), /ENOENT/ );

	} finally {

		await rm( project, { recursive: true, force: true } );

	}

} );

test( 'agent skill installer supports named project-local roots and rejects escapes', async () => {

	const project = await mkdtemp( join( tmpdir(), 'tslp-agent-skill-target-' ) );
	try {

		const installed = await installAgentSkill( { cwd: project, target: 'codex', sourceDir: canonicalSkill } );
		assert.equal( installed.destination, resolve( project, '.codex/skills/integrate-tsl-precompile' ) );
		await assert.rejects(
			installAgentSkill( { cwd: project, target: '../outside', sourceDir: canonicalSkill } ),
			/Refusing to install outside/,
		);

	} finally {

		await rm( project, { recursive: true, force: true } );

	}

} );

test( 'agent skill installer rejects target-root and destination symlink escapes', async ( t ) => {

	if ( process.platform === 'win32' ) {

		t.skip( 'directory symlink creation requires elevated privileges on some Windows hosts' );
		return;

	}
	const project = await mkdtemp( join( tmpdir(), 'tslp-agent-skill-symlink-project-' ) );
	const outside = await mkdtemp( join( tmpdir(), 'tslp-agent-skill-symlink-outside-' ) );
	try {

		await mkdir( resolve( project, '.agents' ), { recursive: true } );
		await symlink( outside, resolve( project, '.agents/skills' ), 'dir' );
		await assert.rejects(
			installAgentSkill( { cwd: project, sourceDir: canonicalSkill, force: true } ),
			/symbolic-link target path/,
		);
		await assert.rejects(
			readFile( resolve( outside, 'integrate-tsl-precompile/SKILL.md' ), 'utf8' ),
			/ENOENT/,
		);

		await rm( resolve( project, '.agents/skills' ) );
		await mkdir( resolve( project, '.agents/skills' ), { recursive: true } );
		await symlink( outside, resolve( project, '.agents/skills/integrate-tsl-precompile' ), 'dir' );
		await assert.rejects(
			installAgentSkill( { cwd: project, sourceDir: canonicalSkill, force: true } ),
			/symbolic-link skill destination/,
		);

	} finally {

		await rm( project, { recursive: true, force: true } );
		await rm( outside, { recursive: true, force: true } );

	}

} );

test( 'agent skill installer rejects symlinks inside the packaged skill tree', async ( t ) => {

	if ( process.platform === 'win32' ) {

		t.skip( 'file symlink creation requires elevated privileges on some Windows hosts' );
		return;

	}
	const project = await mkdtemp( join( tmpdir(), 'tslp-agent-skill-source-link-project-' ) );
	const source = await mkdtemp( join( tmpdir(), 'tslp-agent-skill-source-link-' ) );
	try {

		await writeFile( resolve( source, 'SKILL.md' ), '---\nname: integrate-tsl-precompile\n---\n' );
		await symlink( '/etc/passwd', resolve( source, 'linked-secret' ) );
		await assert.rejects(
			digestAgentSkillTree( source ),
			/skill tree containing a symbolic link/,
		);
		await assert.rejects(
			installAgentSkill( { cwd: project, sourceDir: source } ),
			/skill tree containing a symbolic link/,
		);

	} finally {

		await rm( project, { recursive: true, force: true } );
		await rm( source, { recursive: true, force: true } );

	}

} );

test( 'agent skill installer rejects a symbolic-link source root', async ( t ) => {

	if ( process.platform === 'win32' ) {

		t.skip( 'directory symlink creation requires elevated privileges on some Windows hosts' );
		return;

	}
	const project = await mkdtemp( join( tmpdir(), 'tslp-agent-skill-source-root-project-' ) );
	const parent = await mkdtemp( join( tmpdir(), 'tslp-agent-skill-source-root-' ) );
	const source = resolve( parent, 'source' );
	const linkedSource = resolve( parent, 'linked-source' );
	try {

		await mkdir( source );
		await writeFile( resolve( source, 'SKILL.md' ), '---\nname: integrate-tsl-precompile\n---\n' );
		await symlink( source, linkedSource, 'dir' );
		await assert.rejects(
			digestAgentSkillTree( linkedSource ),
			/symbolic-link agent skill tree root/,
		);
		await assert.rejects(
			installAgentSkill( { cwd: project, sourceDir: linkedSource } ),
			/symbolic-link skill source root/,
		);

	} finally {

		await rm( project, { recursive: true, force: true } );
		await rm( parent, { recursive: true, force: true } );

	}

} );
