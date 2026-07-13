import test from 'node:test';
import assert from 'node:assert/strict';

import {
	attachLiveNodeDependency,
	getLiveNodeDependencies,
} from '../src/slim-support/node-dependencies.js';

test( 'live node dependencies deduplicate by identity and update metadata', () => {

	const owner = {};
	const dependency = {};
	assert.equal( attachLiveNodeDependency( owner, dependency, { role: 'first' } ), owner );
	attachLiveNodeDependency( owner, dependency, { role: 'updated' } );
	assert.deepEqual( getLiveNodeDependencies( owner ), [
		{ node: dependency, metadata: { role: 'updated' } },
	] );

} );

test( 'live node dependency sidecars are non-enumerable and non-serializable', () => {

	const owner = { visible: true };
	attachLiveNodeDependency( owner, { hidden: true }, { role: 'input' } );
	assert.deepEqual( Object.keys( owner ), [ 'visible' ] );
	assert.equal( JSON.stringify( owner ), '{"visible":true}' );

} );

test( 'live node dependency reads return copies and invalid inputs are no-ops', () => {

	const owner = {};
	const dependency = {};
	attachLiveNodeDependency( owner, dependency );
	const first = getLiveNodeDependencies( owner );
	first.length = 0;
	assert.equal( getLiveNodeDependencies( owner ).length, 1 );
	assert.equal( attachLiveNodeDependency( owner, null ), owner );
	assert.equal( attachLiveNodeDependency( Object.freeze( {} ), dependency ) instanceof Object, true );
	assert.deepEqual( getLiveNodeDependencies( null ), [] );

} );
