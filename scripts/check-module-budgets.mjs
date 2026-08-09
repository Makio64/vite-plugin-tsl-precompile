#!/usr/bin/env node

// Concentration ratchet for the architecture's god files.
//
// The repo's structural risk is concentration: a handful of very large files at
// the seams where correctness matters most. Splitting them is slow work; what
// stops the *regrowth race* is a cap. `hydrator.js` went 656 -> 1402 -> 1439
// after its first split precisely because nothing held the line.
//
// The gate is deliberately two-sided:
//   - over the cap  -> fail. New features must land in focused modules.
//   - far under it  -> fail. After a real split, the cap must be ratcheted down
//                     so the reclaimed space cannot be silently re-consumed.
//
// Moving a cap is one command (`--update`) plus a reviewable JSON diff carrying
// a written reason, which is exactly the review conversation we want.
//
// Usage:
//   node scripts/check-module-budgets.mjs             enforce, human report
//   node scripts/check-module-budgets.mjs --json      machine report (generated docs metrics)
//   node scripts/check-module-budgets.mjs --update    rewrite baselines to the current tree

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
	BRANCH_KEYWORD_PATTERN,
	REPO_ROOT,
	collectDebugGlobals,
	measureFile,
	readRepoFile,
	summarizeTree,
} from './repo-metrics.mjs';

const BUDGET_FILE = resolve( REPO_ROOT, 'scripts/module-budget.json' );
const BUDGET_SCHEMA = 'tslp-module-budget@1';
const REPORT_SCHEMA = 'tslp-module-budget-report@1';
const DIAGNOSTIC_ROOTS = Object.freeze( [ 'packages/runtime/src', 'packages/plugin/src', 'packages/examples/batch' ] );

const JSON_OUTPUT = process.argv.includes( '--json' );
const UPDATE = process.argv.includes( '--update' );

function assertDocumentedBudget( file, module, kind ) {

	const baseline = module[ `baseline${ kind }` ];
	const headroom = module[ `${ kind[ 0 ].toLowerCase() }${ kind.slice( 1 ) }Headroom` ];
	const maximum = module[ `max${ kind }` ];
	if ( ! Number.isSafeInteger( baseline ) || ! Number.isSafeInteger( headroom ) || ! Number.isSafeInteger( maximum ) ) {

		throw new Error( `${ file } must document integer ${ kind.toLowerCase() } baseline, headroom, and maximum values.` );

	}
	if ( headroom < 0 ) throw new Error( `${ file } ${ kind.toLowerCase() } headroom must not be negative.` );
	if ( baseline + headroom !== maximum ) {

		throw new Error( `${ file } ${ kind.toLowerCase() } budget must equal its documented baseline plus headroom (${ baseline } + ${ headroom } !== ${ maximum }).` );

	}

}

export function validateBudget( budget ) {

	if ( budget.schema !== BUDGET_SCHEMA ) throw new Error( `Unsupported module budget schema: ${ JSON.stringify( budget.schema ) }` );
	if ( budget.policy?.branchKeywordPattern !== BRANCH_KEYWORD_PATTERN ) {

		throw new Error( `Module budget declares branch pattern ${ JSON.stringify( budget.policy?.branchKeywordPattern ) }, but repo-metrics.mjs measures ${ JSON.stringify( BRANCH_KEYWORD_PATTERN ) }.` );

	}
	if ( ! Number.isSafeInteger( budget.policy.ratchetSlackLines ) || budget.policy.ratchetSlackLines < 0 ) {

		throw new Error( 'Module budget must document a non-negative integer ratchetSlackLines.' );

	}
	if ( ! Number.isSafeInteger( budget.policy.ratchetSlackBranches ) || budget.policy.ratchetSlackBranches < 0 ) {

		throw new Error( 'Module budget must document a non-negative integer ratchetSlackBranches.' );

	}
	if ( typeof budget.baseline?.reason !== 'string' || ! budget.baseline.reason ) {

		throw new Error( 'Module budget must document why its baseline was recorded.' );

	}
	if ( ! Array.isArray( budget.modules ) || budget.modules.length === 0 ) throw new Error( 'Module budget must track at least one module.' );
	const seen = new Set();
	for ( const module of budget.modules ) {

		if ( typeof module.file !== 'string' || ! module.file ) throw new Error( 'Every tracked module must name a file.' );
		if ( seen.has( module.file ) ) throw new Error( `Module budget lists ${ module.file } twice.` );
		seen.add( module.file );
		if ( typeof module.reason !== 'string' || ! module.reason ) throw new Error( `${ module.file } must document why it is capped.` );
		assertDocumentedBudget( module.file, module, 'Lines' );
		assertDocumentedBudget( module.file, module, 'Branches' );

	}

}

