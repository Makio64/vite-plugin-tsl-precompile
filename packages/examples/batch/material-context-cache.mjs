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

const STOCK_NODE_MATERIAL_CLASSES = new Set( [
	'MeshBasicNodeMaterial',
	'MeshLambertNodeMaterial',
	'MeshStandardNodeMaterial',
	'MeshPhysicalNodeMaterial',
	'MeshPhongNodeMaterial',
	'MeshToonNodeMaterial',
	'MeshNormalNodeMaterial',
	'MeshMatcapNodeMaterial',
	'MeshSSSNodeMaterial',
	'LineBasicNodeMaterial',
	'LineDashedNodeMaterial',
	'Line2NodeMaterial',
	'PointsNodeMaterial',
	'SpriteNodeMaterial',
	'VolumeNodeMaterial',
] );

/**
 * Allocate page-local identities for live resources. Capture and replay each
 * build their own equivalence groups, so the numeric values need only be
 * stable for the lifetime of that page.
 */
export function createObjectIdentityKeyer() {

	const identities = new WeakMap();
	let nextIdentity = 1;
	return ( value ) => {

		if ( ! value || ( typeof value !== 'object' && typeof value !== 'function' ) ) return null;
		let identity = identities.get( value );
		if ( ! identity ) {

			identity = nextIdentity ++;
			identities.set( value, identity );

		}
		return identity;

	};

}

/**
 * Return a conservative cross-material shader-topology key for stock
 * NodeMaterials. This deliberately rejects authored node graphs, subclasses,
 * per-object render hooks, and custom compiler hooks. It also requires every
 * material texture to be the same live object, which keeps shared artifact
 * texture refs owner-safe. Numeric uniforms such as roughness and metalness
 * are intentionally absent because generated updaters read them per owner.
 */
export function createStockMaterialTopologyKey( {
	material,
	object,
	className,
	contextKey,
	nodeKeys = [],
	textureProps = [],
	getObjectIdentity,
} = {} ) {

	if ( ! material || ! object || typeof contextKey !== 'string' || contextKey.length === 0 ) return null;
	if ( ! STOCK_NODE_MATERIAL_CLASSES.has( className ) ) return null;
	if ( material.isNodeMaterial !== true || material.type !== className ) return null;
	if ( ! material.constructor || material.constructor.name !== className ) return null;
	if ( typeof getObjectIdentity !== 'function' ) return null;
	if ( Object.prototype.hasOwnProperty.call( material, 'onBeforeCompile' ) || Object.prototype.hasOwnProperty.call( material, 'customProgramCacheKey' ) ) return null;
	if ( Object.prototype.hasOwnProperty.call( object, 'onBeforeRender' ) || Object.prototype.hasOwnProperty.call( object, 'onAfterRender' ) ) return null;

	const knownNodeKeys = new Set( nodeKeys );
	for ( const key of knownNodeKeys ) {

		let value = null;
		try { value = material[ key ]; } catch ( _ ) { return null; }
		if ( value && value.isNode === true ) return null;

	}
	for ( const key of Object.getOwnPropertyNames( material ) ) {

		if ( ! key.endsWith( 'Node' ) || knownNodeKeys.has( key ) ) continue;
		let value = null;
		try { value = material[ key ]; } catch ( _ ) { return null; }
		if ( value && value.isNode === true ) return null;

	}

	const textures = [];
	for ( const property of textureProps ) {

		let texture = null;
		try { texture = material[ property ]; } catch ( _ ) { return null; }
		if ( ! texture || texture.isTexture !== true ) continue;
		const identity = getObjectIdentity( texture );
		if ( identity === null || identity === undefined ) return null;
		textures.push( [ property, identity ] );

	}

	const defines = stablePrimitiveRecord( material.defines );
	if ( defines === null ) return null;
	return JSON.stringify( {
		version: 1,
		className,
		contextKey,
		layers: object.layers && Number.isFinite( object.layers.mask ) ? object.layers.mask : null,
		defines,
		textures,
	} );

}

/** Return the topology representatives owned by one live Scene. */
export function getSceneTopologyMap( cache, scene, create = false ) {

	if ( ! scene || ( typeof scene !== 'object' && typeof scene !== 'function' ) ) return null;
	let topologies = cache.get( scene );
	if ( ! topologies && create ) {

		topologies = new Map();
		cache.set( scene, topologies );

	}
	return topologies || null;

}

const TOPOLOGY_CAPTURE_CONTEXT_FIELDS = Object.freeze( [
	'material',
	'scene',
	'camera',
	'object',
	'renderer',
	'renderTarget',
	'mrt',
] );

/**
 * Remember one material that was collapsed into an existing stock-material
 * topology representative. The caller has already proved equivalence with
 * createStockMaterialTopologyKey(); this helper deliberately does not merge
 * candidates across pending items or topology keys.
 */
export function rememberTopologyCaptureCandidate( pendingItem, candidate ) {

	if ( ! pendingItem || ! candidate?.material || candidate.material === pendingItem.material ) return false;
	let candidates = pendingItem.topologyCaptureCandidates;
	if ( ! Array.isArray( candidates ) ) {

		candidates = [];
		Object.defineProperty( pendingItem, 'topologyCaptureCandidates', {
			value: candidates,
			configurable: true,
		} );

	}
	let stored = candidates.find( ( entry ) => entry.material === candidate.material );
	if ( ! stored ) {

		stored = {};
		candidates.push( stored );

	}
	for ( const field of TOPOLOGY_CAPTURE_CONTEXT_FIELDS ) stored[ field ] = candidate[ field ] ?? null;
	return true;

}

/**
 * Replace an unobserved traversal-first topology representative with the
 * first equivalent sibling that reached Renderer.renderObject(). This keeps
 * capture names stable while ensuring the runtime observer and the material
 * passed to precompile() have the same identity.
 */
export function promoteObservedTopologyCaptureCandidate( pendingItem, observedMaterials ) {

	if ( ! pendingItem || ! observedMaterials || typeof observedMaterials.has !== 'function' ) return false;
	if ( pendingItem.material && observedMaterials.has( pendingItem.material ) ) return false;
	const candidates = Array.isArray( pendingItem.topologyCaptureCandidates )
		? pendingItem.topologyCaptureCandidates
		: [];
	const observed = candidates.find( ( candidate ) => candidate.material && observedMaterials.has( candidate.material ) );
	if ( ! observed ) return false;
	for ( const field of TOPOLOGY_CAPTURE_CONTEXT_FIELDS ) pendingItem[ field ] = observed[ field ] ?? null;
	if ( pendingItem.material && ! pendingItem.material.name && pendingItem.name ) pendingItem.material.name = pendingItem.name;
	return true;

}

function stablePrimitiveRecord( value ) {

	if ( value === undefined || value === null ) return [];
	if ( typeof value !== 'object' || Array.isArray( value ) ) return null;
	const entries = [];
	for ( const key of Object.keys( value ).sort() ) {

		const entry = value[ key ];
		if ( entry !== null && ! [ 'boolean', 'number', 'string' ].includes( typeof entry ) ) return null;
		entries.push( [ key, entry ] );

	}
	return entries;

}
