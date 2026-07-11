import test from 'node:test';
import assert from 'node:assert/strict';

import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { hashPlainConfigSync } from '../src/graph-hash.js';
import { setupPrecompile } from '../src/setup.js';
import { __resetForTests as resetMarkerForTests } from '../src/precompile-marker.js';

test( 'setupPrecompile hashes auxiliary captures with injected exact Three and shared toolchain versions', async () => {

	resetMarkerForTests();
	const originalFetch = globalThis.fetch;
	const originalThreeVersion = globalThis.__TSLP_THREE_PACKAGE_VERSION__;
	globalThis.__TSLP_THREE_PACKAGE_VERSION__ = '0.184.7';
	globalThis.fetch = async () => ( { ok: true, status: 200, text: async () => '' } );

	class Material {}
	const three = { Material, REVISION: '184' };
	const renderer = {
		backend: {},
		toneMapping: 4,
		toneMappingExposure: 1.25,
		outputColorSpace: 'srgb',
		render() {},
	};
	const scene = { traverse() {} };
	const camera = {};
	const compileTSL = async () => [ {
		materialShape: 'output-transform',
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		uniformPlan: [],
	} ];

	try {

		const setup = setupPrecompile( {
			three,
			renderer,
			scene,
			camera,
			devEndpoint: '/__tsl-precompile/capture',
			aux: { compileTSL },
		} );
		await setup.ready;
		const results = await setup.captureAux();
		const output = results.find( ( result ) => result.shape === 'render-output' );

		assert.ok( output && output.ok, 'render-output capture should complete' );
		assert.equal( output.configHash, hashPlainConfigSync( {
			toneMapping: renderer.toneMapping,
			toneMappingExposure: renderer.toneMappingExposure,
			outputColorSpace: renderer.outputColorSpace,
		}, {
			shape: 'render-output',
			threeVersion: '0.184.7',
			pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
		} ) );

	} finally {

		globalThis.fetch = originalFetch;
		if ( originalThreeVersion === undefined ) delete globalThis.__TSLP_THREE_PACKAGE_VERSION__;
		else globalThis.__TSLP_THREE_PACKAGE_VERSION__ = originalThreeVersion;
		resetMarkerForTests();

	}

} );
