import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
	compactDoctorResult,
	inspectTslPrecompileProject,
	parseDoctorArgs,
	printDoctorResult,
} from '../../src/cli/doctor-support.js';

const DOCTOR_CLI = resolve( import.meta.dirname, '../../src/cli/doctor.js' );
const CANONICAL_SKILL = resolve( import.meta.dirname, '../../../../.agents/skills/integrate-tsl-precompile' );

async function writeProjectFile( root, path, contents ) {

	const destination = resolve( root, path );
	await mkdir( dirname( destination ), { recursive: true } );
	await writeFile( destination, contents );

}

async function writeInstalledPackage( root, name, version ) {

	await writeProjectFile(
		root,
		`node_modules/${ name }/package.json`,
		JSON.stringify( { name, version } ),
	);

}

function assertDependencyOrder( actions ) {

	const firstIndexByCode = new Map();
	for ( const [ index, action ] of actions.entries() ) {

		if ( ! firstIndexByCode.has( action.code ) ) firstIndexByCode.set( action.code, index );

	}
	for ( const [ index, action ] of actions.entries() ) {

		for ( const dependency of action.dependsOn || [] ) {

			if ( ! firstIndexByCode.has( dependency ) ) continue;
			assert.equal(
				firstIndexByCode.get( dependency ) < index,
				true,
				`${ dependency } must precede ${ action.code }`,
			);

		}

	}

}

async function inspectPackageManagerProject( {
	packageManager,
	lockfiles = [],
} = {} ) {

	const project = await mkdtemp( join( tmpdir(), 'tslp-doctor-package-manager-' ) );
	await mkdir( resolve( project, '.git' ), { recursive: true } );
	await writeProjectFile( project, 'package.json', JSON.stringify( {
		name: 'doctor-package-manager-fixture',
		private: true,
		...( packageManager === undefined ? {} : { packageManager } ),
	} ) );
	await writeProjectFile( project, 'src/main.js', 'export const fixture = true;\n' );
	for ( const lockfile of lockfiles ) await writeProjectFile( project, lockfile, '\n' );
	const result = await inspectTslPrecompileProject( {
		root: project,
		sources: [ 'src' ],
		verifyRunner: async () => ( {
			schemaVersion: 1,
			ok: false,
			checkedArtifactFiles: 0,
			markerCoverage: {
				enabled: true,
				total: 0,
				covered: 0,
				missing: [],
				issues: [],
			},
			issues: [ 'artifacts: artifact directory does not exist' ],
		} ),
	} );
	return { project, result };

}

test( 'doctor parser accepts repeatable source and exact plugin-matching options', () => {

	const root = resolve( '/tmp/doctor-fixture' );
	assert.deepEqual(
		parseDoctorArgs( [
			'--json',
			'--compact',
			'--root',
			root,
			'--source=src',
			'-s',
			'app/client.ts',
			'--source-root',
			'/tmp/source-identity',
			'--artifacts=generated/tsl',
			'--no-auto-mark',
			'--auto-mark-prefix',
			'shader',
		], '/' ),
		{
			root,
			json: true,
			compact: true,
			help: false,
			sources: [ 'src', 'app/client.ts' ],
			sourceRoot: '/tmp/source-identity',
			artifacts: 'generated/tsl',
			autoMark: false,
			autoMarkPrefix: 'shader',
		},
	);
	assert.equal(
		parseDoctorArgs( [ '--root', root ], '/' ).sourceRoot,
		root,
	);
	assert.equal(
		parseDoctorArgs( [ '--source-root', '..', '--root', root ], '/' ).sourceRoot,
		resolve( root, '..' ),
	);
	assert.throws( () => parseDoctorArgs( [ '--source' ] ), /requires a value/ );
	assert.throws( () => parseDoctorArgs( [ '--unknown' ] ), /Unknown doctor option/ );

} );

