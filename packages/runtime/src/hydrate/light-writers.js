/**
 * Per-frame light uniform writers and light-identity resolution.
 *
 * Carved out of `hydrator.js` so the hydrator stays orchestration and the
 * light-binding model is testable on its own. Three responsibilities:
 *
 *  1. **Identity** — resolve a variant-local shared light identity against
 *     Three's active render-light list. Complete capture evidence is scored
 *     once for all slots, with one-to-one claims per table and topology.
 *     Legacy sources retain uuid → slot snapshot → index behavior.
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

import { Matrix4 } from 'three/src/math/Matrix4.js';
import { Vector3 } from 'three/src/math/Vector3.js';
import { WebGPUCoordinateSystem } from 'three/src/constants.js';
import { linkedLightIdentityForSource } from './light-identities.js';
import { writeMat4, writeNumber, writeSnapshot, writeVec2, writeVec3 } from './snapshot-writers.js';

// Module-scoped scratch — reused per frame to avoid GC pressure. These are
// distinct from the material-writers scratch so the per-frame interleaving
// of `writeUniformGroup` ↔ `writeLightValue` can't collide.
const _lvec = new Vector3();
const _lightMatchVec = new Vector3();
const _mwi = new Matrix4();
const _m4rot = new Matrix4();
const lightIdentitySceneCaches = new WeakMap();
const lightIdentityTableKeys = new WeakMap();
const identitySnapshotFields = [ 'position', 'targetPosition', 'color', 'intensity', 'distance', 'decay', 'angle', 'penumbra', 'width', 'height', 'castShadow', 'shadowType', 'cameraType' ];

/**
 * Return lights in the same order used by Three's current render object.
 * Generated and hydrated updaters both call this implementation, so exact
 * UUID, snapshot, and index fallbacks share one identity model.
 *
 * Outside an active render object, fall back to a visible, camera-layer-
 * filtered scene traversal sorted by numeric Object3D id. That fallback is
 * cached by the explicit scene light version, camera/layers, and frame id.
 */
function activeFrameLights( frame ) {

	const lightsNode = frame && ( frame.lightsNode || frame.renderObject && frame.renderObject.lightsNode );
	if ( ! lightsNode || typeof lightsNode.getLights !== 'function' ) return null;
	const lights = lightsNode.getLights();
	return Array.isArray( lights ) ? lights : null;

}

function isVisibleToCamera( object, camera ) {

	let current = object;
	while ( current ) {

		if ( current.visible === false ) return false;
		current = current.parent;

	}
	if ( ! camera || ! camera.layers || ! object.layers ) return true;
	if ( typeof object.layers.test === 'function' ) return object.layers.test( camera.layers );
	return ( ( object.layers.mask ?? 1 ) & ( camera.layers.mask ?? 1 ) ) !== 0;

}

export function getSceneLights( scene, frame = null ) {

	if ( ! scene ) return [];
	const activeLights = activeFrameLights( frame );
	if ( activeLights ) return activeLights;
	const version = scene._tslpLightCacheVersion || 0;
	const camera = frame && frame.camera || null;
	const cameraLayerMask = camera && camera.layers ? camera.layers.mask : null;
	const frameKey = frame && ( frame.renderId ?? frame.frameId ?? null );
	let cache = scene._tslpLightCache;
	if ( ! cache || cache.scene !== scene || cache.version !== version || cache.camera !== camera || cache.cameraLayerMask !== cameraLayerMask || frameKey !== null && cache.frameKey !== frameKey ) {

		cache = { scene, version, camera, cameraLayerMask, frameKey, lights: [] };
		scene._tslpLightCache = cache;
		const traverseScene = typeof scene.traverseVisible === 'function' ? scene.traverseVisible.bind( scene ) : typeof scene.traverse === 'function' ? scene.traverse.bind( scene ) : null;
		if ( traverseScene ) {

			traverseScene( ( o ) => {

				if ( o && o.isLight === true && isVisibleToCamera( o, camera ) ) cache.lights.push( o );

			} );
			cache.lights.sort( ( a, b ) => ( Number.isFinite( a && a.id ) ? a.id : 0 ) - ( Number.isFinite( b && b.id ) ? b.id : 0 ) );

		}

	}
	return cache.lights;

}

