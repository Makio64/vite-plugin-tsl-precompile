/**
 * AOT updater codegen.
 *
 * Takes a `uniformPlan` (produced by the vendored `extractUniformPlan.js`)
 * and emits a static ES module that writes UBO bytes directly — the
 * performance-critical core of the proposal.
 *
 * Each generated module exports a single function:
 *
 *   export function update(frame, material, view, byteOffset) {
 *     // byteOffset is the UBO's base offset in the staging buffer
 *     writeMat4(view, byteOffset + 0,   frame.camera.projectionMatrix);
 *     writeMat4(view, byteOffset + 64,  frame.camera.viewMatrix);
 *     writeColor(view, byteOffset + 192, material.color);
 *     ...
 *   }
 *
 * Source kinds are mapped from the extractor's dialect (produced by the
 * vendored `extractUniformPlan.js`) to writer calls. The extractor emits
 * e.g. `frame.time`, `constant`, `camera.projectionMatrixInverse`; earlier
 * revisions of this file handled only `time`, `uniform.constant`, etc. The
 * legacy cases are preserved so hand-written synthetic plans (used by the
 * unit tests) still work.
 *
 * Unsupported kinds fall into two tiers:
 *
 *   - `severity: 'unknown'` — the codegen has no case for this kind.
 *     Either the extractor produced something new (vendor drift) or the
 *     author is building a plan by hand. Generated code throws at update()
 *     call time; the build gate fails loudly.
 *   - `severity: 'blocked'` — the kind is recognised but is either handled
 *     outside UBO-slot codegen or deliberately out of scope. Generated code
 *     throws if a hand-written plan places it in group.slots[].
 *
 * @module EmitUpdater
 */

import { BLOCKED_KINDS, blockedKindReason, isBlockedKind } from '@tsl-precompile/contract/kinds';

// Back-compat export for older tests/callers. The canonical registry now lives
// in @tsl-precompile/contract/kinds.
export const DOCUMENTED_BLOCKED_KINDS = BLOCKED_KINDS;

// --- Writer-template tables ---------------------------------------------------
//
// Many `material.*` / `scene.*` / `frame.*` slots emit identical code:
// `writeYYY(view, off, <expr>)` differing only by the writer name and the
// property accessor. The legacy switch had ~50 cases that fit this pattern;
// the tables below let `emitSlotWrite` short-circuit them as a single lookup.
// Cases not in any table fall through to the switch's per-kind logic.

const MATERIAL_COLOR_KINDS = new Set( [
	'material.color',
	'material.emissive',
	'material.specular',
	'material.specularColor',
	'material.sheenColor',
	'material.attenuationColor',
] );

const MATERIAL_SCALAR_KINDS = new Set( [
	'material.scalar',
	'material.opacity',
	'material.alphaTest',
	'material.roughness',
	'material.metalness',
	'material.ior',
	'material.emissiveIntensity',
	'material.aoMapIntensity',
	'material.lightMapIntensity',
	'material.envMapIntensity',
	'material.specularIntensity',
	'material.shininess',
	'material.size',
	'material.rotation',
	'material.clearcoat',
	'material.clearcoatRoughness',
	'material.sheen',
	'material.sheenRoughness',
	'material.transmission',
	'material.thickness',
	'material.attenuationDistance',
	'material.iridescence',
	'material.iridescenceIOR',
	'material.anisotropy',
	'material.anisotropyRotation',
	'material.dispersion',
	'material.reflectivity',
	'material.refractionRatio',
	'material.bumpScale',
	'material.displacementScale',
	'material.displacementBias',
	'material.linewidth',
	'material.scale',
	'material.dashSize',
	'material.gapSize',
	'material.dashOffset',
] );

const MATERIAL_VEC2_KINDS = new Set( [
	'material.normalScale',
	'material.clearcoatNormalScale',
] );

const SCENE_FOG_SCALAR_KINDS = new Set( [
	'scene.fog.near',
	'scene.fog.far',
	'scene.fog.density',
] );

const SCENE_SCALAR_KINDS = new Set( [
	'scene.environmentIntensity',
	'scene.backgroundIntensity',
	'scene.backgroundBlurriness',
] );

// Provably-static snapshot detection: identity mat3 (texture sampler matrix
// for an untransformed texture). The frozen snapshot of an identity matrix
// is the value the live renderer would write each frame anyway, so the
// "won't animate" warning copy is misleading for these slots.
function isStaticSnapshot( snapshot ) {

	if ( ! snapshot || snapshot.type !== 'mat3' || ! Array.isArray( snapshot.data ) || snapshot.data.length !== 9 ) return false;
	const d = snapshot.data;
	return d[ 0 ] === 1 && d[ 1 ] === 0 && d[ 2 ] === 0 &&
		d[ 3 ] === 0 && d[ 4 ] === 1 && d[ 5 ] === 0 &&
		d[ 6 ] === 0 && d[ 7 ] === 0 && d[ 8 ] === 1;

}

/**
 * Try to emit the slot from one of the writer-template tables. Returns
 * `null` if the kind doesn't match any table — the caller's switch handles
 * those. Centralises the "writer + property accessor" pattern so adding a
 * new `material.<scalar>` extractor kind is one Set entry instead of one
 * switch case.
 *
 * @returns {?string} emitted write expression, or null when no table applies.
 */
function emitFromWriterTable( kind, src, off, usedWriters ) {

	if ( MATERIAL_COLOR_KINDS.has( kind ) ) {

		const prop = src.property || kind.split( '.' )[ 1 ];
		usedWriters.add( 'writeColor' );
		return `writeColor(view, ${ off }, material.${ prop });`;

	}
	if ( MATERIAL_SCALAR_KINDS.has( kind ) ) {

		const prop = src.property || kind.split( '.' )[ 1 ];
		usedWriters.add( 'writeF32' );
		return `writeF32(view, ${ off }, material.${ prop });`;

	}
	if ( MATERIAL_VEC2_KINDS.has( kind ) ) {

		const prop = src.property || kind.split( '.' )[ 1 ];
		usedWriters.add( 'writeVec2' );
		return `writeVec2(view, ${ off }, material.${ prop });`;

	}
	if ( SCENE_FOG_SCALAR_KINDS.has( kind ) ) {

		const prop = src.property || kind.split( '.' )[ 2 ];
		usedWriters.add( 'writeF32' );
		return `writeF32(view, ${ off }, frame.scene.fog.${ prop });`;

	}
	if ( SCENE_SCALAR_KINDS.has( kind ) ) {

		const prop = src.property || kind.split( '.' )[ 1 ];
		usedWriters.add( 'writeF32' );
		return `writeF32(view, ${ off }, frame.scene.${ prop });`;

	}
	return null;

}

function object3DTargetExpr( source ) {

	return source && source.target === 'camera'
		? '((material && material.__tslpObject3DTargets && material.__tslpObject3DTargets.camera) || (frame && frame.__tslpObject3DTargets && frame.__tslpObject3DTargets.camera) || null)'
		: 'frame.object';

}

function vec3SnapshotLiteral( snapshot ) {

	const data = snapshot && Array.isArray( snapshot.data ) ? snapshot.data : null;
	if ( ! data || data.length < 3 ) return 'null';
	return `{ x: ${ Number( data[ 0 ] ) || 0 }, y: ${ Number( data[ 1 ] ) || 0 }, z: ${ Number( data[ 2 ] ) || 0 } }`;

}

