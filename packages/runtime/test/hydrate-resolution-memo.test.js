/**
 * Frame-scoped resolution memo — P1.9 first wedge.
 *
 * The contract under test: N render objects sharing one material trigger ONE
 * underlying `resolveTextureBinding` strategy-chain run per (artifact,
 * binding, material) per render, not N. A new frame, a different
 * avoidTexture, a different material, or a missing frame stamp must all
 * bypass / refresh the memo.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFrameScopedResolutionMemo } from '../src/hydrate/rebinders/resolution-memo.js';

function makeCountingResolver( result = { isTexture: true } ) {

	const calls = [];
	const resolve = ( artifact, groupName, bindingName, material, options ) => {

		calls.push( { artifact, groupName, bindingName, material, options } );
		return result;

	};
	return { calls, resolve };

}

test( 'memo: resolution-call count is independent of instance count within one render', () => {

	const { calls, resolve } = makeCountingResolver();
	const memoized = createFrameScopedResolutionMemo( resolve );
	const artifact = { name: 'shared' };
	const material = { isMaterial: true };
	const frame = { renderId: 7, frameId: 3 };

	// 200 render objects of one material each run their rebinder this render.
	let last = null;
	for ( let i = 0; i < 200; i ++ ) {

		last = memoized( artifact, 'group', 'map', material, { frame } );

	}

	assert.equal( calls.length, 1, 'strategy chain must run once, not per instance' );
	assert.ok( last && last.isTexture, 'memoized value is returned to every caller' );

} );

test( 'memo: a new render re-resolves', () => {

	const { calls, resolve } = makeCountingResolver();
	const memoized = createFrameScopedResolutionMemo( resolve );
	const artifact = { name: 'shared' };
	const material = {};

	memoized( artifact, 'group', 'map', material, { frame: { renderId: 1, frameId: 1 } } );
	memoized( artifact, 'group', 'map', material, { frame: { renderId: 1, frameId: 1 } } );
	memoized( artifact, 'group', 'map', material, { frame: { renderId: 2, frameId: 1 } } );

	assert.equal( calls.length, 2, 'renderId change must invalidate' );

} );

test( 'memo: distinct bindings, materials, and avoidTexture identities do not share slots', () => {

	const { calls, resolve } = makeCountingResolver();
	const memoized = createFrameScopedResolutionMemo( resolve );
	const artifact = { name: 'shared' };
	const materialA = {};
	const materialB = {};
	const frame = { renderId: 1, frameId: 1 };
	const rtTexture = { isTexture: true };

	memoized( artifact, 'group', 'map', materialA, { frame } );
	memoized( artifact, 'group', 'normalMap', materialA, { frame } );
	memoized( artifact, 'group', 'map', materialB, { frame } );
	memoized( artifact, 'group', 'map', materialA, { frame, avoidTexture: rtTexture } );

	assert.equal( calls.length, 4 );

	// Same-options repeats hit. (A binding is classified into exactly one
	// rebinder bag, so within a render its avoidTexture identity is stable —
	// the memo holds one slot per binding and refreshes when it changes.)
	memoized( artifact, 'group', 'normalMap', materialA, { frame } );
	memoized( artifact, 'group', 'map', materialB, { frame } );
	memoized( artifact, 'group', 'map', materialA, { frame, avoidTexture: rtTexture } );
	assert.equal( calls.length, 4 );

} );

test( 'memo: calls without a stamped frame pass through every time', () => {

	const { calls, resolve } = makeCountingResolver();
	const memoized = createFrameScopedResolutionMemo( resolve );
	const artifact = { name: 'shared' };
	const material = {};

	memoized( artifact, 'group', 'map', material );
	memoized( artifact, 'group', 'map', material, { frame: {} } );
	memoized( artifact, 'group', 'map', material, null );

	assert.equal( calls.length, 3, 'hydration-time calls must not be memoized' );

} );

test( 'memo: null resolution results are memoized too (no per-instance retry storm)', () => {

	const { calls } = makeCountingResolver();
	const memoized = createFrameScopedResolutionMemo( ( ...args ) => {

		calls.push( args );
		return null;

	} );
	const artifact = { name: 'missing-texture' };
	const material = {};
	const frame = { renderId: 5, frameId: 5 };

	for ( let i = 0; i < 50; i ++ ) memoized( artifact, 'group', 'map', material, { frame } );
	assert.equal( calls.length, 1 );

} );