export function findLightInScene( scene, index, frame = null ) {

	const lights = getSceneLights( scene, frame );
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

function normalizedLightType( value ) {

	if ( typeof value !== 'string' ) return '';
	return value.toLowerCase().replace( /[\s_-]/g, '' ).replace( /light$/, '' );

}

function liveLightType( light ) {

	if ( ! light ) return '';
	if ( light.isDirectionalLight === true ) return 'directional';
	if ( light.isSpotLight === true ) return 'spot';
	if ( light.isPointLight === true ) return 'point';
	if ( light.isRectAreaLight === true ) return 'rectarea';
	if ( light.isHemisphereLight === true ) return 'hemisphere';
	if ( light.isAmbientLight === true ) return 'ambient';
	return normalizedLightType( light.type || '' );

}

function identityTypeMatches( light, record ) {

	const capturedType = normalizedLightType( record && record.type || '' );
	return capturedType === '' || capturedType === liveLightType( light );

}

function topologyMatches( cachedLights, lights ) {

	if ( ! cachedLights || cachedLights.length !== lights.length ) return false;
	for ( let index = 0; index < lights.length; index ++ ) {

		if ( cachedLights[ index ] !== lights[ index ] ) return false;

	}
	return true;

}

function identityTableKey( table ) {

	if ( ! Array.isArray( table ) ) return table;
	let key = lightIdentityTableKeys.get( table );
	if ( key !== undefined ) return key;
	key = JSON.stringify( table.map( ( record ) => [
		record && record.schema || null,
		record && record.captureUuid || null,
		( record && record.captureIndex ) ?? null,
		record && record.type || null,
		record && record.explicitKey || null,
		record && record.name || null,
		...identitySnapshotFields.map( ( field ) => ( record && record.snapshot && record.snapshot[ field ] ) ?? null ),
	] ) );
	lightIdentityTableKeys.set( table, key );
	return key;

}

function identityTableState( scene, lights, table ) {

	let sceneState = lightIdentitySceneCaches.get( scene );
	if ( ! sceneState || ! topologyMatches( sceneState.lights, lights ) ) {

		sceneState = { lights: lights.slice(), tables: new Map() };
		lightIdentitySceneCaches.set( scene, sceneState );

	}
	const tableKey = identityTableKey( table );
	let tableState = sceneState.tables.get( tableKey );
	if ( ! tableState ) {

		tableState = { mappings: new Map(), claims: new Map() };
		sceneState.tables.set( tableKey, tableState );

	}
	return tableState;

}

function canClaimLight( state, identity, light ) {

	const owner = state.claims.get( light );
	return owner === undefined || owner === identity;

}

function claimLight( state, identity, light ) {

	if ( ! light || ! canClaimLight( state, identity, light ) ) return null;
	const previous = state.mappings.get( identity );
	if ( previous && previous !== light && state.claims.get( previous ) === identity ) state.claims.delete( previous );
	state.mappings.set( identity, light );
	state.claims.set( light, identity );
	return light;

}

function recordCaptureUuid( record, source ) {

	for ( const value of [ record.captureUuid, record.lightUuid, record.uuid, source.lightUuid ] ) {

		if ( typeof value === 'string' && value.length > 0 ) return value;

	}
	return '';

}

function recordCaptureIndex( record, source ) {

	for ( const value of [ record.captureIndex, record.lightIndex, record.index, source.lightIndex ] ) {

		if ( Number.isInteger( value ) && value >= 0 ) return value;

	}
	return 0;

}

function recordExplicitKey( record ) {

	for ( const value of [ record.explicitKey, record.tslPrecompileId ] ) {

		if ( typeof value === 'string' && value.length > 0 ) return value;

	}
	return '';

}

function vectorComponents( value ) {

	if ( value && typeof value === 'object' && Array.isArray( value.data ) ) value = value.data;
	if ( Array.isArray( value ) && value.length >= 3 ) {

		const components = [ Number( value[ 0 ] ), Number( value[ 1 ] ), Number( value[ 2 ] ) ];
		return components.every( Number.isFinite ) ? components : null;

	}
	if ( value && typeof value === 'object' && Number.isFinite( value.x ) && Number.isFinite( value.y ) && Number.isFinite( value.z ) ) return [ value.x, value.y, value.z ];
	return null;

}

function colorComponents( value ) {

	if ( value && typeof value === 'object' && Array.isArray( value.data ) ) value = value.data;
	if ( Array.isArray( value ) && value.length >= 3 ) {

		const components = [ Number( value[ 0 ] ), Number( value[ 1 ] ), Number( value[ 2 ] ) ];
		return components.every( Number.isFinite ) ? components : null;

	}
	if ( value && typeof value === 'object' && Number.isFinite( value.r ) && Number.isFinite( value.g ) && Number.isFinite( value.b ) ) return [ value.r, value.g, value.b ];
	return null;

}

function numericSnapshotValue( value ) {

	if ( value && typeof value === 'object' && value.data !== undefined ) value = value.data;
	return Number.isFinite( value ) ? Number( value ) : null;

}

function worldPositionComponents( object ) {

	if ( ! object ) return null;
	const elements = object.matrixWorld && object.matrixWorld.elements;
	if ( elements && elements.length >= 16 ) return [ elements[ 12 ], elements[ 13 ], elements[ 14 ] ];
	return vectorComponents( object.position );

}

function normalizedVectorError( live, captured ) {

	if ( ! live || ! captured ) return null;
	const dx = live[ 0 ] - captured[ 0 ];
	const dy = live[ 1 ] - captured[ 1 ];
	const dz = live[ 2 ] - captured[ 2 ];
	const scale = 1 + captured[ 0 ] * captured[ 0 ] + captured[ 1 ] * captured[ 1 ] + captured[ 2 ] * captured[ 2 ];
	return ( dx * dx + dy * dy + dz * dz ) / scale;

}

function normalizedNumberError( live, captured ) {

	if ( ! Number.isFinite( live ) || ! Number.isFinite( captured ) ) return null;
	const difference = live - captured;
	return difference * difference / ( 1 + captured * captured );

}

function completeSnapshotScore( light, record ) {

	const snapshot = record && record.snapshot;
	if ( ! snapshot || typeof snapshot !== 'object' ) return null;
	let score = 0;
	let evidence = 0;
	let comparedEvidence = 0;
	const addError = ( error, weight = 1 ) => {

		if ( error === null ) score += weight * 16;
		else {

			score += error * weight;
			comparedEvidence += weight;

		}
		evidence += weight;

	};

	if ( snapshot.position !== undefined ) addError( normalizedVectorError( worldPositionComponents( light ), vectorComponents( snapshot.position ) ), 4 );
	if ( snapshot.targetPosition !== undefined ) addError( normalizedVectorError( worldPositionComponents( light && light.target ), vectorComponents( snapshot.targetPosition ) ), 4 );
	if ( snapshot.color !== undefined ) addError( normalizedVectorError( colorComponents( light && light.color ), colorComponents( snapshot.color ) ), 3 );
	for ( const property of [ 'intensity', 'distance', 'decay', 'angle', 'penumbra', 'width', 'height' ] ) {

		if ( snapshot[ property ] !== undefined ) addError( normalizedNumberError( light && light[ property ], numericSnapshotValue( snapshot[ property ] ) ) );

	}
	if ( snapshot.castShadow !== undefined ) {

		score += ( light && light.castShadow === true ) === ( snapshot.castShadow === true ) ? 0 : 8;
		evidence += 1;
		comparedEvidence += 1;

	}
	if ( snapshot.shadowType !== undefined ) {

		const liveShadowType = normalizedLightType( light && light.shadow && ( light.shadow.type || light.shadow.constructor && light.shadow.constructor.name ) || '' );
		score += liveShadowType === normalizedLightType( String( snapshot.shadowType ) ) ? 0 : 8;
		evidence += 1;
		comparedEvidence += 1;

	}
	if ( snapshot.cameraType !== undefined ) {

		const liveCameraType = normalizedLightType( light && light.shadow && light.shadow.camera && ( light.shadow.camera.type || light.shadow.camera.constructor && light.shadow.camera.constructor.name ) || '' );
		score += liveCameraType === normalizedLightType( String( snapshot.cameraType ) ) ? 0 : 8;
		evidence += 1;
		comparedEvidence += 1;

	}
	return evidence > 0 && comparedEvidence > 0 ? score / evidence : null;

}

function capturedKeyIsUnique( table, record, key, value ) {

	if ( ! Array.isArray( table ) ) return true;
	const type = normalizedLightType( record && record.type || '' );
	let matches = 0;
	for ( const candidate of table ) {

		if ( ! candidate || normalizedLightType( candidate.type || '' ) !== type ) continue;
		const candidateValue = key === 'explicitKey' ? recordExplicitKey( candidate ) : candidate.name;
		if ( candidateValue === value ) matches ++;

	}
	return matches === 1;

}

function resolveSharedLightIdentity( scene, source, link, frame ) {

	const lights = getSceneLights( scene, frame );
	if ( lights.length === 0 ) return null;
	const { record, table } = link;
	const state = identityTableState( scene, lights, table );
	const identity = Number.isInteger( source.lightIdentity ) && source.lightIdentity >= 0
		? `identity:${ source.lightIdentity }`
		: record;
	const captureUuid = recordCaptureUuid( record, source );
	if ( captureUuid ) {

		const exact = lights.find( ( light ) => light && light.uuid === captureUuid && canClaimLight( state, identity, light ) ) || null;
		if ( exact ) return claimLight( state, identity, exact );

	}

	const cached = state.mappings.get( identity );
	if ( cached && lights.includes( cached ) && canClaimLight( state, identity, cached ) ) return claimLight( state, identity, cached );

	const explicitKey = recordExplicitKey( record );
	if ( explicitKey && capturedKeyIsUnique( table, record, 'explicitKey', explicitKey ) ) {

		const explicitMatches = lights.filter( ( light ) => identityTypeMatches( light, record )
			&& light && light.userData && String( light.userData.tslPrecompileId ?? '' ) === explicitKey );
		if ( explicitMatches.length === 1 && canClaimLight( state, identity, explicitMatches[ 0 ] ) ) return claimLight( state, identity, explicitMatches[ 0 ] );

	}

	if ( typeof record.name === 'string' && record.name.length > 0 && capturedKeyIsUnique( table, record, 'name', record.name ) ) {

		const nameMatches = lights.filter( ( light ) => identityTypeMatches( light, record )
			&& light && light.name === record.name );
		if ( nameMatches.length === 1 && canClaimLight( state, identity, nameMatches[ 0 ] ) ) return claimLight( state, identity, nameMatches[ 0 ] );

	}

	let best = null;
	let bestScore = Infinity;
	for ( const light of lights ) {

		if ( ! identityTypeMatches( light, record ) || ! canClaimLight( state, identity, light ) ) continue;
		const score = completeSnapshotScore( light, record );
		if ( score !== null && score < bestScore ) {

			best = light;
			bestScore = score;

		}

	}
	if ( best ) return claimLight( state, identity, best );

	const captureIndex = recordCaptureIndex( record, source );
	const indexed = lights[ captureIndex ] || null;
	const hasCapturedType = normalizedLightType( record && record.type || '' ) !== '';
	if ( indexed && ( ! hasCapturedType || identityTypeMatches( indexed, record ) ) && canClaimLight( state, identity, indexed ) ) return claimLight( state, identity, indexed );
	const remainingTypeMatch = lights.find( ( light ) => identityTypeMatches( light, record ) && canClaimLight( state, identity, light ) ) || null;
	if ( remainingTypeMatch ) return claimLight( state, identity, remainingTypeMatch );
	if ( hasCapturedType ) return null;
	return claimLight( state, identity, lights.find( ( light ) => canClaimLight( state, identity, light ) ) || null );

}

export function findLightBySnapshot( scene, source, frame = null ) {

	const lights = getSceneLights( scene, frame );
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
	const identityLink = linkedLightIdentityForSource( source );
	if ( identityLink ) return resolveSharedLightIdentity( scene, source, identityLink, frame );
	const lights = getSceneLights( scene, frame );
	if ( source.lightUuid ) {

		const found = lights.find( ( light ) => light && light.uuid === source.lightUuid ) || null;
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
	return findLightInScene( scene, lightIndex, frame );

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
	if ( linkedLightIdentityForSource( source ) ) {

		const light = findLightBySource( frame.scene, source, frame );
		if ( light ) return light;

	}

	const slots = Array.isArray( group.slots ) ? group.slots : [];
	const shadowGroups = [];
	const seenLightIdentities = new Set();
	for ( const sibling of slots ) {

		const siblingSource = sibling && sibling.source || {};
		const identityLink = linkedLightIdentityForSource( siblingSource );
		const identityKey = identityLink && identityLink.record || ( siblingSource.lightUuid ? `uuid:${ siblingSource.lightUuid }` : Number.isInteger( siblingSource.lightIndex ) ? `index:${ siblingSource.lightIndex }` : null );
		if ( siblingSource.kind && siblingSource.kind.startsWith( 'light.shadow' ) && identityKey !== null && ! seenLightIdentities.has( identityKey ) ) {

			seenLightIdentities.add( identityKey );
			shadowGroups.push( {
				source: siblingSource,
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

		const light = findLightBySource( frame.scene, shadowGroups[ matrixIndex ].source, frame );
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

		const light = findLightBySource( frame.scene, nextShadowGroup.source, frame );
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
		case 'light.shadowModelMatrix':
			if ( light.shadow && light.shadow.matrix && frame.object && frame.object.matrixWorld ) {

				updateLightShadowMatrixForFrame( light, frame );
				_mwi.multiplyMatrices( light.shadow.matrix, frame.object.matrixWorld );
				writeMat4( view, offset, _mwi );

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
		case 'light.shadowBlurSamples':
			writeNumber( view, offset, light.shadow ? light.shadow.blurSamples : null, source.valueSnapshot );
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