function numberSnapshotLiteral( snapshot, fallback = 0 ) {

	const value = snapshot ? Number( snapshot.data ) : NaN;
	return Number.isFinite( value ) ? String( value ) : String( fallback );

}

/**
 * Generate the source text of an updater module for a single artifact.
 *
 * @param {Object} artifact - Output of the vendored `extractArtifact()`.
 * @param {Object} [opts]
 * @param {string} [opts.writersImport='@tsl-precompile/runtime/writers'] - Import specifier for the writers module.
 * @return {{ source: string, unsupportedKinds: Array<{ kind: string, severity: 'unknown' | 'blocked', reason: string, byteOffset: number }> }}
 */
export function emitUpdaterSource( artifact, opts = {} ) {

	const writersImport = opts.writersImport || '@tsl-precompile/runtime/writers';
	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];

	const lines = [];
	const usedWriters = new Set();
	const unsupportedKinds = [];
	const constants = [];
	// Tracks which three.js classes need to be imported and scratched for
	// renderer-side uniforms (screen size / viewport / DPR).
	const rendererHelpers = new Set();

	for ( const group of plan ) {

		if ( ! Array.isArray( group.slots ) ) continue;

		const groupName = group.name || '';
		lines.push( `  if ( groupName === null || groupName === undefined || groupName === ${ JSON.stringify( groupName ) } ) {` );
		lines.push( `    // bind group ${ JSON.stringify( groupName ) }` );

		for ( const slot of group.slots ) {

			const writer = emitSlotWrite( slot, usedWriters, constants, unsupportedKinds, rendererHelpers );
			lines.push( '    ' + writer );

		}
		lines.push( '  }' );

	}

	const writerImports = Array.from( usedWriters ).sort();
	const constantDecls = constants.length > 0 ? constants.join( '\n' ) + '\n\n' : '';

	const header = writerImports.length > 0
		? `import { ${ writerImports.join( ', ' ) } } from ${ JSON.stringify( writersImport ) };\n\n`
		: '';

	// Emit scratch Vector2 / Vector4 / Vector3 / Matrix4 module-level constants
	// for renderer-based and object-based uniforms. Allocated once per module so
	// there is no per-frame GC pressure from temporary objects.
	let rendererHelperDecls = '';
	const allHelpers = new Set( [ ...rendererHelpers ] );
	if ( allHelpers.size > 0 ) {

		const threeNames = new Set();
		const decls = [];
		if ( allHelpers.has( 'size' ) ) {

			threeNames.add( 'Vector2' );
			decls.push( 'const _rSize = new Vector2( 1, 1 );' );

		}
		if ( allHelpers.has( 'viewport' ) ) {

			threeNames.add( 'Vector4' );
			decls.push( 'const _rViewport = new Vector4( 0, 0, 1, 1 );' );

		}
		if ( allHelpers.has( 'size' ) || allHelpers.has( 'viewport' ) ) {

			decls.push( 'function _tslpCurrentRenderTarget(renderer) {' );
			decls.push( '  if (!renderer || typeof renderer.getRenderTarget !== "function") return null;' );
			decls.push( '  try { return renderer.getRenderTarget(); } catch (_) { return null; }' );
			decls.push( '}' );

		}
		if ( allHelpers.has( 'size' ) ) {

			decls.push( 'function _tslpRendererScreenSize(frame) {' );
			decls.push( '  const renderer = frame && frame.renderer;' );
			decls.push( '  const renderTarget = _tslpCurrentRenderTarget(renderer);' );
			decls.push( '  if (renderTarget !== null && Number.isFinite(renderTarget.width) && Number.isFinite(renderTarget.height)) _rSize.set(renderTarget.width, renderTarget.height);' );
			decls.push( '  else if (renderer && typeof renderer.getDrawingBufferSize === "function") renderer.getDrawingBufferSize(_rSize);' );
			decls.push( '  return _rSize;' );
			decls.push( '}' );

		}
		if ( allHelpers.has( 'viewport' ) ) {

			decls.push( 'function _tslpRendererViewport(frame) {' );
			decls.push( '  const renderer = frame && frame.renderer;' );
			decls.push( '  const renderTarget = _tslpCurrentRenderTarget(renderer);' );
			decls.push( '  if (renderTarget !== null && renderTarget.viewport) _rViewport.copy(renderTarget.viewport);' );
			decls.push( '  else if (renderer && typeof renderer.getViewport === "function") {' );
			decls.push( '    renderer.getViewport(_rViewport);' );
			decls.push( '    if (typeof renderer.getPixelRatio === "function") _rViewport.multiplyScalar(renderer.getPixelRatio());' );
			decls.push( '  }' );
			decls.push( '  return _rViewport;' );
			decls.push( '}' );

		}
		if ( allHelpers.has( 'worldMatrixInverse' ) ) {

			threeNames.add( 'Matrix4' );
			decls.push( 'const _mwi = new Matrix4();' );

		}
		if ( allHelpers.has( 'viewPosition' ) ) {

			threeNames.add( 'Vector3' );
			decls.push( 'const _ovp = new Vector3();' );

		}
		if ( allHelpers.has( 'direction' ) ) {

			threeNames.add( 'Vector3' );
			decls.push( 'const _odir = new Vector3();' );

		}
		// Light helpers — direct lights need scratch Color (for live
		// `color * intensity` product) and Vector3 (for view-space and
		// target world position writes). Both are reused across slots
		// in the same module so per-frame GC stays flat.
		if ( allHelpers.has( 'lightColor' ) ) {

			threeNames.add( 'Color' );
			decls.push( 'const _lcol = new Color();' );

		}
		if ( allHelpers.has( 'lightVec' ) ) {

			threeNames.add( 'Vector3' );
			decls.push( 'const _lvec = new Vector3();' );

		}
		if ( allHelpers.has( 'm4rot' ) ) {

			threeNames.add( 'Matrix4' );
			decls.push( 'const _m4rot = new Matrix4();' );

		}
		if ( allHelpers.has( 'velocity' ) ) {

			threeNames.add( 'Matrix4' );
			decls.push( 'const _tslpVelocityCameraStates = new WeakMap();' );
			decls.push( 'const _tslpVelocityObjectStates = new WeakMap();' );
			decls.push( 'const _tslpTemporalFrameState = Symbol.for("@tsl-precompile/runtime/temporal-frame@1");' );
			decls.push( 'function _tslpTemporalState(frame) {' );
			decls.push( '  const renderer = frame && frame.renderer;' );
			decls.push( '  return renderer && renderer[_tslpTemporalFrameState] || null;' );
			decls.push( '}' );
			decls.push( 'function _tslpFrameKey(frame) {' );
			decls.push( '  const temporal = _tslpTemporalState(frame);' );
			decls.push( '  if (temporal && temporal.frameId !== undefined && temporal.frameId !== null) return temporal.frameId;' );
			decls.push( '  return frame && Number.isFinite(frame.frameId) ? frame.frameId : frame && Number.isFinite(frame.renderId) ? frame.renderId : 0;' );
			decls.push( '}' );
			decls.push( 'function _tslpFreezeVelocityState(frame) {' );
			decls.push( '  const temporal = _tslpTemporalState(frame);' );
			decls.push( '  if (temporal && temporal.advance === false) return true;' );
			decls.push( '  const root = typeof globalThis !== "undefined" ? globalThis : null;' );
			decls.push( '  return !!(root && root.__tslpSuppressVelocityStateAdvance === true || frame && frame.renderer && frame.renderer.__tslpSuppressVelocityStateAdvance === true);' );
			decls.push( '}' );
			decls.push( 'function _tslpVelocityCamera(frame) {' );
			decls.push( '  const camera = frame && frame.camera;' );
			decls.push( '  if (!camera) return null;' );
			decls.push( '  const key = _tslpFrameKey(frame);' );
			decls.push( '  let state = _tslpVelocityCameraStates.get(camera);' );
			decls.push( '  if (!state) {' );
			decls.push( '    state = { frameId: key, previousProjectionMatrix: new Matrix4().copy(camera.projectionMatrix), previousCameraViewMatrix: new Matrix4().copy(camera.matrixWorldInverse), currentProjectionMatrix: new Matrix4().copy(camera.projectionMatrix), currentCameraViewMatrix: new Matrix4().copy(camera.matrixWorldInverse) };' );
			decls.push( '    _tslpVelocityCameraStates.set(camera, state);' );
			decls.push( '  } else if (state.frameId !== key && !_tslpFreezeVelocityState(frame)) {' );
			decls.push( '    state.frameId = key;' );
			decls.push( '    state.previousProjectionMatrix.copy(state.currentProjectionMatrix);' );
			decls.push( '    state.previousCameraViewMatrix.copy(state.currentCameraViewMatrix);' );
			decls.push( '    state.currentProjectionMatrix.copy(camera.projectionMatrix);' );
			decls.push( '    state.currentCameraViewMatrix.copy(camera.matrixWorldInverse);' );
			decls.push( '  }' );
			decls.push( '  return state;' );
			decls.push( '}' );
			decls.push( 'function _tslpVelocityObject(frame) {' );
			decls.push( '  const object = frame && frame.object;' );
			decls.push( '  if (!object || !object.matrixWorld) return null;' );
			decls.push( '  const key = _tslpFrameKey(frame);' );
			decls.push( '  let state = _tslpVelocityObjectStates.get(object);' );
			decls.push( '  if (!state) {' );
			decls.push( '    state = { frameId: key, previousModelWorldMatrix: new Matrix4().copy(object.matrixWorld), currentModelWorldMatrix: new Matrix4().copy(object.matrixWorld) };' );
			decls.push( '    _tslpVelocityObjectStates.set(object, state);' );
			decls.push( '  } else if (state.frameId !== key && !_tslpFreezeVelocityState(frame)) {' );
			decls.push( '    state.frameId = key;' );
			decls.push( '    state.previousModelWorldMatrix.copy(state.currentModelWorldMatrix);' );
			decls.push( '    state.currentModelWorldMatrix.copy(object.matrixWorld);' );
			decls.push( '  }' );
			decls.push( '  return state;' );
			decls.push( '}' );

		}
		// Per-call light cache — keyed by `frame.scene` and rebuilt when
		// `frame.scene._tslpLightCacheVersion` changes (e.g. lights added/
		// removed). Without caching, every slot write would re-traverse the
		// scene to find the indexed light; with caching, the traversal cost
		// amortises over all light-uniform writes in the same frame.
		if ( allHelpers.has( 'lightLookup' ) ) {

			decls.push( '' );
			decls.push( 'function _tslpFindLight(scene, index) {' );
			decls.push( '  if (!scene) return null;' );
			decls.push( '  let cache = scene._tslpLightCache;' );
			decls.push( '  if (!cache || cache.scene !== scene) {' );
			decls.push( '    cache = { scene, lights: [] };' );
			decls.push( '    scene._tslpLightCache = cache;' );
			decls.push( '    if (typeof scene.traverse === \'function\') {' );
			decls.push( '      scene.traverse((o) => { if (o && o.isLight === true) cache.lights.push(o); });' );
			decls.push( '    }' );
			decls.push( '  }' );
			decls.push( '  return cache.lights[index] || null;' );
			decls.push( '}' );

		}
		rendererHelperDecls = `import { ${ Array.from( threeNames ).join( ', ' ) } } from 'three';\n` + decls.join( '\n' ) + '\n\n';

	}

	const body = [
		header,
		rendererHelperDecls,
		constantDecls,
		`export function update(frame, material, view, byteOffset) {\n`,
		`  updateGroup(frame, material, view, byteOffset, null);\n`,
		`}\n`,
		`\nexport function updateGroup(frame, material, view, byteOffset, groupName) {\n`,
		lines.join( '\n' ),
		`\n}\n`,
		`\nexport const __unsupportedKinds = ${ JSON.stringify( unsupportedKinds ) };\n`,
	].join( '' );

	return { source: body, unsupportedKinds };

}

