#!/usr/bin/env node
/**
 * Produce one exact 254-case visual-evidence campaign:
 *   - 209 official Three r185 examples in the canonical upstream root
 *   - 45 local routes in six isolated cohort roots
 *   - one aggregate coverage-evidence-set.json proving the exact union
 */

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRunId } from './e2e-evidence.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const REPO = resolve( SELF, '../../..' );
const optionPrefixes = [ '--three-repo=', '--output-root=', '--campaign-id=' ];

function argumentValue( args, prefix ) {

	const argument = args.find( ( value ) => value.startsWith( prefix ) );
	return argument ? argument.slice( prefix.length ) : '';

}

export const evidenceCohorts = Object.freeze( [
	'shadow-debug',
	'postprocessing-debug',
	'pmrem-debug',
	'compute-debug',
	'mrt-debug',
	'wow-showcase',
] );

export function assertFreshCampaignOutputRoot( outputRoot ) {

	if ( ! existsSync( outputRoot ) ) return;
	const stat = lstatSync( outputRoot );
	if ( stat.isSymbolicLink() || ! stat.isDirectory() ) {

		throw new Error( `[evidence-campaign] output root must be a real directory: ${ outputRoot }.` );

	}
	const entries = readdirSync( outputRoot );
	if ( entries.length > 0 ) {

		throw new Error(
			`[evidence-campaign] output root must be new or empty; found ${ entries.length } existing entr${ entries.length === 1 ? 'y' : 'ies' } in ${ outputRoot }.`,
		);

	}

}

let activeChild = null;
let interruptedSignal = null;
for ( const signal of [ 'SIGINT', 'SIGTERM', 'SIGHUP' ] ) {

	process.on( signal, () => {

		interruptedSignal = signal;
		activeChild?.kill( signal );

	} );

}

function signalExitCode( signal ) {

	if ( signal === 'SIGINT' ) return 130;
	if ( signal === 'SIGTERM' ) return 143;
	if ( signal === 'SIGHUP' ) return 129;
	return 1;

}

function runNode( label, script, scriptArgs ) {

	return new Promise( ( resolveExit ) => {

		console.log( `[evidence-campaign] ${ label}` );
		const child = spawn( process.execPath, [ resolve( SELF, script ), ...scriptArgs ], {
			cwd: REPO,
			stdio: 'inherit',
		} );
		activeChild = child;
		child.on( 'error', ( error ) => {

			console.error( `[evidence-campaign] could not start ${ script }: ${ error.message }` );
			activeChild = null;
			resolveExit( 1 );

		} );
		child.on( 'close', ( code, signal ) => {

			activeChild = null;
			resolveExit( signal ? signalExitCode( signal ) : code ?? 1 );

		} );

	} );

}

export async function runEvidenceCampaign( {
	threeRepo,
	outputRoot,
	campaignId,
	runStage = runNode,
	logger = console,
	isInterrupted = () => interruptedSignal,
} ) {

	const failures = [];
	const common = [
		`--three-repo=${ threeRepo }`,
		`--campaign-id=${ campaignId }`,
		'--require-official-three-sources',
	];
	const runRecordedStage = async ( label, script, scriptArgs ) => {

		const status = await runStage( label, script, scriptArgs );
		if ( status !== 0 ) failures.push( { label, status } );

	};

	await runRecordedStage( 'running exact 209-case upstream cohort', 'run-e2e.mjs', [
		...common,
		`--output-root=${ outputRoot }`,
		'--canonical-evidence',
	] );
	for ( const project of evidenceCohorts ) {

		if ( isInterrupted() ) break;
		const localRoot = resolve( REPO, 'packages/examples', project );
		const cohortRoot = resolve( outputRoot, 'cohorts', project );
		await runRecordedStage( `running exact local cohort ${ project }`, 'run-e2e.mjs', [
			...common,
			`--local-examples-root=${ localRoot }`,
			`--output-root=${ cohortRoot }`,
			`--report=${ project }-e2e-report.json`,
		] );

	}
	const interruption = isInterrupted();
	if ( interruption ) return signalExitCode( interruption );

	await runRecordedStage( 'validating the exact 254-case aggregate', 'run-coverage-summary.mjs', [
		`--output-root=${ outputRoot }`,
	] );
	logger.log(
		`[evidence-campaign] campaign ${ campaignId } finished with ${ failures.length } failed stage(s); ` +
		`aggregate root ${ outputRoot } (${ evidenceCohorts.length + 1 } cohorts)`,
	);
	for ( const failure of failures ) {

		logger.error( `[evidence-campaign] failed: ${ failure.label } (exit ${ failure.status })` );

	}
	return failures.length === 0 ? 0 : failures[ 0 ].status || 1;

}

function parseCliOptions( argv, env ) {

	const args = argv.filter( ( argument ) => argument !== '--' );
	const unknownArguments = args.filter(
		( argument ) => ! optionPrefixes.some( ( prefix ) => argument.startsWith( prefix ) )
	);
	if ( unknownArguments.length > 0 ) {

		return {
			error: `[evidence-campaign] unknown option(s): ${ unknownArguments.join( ', ' ) }.`,
		};

	}
	for ( const prefix of optionPrefixes ) {

		if ( args.filter( ( argument ) => argument.startsWith( prefix ) ).length > 1 ) {

			return {
				error: `[evidence-campaign] option ${ prefix.slice( 0, - 1 ) } may be provided only once.`,
			};

		}

	}

	const threeRepoValue = argumentValue( args, '--three-repo=' ) || env.TSLP_THREE_REPO || '';
	if ( ! threeRepoValue ) {

		return {
			error: '[evidence-campaign] --three-repo=<clean-official-r185-checkout> is required.',
		};

	}
	const threeRepo = resolve( threeRepoValue );
	if ( ! existsSync( resolve( threeRepo, 'examples' ) ) ) {

		return {
			error: `[evidence-campaign] Three examples not found below ${ threeRepo }.`,
		};

	}
	const outputRootValue = argumentValue( args, '--output-root=' ) || env.TSLP_E2E_OUT || resolve( SELF, 'results' );
	const outputRoot = resolve( outputRootValue );
	const campaignId = argumentValue( args, '--campaign-id=' ) || createRunId();
	if ( ! /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test( campaignId ) ) {

		return {
			error: `[evidence-campaign] invalid campaign ID ${ JSON.stringify( campaignId ) }.`,
		};

	}
	return { threeRepo, outputRoot, campaignId };

}

async function main() {

	const options = parseCliOptions( process.argv.slice( 2 ), process.env );
	if ( options.error ) {

		console.error( options.error );
		return 2;

	}
	try {

		assertFreshCampaignOutputRoot( options.outputRoot );

	} catch ( error ) {

		console.error( error && error.message || error );
		return 2;

	}
	return runEvidenceCampaign( options );

}

if ( process.argv[ 1 ] && resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {

	process.exit( await main() );

}
