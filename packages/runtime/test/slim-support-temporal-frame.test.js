import test from 'node:test';
import assert from 'node:assert/strict';

import {
	getTemporalFrameState,
	logicalFrameKey,
	shouldAdvanceTemporalState,
	withTemporalFrame,
} from '../src/slim-support/temporal-frame.js';

test( 'withTemporalFrame shares one logical frame across renderers and restores state', () => {

	const slim = {};
	const full = {};
	const result = withTemporalFrame( [ slim, full, slim ], { frameId: 12, time: 0.5 }, ( state ) => {

		assert.equal( getTemporalFrameState( slim ), state );
		assert.equal( getTemporalFrameState( full ), state );
		assert.equal( logicalFrameKey( { renderer: slim, frameId: 99 } ), 12 );
		assert.equal( shouldAdvanceTemporalState( { renderer: full } ), true );
		return 'ok';

	} );
	assert.equal( result, 'ok' );
	assert.equal( getTemporalFrameState( slim ), null );
	assert.equal( getTemporalFrameState( full ), null );

} );

test( 'withTemporalFrame supports nested non-advancing and async scopes', async () => {

	const renderer = {};
	await withTemporalFrame( renderer, { frameId: 3 }, async ( outer ) => {

		assert.equal( getTemporalFrameState( renderer ), outer );
		await withTemporalFrame( renderer, { frameId: 3, advance: false }, async () => {

			assert.equal( logicalFrameKey( { renderer, frameId: 400 } ), 3 );
			assert.equal( shouldAdvanceTemporalState( { renderer } ), false );
			await Promise.resolve();

		} );
		assert.equal( getTemporalFrameState( renderer ), outer );

	} );
	assert.equal( getTemporalFrameState( renderer ), null );

} );

test( 'withTemporalFrame restores state after callback failure', () => {

	const renderer = {};
	assert.throws( () => withTemporalFrame( renderer, { frameId: 1 }, () => {

		throw new Error( 'expected' );

	} ), /expected/ );
	assert.equal( getTemporalFrameState( renderer ), null );

} );
