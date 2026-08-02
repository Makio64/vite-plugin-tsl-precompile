/**
 * Load compiler/capture-only dependencies without retaining them in a
 * production slim-source build. The raw batch harness does not define
 * `import.meta.env`, so it intentionally follows the capture branch.
 */
export async function setupCaptureRuntime( renderer, devEndpoint ) {

	if ( import.meta.env?.PROD === true ) return null;

	const [ runtime, three ] = await Promise.all( [
		import( '@tsl-precompile/runtime' ),
		import( 'three/webgpu' ),
	] );
	const setup = runtime.setupPrecompile( {
		three,
		renderer,
		devEndpoint,
		// Each route captures its named output topology explicitly after the
		// material-state preflight, so the generic automatic capture must not
		// claim the same deduplicated configuration first.
		captureRendererOutput: false,
	} );
	await setup.ready;
	return { runtime, three, setup };

}
