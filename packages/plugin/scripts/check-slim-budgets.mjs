#!/usr/bin/env node

import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { build as viteBuild } from 'vite';

import tslPrecompile from '../src/index.js';
import {
	SLIM_BUNDLE_ANALYSIS_REPORT_SCHEMA,
	SLIM_BUNDLE_ANALYSIS_SCHEMA,
	analyzeSlimBundle,
} from '../../runtime/build-tools/slim-bundle-analysis.js';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const PLUGIN_ROOT = resolve( SELF, '..' );
const RUNTIME_ROOT = resolve( PLUGIN_ROOT, '../runtime' );
const CONTRACT_ROOT = resolve( PLUGIN_ROOT, '../contract' );
const BUDGET_FILE = resolve( RUNTIME_ROOT, 'build-tools/slim-budget.json' );
const FIXTURE_ROOT = resolve( PLUGIN_ROOT, 'test/fixtures/slim-budget' );
const JSON_OUTPUT = process.argv.includes( '--json' );
const PROFILE = process.argv.find( ( argument ) => argument.startsWith( '--profile=' ) )?.slice( '--profile='.length ) || null;
const PREBUILT_HELPERS_PROFILE = 'prebuilt-helpers';

function restoreEnvironment( name, value ) {

	if ( value === undefined ) delete process.env[ name ];
	else process.env[ name ] = value;

}

function summarizeGraph( graph ) {

	if ( graph.schema !== SLIM_BUNDLE_ANALYSIS_SCHEMA ) throw new Error( `Unsupported slim graph analysis schema: ${ JSON.stringify( graph.schema ) }` );
	return {
		moduleCount: graph.moduleCount,
		renderedBytes: graph.renderedBytes,
		compiler: { count: graph.compiler.count, renderedBytes: graph.compiler.renderedBytes },
		stockAdapters: { count: graph.stockAdapters.count, renderedBytes: graph.stockAdapters.renderedBytes },
		retainedNodeRuntime: { count: graph.retainedNodeRuntime.count, renderedBytes: graph.retainedNodeRuntime.renderedBytes },
		bareThreeIdentity: { count: graph.bareThreeIdentity.count, renderedBytes: graph.bareThreeIdentity.renderedBytes },
		runtime: { count: graph.runtime.count, renderedBytes: graph.runtime.renderedBytes },
		prebuiltRuntime: { count: graph.prebuiltRuntime.count, renderedBytes: graph.prebuiltRuntime.renderedBytes },
		runtimeSource: { count: graph.runtimeSource.count, renderedBytes: graph.runtimeSource.renderedBytes },
	};

}

async function buildPrebuiltProfile( temporaryRoot ) {

	const reportFile = join( temporaryRoot, 'prebuilt-analysis.json' );
	const bundleFile = join( temporaryRoot, 'three.webgpu.slim.js' );
	const metadataFile = join( temporaryRoot, 'three.webgpu.slim.meta.json' );
	const previousJson = process.env.TSLP_ANALYZE_JSON;
	const previousHuman = process.env.TSLP_ANALYZE;
	process.env.TSLP_ANALYZE_JSON = reportFile;
	delete process.env.TSLP_ANALYZE;
	try {

		const requireFromRuntime = createRequire( join( RUNTIME_ROOT, 'package.json' ) );
		const rollupEntry = requireFromRuntime.resolve( 'rollup' );
		const { rollup } = await import( pathToFileURL( rollupEntry ).href );
		const configModule = await import( pathToFileURL( join( RUNTIME_ROOT, 'rollup.config.js' ) ).href + `?budget=${ Date.now() }` );
		const config = configModule.default;
		const input = typeof config.input === 'string' ? resolve( RUNTIME_ROOT, config.input ) : config.input;
		const build = await rollup( { ...config, input } );
		try {

			await build.write( { ...config.output, file: bundleFile } );

		} finally {

			await build.close();

		}
		const analysis = JSON.parse( await readFile( reportFile, 'utf8' ) );
		if ( analysis.schema !== SLIM_BUNDLE_ANALYSIS_REPORT_SCHEMA ) throw new Error( `Unsupported slim analysis report schema: ${ JSON.stringify( analysis.schema ) }` );
		return {
			versions: configModule.SLIM_BUNDLE_VERSIONS,
			gzipLevel: analysis.gzipLevel,
			files: { bundleFile, metadataFile },
			profile: {
				output: analysis.output,
				graph: summarizeGraph( analysis.graph ),
			},
		};

	} finally {

		restoreEnvironment( 'TSLP_ANALYZE_JSON', previousJson );
		restoreEnvironment( 'TSLP_ANALYZE', previousHuman );

	}

}

