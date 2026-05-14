import test from 'node:test';
import assert from 'node:assert/strict';

import { loadInspectorOptional, __setProdLikeForTests } from '../src/inspector-loader.js';

test( 'loadInspectorOptional returns null in production-like environments', async () => {

	__setProdLikeForTests( true );
	try {

		const result = await loadInspectorOptional();
		assert.equal( result, null );

	} finally { __setProdLikeForTests( null ); }

} );

test( 'loadInspectorOptional returns null in test env when Inspector addon is not resolvable', async () => {

	// In the runtime test env, `three/addons/inspector/Inspector.js` is NOT
	// pre-bundled. The detection probe also fails (same package isn't there).
	// Both paths should resolve to null cleanly, not throw.
	__setProdLikeForTests( false );
	try {

		const result = await loadInspectorOptional();
		assert.equal( result, null );

	} finally { __setProdLikeForTests( null ); }

} );

test( 'loadInspectorOptional auto-detects environment via dynamic import probe', async () => {

	__setProdLikeForTests( null );
	// In Node test env neither `vite-plugin-tsl-precompile` nor the inspector
	// addon resolves; detection should pick the production-like path and
	// return null without throwing.
	const result = await loadInspectorOptional();
	assert.equal( result, null );

} );
