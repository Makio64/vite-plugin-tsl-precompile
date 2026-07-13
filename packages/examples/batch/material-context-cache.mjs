/**
 * Build a stable key for one material's object topology. Scene, camera, target,
 * and MRT stay on the queued capture item; artifact variants and pass retargeting
 * own those axes. The contract owns the topology vocabulary, while the fallback
 * keeps the batch harness usable with an older contract copy.
 */
export function createMaterialContextKey( createSignature, context = {} ) {

	if ( typeof createSignature === 'function' ) {

		try {

			const signature = createSignature( context );
			if ( typeof signature === 'string' && signature.length > 0 ) return signature;

		} catch ( _ ) {

			// Fall through to the graph-free object shape below.

		}

	}

	const object = context.object || null;
	const geometry = object && object.geometry || null;
	const attributes = geometry && geometry.attributes || {};
	return JSON.stringify( {
		object: object ? {
			type: object.type || object.constructor && object.constructor.name || null,
			skinned: object.isSkinnedMesh === true,
			instanced: object.isInstancedMesh === true,
			batched: object.isBatchedMesh === true,
			attributes: Object.keys( attributes ).sort().map( ( name ) => {

				const attribute = attributes[ name ] || {};
				return [ name, attribute.itemSize ?? null, attribute.normalized === true ];

			} ),
		} : null,
	} );

}

/**
 * Return the per-topology map for a material without retaining materials that
 * have left the scene. Capture stores artifact names; replay stores hydrated
 * PrecompiledMaterial instances in the same shape.
 */
export function getMaterialContextMap( cache, material, create = false ) {

	let contexts = cache.get( material );
	if ( ! contexts && create ) {

		contexts = new Map();
		cache.set( material, contexts );

	}
	return contexts || null;

}
