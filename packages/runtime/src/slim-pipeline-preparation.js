/** Bounded asynchronous WebGPU preparation for replay objects without pass callbacks. */
export function createReplayPipelineBatch( renderer, onProgress, total, precompilationState ) {

	let promises = [], count = 0;
	const nodes = renderer._nodes;
	const stateful = typeof renderer._beginPreCompile === 'function';
	const flagged = typeof renderer._isPreCompiling === 'boolean';
	const begin = () => {

		if ( stateful ) renderer._beginPreCompile( precompilationState );
		else if ( flagged ) renderer._isPreCompiling = true;

	};
	const finish = () => {

		if ( stateful ) renderer._finishPreCompile();
		else if ( flagged ) renderer._isPreCompiling = false;

	};
	return {
		get size() { return count; },
		prepare( renderObject ) {

			if ( renderer.backend?.isWebGPUBackend !== true || renderObject.material?.isPrecompiledMaterial !== true ) return false;
			const state = renderObject.getNodeBuilderState();
			if ( ! Array.isArray( state.updateBeforeNodes ) || state.updateBeforeNodes.length !== 0 ||
				! Array.isArray( state.updateAfterNodes ) || state.updateAfterNodes.length !== 0 ) return false;
			begin();
			try {

				nodes.updateBefore( renderObject );
				renderer._geometries.updateForRender( renderObject );
				nodes.updateForRender( renderObject );
				renderer._bindings.updateForRender( renderObject );

			} finally { finish(); }
			renderer._pipelines.getForRender( renderObject, promises );
			begin();
			try { nodes.updateAfter( renderObject ); } finally { finish(); }
			count ++;
			return true;

		},
		async flush( loaded ) {

			if ( count === 0 ) return loaded;
			const pending = promises, completed = count;
			promises = []; count = 0;
			await Promise.all( pending );
			for ( let index = 0; index < completed; index ++ ) {

				loaded ++;
				if ( onProgress !== null ) onProgress( new globalThis.ProgressEvent( 'progress', { lengthComputable: true, loaded, total } ) );

			}
			return loaded;

		},
	};

}
