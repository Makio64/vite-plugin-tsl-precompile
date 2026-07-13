/**
 * Per-frame light uniform writers and light-identity resolution.
 *
 * Carved out of `hydrator.js` so the hydrator stays orchestration and the
 * light-binding model is testable on its own. Three responsibilities:
 *
 *  1. **Identity** — given a captured `source` (lightUuid / lightIndex /
 *     value snapshot), find the live `Light` on the runtime scene. The
 *     resolution order is uuid → snapshot match → traversal index. Hits
 *     populate a per-scene uuid remap so subsequent lookups are O(1).
 *
 *  2. **Diagnostics** — append events to `globalThis.__tslpHarnessDiagnostics`
 *     when the matching debug flags are set. Off by default; cost is a
 *     single global flag check on the hot path.
 *
 *  3. **Per-frame writes** — `writeLightValue()` writes intensity-scaled
 *     color, distance, decay, view-space position, shadow matrix/bias/etc.
 *     into the UBO. `findShadowMatrixLightForSlot()` pairs unnamed
 *     `uniform.live` mat4 slots with their owning light by sibling-order
 *     analysis of `light.shadow*` slots.
 *
 * @module hydrate/light-writers
 */

import { Matrix4, Vector3, WebGPUCoordinateSystem } from 'three';
import { writeMat4, writeNumber, writeSnapshot, writeVec2, writeVec3 } from './snapshot-writers.js';

// Module-scoped scratch — reused per frame to avoid GC pressure. These are
// distinct from the material-writers scratch so the per-frame interleaving
// of `writeUniformGroup` ↔ `writeLightValue` can't collide.
const _lvec = new Vector3();
const _lightMatchVec = new Vector3();
const _mwi = new Matrix4();
const _m4rot = new Matrix4();

/**
 * Find the Nth light in a scene by numeric Object3D id. Mirrors the cache
 * strategy emit-updater.js bakes into AOT modules — both the AOT and
 * snapshot-based hydration paths use this as a fallback when a captured
 * light UUID is unavailable.
 *
 * The cache key is the Scene instance; lights added/removed mid-session
 * won't invalidate the cache. That's acceptable for now: scene-graph
 * lighting changes are rare and the alternative (per-frame retraversal)
 * would tax every UBO update for materials with many light-driven slots.
 */
export function getSceneLights( scene ) {

	if ( ! scene ) return [];
	let cache = scene._tslpLightCache;
	if ( ! cache || cache.scene !== scene ) {

		cache = { scene, lights: [] };
		scene._tslpLightCache = cache;
		if ( typeof scene.traverse === 'function' ) {

			scene.traverse( ( o ) => {

				if ( o && o.isLight === true ) cache.lights.push( o );

			} );
			cache.lights.sort( ( a, b ) => ( Number.isFinite( a && a.id ) ? a.id : 0 ) - ( Number.isFinite( b && b.id ) ? b.id : 0 ) );

		}

	}
	return cache.lights;

}

export function findLightInScene( scene, index ) {

	const lights = getSceneLights( scene );
	return lights[ index ] || null;

}

function snapshotArray( source, type ) {

	const snap = source && source.valueSnapshot;
	if ( ! snap || snap.type !== type || ! Array.isArray( snap.data ) ) return null;
	return snap.data;

}

function vecDistanceSq( a, b ) {

	if ( ! a || ! b || b.length < 3 ) return Infinity;
	const dx = a.x - b[ 0 ];
	const dy = a.y - b[ 1 ];
	const dz = a.z - b[ 2 ];
	return dx * dx + dy * dy + dz * dz;

}

function colorDistanceSq( light, data ) {

	if ( ! light || ! light.color || ! data || data.length < 3 ) return Infinity;
	const intensity = Number.isFinite( light.intensity ) ? light.intensity : 1;
	const r = light.color.r * intensity - data[ 0 ];
	const g = light.color.g * intensity - data[ 1 ];
	const b = light.color.b * intensity - data[ 2 ];
	return r * r + g * g + b * b;

}

