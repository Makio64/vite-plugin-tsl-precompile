function isWeakKey( value ) {

	return value !== null && ( typeof value === 'object' || typeof value === 'function' );

}

/**
 * Require target-owned evidence. A cube-looking attachment texture alone can
 * belong to a custom or ordinary target and must not activate this lifecycle.
 */
export function isVerifiedCubeRenderTarget( renderTarget ) {

	return isWeakKey( renderTarget ) && (
		readFlag( renderTarget, 'isCubeRenderTarget' ) === true ||
		readFlag( renderTarget, 'isWebGLCubeRenderTarget' ) === true
	);

}

/**
 * Own the one-shot pre-arm lifecycle per live material/renderer pair. Weak
 * ownership lets disposed scenes and renderers leave without explicit cleanup.
 */
export function createCubeCapturePrearmRegistry() {

	const renderersByMaterial = new WeakMap();
	return Object.freeze( {
		claim( { material, renderer, renderTarget, captureMaintenance = false } = {} ) {

			if ( captureMaintenance || ! isWeakKey( material ) || ! isWeakKey( renderer ) ||
				! isVerifiedCubeRenderTarget( renderTarget ) ) return false;
			let renderers = renderersByMaterial.get( material );
			if ( ! renderers ) {

				renderers = new WeakSet();
				renderersByMaterial.set( material, renderers );

			}
			if ( renderers.has( renderer ) ) return false;
			renderers.add( renderer );
			return true;

		},
	} );

}

function readFlag( object, property ) {

	try { return object && object[ property ]; } catch ( _ ) { return undefined; }

}