async function stagePrebuiltRuntime( temporaryRoot, files ) {

	// Keep the staged package under a workspace-shaped path so Rollup's
	// realpath module IDs normalize to the same stable runtime/* provenance as
	// both installed packages and the real workspace.
	const runtimeRoot = join( temporaryRoot, 'packages/runtime' );
	await mkdir( join( runtimeRoot, 'build' ), { recursive: true } );
	await mkdir( join( runtimeRoot, 'node_modules/@tsl-precompile' ), { recursive: true } );
	await Promise.all( [
		copyFile( join( RUNTIME_ROOT, 'package.json' ), join( runtimeRoot, 'package.json' ) ),
		copyFile( join( RUNTIME_ROOT, 'rollup.config.js' ), join( runtimeRoot, 'rollup.config.js' ) ),
		symlink( join( RUNTIME_ROOT, 'src' ), join( runtimeRoot, 'src' ), 'junction' ),
		symlink( join( RUNTIME_ROOT, 'build-tools' ), join( runtimeRoot, 'build-tools' ), 'junction' ),
		symlink( CONTRACT_ROOT, join( runtimeRoot, 'node_modules/@tsl-precompile/contract' ), 'junction' ),
		copyFile( files.bundleFile, join( runtimeRoot, 'build/three.webgpu.slim.js' ) ),
		copyFile( files.metadataFile, join( runtimeRoot, 'build/three.webgpu.slim.meta.json' ) ),
	] );
	return runtimeRoot;

}

async function buildConsumerProfile( name, gzipLevel, { slim = 'source', runtimePackageRoot = RUNTIME_ROOT } = {} ) {

	const root = await realpath( await mkdtemp( join( tmpdir(), `tslp-slim-budget-${ name }-` ) ) );
	try {

		const runtimeRoot = await realpath( runtimePackageRoot );
		const contractRoot = await realpath( CONTRACT_ROOT );
		const threeRoot = await realpath( join( RUNTIME_ROOT, 'node_modules/three' ) );
		await mkdir( join( root, 'node_modules/@tsl-precompile' ), { recursive: true } );
		await symlink( runtimeRoot, join( root, 'node_modules/@tsl-precompile/runtime' ), 'junction' );
		await symlink( contractRoot, join( root, 'node_modules/@tsl-precompile/contract' ), 'junction' );
		await symlink( threeRoot, join( root, 'node_modules/three' ), 'junction' );
		await mkdir( join( root, 'src' ), { recursive: true } );
		await writeFile( join( root, 'package.json' ), JSON.stringify( {
			name: `tslp-slim-budget-${ name }`,
			private: true,
			type: 'module',
			dependencies: { '@tsl-precompile/contract': '0.1.0', '@tsl-precompile/runtime': '0.1.0', three: '0.184.0' },
		} ) );
		const entry = join( root, 'src/main.js' );
		await writeFile( entry, await readFile( join( FIXTURE_ROOT, `${ name }.js` ) ) );
		if ( name === PREBUILT_HELPERS_PROFILE ) await writeFile(
			join( root, 'src/minimal.js' ),
			await readFile( join( FIXTURE_ROOT, 'minimal.js' ) ),
		);
		const result = await viteBuild( {
			root,
			configFile: false,
			logLevel: 'silent',
			plugins: [ tslPrecompile( { slim } ) ],
			build: {
				write: false,
				minify: 'oxc',
				target: 'esnext',
				rollupOptions: { input: entry },
			},
		} );
		const output = Array.isArray( result ) ? result.flatMap( ( item ) => item.output || [] ) : result.output;
		const chunks = output.filter( ( item ) => item.type === 'chunk' );
		const graph = analyzeSlimBundle( Object.fromEntries( chunks.map( ( chunk ) => [ chunk.fileName, chunk ] ) ) );
		return {
			output: {
				chunkCount: chunks.length,
				rawBytes: chunks.reduce( ( total, chunk ) => total + Buffer.byteLength( chunk.code ), 0 ),
				gzipBytes: chunks.reduce( ( total, chunk ) => total + gzipSync( Buffer.from( chunk.code ), { level: gzipLevel } ).length, 0 ),
			},
			graph: summarizeGraph( graph ),
		};

	} finally {

		await rm( root, { recursive: true, force: true } );

	}

}