export function evaluateModules( budget, measure = measureFile ) {

	const observed = [];
	const violations = [];
	for ( const module of budget.modules ) {

		const measured = measure( module.file );
		observed.push( { ...measured, tracker: module.tracker || null, maxLines: module.maxLines, maxBranches: module.maxBranches } );
		for ( const [ metric, actual, maximum, slack ] of [
			[ 'lines', measured.lines, module.maxLines, budget.policy.ratchetSlackLines ],
			[ 'branches', measured.branches, module.maxBranches, budget.policy.ratchetSlackBranches ],
		] ) {

			if ( actual > maximum ) violations.push( { file: module.file, metric, actual, maximum, direction: 'over' } );
			else if ( maximum - actual > slack ) violations.push( { file: module.file, metric, actual, maximum, direction: 'ratchet' } );

		}

	}
	return { observed, violations };

}

function collectReportOnly( budget ) {

	const files = ( budget.reportOnly?.files || [] ).map( ( file ) => measureFile( file ) );
	const trees = ( budget.reportOnly?.trees || [] ).map( ( tree ) => ( {
		label: tree.label,
		...summarizeTree( tree.root, { excludeTests: tree.excludeTests === true, onlyTests: tree.onlyTests === true } ),
	} ) );
	const debugGlobals = collectDebugGlobals( DIAGNOSTIC_ROOTS );
	return { files, trees, debugGlobals: { roots: DIAGNOSTIC_ROOTS, installed: debugGlobals.size } };

}

function printHumanReport( report ) {

	console.log( `Module concentration budgets (baseline ${ report.baseline.commit }, ${ report.baseline.recordedOn })` );
	console.log( 'file                                                lines    cap  branch    cap  tracker' );
	for ( const module of report.observed.modules ) {

		console.log( `${ module.file.padEnd( 50 ) }${ String( module.lines ).padStart( 6 ) }${ String( module.maxLines ).padStart( 7 ) }${ String( module.branches ).padStart( 8 ) }${ String( module.maxBranches ).padStart( 7 ) }  ${ module.tracker || '-' }` );

	}
	console.log( '' );
	console.log( 'report-only (uncapped)                              lines  branch' );
	for ( const file of report.observed.reportOnly.files ) {

		console.log( `${ file.file.padEnd( 50 ) }${ String( file.lines ).padStart( 6 ) }${ String( file.branches ).padStart( 8 ) }` );

	}
	console.log( '' );
	console.log( 'tree                                                files   lines' );
	for ( const tree of report.observed.reportOnly.trees ) {

		console.log( `${ `${ tree.label } (${ tree.root })`.padEnd( 50 ) }${ String( tree.files ).padStart( 6 ) }${ String( tree.lines ).padStart( 8 ) }` );

	}
	console.log( '' );
	console.log( `installed __tslp debug globals: ${ report.observed.reportOnly.debugGlobals.installed }` );
	console.log( '' );
	if ( report.ok ) {

		console.log( 'PASS: every capped module is at its documented ceiling and none has enough reclaimed slack to need a ratchet-down.' );
		return;

	}
	for ( const violation of report.violations ) {

		if ( violation.direction === 'over' ) console.error( `FAIL ${ violation.file } ${ violation.metric }: ${ violation.actual } > ${ violation.maximum }. Land this in a focused module, or move the cap with \`${ report.policy.updateCommand }\` and document why in scripts/module-budget.json.` );
		else console.error( `FAIL ${ violation.file } ${ violation.metric }: ${ violation.actual } is ${ violation.maximum - violation.actual } under its ${ violation.maximum } cap. Ratchet it down with \`${ report.policy.updateCommand }\` so the reclaimed space stays reclaimed.` );

	}

}

function applyUpdate( budget, observed ) {

	const measuredByFile = new Map( observed.map( ( module ) => [ module.file, module ] ) );
	const next = {
		...budget,
		modules: budget.modules.map( ( module ) => {

			const measured = measuredByFile.get( module.file );
			return {
				...module,
				baselineLines: measured.lines,
				maxLines: measured.lines + module.linesHeadroom,
				baselineBranches: measured.branches,
				maxBranches: measured.branches + module.branchesHeadroom,
			};

		} ),
	};
	writeFileSync( BUDGET_FILE, `${ JSON.stringify( next, null, '\t' ) }\n` );

}

function main() {

	const budget = JSON.parse( readRepoFile( 'scripts/module-budget.json' ) );
	validateBudget( budget );
	const { observed, violations } = evaluateModules( budget );
	if ( UPDATE ) {

		applyUpdate( budget, observed );
		console.log( `Rewrote ${ observed.length } module baselines from the current tree. Review the diff and record why each cap moved.` );
		return;

	}
	const report = {
		schema: REPORT_SCHEMA,
		ok: violations.length === 0,
		baseline: budget.baseline,
		policy: budget.policy,
		observed: { modules: observed, reportOnly: collectReportOnly( budget ) },
		violations,
	};
	if ( JSON_OUTPUT ) console.log( JSON.stringify( report, null, 2 ) );
	else printHumanReport( report );
	if ( ! report.ok ) process.exitCode = 1;

}

if ( process.argv[ 1 ] && import.meta.url === pathToFileURL( process.argv[ 1 ] ).href ) {

	try {

		main();

	} catch ( error ) {

		if ( JSON_OUTPUT ) console.log( JSON.stringify( { schema: REPORT_SCHEMA, ok: false, error: error.message }, null, 2 ) );
		else console.error( error && error.stack || error );
		process.exitCode = 1;

	}

}
