import assert from 'node:assert/strict';
import test from 'node:test';
import { gpuPreparationDelta, trackGPUPreparation } from '../../performance/src/gpu-preparation.js';
import { assertAsyncComputePreparation, createInterleavedOrder, createReleaseBenchmarkCaptureWorkloads, createReleaseBenchmarkQuery, createRuntimeExportAliases, normalizeReleaseBenchmarkMatrix, summarizeMetric } from '../../performance/release-benchmark-plan.mjs';
import { createComputePreparation } from '../../performance/src/benchmarks/compute-preparation.js';

test( 'a selected PMREM workload captures all three authored routes without widening the request', () => {

	const routes = [ 'pmrem-scene', 'pmrem-equirect', 'pmrem-cube' ];
	for ( const workload of routes ) {

		const requested = Object.freeze( [ workload ] );
		assert.deepEqual( createReleaseBenchmarkCaptureWorkloads( requested ), routes );
		assert.deepEqual( requested, [ workload ], 'build and measurement scope retains the original request' );

	}

} );

test( 'PMREM capture routes deduplicate across permutations and repeated requests', () => {

	const routes = [ 'pmrem-scene', 'pmrem-equirect', 'pmrem-cube' ];
	for ( const first of routes ) for ( const second of routes ) for ( const third of routes ) {

		assert.deepEqual( createReleaseBenchmarkCaptureWorkloads( [ first, second, third, first ] ), routes );

	}
	assert.deepEqual( createReleaseBenchmarkCaptureWorkloads( [ 'preparation', 'pmrem-cube', 'materials', 'pmrem-scene', 'preparation' ] ), [ 'preparation', ...routes, 'materials' ] );
	assert.deepEqual( createReleaseBenchmarkCaptureWorkloads( [ 'pmrem-equirect', 'preparation' ] ), [ ...routes, 'preparation' ] );

} );

test( 'material and preparation captures never add unrelated PMREM routes', () => {

	for ( const requested of [ [], [ 'materials' ], [ 'preparation' ], [ 'materials', 'preparation' ], [ 'preparation', 'materials' ] ] ) {

		assert.deepEqual( createReleaseBenchmarkCaptureWorkloads( requested ), requested );

	}
	assert.deepEqual( createReleaseBenchmarkCaptureWorkloads( [ 'materials', 'materials' ] ), [ 'materials' ] );

} );

test( 'GPU preparation separates API CPU submission from overlapping async completion and preserves promises', async () => {

	let clock = 0, resolveRender, resolveCompute;
	const render = new Promise( resolve => { resolveRender = resolve; } ), compute = new Promise( resolve => { resolveCompute = resolve; } );
	const device = {
		createShaderModule() { clock += 2; return {}; },
		createRenderPipelineAsync() { clock ++; return render; },
		createComputePipelineAsync() { clock += 2; return compute; },
	};
	const queue = { submit( inputs ) { clock ++; return inputs; } };
	const original = device.createRenderPipelineAsync;
	const tracker = trackGPUPreparation( device, queue, { now: () => clock } );
	device.createShaderModule( { code: '@vertex fn main() {}', label: 'vertex_material' } );
	device.createShaderModule( { code: '@vertex fn main() {}', label: 'vertex_duplicate' } );
	assert.equal( device.createRenderPipelineAsync( {} ), render, 'native promise identity is unchanged' );
	assert.equal( device.createComputePipelineAsync( {} ), compute );
	assert.equal( queue.submit( render ), render );
	clock = 10; resolveRender( {} ); await render; await Promise.resolve();
	assert.equal( tracker.snapshot().pendingAsync, 1 );
	clock = 15; resolveCompute( {} ); await tracker.settled();
	const snapshot = tracker.snapshot();
	assert.equal( snapshot.apiCpuMs, 3 );
	assert.equal( snapshot.api.createRenderPipelineAsync.cpuMs, 1 );
	assert.deepEqual( snapshot.api.createRenderPipelineAsync.asyncLatenciesMs, [ 6 ] );
	assert.deepEqual( snapshot.api.createComputePipelineAsync.asyncLatenciesMs, [ 10 ] );
	assert.equal( snapshot.asyncWallMs, 11, 'overlapping completions form one interval rather than summed latencies' );
	assert.equal( snapshot.pendingAsync, 0 );
	assert.equal( snapshot.duplicateShaderRequests, 1 );
	assert.deepEqual( snapshot.shaderStages.vertex, { calls: 2, bytes: 40, uniqueSources: 1, duplicateRequests: 1 } );
	assert.equal( snapshot.submitCpuMs, 1 );
	assert.equal( snapshot.api.createRenderPipeline.supported, false, 'unsupported measurements remain explicit' );
	tracker.dispose(); assert.equal( device.createRenderPipelineAsync, original );

} );