/**
 * Emit the single line that writes one UBO slot.
 *
 * @param {Object} slot
 * @param {Set<string>} usedWriters - Mutated with writer names encountered.
 * @param {Array<string>} constants - Mutated with any top-of-file const declarations needed.
 * @param {Array<{ kind: string, severity: string, reason: string, byteOffset: number }>} unsupportedKinds - Mutated with kinds we can't emit.
 * @param {Set<string>} [rendererHelpers] - Mutated with scratch vars needed ('size','viewport','worldMatrixInverse','viewPosition','direction').
 * @return {string}
 */
function emitSlotWrite( slot, usedWriters, constants, unsupportedKinds, rendererHelpers = new Set() ) {

	// The extractor emits `offset` (byte-offset, `uniform.offset * 4`). Hand-
	// written synthetic plans (used by the unit tests) emit `byteOffset`.
	// Accept both.
	const byteOffset = ( slot.byteOffset ?? slot.offset ?? 0 ) | 0;
	const src = slot.source || {};
	const kind = src.kind || 'unknown';

	const off = `byteOffset + ${ byteOffset }`;

	// Writer-template tables first — collapse ~50 identical-shape cases
	// (material.* color/scalar/vec2, scene.fog.* scalar, scene.* scalar) into
	// a single lookup. See `emitFromWriterTable` above.
	const tableWrite = emitFromWriterTable( kind, src, off, usedWriters );
	if ( tableWrite !== null ) return tableWrite;

	switch ( kind ) {

		case 'camera.projectionMatrix':
			usedWriters.add( 'writeMat4' );
			return `writeMat4(view, ${ off }, frame.camera.projectionMatrix);`;

		case 'camera.projectionMatrixInverse':
			usedWriters.add( 'writeMat4' );
			return `writeMat4(view, ${ off }, frame.camera.projectionMatrixInverse);`;

		case 'camera.viewMatrix':
			usedWriters.add( 'writeMat4' );
			return `writeMat4(view, ${ off }, frame.camera.matrixWorldInverse);`;

		case 'camera.worldMatrix':
			usedWriters.add( 'writeMat4' );
			return `writeMat4(view, ${ off }, frame.camera.matrixWorld);`;

		case 'camera.position':
			usedWriters.add( 'writeVec3' );
			return `writeVec3(view, ${ off }, frame.camera.position);`;

		case 'camera.near':
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, frame.camera.near);`;

		case 'camera.far':
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, frame.camera.far);`;

		case 'velocity.previousProjectionMatrix':
			rendererHelpers.add( 'velocity' );
			usedWriters.add( 'writeMat4' );
			return `{ const _v = _tslpVelocityCamera(frame); if (_v) writeMat4(view, ${ off }, _v.previousProjectionMatrix); }`;

		case 'velocity.previousCameraViewMatrix':
			rendererHelpers.add( 'velocity' );
			usedWriters.add( 'writeMat4' );
			return `{ const _v = _tslpVelocityCamera(frame); if (_v) writeMat4(view, ${ off }, _v.previousCameraViewMatrix); }`;

		case 'velocity.previousModelWorldMatrix':
			rendererHelpers.add( 'velocity' );
			usedWriters.add( 'writeMat4' );
			return `{ const _v = _tslpVelocityObject(frame); if (_v) writeMat4(view, ${ off }, _v.previousModelWorldMatrix); }`;

		case 'object.worldMatrix':
			usedWriters.add( 'writeMat4' );
			return `writeMat4(view, ${ off }, frame.object.matrixWorld);`;

		case 'object3d.worldMatrix':
			usedWriters.add( 'writeMat4' );
			return `writeMat4(view, ${ off }, ${ object3DTargetExpr( src ) }.matrixWorld);`;

		case 'object.worldMatrixInverse':
			// modelWorldMatrixInverse = matrixWorld.invert() — must compute on the fly.
			rendererHelpers.add( 'worldMatrixInverse' );
			usedWriters.add( 'writeMat4' );
			return `_mwi.copy(frame.object.matrixWorld).invert(); writeMat4(view, ${ off }, _mwi);`;

		case 'object.normalMatrix':
		case 'object3d.normalMatrix':
			usedWriters.add( 'writeMat3' );
			// Recompute the normal matrix from the live world matrix BEFORE
			// writing it. Three.js's renderer keeps `object.normalMatrix` up to
			// date for standard meshes, but several PBR paths read it AFTER it
			// went stale (notably webgpu_materials_envmaps_bpcem lifted from
			// 11.98 → 75.03 dB after this recompute landed). Skip the
			// recompute for meshes whose renderer-path already encodes
			// additional transforms in their matrices: SkinnedMesh
			// (bone-space offsets), InstancedMesh (instanceMatrix), and
			// Points-material draws (billboard alignment) — clobbering those
			// breaks webgpu_skinning_points and friends.
			return `if (frame.object && frame.object.normalMatrix && frame.object.matrixWorld && frame.object.isSkinnedMesh !== true && frame.object.isInstancedMesh !== true && (!frame.object.material || frame.object.material.isPointsNodeMaterial !== true)) frame.object.normalMatrix.getNormalMatrix(frame.object.matrixWorld); writeMat3(view, ${ off }, frame.object && frame.object.normalMatrix);`;

		case 'object.modelViewMatrix':
		case 'object3d.modelViewMatrix':
			usedWriters.add( 'writeMat4' );
			// Same gate as normalMatrix above. The recompute is required for
			// standard meshes (BPCEM, materials with stale matrix arriving
			// at the updater) but the renderer's special-case meshes already
			// have a populated modelViewMatrix that encodes more than
			// `camera.matrixWorldInverse * matrixWorld`.
			return `if (frame.object && frame.object.modelViewMatrix && frame.object.matrixWorld && frame.camera && frame.camera.matrixWorldInverse && frame.object.isSkinnedMesh !== true && frame.object.isInstancedMesh !== true && (!frame.object.material || frame.object.material.isPointsNodeMaterial !== true)) frame.object.modelViewMatrix.multiplyMatrices(frame.camera.matrixWorldInverse, frame.object.matrixWorld); writeMat4(view, ${ off }, frame.object && frame.object.modelViewMatrix);`;

		// Object3DNode — `scope` picks which object metric.
		case 'object3d.position':
			usedWriters.add( 'writeVec3' );
			if ( src.target === 'camera' ) return `{ const _target = ${ object3DTargetExpr( src ) }; writeVec3(view, ${ off }, _target && _target.position ? _target.position : ${ vec3SnapshotLiteral( src.valueSnapshot ) }); }`;
			return `writeVec3(view, ${ off }, ${ object3DTargetExpr( src ) }.position);`;

		case 'object.scale':
			usedWriters.add( 'writeVec3' );
			return `writeVec3(view, ${ off }, frame.object.scale);`;

		case 'object.radius':
			// ModelNode radius uses the rendered object's geometry bounds.
			usedWriters.add( 'writeF32' );
			return `{ const _g = frame.object && frame.object.geometry; if (_g && !_g.boundingSphere && typeof _g.computeBoundingSphere === 'function') _g.computeBoundingSphere(); writeF32(view, ${ off }, _g && _g.boundingSphere ? _g.boundingSphere.radius : ${ numberSnapshotLiteral( src.valueSnapshot, 0 ) }); }`;

		case 'object3d.scale':
			usedWriters.add( 'writeVec3' );
			return `writeVec3(view, ${ off }, ${ object3DTargetExpr( src ) }.scale);`;

		case 'object3d.viewPosition':
			// World position transformed into camera space.
			rendererHelpers.add( 'viewPosition' );
			usedWriters.add( 'writeVec3' );
			return `_ovp.setFromMatrixPosition(${ object3DTargetExpr( src ) }.matrixWorld).applyMatrix4(frame.camera.matrixWorldInverse); writeVec3(view, ${ off }, _ovp);`;

		case 'object3d.direction':
			// World direction of the object (forward vector in world space).
			rendererHelpers.add( 'direction' );
			usedWriters.add( 'writeVec3' );
			return `${ object3DTargetExpr( src ) }.getWorldDirection(_odir); writeVec3(view, ${ off }, _odir);`;

		case 'object3d.radius':
			// Bounding-sphere radius in world space (computed on first access).
			usedWriters.add( 'writeF32' );
			return `{ const _g = frame.object && frame.object.geometry; if (_g && !_g.boundingSphere && typeof _g.computeBoundingSphere === 'function') _g.computeBoundingSphere(); writeF32(view, ${ off }, _g && _g.boundingSphere ? _g.boundingSphere.radius : ${ numberSnapshotLiteral( src.valueSnapshot, 0 ) }); }`;

		case 'object3d.nodeUniform': {

			return emitObjectNodeUniform( slot, off, usedWriters, constants, unsupportedKinds, byteOffset );

		}

		case 'object3d.userData': {

			// UserDataNode — per-draw read of frame.object.userData[property].
			// The property name and uniformType are baked into the source
			// descriptor by extractUniformPlan. Fall back to 0 / snapshot when
			// the object or key is absent so sprites with unset userData keys
			// don't produce NaN in the UBO.
			const udProp = src.property;
			const udType = src.uniformType || 'float';
			const udWriter = inferWriterForValueType( udType );
			if ( ! udProp ) {

				unsupportedKinds.push( {
					kind: 'object3d.userData',
					severity: 'blocked',
					reason: 'object3d.userData slot is missing property name',
					byteOffset,
				} );
				return `/* object3d.userData: missing property name, skipped */`;

			}
			if ( ! udWriter ) {

				unsupportedKinds.push( {
					kind: 'object3d.userData',
					severity: 'unknown',
					reason: `object3d.userData has unknown uniformType "${ udType }"`,
					byteOffset,
				} );
				return `throw new Error("[tsl-precompile] unsupported object3d.userData uniformType: ${ udType }");`;

			}
			usedWriters.add( udWriter );
			return `${ udWriter }(view, ${ off }, frame.object && frame.object.userData != null ? frame.object.userData[${ JSON.stringify( udProp ) }] : undefined);`;

		}

		// Frame-scoped uniforms — the extractor emits `frame.<x>`; earlier
		// hand-written plans used the bare `<x>`. Both paths land here.
		// Wedge 4: honour `globalThis.__tslpPinnedClock` so the AOT updater
		// matches the hydrator runtime path during snapshot replay.
		case 'frame.time':
		case 'time':
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, (typeof globalThis.__tslpPinnedClock === 'number' && Number.isFinite(globalThis.__tslpPinnedClock) ? globalThis.__tslpPinnedClock : frame.time));`;

		// Wave 6 S1: linear-scaled `frame.time` detected by
		// extractUniformPlan.classifyByCallback (`uniform(...).onFrameUpdate(
		// f => f.time * k )`). Scale is constant at extraction time and baked
		// into the writer literal so the slot picks up `__tslpPinnedClock`
		// like vanilla `frame.time` does — fixes time-drift cluster (custom
		// fog scattering, raging-sea derivatives) that previously froze on
		// `uniform.live`.
		case 'frame.time.scaled': {

			usedWriters.add( 'writeF32' );
			const scale = Number.isFinite( src.scale ) ? src.scale : 1;
			return `writeF32(view, ${ off }, (typeof globalThis.__tslpPinnedClock === 'number' && Number.isFinite(globalThis.__tslpPinnedClock) ? globalThis.__tslpPinnedClock : frame.time) * ${ scale });`;

		}

		case 'frame.deltaTime':
		case 'deltaTime':
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, frame.deltaTime);`;

		case 'frame.frameId':
		case 'frameId':
			usedWriters.add( 'writeU32' );
			return `{ const _s = frame && frame.renderer && frame.renderer[Symbol.for("@tsl-precompile/runtime/temporal-frame@1")]; writeU32(view, ${ off }, _s && Number.isFinite(_s.frameId) ? _s.frameId : frame.frameId); }`;

		// Renderer-scoped uniforms — ScreenNode drives these from the live
		// renderer each frame. The slim runtime runs a full WebGPURenderer,
		// so `frame.renderer` is always present at render time.
		//
		// Module-level scratch Vector2 / Vector4 objects are emitted by the
		// caller (emitUpdaterSource) when rendererHelpers contains 'size' or
		// 'viewport'. They are reused across frames to avoid GC pressure.
		case 'renderer.dpr':
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, frame.renderer ? frame.renderer.getPixelRatio() : 1.0);`;

		case 'renderer.size':
			rendererHelpers.add( 'size' );
			usedWriters.add( 'writeVec2' );
			return `writeVec2(view, ${ off }, _tslpRendererScreenSize(frame));`;

		case 'renderer.halfHeight':
			rendererHelpers.add( 'size' );
			usedWriters.add( 'writeF32' );
			return `if (frame.renderer) frame.renderer.getSize(_rSize); writeF32(view, ${ off }, 0.5 * _rSize.y);`;

		case 'renderer.viewport':
			rendererHelpers.add( 'viewport' );
			usedWriters.add( 'writeVec4' );
			return `writeVec4(view, ${ off }, _tslpRendererViewport(frame));`;

		case 'renderer.toneMappingExposure':
			// toneMappingExposure is a bare `uniform()` with onRenderUpdate that reads
			// renderer.toneMappingExposure each frame. Default is 1.0 when no renderer
			// is present (matches three.js's own default for WebGPURenderer.toneMappingExposure).
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, frame.renderer ? frame.renderer.toneMappingExposure : 1.0);`;

		// Scene-scoped uniforms with non-table shapes. The extractor
		// prefixes with `scene.fog.` or `scene.`; the hydrator carries
		// `frame.scene` and `frame.scene.fog` as the live references.
		// `scene.fog.numeric` / `scene.<scalar>` are handled by the
		// writer-template table above.
		case 'scene.fog.color': {

			usedWriters.add( 'writeColor' );
			return `writeColor(view, ${ off }, frame.scene.fog.color);`;

		}

		// scene.backgroundRotation — Matrix4 derived from
		// scene.backgroundRotation (Euler) when scene.background is a
		// texture. Stock three.js mirrors `_m1.makeRotationFromEuler(scene
		// .backgroundRotation).transpose()` once per frame in the TSL
		// uniform's onRenderUpdate. Mirror that here so AOT-emitted
		// updaters keep the rotation in sync without going through the
		// node graph.
		case 'scene.backgroundRotation': {

			usedWriters.add( 'writeMat4FromEuler' );
			return `writeMat4FromEuler(view, ${ off }, frame.scene && frame.scene.backgroundRotation, frame.scene && frame.scene.background);`;

		}

		// Direct light uniforms — three.js's `LightNode` instances build
		// anonymous `uniform()` calls + `update(frame)` closures that copy
		// `light.color * light.intensity`, `light.distance`, etc. into the
		// embedded UniformNodes once per frame. The slim runtime doesn't
		// run those node closures, so without explicit per-frame writes
		// here the captured values stay frozen at extraction time.
		// Each light-kind case looks up `frame.scene.children[...]` (via a
		// per-frame traversal cache) for the Nth light by traversal order.
		// `lightIndex` is baked into the source descriptor at extract time.
		case 'light.colorScaled': {

			rendererHelpers.add( 'lightLookup' );
			rendererHelpers.add( 'lightColor' );
			usedWriters.add( 'writeColor' );
			const idx = src.lightIndex | 0;
			// Live recompute mirrors AnalyticLightNode.update(): copy the
			// light's Color and multiply by the current intensity scalar.
			return `{ const _l = _tslpFindLight(frame.scene, ${ idx }); if (_l) { _lcol.copy(_l.color).multiplyScalar(_l.intensity || 0); writeColor(view, ${ off }, _lcol); } }`;

		}
		case 'light.distance': {

			rendererHelpers.add( 'lightLookup' );
			usedWriters.add( 'writeF32' );
			const idx = src.lightIndex | 0;
			return `{ const _l = _tslpFindLight(frame.scene, ${ idx }); if (_l) writeF32(view, ${ off }, _l.distance || 0); }`;

		}
		case 'light.decay': {

			rendererHelpers.add( 'lightLookup' );
			usedWriters.add( 'writeF32' );
			const idx = src.lightIndex | 0;
			return `{ const _l = _tslpFindLight(frame.scene, ${ idx }); if (_l) writeF32(view, ${ off }, _l.decay != null ? _l.decay : 2); }`;

		}
		case 'light.coneCos': {

			rendererHelpers.add( 'lightLookup' );
			usedWriters.add( 'writeF32' );
			const idx = src.lightIndex | 0;
			return `{ const _l = _tslpFindLight(frame.scene, ${ idx }); if (_l) writeF32(view, ${ off }, Math.cos(_l.angle || 0)); }`;

		}
		case 'light.penumbraCos': {

			rendererHelpers.add( 'lightLookup' );
			usedWriters.add( 'writeF32' );
			const idx = src.lightIndex | 0;
			return `{ const _l = _tslpFindLight(frame.scene, ${ idx }); if (_l) writeF32(view, ${ off }, Math.cos((_l.angle || 0) * (1 - (_l.penumbra || 0)))); }`;

		}
		case 'light.position': {

			rendererHelpers.add( 'lightLookup' );
			rendererHelpers.add( 'lightVec' );
			usedWriters.add( 'writeVec3' );
			const idx = src.lightIndex | 0;
			return `{ const _l = _tslpFindLight(frame.scene, ${ idx }); if (_l) { _lvec.setFromMatrixPosition(_l.matrixWorld); writeVec3(view, ${ off }, _lvec); } }`;

		}
		case 'light.viewPosition': {

			rendererHelpers.add( 'lightLookup' );
			rendererHelpers.add( 'lightVec' );
			usedWriters.add( 'writeVec3' );
			const idx = src.lightIndex | 0;
			// View-space light position — mirrors three.js's Lights.js
			// onRenderUpdate: world position * camera.matrixWorldInverse.
			return `{ const _l = _tslpFindLight(frame.scene, ${ idx }); if (_l && frame.camera) { _lvec.setFromMatrixPosition(_l.matrixWorld); _lvec.applyMatrix4(frame.camera.matrixWorldInverse); writeVec3(view, ${ off }, _lvec); } }`;

		}
		case 'light.targetPosition': {

			rendererHelpers.add( 'lightLookup' );
			rendererHelpers.add( 'lightVec' );
			usedWriters.add( 'writeVec3' );
			const idx = src.lightIndex | 0;
			return `{ const _l = _tslpFindLight(frame.scene, ${ idx }); if (_l && _l.target) { _lvec.setFromMatrixPosition(_l.target.matrixWorld); writeVec3(view, ${ off }, _lvec); } }`;

		}
		case 'light.halfWidth': {

			rendererHelpers.add( 'lightLookup' );
			rendererHelpers.add( 'lightVec' );
			rendererHelpers.add( 'worldMatrixInverse' );
			rendererHelpers.add( 'm4rot' );
			usedWriters.add( 'writeVec3' );
			const halfWidthIdx = src.lightIndex || 0;
			return `{ const _l = _tslpFindLight(frame.scene, ${ halfWidthIdx }); if (_l && frame.camera) { _mwi.copy(_l.matrixWorld).premultiply(frame.camera.matrixWorldInverse); _m4rot.extractRotation(_mwi); _lvec.set(_l.width * 0.5, 0, 0).applyMatrix4(_m4rot); writeVec3(view, ${ off }, _lvec); } }`;

		}
		case 'light.halfHeight': {

			rendererHelpers.add( 'lightLookup' );
			rendererHelpers.add( 'lightVec' );
			rendererHelpers.add( 'worldMatrixInverse' );
			rendererHelpers.add( 'm4rot' );
			usedWriters.add( 'writeVec3' );
			const halfHeightIdx = src.lightIndex || 0;
			return `{ const _l = _tslpFindLight(frame.scene, ${ halfHeightIdx }); if (_l && frame.camera) { _mwi.copy(_l.matrixWorld).premultiply(frame.camera.matrixWorldInverse); _m4rot.extractRotation(_mwi); _lvec.set(0, _l.height * 0.5, 0).applyMatrix4(_m4rot); writeVec3(view, ${ off }, _lvec); } }`;

		}

		// LightShadow uniforms — `ShadowNode.setupShadow()` builds anonymous
		// `reference('bias' | 'normalBias' | 'radius' | 'intensity' |
		// 'blurSamples' | 'mapSize' | 'matrix', …, light.shadow)` calls. Without these
		// per-frame writes the slim runtime would freeze each shadow tweakable
		// at extraction-time — animated `light.shadow.bias` ramps never propagate.
		// The extractor seeds `lightIndex` so we walk the same scene cache used
		// for `light.colorScaled` / `light.position` etc.
		case 'light.shadowMatrix': {

			rendererHelpers.add( 'lightLookup' );
			usedWriters.add( 'writeMat4' );
			const idxShadowM = src.lightIndex | 0;
			// For non-point lights: refresh `shadow.matrix` via `updateMatrices`
			// every frame. Slim replay can have a populated shadow map while the
			// matrix is still stale (e.g. postprocessing pass artifacts compiled
			// before the renderer's shadow pass). For point lights: do NOT override
			// `shadow.matrix` — the renderer's shadow pass already sets it to
			// the correct per-face transform and an unconditional translation
			// override produces a near-identity matrix that breaks
			// `webgpu_shadowmap_pointlight.html`.
			return `{ const _l = _tslpFindLight(frame.scene, ${ idxShadowM }); if (_l && _l.shadow && _l.shadow.matrix) { if (typeof _l.shadow.updateMatrices === 'function' && _l.isPointLight !== true && _l.shadow.isPointLightShadow !== true) { _l.shadow.updateMatrices(_l); } writeMat4(view, ${ off }, _l.shadow.matrix); } }`;

		}
		case 'light.shadowBias':
		case 'light.shadowNormalBias':
		case 'light.shadowRadius':
		case 'light.shadowIntensity':
		case 'light.shadowBlurSamples': {

			rendererHelpers.add( 'lightLookup' );
			usedWriters.add( 'writeF32' );
			const idxShadowF = src.lightIndex | 0;
			const propShadowF = src.property || kind.replace( 'light.shadow', '' ).replace( /^./, ( c ) => c.toLowerCase() );
			// Default values mirror three.js's LightShadow constructor:
			//   bias=0, normalBias=0, radius=1, intensity=1, blurSamples=8.
			let defaultLit = '0';
			if ( kind === 'light.shadowRadius' || kind === 'light.shadowIntensity' ) defaultLit = '1';
			else if ( kind === 'light.shadowBlurSamples' ) defaultLit = '8';
			return `{ const _l = _tslpFindLight(frame.scene, ${ idxShadowF }); if (_l && _l.shadow) writeF32(view, ${ off }, Number.isFinite(_l.shadow.${ propShadowF }) ? _l.shadow.${ propShadowF } : ${ defaultLit }); }`;

		}
		case 'light.shadowCameraNear':
		case 'light.shadowCameraFar': {

			rendererHelpers.add( 'lightLookup' );
			usedWriters.add( 'writeF32' );
			const idxShadowCamera = src.lightIndex | 0;
			const propShadowCamera = kind === 'light.shadowCameraNear' ? 'near' : 'far';
			return `{ const _l = _tslpFindLight(frame.scene, ${ idxShadowCamera }); if (_l && _l.shadow && _l.shadow.camera) writeF32(view, ${ off }, Number.isFinite(_l.shadow.camera.${ propShadowCamera }) ? _l.shadow.camera.${ propShadowCamera } : 0); }`;

		}
		case 'light.shadowMapSize': {

			rendererHelpers.add( 'lightLookup' );
			usedWriters.add( 'writeVec2' );
			const idxShadowV = src.lightIndex | 0;
			return `{ const _l = _tslpFindLight(frame.scene, ${ idxShadowV }); if (_l && _l.shadow && _l.shadow.mapSize) writeVec2(view, ${ off }, _l.shadow.mapSize); }`;

		}

		// Static snapshot baked at extraction time.
		case 'uniform.constant':
		case 'constant': {

			return emitConstant( slot, off, usedWriters, constants, unsupportedKinds, byteOffset );

		}

		case 'uniform.live': {

			return emitLive( slot, off, usedWriters, constants, unsupportedKinds, byteOffset );

		}

		default:
			if ( kind.startsWith( 'material.' ) && kind.endsWith( '.matrix' ) ) {

				const prop = src.property || kind.split( '.' )[ 1 ];
				usedWriters.add( 'writeMat3' );
				// Mirror three.js's TextureNode.update(): refresh texture.matrix from
				// the live repeat/offset/rotation/center before reading it. Without this
				// the matrix stays at the identity assigned in the Texture constructor.
				return `(material.${ prop } && material.${ prop }.matrixAutoUpdate && material.${ prop }.updateMatrix()); writeMat3(view, ${ off }, material.${ prop } && material.${ prop }.matrix);`;

			}
			if ( kind.startsWith( 'material.' ) ) {

				const prop = src.property || kind.slice( 'material.'.length );
				const writer = inferWriterForValueType( src.valueType || src.uniformType || slot.dtype || src.valueSnapshot && src.valueSnapshot.type );
				if ( writer ) {

					usedWriters.add( writer );
					return `${ writer }(view, ${ off }, material[${ JSON.stringify( prop ) }]);`;

				}

			}
			return emitUnknownOrBlocked( kind, off, unsupportedKinds, byteOffset );

	}

}

