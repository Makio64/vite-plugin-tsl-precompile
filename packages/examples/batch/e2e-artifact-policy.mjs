const AUX_ONLY_RENDER_SHAPES = Object.freeze( [ 'background', 'render-output' ] );

/**
 * A user-material artifact is sufficient by itself. An aux-only replay is
 * valid only when capture proves both halves of the renderer-owned draw path:
 * the background material that produces the scene color and the renderer
 * output material that presents it. Unrelated auxiliary artifacts must not
 * turn a missed user-material capture into a pass.
 */
export function hasReplayArtifactCoverage( userArtifacts = {}, auxArtifacts = [] ) {

	if ( Object.keys( userArtifacts || {} ).length > 0 ) return true;
	const shapes = new Set( ( Array.isArray( auxArtifacts ) ? auxArtifacts : [] )
		.map( ( entry ) => entry && entry.shape )
		.filter( Boolean ) );
	return AUX_ONLY_RENDER_SHAPES.every( ( shape ) => shapes.has( shape ) );

}