test( 'doctor preserves a nondefault source root in verification and generated actions', async () => {

	const workspace = await mkdtemp( join( tmpdir(), 'tslp-doctor-source-root-' ) );
	const project = resolve( workspace, 'apps/demo' );
	let verificationOptions = null;
	try {

		await mkdir( resolve( workspace, '.git' ), { recursive: true } );
		await writeProjectFile( project, 'package.json', JSON.stringify( {
			name: 'doctor-source-root-fixture',
			private: true,
			packageManager: 'pnpm@10.0.0',
			scripts: {
				dev: 'vite',
				build: 'vite build',
			},
		} ) );
		await writeProjectFile( project, 'src/main.js', 'export const fixture = true;\n' );
		const result = await inspectTslPrecompileProject( {
			root: project,
			sources: [ 'src' ],
			sourceRoot: workspace,
			verifyRunner: async ( options ) => {

				verificationOptions = options;
				return {
					schemaVersion: 1,
					ok: false,
					checkedArtifactFiles: 0,
					markerCoverage: {
						enabled: true,
						total: 0,
						covered: 0,
						missing: [],
						issues: [],
					},
					issues: [ 'artifacts: artifact directory does not exist' ],
				};

			},
		} );

		assert.equal( result.project.root, project );
		assert.equal( result.project.sourceRoot, workspace );
		assert.equal( verificationOptions.sourceRoot, workspace );
		assert.equal(
			result.checks.find( ( check ) => check.id === 'source-files' ).evidence.sourceRoot,
			workspace,
		);
		assert.deepEqual(
			result.commands.argv.doctor,
			[
				'pnpm',
				'exec',
				'tsl-precompile-doctor',
				'--json',
				'--compact',
				'--source',
				'src',
				'--source-root',
				'../..',
			],
		);
		assert.equal(
			result.commands.templates.recapture.join( '\0' ).includes( '--source-root\0../..' ),
			true,
		);
		assert.equal(
			result.commands.argv.verify.join( '\0' ).includes( '--source-root\0../..' ),
			true,
		);
		const recapture = result.nextActions.find( ( action ) => action.code === 'artifact-recapture' );
		assert.deepEqual( recapture.commandTemplate, result.commands.templates.recapture );
		assertDependencyOrder( result.nextActions );

	} finally {

		await rm( workspace, { recursive: true, force: true } );

	}

} );

test( 'compact doctor output preserves actions and checks while bounding bulky evidence', () => {

	const sourceFiles = Array.from( { length: 80 }, ( _, index ) => `src/module-${ index }.js` );
	const markers = Array.from( { length: 70 }, ( _, index ) => ( {
		name: `marker-${ index }`,
		source: `src/module-${ index }.js`,
		dependencies: Array.from( { length: 30 }, ( _unused, dependency ) => `dep-${ dependency }` ),
	} ) );
	const skillCandidates = Array.from( { length: 20 }, ( _, index ) => ( {
		location: `.agents/skills/integrate-${ index }/SKILL.md`,
		status: index === 0 ? 'current' : 'stale',
		digest: String( index ).padStart( 64, '0' ),
	} ) );
	const checks = Array.from( { length: 17 }, ( _, index ) => ( {
		id: `check-${ index }`,
		status: 'pass',
		evidence: {
			sourceFiles,
			...( index === 0 ? {
				expectedDigest: 'a'.repeat( 64 ),
				candidates: skillCandidates,
			} : {} ),
		},
	} ) );
	const nextActions = [ {
		kind: 'command',
		code: 'run-build',
		cwd: '/absolute/project',
		argv: [ 'pnpm', 'run', 'build' ],
	} ];
	const compact = compactDoctorResult( {
		schemaVersion: 1,
		ok: true,
		status: 'passed',
		command: 'tsl-precompile-doctor',
		discovery: { sourceFiles, markerScanIssues: [] },
		verification: {
			ok: true,
			directories: [],
			issues: [],
			diagnostics: [],
			markerCoverage: {
				markers,
				missing: [],
				issues: [],
			},
		},
		checks,
		nextActions,
		proof: { productionBuild: 'unverified' },
		remainingGates: [ 'production-build' ],
	}, {
		listLimit: 5,
		nestedListLimit: 3,
		stringLimit: 100,
	} );
	assert.equal( compact.discovery.sourceFileCount, 80 );
	assert.deepEqual( compact.discovery.sourceFilesSample, sourceFiles.slice( 0, 5 ) );
	assert.equal( compact.verification.markerCoverage.markerCount, 70 );
	assert.equal( compact.verification.markerCoverage.markers.length, 5 );
	assert.equal( compact.verification.markerCoverage.markers[ 0 ].dependencies.length, 3 );
	assert.equal( compact.checks.length, 17 );
	assert.equal( compact.checks[ 0 ].evidence.expectedDigest, 'a'.repeat( 64 ) );
	assert.equal( compact.checks[ 0 ].evidence.candidates.length, 3 );
	assert.deepEqual( compact.nextActions, nextActions );
	assert.deepEqual( compact.remainingGates, [ 'production-build' ] );
	assert.equal( compact.compactOutput.enabled, true );
	assert.equal( compact.compactOutput.omittedItems > 0, true );
	assert.equal( JSON.stringify( compact ).length < JSON.stringify( {
		sourceFiles,
		markers,
		checks,
	} ).length / 2, true );

} );

