import test from 'node:test';
import assert from 'node:assert/strict';

import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { createRendererOutputConfig } from '@tsl-precompile/contract/output-config';
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
		currentColorSpace: 'srgb',
		outputColorSpace: 'srgb',
		getOutputRenderTarget: () => null,
		render() {},
	};
	const scene = { traverse() {} };
	const camera = {};
	const compileTSL = async ( _renderer, _scene, _camera, options = {} ) => {

		assert.equal( options.captureRendererOutput, true );
		const artifact = {
			materialShape: 'output-transform',
			vertexShader: 'vertex',
			fragmentShader: 'fragment',
			uniformPlan: [ { name: 'object', textures: [ {
				bindingKind: 'sampled-texture',
				textureType: '2d',
				source: { kind: 'artifact.texture', textureUuid: 'output', mapping: 300 },
			} ] } ],
		};
		const artifacts = [ artifact ];
		Object.defineProperty( artifacts, 'renderOutputCapture', { value: {
			artifact,
			replayConfig: createRendererOutputConfig( renderer, { isArrayTexture: false } ),
		} } );
		return artifacts;

	};

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
		assert.equal( output.configHash, hashPlainConfigSync( createRendererOutputConfig( renderer, { isArrayTexture: false } ), {
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
