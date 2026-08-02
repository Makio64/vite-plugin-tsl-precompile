import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
	BROWSER_STABILIZATION_POLICY_IDS,
	browserStabilizationPolicyForExample,
	canvasOrderForExample,
} from '../e2e-browser-stabilization-policy.mjs';

const runnerSource = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );

test( 'browser stabilization is an immutable, disclosed registry', () => {

	assert.deepEqual( BROWSER_STABILIZATION_POLICY_IDS, [
		'bitonic-canvas-position-identity-v1',
		'compute-audio-representative-spectrum-v1',
		'storage-buffer-backend-canvas-identity-v1',
		'texture-gather-backend-canvas-identity-v1',
		'texturegrad-webgpu-canvas-identity-v2',
		'video-decoder-representative-frame-v1',
		'video-panorama-representative-frame-v1',
	] );

	const audio = browserStabilizationPolicyForExample( 'webgpu_compute_audio.html' );
	assert.equal( audio.installAudioAnalyserReadiness, true );
	assert.deepEqual( audio.modeScope, [ 'stock', 'capture', 'replay' ] );
	assert.ok( audio.reason.length > 20 );
	assert.ok( Object.isFrozen( audio ) );
	assert.ok( Object.isFrozen( audio.modeScope ) );

	assert.equal( browserStabilizationPolicyForExample( 'webgpu_materials.html' ), null );

} );

test( 'canvas identity choices come from the shared policy registry', () => {

	assert.equal( canvasOrderForExample( 'webgpu_texturegrad.html' ), 'webgpu-backend-first' );
	assert.equal( canvasOrderForExample( 'webgpu_compute_sort_bitonic.html' ), 'horizontal-right-first' );
	assert.equal( canvasOrderForExample( 'webgpu_storage_buffer.html' ), 'webgpu-backend-first' );
	assert.equal( canvasOrderForExample( 'webgpu_texturegather.html' ), 'webgpu-backend-first' );
	assert.equal( canvasOrderForExample( 'webgpu_materials.html' ), 'reverse-document' );

} );

test( 'the runner fingerprints, applies, and reports the stabilization policy without direct case branches', () => {

	assert.match(
		runnerSource,
		/import \{ browserStabilizationPolicyForExample, canvasOrderForExample \} from '\.\/e2e-browser-stabilization-policy\.mjs';/,
	);

	assert.match(
		runnerSource,
		/const HARNESS_SOURCE_FILES = resolveE2EHarnessSourceFiles\( REPO \);/,
		'repository-local static imports must be fingerprinted through the shared recursive closure',
	);

	const canvasStart = runnerSource.indexOf( 'async function dumpCanvases(' );
	const canvasEnd = runnerSource.indexOf( 'async function canvasBrightFractionInPage(', canvasStart );
	const canvasSource = runnerSource.slice( canvasStart, canvasEnd );
	assert.match( canvasSource, /canvasOrderForExample\( name \)/ );
	assert.doesNotMatch( canvasSource, /name === ['"]webgpu_/ );

	const visitStart = runnerSource.indexOf( 'async function visitExample(' );
	const visitEnd = runnerSource.indexOf( 'function pixelGateEnabledForExample(', visitStart );
	const visitSource = runnerSource.slice( visitStart, visitEnd );
	assert.match( visitSource, /browserStabilizationPolicyForExample\( name \)/ );
	assert.doesNotMatch( visitSource, /(?:name|exampleName) === ['"]webgpu_/ );

	const configurationStart = runnerSource.indexOf( 'function caseEvidenceConfiguration( name )' );
	const configurationEnd = runnerSource.indexOf( 'function mergeDiagnostics(', configurationStart );
	assert.match(
		runnerSource.slice( configurationStart, configurationEnd ),
		/browserStabilizationPolicy: browserStabilizationPolicyForExample\( name \)/,
	);

} );
