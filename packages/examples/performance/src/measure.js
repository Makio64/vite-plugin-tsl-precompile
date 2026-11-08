import { gpuPreparationDelta, trackGPUPreparation } from './gpu-preparation.js';

const nextFrame = () => new Promise( resolve => requestAnimationFrame( resolve ) );
const percentile = ( values, quantile ) => values.length ? [ ...values ].sort( ( a, b ) => a - b )[ Math.ceil( quantile * values.length ) - 1 ] : null;
const summary = values => ( { median: percentile( values, 0.5 ), p95: percentile( values, 0.95 ) } );

export function attachMeasurements( renderer ) {
	const profile = { compilerFree: renderer.constructor.__TSLP_SLIM__ === true, shaderNodes: 0, builderCalls: 0 };
	const seen = new WeakSet();
	let preparation = null;
	const trackPipelines = () => {
		if ( preparation ) return;
		const device = globalThis.GPUDevice?.prototype || renderer.backend.device;
		if ( ! device ) return;
		preparation = trackGPUPreparation( device, globalThis.GPUQueue?.prototype || renderer.backend.device.queue, {
			compilationHints: new URLSearchParams( location.search ).has( 'compilation-hints' ),
		} );
	};
	trackPipelines();
	const pipelineSnapshot = () => preparation?.snapshot() || {};
	const pipelineDelta = before => gpuPreparationDelta( pipelineSnapshot(), before );
	const hydrationPhases = {};
	globalThis.__tslpReplayHydrationPhaseTrace = ( phase, _detail, callback ) => {
		const record = hydrationPhases[ phase ] ||= { calls: 0, cpuMs: 0 };
		const started = performance.now();
		try { return callback(); } finally { record.calls ++; record.cpuMs += performance.now() - started; }
	};
	profile.hydrationPhases = hydrationPhases;
	const createBuilder = renderer.backend.createNodeBuilder;
	renderer.backend.createNodeBuilder = function ( ...args ) {
		profile.builderCalls ++;
		const builder = createBuilder.apply( this, args );
		for ( const method of [ 'build', 'buildAsync' ] ) {
			const original = builder[ method ];
			if ( typeof original !== 'function' ) continue;
			const record = () => { for ( const node of builder.nodes || [] ) if ( ! seen.has( node ) ) { seen.add( node ); profile.shaderNodes ++; } };
			builder[ method ] = function ( ...inputs ) { const result = original.apply( this, inputs ); if ( result?.then ) return result.then( value => { record(); return value; } ); record(); return result; };
		}
		return builder;
	};
	return {
		profile,
		pipelineSnapshot, pipelineDelta,
		trackPipelines,
		settled: () => preparation?.settled(),
		start( app, draw, definition ) {
			let paused = new URLSearchParams( location.search ).has( 'paused' ), running = false, active = app.variants[ 0 ];
			let frames = 0;
			const firstUses = new Map( [ [ active, { cpuMs: profile.firstFrameCpuMs, wallMs: profile.firstFrameWallMs, shaderNodes: profile.startupShaderNodes, builderCalls: profile.startupBuilderCalls } ] ] );
			const freeze = async ( time, variant = active ) => {
				paused = true; active = variant; app.selectVariant( variant ); draw( time );
				await renderer.backend.device.queue.onSubmittedWorkDone();
				await nextFrame(); await nextFrame();
			};
			const loop = () => { requestAnimationFrame( loop ); if ( ! paused ) { draw( frames ++ / 60 ); } };
			loop();
			return {
				definition, profile, variants: app.variants,
				preparation: pipelineSnapshot,
				oracle: () => app.oracle?.(),
				async compileWarm() {
					const before = pipelineSnapshot(), started = performance.now();
					const compiling = renderer.compileAsync( app.scene, app.camera );
					const submissionCpuMs = performance.now() - started;
					await compiling;
					await preparation?.settled();
					return { submissionCpuMs, completionMs: performance.now() - started, preparation: pipelineDelta( before ) };
				},
				pause() { paused = true; },
				play( variant = active ) { active = variant; app.selectVariant( variant ); paused = false; },
				freeze,
				async measure( { variant = active, warmup = 120, samples = 120 } = {} ) {
					if ( running ) throw new Error( 'Measurement already running' );
					running = true; paused = true;
					const cpu = [], gpu = [];
					const timed = renderer.backend.device.features.has( 'timestamp-query' );
					try {
						const beforeNodes = profile.shaderNodes, beforeBuilders = profile.builderCalls;
						const first = performance.now(); active = variant; app.selectVariant( variant ); draw( 0 ); const cpuMs = performance.now() - first;
						await renderer.backend.device.queue.onSubmittedWorkDone();
						if ( ! firstUses.has( variant ) ) firstUses.set( variant, { cpuMs, wallMs: performance.now() - first, shaderNodes: profile.shaderNodes - beforeNodes, builderCalls: profile.builderCalls - beforeBuilders } );
						renderer.backend.trackTimestamp = timed;
						if ( timed ) await renderer.resolveTimestampsAsync();
						for ( let index = -warmup; index < samples; index ++ ) {
							await nextFrame();
							const start = performance.now(); draw( ( index + warmup ) / 60 ); cpu.push( performance.now() - start );
							const gpuMs = timed ? await renderer.resolveTimestampsAsync() : null;
							if ( index < 0 ) { cpu.pop(); continue; }
							if ( Number.isFinite( gpuMs ) && gpuMs > 0 ) gpu.push( gpuMs );
						}
						let sceneObjects = 0, meshes = 0, triangles = 0;
						const materials = new Set();
						app.scene.traverse( object => { sceneObjects ++; if ( object.isMesh ) { meshes ++; triangles += ( object.geometry.index?.count || object.geometry.attributes.position.count ) / 3 * ( object.isInstancedMesh ? object.count : 1 ); for ( const material of [ object.material ].flat() ) materials.add( material ); } } );
						return {
							...profile, case: definition.id, variant, sceneObjects, meshes, triangles, materials: materials.size,
							drawCalls: renderer.info.render.drawCalls, renderedTriangles: renderer.info.render.triangles,
							width: renderer.domElement.width, height: renderer.domElement.height,
							memory: { ...renderer.info.memory }, pmrem: app.pmremTarget ? { width: app.pmremTarget.width, height: app.pmremTarget.height, bound: app.scene.environment === app.pmremTarget.texture } : null,
							postProcessing: Boolean( app.pipeline ), firstUse: firstUses.get( variant ),
							cpu: summary( cpu ), gpu: summary( gpu ), samples, gpuSamples: gpu.length, warmup, cpuSamplesMs: cpu, gpuSamplesMs: gpu,
						};
					} finally { renderer.backend.trackTimestamp = false; running = false; }
				},
			};
		},
	};
}
