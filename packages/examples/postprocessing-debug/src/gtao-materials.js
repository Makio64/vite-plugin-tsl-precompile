/**
 * GTAO renders the scene into an MRT containing color, normal, and depth.
 * Those shaders are intentionally distinct from the standard single-target
 * material family even when the authored materials are otherwise identical.
 */
export function markGtaoMaterials( { floor, cube, sphere } ) {

	floor.precompile( 'postprocessing-debug-gtao-floor' );
	cube.precompile( 'postprocessing-debug-gtao-cube' );
	sphere.precompile( 'postprocessing-debug-gtao-sphere' );

}