export function findLightBySnapshot( scene, source, frame = null ) {

	const lights = getSceneLights( scene );
	if ( lights.length === 0 || ! source ) return null;
	let best = null;
	let bestScore = Infinity;

	if ( source.kind === 'light.colorScaled' ) {

		const data = snapshotArray( source, 'color' );
		if ( data ) {

			for ( const light of lights ) {

				const score = colorDistanceSq( light, data );
				if ( score < bestScore ) {

					bestScore = score;
					best = light;

				}

			}
			return bestScore < 1e-3 ? best : null;

		}

	}

	const vec = snapshotArray( source, 'vec3' );
	if ( ! vec ) return null;
	for ( const light of lights ) {

		if ( ! light || ! light.matrixWorld ) continue;
		if ( source.kind === 'light.viewPosition' ) {

			if ( ! ( frame && frame.camera && frame.camera.matrixWorldInverse ) ) continue;
			_lightMatchVec.setFromMatrixPosition( light.matrixWorld ).applyMatrix4( frame.camera.matrixWorldInverse );

		} else if ( source.kind === 'light.position' ) {

			_lightMatchVec.setFromMatrixPosition( light.matrixWorld );

		} else if ( source.kind === 'light.targetPosition' && light.target && light.target.matrixWorld ) {

			_lightMatchVec.setFromMatrixPosition( light.target.matrixWorld );

		} else {

			continue;

		}

		const score = vecDistanceSq( _lightMatchVec, vec );
		if ( score < bestScore ) {

			bestScore = score;
			best = light;

		}

	}
	return bestScore < 1e-4 ? best : null;

}

export function findLightBySource( scene, source, frame = null ) {

	if ( ! scene || ! source ) return null;
	if ( source.lightUuid && typeof scene.traverse === 'function' ) {

		let found = null;
		scene.traverse( ( o ) => {

			if ( found ) return;
			if ( o && o.isLight === true && o.uuid === source.lightUuid ) found = o;

		} );
		if ( found ) return found;
		const remap = scene._tslpLightUuidRemap;
		if ( remap && remap.has( source.lightUuid ) ) return remap.get( source.lightUuid );

	}
	const snapshotMatch = findLightBySnapshot( scene, source, frame );
	if ( snapshotMatch ) {

		if ( source.lightUuid ) {

			let remap = scene._tslpLightUuidRemap;
			if ( ! remap ) {

				remap = new Map();
				scene._tslpLightUuidRemap = remap;

			}
			remap.set( source.lightUuid, snapshotMatch );

		}
		return snapshotMatch;

	}
	const lightIndex = Number.isInteger( source.lightIndex ) ? source.lightIndex : 0;
	return findLightInScene( scene, lightIndex );

}

