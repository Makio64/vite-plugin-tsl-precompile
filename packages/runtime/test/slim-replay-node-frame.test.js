import test from 'node:test';
import assert from 'node:assert/strict';

import ReplayNodeFrame from '../src/slim-replay-node-frame.js';

const PHASES = Object.freeze( [
	{ dispatch: 'updateBeforeNode', type: 'getUpdateBeforeType', callback: 'updateBefore' },
	{ dispatch: 'updateNode', type: 'getUpdateType', callback: 'update' },
	{ dispatch: 'updateAfterNode', type: 'getUpdateAfterType', callback: 'updateAfter' },
] );

function updateNode( phase, updateType, callback, reference = {} ) {

	return {
		[ phase.type ]: () => updateType,
		updateReference: () => reference,
		[ phase.callback ]: callback,
	};

}

test( 'replay NodeFrame starts with the renderer-facing NodeFrame surface', () => {

	const frame = new ReplayNodeFrame();
	assert.deepEqual( {
		time: frame.time,
		deltaTime: frame.deltaTime,
		frameId: frame.frameId,
		renderId: frame.renderId,
		renderer: frame.renderer,
		material: frame.material,
		camera: frame.camera,
		object: frame.object,
		scene: frame.scene,
		lastTime: frame.lastTime,
	}, {
		time: 0,
		deltaTime: 0,
		frameId: 0,
		renderId: 0,
		renderer: null,
		material: null,
		camera: null,
		object: null,
		scene: null,
		lastTime: undefined,
	} );
	assert.ok( frame.updateMap instanceof WeakMap );
	assert.ok( frame.updateBeforeMap instanceof WeakMap );
	assert.ok( frame.updateAfterMap instanceof WeakMap );

} );

test( 'replay NodeFrame preserves frame, render, object, and inert update cadence', () => {

	const frame = new ReplayNodeFrame();
	frame.frameId = 1;
	frame.renderId = 1;
	let frameCalls = 0;
	let renderCalls = 0;
	let objectCalls = 0;
	let inertReferences = 0;
	const frameNode = updateNode( PHASES[ 1 ], 'frame', () => frameCalls ++ );
	const renderNode = updateNode( PHASES[ 1 ], 'render', () => renderCalls ++ );
	const objectNode = updateNode( PHASES[ 1 ], 'object', () => objectCalls ++ );
	const inertNode = {
		getUpdateType: () => 'none',
		updateReference: () => { inertReferences ++; return {}; },
		update: () => assert.fail( 'none must not update' ),
	};

	for ( let i = 0; i < 2; i ++ ) {

		frame.updateNode( frameNode );
		frame.updateNode( renderNode );
		frame.updateNode( objectNode );
		frame.updateNode( inertNode );

	}
	assert.deepEqual( { frameCalls, renderCalls, objectCalls, inertReferences }, {
		frameCalls: 1,
		renderCalls: 1,
		objectCalls: 2,
		inertReferences: 2,
	} );

	frame.frameId ++;
	frame.renderId ++;
	frame.updateNode( frameNode );
	frame.updateNode( renderNode );
	assert.deepEqual( { frameCalls, renderCalls }, { frameCalls: 2, renderCalls: 2 } );

} );

test( 'replay NodeFrame deduplicates nodes that share an update reference', () => {

	const frame = new ReplayNodeFrame();
	frame.frameId = 1;
	const reference = {};
	const calls = [];
	frame.updateNode( updateNode( PHASES[ 1 ], 'frame', () => calls.push( 'first' ), reference ) );
	frame.updateNode( updateNode( PHASES[ 1 ], 'frame', () => calls.push( 'second' ), reference ) );
	assert.deepEqual( calls, [ 'first' ] );

} );

test( 'replay NodeFrame retries false updates in every phase', () => {

	for ( const phase of PHASES ) {

		const frame = new ReplayNodeFrame();
		frame.frameId = 1;
		let calls = 0;
		const node = updateNode( phase, 'frame', () => ++ calls === 1 ? false : true );
		frame[ phase.dispatch ]( node );
		frame[ phase.dispatch ]( node );
		frame[ phase.dispatch ]( node );
		assert.equal( calls, 2, phase.dispatch );

	}

} );

test( 'replay NodeFrame preserves pre-update and post-update throw stamping', () => {

	const beforeFrame = new ReplayNodeFrame();
	beforeFrame.renderId = 1;
	let beforeCalls = 0;
	const before = updateNode( PHASES[ 0 ], 'render', () => {

		beforeCalls ++;
		throw new Error( 'before failed' );

	} );
	assert.throws( () => beforeFrame.updateBeforeNode( before ), /before failed/ );
	assert.doesNotThrow( () => beforeFrame.updateBeforeNode( before ) );
	assert.equal( beforeCalls, 1, 'updateBefore stamps before invoking the callback' );

	for ( const phase of PHASES.slice( 1 ) ) {

		const frame = new ReplayNodeFrame();
		frame.renderId = 1;
		let calls = 0;
		const node = updateNode( phase, 'render', () => {

			if ( ++ calls === 1 ) throw new Error( 'post failed' );
			return true;

		} );
		assert.throws( () => frame[ phase.dispatch ]( node ), /post failed/ );
		assert.doesNotThrow( () => frame[ phase.dispatch ]( node ) );
		frame[ phase.dispatch ]( node );
		assert.equal( calls, 2, phase.dispatch );

	}

} );

test( 'replay NodeFrame advances elapsed time and frame identity', () => {

	const frame = new ReplayNodeFrame();
	frame.update();
	assert.equal( frame.frameId, 1 );
	assert.ok( Number.isFinite( frame.lastTime ) );
	assert.ok( frame.deltaTime >= 0 );
	assert.equal( frame.time, frame.deltaTime );

} );
