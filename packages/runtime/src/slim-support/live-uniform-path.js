const UNSAFE_NODE_PATH_SEGMENTS = new Set( [ '__proto__', 'prototype', 'constructor' ] );

export function resolveLiveNodePath( sourceMaterial, nodePath ) {

	if ( ! sourceMaterial || ! Array.isArray( nodePath ) || nodePath.length === 0 ) return null;
	let current = sourceMaterial;
	for ( const segment of nodePath ) {

		if ( typeof segment !== 'string' || segment.length === 0 || UNSAFE_NODE_PATH_SEGMENTS.has( segment ) ) return null;
		if ( ! current || ( typeof current !== 'object' && typeof current !== 'function' ) ) return null;
		if ( ! Object.prototype.hasOwnProperty.call( current, segment ) ) return null;
		try { current = current[ segment ]; } catch ( _ ) { return null; }

	}
	return current && current.isUniformNode === true ? current : null;

}

/** Resolve a serialized material owner before a family-wide closure sidecar. */
export function resolveLiveUniformValue( slot, material ) {

	const source = slot && slot.source || {};
	if ( source.kind === 'uniform.live' && ! source.property ) {

		const node = resolveLiveNodePath( material, source.nodePath );
		if ( node ) return node.value;

	}
	return slot && slot.__tslpLiveSidecarOverlay === true ? slot._liveNode?.value : undefined;

}
