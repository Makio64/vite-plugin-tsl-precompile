import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateModules, validateBudget } from './check-module-budgets.mjs';
import { BRANCH_KEYWORD_PATTERN, countBranchKeywords, countLines, collectDebugGlobals } from './repo-metrics.mjs';

function budgetFixture( overrides = {} ) {

	return {
		schema: 'tslp-module-budget@1',
		baseline: { commit: 'abc1234', recordedOn: '2026-08-02', reason: 'fixture' },
		policy: { branchKeywordPattern: BRANCH_KEYWORD_PATTERN, ratchetSlackLines: 40, ratchetSlackBranches: 8 },
		modules: [
			{
				file: 'fixture.js',
				reason: 'fixture',
				baselineLines: 100,
				linesHeadroom: 0,
				maxLines: 100,
				baselineBranches: 10,
				branchesHeadroom: 0,
				maxBranches: 10,
			},
		],
		...overrides,
	};

}

test( 'countLines matches wc -l semantics', () => {

	assert.equal( countLines( 'a\nb\nc\n' ), 3 );
	assert.equal( countLines( 'a\nb\nc' ), 2, 'a file without a trailing newline does not count its last line' );
	assert.equal( countLines( '' ), 0 );

} );

test( 'countBranchKeywords counts whole-word occurrences only', () => {

	assert.equal( countBranchKeywords( 'if ( a ) switch ( b ) { case 1: }' ), 3 );
	assert.equal( countBranchKeywords( 'notif ifx caseless switching' ), 0, 'substrings of longer identifiers are not branches' );
	assert.equal( countBranchKeywords( 'if(a)if(b)' ), 2 );

} );

test( 'a budget whose baseline plus headroom does not equal its maximum is rejected', () => {

	const budget = budgetFixture();
	budget.modules[ 0 ].maxLines = 120;
	assert.throws( () => validateBudget( budget ), /baseline plus headroom/ );

} );

test( 'a budget that measures a different branch pattern than the metrics module is rejected', () => {

	const budget = budgetFixture();
	budget.policy.branchKeywordPattern = '\\bif\\b';
	assert.throws( () => validateBudget( budget ), /repo-metrics\.mjs measures/ );

} );

test( 'a capped module without a written reason is rejected', () => {

	const budget = budgetFixture();
	delete budget.modules[ 0 ].reason;
	assert.throws( () => validateBudget( budget ), /must document why it is capped/ );

} );

test( 'a duplicated file entry is rejected', () => {

	const budget = budgetFixture();
	budget.modules.push( { ...budget.modules[ 0 ] } );
	assert.throws( () => validateBudget( budget ), /twice/ );

} );

test( 'the valid fixture passes validation', () => {

	assert.doesNotThrow( () => validateBudget( budgetFixture() ) );

} );

test( 'growing past the cap fails in the over direction', () => {

	const { violations } = evaluateModules( budgetFixture(), () => ( { file: 'fixture.js', lines: 101, branches: 10 } ) );
	assert.equal( violations.length, 1 );
	assert.deepEqual( violations[ 0 ], { file: 'fixture.js', metric: 'lines', actual: 101, maximum: 100, direction: 'over' } );

} );

test( 'sitting exactly at the cap passes', () => {

	const { violations } = evaluateModules( budgetFixture(), () => ( { file: 'fixture.js', lines: 100, branches: 10 } ) );
	assert.deepEqual( violations, [] );

} );

test( 'shrinking within the slack window passes without demanding a ratchet', () => {

	const { violations } = evaluateModules( budgetFixture(), () => ( { file: 'fixture.js', lines: 60, branches: 3 } ) );
	assert.deepEqual( violations, [], '40 lines and 7 branches of slack are inside the documented window' );

} );

test( 'shrinking past the slack window demands a ratchet-down on both metrics', () => {

	const { violations } = evaluateModules( budgetFixture(), () => ( { file: 'fixture.js', lines: 40, branches: 1 } ) );
	assert.equal( violations.length, 2 );
	assert.deepEqual( violations.map( ( violation ) => [ violation.metric, violation.direction ] ), [ [ 'lines', 'ratchet' ], [ 'branches', 'ratchet' ] ] );

} );

test( 'collectDebugGlobals finds every installed name in the real tree and none of the payload keys', () => {

	const globals = collectDebugGlobals( [ 'packages/runtime/src' ] );
	assert.ok( globals.size > 0 );
	for ( const [ name, files ] of globals ) {

		assert.match( name, /^__(tslp|TSLP)/ );
		assert.ok( files.length > 0, `${ name } must record at least one install site` );

	}

} );
