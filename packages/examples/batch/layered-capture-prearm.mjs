function isWeakKey( value ) {

	return value !== null && ( typeof value === 'object' || typeof value === 'function' );

}

function read( object, property ) {

	try { return object && object[ property ]; } catch ( _ ) { return undefined; }

}

/**
 * Recognize only target-owned layered attachments. Texture flags by themselves
 * are insufficient because arbitrary sampled textures can be array/3D data.
 */
export function isVerifiedLayeredRenderTarget( renderTarget ) {

	if ( ! isWeakKey( renderTarget ) || read( renderTarget, 'isRenderTarget' ) !== true ) return false;
	if (
		read( renderTarget, 'isCubeRenderTarget' ) === true ||
		read( renderTarget, 'isWebGLCubeRenderTarget' ) === true
	) return false;

	const depth = read( renderTarget, 'depth' );
	if ( ! Number.isSafeInteger( depth ) || depth <= 1 ) return false;

	const texture = read( renderTarget, 'texture' );
	if ( ! isWeakKey( texture ) ) return false;
	if ( read( renderTarget, 'isRenderTarget3D' ) === true ) {

		return read( texture, 'isData3DTexture' ) === true;

	}

	return read( texture, 'isArrayTexture' ) === true ||
		read( texture, 'isDataArrayTexture' ) === true;

}

/**
 * A material/renderer pair needs one pre-arm. The first verified layered
 * QuadMesh render opens a real-render harvest; sibling array/3D calls in the
 * same synchronous r185 burst then join that family.
 */
export function createLayeredCapturePrearmRegistry() {

	const renderersByMaterial = new WeakMap();
	return Object.freeze( {
		claim( { material, renderer, renderTarget, captureMaintenance = false } = {} ) {

			if (
				captureMaintenance ||
				! isWeakKey( material ) ||
				! isWeakKey( renderer ) ||
				! isVerifiedLayeredRenderTarget( renderTarget )
			) return false;

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
