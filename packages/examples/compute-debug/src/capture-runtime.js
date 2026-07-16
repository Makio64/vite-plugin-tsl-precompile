/** Compiler/capture dependencies are loaded only by the development branch. */
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
