import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveE2EHarnessSourceFiles } from '../e2e-evidence.mjs';

const adapterSource = readFileSync(
	new URL( '../e2e-capture-setup-adapter.js', import.meta.url ),
	'utf8',
);
const runnerSource = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );
const harnessSourceFiles = resolveE2EHarnessSourceFiles(
	fileURLToPath( new URL( '../../../../', import.meta.url ) ),
);

function loadAdapter( setupDevelopment, root ) {

	const executable = adapterSource
		.replace(
			/^import \{ setupPrecompile as setupDevelopment \} from '\/__tslp_runtime\/setup-development\.js';\s*/m,
			'',
		)
		.replace( /\bexport function /g, 'function ' );
	return Function(
		'setupDevelopment',
		'globalThis',
		`"use strict";\n${ executable }\nreturn { captureSetupOptions, setupPrecompile };`,
	)( setupDevelopment, root );

}

test( 'capture setup adapter forwards the harness endpoint without mutating caller options', () => {

	const calls = [];
	const root = {
		__TSLP_E2E: {
			captureEndpoint: '/__tslp__/capture?example=wow-race',
		},
	};
	const adapter = loadAdapter( options => {

		calls.push( options );
		return { options };

	}, root );
	const renderer = {};
	const callerOptions = { renderer, captureRendererOutput: false };
	const merged = adapter.captureSetupOptions( callerOptions );

	assert.notEqual( merged, callerOptions );
	assert.deepEqual( merged, {
		renderer,
		captureRendererOutput: false,
		devEndpoint: '/__tslp__/capture?example=wow-race',
	} );
	assert.deepEqual( callerOptions, { renderer, captureRendererOutput: false } );
	assert.deepEqual( adapter.setupPrecompile( callerOptions ), { options: merged } );
	assert.deepEqual( calls, [ merged ] );

} );

test( 'capture setup adapter preserves an explicitly supplied endpoint', () => {

	const calls = [];
	const adapter = loadAdapter( options => {

		calls.push( options );
		return options;

	}, {
		__TSLP_E2E: {
			captureEndpoint: '/__tslp__/capture?example=harness',
		},
	} );
	const explicit = {
		renderer: {},
		devEndpoint: '/application-owned-capture',
	};

	assert.equal( adapter.captureSetupOptions( explicit ), explicit );
	assert.equal( adapter.setupPrecompile( explicit ), explicit );
	assert.deepEqual( calls, [ explicit ] );

} );

test( 'capture setup adapter falls through when no harness endpoint exists', () => {

	const adapter = loadAdapter( options => options, {} );
	const options = { renderer: {} };

	assert.equal( adapter.captureSetupOptions( options ), options );
	assert.equal( adapter.captureSetupOptions( null ), null );

} );

test( 'batch server serves and fingerprints the capture-only setup adapter', () => {

	assert.ok(
		harnessSourceFiles.includes(
			fileURLToPath( new URL( '../e2e-capture-setup-adapter.js', import.meta.url ) ),
		),
		'the recursive evidence fingerprint must bind the capture setup adapter',
	);
	assert.match(
		runnerSource,
		/url\.pathname === '\/__tslp_batch\/e2e-capture-setup-adapter\.js'[\s\S]*sendFile\( res, join\( SELF, 'e2e-capture-setup-adapter\.js' \) \)/,
	);
	assert.match(
		adapterSource,
		/from '\/__tslp_runtime\/setup-development\.js'/,
	);
	assert.doesNotMatch( adapterSource, /setup-production|slim-webgpu-replay/ );

} );