test( 'doctor withholds install mutations until ambiguous package-manager ownership is resolved', async () => {

	for ( const fixture of [
		{ label: 'no lockfile', lockfiles: [] },
		{
			label: 'competing lockfiles with an invalid declaration',
			packageManager: 'npm',
			lockfiles: [ 'pnpm-lock.yaml', 'package-lock.json' ],
		},
	] ) {

		const { project, result } = await inspectPackageManagerProject( fixture );
		try {

			assert.equal( result.project.packageManager, null, fixture.label );
			assert.equal( result.commands.install, null, fixture.label );
			assert.equal( result.commands.argv.install, null, fixture.label );
			const packageManagerCheck = result.checks.find( ( check ) => check.id === 'package-manager' );
			assert.equal( packageManagerCheck.status, 'warn', fixture.label );
			assert.match( packageManagerCheck.summary, /withheld until a package manager is chosen/, fixture.label );

			const choice = result.nextActions.find( ( action ) => action.code === 'choose-package-manager' );
			assert.equal( choice.kind, 'manual', fixture.label );
			assert.equal( choice.argv, null, fixture.label );
			assert.deepEqual( choice.requiresInput, [ 'packageManager' ], fixture.label );
			assert.deepEqual(
				choice.context.allowedPackageManagers,
				[ 'pnpm', 'npm', 'yarn', 'bun' ],
				fixture.label,
			);

			const installActions = result.nextActions.filter( ( action ) =>
				action.code === 'install-plugin-package' || action.code === 'install-runtime-package'
			);
			assert.equal( installActions.length, 2, fixture.label );
			for ( const action of installActions ) {

				assert.equal( action.kind, 'manual', fixture.label );
				assert.equal( action.argv, null, fixture.label );
				assert.deepEqual( action.requiresInput, [ 'packageManager' ], fixture.label );
				assert.equal( action.dependsOn.includes( 'choose-package-manager' ), true, fixture.label );
				assert.deepEqual(
					Object.keys( action.argvByPackageManager ),
					[ 'pnpm', 'npm', 'yarn', 'bun' ],
					fixture.label,
				);

			}
			assert.equal(
				result.nextActions.some( ( action ) =>
					action.kind === 'command'
					&& (
						( [ 'pnpm', 'yarn', 'bun' ].includes( action.argv?.[ 0 ] ) && action.argv?.[ 1 ] === 'add' )
						|| ( action.argv?.[ 0 ] === 'npm' && action.argv?.[ 1 ] === 'install' )
					)
				),
				false,
				fixture.label,
			);
			assertDependencyOrder( result.nextActions );

		} finally {

			await rm( project, { recursive: true, force: true } );

		}

	}

} );

test( 'doctor prefers a valid packageManager declaration over competing lockfiles', async () => {

	const { project, result } = await inspectPackageManagerProject( {
		packageManager: 'yarn@4.9.2',
		lockfiles: [ 'pnpm-lock.yaml', 'package-lock.json' ],
	} );
	try {

		assert.equal( result.project.packageManager, 'yarn' );
		assert.equal( result.project.packageManagerSource, 'package.json#packageManager' );
		assert.equal( result.project.packageManagerField, 'yarn@4.9.2' );
		assert.equal(
			result.checks.find( ( check ) => check.id === 'package-manager' ).status,
			'warn',
		);
		assert.deepEqual( result.commands.argv.install[ 0 ].slice( 0, 2 ), [ 'yarn', 'add' ] );
		assert.equal(
			result.nextActions.some( ( action ) => action.code === 'choose-package-manager' ),
			false,
		);
		const installActions = result.nextActions.filter( ( action ) =>
			action.kind === 'command'
			&& (
				action.code === 'install-plugin-package'
				|| action.code === 'install-runtime-package'
			)
		);
		assert.equal( installActions.length, 2 );
		assert.deepEqual(
			installActions.map( ( action ) => action.code ),
			[ 'install-plugin-package', 'install-runtime-package' ],
		);
		assert.equal( installActions.every( ( action ) => action.argv[ 0 ] === 'yarn' ), true );
		assert.equal(
			new Set( result.nextActions.map( ( action ) => action.code ) ).size,
			result.nextActions.length,
		);
		assertDependencyOrder( result.nextActions );

	} finally {

		await rm( project, { recursive: true, force: true } );

	}

} );

test( 'passing doctor checks omit remediation and nextAction fields', async () => {

	const { project, result } = await inspectPackageManagerProject( {
		lockfiles: [ 'pnpm-lock.yaml' ],
	} );
	try {

		const passing = result.checks.filter( ( check ) => check.status === 'pass' );
		const actionable = result.checks.filter( ( check ) => check.status !== 'pass' );
		assert.equal( passing.length > 0, true );
		assert.equal( actionable.length > 0, true );
		for ( const check of passing ) {

			assert.equal( Object.hasOwn( check, 'remediation' ), false, check.id );
			assert.equal( Object.hasOwn( check, 'nextAction' ), false, check.id );

		}
		for ( const check of actionable ) {

			assert.equal( typeof check.remediation, 'string', check.id );
			assert.equal( check.nextAction, check.remediation, check.id );

		}

	} finally {

		await rm( project, { recursive: true, force: true } );

	}

} );

