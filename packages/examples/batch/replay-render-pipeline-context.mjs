/** Bridge the harness transaction hooks to native r186/r187 callback arrays. */

export function createReplayRenderPipelineContext( pipeline, passNodes = [] ) {

	const context = {
		renderPipeline: pipeline,
		renderPipelineState: { viewOffsetOwner: null },
		passNodes,
		onBeforeRenderPipeline: null,
		onAfterRenderPipeline: null,
		onBeforePipelineCallbacks: [],
		onAfterPipelineCallbacks: [],
	};
	pipeline._context = context;
	// The native draw consumes the transaction once. Effect callbacks collected
	// during setup run inside that transaction at its scheduled boundary.
	pipeline._contextData = {
		...context,
		onBeforePipelineCallbacks: [ () => context.onBeforeRenderPipeline?.() ],
		onAfterPipelineCallbacks: [ () => context.onAfterRenderPipeline?.() ],
	};
	return context;

}

export function collectReplayRenderPipelineCallbacks( context, phase ) {

	const legacy = phase === 'before' ? context.onBeforeRenderPipeline : context.onAfterRenderPipeline;
	const callbacks = phase === 'before' ? context.onBeforePipelineCallbacks : context.onAfterPipelineCallbacks;
	const collected = [ ...( typeof legacy === 'function' ? [ legacy ] : [] ), ...callbacks ];
	return collected.length > 0 ? () => { for ( const callback of collected ) callback(); } : null;

}
