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
	runtime.installPrecompileMarker( three, { devEndpoint } );
	runtime.setDevRenderer( renderer );
	return { runtime, three };

}
