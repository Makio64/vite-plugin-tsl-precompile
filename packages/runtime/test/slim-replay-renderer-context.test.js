import test from 'node:test';
import assert from 'node:assert/strict';

import {
	createReplayRendererContext,
	getReplayRendererHighPrecision,
	setReplayRendererHighPrecision,
} from '../src/slim-replay-renderer-context.js';

test( 'replay renderer contexts own stable cache identity and merged flow data', () => {

	const root = createReplayRendererContext( { root: 1, shared: 'root' } );
	const child = root.context( { child: 2, shared: 'child' } );
	assert.equal( root.isNode, true );
	assert.equal( root.isContextNode, true );
	assert.notEqual( root.id, child.id );
	assert.ok( root.id < 0 && child.id < 0, 'replay ids cannot collide with Three Node ids' );
	assert.equal( root.version, 0 );
	root.needsUpdate = true;
	assert.equal( root.version, 1 );
	assert.deepEqual( child.getFlowContextData(), { root: 1, child: 2, shared: 'root' } );

} );

test( 'high precision is semantic renderer state and invalidates context once per change', () => {

	const renderer = { contextNode: createReplayRendererContext() };
	assert.equal( getReplayRendererHighPrecision( renderer ), false );
	setReplayRendererHighPrecision( renderer, true );
	assert.equal( getReplayRendererHighPrecision( renderer ), true );
	assert.equal( renderer.contextNode.version, 1 );
	setReplayRendererHighPrecision( renderer, true );
	assert.equal( renderer.contextNode.version, 1 );
	setReplayRendererHighPrecision( renderer, false );
	assert.equal( getReplayRendererHighPrecision( renderer ), false );
	assert.equal( renderer.contextNode.version, 2 );

} );

test( 'high precision adopts a foreign context without retaining its graph', () => {

	let flowReads = 0;
	const renderer = {
		contextNode: {
			isNode: true,
			value: { outer: true, shared: 'outer' },
			getFlowContextData() {

				flowReads ++;
				return { outer: true, inherited: true, shared: 'inherited' };

			},
		},
	};
	setReplayRendererHighPrecision( renderer, false );
	assert.equal( renderer.contextNode.isNode, true, 'an idempotent false write preserves a user context' );
	assert.equal( flowReads, 0, 'an idempotent write does not inspect or replace the foreign graph' );
	setReplayRendererHighPrecision( renderer, true );
	assert.equal( renderer.contextNode.isReplayRendererContext, true );
	assert.deepEqual( renderer.contextNode.value, { outer: true, inherited: true, shared: 'inherited' } );
	assert.equal( flowReads, 1 );
	assert.equal( renderer.contextNode.version, 1 );
	assert.throws( () => setReplayRendererHighPrecision( null, true ), /renderer object/ );

} );
