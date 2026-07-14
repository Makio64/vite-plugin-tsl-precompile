/**
 * Build the value used to skip unchanged inspector renders.
 *
 * Shader byte counts alone are insufficient: two accepted captures can have
 * equal-length WGSL while carrying different content hashes or diagnostics.
 * Keep this signature limited to values the panel renders so it stays cheap
 * enough to compute every frame.
 *
 * @param {Object} capture
 * @return {string}
 */
export function captureRenderKey( capture ) {

	const unsupported = Array.isArray( capture.unsupportedKinds )
		? capture.unsupportedKinds.map( ( entry ) => [ entry?.severity || '', entry?.kind || '', String( entry?.reason || '' ) ] )
		: [];
	return JSON.stringify( [
		capture.id,
		capture.hash || '',
		capture.configHash || '',
		capture.vertexBytes || 0,
		capture.fragmentBytes || 0,
		capture.computeBytes || 0,
		capture.bytesLabel || '',
		unsupported,
	] );

}
