// Generated PMREM registries provide this capability only when the build has
// captured PMREM passes. Ordinary renderer imports must not retain the generator.
let factory = null;

export function setReplayPMREMGeneratorFactory( create ) {

	if ( typeof create === 'function' ) factory = create;

}

export function createReplayPMREMGenerator( renderer ) {

	if ( ! factory ) throw new Error( '[tsl-precompile/slim] PMREM replay is unavailable. Capture the environment source and load the generated auxiliary registry before rendering.' );
	return factory( renderer );

}