test( 'layout duplication uses exact ordered bind group object identities', () => {

	const device = { createPipelineLayout: descriptor => descriptor }, a = {}, b = {};
	const tracker = trackGPUPreparation( device, null );
	device.createPipelineLayout( { bindGroupLayouts: [ a, b ] } );
	device.createPipelineLayout( { bindGroupLayouts: [ a, b ], label: 'same layout' } );
	device.createPipelineLayout( { bindGroupLayouts: [ b, a ] } );
	device.createPipelineLayout( { bindGroupLayouts: [ {}, b ] } );
	const snapshot = tracker.snapshot();
	assert.equal( snapshot.layoutCalls, 4 );
	assert.equal( snapshot.uniqueOrderedBindGroupLayouts, 3 );
	assert.equal( snapshot.duplicateLayoutRequests, 1 );
	tracker.dispose();

} );

test( 'rejected pipeline preparations remain rejected and are counted without an observation rejection leak', async () => {

	const failure = new Error( 'invalid native pipeline' );
	const promise = Promise.reject( failure );
	const device = { createRenderPipelineAsync: () => promise };
	const tracker = trackGPUPreparation( device, null );
	assert.equal( device.createRenderPipelineAsync( {} ), promise );
	await assert.rejects( promise, error => error === failure );
	await tracker.settled();
	assert.equal( tracker.snapshot().api.createRenderPipelineAsync.failures, 1 );
	assert.equal( tracker.snapshot().pendingAsync, 0 );
	tracker.dispose();

} );

test( 'optional main hints clone the native descriptor without inventing a pipeline layout', () => {

	let actual;
	const device = { createShaderModule: descriptor => { actual = descriptor; return descriptor; } };
	const tracker = trackGPUPreparation( device, null, { compilationHints: true } );
	const descriptor = Object.freeze( { label: 'compute_kernel', code: '@compute @workgroup_size(64) fn main() {}', compilationHints: [] } );
	device.createShaderModule( descriptor );
	assert.deepEqual( descriptor.compilationHints, [] );
	assert.notEqual( actual, descriptor );
	assert.deepEqual( actual.compilationHints, [ { entryPoint: 'main' } ] );
	assert.equal( tracker.snapshot().hintedModules, 1 );
	assert.throws( () => device.createShaderModule( { label: 'compute_bad', code: '@compute fn other() {}' } ), /main entry point/ );
	const utility = { label: 'mipmap-utility', code: '@compute fn mipmaps() {}' };
	device.createShaderModule( utility );
	assert.equal( actual, utility, 'utility entry points remain untouched even in a hint trial' );
	assert.equal( tracker.snapshot().skippedHintModules, 1 );
	tracker.dispose();

} );

test( 'warm preparation deltas retain async observations and stage counts without subtracting missing API values', async () => {

	const device = { createComputePipelineAsync: () => Promise.resolve( {} ) };
	const tracker = trackGPUPreparation( device, null );
	const before = tracker.snapshot();
	device.createComputePipelineAsync( {} ); await tracker.settled();
	const delta = gpuPreparationDelta( tracker.snapshot(), before );
	assert.equal( delta.computeCalls, 1 );
	assert.equal( delta.api.createComputePipelineAsync.completed, 1 );
	assert.equal( delta.api.createComputePipelineAsync.asyncLatenciesMs.length, 1 );
	assert.equal( delta.api.createShaderModule.supported, false );
	assert.equal( delta.shaderStages.compute.calls, 0 );
	assert.ok( delta.asyncWallMs >= 0 );
	tracker.dispose();

} );

test( 'release benchmark validates identities and interleaves at least five independent rounds', () => {

	const matrix = normalizeReleaseBenchmarkMatrix( [ { id: 'stable', mode: 'native', threeRoot: '/tmp/stable' }, { id: 'dev', mode: 'source', threeRoot: '/tmp/dev', webgpuOnly: true } ] );
	const order = createInterleavedOrder( matrix.map( candidate => candidate.id ), 5 );
	assert.equal( order.length, 5 );
	assert.notDeepEqual( order[ 0 ], order[ 1 ], 'adjacent rounds reverse order instead of cancelling rotation for two candidates' );
	for ( const round of order ) assert.deepEqual( [ ...round ].sort(), [ 'dev', 'stable' ] );
	assert.throws( () => normalizeReleaseBenchmarkMatrix( [ ...matrix, matrix[ 0 ] ] ), /unique/ );
	assert.throws( () => normalizeReleaseBenchmarkMatrix( [ matrix[ 0 ], { ...matrix[ 1 ], id: '../escape' } ] ), /unique/ );
	assert.throws( () => normalizeReleaseBenchmarkMatrix( [ matrix[ 0 ], { ...matrix[ 1 ], mode: 'prebuilt', webgpuOnly: false } ] ), /sidecar/ );
	assert.throws( () => normalizeReleaseBenchmarkMatrix( [ matrix[ 0 ], { ...matrix[ 1 ], mode: 'native' } ] ), /source mode/ );
	assert.deepEqual( summarizeMetric( [ 4, 3, 0, 2, 1 ] ), { samples: 5, median: 2, p95: 4, min: 0, max: 4 } );
	assert.deepEqual( summarizeMetric( [ null, undefined, NaN ] ), { samples: 0, median: null, p95: null, min: null, max: null } );

} );