function addMaximumViolation( violations, profile, metric, actual, maximum ) {

	if ( Number.isSafeInteger( maximum ) && actual <= maximum ) return;
	violations.push( { profile, metric, actual, maximum } );

}

function addExactViolation( violations, profile, metric, actual, expected ) {

	if ( Number.isSafeInteger( expected ) && actual === expected ) return;
	violations.push( { profile, metric, actual, expected } );

}

function evaluateBudgets( budget, observed ) {

	const violations = [];
	const prebuilt = observed.prebuilt;
	if ( prebuilt ) {

		addMaximumViolation( violations, 'prebuilt', 'rawBytes', prebuilt.output.rawBytes, budget.prebuilt.maxRawBytes );
		addMaximumViolation( violations, 'prebuilt', 'gzipBytes', prebuilt.output.gzipBytes, budget.prebuilt.maxGzipBytes );
		addMaximumViolation( violations, 'prebuilt', 'compilerModules', prebuilt.graph.compiler.count, budget.prebuilt.maxCompilerModules );
		addMaximumViolation( violations, 'prebuilt', 'stockAdapterModules', prebuilt.graph.stockAdapters.count, budget.prebuilt.maxStockAdapterModules );
		addMaximumViolation( violations, 'prebuilt', 'retainedNodeModules', prebuilt.graph.retainedNodeRuntime.count, budget.prebuilt.maxRetainedNodeModules );
		addMaximumViolation( violations, 'prebuilt', 'retainedNodeRenderedBytes', prebuilt.graph.retainedNodeRuntime.renderedBytes, budget.prebuilt.maxRetainedNodeRenderedBytes );

	}
	const helpers = observed.consumer && observed.consumer.prebuiltHelpers;
	if ( helpers ) {

		const limits = budget.consumer.fixtures.prebuiltHelpers;
		addMaximumViolation( violations, 'consumer:prebuilt-helpers', 'rawBytes', helpers.output.rawBytes, limits.maxRawBytes );
		addMaximumViolation( violations, 'consumer:prebuilt-helpers', 'gzipBytes', helpers.output.gzipBytes, limits.maxGzipBytes );
		addExactViolation( violations, 'consumer:prebuilt-helpers', 'runtimeModules', helpers.graph.runtime.count, limits.expectedRuntimeModules );
		addExactViolation( violations, 'consumer:prebuilt-helpers', 'prebuiltRuntimeModules', helpers.graph.prebuiltRuntime.count, limits.expectedPrebuiltRuntimeModules );
		addMaximumViolation( violations, 'consumer:prebuilt-helpers', 'runtimeSourceModules', helpers.graph.runtimeSource.count, limits.maxRuntimeSourceModules );

	}
	for ( const name of [ 'minimal', 'advanced' ] ) {

		const source = observed.source && observed.source[ name ];
		if ( ! source ) continue;
		addMaximumViolation( violations, `source:${ name }`, 'gzipBytes', source.output.gzipBytes, budget.source.fixtures[ name ].maxGzipBytes );
		addMaximumViolation( violations, `source:${ name }`, 'compilerModules', source.graph.compiler.count, budget.source.maxCompilerModules );
		addMaximumViolation( violations, `source:${ name }`, 'stockAdapterModules', source.graph.stockAdapters.count, budget.source.maxStockAdapterModules );
		addMaximumViolation( violations, `source:${ name }`, 'retainedNodeModules', source.graph.retainedNodeRuntime.count, budget.source.maxRetainedNodeModules );
		addMaximumViolation( violations, `source:${ name }`, 'retainedNodeRenderedBytes', source.graph.retainedNodeRuntime.renderedBytes, budget.source.maxRetainedNodeRenderedBytes );
		addMaximumViolation( violations, `source:${ name }`, 'bareThreeIdentityModules', source.graph.bareThreeIdentity.count, budget.source.maxBareThreeIdentityModules );

	}
	return violations;

}

