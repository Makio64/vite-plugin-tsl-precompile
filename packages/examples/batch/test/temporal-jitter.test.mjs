import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	DEFAULT_ACTIVE_JITTER_SAMPLES,
	synchronizeTemporalJitterNode,
	temporalJitterFrameId,
	temporalJitterIndexForFrameId,
} from '../temporal-jitter.mjs';

test( 'logical frame IDs map to Three temporal-AA Halton samples', () => {

	assert.equal( DEFAULT_ACTIVE_JITTER_SAMPLES, 31 );
	assert.equal( temporalJitterIndexForFrameId( 0 ), 0 );
	assert.equal( temporalJitterIndexForFrameId( 1 ), 0 );
	assert.equal( temporalJitterIndexForFrameId( 2 ), 1 );
	assert.equal( temporalJitterIndexForFrameId( 31 ), 30 );
	assert.equal( temporalJitterIndexForFrameId( 32 ), 0 );
	assert.equal( temporalJitterIndexForFrameId( Number.NaN ), 0 );

} );

test( 'temporal nodes advance once per logical tick and ignore extra clears', () => {

	const root = {
		__tslpRafTick: 0,
		__tslpAnimationLoopCalls: 1,
		__tslpFrameCallbackCount: 1,
		__tslpHarnessDiagnostics: {},
	};
	const observed = [];
	const node = {
		constructor: { type: 'TRAANode' },
		_jitterIndex: 0,
		setViewOffset() {

			observed.push( this._jitterIndex );

		},
		clearViewOffset() {

			this._jitterIndex = ( this._jitterIndex + 1 ) % DEFAULT_ACTIVE_JITTER_SAMPLES;

		},
	};

	assert.equal( synchronizeTemporalJitterNode( node, { root, marker: '__testSynchronized' } ), true );
	assert.equal( synchronizeTemporalJitterNode( node, { root, marker: '__testSynchronized' } ), false );
	node.setViewOffset( 640, 480 );
	node.clearViewOffset();
	node.setViewOffset( 640, 480 );
	node.clearViewOffset();
	assert.equal( node._jitterIndex, 0 );

	root.__tslpAnimationLoopCalls = 2;
	root.__tslpFrameCallbackCount = 2;
	node.setViewOffset( 640, 480 );
	node.clearViewOffset();
	assert.equal( node._jitterIndex, 1 );
	assert.deepEqual( observed, [ 0, 0, 1 ] );
	assert.deepEqual( root.__tslpHarnessDiagnostics.temporalJitter.samples, [
		{ type: 'TRAANode', frameId: 1, index: 0 },
		{ type: 'TRAANode', frameId: 2, index: 1 },
	] );
	assert.equal( root.__tslpHarnessDiagnostics.temporalJitter.setViewOffsetCalls, 3 );
	assert.equal( root.__tslpHarnessDiagnostics.temporalJitter.clearViewOffsetCalls, 3 );

} );

test( 'logical callback identity takes precedence while rAF time is clamped', () => {

	const root = { __tslpRafTick: 0, __tslpAnimationLoopCalls: 5, __tslpFrameCallbackCount: 9 };
	assert.equal( temporalJitterFrameId( root ), 9 );
	delete root.__tslpFrameCallbackCount;
	assert.equal( temporalJitterFrameId( root ), 5 );
	delete root.__tslpAnimationLoopCalls;
	root.__tslpRafTick = 3;
	assert.equal( temporalJitterFrameId( root ), 3 );

} );

test( 'TRAA exposes its unjittered projection only while the pipeline is active', () => {

	const velocityProjection = Symbol.for( '@tsl-precompile/runtime/velocity-projection-matrix@1' );
	const projectionMatrix = { elements: [ 1 ] };
	const camera = {};
	const node = {
		camera,
		_originalProjectionMatrix: projectionMatrix,
		_jitterIndex: 0,
		setViewOffset() {},
		clearViewOffset() {},
	};
	synchronizeTemporalJitterNode( node, { root: { __tslpFrameCallbackCount: 1 } } );
	node.setViewOffset( 640, 480 );
	assert.equal( camera[ velocityProjection ], projectionMatrix );
	node.clearViewOffset();
	assert.equal( camera[ velocityProjection ], undefined );

} );
