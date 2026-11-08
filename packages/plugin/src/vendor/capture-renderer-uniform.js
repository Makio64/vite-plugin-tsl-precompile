/** Classify numeric renderer-derived updates while leaving captured values intact. */
export function classifyRendererScalarCallback( node ) {

	if ( typeof node.value !== 'number' || node.updateType !== 'render' || typeof node.update !== 'function' ) return null;
	const originalValue = node.value;
	const probes = [
		{ width: 11, height: 80, dpr: 2 },
		{ width: 37, height: 160, dpr: 3 },
		{ width: 61, height: 120, dpr: 5 },
	];
	const values = [];
	try {

		for ( const probe of probes ) {

			node.update( { renderer: {
				getSize: () => ( { x: probe.width, y: probe.height, width: probe.width, height: probe.height } ),
				getPixelRatio: () => probe.dpr,
			} } );
			values.push( node.value );

		}
		if ( values.every( ( value, index ) => value === probes[ index ].dpr ) ) return { kind: 'renderer.dpr' };
		if ( values.every( ( value, index ) => value === 0.5 * probes[ index ].height ) ) return { kind: 'renderer.halfHeight' };

	} catch ( _ ) {

		return null;

	} finally {

		node.value = originalValue;

	}
	return null;

}
