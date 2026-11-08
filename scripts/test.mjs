#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve( import.meta.dirname, '..' );
const GENERATION = new Set( [
	'aux-capture', 'aux-roundtrip', 'classify-material-shape',
	'compile-tsl-framebuffer-warmup', 'compute-artifact', 'compute-bindings-extraction',
	'compute-transform-feedback', 'extract-attribute-payload', 'extract-uniform-plan',
	'extractor-convergence', 'ltc-capture', 'live-render-harvest', 'live-uniform-node-path',
	'node-harness-lifecycle',
	'public-package-pack', 'range-attribute-integration', 'shader-language-extraction',
].map( ( name ) => `${ name }.test.js` ) );
const GENERATION_IMPORTS = [ '/src/vendor/compileTSL.js', '/src/aux-capture.js', '/src/node-harness.js' ];
const PACKAGES = {
	contract: 'packages/contract',
	plugin: 'packages/plugin',
	runtime: 'packages/runtime',
	inspector: 'packages/inspector-panel',
	site: 'packages/site',
	tooling: '.',
	batch: 'packages/examples/batch',
};
const TIERS = [ 'quick', 'full', 'unit', 'generation', 'rewrite', 'coverage' ];

function testFiles( directory ) {

	return readdirSync( directory, { recursive: true, withFileTypes: true } )
		.filter( ( entry ) => entry.isFile() && /\.test\.m?js$/.test( entry.name ) )
		.map( ( entry ) => join( entry.parentPath, entry.name ) ).sort();

}

function pluginGroup( file ) {

	const name = basename( file );
	if ( file.includes( join( 'test', 'coverage' ) + sep ) ) return 'coverage';
	if ( GENERATION.has( name ) ) return 'generation';
	if ( name.startsWith( 'rewrite-' ) ) return 'rewrite';
	const source = readFileSync( file, 'utf8' );
	if ( GENERATION_IMPORTS.some( ( marker ) => source.includes( marker ) ) ) {

		throw new Error( `Generation-heavy test must be classified in scripts/test.mjs: ${ name }` );

	}
	return name.startsWith( 'slim-' ) ? 'slim' : 'quick';

}

export function parseOptions( args, environment = process.env ) {

	const options = { tier: 'quick', scope: null, matches: [], list: false, verbose: false, failFast: false, help: false };
	let tierSeen = false;
	let workers;
	let timeout = environment.TSLP_TEST_TIMEOUT ?? '300000';
	let lowMemory = false;
	for ( const arg of args ) {

		if ( arg === '--' ) continue;
		if ( arg === '--list' ) options.list = true;
		else if ( arg === '--verbose' ) options.verbose = true;
		else if ( arg === '--help' || arg === '-h' ) options.help = true;
		else if ( arg === '--fail-fast' ) options.failFast = true;
		else if ( arg === '--low-memory' ) lowMemory = true;
		else if ( arg.startsWith( '--workers=' ) ) workers = arg.slice( 10 );
		else if ( arg.startsWith( '--timeout=' ) ) timeout = arg.slice( 10 );
		else if ( arg.startsWith( '--scope=' ) ) options.scope = arg.slice( 8 );
		else if ( arg.startsWith( '--match=' ) ) {

			const match = arg.slice( 8 );
			if ( ! match ) throw new Error( '--match requires a nonempty file substring.' );
			options.matches.push( match );

		}
		else if ( TIERS.includes( arg ) && ! tierSeen ) { options.tier = arg; tierSeen = true; }
		else throw new Error( `Unknown test option: ${ arg }` );

	}
	if ( options.scope !== null && ! Object.hasOwn( PACKAGES, options.scope ) ) throw new Error( `Unknown test scope: ${ options.scope }` );
	const value = workers ?? ( lowMemory ? '1' : environment.TSLP_TEST_CONCURRENCY ?? '2' );
	if ( ! /^[1-9]\d*$/.test( value ) || ! Number.isSafeInteger( Number( value ) ) ) {

		throw new Error( '--workers / TSLP_TEST_CONCURRENCY must be a positive integer.' );

	}
	options.concurrency = Number( value );
	if ( lowMemory && options.concurrency !== 1 ) throw new Error( '--low-memory requires --workers=1.' );
	if ( ! /^(0|[1-9]\d*)$/.test( timeout ) || ! Number.isSafeInteger( Number( timeout ) ) || Number( timeout ) > 2 ** 31 - 1 ) {

		throw new Error( '--timeout / TSLP_TEST_TIMEOUT must be an integer from 0 to 2147483647 milliseconds.' );

	}
	options.timeout = Number( timeout );
	return options;

}

