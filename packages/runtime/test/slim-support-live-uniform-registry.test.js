import test from 'node:test';
import assert from 'node:assert/strict';

import { uniform } from '../src/slim-stubs.js';
import {
	clearLiveUniformRegistryForTests,
	getLiveUniformNodeIdentity,
	listLiveUniformNodes,
	registerLiveUniformNode,
} from '../src/slim-support/live-uniform-registry.js';

test( 'live uniform registry deduplicates nodes and preserves creation order', () => {

	clearLiveUniformRegistryForTests();
	const first = { isUniformNode: true, value: 1 };
	const second = { isUniformNode: true, value: 2 };
	registerLiveUniformNode( first );
	registerLiveUniformNode( second );
	registerLiveUniformNode( first );
	assert.deepEqual( listLiveUniformNodes(), [ first, second ] );
	clearLiveUniformRegistryForTests();

} );

test( 'slim uniform factory registers closure-only UniformNodes', () => {

	clearLiveUniformRegistryForTests();
	const first = uniform( - 0.2 );
	const second = uniform( - 0.2 );
	assert.deepEqual( listLiveUniformNodes(), [ first, second ] );
	clearLiveUniformRegistryForTests();

} );

test( 'live uniform registry stamps stable call-site instance identity after generic registration', () => {

	clearLiveUniformRegistryForTests();
	const first = registerLiveUniformNode( { isUniformNode: true, value: 0 } );
	registerLiveUniformNode( first, 'uniform-callsite@1#src/reduce.js#4', 0 );
	const second = registerLiveUniformNode( { isUniformNode: true, value: 0 }, 'uniform-callsite@1#src/reduce.js#4', 1 );
	assert.equal( getLiveUniformNodeIdentity( first ), 'uniform-callsite@1#src/reduce.js#4#0' );
	assert.equal( getLiveUniformNodeIdentity( second ), 'uniform-callsite@1#src/reduce.js#4#1' );
	assert.deepEqual( listLiveUniformNodes(), [ first, second ] );
	clearLiveUniformRegistryForTests();
	assert.equal( getLiveUniformNodeIdentity( first ), null );

} );