export function recordLightLinkDiagnostic( event ) {

	try {

		const root = typeof globalThis !== 'undefined' ? globalThis : null;
		if ( ! root || root.__TSLP_DEBUG_LIGHT_LINKAGE !== true ) return;
		const diag = root.__tslpHarnessDiagnostics || ( root.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
		const list = diag.lightLinkage || ( diag.lightLinkage = [] );
		if ( list.length < 120 ) list.push( event );

	} catch ( _ ) {}

}

export function recordShadowBindingDiagnostic( event ) {

	try {

		const root = typeof globalThis !== 'undefined' ? globalThis : null;
		if ( ! root || root.__TSLP_DEBUG_SHADOW_BINDINGS !== true ) return;
		const diag = root.__tslpHarnessDiagnostics || ( root.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
		const list = diag.shadowBindings || ( diag.shadowBindings = [] );
		if ( list.length < 500 ) list.push( event );

	} catch ( _ ) {}

}

export function lightDiagnosticShape( light ) {

	if ( ! light ) return null;
	let position = null;
	try {

		if ( light.matrixWorld ) {

			_lvec.setFromMatrixPosition( light.matrixWorld );
			position = [ _lvec.x, _lvec.y, _lvec.z ];

		}

	} catch ( _ ) {}
	return {
		type: light.isSpotLight ? 'spot' : light.isDirectionalLight ? 'directional' : light.isAmbientLight ? 'ambient' : light.type || 'light',
		uuid: light.uuid || null,
		intensity: Number.isFinite( light.intensity ) ? light.intensity : null,
		position,
	};

}

/**
 * Locate the live `Light` that owns the shadow matrix written into an
 * unnamed `uniform.live` mat4 slot. Stock TSL emits shadow matrices as
 * anonymous `UniformNode<mat4>` siblings of the named `light.shadow*`
 * slots — they carry no `source.name`, so we pair them by offset order:
 * the kth anonymous mat4 belongs to the kth shadow-emitting light in the
 * group.
 *
 * Returns null when no shadow-matrix pattern is detected or when the slot
 * isn't the canonical mat4 shape.
 */
export function findShadowMatrixLightForSlot( group, slot, frame ) {

	if ( ! group || ! frame || ! frame.scene ) return null;
	const source = slot && slot.source || {};
	if ( source.kind !== 'uniform.live' || source.name ) return null;

	const slots = Array.isArray( group.slots ) ? group.slots : [];
	const shadowGroups = [];
	const seenLightIndices = new Set();
	for ( const sibling of slots ) {

		const siblingSource = sibling && sibling.source || {};
		if ( siblingSource.kind && siblingSource.kind.startsWith( 'light.shadow' ) && Number.isInteger( siblingSource.lightIndex ) && ! seenLightIndices.has( siblingSource.lightIndex ) ) {

			seenLightIndices.add( siblingSource.lightIndex );
			shadowGroups.push( {
				lightIndex: siblingSource.lightIndex,
				lightUuid: siblingSource.lightUuid || null,
				offset: sibling.offset ?? sibling.byteOffset ?? Number.POSITIVE_INFINITY,
			} );

		}

	}
	if ( shadowGroups.length === 0 ) return null;

	shadowGroups.sort( ( a, b ) => a.offset - b.offset );

	const liveShadowMatrices = slots
		.filter( ( sibling ) => {

			const siblingSource = sibling && sibling.source || {};
			return sibling && sibling.dtype === 'mat4' && siblingSource.kind === 'uniform.live' && ! siblingSource.name;

		} )
		.sort( ( a, b ) => ( a.offset ?? a.byteOffset ?? 0 ) - ( b.offset ?? b.byteOffset ?? 0 ) );
	const matrixIndex = liveShadowMatrices.indexOf( slot );
	if ( matrixIndex >= 0 && shadowGroups.length >= liveShadowMatrices.length ) {

		const light = findLightBySource( frame.scene, shadowGroups[ matrixIndex ] );
		recordLightLinkDiagnostic( {
			kind: 'light.shadowMatrix',
			slotOffset: slot.offset ?? slot.byteOffset ?? 0,
			source: shadowGroups[ matrixIndex ],
			light: lightDiagnosticShape( light ),
			matrix: light && light.shadow && light.shadow.matrix && light.shadow.matrix.elements ? light.shadow.matrix.elements.slice() : null,
		} );
		return light;

	}

	const slotOffset = slot.offset ?? slot.byteOffset ?? 0;
	const nextShadowGroup = shadowGroups.find( ( entry ) => entry.offset > slotOffset );
	if ( nextShadowGroup ) {

		const light = findLightBySource( frame.scene, nextShadowGroup );
		recordLightLinkDiagnostic( {
			kind: 'light.shadowMatrix',
			slotOffset,
			source: nextShadowGroup,
			light: lightDiagnosticShape( light ),
			matrix: light && light.shadow && light.shadow.matrix && light.shadow.matrix.elements ? light.shadow.matrix.elements.slice() : null,
		} );
		return light;

	}
	return null;

}

/**
 * Refresh `light.shadow.matrix` for the current frame — mirrors
 * `LightShadow.updateMatrices()` and is safe before or after the renderer has
 * allocated `light.shadow.map`. Used by `writeLightValue` (`light.shadowMatrix`)
 * and by the shadow-matrix companion slot in `writeUniformGroup`
 * (`uniform.live` mat4).
 */
export function updateLightShadowMatrixForFrame( light, frame ) {

	if ( ! light || ! light.shadow ) return;
	if ( typeof light.shadow.updateMatrices !== 'function' ) return;
	if ( ( light.isPointLight === true || light.shadow.isPointLightShadow === true ) && light.shadow.matrix ) {

		try {

			if ( light.matrixWorld ) _lvec.setFromMatrixPosition( light.matrixWorld );
			else if ( light.position ) _lvec.copy( light.position );
			else return;
			light.shadow.matrix.makeTranslation( - _lvec.x, - _lvec.y, - _lvec.z );

		} catch ( _ ) {}
		return;

	}
	try {

		const shadowCamera = light.shadow.camera;
		const renderer = frame && frame.renderer;
		const frameCamera = frame && frame.camera;
		const coordinateSystem = renderer && renderer.coordinateSystem !== undefined ? renderer.coordinateSystem :
			frameCamera && frameCamera.coordinateSystem !== undefined ? frameCamera.coordinateSystem :
			WebGPUCoordinateSystem;
		if ( shadowCamera && coordinateSystem !== undefined && shadowCamera.coordinateSystem !== coordinateSystem ) {

			shadowCamera.coordinateSystem = coordinateSystem;
			if ( typeof shadowCamera.updateProjectionMatrix === 'function' ) shadowCamera.updateProjectionMatrix();

		}
		light.shadow.updateMatrices( light );

	} catch ( _ ) {}

}

/**
 * Per-frame writer for direct-light uniforms. Looks up the live `Light`
 * object on `frame.scene` by the `lightIndex` baked into the source at
 * extract time, then writes the live value (intensity-scaled color, decay
 * exponent, view-space position, ...) into the UBO. Without this, captures
 * freeze at extraction-time light state and animated `light.intensity` /
 * `light.position` etc. never reach the GPU.
 *
 * Falls back to the captured snapshot (if any) when the indexed light
 * can't be resolved — e.g. JSON-loaded artifact replayed against a scene
 * that no longer has that light. Three.js itself would render with the
 * frozen value too in that case.
 */
export function writeLightValue( view, offset, kind, source, frame ) {

	const light = frame && frame.scene ? findLightBySource( frame.scene, source, frame ) : null;
	recordLightLinkDiagnostic( {
		kind,
		source: source ? {
			lightIndex: Number.isInteger( source.lightIndex ) ? source.lightIndex : null,
			lightUuid: source.lightUuid || null,
		} : null,
		light: lightDiagnosticShape( light ),
	} );

	if ( ! light ) {

		// Captured fallback — keeps PSNR within reach when the runtime
		// scene differs from capture (no light at the captured index).
		writeSnapshot( view, offset, source.valueSnapshot );
		return;

	}

	switch ( kind ) {

		case 'light.colorScaled': {

			// Mirror AnalyticLightNode.update(): copy color + scale by
			// intensity. Re-use a scratch field on `frame.scene` to avoid
			// allocating per call; small enough to inline directly via
			// component math instead of a Color helper.
			const c = light.color || null;
			const intensity = Number.isFinite( light.intensity ) ? light.intensity : 1;
			const r = c ? c.r * intensity : 0;
			const g = c ? c.g * intensity : 0;
			const b = c ? c.b * intensity : 0;
			view.setFloat32( offset, r, true );
			view.setFloat32( offset + 4, g, true );
			view.setFloat32( offset + 8, b, true );
			return;

		}
		case 'light.distance':
			writeNumber( view, offset, Number.isFinite( light.distance ) ? light.distance : 0 );
			return;
		case 'light.decay':
			writeNumber( view, offset, Number.isFinite( light.decay ) ? light.decay : 2 );
			return;
		case 'light.coneCos':
			writeNumber( view, offset, Math.cos( light.angle || 0 ) );
			return;
		case 'light.penumbraCos':
			writeNumber( view, offset, Math.cos( ( light.angle || 0 ) * ( 1 - ( light.penumbra || 0 ) ) ) );
			return;
		case 'light.position':
			if ( light.matrixWorld ) {

				_lvec.setFromMatrixPosition( light.matrixWorld );
				writeVec3( view, offset, _lvec );

			} else writeSnapshot( view, offset, source.valueSnapshot );
			return;
		case 'light.viewPosition':
			if ( light.matrixWorld && frame.camera && frame.camera.matrixWorldInverse ) {

				_lvec.setFromMatrixPosition( light.matrixWorld );
				_lvec.applyMatrix4( frame.camera.matrixWorldInverse );
				writeVec3( view, offset, _lvec );

			} else writeSnapshot( view, offset, source.valueSnapshot );
			return;
		case 'light.targetPosition':
			if ( light.target && light.target.matrixWorld ) {

				_lvec.setFromMatrixPosition( light.target.matrixWorld );
				writeVec3( view, offset, _lvec );

			} else writeSnapshot( view, offset, source.valueSnapshot );
			return;
		case 'light.shadowMatrix':
			if ( light.shadow && light.shadow.matrix ) {

				updateLightShadowMatrixForFrame( light, frame );
				writeMat4( view, offset, light.shadow.matrix );

			} else writeSnapshot( view, offset, source.valueSnapshot );
			return;
		case 'light.shadowBias':
			writeNumber( view, offset, light.shadow ? light.shadow.bias : null, source.valueSnapshot );
			return;
		case 'light.shadowNormalBias':
			writeNumber( view, offset, light.shadow ? light.shadow.normalBias : null, source.valueSnapshot );
			return;
		case 'light.shadowRadius':
			writeNumber( view, offset, light.shadow ? light.shadow.radius : null, source.valueSnapshot );
			return;
		case 'light.shadowCameraNear':
			writeNumber( view, offset, light.shadow && light.shadow.camera ? light.shadow.camera.near : null, source.valueSnapshot );
			return;
		case 'light.shadowCameraFar':
			writeNumber( view, offset, light.shadow && light.shadow.camera ? light.shadow.camera.far : null, source.valueSnapshot );
			return;
		case 'light.shadowMapSize':
			writeVec2( view, offset, light.shadow ? light.shadow.mapSize : null, source.valueSnapshot );
			return;
		case 'light.shadowIntensity':
			writeNumber( view, offset, light.shadow && light.shadow.__tslpDisableReplayShadow === true ? 0 : light.shadow && Number.isFinite( light.shadow.intensity ) ? light.shadow.intensity : null, source.valueSnapshot );
			return;
		case 'light.halfWidth':
			if ( light.matrixWorld && frame.camera && frame.camera.matrixWorldInverse ) {

				_mwi.copy( light.matrixWorld ).premultiply( frame.camera.matrixWorldInverse );
				_m4rot.extractRotation( _mwi );
				_lvec.set( light.width * 0.5, 0, 0 ).applyMatrix4( _m4rot );
				writeVec3( view, offset, _lvec );

			} else writeSnapshot( view, offset, source.valueSnapshot );
			return;
		case 'light.halfHeight':
			if ( light.matrixWorld && frame.camera && frame.camera.matrixWorldInverse ) {

				_mwi.copy( light.matrixWorld ).premultiply( frame.camera.matrixWorldInverse );
				_m4rot.extractRotation( _mwi );
				_lvec.set( 0, light.height * 0.5, 0 ).applyMatrix4( _m4rot );
				writeVec3( view, offset, _lvec );

			} else writeSnapshot( view, offset, source.valueSnapshot );
			return;
		default:
			// Unknown light.* kind — fall back to snapshot.
			writeSnapshot( view, offset, source.valueSnapshot );
			return;

	}

}