test( 'doctor warns for altered or unsafe skills without overwriting them', async () => {

	const workspace = await mkdtemp( join( tmpdir(), 'tslp-doctor-skill-integrity-' ) );
	const project = resolve( workspace, 'apps/demo' );
	const skillRoot = resolve( workspace, '.agents/skills/integrate-tsl-precompile' );
	const inspect = () => inspectTslPrecompileProject( {
		root: project,
		sources: [ 'src' ],
		verifyRunner: async () => ( {
			schemaVersion: 1,
			ok: false,
			checkedArtifactFiles: 0,
			markerCoverage: {
				enabled: true,
				total: 0,
				covered: 0,
				missing: [],
				issues: [],
			},
			issues: [ 'artifacts: artifact directory does not exist' ],
		} ),
	} );
	try {

		await mkdir( resolve( workspace, '.git' ), { recursive: true } );
		await writeProjectFile( workspace, 'pnpm-lock.yaml', 'lockfileVersion: 9\n' );
		await writeProjectFile( project, 'package.json', JSON.stringify( {
			name: 'doctor-skill-integrity-fixture',
			private: true,
		} ) );
		await writeProjectFile( project, 'src/main.js', 'export const fixture = true;\n' );
		await cp( CANONICAL_SKILL, skillRoot, { recursive: true } );

		await writeProjectFile( skillRoot, 'LOCAL.md', 'keep this local edit\n' );
		const staleResult = await inspect();
		const staleCheck = staleResult.checks.find( ( check ) => check.id === 'agent-skill' );
		assert.equal( staleCheck.status, 'warn' );
		assert.match( staleCheck.summary, /stale/ );
		assert.equal( staleCheck.evidence.digest, null );
		assert.match( staleCheck.evidence.expectedDigest, /^[a-f0-9]{64}$/ );
		assert.equal( staleCheck.evidence.candidates[ 0 ].status, 'stale' );
		assert.match( staleCheck.evidence.candidates[ 0 ].digest, /^[a-f0-9]{64}$/ );
		assert.notEqual(
			staleCheck.evidence.candidates[ 0 ].digest,
			staleCheck.evidence.expectedDigest,
		);
		const remediation = staleResult.nextActions.find( ( action ) => action.code === 'agent-skill' );
		assert.equal( remediation.kind, 'command' );
		assert.equal( remediation.argv.includes( '--force' ), false );
		assert.equal(
			await readFile( resolve( skillRoot, 'LOCAL.md' ), 'utf8' ),
			'keep this local edit\n',
		);

		if ( process.platform !== 'win32' ) {

			await rm( resolve( skillRoot, 'LOCAL.md' ) );
			const linkedEntry = resolve( skillRoot, 'linked-entry' );
			await symlink( resolve( CANONICAL_SKILL, 'SKILL.md' ), linkedEntry );
			const unsafeResult = await inspect();
			const unsafeCheck = unsafeResult.checks.find( ( check ) => check.id === 'agent-skill' );
			assert.equal( unsafeCheck.status, 'warn' );
			assert.match( unsafeCheck.summary, /unsafe/ );
			assert.equal( unsafeCheck.evidence.candidates[ 0 ].status, 'unsafe' );
			assert.equal( unsafeCheck.evidence.candidates[ 0 ].digest, null );
			assert.match( unsafeCheck.evidence.candidates[ 0 ].issue, /symbolic link/ );
			assert.equal( ( await lstat( linkedEntry ) ).isSymbolicLink(), true );

		}

	} finally {

		await rm( workspace, { recursive: true, force: true } );

	}

} );