test( 'public runtime aliases preserve canonical source registries and development setup conditions', () => {

	const exports = { '.': { default: './src/index.js' }, './setup': { development: './src/setup-development.js', production: './src/setup-production.js', default: './src/setup-production.js' }, './slim/source': './src/slim-source-entry.js', './types-only': { types: './types/index.d.ts' } };
	const development = createRuntimeExportAliases( '/canonical/runtime', exports, true ), production = createRuntimeExportAliases( '/canonical/runtime', exports );
	assert.equal( development.length, 3 );
	assert.equal( development.find( alias => alias.find.test( '@tsl-precompile/runtime/setup' ) ).replacement, '/canonical/runtime/src/setup-development.js' );
	assert.equal( production.find( alias => alias.find.test( '@tsl-precompile/runtime/setup' ) ).replacement, '/canonical/runtime/src/setup-production.js' );
	assert.equal( production.find( alias => alias.find.test( '@tsl-precompile/runtime' ) ).replacement, '/canonical/runtime/src/index.js' );
	assert.equal( development.some( alias => alias.find.test( '@tsl-precompile/runtime/setup/other' ) ), false );

} );

test( 'async compute control validates booleans and uses the same capture and production query', () => {

	const baseline = { id: 'native', mode: 'native', threeRoot: '/tmp/stable' };
	const candidate = { ...baseline, id: 'async', compileComputeAsync: true, compilationHints: true };
	const matrix = normalizeReleaseBenchmarkMatrix( [ baseline, candidate ] );
	assert.equal( matrix[ 1 ].compileComputeAsync, true );
	assert.equal( createReleaseBenchmarkQuery( matrix[ 0 ], 'preparation' ), '?case=preparation&paused&prepare-async' );
	assert.equal( createReleaseBenchmarkQuery( matrix[ 1 ], 'preparation' ), '?case=preparation&paused&prepare-async&compilation-hints&compile-compute-async' );
	assert.throws( () => normalizeReleaseBenchmarkMatrix( [ baseline, { ...candidate, compileComputeAsync: 'true' } ] ), /compileComputeAsync must be boolean/ );

} );

test( 'async compute control waits for compilation before dispatch and preserves the baseline promise', async () => {

	const node = {}, events = [];
	let resolveCompile;
	const compilation = new Promise( resolve => { resolveCompile = resolve; } );
	const dispatched = Promise.resolve( 'readback-ready' );
	const renderer = { compileComputeAsync( actual ) { assert.equal( actual, node ); events.push( 'compile' ); return compilation; } };
	const runner = { node, dispatchAsync() { events.push( 'dispatch' ); return dispatched; } };
	assert.equal( createComputePreparation( renderer, runner, false )(), dispatched );
	assert.deepEqual( events, [ 'dispatch' ] );
	events.length = 0;
	const prepared = createComputePreparation( renderer, runner, true )();
	assert.deepEqual( events, [ 'compile' ] );
	resolveCompile(); assert.equal( await prepared, 'readback-ready' );
	assert.deepEqual( events, [ 'compile', 'dispatch' ] );
	const failure = new Error( 'invalid compute shader' );
	await assert.rejects( createComputePreparation( { compileComputeAsync: () => Promise.reject( failure ) }, runner, true )(), error => error === failure );
	assert.deepEqual( events, [ 'compile', 'dispatch' ], 'a failed compilation must not dispatch' );
	assert.equal( await createComputePreparation( renderer, undefined, true )(), undefined );

} );

test( 'async compute evidence rejects synchronous pipelines even when async graphics were prepared', async () => {

	const device = { createComputePipeline: () => ( {} ), createComputePipelineAsync: () => Promise.resolve( {} ), createRenderPipelineAsync: () => Promise.resolve( {} ) };
	const tracker = trackGPUPreparation( device, null ), candidate = { id: 'async', compileComputeAsync: true };
	const before = tracker.snapshot();
	device.createComputePipelineAsync( {} ); await tracker.settled();
	const profile = { computePreparation: gpuPreparationDelta( tracker.snapshot(), before ) };
	assert.doesNotThrow( () => assertAsyncComputePreparation( candidate, 'preparation', profile ) );
	device.createComputePipeline( {} );
	profile.computePreparation = gpuPreparationDelta( tracker.snapshot(), before );
	assert.throws( () => assertAsyncComputePreparation( candidate, 'preparation', profile ), /zero synchronous compute pipeline/ );
	const graphicsBefore = tracker.snapshot();
	device.createRenderPipelineAsync( {} ); await tracker.settled();
	assert.throws( () => assertAsyncComputePreparation( candidate, 'preparation', { computePreparation: gpuPreparationDelta( graphicsBefore, graphicsBefore ) } ), /requires an async pipeline/ );
	assert.throws( () => assertAsyncComputePreparation( candidate, 'preparation', {} ), /requires an async pipeline/ );
	assert.doesNotThrow( () => assertAsyncComputePreparation( { id: 'baseline' }, 'preparation', {} ) );
	assert.doesNotThrow( () => assertAsyncComputePreparation( candidate, 'materials', {} ) );
	tracker.dispose();

} );
