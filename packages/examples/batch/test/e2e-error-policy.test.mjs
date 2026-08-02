import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
	coverageConfig,
	expectedCaptureErrorPatternsForExample,
	expectedCaptureErrorSourcesForExample,
	expectedReplayErrorSourcesForExample,
} from '../psnr.mjs';

const runner = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );

test( 'capture and replay error exceptions are case-scoped configuration only', () => {

	assert.doesNotMatch( runner, /function isIgnorableCaptureError/ );
	assert.doesNotMatch( runner, /function isIgnorableReplayError/ );
	assert.match( runner, /expectedCaptureErrorPatternsForExample\( name \)/ );
	assert.match( runner, /capture\.errors\.filter\( \( error \) => ! expectedCapturePatterns\.some/ );
	assert.match( runner, /artifactCapture\.errors\.filter\( \( error \) => ! expectedCapturePatterns\.some/ );
	assert.match( runner, /expectedReplayErrorPatternsForExample\( name \)/ );
	assert.deepEqual( expectedCaptureErrorSourcesForExample( 'webgpu_clearcoat.html' ), [] );
	assert.deepEqual( expectedCaptureErrorPatternsForExample( 'webgpu_clearcoat.html' ), [] );
	assert.deepEqual( expectedReplayErrorSourcesForExample( 'webgpu_hdr.html' ), [] );
	assert.deepEqual( coverageConfig.pixelGate.expectedCaptureErrors, {} );
	assert.deepEqual( coverageConfig.pixelGate.expectedReplayErrors, {} );

} );

test( 'generic resource failures are no longer globally discarded', () => {

	assert.doesNotMatch( runner, /errors\.filter\([^)]*Failed to load resource/ );
	assert.match( runner, /installBrowserFailureCollector\( page, \{ pageUrl \} \)/ );
	assert.match( runner, /\[ \.\.\.browserFailures\.messages\(\), \.\.\.errors \]/ );
	assert.doesNotMatch( runner, /faviconOnly = \/favicon/ );
	assert.doesNotMatch( runner, /harness asset failed:/ );

} );
