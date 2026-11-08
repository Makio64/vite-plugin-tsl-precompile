import test from 'node:test';
import assert from 'node:assert/strict';

import { loadInspectorOptional, __setProdLikeForTests } from '../src/inspector-loader.js';

// r186's Inspector addon touches localStorage at module load and cannot be imported in Node;
// the r187dev addon guards its storage access and imports cleanly. Dev-like loading must return
// exactly what the addon import yields, and never throw.
const NODE_IMPORTABLE_INSPECTOR = await import( 'three/addons/inspector/Inspector.js' ).then( ( mod ) => mod.Inspector || null, () => null );

test( 'loadInspectorOptional returns null in production-like environments', async () => {

	__setProdLikeForTests( true );
	try {

		const result = await loadInspectorOptional();
		assert.equal( result, null );

	} finally { __setProdLikeForTests( null ); }

} );

test( 'loadInspectorOptional returns null in test env when Inspector addon is not resolvable', async () => {

	// In the runtime test env, `three/addons/inspector/Inspector.js` is NOT
	// pre-bundled. When Node cannot evaluate the addon the loader resolves to
	// null cleanly instead of throwing.
	__setProdLikeForTests( false );
	try {

		const result = await loadInspectorOptional();
		assert.equal( result, NODE_IMPORTABLE_INSPECTOR );

	} finally { __setProdLikeForTests( null ); }

} );

test( 'loadInspectorOptional auto-detects environment via dynamic import probe', async () => {

	__setProdLikeForTests( null );
	// Detection must not throw. In this workspace the plugin probe resolves, so
	// the result is whatever the addon import yields in Node (see above).
	const result = await loadInspectorOptional();
	assert.equal( result, NODE_IMPORTABLE_INSPECTOR );

} );
