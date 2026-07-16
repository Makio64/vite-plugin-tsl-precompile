/**
 * Build a stable key for one material's reproducible shader topology. Scene,
 * camera, target, and MRT stay on the queued capture item; artifact variants and
 * pass retargeting own those axes. Projecting the contract RenderObject selector
 * also drops physical vertex-buffer layout that can change after WebGPU uploads
 * without changing WGSL. The fallback keeps the batch harness usable with an
 * older contract copy.
 */
export function createMaterialContextKey( createSelector, context = {}, projectSelector = null ) {

	if ( typeof createSelector === 'function' ) {

		try {

			const object = context.object || null;
			const renderer = context.renderer || null;
			let selector = createSelector( {
				renderer,
				scene: null,
				camera: null,
				object,
				sourceGeometry: object && object.geometry || null,
				material: context.material || object && object.material || null,
				context: null,
				lightsNode: null,
				clippingContext: null,
			}, renderer );
			if ( typeof projectSelector === 'function' ) selector = projectSelector( selector, null );
			if ( typeof selector === 'string' && selector.length > 0 ) return selector;

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
