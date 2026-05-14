import test from 'node:test';
import assert from 'node:assert/strict';

import { precompileAuxiliary } from '../src/aux-marker.js';

function silentInfo() {

	const original = console.info;
	console.info = () => {};
	return () => { console.info = original; };

}

function silentWarn() {

	const original = console.warn;
	console.warn = () => {};
	return () => { console.warn = original; };

}

test( 'precompileAuxiliary returns [] without endpoint instead of throwing', async () => {

	const restore = silentWarn();
	try {

		const result = await precompileAuxiliary( {}, { traverse: () => {} }, {}, {} );
		assert.deepEqual( result, [] );

	} finally { restore(); }

} );

test( 'precompileAuxiliary no-ops cleanly in production-like envs (compileTSL unresolvable)', async () => {

	// In the runtime test env, `vite-plugin-tsl-precompile` is not a peer dep,
	// so `lazyLoadCompileTSL`'s dynamic import fails — the same shape as a
	// production bundle that has stripped compileTSL. Adopters call
	// `precompileAuxiliary` unconditionally; the runtime must silently no-op
	// instead of bubbling the resolution failure into user code.
	const restore = silentInfo();
	try {

		const result = await precompileAuxiliary( {}, { traverse: () => {} }, {}, {
			devEndpoint: '/__tsl-precompile/capture',
			threeVersion: '184',
		} );
		assert.deepEqual( result, [], 'returns empty result list (no captures)' );

	} finally { restore(); }

} );

test( 'precompileAuxiliary prod no-op fires before fetch is attempted', async () => {

	// Locks the contract that the production short-circuit runs *before* any
	// network call. If a future refactor re-orders the checks, a missing dev
	// server would throw `JSON.parse('<')` from an HTML 404 page (P1.8 gap 1).
	const originalFetch = globalThis.fetch;
	let fetchCalled = false;
	globalThis.fetch = async () => { fetchCalled = true; return { ok: false, status: 404, text: async () => '' }; };
	const restore = silentInfo();
	try {

		await precompileAuxiliary(
			{ toneMapping: 0, toneMappingExposure: 1, outputColorSpace: 'srgb' },
			{ traverse: () => {}, backgroundNode: null, background: null },
			{},
			{ devEndpoint: '/__tsl-precompile/capture', threeVersion: '184' },
		);
		assert.equal( fetchCalled, false, 'no fetch attempted in prod-like env' );

	} finally {

		globalThis.fetch = originalFetch;
		restore();

	}

} );
