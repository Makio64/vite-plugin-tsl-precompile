import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );

test( 'inline RenderOutput RTTs render their complete node graph before using a generic fallback', () => {

	const start = source.indexOf( 'function __renderRTTNodeWithFullRenderer' );
	const end = source.indexOf( 'function __rttPrecompiledShape', start );
	assert.ok( start >= 0 && end > start, 'expected the RTT full-renderer replay helper' );
	const helper = source.slice( start, end );

	assert.doesNotMatch( helper, /if \( __rttPrecompiledShape\( rttNode \) === 'render-output' \) return/ );
	assert.match( helper, /const fragmentNode = rttNode\._rttNode \|\| rttNode\.node;/ );
	assert.match( helper, /fragmentNode\.context\( \{/ );
	assert.match( helper, /toneMapping: slimRenderer\.toneMapping,/ );
	assert.match( helper, /outputColorSpace: slimRenderer\.outputColorSpace,/ );
	assert.match( helper, /return __renderRTTNodeWithPrecompiledSlim\( rttNode, slimRenderer \);/ );

} );