test( 'doctor recognizes aliased Vite, renderer, and setup imports without false setup failures', async () => {

	const workspace = await mkdtemp( join( tmpdir(), 'tslp-doctor-aliases-' ) );
	const project = resolve( workspace, 'apps/demo' );
	try {

		await mkdir( resolve( workspace, '.git' ), { recursive: true } );
		await writeProjectFile( workspace, 'pnpm-lock.yaml', 'lockfileVersion: 9\n' );
		await writeProjectFile( project, 'package.json', JSON.stringify( {
			name: 'doctor-fixture',
			private: true,
			type: 'module',
			scripts: {
				dev: 'vite',
				build: 'vite build',
			},
			dependencies: {
				'@tsl-precompile/runtime': '0.1.0-alpha.0',
				three: '0.185.1',
			},
			devDependencies: {
				'vite-plugin-tsl-precompile': '0.1.0-alpha.0',
				vite: '8.0.0',
			},
		} ) );
		await writeProjectFile( project, 'vite.config.js', `
			import precompilePlugin from 'vite-plugin-tsl-precompile';
			export default { plugins: [ precompilePlugin() ] };
		` );
		await writeProjectFile( project, 'src/main.js', `
			import {
				WebGPURenderer as Renderer,
				MeshStandardNodeMaterial,
			} from 'three/webgpu';
			import { setupPrecompile as wirePrecompile } from '@tsl-precompile/runtime/setup';

			const renderer = new Renderer();
			const setup = wirePrecompile( { renderer } );
			await Promise.all( [ renderer.init(), setup.ready ] );

			const material = new MeshStandardNodeMaterial();
			material.precompile( 'doctor-water' );
		` );
		await Promise.all( [
			writeInstalledPackage( project, 'vite-plugin-tsl-precompile', '0.1.0-alpha.0' ),
			writeInstalledPackage( project, '@tsl-precompile/runtime', '0.1.0-alpha.0' ),
			writeInstalledPackage( project, 'three', '0.185.1' ),
			writeInstalledPackage( project, 'vite', '8.0.0' ),
		] );

		const result = await inspectTslPrecompileProject( {
			root: project,
			sources: [ 'src' ],
			autoMark: false,
			verifyRunner: async () => ( {
				schemaVersion: 1,
				ok: true,
				checkedArtifactFiles: 1,
				markerCoverage: {
					enabled: true,
					total: 1,
					covered: 1,
					missing: [],
					issues: [],
				},
				issues: [],
			} ),
		} );

		assert.equal( result.ok, true );
		assert.equal( result.status, 'passed' );
		assert.equal( result.command, 'tsl-precompile-doctor' );
		assert.equal( result.readiness, 'ready-compatibility' );
		assert.equal( result.project.mode, 'compatibility' );
		assert.equal( result.project.packageManager, 'pnpm' );
		assert.deepEqual( result.project.lockfiles, [ '../../pnpm-lock.yaml' ] );
		assert.deepEqual( result.project.viteConfigs, [ 'vite.config.js' ] );
		assert.equal( result.discovery.webgpuRendererConstructions, 1 );
		assert.equal( result.discovery.setupCalls, 1 );
		assert.equal( result.discovery.readyAwaits, 1 );
		assert.equal( result.discovery.authoredMarkers, 1 );
		assert.equal(
			result.checks.find( ( check ) => check.id === 'runtime-setup' )?.status,
			'pass',
		);
		assert.deepEqual(
			result.commands.argv.install,
			[
				[
					'pnpm',
					'add',
					'-D',
					'vite-plugin-tsl-precompile@0.1.0-alpha.0',
				],
				[
					'pnpm',
					'add',
					'@tsl-precompile/runtime@0.1.0-alpha.0',
					'three@0.185.1',
					'--save-exact',
				],
			],
		);
		assert.match(
			result.commands.install,
			/vite-plugin-tsl-precompile@0\.1\.0-alpha\.0/,
		);
		assert.deepEqual(
			result.commands.argv.installSkill,
			[ 'pnpm', 'exec', 'tsl-precompile-install-skill', '--json' ],
		);
		assert.equal( result.commands.argv.recapture, null );
		assert.deepEqual(
			result.commands.templates.recapture,
			[
				'pnpm',
				'exec',
				'tsl-precompile-recapture',
				'--json',
				'--url',
				'<dev-server-url>',
				'--paths',
				'<comma-separated-routes>',
				'--backends',
				'webgpu,webgl',
				'--source',
				'src',
				'--source-root',
				'.',
				'--artifacts',
				'artifacts',
				'--no-auto-mark',
			],
		);
		assert.deepEqual(
			result.remainingGates,
			[
				'route-coverage',
				'topology-coverage',
				'production-build',
				'production-webgpu-preview',
			],
		);
		assert.equal( result.proof.productionWebGPUPreview, 'unverified' );
		assert.match( result.suggestedAgentPrompt, /real renderer route\/state/ );
		assert.match( result.suggestedAgentPrompt, /WebGPURenderer production preview/ );
		assert.match( result.suggestedAgentPrompt, /WebGPU or WebGL2 backend/ );
		assert.equal( result.nextActions.length, 5 );
		assert.deepEqual( result.nextActions[ 0 ], {
			kind: 'command',
			code: 'agent-skill',
			check: 'agent-skill',
			priority: 'warn',
			reason: result.checks.find( ( check ) => check.id === 'agent-skill' ).remediation,
			action: result.checks.find( ( check ) => check.id === 'agent-skill' ).remediation,
			cwd: project,
			argv: [ 'pnpm', 'exec', 'tsl-precompile-install-skill', '--json' ],
			commands: [ [ 'pnpm', 'exec', 'tsl-precompile-install-skill', '--json' ] ],
		} );
		const compatibilityProofActions = result.nextActions.filter( ( action ) =>
			result.remainingGates.includes( action.code )
		);
		assert.deepEqual(
			compatibilityProofActions.map( ( action ) => [ action.code, action.kind ] ),
			[
				[ 'route-coverage', 'manual' ],
				[ 'topology-coverage', 'manual' ],
				[ 'production-build', 'command' ],
				[ 'production-webgpu-preview', 'manual' ],
			],
		);
		assert.deepEqual(
			compatibilityProofActions[ 2 ].dependsOn,
			[ 'route-coverage', 'topology-coverage' ],
		);
		assert.deepEqual(
			compatibilityProofActions[ 3 ].dependsOn,
			[ 'production-build' ],
		);
		assert.match( compatibilityProofActions[ 0 ].action, /real renderer route\/state/ );
		assert.match( compatibilityProofActions[ 0 ].action, /WebGPU or WebGL2 backend/ );
		assert.match( compatibilityProofActions[ 3 ].action, /WebGPURenderer production preview/ );
		assert.match( compatibilityProofActions[ 3 ].action, /WebGPU or WebGL2 backend/ );

		await cp(
			CANONICAL_SKILL,
			resolve( workspace, '.agents/skills/integrate-tsl-precompile' ),
			{ recursive: true },
		);
		const ancestorSkillResult = await inspectTslPrecompileProject( {
			root: project,
			sources: [ 'src' ],
			autoMark: false,
			verifyRunner: async () => result.verification,
		} );
		assert.equal(
			ancestorSkillResult.checks.find( ( check ) => check.id === 'agent-skill' )?.status,
			'pass',
		);
		assert.deepEqual(
			ancestorSkillResult.checks.find( ( check ) => check.id === 'agent-skill' )?.evidence.locations,
			[ '../../.agents/skills/integrate-tsl-precompile/SKILL.md' ],
		);
		const ancestorSkillEvidence = ancestorSkillResult.checks.find(
			( check ) => check.id === 'agent-skill'
		)?.evidence;
		assert.match( ancestorSkillEvidence.digest, /^[a-f0-9]{64}$/ );
		assert.equal( ancestorSkillEvidence.digest, ancestorSkillEvidence.expectedDigest );
		assert.deepEqual( ancestorSkillEvidence.candidates, [ {
			location: '../../.agents/skills/integrate-tsl-precompile/SKILL.md',
			status: 'current',
			digest: ancestorSkillEvidence.digest,
		} ] );
		assert.equal(
			ancestorSkillResult.nextActions.some( ( action ) => action.code === 'agent-skill' ),
			false,
		);
		assert.deepEqual(
			ancestorSkillResult.nextActions.map( ( action ) => action.code ),
			ancestorSkillResult.remainingGates,
		);

		const captureResult = await inspectTslPrecompileProject( {
			root: project,
			sources: [ 'src' ],
			artifacts: 'generated/tsl',
			autoMark: false,
			autoMarkPrefix: 'shader',
			verifyRunner: async () => ( {
				schemaVersion: 1,
				ok: false,
				checkedArtifactFiles: 0,
				markerCoverage: {
					enabled: true,
					total: 1,
					covered: 0,
					missing: [],
					issues: [],
				},
				issues: [ 'generated/tsl: artifact directory does not exist' ],
			} ),
		} );
		const captureVerificationCheck = captureResult.checks.find(
			( check ) => check.id === 'artifact-verification'
		);
		assert.match( captureVerificationCheck.nextAction, /real renderer route\/state/ );
		assert.match( captureVerificationCheck.nextAction, /WebGPU or WebGL2 backend/ );
		assert.deepEqual(
			captureResult.commands.argv.doctor,
			[
				'pnpm',
				'exec',
				'tsl-precompile-doctor',
				'--json',
				'--compact',
				'--source',
				'src',
				'--artifacts',
				'generated/tsl',
				'--no-auto-mark',
				'--auto-mark-prefix',
				'shader',
			],
		);
		assert.match( captureResult.commands.doctor, /--artifacts generated\/tsl/ );
		assert.match( captureResult.commands.doctor, /--no-auto-mark/ );
		assert.match( captureResult.commands.doctor, /--auto-mark-prefix shader/ );

		const captureActions = captureResult.nextActions.filter(
			( action ) => action.check === 'artifact-verification',
		);
		assert.deepEqual(
			captureActions.map( ( action ) => [ action.code, action.kind ] ),
			[
				[ 'dev-server-prerequisite', 'manual' ],
				[ 'artifact-recapture', 'manual' ],
				[ 'artifact-verification', 'command' ],
			],
		);
		assert.equal( captureActions[ 0 ].argv, null );
		assert.deepEqual( captureActions[ 0 ].prerequisiteFor, [ 'artifact-recapture' ] );
		assert.equal( captureActions[ 1 ].argv, null );
		assert.deepEqual( captureActions[ 1 ].dependsOn, [ 'dev-server-prerequisite' ] );
		assert.deepEqual( captureActions[ 1 ].requiresInput, [ 'devServerUrl', 'routesAndStates' ] );
		assert.match( captureActions[ 1 ].action, /real renderer route\/state/ );
		assert.match( captureActions[ 1 ].action, /both WebGPURenderer backends/ );
		assert.match( captureActions[ 1 ].action, /WGSL and GLSL variants/ );
		assert.deepEqual(
			captureActions[ 1 ].commandTemplate,
			captureResult.commands.templates.recapture,
		);
		assert.deepEqual(
			captureActions[ 1 ].commandTemplate.slice( - 9 ),
			[
				'--source',
				'src',
				'--source-root',
				'.',
				'--artifacts',
				'generated/tsl',
				'--no-auto-mark',
				'--auto-mark-prefix',
				'shader',
			],
		);
		assert.deepEqual( captureActions[ 2 ].dependsOn, [ 'artifact-recapture' ] );
		assert.equal(
			captureResult.nextActions.some(
				( action ) => action.kind === 'command' && action.argv?.includes( 'tsl-precompile-recapture' ),
			),
			false,
		);

		await writeProjectFile( project, 'vite.config.js', `
			import precompilePlugin from 'vite-plugin-tsl-precompile';
			export default { plugins: [ precompilePlugin( { slim: 'source' } ) ] };
		` );
		const slimResult = await inspectTslPrecompileProject( {
			root: project,
			sources: [ 'src' ],
			autoMark: false,
			verifyRunner: async () => result.verification,
		} );
		assert.equal( slimResult.project.mode, 'slim-source' );
		assert.equal( slimResult.readiness, 'slim-proof-required' );
		assert.equal( slimResult.ok, false );
		assert.equal( slimResult.proof.slimReadiness, 'unverified' );
		assert.equal( slimResult.remainingGates.includes( 'slim-readiness' ), true );
		const proofActions = slimResult.nextActions.filter( ( action ) =>
			slimResult.remainingGates.includes( action.code )
		);
		assert.deepEqual(
			proofActions.map( ( action ) => [ action.code, action.kind ] ),
			[
				[ 'route-coverage', 'manual' ],
				[ 'topology-coverage', 'manual' ],
				[ 'production-build', 'command' ],
				[ 'production-webgpu-preview', 'manual' ],
				[ 'slim-readiness', 'manual' ],
			],
		);
		assert.deepEqual( proofActions[ 2 ].argv, [ 'pnpm', 'run', 'build' ] );
		assert.deepEqual(
			proofActions[ 2 ].dependsOn,
			[ 'route-coverage', 'topology-coverage' ],
		);
		assert.deepEqual(
			proofActions[ 4 ].dependsOn,
			[ 'production-webgpu-preview' ],
		);
		assert.match( slimResult.suggestedAgentPrompt, /Preserve the established slim mode/ );
		assert.match( slimResult.suggestedAgentPrompt, /real renderer route\/state/ );
		assert.match( slimResult.suggestedAgentPrompt, /WebGPURenderer production preview/ );
		assert.match( slimResult.suggestedAgentPrompt, /WebGPU or WebGL2 backend/ );
		assert.doesNotMatch( slimResult.suggestedAgentPrompt, /integrate .* compatibility mode/ );

		const slimCaptureResult = await inspectTslPrecompileProject( {
			root: project,
			sources: [ 'src' ],
			autoMark: false,
			verifyRunner: async () => ( {
				schemaVersion: 1,
				ok: false,
				checkedArtifactFiles: 0,
				markerCoverage: {
					enabled: true,
					total: 1,
					covered: 0,
					missing: [ 'doctor-water' ],
					issues: [],
				},
				issues: [ 'doctor-water: missing capture' ],
			} ),
		} );
		assert.equal( slimCaptureResult.readiness, 'needs-capture' );
		assert.match( slimCaptureResult.suggestedAgentPrompt, /Preserve the established slim mode/ );
		assert.doesNotMatch( slimCaptureResult.suggestedAgentPrompt, /integrate .* compatibility mode/ );

	} finally {

		await rm( workspace, { recursive: true, force: true } );

	}

} );

