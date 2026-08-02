import assert from 'node:assert/strict';
import test from 'node:test';

import {
	clampComparisonPosition,
	COMPARISON_SIDE,
	comparisonImageAlt,
	comparisonValueText,
	resolveSoloFrame,
} from '../src/comparison-contract.js';

test( 'comparison slider text describes the visible left/right reveal', () => {

	assert.equal( clampComparisonPosition( - 20 ), 0 );
	assert.equal( clampComparisonPosition( 120 ), 100 );
	assert.equal( clampComparisonPosition( Number.NaN, 42 ), 42 );
	assert.equal( comparisonValueText( 0 ), 'All slim replay; live three.js is hidden' );
	assert.equal(
		comparisonValueText( 51.2 ),
		'51% live three.js on the left; 49% slim replay on the right',
	);
	assert.equal( comparisonValueText( 100 ), 'All live three.js; slim replay is hidden' );

} );

test( 'comparison frames receive side-specific dynamic alternatives', () => {

	assert.equal(
		comparisonImageAlt( 'materials · clearcoat', COMPARISON_SIDE.CAPTURE ),
		'materials · clearcoat: live three.js reference frame',
	);
	assert.equal(
		comparisonImageAlt( 'materials · clearcoat', COMPARISON_SIDE.REPLAY ),
		'materials · clearcoat: precompiled slim replay frame',
	);
	assert.throws( () => comparisonImageAlt( 'example', 'unknown' ), /Unknown comparison side/ );

} );

test( 'solo comparison reports the frame it actually displays after fallback', () => {

	assert.deepEqual(
		resolveSoloFrame( COMPARISON_SIDE.REPLAY, {
			captureSrc: 'capture.webp',
			replaySrc: 'replay.webp',
		} ),
		{ side: COMPARISON_SIDE.REPLAY, src: 'replay.webp' },
	);
	assert.deepEqual(
		resolveSoloFrame( COMPARISON_SIDE.REPLAY, { captureSrc: 'capture.webp' } ),
		{ side: COMPARISON_SIDE.CAPTURE, src: 'capture.webp' },
	);
	assert.deepEqual(
		resolveSoloFrame( COMPARISON_SIDE.CAPTURE, { replaySrc: 'replay.webp' } ),
		{ side: COMPARISON_SIDE.REPLAY, src: 'replay.webp' },
	);
	assert.deepEqual(
		resolveSoloFrame( COMPARISON_SIDE.CAPTURE ),
		{ side: null, src: null },
	);

} );