/**
 * Inline a compile-time-snapshotted value as a literal. Handles both the
 * legacy `{valueType, value}` shape (hand-written plans) AND the extractor's
 * `{valueSnapshot: {type, data}}` shape.
 */
function emitConstant( slot, off, usedWriters, constants, unsupportedKinds, byteOffset ) {

	const src = slot.source;
	// Normalize: legacy → { valueType, value }; extractor → { valueSnapshot: { type, data } }
	const snap = src.valueSnapshot;
	const valueType = src.valueType || src.uniformType || slot.dtype || ( snap && snap.type ) || null;
	const value = src.value !== undefined ? src.value : ( snap && snap.data );

	if ( valueType === null || value === undefined ) {

		unsupportedKinds.push( {
			kind: src.kind || 'uniform.constant',
			severity: 'unknown',
			reason: 'constant slot has neither valueType/value nor valueSnapshot',
			byteOffset,
		} );
		return `throw new Error("[tsl-precompile] constant slot is missing value snapshot");`;

	}

	const idx = constants.length;
	const varName = `__const${ idx }`;

	switch ( valueType ) {

		case 'f32':
		case 'float':
		case 'number':
			constants.push( `const ${ varName } = ${ Number( value ) };` );
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, ${ varName });`;

		case 'i32':
		case 'int':
			constants.push( `const ${ varName } = ${ Number( value ) | 0 };` );
			usedWriters.add( 'writeI32' );
			return `writeI32(view, ${ off }, ${ varName });`;

		case 'u32':
		case 'uint':
			constants.push( `const ${ varName } = ${ ( Number( value ) | 0 ) >>> 0 };` );
			usedWriters.add( 'writeU32' );
			return `writeU32(view, ${ off }, ${ varName });`;

		case 'vec2':
			constants.push( `const ${ varName } = { x: ${ value[ 0 ] }, y: ${ value[ 1 ] } };` );
			usedWriters.add( 'writeVec2' );
			return `writeVec2(view, ${ off }, ${ varName });`;

		case 'vec3':
			constants.push( `const ${ varName } = { x: ${ value[ 0 ] }, y: ${ value[ 1 ] }, z: ${ value[ 2 ] } };` );
			usedWriters.add( 'writeVec3' );
			return `writeVec3(view, ${ off }, ${ varName });`;

		case 'vec4':
			constants.push( `const ${ varName } = { x: ${ value[ 0 ] }, y: ${ value[ 1 ] }, z: ${ value[ 2 ] }, w: ${ value[ 3 ] } };` );
			usedWriters.add( 'writeVec4' );
			return `writeVec4(view, ${ off }, ${ varName });`;

		case 'color':
			constants.push( `const ${ varName } = { r: ${ value[ 0 ] }, g: ${ value[ 1 ] }, b: ${ value[ 2 ] } };` );
			usedWriters.add( 'writeColor' );
			return `writeColor(view, ${ off }, ${ varName });`;

		case 'mat3':
			constants.push( `const ${ varName } = { elements: ${ JSON.stringify( Array.from( value ) ) } };` );
			usedWriters.add( 'writeMat3' );
			return `writeMat3(view, ${ off }, ${ varName });`;

		case 'mat4':
			constants.push( `const ${ varName } = { elements: ${ JSON.stringify( Array.from( value ) ) } };` );
			usedWriters.add( 'writeMat4' );
			return `writeMat4(view, ${ off }, ${ varName });`;

		default:
			unsupportedKinds.push( {
				kind: src.kind || 'uniform.constant',
				severity: 'unknown',
				reason: `uniform.constant has unknown valueType "${ valueType }"`,
				byteOffset,
			} );
			return `throw new Error("[tsl-precompile] unsupported uniform.constant valueType: ${ valueType }");`;

	}

}

/**
 * Live uniform. Two shapes exist:
 *   1. Legacy hand-written: `{ kind: 'uniform.live', property, valueType }`
 *      → reads `material.<property>` live each frame.
 *   2. Extractor-produced: `{ kind: 'uniform.live', name, valueSnapshot }`
 *      → no runtime source mapped (the live-node registry is deferred);
 *      emit the snapshot as a constant fallback and flag as blocked with
 *      a clear reason so the build warns but doesn't fail.
 */
function emitLive( slot, off, usedWriters, constants, unsupportedKinds, byteOffset ) {

	const src = slot.source;

	// Path 1: hand-written / material-property reference
	if ( src.property ) {

		const writer = inferWriterForValueType( src.valueType );
		if ( ! writer ) {

			unsupportedKinds.push( {
				kind: 'uniform.live',
				severity: 'unknown',
				reason: `uniform.live with property="${ src.property }" has unknown valueType "${ src.valueType }"`,
				byteOffset,
			} );
			return `throw new Error("[tsl-precompile] unsupported uniform.live valueType ${ src.valueType }");`;

		}
		usedWriters.add( writer );
		return `${ writer }(view, ${ off }, material.${ src.property });`;

	}

	// Path 2: extractor-produced, snapshot-only fallback. The extractor
	// could not statically resolve the `onRenderUpdate` closure body (no
	// LightNode / ShadowNode / SceneProperties / MaterialReferenceNode
	// match in `extractUniformPlan.classifyByIdentity` or
	// `collectShadowUniformSources`). The slot freezes to whatever the
	// closure wrote at extract time — animated values WILL diverge from
	// capture. Surface this clearly so users know to lift the value into
	// a property the plugin can mirror (material / scene / light / shadow).
	if ( src.valueSnapshot ) {

		unsupportedKinds.push( {
			kind: 'uniform.live',
			severity: 'blocked',
			reason: `uniform.live "${ src.name || '<unnamed>' }" has no property binding (statically-unresolvable onRenderUpdate / onObjectUpdate closure). Using frozen extract-time snapshot — animation will NOT propagate. Lift the driving value onto material / scene / light / light.shadow so the extractor can mirror it.`,
			byteOffset,
			isStaticSnapshot: isStaticSnapshot( src.valueSnapshot ),
		} );
		return emitConstant(
			{ ...slot, source: { kind: 'constant', valueSnapshot: src.valueSnapshot } },
			off,
			usedWriters,
			constants,
			unsupportedKinds,
			byteOffset,
		);

	}

	// Last resort: no property to read live and no captured snapshot.
	// Downgrade to `blocked` rather than `unknown` so capture doesn't
	// throw — static rendering with zero-initialised UBO bytes still
	// produces valid output for many cases (e.g. sprite.userData.rotation
	// where the user defaults the value to 0). Animation paths that
	// depend on these uniforms WILL be wrong, but the artifact is at
	// least usable for the common static case.
	unsupportedKinds.push( {
		kind: 'uniform.live',
		severity: 'blocked',
		reason: `uniform.live "${ src.name || '<unnamed>' }" has no property and no snapshot (unresolvable onRenderUpdate closure). Freezing to zero — animation will NOT propagate.`,
		byteOffset,
	} );
	// Emit a no-op (the buffer was already zero-initialised; nothing to write).
	return `/* uniform.live "${ src.name || '<unnamed>' }" frozen to 0 (no property, no snapshot) */`;

}

function emitObjectNodeUniform( slot, off, usedWriters, constants, unsupportedKinds, byteOffset ) {

	const src = slot.source || {};
	const prop = src.property;
	const declaredValueType = src.valueType || src.uniformType || slot.dtype || src.valueSnapshot && src.valueSnapshot.type;
	let writer = inferWriterForValueType( declaredValueType );
	let resolvedValueType = declaredValueType;

	// Fallback: extractor produced an opaque valueType (null / "undefined")
	// because the snapshot was captured before the property was assigned —
	// e.g., SkyMesh's `showSunDisc` defaults are set lazily. Sniff the actual
	// runtime data shape so booleans and numbers don't crash capture, and
	// promote the resolved type so the constant fallback uses the same writer.
	if ( ! writer && src.valueSnapshot ) {

		writer = inferWriterFromSnapshotData( src.valueSnapshot.data );
		if ( writer ) resolvedValueType = valueTypeForWriter( writer );

	}

	if ( ! prop ) {

		unsupportedKinds.push( {
			kind: 'object3d.nodeUniform',
			severity: 'blocked',
			reason: 'object3d.nodeUniform slot is missing property name',
			byteOffset,
		} );
		return `/* object3d.nodeUniform: missing property name, skipped */`;

	}
	if ( ! writer ) {

		// Mirror the `uniform.live` Last-resort: downgrade to `blocked` rather
		// than throwing so capture survives. Zero-initialised UBO bytes still
		// render correctly for the common case where the property defaults to
		// 0 / false; animation paths that depend on this property WILL be
		// wrong. Add a writer case (or annotate the snapshot type) to recover
		// animation.
		unsupportedKinds.push( {
			kind: 'object3d.nodeUniform',
			severity: 'blocked',
			reason: `object3d.nodeUniform "${ prop }" has unknown valueType "${ declaredValueType }" — freezing to zero (animation will NOT propagate). Lift the value into a known scope or set a typed valueSnapshot to recover.`,
			byteOffset,
		} );
		return `/* object3d.nodeUniform "${ prop }" frozen to 0 (unknown valueType "${ declaredValueType }") */`;

	}

	usedWriters.add( writer );
	const nodeExpr = `frame.object && frame.object[${ JSON.stringify( prop ) }]`;
	const liveWrite = `{ const _value = _node && _node.value !== undefined ? _node.value : _node; ${ writer }(view, ${ off }, _value); }`;
	let fallbackWrite = `/* object3d.nodeUniform "${ prop }" missing; no snapshot */`;
	if ( src.valueSnapshot && src.valueSnapshot.data !== undefined ) {

		// Re-stamp the snapshot with the resolved type so emitConstant routes
		// to the matching writer even when the extractor labelled the type as
		// "undefined".
		const resolvedSnapshot = resolvedValueType !== declaredValueType
			? { type: resolvedValueType, data: src.valueSnapshot.data }
			: src.valueSnapshot;
		fallbackWrite = emitConstant(
			{ ...slot, source: { kind: 'constant', valueSnapshot: resolvedSnapshot } },
			off,
			usedWriters,
			constants,
			unsupportedKinds,
			byteOffset,
		);

	}
	return `{ const _node = ${ nodeExpr }; if (_node !== undefined && _node !== null) ${ liveWrite } else ${ fallbackWrite } }`;

}

function emitUnknownOrBlocked( kind, off, unsupportedKinds, byteOffset ) {

	if ( isBlockedKind( kind ) ) {

		const reason = blockedKindReason( kind );

		unsupportedKinds.push( {
			kind,
			severity: 'blocked',
			reason,
			byteOffset,
		} );
		return `throw new Error(${ JSON.stringify( `[tsl-precompile] blocked kind ${ kind } at byteOffset ${ byteOffset }: ${ reason }` ) });`;

	}

	// Unknown object3d.* scopes — treat as blocked (we know about Object3DNode,
	// just haven't mapped this scope yet) with a clearer reason.
	if ( kind.startsWith( 'object3d.' ) ) {

		unsupportedKinds.push( {
			kind,
			severity: 'blocked',
			reason: `Object3DNode scope "${ kind.slice( 'object3d.'.length ) }" is not mapped yet (add a case in emit-updater.js).`,
			byteOffset,
		} );
		return `throw new Error(${ JSON.stringify( `[tsl-precompile] unmapped object3d scope ${ kind }` ) });`;

	}

	unsupportedKinds.push( {
		kind,
		severity: 'unknown',
		reason: 'no codegen case for this kind (extractor drift or unrecognised dialect)',
		byteOffset,
	} );
	return `throw new Error(${ JSON.stringify( `[tsl-precompile] unsupported source.kind: ${ kind }` ) });`;

}

function inferWriterForValueType( valueType ) {

	switch ( valueType ) {

		case 'f32': case 'float': case 'number': return 'writeF32';
		case 'i32': case 'int': return 'writeI32';
		case 'u32': case 'uint': return 'writeU32';
		case 'bool': case 'boolean': return 'writeF32';
		case 'vec2': return 'writeVec2';
		case 'vec3': return 'writeVec3';
		case 'vec4': return 'writeVec4';
		case 'color': return 'writeColor';
		case 'mat3': return 'writeMat3';
		case 'mat4': return 'writeMat4';
		default: return null;

	}

}

function inferWriterFromSnapshotData( data ) {

	if ( typeof data === 'number' || typeof data === 'boolean' ) return 'writeF32';
	if ( Array.isArray( data ) ) {

		if ( data.length === 2 ) return 'writeVec2';
		if ( data.length === 3 ) return 'writeVec3';
		if ( data.length === 4 ) return 'writeVec4';

	}
	return null;

}

function valueTypeForWriter( writer ) {

	switch ( writer ) {

		case 'writeF32': return 'f32';
		case 'writeI32': return 'i32';
		case 'writeU32': return 'u32';
		case 'writeVec2': return 'vec2';
		case 'writeVec3': return 'vec3';
		case 'writeVec4': return 'vec4';
		case 'writeColor': return 'color';
		case 'writeMat3': return 'mat3';
		case 'writeMat4': return 'mat4';
		default: return null;

	}

}
