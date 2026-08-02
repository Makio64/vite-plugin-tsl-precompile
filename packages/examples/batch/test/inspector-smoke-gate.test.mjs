import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateInspectorSmokeGate } from '../inspector-smoke-gate.mjs';

function validProbe() {

	return {
		ok: true,
		summaryCaptureTotalText: '3',
		totalText: '3 captures 96 B WGSL',
		pillTexts: [
			'background · 1',
			'user · 2',
			'3 unknown',
			'2 blocked',
		],
		rows: [
			{ shape: 'user', name: 'one', unknownCountText: '2', blockedCountText: '1' },
			{ shape: 'background', name: 'two', unknownCountText: '1', blockedCountText: '0' },
			{ shape: 'user', name: 'three', unknownCountText: '0', blockedCountText: '1' },
		],
	};

}

test( 'inspector smoke gate accepts exact summary, shape, and diagnostic totals', () => {

	const result = evaluateInspectorSmokeGate( validProbe() );

	assert.equal( result.ok, true );
	assert.deepEqual( result.counts, {
		total: 3,
		shapes: { background: 1, user: 2 },
		unknowns: 3,
		blocked: 2,
	} );

} );

test( 'inspector smoke gate rejects a stale summary total', () => {

	const probe = validProbe();
	probe.summaryCaptureTotalText = '2';

	const result = evaluateInspectorSmokeGate( probe );

	assert.equal( result.ok, false );
	assert.match( result.errors.join( '\n' ), /summary capture total 2 does not match 3 table rows/ );

} );

test( 'inspector smoke gate rejects missing, duplicate, extra, and stale shape pills', () => {

	const cases = [
		{
			name: 'missing',
			pills: [ 'user · 2', '3 unknown', '2 blocked' ],
			expected: /missing shape pill for "background"/,
		},
		{
			name: 'duplicate',
			pills: [ 'background · 1', 'user · 2', 'user · 2', '3 unknown', '2 blocked' ],
			expected: /duplicate shape pill for "user"/,
		},
		{
			name: 'extra',
			pills: [ 'background · 1', 'user · 2', 'compute · 1', '3 unknown', '2 blocked' ],
			expected: /table has no such rows/,
		},
		{
			name: 'stale',
			pills: [ 'background · 1', 'user · 1', '3 unknown', '2 blocked' ],
			expected: /reports 1, but the table has 2 rows/,
		},
	];

	for ( const scenario of cases ) {

		const probe = validProbe();
		probe.pillTexts = scenario.pills;
		const result = evaluateInspectorSmokeGate( probe );
		assert.equal( result.ok, false, scenario.name );
		assert.match( result.errors.join( '\n' ), scenario.expected, scenario.name );

	}

} );

test( 'inspector smoke gate sums multiple unsupported entries of both severities per row', () => {

	const probe = validProbe();
	probe.pillTexts = [ 'background · 1', 'user · 2', '2 unknown', '2 blocked' ];

	const result = evaluateInspectorSmokeGate( probe );

	assert.equal( result.ok, false );
	assert.match( result.errors.join( '\n' ), /unknown pill reports 2, but row diagnostics total 3/ );
	assert.doesNotMatch( result.errors.join( '\n' ), /blocked pill/ );

} );

test( 'inspector smoke gate makes page, console, and network failures fatal', () => {

	const result = evaluateInspectorSmokeGate( validProbe(), [
		{ kind: 'pageerror', message: 'ReferenceError: boom' },
		{ kind: 'console', message: 'shader capture rejected' },
		{ kind: 'requestfailed', message: 'net::ERR_FAILED https://example.invalid/capture' },
		{ kind: 'response', message: '500 https://example.invalid/capture' },
	] );

	assert.equal( result.ok, false );
	assert.match( result.errors.join( '\n' ), /pageerror: ReferenceError: boom/ );
	assert.match( result.errors.join( '\n' ), /console: shader capture rejected/ );
	assert.match( result.errors.join( '\n' ), /requestfailed: net::ERR_FAILED/ );
	assert.match( result.errors.join( '\n' ), /response: 500/ );

} );

test( 'inspector smoke gate rejects malformed numeric DOM attributes', () => {

	const probe = validProbe();
	probe.rows[ 0 ].unknownCountText = '2.0';
	probe.summaryCaptureTotalText = '03';

	const result = evaluateInspectorSmokeGate( probe );

	assert.equal( result.ok, false );
	assert.match( result.errors.join( '\n' ), /summary capture total must be a canonical non-negative integer/ );
	assert.match( result.errors.join( '\n' ), /data-unknown-count must be a canonical non-negative integer/ );

} );
