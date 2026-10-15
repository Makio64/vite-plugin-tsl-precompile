import { resolve } from 'node:path';

export const RELEASE_BENCHMARK_WORKLOADS = Object.freeze( [ 'materials', 'preparation', 'pmrem-scene', 'pmrem-equirect', 'pmrem-cube' ] );

/** All markers in the shared authored PMREM module need real route captures before any route builds. */
export function createReleaseBenchmarkCaptureWorkloads( requestedWorkloads ) {

	const pmremRoutes = RELEASE_BENCHMARK_WORKLOADS.filter( workload => workload.startsWith( 'pmrem-' ) );
	return [ ...new Set( requestedWorkloads.flatMap( workload => pmremRoutes.includes( workload ) ? pmremRoutes : [ workload ] ) ) ];

}

/** Canonicalize public entries before Vite creates its resolver, preserving singleton registries. */
export function createRuntimeExportAliases( root, exports, development = false ) {

	return Object.entries( exports ).flatMap( ( [ subpath, targets ] ) => {

		const target = typeof targets === 'string' ? targets : development ? targets.development || targets.default : targets.production || targets.default;
		if ( typeof target !== 'string' ) return [];
		const specifier = '@tsl-precompile/runtime' + ( subpath === '.' ? '' : subpath.slice( 1 ) );
		return [ { find: new RegExp( '^' + specifier.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) + '$' ), replacement: resolve( root, target ) } ];

	} );

}

export function normalizeReleaseBenchmarkMatrix( value ) {

	if ( ! Array.isArray( value ) || value.length < 2 ) throw new Error( 'Benchmark matrix requires at least two candidates' );
	const ids = new Set();
	return value.map( entry => {

		if ( ! entry || ! /^[a-z][a-z0-9-]{0,63}$/.test( entry.id ) || ids.has( entry.id ) ) throw new Error( 'Candidate IDs must be unique lowercase names' );
		ids.add( entry.id );
		if ( ! [ 'native', 'prebuilt', 'source' ].includes( entry.mode ) || typeof entry.threeRoot !== 'string' || ! entry.threeRoot ) throw new Error( `${ entry.id }: mode and exact Three root are required` );
		if ( entry.mode === 'prebuilt' && ( typeof entry.slimBundle !== 'string' || typeof entry.slimMetadata !== 'string' ) ) throw new Error( `${ entry.id }: preserved prebuilt bundle and sidecar are required` );
		if ( entry.webgpuOnly && entry.mode !== 'source' ) throw new Error( `${ entry.id }: webgpuOnly requires source mode` );
		for ( const key of [ 'webgpuOnly', 'compilationHints', 'compileComputeAsync' ] ) if ( entry[ key ] !== undefined && typeof entry[ key ] !== 'boolean' ) throw new Error( `${ entry.id }: ${ key } must be boolean` );
		return { ...entry, threeRoot: resolve( entry.threeRoot ), ...( entry.mode === 'prebuilt' ? { slimBundle: resolve( entry.slimBundle ), slimMetadata: resolve( entry.slimMetadata ) } : {} ) };

	} );

}

export function createReleaseBenchmarkQuery( candidate, workload ) {

	return `?case=${ encodeURIComponent( workload ) }&paused&prepare-async${ candidate.compilationHints ? '&compilation-hints' : '' }${ candidate.compileComputeAsync ? '&compile-compute-async' : '' }`;

}

export function assertAsyncComputePreparation( candidate, workload, profile ) {

	if ( workload !== 'preparation' || ! candidate.compileComputeAsync ) return;
	const preparation = profile.computePreparation;
	if ( ! ( preparation?.asyncCalls >= 1 ) || preparation.api?.createComputePipeline?.calls !== 0 ) throw new Error( `${ candidate.id }: async compute control requires an async pipeline and zero synchronous compute pipeline calls` );

}

/** Rotate positions and reverse alternate rounds; every candidate runs once per round. */
export function createInterleavedOrder( candidates, rounds ) {

	if ( ! Number.isInteger( rounds ) || rounds < 1 || rounds > 20 ) throw new Error( 'Rounds must be an integer from 1 to 20' );
	return Array.from( { length: rounds }, ( _, round ) => {

		const offset = Math.floor( round / 2 ) % candidates.length;
		const order = [ ...candidates.slice( offset ), ...candidates.slice( 0, offset ) ];
		return round % 2 ? order.reverse() : order;

	} );

}

export function summarizeMetric( values ) {

	const samples = values.filter( Number.isFinite ).sort( ( a, b ) => a - b );
	const quantile = value => samples.length ? samples[ Math.ceil( value * samples.length ) - 1 ] : null;
	return { samples: samples.length, median: quantile( 0.5 ), p95: quantile( 0.95 ), min: samples[ 0 ] ?? null, max: samples.at( -1 ) ?? null };

}

export function summarizeReleaseBenchmark( runs ) {

	const metrics = [ 'readyFromNavigationMs', 'rendererInitMs', 'sceneModuleMs', 'sceneSetupMs', 'replayBindingMs', 'computePrepareMs', 'compileAsyncSubmissionCpuMs', 'compileAsyncCompletionMs', 'prepareAsyncMs', 'firstFrameCpuMs', 'firstFrameWallMs', 'firstFrameGpuWaitMs' ];
	return Object.fromEntries( [ ...new Set( runs.map( run => run.candidate ) ) ].map( id => {

		const selected = runs.filter( run => run.candidate === id );
		return [ id, {
			cold: Object.fromEntries( metrics.map( metric => [ metric, summarizeMetric( selected.map( run => run.profile[ metric ] ) ) ] ) ),
			pipelinePreparation: Object.fromEntries( [ 'shaderCalls', 'shaderBytes', 'uniqueShaderSources', 'duplicateShaderRequests', 'renderCalls', 'computeCalls', 'asyncCalls', 'apiCpuMs', 'asyncWallMs', 'layoutCalls', 'uniqueOrderedBindGroupLayouts', 'duplicateLayoutRequests' ].map( metric => [ metric, summarizeMetric( selected.map( run => run.profile.setupPipelines?.[ metric ] ) ) ] ) ),
			hydrationPhases: Object.fromEntries( [ ...new Set( selected.flatMap( run => Object.keys( run.profile.hydrationPhases || {} ) ) ) ].map( phase => [ phase, {
				calls: summarizeMetric( selected.map( run => run.profile.hydrationPhases?.[ phase ]?.calls ) ),
				cpuMs: summarizeMetric( selected.map( run => run.profile.hydrationPhases?.[ phase ]?.cpuMs ) ),
			} ] ) ),
			warm: {
				cpuMs: summarizeMetric( selected.map( run => run.warm.cpu.median ) ),
				gpuPassMs: summarizeMetric( selected.map( run => run.warm.gpu.median ) ),
				compileCacheHitMs: summarizeMetric( selected.map( run => run.compileWarm.completionMs ) ),
			},
		} ];

	} ) );

}
