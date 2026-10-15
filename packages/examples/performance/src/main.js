import { WebGPURenderer, ACESFilmicToneMapping } from 'three/webgpu';
import { setupPrecompile } from '@tsl-precompile/runtime/setup';
import { loadScene } from 'virtual:performance-scenes';
import { CASES } from '../catalogue.js';
import { attachMeasurements } from './measure.js';

const id = new URLSearchParams( location.search ).get( 'case' ) || 'knot';
const definition = CASES.find( item => item.id === id );
const fail = error => { document.getElementById( 'error' ).textContent = String( error?.stack || error ); };
window.addEventListener( 'error', event => fail( event.error || event.message ) );
window.addEventListener( 'unhandledrejection', event => fail( event.reason ) );
if ( ! definition ) throw new Error( `Unknown scene: ${ id }` );
const started = performance.now();
const renderer = new WebGPURenderer( { antialias: true, trackTimestamp: true } );
renderer.setPixelRatio( 1 ); renderer.setSize( innerWidth, innerHeight );
renderer.toneMapping = ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
renderer.info.autoReset = false;
document.body.appendChild( renderer.domElement );
const profiler = attachMeasurements( renderer );
const setup = setupPrecompile( { renderer, captureRendererOutput: false } );
const baseline = setup.captureStatus();
const initStart = performance.now();
const initialized = Promise.all( [ renderer.init(), setup.ready ] ).then( () => {
	profiler.profile.rendererInitMs = performance.now() - initStart;
} );
// Module loading can overlap device setup; scene creation needs both ready.
const moduleStart = performance.now();
const [ { create } ] = await Promise.all( [ loadScene( id ).then( module => {
	profiler.profile.sceneModuleMs = performance.now() - moduleStart;
	return module;
} ), initialized ] );
profiler.trackPipelines();
const adapter = renderer.backend.device.adapterInfo;
profiler.profile.gpuAdapter = adapter ? { vendor: adapter.vendor, architecture: adapter.architecture, device: adapter.device, description: adapter.description } : null;
profiler.profile.gpuFeatures = Array.from( renderer.backend.device.features ).sort();
const creationStart = performance.now();
const app = await create( renderer );
if ( new URLSearchParams( location.search ).has( 'debug' ) ) window.__TSLP_DEBUG__ = { renderer, app };
profiler.profile.sceneSetupMs = performance.now() - creationStart;
let fixedTime = 0;
const nodeFrame = renderer._nodes.nodeFrame;
const update = nodeFrame.update;
nodeFrame.update = function ( ...args ) { const result = update.apply( this, args ); this.time = fixedTime; this.deltaTime = 1 / 60; return result; };
const draw = time => {
	// Three advances its node clock in RAF. An explicit draw (first use/freeze)
	// can happen before the next RAF, so stamp this draw's time and identity now.
	fixedTime = time; nodeFrame.time = time; nodeFrame.deltaTime = 1 / 60; nodeFrame.frameId ++;
	app.step( time ); renderer.info.reset();
	if ( app.pipeline ) app.pipeline.render();
	else renderer.render( app.scene, app.camera );
};
const bindStart = performance.now();
if ( import.meta.env.PROD && profiler.profile.compilerFree && app.pipeline ) {
	const { bindAuxByName } = await import( '@tsl-precompile/runtime' );
	bindAuxByName( app.pipeline.outputNode, 'post-process', app.pipelineName );
}
profiler.profile.replayBindingMs = performance.now() - bindStart;
app.selectVariant( app.variants[ 0 ] );
if ( new URLSearchParams( location.search ).has( 'prepare-async' ) ) {
	const prepareStart = performance.now();
	const preparePipelines = profiler.pipelineSnapshot();
	await app.prepareAsync?.();
	profiler.profile.computePrepareMs = performance.now() - prepareStart;
	profiler.profile.computePreparation = profiler.pipelineDelta( preparePipelines );
	const compileStart = performance.now();
	const compilePipelines = profiler.pipelineSnapshot();
	const compiling = renderer.compileAsync( app.scene, app.camera );
	profiler.profile.compileAsyncSubmissionCpuMs = performance.now() - compileStart;
	await compiling;
	await profiler.settled();
	profiler.profile.compileAsyncCompletionMs = performance.now() - compileStart;
	profiler.profile.compilePreparation = profiler.pipelineDelta( compilePipelines );
	profiler.profile.prepareAsyncMs = performance.now() - prepareStart;
}
profiler.profile.setupPipelines = profiler.pipelineSnapshot();
const firstStart = performance.now(); draw( 0 );
profiler.profile.firstFrameCpuMs = performance.now() - firstStart;
await renderer.backend.device.queue.onSubmittedWorkDone();
await profiler.settled();
profiler.profile.firstFrameWallMs = performance.now() - firstStart;
profiler.profile.firstFrameGpuWaitMs = profiler.profile.firstFrameWallMs - profiler.profile.firstFrameCpuMs;
profiler.profile.firstFramePipelines = profiler.pipelineDelta( profiler.profile.setupPipelines );
profiler.profile.readyFromEntryMs = performance.now() - started;
profiler.profile.readyFromNavigationMs = performance.now();
profiler.profile.startupShaderNodes = profiler.profile.shaderNodes;
profiler.profile.startupBuilderCalls = profiler.profile.builderCalls;
if ( import.meta.env.DEV ) {
	await setup.waitForCaptureSettled( { since: baseline, timeoutMs: 30000, settleMs: 100 } );
	// Exercise every authored material on its real object/pass before capture.
	for ( const variant of app.variants ) {
		app.selectVariant( variant );
		for ( let i = 0; i < 3; i ++ ) { await new Promise( resolve => requestAnimationFrame( resolve ) ); draw( i / 60 ); }
		await setup.waitForCaptureSettled( { since: baseline, timeoutMs: 30000, settleMs: 100 } );
	}
	await setup.waitForCaptureSettled( { since: baseline, timeoutMs: 30000, settleMs: 100 } );
	const [ runtime, three ] = await Promise.all( [ import( '@tsl-precompile/runtime' ), import( 'three/webgpu' ) ] );
	const auxiliary = await runtime.precompileAuxiliary( renderer, app.scene, app.camera, {
		three, threeVersion: globalThis.__TSLP_THREE_PACKAGE_VERSION__, devEndpoint: '/__tsl-precompile/capture',
		pmremSceneSizes: app.pmremSceneSizes || [],
		pmremSourceTextures: app.pmremSourceTextures || [],
		...( app.pipeline ? { postProcessing: app.pipeline, renderPipeline: app.pipeline, postProcessingName: app.pipelineName } : {} ),
	} );
	const failures = auxiliary.filter( item => item.ok === false );
	if ( failures.length ) throw new Error( `Auxiliary capture failed: ${ JSON.stringify( failures ) }` );
	await setup.waitForCaptureSettled( { since: baseline, timeoutMs: 30000, settleMs: 100 } );
}
app.selectVariant( app.variants[ 0 ] );
renderer.backend.trackTimestamp = false;
window.__TSLP_SHOWCASE__ = profiler.start( app, draw, definition );
