export function createComputePreparation( renderer, runner, compileComputeAsync ) {

	if ( ! compileComputeAsync ) return () => runner?.dispatchAsync();
	return async () => {

		if ( ! runner ) return;
		await renderer.compileComputeAsync( runner.node );
		return runner.dispatchAsync();

	};

}