test( 'doctor JSON keeps invalid invocations machine-readable and nonzero', () => {

	const run = spawnSync(
		process.execPath,
		[ DOCTOR_CLI, '--json', '--not-an-option' ],
		{ encoding: 'utf8' },
	);
	assert.equal( run.status, 1 );
	assert.equal( run.stderr, '' );
	const report = JSON.parse( run.stdout );
	assert.equal( report.schemaVersion, 1 );
	assert.equal( report.ok, false );
	assert.equal( report.status, 'failed' );
	assert.equal( report.command, 'tsl-precompile-doctor' );
	assert.equal( report.readiness, 'invalid-invocation' );
	assert.equal( report.checks[ 0 ].id, 'invocation' );
	assert.equal( report.checks[ 0 ].code, 'invocation' );
	assert.equal( report.checks[ 0 ].severity, 'error' );
	assert.deepEqual( report.checks[ 0 ].evidence.argv, [ '--json', '--not-an-option' ] );
	assert.match( report.checks[ 0 ].remediation, /--help/ );
	assert.equal( report.checks[ 0 ].nextAction, report.checks[ 0 ].remediation );
	assert.match( report.checks[ 0 ].summary, /Unknown doctor option/ );
	assert.equal( report.nextActions[ 0 ].kind, 'command' );
	assert.equal( report.nextActions[ 0 ].code, 'show-help' );
	assert.equal( report.nextActions[ 0 ].cwd, process.cwd() );
	assert.deepEqual( report.nextActions[ 0 ].argv, [ process.execPath, DOCTOR_CLI, '--help' ] );
	assert.deepEqual( report.nextActions[ 0 ].commands, [ report.nextActions[ 0 ].argv ] );
	const [ command, ...args ] = report.nextActions[ 0 ].argv;
	const followup = spawnSync( command, args, {
		cwd: report.nextActions[ 0 ].cwd,
		encoding: 'utf8',
	} );
	assert.equal( followup.status, 0 );
	assert.match( followup.stdout, /Usage: tsl-precompile-doctor/ );

} );

