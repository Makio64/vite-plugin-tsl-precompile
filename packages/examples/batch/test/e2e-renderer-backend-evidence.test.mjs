import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
	createRendererBackendEvidence,
	uniqueRendererBackendValues,
} from '../e2e-renderer-backend-evidence.mjs';
import { canvasOrderForExample } from '../e2e-browser-stabilization-policy.mjs';
import { tierExamples } from '../psnr.mjs';

const runnerSource = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );

test( 'renderer backend values are normalized, deduplicated, and stable', () => {

	assert.deepEqual(
		uniqueRendererBackendValues( [ '', 'webgl', ' webgpu ', 'webgl', null, 'future' ] ),
		[ 'webgpu', 'webgl', 'future' ],
	);

} );

test( 'dual-backend evidence requires exact WebGPU and WebGL markers in both visits', () => {

	const evidence = createRendererBackendEvidence( {
		capture: [ 'webgl', 'webgpu', 'webgpu' ],
		replay: [ 'webgpu', 'webgl' ],
		requireDualBackend: true,
	} );

	assert.equal( evidence.pass, true );
	assert.deepEqual( evidence.expected, [ 'webgpu', 'webgl' ] );
	assert.deepEqual( evidence.visits.capture, [ 'webgpu', 'webgl' ] );
	assert.deepEqual( evidence.visits.replay, [ 'webgpu', 'webgl' ] );
	assert.deepEqual( evidence.missing, { capture: [], replay: [] } );
	assert.deepEqual( evidence.unexpected, { capture: [], replay: [] } );

} );

test( 'dual-backend evidence reports missing and unexpected visit markers', () => {

	const evidence = createRendererBackendEvidence( {
		capture: [ 'webgpu' ],
		replay: [ 'webgpu', 'webgl', 'future' ],
		requireDualBackend: true,
	} );

	assert.equal( evidence.pass, false );
	assert.deepEqual( evidence.missing, { capture: [ 'webgl' ], replay: [] } );
	assert.deepEqual( evidence.unexpected, { capture: [], replay: [ 'future' ] } );

} );

test( 'non-dual examples report observed values without turning them into a gate', () => {

	const evidence = createRendererBackendEvidence( {
		capture: [ 'webgpu' ],
		replay: [],
	} );

	assert.equal( evidence.enabled, false );
	assert.equal( evidence.pass, true );
	assert.deepEqual( evidence.visits, { capture: [ 'webgpu' ], replay: [] } );

} );

test( 'Tier-1 includes every declared dual-backend fixture', () => {

	const dualBackendCases = tierExamples( 'tier1' )
		.filter( ( name ) => canvasOrderForExample( name ) === 'webgpu-backend-first' )
		.sort();
	assert.deepEqual( dualBackendCases, [
		'webgpu_storage_buffer.html',
		'webgpu_texturegather.html',
		'webgpu_texturegrad.html',
	] );

} );

test( 'the runner collects settled capture and replay markers and gates dual-backend cases', () => {

	const visitStart = runnerSource.indexOf( 'async function visitExample(' );
	const visitEnd = runnerSource.indexOf( 'function pixelGateEnabledForExample(', visitStart );
	const visitSource = runnerSource.slice( visitStart, visitEnd );
	assert.ok( visitSource.indexOf( 'canvasBackends = uniqueRendererBackendValues(' ) > visitSource.indexOf( "trace( 'freeze-complete' )" ) );
	assert.ok( visitSource.indexOf( 'await dumpCanvas(' ) > visitSource.indexOf( 'canvasBackends = uniqueRendererBackendValues(' ) );
	// The capture pass grades no pixels — PSNR compares stock against replay and
	// nothing reads `artifactCapture.bright` — so it skips the screenshot and the
	// brightness round-trip that follows it. Every other mode must still shoot.
	assert.match( visitSource, /const gradesPixels = mode !== 'capture';/ );
	assert.match( visitSource, /const shot = gradesPixels \? await dumpCanvas\( page, name \) : null;/ );
	assert.match( visitSource, /return \{ bright: finalBright,[^\n]+canvasBackends,/ );

	const runStart = runnerSource.indexOf( 'async function runOne(' );
	const runEnd = runnerSource.indexOf( 'function summarizeArtifacts(', runStart );
	const runSource = runnerSource.slice( runStart, runEnd );
	assert.match( runSource, /capture: artifactCapture\.canvasBackends,/ );
	assert.match( runSource, /replay: replay\.canvasBackends,/ );
	assert.match( runSource, /requireDualBackend: canvasOrderForExample\( name \) === 'webgpu-backend-first'/ );
	assert.match( runSource, /rendererBackendEvidence\.pass/ );
	assert.match( runSource, /\n\t\trendererBackendEvidence,/ );
	assert.equal( ( runSource.match( /\n\t\tevidenceGate,/g ) || [] ).length, 1 );

	assert.match( runnerSource, /rendererBackendEvidence: detail\.rendererBackendEvidence \|\| null,/ );

} );
