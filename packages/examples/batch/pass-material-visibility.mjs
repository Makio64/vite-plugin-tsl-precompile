/**
 * Mirror Three r184's RenderList transparent/opaque split for pass-scoped
 * artifact preparation. Materials excluded by a PassNode must not be
 * retargeted merely to satisfy that pass's MRT output count.
 */
export function isTransparentRenderMaterial( material ) {

	return !! ( material && (
		material.transparent === true ||
		Number( material.transmission ) > 0 ||
		material.transmissionNode && material.transmissionNode.isNode === true ||
		material.backdropNode && material.backdropNode.isNode === true
	) );

}

export function passRendersMaterial( passNode, material ) {

	if ( ! passNode ) return true;
	return isTransparentRenderMaterial( material )
		? passNode.transparent !== false
		: passNode.opaque !== false;

}
