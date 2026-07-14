import { test } from 'node:test';
import assert from 'node:assert/strict';

import { captureRenderKey } from '../src/render-key.js';

function capture( overrides = {} ) {

	return {
		id: 'user:live-material',
		hash: 'hash-a',
		configHash: null,
		vertexBytes: 10,
		fragmentBytes: 10,
		computeBytes: 0,
		unsupportedKinds: [],
		...overrides,
	};

}

test( 'render key changes for equal-length accepted shader revisions', () => {

	const first = captureRenderKey( capture() );
	const revised = captureRenderKey( capture( { hash: 'hash-b' } ) );

	assert.notEqual( revised, first );

} );

test( 'render key covers compute size and unsupported diagnostics', () => {

	const first = captureRenderKey( capture() );
	assert.notEqual( captureRenderKey( capture( { computeBytes: 64 } ) ), first );
	assert.notEqual( captureRenderKey( capture( {
		unsupportedKinds: [ { severity: 'blocked', kind: 'storage.texture', reason: 'recapture' } ],
	} ) ), first );
	assert.equal( captureRenderKey( capture() ), first );

} );
