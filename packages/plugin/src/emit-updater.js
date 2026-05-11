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

/**
 * Kinds the codegen deliberately does not implement as UBO slot writes. These
 * surface as `severity: 'blocked'` in the returned unsupportedKinds array with
 * a human-readable reason.
 */
export const DOCUMENTED_BLOCKED_KINDS = Object.freeze( {
	// Texture-binding kinds — these appear in group.textures[], not group.slots[],
	// so the UBO-slot updater never processes them. The hydrator handles them via
	// its texture-binding resolution path. Listed here so the drift gate doesn't
	// flag them as "unknown" if they ever surface in a synthetic hand-written plan.
	'builtin.dfgLUT': 'IBL DFG LUT — resolved by the hydrator (getDFGLUT()). Not a UBO slot kind.',
	'artifact.texture': 'Artifact-level texture — resolved by the hydrator via _textureRefs / material UUID scan. Not a UBO slot kind.',
	'depth.texture': 'Shadow depth texture (light.shadow.map.depthTexture) — resolved by the hydrator per-frame via the lightIndex baked into the source. Not a UBO slot kind.',
	'viewport.texture': 'Viewport-mip framebuffer texture (KHR_materials_transmission glass) — resolved by the hydrator via createViewportTextureRebinder, which drives a real ViewportTextureNode per render. Not a UBO slot kind.',
	'reflector.texture': 'Reflector render-target texture — resolved by the hydrator via createReflectorTextureRebinder, which binds the live ReflectorBaseNode render target per render. Not a UBO slot kind.',
	'unsupported': 'Extractor flagged this texture binding as unsupported (no source identified). The hydrator substitutes a 1×1 white fallback. Not a UBO slot kind.',
	'scene.overrideMaterial': 'scene.overrideMaterial context is out of scope for v1.',
} );

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

		case 'object.worldMatrix':
		case 'object3d.worldMatrix':
			usedWriters.add( 'writeMat4' );
			return `writeMat4(view, ${ off }, frame.object.matrixWorld);`;

		case 'object.worldMatrixInverse':
			// modelWorldMatrixInverse = matrixWorld.invert() — must compute on the fly.
			rendererHelpers.add( 'worldMatrixInverse' );
			usedWriters.add( 'writeMat4' );
			return `_mwi.copy(frame.object.matrixWorld).invert(); writeMat4(view, ${ off }, _mwi);`;

		case 'object.normalMatrix':
		case 'object3d.normalMatrix':
			usedWriters.add( 'writeMat3' );
			return `writeMat3(view, ${ off }, frame.object.normalMatrix);`;

		case 'object.modelViewMatrix':
		case 'object3d.modelViewMatrix':
			usedWriters.add( 'writeMat4' );
			return `writeMat4(view, ${ off }, frame.object.modelViewMatrix);`;

		// Object3DNode — `scope` picks which object metric.
		case 'object3d.position':
			usedWriters.add( 'writeVec3' );
			return `writeVec3(view, ${ off }, frame.object.position);`;

		case 'object3d.scale':
		case 'object.scale':
			usedWriters.add( 'writeVec3' );
			return `writeVec3(view, ${ off }, frame.object.scale);`;

		case 'object3d.viewPosition':
			// World position transformed into camera space.
			rendererHelpers.add( 'viewPosition' );
			usedWriters.add( 'writeVec3' );
			return `_ovp.setFromMatrixPosition(frame.object.matrixWorld).applyMatrix4(frame.camera.matrixWorldInverse); writeVec3(view, ${ off }, _ovp);`;

		case 'object3d.direction':
			// World direction of the object (forward vector in world space).
			rendererHelpers.add( 'direction' );
			usedWriters.add( 'writeVec3' );
			return `frame.object.getWorldDirection(_odir); writeVec3(view, ${ off }, _odir);`;

		case 'object3d.radius':
			// Bounding-sphere radius in world space (computed on first access).
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, frame.object.geometry && frame.object.geometry.boundingSphere ? frame.object.geometry.boundingSphere.radius : 0);`;

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
		case 'frame.time':
		case 'time':
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, frame.time);`;

		case 'frame.deltaTime':
		case 'deltaTime':
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, frame.deltaTime);`;

		case 'frame.frameId':
		case 'frameId':
			usedWriters.add( 'writeU32' );
			return `writeU32(view, ${ off }, frame.frameId);`;

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
			return `if (frame.renderer) frame.renderer.getDrawingBufferSize(_rSize); writeVec2(view, ${ off }, _rSize);`;

		case 'renderer.halfHeight':
			rendererHelpers.add( 'size' );
			usedWriters.add( 'writeF32' );
			return `if (frame.renderer) frame.renderer.getSize(_rSize); writeF32(view, ${ off }, 0.5 * _rSize.y);`;

		case 'renderer.viewport':
			rendererHelpers.add( 'viewport' );
			usedWriters.add( 'writeVec4' );
			return `if (frame.renderer) frame.renderer.getViewport(_rViewport); writeVec4(view, ${ off }, _rViewport);`;

		case 'renderer.toneMappingExposure':
			// toneMappingExposure is a bare `uniform()` with onRenderUpdate that reads
			// renderer.toneMappingExposure each frame. Default is 1.0 when no renderer
			// is present (matches three.js's own default for WebGPURenderer.toneMappingExposure).
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, frame.renderer ? frame.renderer.toneMappingExposure : 1.0);`;

		case 'material.color':
		case 'material.emissive':
		case 'material.specular':
		case 'material.specularColor':
		case 'material.sheenColor':
		case 'material.attenuationColor': {

			const prop = src.property || kind.split( '.' )[ 1 ];
			usedWriters.add( 'writeColor' );
			return `writeColor(view, ${ off }, material.${ prop });`;

		}

		case 'material.scalar':
		case 'material.opacity':
		case 'material.alphaTest':
		case 'material.roughness':
		case 'material.metalness':
		case 'material.ior':
		case 'material.emissiveIntensity':
		case 'material.aoMapIntensity':
		case 'material.lightMapIntensity':
		case 'material.envMapIntensity':
		case 'material.specularIntensity':
		case 'material.shininess':
		case 'material.size':
		case 'material.rotation':
		case 'material.clearcoat':
		case 'material.clearcoatRoughness':
		case 'material.sheen':
		case 'material.sheenRoughness':
		case 'material.transmission':
		case 'material.thickness':
		case 'material.attenuationDistance':
		case 'material.iridescence':
		case 'material.iridescenceIOR':
		case 'material.anisotropy':
		case 'material.anisotropyRotation':
		case 'material.dispersion':
		case 'material.reflectivity':
		case 'material.refractionRatio':
		case 'material.bumpScale':
		case 'material.displacementScale':
		case 'material.displacementBias':
		case 'material.linewidth':
		case 'material.scale':
		case 'material.dashSize':
		case 'material.gapSize':
		case 'material.dashOffset': {

			const prop = src.property || kind.split( '.' )[ 1 ];
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, material.${ prop });`;

		}

		case 'material.normalScale': {

			const prop = src.property || 'normalScale';
			usedWriters.add( 'writeVec2' );
			return `writeVec2(view, ${ off }, material.${ prop });`;

		}

		case 'material.clearcoatNormalScale': {

			const prop = src.property || 'clearcoatNormalScale';
			usedWriters.add( 'writeVec2' );
			return `writeVec2(view, ${ off }, material.${ prop });`;

		}

		// Scene-scoped uniforms — fog + scene-level state. The extractor
		// prefixes with `scene.fog.` or `scene.`; the hydrator carries
		// `frame.scene` and `frame.scene.fog` as the live references.
		case 'scene.fog.color': {

			usedWriters.add( 'writeColor' );
			return `writeColor(view, ${ off }, frame.scene.fog.color);`;

		}

		case 'scene.fog.near':
		case 'scene.fog.far':
		case 'scene.fog.density': {

			const prop = src.property || kind.split( '.' )[ 2 ];
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, frame.scene.fog.${ prop });`;

		}

		// Generic scene.<prop> (e.g. scene.environmentIntensity, scene.backgroundIntensity).
		// Read dynamically. Numeric by default — fall back to snapshot's writer
		// inference when a snapshot is present.
		case 'scene.environmentIntensity':
		case 'scene.backgroundIntensity':
		case 'scene.backgroundBlurriness': {

			const prop = src.property || kind.split( '.' )[ 1 ];
			usedWriters.add( 'writeF32' );
			return `writeF32(view, ${ off }, frame.scene.${ prop });`;

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
			return `{ const _l = _tslpFindLight(frame.scene, ${ idxShadowM }); if (_l && _l.shadow && _l.shadow.matrix) writeMat4(view, ${ off }, _l.shadow.matrix); }`;

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
	const valueType = src.valueType || ( snap && snap.type ) || null;
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
		} );
		return emitConstant(
			{ source: { kind: 'constant', valueSnapshot: src.valueSnapshot } },
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

function emitUnknownOrBlocked( kind, off, unsupportedKinds, byteOffset ) {

	if ( Object.prototype.hasOwnProperty.call( DOCUMENTED_BLOCKED_KINDS, kind ) ) {

		unsupportedKinds.push( {
			kind,
			severity: 'blocked',
			reason: DOCUMENTED_BLOCKED_KINDS[ kind ],
			byteOffset,
		} );
		return `throw new Error("[tsl-precompile] blocked kind ${ JSON.stringify( kind ) } at byteOffset ${ byteOffset }: ${ escapeString( DOCUMENTED_BLOCKED_KINDS[ kind ] ) }");`;

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
		return `throw new Error("[tsl-precompile] unmapped object3d scope ${ JSON.stringify( kind ) }");`;

	}

	unsupportedKinds.push( {
		kind,
		severity: 'unknown',
		reason: 'no codegen case for this kind (extractor drift or unrecognised dialect)',
		byteOffset,
	} );
	return `throw new Error("[tsl-precompile] unsupported source.kind: ${ kind }");`;

}

function inferWriterForValueType( valueType ) {

	switch ( valueType ) {

		case 'f32': case 'float': return 'writeF32';
		case 'i32': case 'int': return 'writeI32';
		case 'u32': case 'uint': return 'writeU32';
		case 'vec2': return 'writeVec2';
		case 'vec3': return 'writeVec3';
		case 'vec4': return 'writeVec4';
		case 'color': return 'writeColor';
		case 'mat3': return 'writeMat3';
		case 'mat4': return 'writeMat4';
		default: return null;

	}

}

function escapeString( s ) {

	return String( s ).replace( /\\/g, '\\\\' ).replace( /"/g, '\\"' );

}
