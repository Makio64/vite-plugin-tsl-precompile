import { spawnSync } from 'node:child_process';
import { access, lstat, readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import { SLIM_THREE_PACKAGE_VERSION } from '@tsl-precompile/contract/slim-three-policy';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';

import {
	digestAgentSkillTree,
	digestBundledAgentSkill,
} from '../agent-skill-installer.js';
import { collectExpectedMarkerCoverage, resolveSourceFiles } from './verify-support.js';

const traverse = _traverse.default || _traverse;
const require = createRequire( import.meta.url );
const SELF_PACKAGE_VERSION = require( '../../package.json' ).version;
const VERIFY_CLI = fileURLToPath( new URL( './verify.js', import.meta.url ) );
const SOURCE_EXTENSIONS = new Set( [ '.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts', '.cjs', '.cts' ] );
const PARSER_PLUGINS = [ 'jsx', 'typescript', 'decorators-legacy', 'importAttributes', 'deprecatedImportAssert', 'topLevelAwait' ];
const VITE_CONFIG_NAMES = [
	'vite.config.js',
	'vite.config.jsx',
	'vite.config.ts',
	'vite.config.mjs',
	'vite.config.mts',
	'vite.config.cjs',
	'vite.config.cts',
];
const LOCKFILES = [
	{ file: 'pnpm-lock.yaml', manager: 'pnpm' },
	{ file: 'package-lock.json', manager: 'npm' },
	{ file: 'yarn.lock', manager: 'yarn' },
	{ file: 'bun.lock', manager: 'bun' },
	{ file: 'bun.lockb', manager: 'bun' },
];
const PACKAGE_MANAGERS = [ ...new Set( LOCKFILES.map( ( entry ) => entry.manager ) ) ];
const SKILL_LOCATIONS = [
	'.agents/skills/integrate-tsl-precompile/SKILL.md',
	'.codex/skills/integrate-tsl-precompile/SKILL.md',
	'.claude/skills/integrate-tsl-precompile/SKILL.md',
];
const COMPATIBILITY_AGENT_PROMPT = 'Use $integrate-tsl-precompile to start with tsl-precompile-doctor --json --compact, execute every emitted nextAction in dependency order, integrate TSL precompilation in compatibility mode, capture every real renderer route/state and advanced topology on each production WebGPURenderer backend, verify artifacts, and prove the production build plus the WebGPURenderer production preview with the app\'s WebGPU or WebGL2 backend before considering slim mode.';
const ESTABLISHED_SLIM_AGENT_PROMPT = 'Use $integrate-tsl-precompile. Start with tsl-precompile-doctor --json --compact. Preserve the established slim mode in this Vite three.js app; do not reset it to compatibility mode. Complete every emitted nextAction in dependency order, exercise every real renderer route/state and advanced render topology, run source-aware verification, then prove the production build, a compiler-free WebGPURenderer production preview with the app\'s WebGPU or WebGL2 backend, and zero capture/compiler residue.';

export const DOCTOR_HELP = `
Usage: tsl-precompile-doctor [options]

Read-only project audit for humans and coding agents. It checks dependency
versions, Vite wiring, renderer setup, discoverable NodeMaterial markers, and
source-aware artifact verification. Passing this read-only audit still leaves
real renderer route/state coverage, the production build, and the
WebGPURenderer production preview with the app's WebGPU or WebGL2 backend as
separate gates.

Options:
  --json                       Print one machine-readable JSON result.
  --compact                    Bound bulky JSON evidence lists while preserving
                               every check, next action, proof, and remaining gate.
  --root <path>                Project root (default: current directory).
  -s, --source <path>          Application source file or directory. Repeatable.
                               Default: src, then the local HTML/module entry.
  --source-root <path>         Root used for stable marker ownership, resolved
                               from --root (default: --root).
  --artifacts <path>           Artifact directory (default: artifacts).
  --no-auto-mark               Match tslPrecompile({ autoMark: false }).
  --auto-mark-prefix <prefix>  Match the plugin's autoMark prefix (default: auto).
  -h, --help                   Display this help message.
`;

export function parseDoctorArgs( args, cwd = process.cwd() ) {

	const options = {
		root: resolve( cwd ),
		json: false,
		compact: false,
		help: false,
		sources: [],
		sourceRoot: null,
		artifacts: 'artifacts',
		autoMark: true,
		autoMarkPrefix: 'auto',
	};
	for ( let index = 0; index < args.length; index ++ ) {

		const arg = args[ index ];
		if ( arg === '--help' || arg === '-h' ) {

			options.help = true;
			continue;

		}
		if ( arg === '--json' ) {

			options.json = true;
			continue;

		}
		if ( arg === '--compact' ) {

			options.compact = true;
			continue;

		}
		if ( arg === '--no-auto-mark' ) {

			options.autoMark = false;
			continue;

		}
		const parsed = splitOption( arg );
		if ( [ '--root', '--source', '-s', '--source-root', '--artifacts', '--auto-mark-prefix' ].includes( parsed.name ) ) {

			let value = parsed.value;
			if ( value === null ) {

				value = args[ index + 1 ];
				if ( value === undefined || value.startsWith( '-' ) ) throw new Error( `${ parsed.name } requires a value.` );
				index ++;

			}
			if ( value.length === 0 ) throw new Error( `${ parsed.name } requires a value.` );
			if ( parsed.name === '--root' ) options.root = resolve( cwd, value );
			else if ( parsed.name === '--source' || parsed.name === '-s' ) options.sources.push( value );
			else if ( parsed.name === '--source-root' ) options.sourceRoot = value;
			else if ( parsed.name === '--artifacts' ) options.artifacts = value;
			else options.autoMarkPrefix = value;
			continue;

		}
		throw new Error( `Unknown doctor option: ${ arg }` );

	}
	options.sourceRoot = options.sourceRoot === null
		? options.root
		: resolve( options.root, options.sourceRoot );
	return options;

}

export function compactDoctorResult( result, {
	listLimit = 10,
	nestedListLimit = 5,
	stringLimit = 1000,
} = {} ) {

	const metrics = { omittedItems: 0, truncatedStrings: 0 };
	const sample = ( values, limit = listLimit ) => {

		const list = Array.isArray( values ) ? values : [];
		metrics.omittedItems += Math.max( 0, list.length - limit );
		return list.slice( 0, limit ).map( ( value ) =>
			boundCompactEvidence( value, metrics, { nestedListLimit, stringLimit } )
		);

	};
	const discovery = result.discovery || {};
	const {
		sourceFiles: discoverySourceFiles,
		markerScanIssues: discoveryMarkerScanIssues,
		...compactDiscovery
	} = discovery;
	const verification = result.verification || {};
	const markerCoverage = verification.markerCoverage || null;
	const compactVerification = {
		...verification,
		directories: sample( verification.directories ),
		directoryCount: Array.isArray( verification.directories ) ? verification.directories.length : 0,
		issues: sample( verification.issues ),
		issueCount: Array.isArray( verification.issues ) ? verification.issues.length : 0,
		diagnostics: sample( verification.diagnostics ),
		diagnosticCount: Array.isArray( verification.diagnostics ) ? verification.diagnostics.length : 0,
		...( markerCoverage ? {
			markerCoverage: {
				...markerCoverage,
				missing: sample( markerCoverage.missing ),
				missingCount: Array.isArray( markerCoverage.missing ) ? markerCoverage.missing.length : 0,
				markers: sample( markerCoverage.markers ),
				markerCount: Array.isArray( markerCoverage.markers ) ? markerCoverage.markers.length : 0,
				issues: sample( markerCoverage.issues ),
				issueCount: Array.isArray( markerCoverage.issues ) ? markerCoverage.issues.length : 0,
			},
		} : {} ),
	};
	return {
		...result,
		discovery: {
			...compactDiscovery,
			sourceFileCount: Array.isArray( discoverySourceFiles ) ? discoverySourceFiles.length : 0,
			sourceFilesSample: sample( discoverySourceFiles ),
			markerScanIssueCount: Array.isArray( discoveryMarkerScanIssues ) ? discoveryMarkerScanIssues.length : 0,
			markerScanIssues: sample( discoveryMarkerScanIssues ),
		},
		verification: compactVerification,
		checks: ( result.checks || [] ).map( ( check ) => ( {
			...check,
			evidence: boundCompactEvidence(
				check.evidence,
				metrics,
				{ nestedListLimit, stringLimit },
			),
		} ) ),
		compactOutput: {
			enabled: true,
			listLimit,
			nestedListLimit,
			stringLimit,
			omittedItems: metrics.omittedItems,
			truncatedStrings: metrics.truncatedStrings,
		},
	};

}

export async function inspectTslPrecompileProject( options = {} ) {

	const root = resolve( options.root || process.cwd() );
	const sourceRoot = options.sourceRoot ? resolve( root, options.sourceRoot ) : root;
	const artifacts = options.artifacts || 'artifacts';
	const autoMark = options.autoMark !== false;
	const autoMarkPrefix = options.autoMarkPrefix || 'auto';
	const checks = [];
	const packageJson = await readJsonIfPresent( resolve( root, 'package.json' ) );
	const sourcePaths = options.sources?.length > 0
		? [ ...options.sources ]
		: await discoverDefaultSourcePaths( root );
	const packageManager = await detectPackageManager( root, packageJson );
	const commandSet = createCommandSet( {
		root,
		manager: packageManager.manager,
		sourcePaths,
		sourceRoot,
		artifacts,
		autoMark,
		autoMarkPrefix,
	} );

	addCheck( checks, {
		id: 'node-version',
		status: supportsNodeVersion( process.versions.node ) ? 'pass' : 'fail',
		summary: supportsNodeVersion( process.versions.node )
			? `Node ${ process.versions.node } satisfies >=24.0.0.`
			: `Node ${ process.versions.node } does not satisfy >=24.0.0.`,
		nextAction: 'Use Node 24 or newer before installing or building.',
	} );

	addCheck( checks, {
		id: 'package-json',
		status: packageJson ? 'pass' : 'fail',
		summary: packageJson ? 'Found package.json.' : 'package.json is missing.',
		nextAction: 'Run the doctor from the Vite application root.',
	} );

	const packageManagerCheck = describePackageManager( packageManager );
	addCheck( checks, {
		id: 'package-manager',
		...packageManagerCheck,
		evidence: {
			source: packageManager.source,
			packageManagerField: packageManager.packageManagerField,
			packageManagerFieldValid: packageManager.packageManagerFieldValid,
			lockfiles: packageManager.lockfiles,
			lockfileManagers: packageManager.lockfileManagers,
		},
	} );

	const dependencyState = await inspectDependencies( root, packageJson );
	addDependencyChecks( checks, dependencyState, commandSet );

	const viteConfigs = await inspectViteConfigs( root );
	addCheck( checks, {
		id: 'vite-plugin',
		status: viteConfigs.active.length > 0 ? 'pass' : 'fail',
		summary: viteConfigs.active.length > 0
			? `Found tslPrecompile() in ${ viteConfigs.active.join( ', ' ) }; detected mode: ${ viteConfigs.mode }.`
			: viteConfigs.files.length > 0
				? `Found ${ viteConfigs.files.join( ', ' ) }, but no tslPrecompile() invocation.`
				: 'No Vite config was found.',
		evidence: {
			configs: viteConfigs.files,
			activeConfigs: viteConfigs.active,
			mode: viteConfigs.mode,
		},
		nextAction: 'Import vite-plugin-tsl-precompile and add tslPrecompile() to the existing Vite plugins array in compatibility mode.',
	} );

	let sourceFiles = [];
	let sourceReadError = null;
	try {

		sourceFiles = await resolveSourceFiles( sourcePaths, root );

	} catch ( error ) {

		sourceReadError = error;

	}
	addCheck( checks, {
		id: 'source-files',
		status: sourceReadError || sourceFiles.length === 0 ? 'fail' : 'pass',
		summary: sourceReadError
			? `Could not resolve application sources: ${ sourceReadError.message || sourceReadError }`
			: sourceFiles.length === 0
				? 'The source selection matched zero JavaScript/TypeScript files.'
				: `Inspecting ${ sourceFiles.length } application source file${ sourceFiles.length === 1 ? '' : 's' }.`,
		evidence: {
			sourcePaths,
			sourceRoot,
			sourceFiles: sourceFiles.map( ( file ) => displayPath( root, file ) ),
		},
		nextAction: 'Repeat --source for the application JavaScript/TypeScript roots.',
	} );

	const discovery = await discoverSourceIntegration( sourceFiles, root, {
		autoMark,
		autoMarkPrefix,
		sourcePaths,
		sourceRoot,
	} );
	addCheck( checks, {
		id: 'webgpu-renderer',
		status: discovery.webgpuRendererConstructions > 0 ? 'pass' : 'fail',
		summary: discovery.webgpuRendererConstructions > 0
			? `Found ${ discovery.webgpuRendererConstructions } WebGPURenderer construction site${ discovery.webgpuRendererConstructions === 1 ? '' : 's' }.`
			: 'No direct WebGPURenderer construction was found in the selected sources.',
		nextAction: 'Confirm this is a Vite + three.js WebGPURenderer app using the WebGPU or WebGL2 backend and include the source file that constructs its live renderer.',
	} );
	addCheck( checks, {
		id: 'runtime-setup',
		status: discovery.setupCalls > 0 && discovery.readyAwaits > 0 ? 'pass' : 'fail',
		summary: discovery.setupCalls === 0
			? 'No setupPrecompile({ renderer }) call was found.'
			: discovery.readyAwaits === 0
				? `Found ${ discovery.setupCalls } setupPrecompile() call${ discovery.setupCalls === 1 ? '' : 's' }, but no awaited setup.ready.`
				: `Found ${ discovery.setupCalls } setupPrecompile() call${ discovery.setupCalls === 1 ? '' : 's' } and an awaited ready gate.`,
		nextAction: 'Register the same live renderer once with setupPrecompile({ renderer }); await renderer.init() and setup.ready.',
	} );
	addCheck( checks, {
		id: 'material-markers',
		status: discovery.markerScanIssues.length > 0 || discovery.totalMarkers === 0 ? 'fail' : 'pass',
		summary: discovery.markerScanIssues.length > 0
			? `Marker discovery failed: ${ discovery.markerScanIssues[ 0 ] }`
			: discovery.totalMarkers === 0
				? 'No authored or automatically discoverable NodeMaterial marker was found.'
				: `Discovered ${ discovery.totalMarkers } expected material marker${ discovery.totalMarkers === 1 ? '' : 's' } (${ discovery.automaticMarkers } automatic, ${ discovery.authoredMarkers } authored).`,
		evidence: {
			total: discovery.totalMarkers,
			automatic: discovery.automaticMarkers,
			authored: discovery.authoredMarkers,
			issues: discovery.markerScanIssues,
		},
		nextAction: autoMark
			? 'Keep direct new *NodeMaterial() constructors discoverable, or add stable literal .precompile(name) markers after graph assignment.'
			: 'Add a unique literal .precompile(name) marker for every reachable NodeMaterial.',
	} );

	const verifyRunner = options.verifyRunner || executeVerification;
	let verification;
	try {

		verification = await verifyRunner( {
			root,
			sourcePaths,
			sourceRoot,
			artifacts,
			autoMark,
			autoMarkPrefix,
		} );

	} catch ( error ) {

		verification = {
			schemaVersion: 1,
			ok: false,
			checkedArtifactFiles: 0,
			markerCoverage: { enabled: true, total: discovery.totalMarkers, covered: 0, missing: [] },
			issues: [ error.message || String( error ) ],
		};

	}
	addCheck( checks, {
		id: 'artifact-verification',
		status: verification.ok ? 'pass' : 'fail',
		summary: verification.ok
			? `Verified ${ verification.checkedArtifactFiles } artifact file${ verification.checkedArtifactFiles === 1 ? '' : 's' } and ${ verification.markerCoverage?.covered || 0 }/${ verification.markerCoverage?.total || 0 } expected markers.`
			: `Artifact verification is not ready: ${ verification.issues?.[ 0 ] || 'unknown verification failure' }`,
		evidence: {
			checkedArtifactFiles: verification.checkedArtifactFiles || 0,
			markerCoverage: verification.markerCoverage || null,
			issues: verification.issues || [],
		},
		nextAction: commandSet.verify
			? `Start the dev server, exercise every real renderer route/state using WebGPURenderer with the app's WebGPU or WebGL2 backend, then run: ${ commandSet.verify }`
			: 'Choose the application package manager, start its dev script, exercise every real renderer route/state using WebGPURenderer with the app\'s WebGPU or WebGL2 backend, then run its source-aware tsl-precompile-verify command.',
	} );

	const installedSkills = await inspectInstalledSkills( root );
	const agentSkillCheck = describeInstalledSkills( installedSkills );
	addCheck( checks, {
		id: 'agent-skill',
		...agentSkillCheck,
		evidence: installedSkills,
		nextAction: commandSet.installSkill
			|| 'Choose the application package manager, then run its project-local tsl-precompile-install-skill --json command.',
	} );

	const scripts = packageJson?.scripts || {};
	addCheck( checks, {
		id: 'project-scripts',
		status: typeof scripts.dev === 'string' && typeof scripts.build === 'string' ? 'pass' : 'warn',
		summary: typeof scripts.dev === 'string' && typeof scripts.build === 'string'
			? 'Found project dev and build scripts.'
			: 'A dev or build package script is missing.',
		nextAction: 'Expose the application dev server and production build as package scripts so agents can run deterministic gates.',
	} );

	const artifactsIgnore = await artifactsAppearIgnored( root, artifacts );
	addCheck( checks, {
		id: 'artifact-tracking',
		status: artifactsIgnore ? 'warn' : 'pass',
		summary: artifactsIgnore
			? `${ artifacts } appears to be ignored by .gitignore even though generated artifacts are build inputs.`
			: `${ artifacts } is not excluded by a simple .gitignore rule.`,
		nextAction: `Ensure ${ artifacts } and manifest.json can be committed; generated capture artifacts must not be fabricated or hand-edited.`,
	} );

	const summary = summarizeChecks( checks );
	const failIds = new Set( checks.filter( ( check ) => check.status === 'fail' ).map( ( check ) => check.id ) );
	const readiness = failIds.has( 'artifact-verification' ) && [ ...failIds ].every( ( id ) => id === 'artifact-verification' )
		? 'needs-capture'
		: summary.fail > 0
			? 'needs-setup'
			: viteConfigs.mode === 'compatibility'
				? 'ready-compatibility'
				: 'slim-proof-required';
	const installCommands = packageManagerCommandDescriptors( commandSet, 'install', {
		grouped: true,
		codes: [ 'install-plugin-package', 'install-runtime-package' ],
		actions: [
			'Install vite-plugin-tsl-precompile as a development dependency.',
			`Install @tsl-precompile/runtime and pin three exactly at ${ SLIM_THREE_PACKAGE_VERSION }.`,
		],
	} );
	const safeCommandsByCheck = {
		'plugin-package': installCommands,
		'runtime-package': installCommands,
		'package-version-pair': installCommands,
		'three-version': installCommands,
		'three-types-version': packageManagerCommandDescriptors( commandSet, 'installTypes', {
			code: 'install-three-types',
			action: `Install @types/three exactly at ${ SLIM_THREE_PACKAGE_VERSION } as a development dependency.`,
		} ),
		'artifact-verification': packageManagerCommandDescriptors( commandSet, 'verify', {
			code: 'artifact-verification',
			dependsOn: [ 'artifact-recapture' ],
		} ),
		'agent-skill': packageManagerCommandDescriptors( commandSet, 'installSkill', {
			code: 'agent-skill',
		} ),
	};
	const packageManagerChoiceRequired = packageManager.manager === null;
	const manualActionsByCheck = {
		...( packageManagerChoiceRequired ? {
			'package-manager': [ {
				code: 'choose-package-manager',
				action: 'Choose the package manager that owns this application before resolving any package-manager-specific action.',
				requiresInput: [ 'packageManager' ],
				context: {
					allowedPackageManagers: PACKAGE_MANAGERS,
					packageManagerField: packageManager.packageManagerField,
					lockfiles: packageManager.lockfiles,
				},
			} ],
		} : {} ),
		'artifact-verification': [
			{
				code: 'dev-server-prerequisite',
				action: commandSet.dev
					? `Start the application's existing dev command (${ commandSet.dev }) and keep it running. Record the actual local URL before recapture.`
					: 'After choosing the package manager, start the application dev script and keep it running. Record the actual local URL before recapture.',
				...( packageManagerChoiceRequired ? {
					dependsOn: [ 'choose-package-manager' ],
					requiresInput: [ 'packageManager' ],
					argvByPackageManager: packageManagerArgvChoices( commandSet, 'dev' ),
				} : {} ),
				prerequisiteFor: [ 'artifact-recapture' ],
			},
			{
				code: 'artifact-recapture',
				action: commandSet.recapture
					? `Exercise every required real renderer route/state automatically on both WebGPURenderer backends so capture retains WGSL and GLSL variants. Replace every placeholder before running this template: ${ commandSet.recapture }`
					: 'Exercise every required real renderer route/state automatically on both WebGPURenderer backends so capture retains WGSL and GLSL variants. After choosing the package manager, select its recapture argv and replace every placeholder before running it.',
				dependsOn: [ 'dev-server-prerequisite' ],
				prerequisiteFor: [ 'artifact-verification' ],
				requiresInput: [
					...( packageManagerChoiceRequired ? [ 'packageManager' ] : [] ),
					'devServerUrl',
					'routesAndStates',
				],
				commandTemplate: commandSet.templates.recapture,
				...( packageManagerChoiceRequired ? {
					argvByPackageManager: packageManagerArgvChoices( commandSet, 'recaptureTemplate' ),
				} : {} ),
			},
		],
	};
	const nextActions = uniqueActions( [
		...createNextActions( checks, safeCommandsByCheck, root, manualActionsByCheck ),
		...createProofGateActions( {
			root,
			readiness,
			commandSet,
			packageManagerChoiceRequired,
		} ),
	] );
	const ok = summary.fail === 0 && readiness === 'ready-compatibility';
	const establishedSlimMode = viteConfigs.mode === 'slim-source' || viteConfigs.mode === 'slim-prebuilt';

	return {
		schemaVersion: 1,
		ok,
		status: ok ? 'passed' : 'attention-required',
		command: 'tsl-precompile-doctor',
		readiness,
		project: {
			root,
			sourceRoot,
			packageManager: packageManager.manager,
			packageManagerSource: packageManager.source,
			packageManagerField: packageManager.packageManagerField,
			lockfiles: packageManager.lockfiles,
			sourcePaths,
			artifacts,
			viteConfigs: viteConfigs.files,
			mode: viteConfigs.mode,
		},
		versions: {
			node: process.versions.node,
			plugin: dependencyState.plugin.installed?.version || null,
			runtime: dependencyState.runtime.installed?.version || null,
			three: dependencyState.three.installed?.version || null,
			vite: dependencyState.vite.installed?.version || null,
			expectedThree: SLIM_THREE_PACKAGE_VERSION,
			artifactToolchain: ARTIFACT_TOOLCHAIN_VERSION,
		},
		summary,
		discovery,
		verification,
		checks,
		commands: commandSet,
		nextActions,
		proof: {
			routeCoverage: 'unverified',
			topologyCoverage: 'unverified',
			productionBuild: 'unverified',
			productionWebGPUPreview: 'unverified',
			slimReadiness: viteConfigs.mode === 'compatibility' ? 'not-applicable' : 'unverified',
		},
		remainingGates: [
			'route-coverage',
			'topology-coverage',
			'production-build',
			'production-webgpu-preview',
			...( viteConfigs.mode === 'compatibility' ? [] : [ 'slim-readiness' ] ),
		],
		suggestedAgentPrompt: establishedSlimMode
			? ESTABLISHED_SLIM_AGENT_PROMPT
			: COMPATIBILITY_AGENT_PROMPT,
	};

}

export function printDoctorResult( result, output = console ) {

	output.log( `[tsl-precompile] doctor ${ result.readiness } (${ result.summary.pass } pass, ${ result.summary.warn } warn, ${ result.summary.fail } fail)` );
	for ( const check of result.checks ) output.log( `${ check.status.toUpperCase() } ${ check.id }: ${ check.summary }` );
	if ( result.nextActions.length > 0 ) {

		output.log( 'Next actions:' );
		for ( const action of result.nextActions ) output.log( `  - [${ action.priority }] ${ action.action }` );

	}
	if ( result.commands.build ) {

		output.log( `Then run: ${ result.commands.build } and smoke-test the WebGPURenderer production preview with the app's WebGPU or WebGL2 backend.` );

	} else {

		output.log( 'Then choose the application package manager, run its build script, and smoke-test the WebGPURenderer production preview with the app\'s WebGPU or WebGL2 backend.' );

	}

}

async function inspectDependencies( root, packageJson ) {

	const declared = ( name ) => dependencyDeclaration( packageJson, name );
	const plugin = await installedPackage( root, 'vite-plugin-tsl-precompile' );
	const runtime = await installedPackage( root, '@tsl-precompile/runtime' );
	const three = await installedPackage( root, 'three' );
	const typesThree = await installedPackage( root, '@types/three' );
	const vite = await installedPackage( root, 'vite' );
	return {
		plugin: { declared: declared( 'vite-plugin-tsl-precompile' ), installed: plugin },
		runtime: { declared: declared( '@tsl-precompile/runtime' ), installed: runtime },
		three: { declared: declared( 'three' ), installed: three },
		typesThree: { declared: declared( '@types/three' ), installed: typesThree },
		vite: { declared: declared( 'vite' ), installed: vite },
		typescriptProject: await pathExists( resolve( root, 'tsconfig.json' ) ),
	};

}

function addDependencyChecks( checks, state, commands ) {

	const installRemediation = commands.install
		|| 'Choose the application package manager, then install matching vite-plugin-tsl-precompile and @tsl-precompile/runtime releases with exact three.js.';
	const installTypesRemediation = commands.installTypes
		|| `Choose the application package manager, then install @types/three exactly at ${ SLIM_THREE_PACKAGE_VERSION } as a development dependency.`;
	const pluginPlacement = state.plugin.declared?.section;
	addCheck( checks, {
		id: 'plugin-package',
		status: ! state.plugin.installed ? 'fail' : pluginPlacement === 'devDependencies' ? 'pass' : 'warn',
		summary: ! state.plugin.installed
			? 'vite-plugin-tsl-precompile is not installed.'
			: pluginPlacement === 'devDependencies'
				? `vite-plugin-tsl-precompile ${ state.plugin.installed.version } is installed as a development dependency.`
				: `vite-plugin-tsl-precompile ${ state.plugin.installed.version } is installed, but not in devDependencies.`,
		nextAction: installRemediation,
	} );
	const runtimePlacement = state.runtime.declared?.section;
	addCheck( checks, {
		id: 'runtime-package',
		status: ! state.runtime.installed ? 'fail' : runtimePlacement === 'dependencies' ? 'pass' : 'warn',
		summary: ! state.runtime.installed
			? '@tsl-precompile/runtime is not installed.'
			: runtimePlacement === 'dependencies'
				? `@tsl-precompile/runtime ${ state.runtime.installed.version } is installed as a runtime dependency.`
				: `@tsl-precompile/runtime ${ state.runtime.installed.version } is installed, but not in dependencies.`,
		nextAction: installRemediation,
	} );
	addCheck( checks, {
		id: 'package-version-pair',
		status: state.plugin.installed && state.runtime.installed && state.plugin.installed.version === state.runtime.installed.version ? 'pass' : 'fail',
		summary: state.plugin.installed && state.runtime.installed && state.plugin.installed.version === state.runtime.installed.version
			? `Plugin and runtime versions match at ${ state.plugin.installed.version }.`
			: `Plugin/runtime versions do not match (${ state.plugin.installed?.version || 'missing' } vs ${ state.runtime.installed?.version || 'missing' }).`,
		nextAction: 'Install matching releases of vite-plugin-tsl-precompile and @tsl-precompile/runtime.',
	} );
	const exactThreeDeclared = state.three.declared?.spec === SLIM_THREE_PACKAGE_VERSION;
	const exactThreeInstalled = state.three.installed?.version === SLIM_THREE_PACKAGE_VERSION;
	addCheck( checks, {
		id: 'three-version',
		status: exactThreeDeclared && exactThreeInstalled ? 'pass' : 'fail',
		summary: exactThreeDeclared && exactThreeInstalled
			? `three is declared and resolved exactly at ${ SLIM_THREE_PACKAGE_VERSION }.`
			: `three must be declared and resolved exactly at ${ SLIM_THREE_PACKAGE_VERSION } (declared ${ state.three.declared?.spec || 'missing' }, resolved ${ state.three.installed?.version || 'missing' }).`,
		nextAction: installRemediation,
	} );
	const viteVersion = state.vite.installed?.version;
	addCheck( checks, {
		id: 'vite-version',
		status: viteVersion && supportsViteVersion( viteVersion ) ? 'pass' : 'fail',
		summary: viteVersion && supportsViteVersion( viteVersion )
			? `Vite ${ viteVersion } satisfies >=6.4.3 <9.`
			: `Vite ${ viteVersion || 'missing' } does not satisfy >=6.4.3 <9.`,
		nextAction: 'Install a Vite release in the supported >=6.4.3 <9 range.',
	} );
	if ( state.typescriptProject ) {

		const exactTypesDeclared = state.typesThree.declared?.spec === SLIM_THREE_PACKAGE_VERSION;
		const exactTypesInstalled = state.typesThree.installed?.version === SLIM_THREE_PACKAGE_VERSION;
		addCheck( checks, {
			id: 'three-types-version',
			status: exactTypesDeclared && exactTypesInstalled ? 'pass' : 'fail',
			summary: exactTypesDeclared && exactTypesInstalled
				? `@types/three is declared and resolved exactly at ${ SLIM_THREE_PACKAGE_VERSION }.`
				: `This TypeScript project must declare and resolve @types/three exactly at ${ SLIM_THREE_PACKAGE_VERSION }.`,
			nextAction: installTypesRemediation,
		} );

	}

}

async function inspectViteConfigs( root ) {

	const files = [];
	const active = [];
	const modes = new Set();
	for ( const name of VITE_CONFIG_NAMES ) {

		const path = resolve( root, name );
		if ( ! await pathExists( path ) ) continue;
		files.push( name );
		const source = await readFile( path, 'utf8' );
		const inspection = inspectViteConfigSource( source, path );
		if ( inspection.active ) {

			active.push( name );
			for ( const mode of inspection.modes ) modes.add( mode );

		}

	}
	return {
		files,
		active,
		mode: modes.size === 0 ? 'unknown' : modes.size === 1 ? [ ...modes ][ 0 ] : 'mixed',
	};

}

function inspectViteConfigSource( source, filename ) {

	const directBindings = new Set();
	const namespaceBindings = new Set();
	const modes = new Set();
	let ast;
	try {

		ast = parse( source, {
			sourceType: 'unambiguous',
			sourceFilename: filename,
			plugins: PARSER_PLUGINS,
			errorRecovery: false,
		} );

	} catch {

		// Vite/esbuild can accept syntax outside this audit parser. Keep a
		// conservative fallback for the canonical documented binding, but do
		// not guess that an unrelated aliased call is the plugin.
		const active = source.includes( 'vite-plugin-tsl-precompile' )
			&& /(?:^|[^\w$])tslPrecompile\s*\(/m.test( source );
		if ( active ) modes.add( fallbackSlimMode( source ) );
		return { active, modes };

	}

	traverse( ast, {
		ImportDeclaration( path ) {

			if ( path.node.source.value !== 'vite-plugin-tsl-precompile' ) return;
			for ( const specifier of path.node.specifiers ) {

				if ( t.isImportDefaultSpecifier( specifier ) ) directBindings.add( specifier.local.name );
				else if ( t.isImportNamespaceSpecifier( specifier ) ) namespaceBindings.add( specifier.local.name );

			}

		},
		VariableDeclarator( path ) {

			if ( ! t.isIdentifier( path.node.id ) ) return;
			const required = requiredPackage( path.node.init ) || requiredDefaultPackage( path.node.init );
			if ( required === 'vite-plugin-tsl-precompile' ) directBindings.add( path.node.id.name );

		},
	} );
	traverse( ast, {
		CallExpression( path ) {

			if ( ! isBoundCall( path.node.callee, directBindings, namespaceBindings, 'default' ) ) return;
			modes.add( slimModeForPluginCall( path.node ) );

		},
	} );
	return { active: modes.size > 0, modes };

}

function slimModeForPluginCall( call ) {

	const options = call.arguments[ 0 ];
	if ( options === undefined ) return 'compatibility';
	if ( ! t.isObjectExpression( options ) ) return 'dynamic';
	for ( const property of options.properties ) {

		if ( ! t.isObjectProperty( property ) || property.computed ) continue;
		const key = importName( property.key );
		if ( key !== 'slim' ) continue;
		if ( t.isStringLiteral( property.value, { value: 'source' } ) ) return 'slim-source';
		if ( t.isBooleanLiteral( property.value, { value: true } ) ) return 'slim-prebuilt';
		if ( t.isBooleanLiteral( property.value, { value: false } ) ) return 'compatibility';
		return 'dynamic';

	}
	return 'compatibility';

}

function fallbackSlimMode( source ) {

	if ( /slim\s*:\s*['"]source['"]/m.test( source ) ) return 'slim-source';
	if ( /slim\s*:\s*true/m.test( source ) ) return 'slim-prebuilt';
	return 'compatibility';

}

async function discoverSourceIntegration( sourceFiles, root, options ) {

	let webgpuRendererConstructions = 0;
	let setupCalls = 0;
	let readyAwaits = 0;
	let captureAuxCalls = 0;
	for ( const file of sourceFiles ) {

		const source = await readFile( file, 'utf8' );
		const integration = inspectApplicationSource( source, file );
		webgpuRendererConstructions += integration.webgpuRendererConstructions;
		setupCalls += integration.setupCalls;
		readyAwaits += integration.readyAwaits;
		captureAuxCalls += integration.captureAuxCalls;

	}
	let coverage = null;
	let markerScanIssues = [];
	try {

		coverage = await collectExpectedMarkerCoverage( {
			cwd: root,
			sourcePaths: options.sourcePaths,
			sourceRoot: options.sourceRoot,
			autoMark: options.autoMark,
			autoMarkPrefix: options.autoMarkPrefix,
			capturedNames: [],
		} );
		markerScanIssues = coverage.issues || [];

	} catch ( error ) {

		markerScanIssues = [ error.message || String( error ) ];

	}
	const markers = coverage?.markers || [];
	return {
		sourceFiles: sourceFiles.map( ( file ) => displayPath( root, file ) ),
		webgpuRendererConstructions,
		setupCalls,
		readyAwaits,
		captureAuxCalls,
		totalMarkers: markers.length,
		automaticMarkers: markers.filter( ( marker ) => marker.autoMarked ).length,
		authoredMarkers: markers.filter( ( marker ) => ! marker.autoMarked ).length,
		markerScanIssues,
	};

}

function inspectApplicationSource( source, filename ) {

	const rendererBindings = new Set();
	const rendererNamespaces = new Set();
	const setupBindings = new Set();
	const setupNamespaces = new Set();
	const setupResults = new Set();
	const readyBindings = new Set();
	let ast;
	try {

		ast = parse( source, {
			sourceType: 'unambiguous',
			sourceFilename: filename,
			plugins: PARSER_PLUGINS,
			errorRecovery: false,
		} );

	} catch {

		return {
			webgpuRendererConstructions: countMatches( source, /\bnew\s+WebGPURenderer\s*\(/g ),
			setupCalls: countMatches( source, /\bsetupPrecompile\s*\(/g ),
			readyAwaits: countMatches( source, /\bawait\s+[\w$.]+\.ready\b/g ),
			captureAuxCalls: countMatches( source, /\.captureAux\s*\(/g ),
		};

	}

	traverse( ast, {
		ImportDeclaration( path ) {

			const sourceValue = path.node.source.value;
			if ( sourceValue === 'three/webgpu' ) {

				for ( const specifier of path.node.specifiers ) {

					if ( t.isImportSpecifier( specifier ) && importName( specifier.imported ) === 'WebGPURenderer' ) {

						rendererBindings.add( specifier.local.name );

					} else if ( t.isImportNamespaceSpecifier( specifier ) ) {

						rendererNamespaces.add( specifier.local.name );

					}

				}

			}
			if ( sourceValue === '@tsl-precompile/runtime/setup' ) {

				for ( const specifier of path.node.specifiers ) {

					if ( t.isImportSpecifier( specifier ) && importName( specifier.imported ) === 'setupPrecompile' ) {

						setupBindings.add( specifier.local.name );

					} else if ( t.isImportNamespaceSpecifier( specifier ) ) {

						setupNamespaces.add( specifier.local.name );

					}

				}

			}

		},
		VariableDeclarator( path ) {

			const required = requiredPackage( path.node.init );
			if ( required === 'three/webgpu' ) {

				collectRequiredBindings( path.node.id, 'WebGPURenderer', rendererBindings, rendererNamespaces );

			} else if ( required === '@tsl-precompile/runtime/setup' ) {

				collectRequiredBindings( path.node.id, 'setupPrecompile', setupBindings, setupNamespaces );

			}

		},
	} );

	let webgpuRendererConstructions = 0;
	let setupCalls = 0;
	let captureAuxCalls = 0;
	traverse( ast, {
		NewExpression( path ) {

			if ( isBoundCall( path.node.callee, rendererBindings, rendererNamespaces, 'WebGPURenderer' ) ) {

				webgpuRendererConstructions ++;

			}

		},
		CallExpression( path ) {

			const isSetup = isBoundCall( path.node.callee, setupBindings, setupNamespaces, 'setupPrecompile' );
			if ( isSetup ) {

				setupCalls ++;
				const parent = path.parentPath;
				if ( parent?.isVariableDeclarator() ) {

					if ( t.isIdentifier( parent.node.id ) ) setupResults.add( parent.node.id.name );
					else if ( t.isObjectPattern( parent.node.id ) ) {

						for ( const property of parent.node.id.properties ) {

							if ( ! t.isObjectProperty( property ) ) continue;
							if ( importName( property.key ) === 'ready' && t.isIdentifier( property.value ) ) {

								readyBindings.add( property.value.name );

							}

						}

					}

				} else if ( parent?.isAssignmentExpression() && t.isIdentifier( parent.node.left ) ) {

					setupResults.add( parent.node.left.name );

				}

			}
			if ( t.isMemberExpression( path.node.callee ) && memberName( path.node.callee ) === 'captureAux' ) captureAuxCalls ++;

		},
	} );

	let readyAwaits = 0;
	traverse( ast, {
		AwaitExpression( path ) {

			if ( containsReadyGate(
				path.node.argument,
				setupResults,
				readyBindings,
				setupBindings,
				setupNamespaces,
			) ) readyAwaits ++;

		},
	} );

	return {
		webgpuRendererConstructions,
		setupCalls,
		readyAwaits,
		captureAuxCalls,
	};

}

function containsReadyGate( node, setupResults, readyBindings, setupBindings, setupNamespaces ) {

	if ( ! node || typeof node !== 'object' ) return false;
	if ( t.isIdentifier( node ) && readyBindings.has( node.name ) ) return true;
	if ( t.isMemberExpression( node ) && memberName( node ) === 'ready' ) {

		const owner = node.object;
		if ( t.isIdentifier( owner ) && setupResults.has( owner.name ) ) return true;
		if ( t.isCallExpression( owner ) && isBoundCall( owner.callee, setupBindings, setupNamespaces, 'setupPrecompile' ) ) return true;

	}
	for ( const key of t.VISITOR_KEYS[ node.type ] || [] ) {

		const child = node[ key ];
		if ( Array.isArray( child ) ) {

			if ( child.some( ( entry ) => containsReadyGate( entry, setupResults, readyBindings, setupBindings, setupNamespaces ) ) ) return true;

		} else if ( containsReadyGate( child, setupResults, readyBindings, setupBindings, setupNamespaces ) ) {

			return true;

		}

	}
	return false;

}

function collectRequiredBindings( id, exportedName, directBindings, namespaceBindings ) {

	if ( t.isIdentifier( id ) ) {

		namespaceBindings.add( id.name );
		return;

	}
	if ( ! t.isObjectPattern( id ) ) return;
	for ( const property of id.properties ) {

		if ( ! t.isObjectProperty( property ) || importName( property.key ) !== exportedName ) continue;
		if ( t.isIdentifier( property.value ) ) directBindings.add( property.value.name );

	}

}

function importName( node ) {

	if ( t.isIdentifier( node ) ) return node.name;
	if ( t.isStringLiteral( node ) ) return node.value;
	return null;

}

function memberName( node ) {

	if ( ! t.isMemberExpression( node ) ) return null;
	if ( node.computed ) return t.isStringLiteral( node.property ) ? node.property.value : null;
	return t.isIdentifier( node.property ) ? node.property.name : null;

}

function isBoundCall( callee, directBindings, namespaceBindings, namespaceMember ) {

	if ( t.isIdentifier( callee ) ) return directBindings.has( callee.name );
	if ( ! t.isMemberExpression( callee ) || memberName( callee ) !== namespaceMember ) return false;
	return t.isIdentifier( callee.object ) && namespaceBindings.has( callee.object.name );

}

function requiredPackage( node ) {

	if ( ! t.isCallExpression( node ) || ! t.isIdentifier( node.callee, { name: 'require' } ) ) return null;
	const argument = node.arguments[ 0 ];
	return t.isStringLiteral( argument ) ? argument.value : null;

}

function requiredDefaultPackage( node ) {

	if ( ! t.isMemberExpression( node ) || memberName( node ) !== 'default' ) return null;
	return requiredPackage( node.object );

}

function executeVerification( {
	root,
	sourcePaths,
	sourceRoot,
	artifacts,
	autoMark,
	autoMarkPrefix,
} ) {

	const args = [
		VERIFY_CLI,
		'--json',
		'--source-root',
		sourceRoot,
		...sourcePaths.flatMap( ( source ) => [ '--source', source ] ),
		...( autoMark ? [] : [ '--no-auto-mark' ] ),
		...( autoMarkPrefix === 'auto' ? [] : [ '--auto-mark-prefix', autoMarkPrefix ] ),
		artifacts,
	];
	const result = spawnSync( process.execPath, args, {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
	} );
	if ( result.error ) throw result.error;
	let parsed;
	try {

		parsed = JSON.parse( result.stdout );

	} catch ( error ) {

		throw new Error( `tsl-precompile-verify did not return JSON: ${ result.stderr || error.message }` );

	}
	return parsed;

}

async function discoverDefaultSourcePaths( root ) {

	if ( await isDirectory( resolve( root, 'src' ) ) ) return [ 'src' ];
	const candidates = [];
	const htmlPath = resolve( root, 'index.html' );
	if ( await pathExists( htmlPath ) ) {

		const html = await readFile( htmlPath, 'utf8' );
		for ( const match of html.matchAll( /<script\b[^>]*\bsrc\s*=\s*["']([^"'?#]+)["'][^>]*>/gi ) ) {

			const candidate = match[ 1 ].replace( /^\.?\//, '' );
			if ( SOURCE_EXTENSIONS.has( extname( candidate ).toLowerCase() ) && await pathExists( resolve( root, candidate ) ) ) candidates.push( candidate );

		}

	}
	if ( candidates.length > 0 ) return [ ...new Set( candidates ) ].sort();
	const entries = await readdir( root, { withFileTypes: true } );
	for ( const entry of entries ) {

		if ( entry.isFile() && /^(?:main|app|index)\.[cm]?[jt]sx?$/.test( entry.name ) ) candidates.push( entry.name );

	}
	return candidates.length > 0 ? candidates.sort() : [ '.' ];

}

async function detectPackageManager( root, packageJson ) {

	const projectRoot = resolve( root );
	const packageManagerField = packageJson?.packageManager ?? null;
	const declaredManager = parsePackageManagerField( packageManagerField );
	let directory = projectRoot;
	for ( ; ; ) {

		const found = [];
		for ( const candidate of LOCKFILES ) {

			const path = resolve( directory, candidate.file );
			if ( await pathExists( path ) ) found.push( {
				...candidate,
				display: relative( projectRoot, path ).replaceAll( '\\', '/' ) || candidate.file,
			} );

		}
		if ( found.length > 0 ) {

			const lockfileManagers = [ ...new Set( found.map( ( entry ) => entry.manager ) ) ];
			return {
				manager: declaredManager || ( lockfileManagers.length === 1 ? lockfileManagers[ 0 ] : null ),
				source: declaredManager ? 'package.json#packageManager' : lockfileManagers.length === 1 ? 'lockfile' : null,
				packageManagerField,
				packageManagerFieldValid: declaredManager !== null,
				lockfiles: found.map( ( entry ) => entry.display ),
				lockfileManagers,
			};

		}
		// A nested workspace package inherits the nearest repository lockfile.
		// Do not walk past the repository boundary and accidentally select an
		// unrelated lockfile elsewhere on the machine.
		if ( await pathExists( resolve( directory, '.git' ) ) ) break;
		const parent = dirname( directory );
		if ( parent === directory ) break;
		directory = parent;

	}
	return {
		manager: declaredManager,
		source: declaredManager ? 'package.json#packageManager' : null,
		packageManagerField,
		packageManagerFieldValid: declaredManager !== null,
		lockfiles: [],
		lockfileManagers: [],
	};

}

function parsePackageManagerField( value ) {

	if ( typeof value !== 'string' ) return null;
	const match = /^(pnpm|npm|yarn|bun)@\d+\.\d+\.\d+(?:[+-][^\s]+)?$/.exec( value.trim() );
	return match?.[ 1 ] || null;

}

function describePackageManager( packageManager ) {

	const {
		manager,
		source,
		packageManagerField,
		packageManagerFieldValid,
		lockfiles,
		lockfileManagers,
	} = packageManager;
	if ( manager === null ) {

		return {
			status: 'warn',
			summary: lockfiles.length === 0
				? packageManagerField === null
					? 'No package-manager lockfile or package.json#packageManager declaration was found; install commands are withheld until a package manager is chosen.'
					: `package.json#packageManager (${ String( packageManagerField ) }) is invalid and no lockfile was found; install commands are withheld until a package manager is chosen.`
				: `Multiple package managers own lockfiles (${ lockfiles.join( ', ' ) }) and package.json#packageManager does not resolve the conflict; install commands are withheld until a package manager is chosen.`,
			nextAction: 'Choose the package manager that owns the application, then keep one matching lockfile and a valid package.json#packageManager declaration.',
		};

	}
	if ( source === 'package.json#packageManager' ) {

		const matchingLockfile = lockfileManagers.includes( manager );
		const clean = lockfiles.length === 1 && matchingLockfile;
		return {
			status: clean ? 'pass' : 'warn',
			summary: clean
				? `Detected ${ manager } from package.json#packageManager (${ packageManagerField }) with ${ lockfiles[ 0 ] }.`
				: lockfiles.length === 0
					? `Selected ${ manager } from package.json#packageManager (${ packageManagerField }); no lockfile was found.`
					: `Selected ${ manager } from package.json#packageManager (${ packageManagerField }); reconcile competing or mismatched lockfiles (${ lockfiles.join( ', ' ) }).`,
			nextAction: lockfiles.length === 0
				? `Generate and commit the ${ manager } lockfile so it owns dependency resolution.`
				: `Keep the ${ manager } lockfile that owns the application and remove competing or mismatched lockfiles.`,
		};

	}
	if ( packageManagerField !== null && ! packageManagerFieldValid ) {

		return {
			status: 'warn',
			summary: `Detected ${ manager } from ${ lockfiles.join( ', ' ) }, but package.json#packageManager (${ String( packageManagerField ) }) is invalid.`,
			nextAction: `Set package.json#packageManager to a valid ${ manager }@<version> declaration.`,
		};

	}
	return {
		status: lockfiles.length === 1 ? 'pass' : 'warn',
		summary: lockfiles.length === 1
			? `Detected ${ manager } from ${ lockfiles[ 0 ] }.`
			: `Detected ${ manager } from ${ lockfiles.join( ', ' ) }, but multiple lockfiles exist for that package manager.`,
		nextAction: `Keep one ${ manager } lockfile as the application dependency owner.`,
	};

}

async function inspectInstalledSkills( root ) {

	let expectedDigest = null;
	let bundledIssue = null;
	try {

		expectedDigest = await digestBundledAgentSkill();

	} catch ( error ) {

		bundledIssue = error?.message || String( error );

	}
	const candidates = [];
	let directory = root;
	while ( true ) {

		for ( const location of SKILL_LOCATIONS ) {

			const skillFile = resolve( directory, location );
			const displayedLocation = relative( root, skillFile ).replaceAll( '\\', '/' ) || location;
			let skillFileStat;
			try {

				skillFileStat = await lstatIfPresent( skillFile );

			} catch ( error ) {

				candidates.push( {
					location: displayedLocation,
					status: 'unsafe',
					digest: null,
					issue: error?.message || String( error ),
				} );
				continue;

			}
			if ( ! skillFileStat ) continue;
			if ( ! skillFileStat.isFile() ) {

				candidates.push( {
					location: displayedLocation,
					status: 'unsafe',
					digest: null,
					issue: 'The discovered SKILL.md is not a regular file.',
				} );
				continue;

			}
			const skillRoot = dirname( skillFile );
			try {

				const digest = await digestAgentSkillTree( skillRoot );
				candidates.push( {
					location: displayedLocation,
					status: expectedDigest === null
						? 'unsafe'
						: digest === expectedDigest
							? 'current'
							: 'stale',
					digest,
				} );

			} catch ( error ) {

				candidates.push( {
					location: displayedLocation,
					status: 'unsafe',
					digest: null,
					issue: error?.message || String( error ),
				} );

			}

		}
		if ( await pathExists( resolve( directory, '.git' ) ) ) break;
		const parent = dirname( directory );
		if ( parent === directory ) break;
		directory = parent;

	}
	const locations = candidates.map( ( candidate ) => candidate.location );
	const currentLocations = candidates
		.filter( ( candidate ) => candidate.status === 'current' )
		.map( ( candidate ) => candidate.location );
	const allCurrent = candidates.length > 0
		&& expectedDigest !== null
		&& currentLocations.length === candidates.length;
	return {
		expectedDigest,
		digest: allCurrent ? expectedDigest : null,
		locations,
		currentLocations,
		candidates,
		...( bundledIssue ? { bundledIssue } : {} ),
	};

}

function describeInstalledSkills( inspection ) {

	if ( inspection.bundledIssue ) return {
		status: 'warn',
		summary: `The packaged integration skill could not be validated safely: ${ inspection.bundledIssue }`,
	};
	if ( inspection.candidates.length === 0 ) return {
		status: 'warn',
		summary: 'The official integration skill is not installed in this project.',
	};
	const nonCurrent = inspection.candidates.filter( ( candidate ) => candidate.status !== 'current' );
	if ( nonCurrent.length === 0 ) return {
		status: 'pass',
		summary: `Found the current official integration skill at ${ inspection.locations.join( ', ' ) }.`,
	};
	const statuses = [ ...new Set( nonCurrent.map( ( candidate ) => candidate.status ) ) ];
	return {
		status: 'warn',
		summary: `Found an integration skill at ${ inspection.locations.join( ', ' ) }, but ${ nonCurrent.length } skill tree${ nonCurrent.length === 1 ? '' : 's' } failed bundled-integrity validation (${ statuses.join( ', ' ) }).`,
	};

}

async function lstatIfPresent( path ) {

	try {

		return await lstat( path );

	} catch ( error ) {

		if ( error?.code === 'ENOENT' ) return null;
		throw error;

	}

}

function createCommandSet( {
	root,
	manager,
	sourcePaths,
	sourceRoot,
	artifacts,
	autoMark,
	autoMarkPrefix,
} ) {

	const sourceRootArgument = relativeCommandPath( root, sourceRoot );
	const variants = Object.fromEntries( PACKAGE_MANAGERS.map( ( candidate ) => [
		candidate,
		createCommandSetForManager( {
			manager: candidate,
			sourcePaths,
			sourceRootArgument,
			artifacts,
			autoMark,
			autoMarkPrefix,
		} ),
	] ) );
	if ( manager !== null ) return variants[ manager ];
	return {
		install: null,
		installTypes: null,
		installSkill: null,
		doctor: null,
		recapture: null,
		verify: null,
		dev: null,
		build: null,
		argv: {
			install: null,
			installTypes: null,
			installSkill: null,
			doctor: null,
			recapture: null,
			verify: null,
			dev: null,
			build: null,
		},
		templates: {
			recapture: null,
		},
		argvByPackageManager: Object.fromEntries( Object.entries( variants ).map( ( [ candidate, commands ] ) => [
			candidate,
			{
				...commands.argv,
				recaptureTemplate: commands.templates.recapture,
			},
		] ) ),
	};

}

function createCommandSetForManager( {
	manager,
	sourcePaths,
	sourceRootArgument,
	artifacts,
	autoMark,
	autoMarkPrefix,
} ) {

	const pluginSpecifier = `vite-plugin-tsl-precompile@${ SELF_PACKAGE_VERSION }`;
	const runtimeSpecifier = `@tsl-precompile/runtime@${ SELF_PACKAGE_VERSION }`;
	const exec = manager === 'pnpm'
		? 'pnpm exec'
		: manager === 'yarn'
			? 'yarn exec'
			: manager === 'bun'
				? 'bunx --bun'
				: 'npx --no-install';
	const run = manager === 'yarn' ? 'yarn' : `${ manager } run`;
	const execArgv = manager === 'pnpm'
		? [ 'pnpm', 'exec' ]
		: manager === 'yarn'
			? [ 'yarn', 'exec' ]
			: manager === 'bun'
				? [ 'bunx', '--bun' ]
				: [ 'npx', '--no-install' ];
	const runArgv = ( script ) => [ manager, 'run', script ];
	const sourceArgs = sourcePaths.map( ( source ) => `--source ${ shellQuote( source ) }` ).join( ' ' );
	const sourceArgv = sourcePaths.flatMap( ( source ) => [ '--source', source ] );
	const doctorOptions = [
		'--json',
		'--compact',
		sourceArgs,
		sourceRootArgument === '.' ? '' : `--source-root ${ shellQuote( sourceRootArgument ) }`,
		artifacts === 'artifacts' ? '' : `--artifacts ${ shellQuote( artifacts ) }`,
		autoMark ? '' : '--no-auto-mark',
		autoMarkPrefix === 'auto' ? '' : `--auto-mark-prefix ${ shellQuote( autoMarkPrefix ) }`,
	].filter( Boolean ).join( ' ' );
	const doctorArgv = [
		...execArgv,
		'tsl-precompile-doctor',
		'--json',
		'--compact',
		...sourceArgv,
		...( sourceRootArgument === '.' ? [] : [ '--source-root', sourceRootArgument ] ),
		...( artifacts === 'artifacts' ? [] : [ '--artifacts', artifacts ] ),
		...( autoMark ? [] : [ '--no-auto-mark' ] ),
		...( autoMarkPrefix === 'auto' ? [] : [ '--auto-mark-prefix', autoMarkPrefix ] ),
	];
	const verifyOptions = [
		'--json',
		sourceArgs,
		`--source-root ${ shellQuote( sourceRootArgument ) }`,
		autoMark ? '' : '--no-auto-mark',
		autoMarkPrefix === 'auto' ? '' : `--auto-mark-prefix ${ shellQuote( autoMarkPrefix ) }`,
		shellQuote( artifacts ),
	].filter( Boolean ).join( ' ' );
	const installArgv = manager === 'pnpm'
		? [
				[ 'pnpm', 'add', '-D', pluginSpecifier ],
				[ 'pnpm', 'add', runtimeSpecifier, `three@${ SLIM_THREE_PACKAGE_VERSION }`, '--save-exact' ],
			]
			: manager === 'yarn'
				? [
					[ 'yarn', 'add', '--dev', pluginSpecifier ],
					[ 'yarn', 'add', '--exact', runtimeSpecifier, `three@${ SLIM_THREE_PACKAGE_VERSION }` ],
				]
				: manager === 'bun'
					? [
						[ 'bun', 'add', '--dev', pluginSpecifier ],
						[ 'bun', 'add', '--exact', runtimeSpecifier, `three@${ SLIM_THREE_PACKAGE_VERSION }` ],
					]
					: [
						[ 'npm', 'install', '--save-dev', pluginSpecifier ],
						[ 'npm', 'install', '--save-exact', runtimeSpecifier, `three@${ SLIM_THREE_PACKAGE_VERSION }` ],
					];
	const installTypesArgv = manager === 'pnpm'
		? [ 'pnpm', 'add', '-D', `@types/three@${ SLIM_THREE_PACKAGE_VERSION }`, '--save-exact' ]
		: manager === 'yarn'
			? [ 'yarn', 'add', '--dev', '--exact', `@types/three@${ SLIM_THREE_PACKAGE_VERSION }` ]
			: manager === 'bun'
				? [ 'bun', 'add', '--dev', '--exact', `@types/three@${ SLIM_THREE_PACKAGE_VERSION }` ]
				: [ 'npm', 'install', '--save-dev', '--save-exact', `@types/three@${ SLIM_THREE_PACKAGE_VERSION }` ];
	const recaptureTemplateArgv = [
		...execArgv,
		'tsl-precompile-recapture',
		'--json',
		'--url',
		'<dev-server-url>',
		'--paths',
		'<comma-separated-routes>',
		'--backends',
		'webgpu,webgl',
		...sourcePaths.flatMap( ( source ) => [ '--source', source ] ),
		'--source-root',
		sourceRootArgument,
		'--artifacts',
		artifacts,
		...( autoMark ? [] : [ '--no-auto-mark' ] ),
		...( autoMarkPrefix === 'auto' ? [] : [ '--auto-mark-prefix', autoMarkPrefix ] ),
	];
	const verifyArgv = [
		...execArgv,
		'tsl-precompile-verify',
		'--json',
		...sourceArgv,
		'--source-root',
		sourceRootArgument,
		...( autoMark ? [] : [ '--no-auto-mark' ] ),
		...( autoMarkPrefix === 'auto' ? [] : [ '--auto-mark-prefix', autoMarkPrefix ] ),
		artifacts,
	];
	return {
		install: manager === 'pnpm'
			? `pnpm add -D ${ pluginSpecifier } && pnpm add ${ runtimeSpecifier } three@${ SLIM_THREE_PACKAGE_VERSION } --save-exact`
			: manager === 'yarn'
				? `yarn add --dev ${ pluginSpecifier } && yarn add --exact ${ runtimeSpecifier } three@${ SLIM_THREE_PACKAGE_VERSION }`
				: manager === 'bun'
					? `bun add --dev ${ pluginSpecifier } && bun add --exact ${ runtimeSpecifier } three@${ SLIM_THREE_PACKAGE_VERSION }`
					: `npm install --save-dev ${ pluginSpecifier } && npm install --save-exact ${ runtimeSpecifier } three@${ SLIM_THREE_PACKAGE_VERSION }`,
		installTypes: manager === 'pnpm'
			? `pnpm add -D @types/three@${ SLIM_THREE_PACKAGE_VERSION } --save-exact`
			: manager === 'yarn'
				? `yarn add --dev --exact @types/three@${ SLIM_THREE_PACKAGE_VERSION }`
				: manager === 'bun'
					? `bun add --dev --exact @types/three@${ SLIM_THREE_PACKAGE_VERSION }`
				: `npm install --save-dev --save-exact @types/three@${ SLIM_THREE_PACKAGE_VERSION }`,
		installSkill: `${ exec } tsl-precompile-install-skill --json`,
		doctor: `${ exec } tsl-precompile-doctor ${ doctorOptions }`,
		recapture: [
			`${ exec } tsl-precompile-recapture --json --url <dev-server-url> --paths <comma-separated-routes> --backends webgpu,webgl`,
			sourceArgs,
			`--source-root ${ shellQuote( sourceRootArgument ) }`,
			`--artifacts ${ shellQuote( artifacts ) }`,
			autoMark ? '' : '--no-auto-mark',
			autoMarkPrefix === 'auto' ? '' : `--auto-mark-prefix ${ shellQuote( autoMarkPrefix ) }`,
		].filter( Boolean ).join( ' ' ),
		verify: `${ exec } tsl-precompile-verify ${ verifyOptions }`,
		dev: `${ run } dev`,
		build: `${ run } build`,
		argv: {
			install: installArgv,
			installTypes: installTypesArgv,
			installSkill: [ ...execArgv, 'tsl-precompile-install-skill', '--json' ],
			doctor: doctorArgv,
			recapture: null,
			verify: verifyArgv,
			dev: runArgv( 'dev' ),
			build: runArgv( 'build' ),
		},
		templates: {
			recapture: recaptureTemplateArgv,
		},
	};

}

function packageManagerCommandDescriptors( commandSet, key, {
	grouped = false,
	code = null,
	codes = [],
	action = null,
	actions = [],
	dependsOn = [],
} = {} ) {

	const selected = commandSet.argv[ key ];
	if ( selected !== null ) {

		if ( grouped ) return selected.map( ( argv, index ) => ( {
			argv,
			code: codes[ index ] || `${ key }-${ index + 1 }`,
			...( actions[ index ] ? { action: actions[ index ] } : {} ),
			...( dependsOn.length > 0 ? { dependsOn } : {} ),
		} ) );
		return [ {
			argv: selected,
			...( code ? { code } : {} ),
			...( action ? { action } : {} ),
			...( dependsOn.length > 0 ? { dependsOn } : {} ),
		} ];

	}
	if ( ! commandSet.argvByPackageManager ) return [];
	if ( grouped ) {

		const commandCount = Math.max( ...Object.values( commandSet.argvByPackageManager )
			.map( ( commands ) => commands[ key ]?.length || 0 ) );
		return Array.from( { length: commandCount }, ( _, index ) => ( {
			code: codes[ index ] || `${ key }-${ index + 1 }`,
			...( actions[ index ] ? { action: actions[ index ] } : {} ),
			argvByPackageManager: packageManagerArgvChoices( commandSet, key, index ),
			requiresInput: [ 'packageManager' ],
			dependsOn: [ 'choose-package-manager', ...dependsOn ],
		} ) );

	}
	return [ {
		...( code ? { code } : {} ),
		...( action ? { action } : {} ),
		argvByPackageManager: packageManagerArgvChoices( commandSet, key ),
		requiresInput: [ 'packageManager' ],
		dependsOn: [ 'choose-package-manager', ...dependsOn ],
	} ];

}

function packageManagerArgvChoices( commandSet, key, index = null ) {

	return Object.fromEntries( Object.entries( commandSet.argvByPackageManager || {} )
		.map( ( [ manager, commands ] ) => {

			const argv = index === null ? commands[ key ] : commands[ key ]?.[ index ];
			return [ manager, Array.isArray( argv ) ? [ ...argv ] : null ];

		} )
		.filter( ( [ , argv ] ) => argv !== null ) );

}

async function artifactsAppearIgnored( root, artifacts ) {

	const gitignore = resolve( root, '.gitignore' );
	if ( ! await pathExists( gitignore ) ) return false;
	const normalized = artifacts.replaceAll( '\\', '/' ).replace( /^\.?\//, '' ).replace( /\/$/, '' );
	const source = await readFile( gitignore, 'utf8' );
	let ignored = false;
	for ( const rawLine of source.split( /\r?\n/ ) ) {

		const line = rawLine.trim();
		if ( ! line || line.startsWith( '#' ) ) continue;
		const negated = line.startsWith( '!' );
		const pattern = ( negated ? line.slice( 1 ) : line ).replace( /^\//, '' ).replace( /\/$/, '' ).replace( /^\*\*\//, '' );
		if ( pattern === normalized ) ignored = ! negated;

	}
	return ignored;

}

function addCheck( checks, check ) {

	const remediation = check.status === 'pass' ? null : check.nextAction;
	checks.push( {
		id: check.id,
		code: check.id,
		status: check.status,
		severity: check.status === 'fail' ? 'error' : check.status === 'warn' ? 'warning' : 'info',
		summary: check.summary,
		message: check.summary,
		evidence: check.evidence ?? null,
		...( remediation ? {
			remediation,
			nextAction: remediation,
		} : {} ),
	} );

}

function summarizeChecks( checks ) {

	return checks.reduce( ( summary, check ) => {

		summary[ check.status ] ++;
		return summary;

	}, { pass: 0, warn: 0, fail: 0 } );

}

function uniqueActions( actions ) {

	const seen = new Set();
	const unique = actions.filter( ( action ) => {

		const identity = action.kind === 'command'
			? JSON.stringify( [ action.cwd, action.argv ] )
			: action.action;
		if ( seen.has( identity ) ) return false;
		seen.add( identity );
		return true;

	} ).sort( ( a, b ) => priorityRank( a.priority ) - priorityRank( b.priority ) );
	const actionsByCode = new Map();
	for ( const action of unique ) {

		const matches = actionsByCode.get( action.code ) || [];
		matches.push( action );
		actionsByCode.set( action.code, matches );

	}
	const ordered = [];
	const visited = new Set();
	const visiting = new Set();
	const visit = ( action ) => {

		if ( visited.has( action ) || visiting.has( action ) ) return;
		visiting.add( action );
		for ( const dependency of action.dependsOn || [] ) {

			for ( const prerequisite of actionsByCode.get( dependency ) || [] ) visit( prerequisite );

		}
		visiting.delete( action );
		visited.add( action );
		ordered.push( action );

	};
	for ( const action of unique ) visit( action );
	return ordered;

}

function createNextActions( checks, safeCommandsByCheck, root, manualActionsByCheck = {} ) {

	const actions = [];
	for ( const check of checks ) {

		if ( check.status === 'pass' || ! check.nextAction ) continue;
		const manualActions = manualActionsByCheck[ check.id ] || [];
		for ( const manualAction of manualActions ) actions.push( {
			kind: 'manual',
			code: manualAction.code || check.id,
			check: check.id,
			priority: check.status,
			reason: check.nextAction,
			action: manualAction.action || check.nextAction,
			cwd: root,
			argv: null,
			...( manualAction.dependsOn ? { dependsOn: [ ...manualAction.dependsOn ] } : {} ),
			...( manualAction.prerequisiteFor ? { prerequisiteFor: [ ...manualAction.prerequisiteFor ] } : {} ),
			...( manualAction.requiresInput ? { requiresInput: [ ...manualAction.requiresInput ] } : {} ),
			...( manualAction.commandTemplate ? { commandTemplate: [ ...manualAction.commandTemplate ] } : {} ),
			...( manualAction.argvByPackageManager ? {
				argvByPackageManager: cloneArgvChoices( manualAction.argvByPackageManager ),
			} : {} ),
			...( manualAction.context ? { context: structuredClone( manualAction.context ) } : {} ),
		} );
		const commands = safeCommandsByCheck[ check.id ];
		if ( Array.isArray( commands ) && commands.length > 0 ) {

			for ( const command of commands ) {

				const descriptor = Array.isArray( command ) ? { argv: command } : command;
				if ( descriptor.argvByPackageManager ) {

					actions.push( {
						kind: 'manual',
						code: descriptor.code || check.id,
						check: check.id,
						priority: check.status,
						reason: check.nextAction,
						action: descriptor.action || check.nextAction,
						cwd: root,
						argv: null,
						argvByPackageManager: cloneArgvChoices( descriptor.argvByPackageManager ),
						requiresInput: [ ...( descriptor.requiresInput || [ 'packageManager' ] ) ],
						...( descriptor.dependsOn ? { dependsOn: [ ...descriptor.dependsOn ] } : {} ),
					} );
					continue;

				}
				const argv = descriptor.argv;
				actions.push( {
					kind: 'command',
					code: descriptor.code || check.id,
					check: check.id,
					priority: check.status,
					reason: check.nextAction,
					action: descriptor.action || check.nextAction,
					cwd: root,
					argv: [ ...argv ],
					// Additive schema-v1 compatibility for clients that consumed
					// the earlier grouped command field.
					commands: [ [ ...argv ] ],
					...( descriptor.dependsOn ? { dependsOn: [ ...descriptor.dependsOn ] } : {} ),
				} );

			}

		} else if ( manualActions.length === 0 ) {

			actions.push( {
				kind: 'manual',
				code: check.id,
				check: check.id,
				priority: check.status,
				reason: check.nextAction,
				action: check.nextAction,
				cwd: root,
				argv: null,
			} );

		}

	}
	return uniqueActions( actions );

}

function cloneArgvChoices( choices ) {

	return Object.fromEntries( Object.entries( choices ).map( ( [ manager, argv ] ) => [
		manager,
		[ ...argv ],
	] ) );

}

function createProofGateActions( {
	root,
	readiness,
	commandSet,
	packageManagerChoiceRequired = false,
} ) {

	const compatibilityReady = readiness === 'ready-compatibility';
	const slimProofRequired = readiness === 'slim-proof-required';
	if ( ! compatibilityReady && ! slimProofRequired ) return [];
	const reason = slimProofRequired
		? 'Established slim mode still requires production evidence that the read-only doctor cannot infer.'
		: 'Compatibility-ready setup still requires production evidence that the read-only doctor cannot infer.';
	const actions = [
		{
			kind: 'manual',
			code: 'route-coverage',
			check: 'route-coverage',
			priority: 'warn',
			reason,
			action: 'Enumerate every real renderer route/state that reaches WebGPURenderer through its WebGPU or WebGL2 backend, then exercise each one during capture and replay.',
			cwd: root,
			argv: null,
			requiresInput: [ 'routesAndStates' ],
			prerequisiteFor: [ 'production-build' ],
		},
		{
			kind: 'manual',
			code: 'topology-coverage',
			check: 'topology-coverage',
			priority: 'warn',
			reason,
			action: 'Enumerate and exercise advanced render topologies used by the app, including environment/PMREM, shadows, post-processing, render targets, reflectors, MRT, and compute where applicable.',
			cwd: root,
			argv: null,
			requiresInput: [ 'advancedRenderTopologies' ],
			prerequisiteFor: [ 'production-build' ],
		},
		commandSet.argv.build ? {
			kind: 'command',
			code: 'production-build',
			check: 'production-build',
			priority: 'warn',
			reason,
			action: `Run the existing production build: ${ commandSet.build }`,
			cwd: root,
			argv: [ ...commandSet.argv.build ],
			commands: [ [ ...commandSet.argv.build ] ],
			dependsOn: [ 'route-coverage', 'topology-coverage' ],
		} : {
			kind: 'manual',
			code: 'production-build',
			check: 'production-build',
			priority: 'warn',
			reason,
			action: 'After choosing the package manager, run the application production build.',
			cwd: root,
			argv: null,
			argvByPackageManager: packageManagerArgvChoices( commandSet, 'build' ),
			dependsOn: [
				...( packageManagerChoiceRequired ? [ 'choose-package-manager' ] : [] ),
				'route-coverage',
				'topology-coverage',
			],
			requiresInput: [ 'packageManager' ],
		},
		{
			kind: 'manual',
			code: 'production-webgpu-preview',
			check: 'production-webgpu-preview',
			priority: 'warn',
			reason,
			action: 'Serve the WebGPURenderer production preview with the app\'s WebGPU or WebGL2 backend, open every required real renderer route/state, and require nonblank rendered pixels with no page, console, or renderer/backend errors.',
			cwd: root,
			argv: null,
			dependsOn: [ 'production-build' ],
			requiresInput: [ 'previewUrl', 'routesAndStates' ],
		},
	];
	if ( slimProofRequired ) actions.push( {
			kind: 'manual',
			code: 'slim-readiness',
			check: 'slim-readiness',
			priority: 'warn',
			reason,
			action: 'Prove the WebGPURenderer production preview is compiler-free for the exercised WebGPU or WebGL2 backend: zero capture requests, zero runtime compiler residue, hydrated precompiled pipelines, and successful advanced-topology receipts.',
			cwd: root,
			argv: null,
			dependsOn: [ 'production-webgpu-preview' ],
		} );
	return actions;

}

function priorityRank( priority ) {

	return priority === 'fail' ? 0 : 1;

}

function boundCompactEvidence( value, metrics, {
	nestedListLimit,
	stringLimit,
} ) {

	if ( typeof value === 'string' ) {

		if ( value.length <= stringLimit ) return value;
		metrics.truncatedStrings ++;
		return `${ value.slice( 0, stringLimit ) }\u2026`;

	}
	if ( Array.isArray( value ) ) {

		metrics.omittedItems += Math.max( 0, value.length - nestedListLimit );
		return value.slice( 0, nestedListLimit ).map( ( entry ) =>
			boundCompactEvidence( entry, metrics, { nestedListLimit, stringLimit } )
		);

	}
	if ( value && typeof value === 'object' ) {

		return Object.fromEntries( Object.entries( value ).map( ( [ key, entry ] ) => [
			key,
			boundCompactEvidence( entry, metrics, { nestedListLimit, stringLimit } ),
		] ) );

	}
	return value;

}

function dependencyDeclaration( packageJson, name ) {

	for ( const section of [ 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies' ] ) {

		const spec = packageJson?.[ section ]?.[ name ];
		if ( typeof spec === 'string' ) return { section, spec };

	}
	return null;

}

async function installedPackage( root, name ) {

	return readJsonIfPresent( resolve( root, 'node_modules', ...name.split( '/' ), 'package.json' ) );

}

function supportsNodeVersion( version ) {

	const parsed = parseVersion( version );
	return parsed !== null && parsed.major >= 24;

}

function supportsViteVersion( version ) {

	const parsed = parseVersion( version );
	if ( parsed === null || parsed.major >= 9 ) return false;
	if ( parsed.major > 6 ) return true;
	return parsed.major === 6 && ( parsed.minor > 4 || parsed.minor === 4 && parsed.patch >= 3 );

}

function parseVersion( version ) {

	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec( String( version ) );
	if ( ! match ) return null;
	return {
		major: Number( match[ 1 ] ),
		minor: Number( match[ 2 ] ),
		patch: Number( match[ 3 ] ),
	};

}

function countMatches( source, pattern ) {

	return [ ...source.matchAll( pattern ) ].length;

}

function shellQuote( value ) {

	const string = String( value );
	return /^[A-Za-z0-9_./:@-]+$/.test( string )
		? string
		: `'${ string.replaceAll( "'", "'\\''" ) }'`;

}

async function readJsonIfPresent( path ) {

	try {

		return JSON.parse( await readFile( path, 'utf8' ) );

	} catch ( error ) {

		if ( error?.code === 'ENOENT' ) return null;
		throw error;

	}

}

async function pathExists( path ) {

	try {

		await access( path );
		return true;

	} catch {

		return false;

	}

}

async function isDirectory( path ) {

	try {

		return ( await stat( path ) ).isDirectory();

	} catch {

		return false;

	}

}

function displayPath( root, path ) {

	const fromRoot = relative( root, path ).replaceAll( '\\', '/' );
	return fromRoot && ! fromRoot.startsWith( '../' ) ? fromRoot : path;

}

function relativeCommandPath( root, path ) {

	return relative( root, path ).replaceAll( '\\', '/' ) || '.';

}

function splitOption( arg ) {

	const equals = arg.indexOf( '=' );
	if ( equals === - 1 ) return { name: arg, value: null };
	return { name: arg.slice( 0, equals ), value: arg.slice( equals + 1 ) };

}