function printHumanReport( report ) {

	console.log( 'Slim production budgets' );
	console.log( 'profile                   raw KiB  gzip KiB  modules  compiler  stock  node  node KiB  bare  runtime  prebuilt  runtime/src' );
	const rows = [];
	if ( report.observed.prebuilt ) rows.push( [ 'prebuilt', report.observed.prebuilt ] );
	if ( report.observed.consumer?.prebuiltHelpers ) rows.push( [ 'consumer:prebuilt-helpers', report.observed.consumer.prebuiltHelpers ] );
	if ( report.observed.source?.minimal ) rows.push( [ 'source:minimal', report.observed.source.minimal ] );
	if ( report.observed.source?.advanced ) rows.push( [ 'source:advanced', report.observed.source.advanced ] );
	for ( const [ name, profile ] of rows ) {

		console.log( `${ name.padEnd( 26 ) }${ ( profile.output.rawBytes / 1024 ).toFixed( 1 ).padStart( 8 ) }${ ( profile.output.gzipBytes / 1024 ).toFixed( 1 ).padStart( 10 ) }${ String( profile.graph.moduleCount ).padStart( 9 ) }${ String( profile.graph.compiler.count ).padStart( 10 ) }${ String( profile.graph.stockAdapters.count ).padStart( 7 ) }${ String( profile.graph.retainedNodeRuntime.count ).padStart( 6 ) }${ ( profile.graph.retainedNodeRuntime.renderedBytes / 1024 ).toFixed( 1 ).padStart( 10 ) }${ String( profile.graph.bareThreeIdentity.count ).padStart( 6 ) }${ String( profile.graph.runtime.count ).padStart( 9 ) }${ String( profile.graph.prebuiltRuntime.count ).padStart( 10 ) }${ String( profile.graph.runtimeSource.count ).padStart( 13 ) }` );

	}
	if ( report.ok ) console.log( 'PASS: every byte, compiler, replay-adapter, retained-node, identity, and runtime-provenance budget is within its cap.' );
	else for ( const violation of report.violations ) console.error( `FAIL ${ violation.profile } ${ violation.metric }: ${ violation.actual } ${ violation.expected !== undefined ? `!== ${ violation.expected }` : `> ${ violation.maximum }` }` );

}

async function main() {

	if ( PROFILE && PROFILE !== PREBUILT_HELPERS_PROFILE ) throw new Error( `Unknown slim budget profile: ${ JSON.stringify( PROFILE ) }` );
	const budget = JSON.parse( await readFile( BUDGET_FILE, 'utf8' ) );
	if ( budget.schema !== 'tslp-slim-budget@1' ) throw new Error( `Unsupported slim budget schema: ${ JSON.stringify( budget.schema ) }` );
	const temporaryRoot = await realpath( await mkdtemp( join( tmpdir(), 'tslp-slim-budget-prebuilt-' ) ) );
	try {

		const prebuilt = await buildPrebuiltProfile( temporaryRoot );
		if ( prebuilt.gzipLevel !== budget.gzipLevel ) throw new Error( `Slim analysis used gzip level ${ prebuilt.gzipLevel }, but the budget requires ${ budget.gzipLevel }.` );
		const stagedRuntime = await stagePrebuiltRuntime( temporaryRoot, prebuilt.files );
		const prebuiltHelpers = await buildConsumerProfile( PREBUILT_HELPERS_PROFILE, budget.gzipLevel, {
			slim: true,
			runtimePackageRoot: stagedRuntime,
		} );
		const observed = PROFILE === PREBUILT_HELPERS_PROFILE
			? { consumer: { prebuiltHelpers } }
			: {
				prebuilt: prebuilt.profile,
				consumer: { prebuiltHelpers },
				source: {
					minimal: await buildConsumerProfile( 'minimal', budget.gzipLevel ),
					advanced: await buildConsumerProfile( 'advanced', budget.gzipLevel ),
				},
			};
		const violations = evaluateBudgets( budget, observed );
		const report = {
			schema: 'tslp-slim-budget-report@1',
			ok: violations.length === 0,
			versions: prebuilt.versions,
			observed,
			violations,
		};
		if ( JSON_OUTPUT ) console.log( JSON.stringify( report, null, 2 ) );
		else printHumanReport( report );
		if ( ! report.ok ) process.exitCode = 1;

	} finally {

		await rm( temporaryRoot, { recursive: true, force: true } );

	}

}

main().catch( ( error ) => {

	if ( JSON_OUTPUT ) console.log( JSON.stringify( { schema: 'tslp-slim-budget-report@1', ok: false, error: error.message }, null, 2 ) );
	else console.error( error && error.stack || error );
	process.exitCode = 1;

} );
