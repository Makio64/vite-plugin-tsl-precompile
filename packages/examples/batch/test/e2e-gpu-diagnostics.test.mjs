import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	E2E_GPU_OBSERVATION_SCHEMA,
	drainAndSettleE2EGpuDiagnostics,
	drainE2EGpuDiagnostics,
	installE2EGpuDiagnostics,
} from '../e2e-gpu-diagnostics.mjs';
import { resolveE2EHarnessSourceFiles } from '../e2e-evidence.mjs';

const BATCH_ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const REPO = resolve( BATCH_ROOT, '../../..' );

function deferred() {

	let resolvePromise;
	const promise = new Promise( ( resolve ) => {

		resolvePromise = resolve;

	} );
	return { promise, resolve: resolvePromise };

}

function fakeGpuWindow( {
	queue = { onSubmittedWorkDone: async () => {} },
	lost = deferred(),
} = {} ) {

	const listeners = new Map();
	const device = {
		queue,
		lost: lost.promise,
		addEventListener( type, listener ) {

			listeners.set( type, listener );

		},
	};
	const adapter = {
		async requestDevice() {

			return device;

		},
	};
	const target = {
		navigator: {
			gpu: {
				async requestAdapter() {

					return adapter;

				},
			},
		},
	};
	return { adapter, device, listeners, lost, target };

}

async function requestObservedDevice( fixture ) {

	installE2EGpuDiagnostics( fixture.target );
	const adapter = await fixture.target.navigator.gpu.requestAdapter();
	return adapter.requestDevice();

}

test( 'fulfilled GPU queue completion stays clean', async () => {

	let completionCalls = 0;
	const fixture = fakeGpuWindow( {
		queue: {
			async onSubmittedWorkDone() {

				completionCalls ++;

			},
		},
	} );
	assert.equal( await requestObservedDevice( fixture ), fixture.device );
	const errors = await drainE2EGpuDiagnostics( fixture.target );
	assert.equal( completionCalls, 1 );
	assert.deepEqual( errors, [] );
	assert.deepEqual( fixture.target.__tslpHarnessDiagnostics.gpuObservation, {
		schema: E2E_GPU_OBSERVATION_SCHEMA,
		hookInstalled: true,
		requestAdapterCalls: 1,
		requestDeviceCalls: 1,
		devicesObserved: 1,
		uncapturedErrorObservers: 1,
		deviceLostObservers: 1,
		drainAttempts: 1,
		queuesExpected: 1,
		queuesFenced: 1,
		queueFenceFailures: 0,
		complete: true,
	} );

} );

test( 'GPU queue completion rejection is recorded without rejecting the drain', async () => {

	const fixture = fakeGpuWindow( {
		queue: {
			async onSubmittedWorkDone() {

				throw new Error( 'submission failed' );

			},
		},
	} );
	await requestObservedDevice( fixture );
	const errors = await drainE2EGpuDiagnostics( fixture.target );
	assert.deepEqual( errors, [
		'GPU queue completion rejected (device 1): submission failed',
	] );
	assert.equal( fixture.target.__tslpHarnessDiagnostics.gpuObservation.queuesFenced, 0 );
	assert.equal( fixture.target.__tslpHarnessDiagnostics.gpuObservation.queueFenceFailures, 1 );
	assert.equal( fixture.target.__tslpHarnessDiagnostics.gpuObservation.complete, false );

} );

test( 'a drain with no observed GPU device stays explicitly incomplete', async () => {

	const fixture = fakeGpuWindow();
	installE2EGpuDiagnostics( fixture.target );
	assert.deepEqual( await drainE2EGpuDiagnostics( fixture.target ), [] );
	assert.deepEqual(
		{
			devicesObserved: fixture.target.__tslpHarnessDiagnostics.gpuObservation.devicesObserved,
			drainAttempts: fixture.target.__tslpHarnessDiagnostics.gpuObservation.drainAttempts,
			queuesExpected: fixture.target.__tslpHarnessDiagnostics.gpuObservation.queuesExpected,
			queuesFenced: fixture.target.__tslpHarnessDiagnostics.gpuObservation.queuesFenced,
			complete: fixture.target.__tslpHarnessDiagnostics.gpuObservation.complete,
		},
		{
			devicesObserved: 0,
			drainAttempts: 1,
			queuesExpected: 0,
			queuesFenced: 0,
			complete: false,
		},
	);

} );

