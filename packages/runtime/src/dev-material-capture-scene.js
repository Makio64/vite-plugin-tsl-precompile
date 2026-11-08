/** Dev capture scene copies and temporary geometry ownership. */

const LIGHT_NODE_GRAPH_PROPS = [ 'colorNode' ];

/**
 * Clone every light from the source scene into the destination throwaway
 * scene. We must clone — never reparent — because `Object3D.add()` removes
 * the light from its existing parent and breaks the user's real render pass.
 *
 * three.js's `Light.clone()` (inherited via `Object3D.clone()`) covers every
 * built-in light class: AmbientLight, DirectionalLight, HemisphereLight,
 * PointLight, RectAreaLight, SpotLight, plus the IES/probe variants. It
 * preserves `color`, `intensity`, `position`, `distance`, `decay`, `angle`,
 * `penumbra`, `castShadow`, etc. via the standard `copy()` chain.
 *
 * Targets (DirectionalLight.target, SpotLight.target) are themselves Object3Ds
 * that live in the user's scene graph; `light.clone()` deep-clones the target
 * by default, so the cloned target carries the original target's transform
 * but is unparented. We add it to the throwaway scene alongside the light so
 * `updateMatrixWorld()` finds it during extraction.
 *
 * Lights nested inside transformed parents (e.g. a `PointLight` child of a
 * moving `particleLight` mesh) need their world transform baked in — the
 * throwaway scene won't replicate the parent chain. We compute the source
 * light's world matrix and decompose it onto the clone's local transform.
 *
 * @param {Object} sourceScene - The user's real scene (any Object3D with .traverse).
 * @param {Object} destScene - The throwaway scene to populate.
 */
export function cloneLightsInto( sourceScene, destScene ) {

	if ( ! sourceScene || typeof sourceScene.traverse !== 'function' ) return;
	const lights = [];
	sourceScene.traverse( ( o ) => {

		if ( o && o.isLight === true ) lights.push( o );

	} );
	if ( lights.length === 0 ) return;
	// Preserve r185's shader construction order, which follows creation ids,
	// even when a later-created nested light precedes older lights in traversal.
	lights.sort( ( a, b ) => ( a.id || 0 ) - ( b.id || 0 ) );

	// Make sure world matrices are current; users typically call
	// `scene.updateMatrixWorld()` once per frame before render, but the
	// extraction marker can fire from a microtask outside the render loop.
	if ( typeof sourceScene.updateMatrixWorld === 'function' ) sourceScene.updateMatrixWorld( true );

	for ( const light of lights ) {

		let cloned;
		try {

			cloned = typeof light.clone === 'function' ? light.clone() : null;

		} catch ( _ ) {

			cloned = null;

		}
		if ( ! cloned ) continue;
		stripClonedLightChildren( cloned );
		copyLightNodeGraphProps( light, cloned );

		// Bake world transform into the clone so a light parented under a
		// moving rig still illuminates from the right place during capture.
		// We only bother when the source has a non-identity world matrix
		// different from its local matrix (i.e. a non-Scene parent).
		if ( light.matrixWorld && light.parent && light.parent.isScene !== true ) {

			cloned.matrix.copy( light.matrixWorld );
			cloned.matrix.decompose( cloned.position, cloned.quaternion, cloned.scale );
			cloned.matrixWorldNeedsUpdate = true;

		}

		destScene.add( cloned );

		// SpotLight / DirectionalLight carry a separate `target` Object3D.
		// `Light.clone()` already deep-clones it, but the cloned target
		// stays unparented, so its world matrix never updates. Mirror the
		// source target's world transform onto the clone's target and add
		// it to the destination scene.
		if ( cloned.target && cloned.target.isObject3D && cloned.target !== cloned ) {

			const srcTarget = light.target;
			if ( srcTarget && srcTarget.matrixWorld ) {

				cloned.target.matrix.copy( srcTarget.matrixWorld );
				cloned.target.matrix.decompose( cloned.target.position, cloned.target.quaternion, cloned.target.scale );
				cloned.target.matrixWorldNeedsUpdate = true;

			}
			// Only attach if the target isn't already a descendant of the
			// cloned light (some custom Light subclasses parent target to
			// themselves).
			if ( ! cloned.target.parent ) destScene.add( cloned.target );

		}

	}

}

function copyLightNodeGraphProps( source, target ) {

	if ( ! source || ! target ) return;
	for ( const key of LIGHT_NODE_GRAPH_PROPS ) {

		if ( source[ key ] !== undefined ) target[ key ] = source[ key ];

	}

}

function stripClonedLightChildren( light ) {

	if ( ! light || ! Array.isArray( light.children ) ) return;
	const keep = light.target && light.target.isObject3D ? light.target : null;
	for ( const child of [ ...light.children ] ) {

		if ( child === keep ) continue;
		try { light.remove( child ); } catch ( _ ) {}

	}

}

