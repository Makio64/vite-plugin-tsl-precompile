/**
 * Read Three's shared screen-vector identity without advancing renderer state.
 * r185 exposed the output node; r186/r187 keep only the module-owned vector.
 */
export function resolveScreenUniformSource( node ) {

	const kind = { size: 'renderer.size', viewport: 'renderer.viewport', dpr: 'renderer.dpr' }[ node.scope ];
	if ( ! kind ) return null;
	if ( node._output ) return { uniformNode: node._output, source: { kind } };
	if ( node.scope === 'dpr' || typeof node.update !== 'function' ) return null;
	let value = null;
	const capture = target => { value = target; return target; };
	try {

		node.update( { renderer: {
			getRenderTarget: () => null,
			getDrawingBufferSize: capture,
			getViewport: capture,
			getPixelRatio: () => 1,
		} } );

	} catch ( _ ) {

		return null;

	}
	const valid = node.scope === 'size' ? value?.isVector2 === true : value?.isVector4 === true;
	return valid ? { uniformValue: value, source: { kind } } : null;

}
