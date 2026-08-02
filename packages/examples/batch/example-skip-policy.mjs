export const E2E_EXAMPLE_SKIP_PREFIXES = Object.freeze( [
	'webxr_',
	'vr_',
	'ar_',
	'webgpu_xr_',
	'webgpu_webxr_',
	'webgpu_compile_async',
	'webgpu_tsl_precompile',
	'webgpu_tsl_transpiler',
] );

export function matchesExampleSkipPrefix( name, prefixes ) {

	return prefixes.some( ( prefix ) => name.startsWith( prefix ) );

}

export function shouldSkipE2EExample( name ) {

	return matchesExampleSkipPrefix( name, E2E_EXAMPLE_SKIP_PREFIXES );

}