/**
 * Mirror the source object's ClippingGroup ancestry into the throwaway
 * extraction scene. Returns the Object3D the throwaway mesh should be
 * attached to — either the innermost cloned ClippingGroup, or the destScene
 * itself when the source has no ClippingGroup ancestors.
 *
 * Clones, never reparents — the live groups remain in the user's scene.
 * Order is outermost → innermost so the cloned chain matches the user's,
 * which matters because `ClippingContext.getGroupContext()` composes nested
 * contexts by walking parent → child and merging plane sets.
 *
 * @param {Function|undefined} ClippingGroup - The three.js ClippingGroup constructor.
 * @param {Object|null} sourceObject - The user's source mesh, may be null.
 * @param {Object} destScene - The throwaway scene root.
 * @return {Object} The Object3D the throwaway mesh should be added to.
 */
export function mountClippingGroupsInto( ClippingGroup, sourceObject, destScene ) {

	if ( ! ClippingGroup || ! sourceObject ) return destScene;

	const chain = [];
	let cursor = sourceObject.parent || null;
	while ( cursor ) {

		if ( cursor.isClippingGroup === true ) chain.unshift( cursor );
		cursor = cursor.parent || null;

	}
	if ( chain.length === 0 ) return destScene;

	let parent = destScene;
	for ( const group of chain ) {

		const cloned = new ClippingGroup();
		// `clippingPlanes` is an array of `Plane` instances. Share the same
		// references so the cloned group reflects live plane mutations during
		// extraction (the user might tweak plane.constant in a GUI between
		// scene mount and our extractor run; the captured shader is invariant
		// to the values, only the count/scope matters for shader shape).
		cloned.clippingPlanes = group.clippingPlanes;
		cloned.enabled = group.enabled;
		cloned.clipIntersection = group.clipIntersection;
		cloned.clipShadows = group.clipShadows;
		parent.add( cloned );
		parent = cloned;

	}
	return parent;

}

/**
 * Walk up an Object3D's parent chain to find the Scene it lives in. Returns
 * the Scene instance (anything with `.isScene === true`) or null. Used by
 * the precompile marker so the throwaway extraction scene can inherit the
 * real scene's environment / lights / fog — without that, PBR materials
 * extract without IBL bindings even when scene.environment is set.
 *
 * @param {Object3D|null} obj
 * @return {Object|null}
 */
export function findParentScene( obj ) {

	let cursor = obj;
	while ( cursor ) {

		if ( cursor.isScene === true ) return cursor;
		cursor = cursor.parent || null;

	}
	return null;

}

export function createCaptureObject( Mesh, BoxGeometry, sourceObject, material, ownedGeometries = null ) {

	if ( sourceObject && typeof sourceObject.clone === 'function' ) {

		try {

			const cloned = sourceObject.clone( false );
			if ( cloned && cloned !== sourceObject ) {

				cloned.parent = null;
				if ( Array.isArray( cloned.children ) && cloned.children.length > 0 ) cloned.children.length = 0;
				cloned.material = Array.isArray( sourceObject.material ) ? sourceObject.material : material;
				mirrorCaptureObjectRuntimeProperties( cloned, sourceObject );
				normalizeDetachedVisualHelper( cloned, sourceObject, Mesh );
				return cloned;

			}

		} catch ( _ ) {

			// Custom Object3D subclasses sometimes require constructor arguments
			// and do not implement clone(). Fall through to a conservative Mesh
			// surrogate while mirroring renderer-dispatch flags below.

		}

	}

	let geometry = sourceObject && sourceObject.geometry;
	if ( ! geometry ) {

		geometry = new BoxGeometry( 1, 1, 1 );
		if ( ownedGeometries ) ownedGeometries.push( geometry );

	}
	const fallback = new Mesh( geometry, material );
	if ( sourceObject ) {

		for ( const key of [
			'isSkinnedMesh', 'isInstancedMesh', 'isBatchedMesh', 'isSprite',
			'isLine', 'isLineSegments', 'isPoints', 'isQuadMesh',
		] ) {

			if ( sourceObject[ key ] === true ) fallback[ key ] = true;

		}
		mirrorCaptureObjectRuntimeProperties( fallback, sourceObject );

	}
	return fallback;

}

function normalizeDetachedVisualHelper( target, sourceObject, Mesh ) {

	const helperType = sourceObject && ( sourceObject.type || sourceObject.constructor && sourceObject.constructor.name ) || '';
	if ( sourceObject && sourceObject.isHelper !== true && ! /Helper$/.test( helperType ) ) return;
	const baseUpdateMatrixWorld = Mesh && Mesh.prototype && Mesh.prototype.updateMatrixWorld;
	if ( typeof baseUpdateMatrixWorld === 'function' ) target.updateMatrixWorld = baseUpdateMatrixWorld;

}

function mirrorCaptureObjectRuntimeProperties( target, sourceObject ) {

	for ( const key of [
		'skeleton', 'bindMatrix', 'bindMatrixInverse', 'instanceMatrix',
		'instanceColor', 'morphTargetInfluences', 'morphTargetDictionary',
		'_matricesTexture', '_colorsTexture', 'count',
	] ) {

		if ( sourceObject[ key ] !== undefined ) target[ key ] = sourceObject[ key ];

	}

}

