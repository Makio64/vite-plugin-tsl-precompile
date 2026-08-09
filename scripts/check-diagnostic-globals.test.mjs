import assert from 'node:assert/strict';
import test from 'node:test';

import {
	DIAGNOSTIC_GLOBALS,
	PRODUCT_DIAGNOSTIC_GLOBAL_SURFACES,
	getDiagnosticGlobal,
	installDiagnosticGlobal,
	isDeclaredDiagnosticGlobal,
	isProductDiagnosticGlobal,
	listDiagnosticGlobals,
	readDiagnosticGlobal,
} from '../packages/contract/src/diagnostic-globals.js';
import { compareRegistryToTree, validateRegistry } from './check-diagnostic-globals.mjs';

const DECLARED = [
	{ name: '__tslpFixtureState', surfaces: [ 'runtime' ], kind: 'state', purpose: 'fixture' },
	{ name: '__tslpFixtureHarness', surfaces: [ 'harness' ], kind: 'flag', purpose: null },
];

test( 'the shipped registry is internally well formed', () => {

	assert.deepEqual( validateRegistry( DIAGNOSTIC_GLOBALS ), [] );

} );

test( 'every product-surface declaration carries a written purpose', () => {

	for ( const entry of DIAGNOSTIC_GLOBALS ) {

		if ( ! entry.surfaces.some( ( surface ) => PRODUCT_DIAGNOSTIC_GLOBAL_SURFACES.includes( surface ) ) ) continue;
		assert.equal( typeof entry.purpose, 'string', `${ entry.name } must document a purpose` );
		assert.ok( entry.purpose.trim().length > 0, `${ entry.name } must document a purpose` );

	}

} );

test( 'a malformed name is rejected', () => {

	const problems = validateRegistry( [ { name: 'tslpNoPrefix', surfaces: [ 'harness' ], kind: 'flag', purpose: null } ] );
	assert.equal( problems.length, 1 );
	assert.equal( problems[ 0 ].kind, 'malformed' );

} );

test( 'an unknown surface or kind is rejected', () => {

	const problems = validateRegistry( [ { name: '__tslpX', surfaces: [ 'server' ], kind: 'gadget', purpose: null } ] );
	assert.deepEqual( problems.map( ( problem ) => problem.kind ), [ 'malformed', 'malformed' ] );

} );

test( 'a global installed in the tree but missing from the registry fails', () => {

	const installed = new Map( [
		[ '__tslpFixtureState', [ 'packages/runtime/src/a.js' ] ],
		[ '__tslpFixtureHarness', [ 'packages/examples/batch/b.mjs' ] ],
		[ '__tslpSurprise', [ 'packages/runtime/src/c.js' ] ],
	] );
	const problems = compareRegistryToTree( DECLARED, installed );
	assert.deepEqual( problems.map( ( problem ) => [ problem.kind, problem.name ] ), [ [ 'undeclared', '__tslpSurprise' ] ] );

} );

test( 'a declaration with no install site fails as dead', () => {

	const installed = new Map( [ [ '__tslpFixtureState', [ 'packages/runtime/src/a.js' ] ] ] );
	const problems = compareRegistryToTree( DECLARED, installed );
	assert.deepEqual( problems.map( ( problem ) => [ problem.kind, problem.name ] ), [ [ 'dead', '__tslpFixtureHarness' ] ] );

} );

test( 'a hook that migrates from harness-only into shipped code fails on surface drift', () => {

	const installed = new Map( [
		[ '__tslpFixtureState', [ 'packages/runtime/src/a.js' ] ],
		[ '__tslpFixtureHarness', [ 'packages/examples/batch/b.mjs', 'packages/runtime/src/d.js' ] ],
	] );
	const problems = compareRegistryToTree( DECLARED, installed );
	assert.equal( problems.length, 2 );
	assert.deepEqual( problems.map( ( problem ) => problem.kind ).sort(), [ 'missing-purpose', 'surface-drift' ] );

} );

test( 'a clean tree produces no problems', () => {

	const installed = new Map( [
		[ '__tslpFixtureState', [ 'packages/runtime/src/a.js' ] ],
		[ '__tslpFixtureHarness', [ 'packages/examples/batch/b.mjs' ] ],
	] );
	assert.deepEqual( compareRegistryToTree( DECLARED, installed ), [] );

} );

test( 'lookup helpers agree with the declared data', () => {

	const entry = DIAGNOSTIC_GLOBALS[ 0 ];
	assert.equal( getDiagnosticGlobal( entry.name ), entry );
	assert.equal( getDiagnosticGlobal( '__tslpNeverDeclared' ), null );
	assert.equal( isDeclaredDiagnosticGlobal( entry.name ), true );
	assert.equal( isDeclaredDiagnosticGlobal( '__tslpNeverDeclared' ), false );
	assert.equal( isProductDiagnosticGlobal( '__tslpHarnessDiagnostics' ), true );
	assert.equal( isProductDiagnosticGlobal( '__TSLP_DEBUG_IBL_BINDINGS' ), false );
	assert.equal( listDiagnosticGlobals().length, DIAGNOSTIC_GLOBALS.length );
	assert.ok( listDiagnosticGlobals( { surface: 'runtime' } ).every( ( item ) => item.surfaces.includes( 'runtime' ) ) );

} );

test( 'the accessors refuse an undeclared name and round-trip a declared one', () => {

	const scope = {};
	assert.throws( () => readDiagnosticGlobal( '__tslpNeverDeclared', scope ), /not a declared diagnostic global/ );
	assert.throws( () => installDiagnosticGlobal( '__tslpNeverDeclared', 1, scope ), /not a declared diagnostic global/ );
	installDiagnosticGlobal( '__tslpHarnessDiagnostics', { ok: true }, scope );
	assert.deepEqual( readDiagnosticGlobal( '__tslpHarnessDiagnostics', scope ), { ok: true } );

} );

test( 'the registry entries are frozen', () => {

	assert.throws( () => {

		DIAGNOSTIC_GLOBALS[ 0 ].purpose = 'mutated';

	}, TypeError );

} );
