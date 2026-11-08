import test from 'node:test';
import assert from 'node:assert/strict';
import RenderPipeline from 'three/src/renderers/common/RenderPipeline.js';
import {
	collectReplayRenderPipelineCallbacks,
	createReplayRenderPipelineContext,
} from '../replay-render-pipeline-context.mjs';

test( 'native pipeline first render runs each legacy and native effect callback once inside the transaction', () => {

	const renderer = { toneMapping: 0, outputColorSpace: 'srgb', xr: { enabled: false } };
	const pipeline = new RenderPipeline( renderer, {} );
	assert.equal( pipeline._contextData, null );
	const calls = [];
	const context = createReplayRenderPipelineContext( pipeline );
	context.onBeforeRenderPipeline = () => calls.push( 'legacy-before' );
	context.onAfterRenderPipeline = () => calls.push( 'legacy-after' );
	context.onBeforePipelineCallbacks.push( () => calls.push( 'native-before' ) );
	context.onAfterPipelineCallbacks.push( () => calls.push( 'native-after' ) );
	const before = collectReplayRenderPipelineCallbacks( context, 'before' );
	const after = collectReplayRenderPipelineCallbacks( context, 'after' );
	context.onBeforeRenderPipeline = () => { calls.push( 'transaction' ); before(); };
	context.onAfterRenderPipeline = after;
	pipeline._update = () => {};
	pipeline._quadMesh.render = () => calls.push( 'draw' );
	try {

		pipeline.render();
		pipeline.render();
		assert.deepEqual( calls, Array( 2 ).fill( [
			'transaction', 'legacy-before', 'native-before', 'draw', 'legacy-after', 'native-after',
		] ).flat() );
		assert.equal( pipeline._contextData.renderPipelineState, context.renderPipelineState );
		// The native wrapper reads the current transaction hook, including loader
		// deferrals and per-frame restoration, rather than a stale setup callback.
		context.onBeforeRenderPipeline = null;
		context.onAfterRenderPipeline = null;
		calls.length = 0;
		pipeline.render();
		assert.deepEqual( calls, [ 'draw' ] );

	} finally {

		pipeline.dispose();

	}

} );