export function createTestPlan( options, root = ROOT ) {

	const specialized = [ 'generation', 'rewrite', 'coverage', 'unit' ].includes( options.tier );
	const scopes = options.scope ? [ options.scope ] : specialized ? [ 'plugin' ] : [ 'contract', 'plugin', 'runtime', 'inspector', 'site', 'tooling' ];
	if ( specialized && scopes.some( ( scope ) => scope !== 'plugin' ) ) throw new Error( `${ options.tier } is a plugin tier; use quick or full for other scopes.` );
	const plan = [];
	for ( const scope of scopes ) {

		const cwd = join( root, PACKAGES[ scope ] );
		const files = testFiles( join( cwd, scope === 'tooling' ? 'scripts' : 'test' ) );
		const groups = new Map();
		for ( const file of files ) {

			// Explicit file selection needs no source reads or classification for
			// unrelated fixtures. Selected heavy imports still fail closed below.
			if ( options.matches?.length && ! options.matches.some( ( match ) => relative( root, file ).includes( match ) ) ) continue;
			const group = scope === 'plugin' ? pluginGroup( file )
				: scope === 'site' && basename( file ) === 'examples-evidence-contract.test.mjs' ? 'integration' : 'quick';
			if ( options.tier === 'quick' && group !== 'quick' ) continue;
			if ( scope === 'plugin' && options.tier !== 'full' && ! ( options.tier === 'unit' ? group !== 'coverage' : group === options.tier ) ) continue;
			if ( scope === 'tooling' && options.tier === 'quick' && basename( file ) !== 'test.test.mjs' ) continue;
			// Heavy compiler/rewrite/pack fixtures never overlap each other. Quick
			// tests keep their normal worker budget even in a complete suite.
			const concurrency = scope === 'plugin' && group !== 'quick' ? 1 : options.concurrency;
			if ( ! groups.has( concurrency ) ) groups.set( concurrency, [] );
			groups.get( concurrency ).push( file );

		}
		for ( const [ concurrency, selected ] of groups ) plan.push( { scope, cwd, concurrency, files: selected } );
		if ( scope === 'contract' && ! options.matches?.length ) plan.push( {
			scope: 'contract:types', cwd: root,
			args: [ join( root, 'node_modules/typescript/bin/tsc' ), '--project', 'packages/contract/test/tsconfig.json' ],
		} );

	}
	if ( ! plan.some( ( group ) => group.files?.length ) ) throw new Error( 'No test files matched the selection.' );
	return plan;

}