test( 'doctor --json --compact bounds a large project report at the executable boundary', async () => {

	const project = await mkdtemp( join( tmpdir(), 'tslp-doctor-compact-' ) );
	try {

		await writeProjectFile( project, 'package.json', JSON.stringify( {
			name: 'compact-doctor-fixture',
			private: true,
		} ) );
		await Promise.all( Array.from( { length: 60 }, ( _, index ) =>
			writeProjectFile( project, `src/module-${ index }.js`, `export const value${ index } = ${ index };\n` )
		) );
		const run = spawnSync(
			process.execPath,
			[
				DOCTOR_CLI,
				'--json',
				'--compact',
				'--root',
				project,
				'--source',
				'src',
			],
			{ encoding: 'utf8' },
		);
		assert.equal( run.status, 1 );
		assert.equal( run.stderr, '' );
		const report = JSON.parse( run.stdout );
		assert.equal( report.command, 'tsl-precompile-doctor' );
		assert.equal( report.compactOutput.enabled, true );
		assert.equal( report.discovery.sourceFileCount, 60 );
		assert.equal( report.discovery.sourceFilesSample.length, 10 );
		assert.equal( Object.hasOwn( report.discovery, 'sourceFiles' ), false );
		assert.equal( Array.isArray( report.checks ), true );
		assert.equal( report.checks.length > 10, true );
		assert.equal( Array.isArray( report.nextActions ), true );
		assert.equal( run.stdout.length < 50000, true, `compact report was ${ run.stdout.length } bytes` );

	} finally {

		await rm( project, { recursive: true, force: true } );

	}

} );

