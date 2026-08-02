import test from 'node:test';
import assert from 'node:assert/strict';

import {
	TemporalFrameIdentityError,
	createTemporalNodeFrame,
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
		assert.equal( state.renderId, 12 );
		assert.deepEqual( createTemporalNodeFrame( slim, { context: { pass: true } } ), {
			renderer: slim,
			frameId: 12,
			renderId: 12,
			time: 0.5,
			context: { pass: true },
		} );
		assert.equal( shouldAdvanceTemporalState( { renderer: full } ), true );
		return 'ok';

	} );
	assert.equal( result, 'ok' );
	assert.equal( getTemporalFrameState( slim ), null );
	assert.equal( getTemporalFrameState( full ), null );

} );

test( 'createTemporalNodeFrame preserves explicit render identity and only merges live overrides', () => {

	const renderer = {};
	withTemporalFrame( renderer, { frameId: 'frame', renderId: 'render', time: 1 }, () => {

		const nodeFrame = createTemporalNodeFrame( renderer, {
			frameId: 'ignored',
			renderId: 'ignored',
			time: 2,
			context: { effect: true },
			camera: { ignored: true },
		} );
		assert.deepEqual( nodeFrame, {
			renderer,
			frameId: 'frame',
			renderId: 'render',
			time: 2,
			context: { effect: true },
		} );

	} );
	assert.throws( () => createTemporalNodeFrame( renderer ), TemporalFrameIdentityError );

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

test( 'withTemporalFrame rejects overlapping async scopes without corrupting the active frame', async () => {

	const renderer = {};
	let release;
	const pending = new Promise( ( resolve ) => { release = resolve; } );
	const first = withTemporalFrame( renderer, { frameId: 'first' }, async ( state ) => {

		await pending;
		assert.equal( getTemporalFrameState( renderer ), state );

	} );

	assert.throws(
		() => withTemporalFrame( renderer, { frameId: 'overlap' }, () => undefined ),
		( error ) => error && error.code === 'TSLP_TEMPORAL_FRAME_OVERLAP',
	);
	assert.equal( getTemporalFrameState( renderer ).frameId, 'first' );
	release();
	await first;
	assert.equal( getTemporalFrameState( renderer ), null );

} );

test( 'duplicate ESM instances coordinate overlap rejection and nested restoration', async () => {

	const duplicate = await import( '../src/slim-support/temporal-frame.js?duplicate-temporal-instance' );
	const renderer = {};
	let release;
	const pending = new Promise( ( resolve ) => { release = resolve; } );
	const first = withTemporalFrame( renderer, { frameId: 'first' }, async () => {

		await pending;

	} );

	assert.throws(
		() => duplicate.withTemporalFrame( renderer, { frameId: 'overlap' }, () => undefined ),
		( error ) => error && error.code === 'TSLP_TEMPORAL_FRAME_OVERLAP',
	);
	assert.equal( duplicate.getTemporalFrameState( renderer ).frameId, 'first' );
	release();
	await first;
	assert.equal( getTemporalFrameState( renderer ), null );

	withTemporalFrame( renderer, { frameId: 'outer' }, ( outer ) => {

		duplicate.withTemporalFrame( renderer, { frameId: 'inner' }, () => {

			assert.equal( getTemporalFrameState( renderer ).frameId, 'inner' );

		} );
		assert.equal( getTemporalFrameState( renderer ), outer );

	} );
	assert.equal( duplicate.getTemporalFrameState( renderer ), null );

} );

test( 'withTemporalFrame removes settled async ancestors when nested scopes finish out of order', async () => {

	const renderer = {};
	let releaseInner;
	const innerPending = new Promise( ( resolve ) => { releaseInner = resolve; } );
	let inner;
	const outer = withTemporalFrame( renderer, { frameId: 'outer' }, () => {

		inner = withTemporalFrame( renderer, { frameId: 'inner' }, async () => {

			await innerPending;

		} );
		return Promise.resolve();

	} );

	await outer;
	assert.equal( getTemporalFrameState( renderer ).frameId, 'inner' );
	releaseInner();
	await inner;
	assert.equal( getTemporalFrameState( renderer ), null );

} );

test( 'withTemporalFrame rolls back earlier renderers when scope setup fails', () => {

	const first = {};
	const locked = {};
	const temporalStateKey = Symbol.for( '@tsl-precompile/runtime/temporal-frame@1' );
	const sentinel = { frameId: 'locked' };
	Object.defineProperty( locked, temporalStateKey, {
		value: sentinel,
		configurable: false,
	} );

	assert.throws(
		() => withTemporalFrame( [ first, locked ], { frameId: 'setup-failure' }, () => undefined ),
		TypeError,
	);
	assert.equal( getTemporalFrameState( first ), null );
	assert.equal( getTemporalFrameState( locked ), sentinel );
	assert.doesNotThrow( () => withTemporalFrame( first, { frameId: 'after-failure' }, () => undefined ) );
	assert.equal( getTemporalFrameState( first ), null );

} );

test( 'withTemporalFrame restores state when callback result then-probing throws', () => {

	const renderer = {};
	const invalidThenable = Object.defineProperty( {}, 'then', {
		get() {

			throw new Error( 'broken then getter' );

		},
	} );
	assert.throws(
		() => withTemporalFrame( renderer, { frameId: 'probe-failure' }, () => invalidThenable ),
		/broken then getter/,
	);
	assert.equal( getTemporalFrameState( renderer ), null );

} );