test( 'a device without a submitted-work fence is recorded and cannot complete', async () => {

	const fixture = fakeGpuWindow( { queue: {} } );
	await requestObservedDevice( fixture );
	const errors = await drainE2EGpuDiagnostics( fixture.target );
	assert.deepEqual( errors, [
		'GPU queue completion rejected (device 1): GPUQueue.onSubmittedWorkDone is unavailable',
	] );
	assert.equal( fixture.target.__tslpHarnessDiagnostics.gpuObservation.queueFenceFailures, 1 );
	assert.equal( fixture.target.__tslpHarnessDiagnostics.gpuObservation.complete, false );

} );

test( 'uncaptured GPU errors are recorded on the observed device', async () => {

	const fixture = fakeGpuWindow();
	await requestObservedDevice( fixture );
	fixture.listeners.get( 'uncapturederror' )( {
		error: new Error( 'bind group layout mismatch' ),
	} );
	assert.deepEqual( fixture.target.__tslpHarnessDiagnostics.gpuErrors, [
		'GPU uncaptured error: bind group layout mismatch',
	] );

} );

test( 'device loss observation is nonblocking and records the loss reason', async () => {

	const fixture = fakeGpuWindow();
	const request = requestObservedDevice( fixture );
	const result = await Promise.race( [
		request.then( () => 'resolved' ),
		new Promise( ( resolveResult ) => setTimeout( () => resolveResult( 'blocked' ), 50 ) ),
	] );
	assert.equal( result, 'resolved' );
	fixture.lost.resolve( {
		reason: 'destroyed',
		message: 'fixture device disappeared',
	} );
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual( fixture.target.__tslpHarnessDiagnostics.gpuErrors, [
		'GPU device lost (destroyed): fixture device disappeared',
	] );

} );

test( 'the runner installs and drains the helper and provenance follows its static import', () => {

	const runnerPath = resolve( BATCH_ROOT, 'run-e2e.mjs' );
	const runnerSource = readFileSync( runnerPath, 'utf8' );
	assert.match(
		runnerSource,
		/import \{[\s\S]*drainAndSettleE2EGpuDiagnostics,[\s\S]*drainE2EGpuDiagnostics,[\s\S]*installE2EGpuDiagnostics,[\s\S]*\} from '\.\/e2e-gpu-diagnostics\.mjs';/,
	);
	assert.match( runnerSource, /page\.addInitScript\( installE2EGpuDiagnostics \)/ );
	assert.equal(
		( runnerSource.match( /page\.evaluate\( drainE2EGpuDiagnostics \)/g ) || [] ).length,
		1,
	);
	assert.match( runnerSource, /await drainAndSettleE2EGpuDiagnostics\( page \);/ );
	assert.doesNotMatch( runnerSource, /Promise\.allSettled\( devices\.map/ );
	const sourcePaths = resolveE2EHarnessSourceFiles( REPO )
		.map( ( file ) => relative( REPO, file ) );
	assert.equal(
		sourcePaths.includes( 'packages/examples/batch/e2e-gpu-diagnostics.mjs' ),
		true,
	);
	const stockSource = readFileSync( resolve( BATCH_ROOT, 'run.mjs' ), 'utf8' );
	assert.match( stockSource, /page\.addInitScript\( installE2EGpuDiagnostics \)/ );
	assert.match( stockSource, /await drainAndSettleE2EGpuDiagnostics\( page \);/ );
	assert.match( stockSource, /gpuObservation: result\.gpuObservation \|\| null/ );
	assert.match( stockSource, /e2eGpuObservationIssues\( result\.gpuObservation \)/ );

} );

test( 'the shared page drain waits for the serialized GPU drain before settling', async () => {

	const fixture = fakeGpuWindow();
	await requestObservedDevice( fixture );
	const calls = [];
	const page = {
		async evaluate( operation ) {

			calls.push( operation );
			return await operation( fixture.target );

		},
	};
	await drainAndSettleE2EGpuDiagnostics( page, { settleMs: 0 } );
	assert.deepEqual( calls, [ drainE2EGpuDiagnostics ] );
	assert.equal( fixture.target.__tslpHarnessDiagnostics.gpuObservation.complete, true );

} );