// Own the CLI and its descendants as one process group. A watchdog must stop a
// file stuck during synchronous import too; --test-timeout cannot interrupt that.
export async function runGroup( args, { cwd, timeout = 300000, stdio = 'inherit' } ) {

	const grouped = process.platform !== 'win32';
	const environment = { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', ...process.env };
	// The spawned CLI is a fresh runner even when a tooling fixture invokes it.
	// Inheriting child-v8 would make Node skip the nested suite entirely.
	delete environment.NODE_TEST_CONTEXT;
	const child = spawn( process.execPath, args, { cwd, stdio, detached: grouped, env: environment } );
	let timedOut = false;
	let interrupted = null;
	let escalation;
	let cleanup;
	let settleCleanup;
	const kill = ( signal ) => {

		try {

			if ( grouped ) process.kill( -child.pid, signal );
			else {

				// Windows has no POSIX process groups. taskkill /T owns the matching
				// process tree, including workers spawned by test fixtures.
				const result = spawnSync( 'taskkill.exe', [ '/pid', String( child.pid ), '/T', '/F' ], { stdio: 'ignore', timeout: 10000 } );
				if ( result.error || result.status !== 0 ) child.kill( signal );

			}

		} catch ( error ) {

			if ( error.code !== 'ESRCH' ) throw error;

		}

	};
	const stop = ( signal ) => {

		if ( cleanup || ! child.pid ) return;
		cleanup = new Promise( ( done ) => { settleCleanup = done; } );
		kill( signal );
		// The CLI can exit before a hung worker or grandchild. Keep the watchdog
		// alive until the whole group has received the final termination signal.
		escalation = setTimeout( () => { kill( 'SIGKILL' ); settleCleanup(); }, 250 );

	};
	const onInterrupt = ( signal ) => { interrupted = signal; stop( signal ); };
	const onSigint = () => onInterrupt( 'SIGINT' );
	const onSigterm = () => onInterrupt( 'SIGTERM' );
	process.on( 'SIGINT', onSigint );
	process.on( 'SIGTERM', onSigterm );
	const watchdog = timeout > 0 ? setTimeout( () => { timedOut = true; stop( 'SIGTERM' ); }, timeout ) : null;
	try {

		const result = await new Promise( ( done, reject ) => {

			child.once( 'error', reject );
			child.once( 'exit', ( status, signal ) => done( { status, signal } ) );

		} );
		clearTimeout( watchdog );
		await cleanup;
		return { ...result, timedOut, interrupted };

	} finally {

		clearTimeout( watchdog );
		clearTimeout( escalation );
		process.off( 'SIGINT', onSigint );
		process.off( 'SIGTERM', onSigterm );

	}

}

export async function executePlan( plan, { verbose = false, timeout = 300000, failFast = false } = {} ) {

	const logs = mkdtempSync( join( tmpdir(), 'tslp-tests-' ) );
	console.log( `[test] Complete logs: ${ logs }` );
	let failed = false;
	for ( const [ index, group ] of plan.entries() ) {

		const log = join( logs, `${ index }-${ group.scope.replaceAll( ':', '-' ) }.log` );
		console.log( `[test] ${ group.scope }: ${ group.files ? `${ group.files.length } files, ${ group.concurrency } workers` : 'declarations' }` );
		const args = group.args || [
			'--test', `--test-concurrency=${ group.concurrency }`,
			`--test-reporter=${ verbose ? 'spec' : join( ROOT, 'scripts/test-reporter.mjs' ) }`,
			'--test-reporter-destination=stdout',
			'--test-reporter=spec', `--test-reporter-destination=${ log }`,
			...group.files,
		];
		// Declaration output belongs in the same diagnostic directory as tests.
		const declarationLog = group.args ? openSync( log, 'w' ) : null;
		let result;
		try {

			result = await runGroup( args, { cwd: group.cwd, timeout, stdio: declarationLog === null ? 'inherit' : [ 'inherit', declarationLog, declarationLog ] } );

		} finally {

			if ( declarationLog !== null ) closeSync( declarationLog );

		}
		if ( result.interrupted ) return result.interrupted === 'SIGINT' ? 130 : 143;
		if ( result.timedOut ) console.error( `[test] ${ group.scope } exceeded ${ timeout }ms; stopped its process group. ${ log }` );
		if ( result.status !== 0 || result.timedOut ) {

			failed = true;
			console.error( `[test] ${ group.scope } failed (${ result.signal || `exit ${ result.status }` }); ${ log }` );
			if ( failFast || result.timedOut || result.signal ) break;

		}

	}
	return failed ? 1 : 0;

}

if ( process.argv[ 1 ] && resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {

	try {

		const options = parseOptions( process.argv.slice( 2 ) );
		if ( options.help ) {

			console.log( `Usage: pnpm test [--scope=runtime] [--match=hydrate-storage-buffer]
  --match=<substring>  Select whole files; repeat to include multiple matches.
  --workers=<count>    Ordinary file workers (default 2); heavy fixtures stay serial.
  --low-memory         Run one file worker at a time.
  --timeout=<ms>       Stop a stalled group and descendants (default 300000; 0 disables).
  --fail-fast          Stop after the first failed group.
  --list              Print the exact selection without running it.
  --verbose           Stream the complete report; all runs also save full logs.
Tiers: ${ TIERS.join( ', ' ) }. Scopes: ${ Object.keys( PACKAGES ).join( ', ' ) }.
Environment: TSLP_TEST_CONCURRENCY, TSLP_TEST_TIMEOUT.` );
			process.exitCode = 0;

		} else {

			const plan = createTestPlan( options );
			if ( options.list ) console.log( JSON.stringify( plan.map( ( group ) => ( {
				...group, files: group.files?.map( ( file ) => relative( ROOT, file ) ),
			} ) ), null, 2 ) );
			else process.exitCode = await executePlan( plan, options );

		}

	} catch ( error ) {

		console.error( `[test] ${ error.message }` );
		process.exitCode = 1;

	}

}
