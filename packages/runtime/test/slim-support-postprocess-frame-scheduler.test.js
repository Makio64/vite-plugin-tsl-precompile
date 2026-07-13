import test from 'node:test';
import assert from 'node:assert/strict';

import {
	POSTPROCESS_FRAME_ROLES,
	createPostprocessFrameScheduler,
} from '../src/slim-support/postprocess-frame-scheduler.js';
import {
	TemporalFrameIdentityError,
	withTemporalFrame,
} from '../src/slim-support/temporal-frame.js';

function inFrame( renderer, options, callback ) {

	return withTemporalFrame( renderer, options, callback );

}

test( 'scheduler is stable per owner and isolates claims between owners', () => {

	const renderer = {};
	const firstOwner = {};
	const secondOwner = {};
	const first = createPostprocessFrameScheduler( firstOwner );
	assert.equal( createPostprocessFrameScheduler( firstOwner ), first );
	assert.notEqual( createPostprocessFrameScheduler( secondOwner ), first );

	const identity = {};
	let calls = 0;
	inFrame( renderer, { frameId: 1, renderId: 4 }, () => {

		assert.equal( first.begin( renderer ).run( identity, 'effect', () => ++ calls ), 1 );
		assert.equal( first.begin( renderer ).run( identity, 'effect', () => ++ calls ), 1 );
		assert.equal( createPostprocessFrameScheduler( secondOwner ).begin( renderer ).run( identity, 'effect', () => ++ calls ), 2 );

	} );
	assert.equal( calls, 2 );

} );

test( 'claims persist across separate temporal scopes with the same frame and render IDs', () => {

	const slimRenderer = {};
	const fullRenderer = {};
	const scheduler = createPostprocessFrameScheduler( {} );
	const identity = {};
	let calls = 0;
	for ( const renderer of [ slimRenderer, fullRenderer ] ) {

		inFrame( renderer, { frameId: 'frame', renderId: 8 }, () => {

			assert.equal( scheduler.begin( renderer ).run( identity, POSTPROCESS_FRAME_ROLES.PRODUCER, () => ++ calls ), 1 );

		} );

	}
	inFrame( slimRenderer, { frameId: 'frame', renderId: 9 }, () => {

		assert.equal( scheduler.begin( slimRenderer ).run( identity, POSTPROCESS_FRAME_ROLES.PRODUCER, () => ++ calls ), 2 );

	} );
	assert.equal( calls, 2 );

} );

test( 'role conflicts fail closed without replacing the successful claim', () => {

	const renderer = {};
	const scheduler = createPostprocessFrameScheduler( {} );
	inFrame( renderer, { frameId: 2 }, () => {

		const frame = scheduler.begin( renderer );
		const identity = {};
		assert.equal( frame.run( identity, POSTPROCESS_FRAME_ROLES.PRODUCER, () => 'ready' ), 'ready' );
		assert.equal( frame.run( identity, POSTPROCESS_FRAME_ROLES.CONSUMER, () => 'wrong' ), false );
		assert.equal( frame.getStatus( identity ).role, POSTPROCESS_FRAME_ROLES.PRODUCER );
		assert.equal( frame.getStatus( identity ).status, 'succeeded' );
		assert.deepEqual( frame.getConflicts(), [ {
			identity,
			claimedRole: POSTPROCESS_FRAME_ROLES.PRODUCER,
			requestedRole: POSTPROCESS_FRAME_ROLES.CONSUMER,
		} ] );

	} );

} );

test( 'false and thrown callbacks release a same-role claim for retry', () => {

	const renderer = {};
	const scheduler = createPostprocessFrameScheduler( {} );
	inFrame( renderer, { frameId: 3, renderId: 5 }, () => {

		const frame = scheduler.begin( renderer );
		const falseIdentity = {};
		assert.equal( frame.run( falseIdentity, 'producer', () => false ), false );
		assert.equal( frame.getStatus( falseIdentity ).status, 'failed' );
		assert.equal( frame.run( falseIdentity, 'producer', () => true ), true );
		assert.equal( frame.getStatus( falseIdentity ).attempts, 2 );

		const thrownIdentity = {};
		assert.throws( () => frame.run( thrownIdentity, 'producer', () => {

			throw new Error( 'retry me' );

		} ), /retry me/ );
		assert.equal( frame.run( thrownIdentity, 'producer', () => 'recovered' ), 'recovered' );
		assert.equal( frame.getStatus( thrownIdentity ).attempts, 2 );

	} );

} );

test( 'concurrent async callers share in-flight work and rejection releases it', async () => {

	const renderer = {};
	const scheduler = createPostprocessFrameScheduler( {} );
	let resolveWork;
	let calls = 0;
	await inFrame( renderer, { frameId: 4, renderId: 4 }, async () => {

		const frame = scheduler.begin( renderer );
		const identity = {};
		const first = frame.run( identity, 'effect', () => {

			calls ++;
			return new Promise( ( resolve ) => { resolveWork = resolve; } );

		} );
		const second = frame.run( identity, 'effect', () => ++ calls );
		assert.equal( second, first );
		resolveWork( 'done' );
		assert.equal( await first, 'done' );
		assert.equal( calls, 1 );

		const rejectedIdentity = {};
		await assert.rejects( frame.run( rejectedIdentity, 'effect', () => Promise.reject( new Error( 'nope' ) ) ), /nope/ );
		assert.equal( frame.getStatus( rejectedIdentity ).status, 'failed' );
		assert.equal( await frame.run( rejectedIdentity, 'effect', async () => 'retry' ), 'retry' );
		assert.equal( frame.getStatus( rejectedIdentity ).attempts, 2 );

	} );

} );

test( 'failed producers are observable and block downstream work until retry succeeds', () => {

	const renderer = {};
	const scheduler = createPostprocessFrameScheduler( {} );
	inFrame( renderer, { frameId: 5, renderId: 6 }, () => {

		const frame = scheduler.begin( renderer );
		const producer = {};
		const consumer = {};
		let consumerCalls = 0;
		assert.equal( frame.run( producer, 'producer', () => false ), false );
		assert.equal( frame.getStatus( producer ).reason, 'callback-returned-false' );
		assert.equal( frame.run( consumer, 'consumer', () => ++ consumerCalls, { dependsOn: [ producer ] } ), false );
		assert.equal( frame.getStatus( consumer ).status, 'blocked' );
		assert.equal( frame.getStatus( consumer ).blockedBy[ 0 ].status, 'failed' );
		assert.equal( consumerCalls, 0 );

		assert.equal( frame.run( producer, 'producer', () => true ), true );
		assert.equal( frame.run( consumer, 'consumer', () => ++ consumerCalls, { dependsOn: [ producer ] } ), 1 );
		assert.equal( frame.hasSucceeded( consumer, 'consumer' ), true );

	} );

} );

test( 'begin fails closed when the active temporal scope has no complete identity', () => {

	const renderer = {};
	const scheduler = createPostprocessFrameScheduler( {} );
	assert.throws( () => scheduler.begin( renderer ), TemporalFrameIdentityError );
	inFrame( renderer, { renderId: 1 }, () => {

		assert.throws( () => scheduler.begin( renderer ), /both frameId and renderId/ );

	} );

} );
