#!/usr/bin/env node

// Diagnostics-schema-first gate.
//
// `@tsl-precompile/contract/diagnostic-globals` declares every `__tslp*` /
// `__TSLP_*` name this project is allowed to install on a global object. This
// script holds the tree to that declaration in both directions:
//
//   installed but not declared -> fail. Declare the hook first; that is the
//     inversion. P3.12 was formalizing hooks after they spread, which is why
//     the count reached 104 before anyone wrote a schema.
//   declared but not installed -> fail. A registry that keeps dead entries stops
//     being a description of the system and becomes another stale document.
//   reaches shipped code without a written purpose -> fail. Harness-only hooks
//     may stay terse; anything the runtime or plugin installs must say what it
//     is for.
//
// Usage:
//   node scripts/check-diagnostic-globals.mjs           enforce, human report
//   node scripts/check-diagnostic-globals.mjs --json    machine report

import { pathToFileURL } from 'node:url';

import {
	DIAGNOSTIC_GLOBALS,
	DIAGNOSTIC_GLOBAL_KINDS,
	DIAGNOSTIC_GLOBAL_SCHEMA,
	DIAGNOSTIC_GLOBAL_SURFACES,
	PRODUCT_DIAGNOSTIC_GLOBAL_SURFACES,
} from '../packages/contract/src/diagnostic-globals.js';
import { collectDebugGlobals } from './repo-metrics.mjs';

const REPORT_SCHEMA = 'tslp-diagnostic-globals-report@1';
const SCANNED_ROOTS = Object.freeze( [ 'packages/runtime/src', 'packages/plugin/src', 'packages/examples/batch' ] );
const REGISTRY_MODULE = '@tsl-precompile/contract/diagnostic-globals';

const JSON_OUTPUT = process.argv.includes( '--json' );

function surfaceOfFile( file ) {

	if ( file.startsWith( 'packages/runtime/' ) ) return 'runtime';
	if ( file.startsWith( 'packages/plugin/' ) ) return 'plugin';
	return 'harness';

}

export function validateRegistry( entries ) {

	const problems = [];
	const seen = new Set();
	for ( const entry of entries ) {

		if ( typeof entry.name !== 'string' || ! /^__(tslp|TSLP)/.test( entry.name ) ) {

			problems.push( { kind: 'malformed', name: String( entry.name ), detail: 'name must start with __tslp or __TSLP' } );
			continue;

		}
		if ( seen.has( entry.name ) ) problems.push( { kind: 'duplicate', name: entry.name, detail: 'declared more than once' } );
		seen.add( entry.name );
		if ( ! Array.isArray( entry.surfaces ) || entry.surfaces.length === 0 ) {

			problems.push( { kind: 'malformed', name: entry.name, detail: 'must declare at least one surface' } );

		} else for ( const surface of entry.surfaces ) {

			if ( ! DIAGNOSTIC_GLOBAL_SURFACES.includes( surface ) ) problems.push( { kind: 'malformed', name: entry.name, detail: `unknown surface ${ JSON.stringify( surface ) }` } );

		}
		if ( ! DIAGNOSTIC_GLOBAL_KINDS.includes( entry.kind ) ) problems.push( { kind: 'malformed', name: entry.name, detail: `unknown kind ${ JSON.stringify( entry.kind ) }` } );

	}
	return problems;

}

export function compareRegistryToTree( entries, installed ) {

	const declaredByName = new Map( entries.map( ( entry ) => [ entry.name, entry ] ) );
	const problems = [];

	for ( const [ name, files ] of installed ) {

		const entry = declaredByName.get( name );
		if ( ! entry ) {

			problems.push( { kind: 'undeclared', name, detail: `installed by ${ files.join( ', ' ) } but not declared in ${ REGISTRY_MODULE }` } );
			continue;

		}
		const actual = [ ...new Set( files.map( surfaceOfFile ) ) ].sort();
		const declared = [ ...entry.surfaces ].sort();
		if ( actual.join( ',' ) !== declared.join( ',' ) ) {

			problems.push( { kind: 'surface-drift', name, detail: `declared [${ declared.join( ', ' ) }] but installed from [${ actual.join( ', ' ) }]` } );

		}
		const reachesProduct = actual.some( ( surface ) => PRODUCT_DIAGNOSTIC_GLOBAL_SURFACES.includes( surface ) );
		if ( reachesProduct && ( typeof entry.purpose !== 'string' || ! entry.purpose.trim() ) ) {

			problems.push( { kind: 'missing-purpose', name, detail: 'reaches shipped runtime or plugin code and must document what it is for' } );

		}

	}

	for ( const entry of entries ) {

		if ( ! installed.has( entry.name ) ) problems.push( { kind: 'dead', name: entry.name, detail: `declared in ${ REGISTRY_MODULE } but installed nowhere; delete the declaration` } );

	}

	return problems.sort( ( a, b ) => ( a.name < b.name ? - 1 : a.name > b.name ? 1 : 0 ) );

}

function buildReport() {

	const installed = collectDebugGlobals( SCANNED_ROOTS );
	const problems = [ ...validateRegistry( DIAGNOSTIC_GLOBALS ), ...compareRegistryToTree( DIAGNOSTIC_GLOBALS, installed ) ];
	const surfaces = {};
	for ( const surface of DIAGNOSTIC_GLOBAL_SURFACES ) surfaces[ surface ] = DIAGNOSTIC_GLOBALS.filter( ( entry ) => entry.surfaces.includes( surface ) ).length;
	return {
		schema: REPORT_SCHEMA,
		registrySchema: DIAGNOSTIC_GLOBAL_SCHEMA,
		ok: problems.length === 0,
		scannedRoots: SCANNED_ROOTS,
		observed: {
			declared: DIAGNOSTIC_GLOBALS.length,
			installed: installed.size,
			bySurface: surfaces,
			product: DIAGNOSTIC_GLOBALS.filter( ( entry ) => entry.surfaces.some( ( surface ) => PRODUCT_DIAGNOSTIC_GLOBAL_SURFACES.includes( surface ) ) ).length,
		},
		problems,
	};

}

function printHumanReport( report ) {

	console.log( `Declared diagnostic globals (${ report.registrySchema })` );
	console.log( `  declared ${ report.observed.declared } · installed in tree ${ report.observed.installed }` );
	console.log( `  reaching shipped code (runtime/plugin) ${ report.observed.product } · harness-only ${ report.observed.declared - report.observed.product }` );
	console.log( '' );
	if ( report.ok ) {

		console.log( 'PASS: every installed diagnostic global is declared, every declaration is live, and every product-surface hook documents its purpose.' );
		return;

	}
	for ( const problem of report.problems ) console.error( `FAIL ${ problem.kind } ${ problem.name }: ${ problem.detail }` );
	console.error( '' );
	console.error( `Declare new hooks in packages/contract/src/diagnostic-globals.js before using them, and install/read them through installDiagnosticGlobal()/readDiagnosticGlobal().` );

}

function main() {

	const report = buildReport();
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
