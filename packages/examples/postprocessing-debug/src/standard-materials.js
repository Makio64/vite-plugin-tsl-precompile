/**
 * Single-color-target routes share one signed material family. Keeping these
 * literal marker calls in their own entry-only module prevents GTAO's MRT
 * variants from entering the standard route bundles.
 */
export function markStandardMaterials( { floor, cube, sphere } ) {

	floor.precompile( 'postprocessing-debug-floor' );
	cube.precompile( 'postprocessing-debug-cube' );
	sphere.precompile( 'postprocessing-debug-sphere' );

}
