import test from 'node:test';
import assert from 'node:assert/strict';

import { uniform } from '../src/slim-stubs.js';
import {
	clearLiveUniformRegistryForTests,
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
