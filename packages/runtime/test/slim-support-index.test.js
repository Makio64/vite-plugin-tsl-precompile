import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as slimSupport from '@tsl-precompile/runtime/slim-support';
import { createSlimSceneSupport } from '../src/slim-support/scene-support.js';
import { createFullRendererFallback } from '../src/slim-support/full-renderer-fallback.js';

test( 'slim-support package subpath resolves through the public export map', () => {

	assert.equal( slimSupport.createSlimSceneSupport, createSlimSceneSupport );
	assert.equal( slimSupport.createFullRendererFallback, createFullRendererFallback );
	assert.equal( typeof slimSupport.syncComputeStorageOutputs, 'function' );
	assert.equal( typeof slimSupport.renderPassWithFullRenderer, 'function' );
	assert.equal( typeof slimSupport.preparePrecompiledPostprocess, 'function' );
	assert.equal( typeof slimSupport.recordDiagnostic, 'function' );

} );

test( 'runtime package exports the stable slim-support barrel with types', () => {

	const pkg = JSON.parse( readFileSync( new URL( '../package.json', import.meta.url ), 'utf8' ) );
	assert.deepEqual( pkg.exports[ './slim-support' ], {
		types: './types/slim-support/index.d.ts',
		default: './src/slim-support/index.js',
	} );
	assert.equal( pkg.exports[ './slim-support/postprocess-wire' ].types, './types/slim-support/postprocess-wire.d.ts' );
	assert.equal( pkg.exports[ './slim-support/render-fallback-registry' ].types, './types/slim-support/render-fallback-registry.d.ts' );
	assert.equal( pkg.exports[ './slim-support/diagnostics' ].types, './types/slim-support/diagnostics.d.ts' );

} );
