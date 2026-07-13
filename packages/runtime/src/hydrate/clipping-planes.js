/**
 * Clipping-plane resolution for precompiled materials.
 *
 * Walks `frame.object`'s ancestry for `ClippingGroup` nodes, projects their
 * planes into camera space, and packs them into the per-binding Float32Array
 * the `Clipping_*` UBO slots expect. Behavior matches three.js's
 * `WebGPUClippingContext` for the subset of cases the precompile path
 * supports — runtime ClippingGroup ancestry is honoured; per-material
 * `clipShadows` discard is handled at extract time and baked into the
 * generated WGSL.
 *
 * Pure functions; no module-level mutation. Two scratch instances
 * (`Plane`/`Matrix3`) are reused per frame to avoid GC pressure during
 * hot-path invocation.
 *
 * @module Hydrate.ClippingPlanes
 */

import { Matrix3 } from 'three/src/math/Matrix3.js';
import { Plane } from 'three/src/math/Plane.js';

const _clipPlane = new Plane();
const _clipNormalMatrix = new Matrix3();

/**
 * Walk the object's parent chain for active `ClippingGroup` nodes (root-most
 * first). Honours `enabled` flags and the shadow-pass `clipShadows` opt-in.
 *
 * @param {Object} object - Three.js Object3D (or null/undefined → no groups).
 * @param {boolean} [shadowPass=false] - When true, only include groups with `clipShadows === true`.
 * @returns {Array<Object>} ClippingGroup ancestors, root-first.
 */
export function collectClippingGroupsForObject( object, shadowPass = false ) {

	const groups = [];
	let cursor = object && object.parent || null;
	while ( cursor ) {

		if ( cursor.isClippingGroup === true && cursor.enabled !== false && ( ! shadowPass || cursor.clipShadows === true ) ) groups.unshift( cursor );
		cursor = cursor.parent || null;

	}
	return groups;

}

/**
 * Project an array of world-space `Plane` instances into camera space and
 * pack them into a tight Float32Array of `[ -nx, -ny, -nz, constant, … ]`
 * tuples (the layout WGSL `Clipping_*` slots expect).
 *
 * @param {Array<Plane>} planes
 * @param {Object} camera - Three.js Camera (must have `matrixWorldInverse`).
 * @returns {Float32Array}
 */
export function projectClippingPlanes( planes, camera ) {

	const count = Array.isArray( planes ) ? planes.length : 0;
	const out = new Float32Array( count * 4 );
	if ( count === 0 || ! camera || ! camera.matrixWorldInverse ) return out;
	_clipNormalMatrix.getNormalMatrix( camera.matrixWorldInverse );
	for ( let i = 0; i < count; i ++ ) {

		const plane = planes[ i ];
		if ( ! plane || ! plane.normal ) continue;
		_clipPlane.copy( plane ).applyMatrix4( camera.matrixWorldInverse, _clipNormalMatrix );
		const normal = _clipPlane.normal;
		const offset = i * 4;
		out[ offset + 0 ] = - normal.x;
		out[ offset + 1 ] = - normal.y;
		out[ offset + 2 ] = - normal.z;
		out[ offset + 3 ] = _clipPlane.constant;

	}
	return out;

}

/**
 * For the current `frame`, resolve the active union/intersection clipping-plane
 * arrays in camera space. Returns `null` when there are no clipping ancestors —
 * caller should leave the corresponding UBO slots zero-initialised.
 *
 * @param {Object} frame - The per-render frame state.
 * @param {Object} material - Active material (used for `__tslpPrecompileObject` fallback).
 * @returns {?{ union: Float32Array, intersection: Float32Array }}
 */
export function clippingPlaneSetsForFrame( frame, material ) {

	const object = frame && frame.object || material && material.__tslpPrecompileObject || null;
	const camera = frame && frame.camera || null;
	if ( ! object || ! camera ) return null;
	const groups = collectClippingGroupsForObject( object, frame && frame.scene && frame.scene.overrideMaterial && frame.scene.overrideMaterial.isShadowPassMaterial === true );
	if ( groups.length === 0 ) return null;
	const unionPlanes = [];
	const intersectionPlanes = [];
	for ( const group of groups ) {

		const planes = Array.isArray( group.clippingPlanes ) ? group.clippingPlanes : [];
		if ( planes.length === 0 ) continue;
		if ( group.clipIntersection === true ) intersectionPlanes.push( ...planes );
		else unionPlanes.push( ...planes );

	}
	return {
		union: projectClippingPlanes( unionPlanes, camera ),
		intersection: projectClippingPlanes( intersectionPlanes, camera ),
	};

}

/**
 * Pick which packed plane array (union vs intersection) matches a clipping
 * UBO entry's expected count + visibility scope. Returns `null` if neither
 * fits — caller leaves the UBO zero-initialised.
 *
 * @param {{ byteLength: number, visibility: number }} entry
 * @param {{ union: Float32Array, intersection: Float32Array }} sets
 * @returns {?Float32Array}
 */
export function selectClippingPlaneArray( entry, sets ) {

	if ( ! entry || ! sets ) return null;
	const count = Math.max( 0, ( entry.byteLength / 16 ) | 0 );
	if ( count === 0 ) return null;
	const unionCount = sets.union.length / 4;
	const intersectionCount = sets.intersection.length / 4;
	const vertexOnly = ( entry.visibility & 1 ) !== 0 && ( entry.visibility & 2 ) === 0;
	const fragmentOnly = ( entry.visibility & 2 ) !== 0 && ( entry.visibility & 1 ) === 0;
	if ( vertexOnly && unionCount === count ) return sets.union;
	if ( fragmentOnly && intersectionCount === count ) return sets.intersection;
	if ( unionCount === count && intersectionCount !== count ) return sets.union;
	if ( intersectionCount === count && unionCount !== count ) return sets.intersection;
	if ( fragmentOnly && unionCount === count ) return sets.union;
	if ( vertexOnly && intersectionCount === count ) return sets.intersection;
	return null;

}
