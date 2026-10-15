/** Capture the native fullscreen draw without running its owning pipeline/effect graph. */
export function assertFullscreenQuadCapture( quad, scene, options ) {

	if ( ! quad ) return;
	if ( quad.isQuadMesh !== true || typeof quad.render !== 'function' || ! quad.material ||
		! Array.isArray( scene?.children ) || scene.children.length !== 1 || scene.children[ 0 ] !== quad ||
		options.renderPipeline ) throw new TypeError(
		'compileTSL: fullscreenQuad must be the sole native QuadMesh in the isolated capture scene, without a renderPipeline.',
	);
	if ( ! options.skipNodeUpdatesForMaterials?.includes( quad.material ) ) throw new TypeError(
		'compileTSL: fullscreenQuad capture must suppress the isolated material update phases.',
	);

}

export function renderCapturedFullscreenQuad( renderer, quad ) {

	const material = quad.material;
	const previousVertexNode = material.vertexNode;
	try {

		quad.render( renderer );

	} finally {

		// Native QuadMesh restores this only after a successful draw. Capture
		// must also restore it when the renderer or an exact selector rejects.
		material.vertexNode = previousVertexNode;

	}

}