test( 'doctor JSON help remains one machine-readable result', () => {

	const run = spawnSync(
		process.execPath,
		[ DOCTOR_CLI, '--json', '--help' ],
		{ encoding: 'utf8' },
	);
	assert.equal( run.status, 0 );
	assert.equal( run.stderr, '' );
	const report = JSON.parse( run.stdout );
	assert.equal( report.schemaVersion, 1 );
	assert.equal( report.ok, true );
	assert.equal( report.status, 'help' );
	assert.equal( report.command, 'tsl-precompile-doctor' );
	assert.deepEqual( report.nextActions, [] );
	assert.match( report.help, /--source/ );
	assert.match( report.help, /--source-root/ );
	assert.match( report.help, /real renderer route\/state coverage/ );
	assert.match( report.help, /WebGPURenderer production preview/ );
	assert.match( report.help, /WebGPU or WebGL2 backend/ );

} );

test( 'doctor human output describes the supported WebGPURenderer production backends', () => {

	const lines = [];
	printDoctorResult( {
		readiness: 'ready-compatibility',
		summary: { pass: 1, warn: 0, fail: 0 },
		checks: [],
		nextActions: [],
		commands: { build: 'pnpm run build' },
	}, { log: ( line ) => lines.push( line ) } );
	const output = lines.join( '\n' );
	assert.match( output, /WebGPURenderer production preview/ );
	assert.match( output, /WebGPU or WebGL2 backend/ );

} );
