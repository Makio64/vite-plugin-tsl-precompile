/**
 * VENDORED from three.js fork branch `tsl-precompile`
 * Source: src/nodes/precompile/extractUniformPlan.js
 * See VENDORING.md for provenance and upgrade policy.
 *
 * Uniform-slot provenance extractor.
 *
 * Walks a compiled `NodeBuilderState` and tags each uniform slot with a
 * serializable `source` descriptor. The precompiled hydrator uses these
 * descriptors to produce per-frame updaters without any `src/nodes/**`
 * classes on the runtime side.
 *
 * Emits plan entries for `UniformsGroup` UBOs (slot-level provenance) AND
 * for sampled-texture / sampler bindings (binding-level provenance). Storage
 * buffers and depth textures are still deferred.
 *
 * @module ExtractUniformPlan
 */

// Vendor note: these symbols live inside three.js under '../accessors/ModelNode.js'
// and '../utils/Timer.js'. The stock three package re-exports them via 'three/tsl'.
// If a future three.js release drops them from 'three/tsl', bump the vendor
// version in VENDORING.md and add a compat shim in _shared/three-compat.js.
import { modelNormalMatrix, modelWorldMatrixInverse, time, deltaTime, frameId, backgroundBlurriness, backgroundIntensity, backgroundRotation, materialEnvIntensity, materialEnvRotation, toneMappingExposure, lightPosition, lightTargetPosition, lightViewPosition, lightShadowMatrix } from 'three/tsl';
import { UniformNode } from 'three/webgpu';
import {
	canonicalTextureImageSource,
	createViewportTextureIdentity,
} from '@tsl-precompile/contract/dynamic-bindings';
import { createLightSourceIdentityMetadata } from '@tsl-precompile/contract/light-identities';
import { RENDER_BINDING_OWNER_KINDS, SHADOW_CASTER_COPIED_BINDING_PROPERTIES } from '@tsl-precompile/contract/render-selector';
import { createRendererRenderTargetTextureSelector } from '@tsl-precompile/contract/render-target-texture';
import { isObservedVelocityProjectionSource } from '../velocity-projection-observation.js';

const SHADOW_CASTER_COPIED_BINDING_PROPERTY_SET = new Set( SHADOW_CASTER_COPIED_BINDING_PROPERTIES );
const PMREM_CUBE_UV_MAPPING = 306;

/**
 * Three r185 decides whether a sampler is a comparison sampler from the
 * authored TextureNode, not from Texture.compareFunction alone. Preserve that
 * intent as a boolean because the node graph is deliberately absent at replay.
 *
 * @param {?Object} binding
 * @return {boolean}
 */
export function isComparisonSamplerBinding( binding ) {

	return !! (
		binding &&
		binding.isSampler === true &&
		binding.isSampledTexture !== true &&
		binding.textureNode &&
		binding.textureNode.compareNode != null
	);

}

// UniformNode binds update callbacks twice, so `node.update.toString()` is
// native code and cannot identify Three's lazy high-precision callbacks.
// Capture the original callback in a WeakMap before the lazy ModelNode and
// ShadowNode graphs are built. The wrapper preserves Three's exact behavior,
// installs once per Three class identity, and never annotates user nodes.
const UNIFORM_UPDATE_CAPTURE = Symbol.for( '@tsl-precompile/uniform-update-callback-capture' );

function installUniformUpdateCallbackCapture() {

	const prototype = UniformNode && UniformNode.prototype;
	if ( ! prototype || typeof prototype.onUpdate !== 'function' ) throw new Error( 'extractUniformPlan: Three UniformNode.onUpdate is unavailable' );
	const installed = prototype[ UNIFORM_UPDATE_CAPTURE ];
	if ( installed && installed.callbacks instanceof WeakMap ) return installed.callbacks;

	const callbacks = new WeakMap();
	const originalOnUpdate = prototype.onUpdate;
	Object.defineProperty( prototype, UNIFORM_UPDATE_CAPTURE, {
		value: { callbacks, originalOnUpdate },
		configurable: false,
		enumerable: false,
		writable: false,
	} );
	prototype.onUpdate = function captureUniformUpdateCallback( callback, updateType ) {

		callbacks.set( this, callback );
		return originalOnUpdate.call( this, callback, updateType );

	};
	return callbacks;

}

const capturedUniformUpdateCallbacks = installUniformUpdateCallbackCapture();
const STOCK_HIGHP_MODEL_VIEW_CALLBACK = '({object,camera})=>{returnobject.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse,object.matrixWorld);}';
const STOCK_HIGHP_MODEL_NORMAL_VIEW_CALLBACK = '({object,camera})=>{if(isHighPrecisionModelViewMatrix!==true){object.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse,object.matrixWorld);}returnobject.normalMatrix.getNormalMatrix(object.modelViewMatrix);}';
const STOCK_HIGHP_SHADOW_MODEL_CALLBACK = '({object},self)=>{returnself.value.multiplyMatrices(shadowMatrix.value,object.matrixWorld);}';

function capturedUniformUpdateSource( node ) {

	const callback = capturedUniformUpdateCallbacks.get( node );
	if ( typeof callback !== 'function' ) return { callback: null, source: '' };
	let source = '';
	try { source = Function.prototype.toString.call( callback ).replace( /\s+/g, '' ); } catch ( _ ) { /* ignored */ }
	return { callback, source };

}

/**
 * Resolve a TSL update node to a `source` descriptor for the uniform slot
 * it drives. Return `null` if the node does not drive a per-slot uniform
 * (e.g. UniformGroupNode stubs that also appear in `updateNodes`).
 *
 * Dispatch is by `constructor.type` — the `is<Foo>Node` flags are not set
 * on most base classes (ReferenceNode, Object3DNode), so relying on them
 * misses the vast majority of update nodes.
 *
 * @param {Object} node - A TSL update node pulled from `state.updateNodes`.
 * @return {?{ uniformNode: Object, source: Object }}
 */
function object3DSourceForNode( node, context ) {

	const type = node.constructor ? node.constructor.type : null;
	const prefix = type === 'ModelNode' ? 'object.' : 'object3d.';
	const scope = node.scope || 'unknown';
	const explicitObject = type === 'Object3DNode' ? node.object3d : null;
	const contextObject = context && context.object || null;

	if ( explicitObject && explicitObject !== contextObject && explicitObject.isCamera === true ) {

		return {
			kind: prefix + scope,
			target: 'camera',
		};

	}

	return { kind: prefix + scope };

}

function materialReferenceSource( node, type, context ) {

	const shadowCasterContext = context && context.bindingOwnerKind === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER;
	const materialBindingOwners = context && context.materialBindingOwners;
	const hasExactOwners = shadowCasterContext && materialBindingOwners instanceof Set && materialBindingOwners.size > 0;

	if ( type === 'ReferenceNode' ) {

		// Plain ReferenceNode targets are heterogeneous. Only a stable explicit
		// `.object` identity from Three's reference( ..., sourceMaterial ) call
		// can prove caster ownership. `.reference` is mutable and may already
		// point at a later draw when cached update nodes are inspected.
		if ( hasExactOwners && node.object && materialBindingOwners.has( node.object ) ) {

			return {};

		}
		return null;

	}

	// MaterialReferenceNode.material is the stable explicit target. A null
	// target means "the active shader material"; for shadow passes only the
	// properties Renderer.renderObject copies from the caster may opt into the
	// alternate owner. Other dynamic material references (notably opacity)
	// remain owned by the renderer's shared shadow material.
	const explicitMaterial = node.material || node.object || null;
	if ( hasExactOwners ) {

		if ( explicitMaterial ) {

			if ( materialBindingOwners.has( explicitMaterial ) ) return {};
			if ( explicitMaterial !== context.material ) return null;
			return { bindingOwner: RENDER_BINDING_OWNER_KINDS.MATERIAL };

		} else if ( SHADOW_CASTER_COPIED_BINDING_PROPERTY_SET.has( node.property ) ) {

			return {};

		}
		return { bindingOwner: RENDER_BINDING_OWNER_KINDS.MATERIAL };

	} else if ( explicitMaterial && context && context.material && explicitMaterial !== context.material ) {

		// Reading an explicitly different material through frame.material would
		// be incorrect. Preserve the live-node/snapshot fallback until the
		// contract grows a generic external-reference owner.
		return null;

	}

	return {};

}

function resolveFromUpdateNode( node, context = null ) {

	const type = node.constructor ? node.constructor.type : null;
	const objectPropertyUpdate = resolveObjectPropertyUpdateNode( node );
	if ( objectPropertyUpdate ) return objectPropertyUpdate;

	// ReferenceNode / MaterialReferenceNode expose the live property on the
	// referenced object. Their internal `node` field is the TSL UniformNode
	// that ends up in the UBO.
	//
	// MaterialReferenceNode always targets the active material. Plain
	// ReferenceNode carries a heterogeneous target — inspect `node.reference`
	// for well-known scene objects (Fog, FogExp2, Scene) so the hydrator
	// reads the right live state:
	//
	//   sceneFog  → 'scene.fog.<prop>'   (scene.fog.color / near / far / density)
	//   scene     → 'scene.<prop>'       (scene.environment, background, ...)
	//   other     → 'reference.<prop>'   (generic; hydrator reads frame.object)
	// UserDataNode — a ReferenceNode subclass whose `updateReference()` binds
	// to `state.object.userData[property]` each draw. Emit a per-draw
	// `object3d.userData` kind so the hydrator/updater reads the live value
	// from `frame.object.userData[property]` at render time instead of
	// freezing the compile-time snapshot (which is always 0 for unset keys).
	if ( type === 'UserDataNode' ) {

		if ( ! node.node ) return null;
		return {
			uniformNode: node.node,
			source: {
				kind: 'object3d.userData',
				property: node.property,
				uniformType: node.uniformType || 'float',
			},
		};

	}

	// RendererReferenceNode is implemented on top of ReferenceBaseNode rather
	// than ReferenceNode, so it does not enter the generic reference branch
	// below. Match its stable public shape instead of relying on the imported
	// `toneMappingExposure` singleton: extraction and compilation can resolve
	// different three.js module entry points, making singleton identity differ.
	if ( type === 'RendererReferenceNode' && node.property === 'toneMappingExposure' ) {

		return node.node ? {
			uniformNode: node.node,
			source: { kind: 'renderer.toneMappingExposure' },
		} : null;

	}

	if ( type === 'ReferenceNode' || type === 'MaterialReferenceNode' ) {

		// Route by target identity. Material + scene + fog references
		// resolve against stable runtime objects (frame.material, frame.scene,
		// frame.scene.fog) that the hydrator walks each frame.
		// ANY other target — LightShadow, Object3D, an app-specific object —
		// falls through to `null` so the slot's fallback path becomes
		// `uniform.live`. That reads the internal UniformNode.value, which
		// the preserved state.updateNodes' ReferenceNode.update() keeps
		// refreshed from the live `this.reference` object.
		let prefix = null;
		let bindingOwner = null;
		const materialSource = materialReferenceSource( node, type, context );
		if ( materialSource ) {

			prefix = 'material';
			bindingOwner = materialSource.bindingOwner || null;

		} else if ( type === 'ReferenceNode' && node.reference && ( node.reference.isFog || node.reference.isFogExp2 ) ) {

			prefix = 'scene.fog';

		} else if ( type === 'ReferenceNode' && node.reference && node.reference.isScene ) {

			prefix = 'scene';

		}

		if ( prefix === null ) return null;

		const source = {
			kind: prefix + '.' + node.property,
			property: node.property,
			uniformType: node.uniformType || null
		};
		if ( bindingOwner ) source.bindingOwner = bindingOwner;

		return node.node ? { uniformNode: node.node, source } : null;

	}

	// LightNode.intensity is exposed via three/tsl `lightIntensity` (some
	// future versions). The intensity is also driven by AnalyticLightNode's
	// `colorScaled` (this.color = light.color * light.intensity), so the
	// `light.colorScaled` kind already covers the most common case. The
	// per-light shadow `matrix` / `bias` / `normalBias` / `radius` /
	// `intensity` / `blurSamples` references are wired up separately via
	// `collectShadowUniformSources` (called from `extractUniformPlan`).

	// Object3DNode / ModelNode — the `scope` selects which object3d metric
	// is written into the embedded UniformNode each frame.
	if ( type === 'Object3DNode' || type === 'ModelNode' ) {

		return node.uniformNode ? { uniformNode: node.uniformNode, source: object3DSourceForNode( node, context ) } : null;

	}

	// Bare UniformNode with onRenderUpdate / onObjectUpdate: the node itself
	// holds the uniform slot. Classify by module-level identity first — these
	// TSL helpers don't set an explicit `.name`, so name-based dispatch can't
	// reach them. Fall back to name dispatch for the named camera uniforms.
	if ( type === 'UniformNode' ) {

		const known = classifyByIdentity( node );
		if ( known ) return { uniformNode: node, source: known };
		const objectMatrix = classifyObjectMatrixCallback( node );
		if ( objectMatrix ) return { uniformNode: node, source: objectMatrix };

		// Wave 5+ — pattern-detect time-derived `onFrameUpdate(frame => frame.time)`
		// style callbacks. `UniformNode.onUpdate` wraps the user callback and
		// auto-assigns its return value to `node.value`, so invoking
		// `node.update(stubFrame)` with a known `frame.time` value tells us
		// whether the slot is a pure time passthrough. Lift those to the
		// `frame.time` / `frame.deltaTime` codegen kinds so the AOT updater
		// honours `__tslpPinnedClock` at replay (instead of freezing the
		// captured snapshot value). Lifts custom_fog + animation-drift cluster
		// without needing a runtime-side callback ledger.
		const detected = classifyByCallback( node );
		if ( detected ) return { uniformNode: node, source: detected };

		return { uniformNode: node, source: classifyByName( node.name ) };

	}

	// ScreenNode — writes viewport / screen-size / DPR uniforms each frame
	// from the live renderer. The internal UniformNode is lazily created by
	// setup() and stored on `node._output`. By the time extractUniformPlan
	// runs the NodeBuilderState is fully compiled, so `_output` is always set.
	// Scopes COORDINATE and UV do not drive a UBO slot (they expand to
	// built-in WGSL expressions), so we return null for them.
	if ( type === 'ScreenNode' ) {

		const scope = node.scope;
		let kind = null;
		if ( scope === 'size' ) kind = 'renderer.size';
		else if ( scope === 'viewport' ) kind = 'renderer.viewport';
		else if ( scope === 'dpr' ) kind = 'renderer.dpr';

		if ( kind === null || ! node._output ) return null;

		return { uniformNode: node._output, source: { kind } };

	}

	return null;

}

/**
 * Detect Three's CPU/high-precision model-view matrix callbacks without
 * retaining ModelNode singleton identity. The high-precision uniforms are
 * created inside a cached Fn during builder setup, so they are anonymous
 * object-update UniformNodes by the time extraction sees them.
 *
 * Match only the original stock callback captured before UniformNode binds
 * it. Never execute object-update callbacks during extraction: user callbacks
 * may mutate their matrix or application state even when their return value is
 * restored afterward.
 */
function classifyObjectMatrixCallback( node ) {

	if ( node.updateType !== 'object' || typeof node.update !== 'function' ) return null;
	if ( node.nodeType !== 'mat3' && node.nodeType !== 'mat4' ) return null;
	const originalValue = node.value;
	if ( ! originalValue || ( node.nodeType === 'mat3' ? originalValue.isMatrix3 !== true : originalValue.isMatrix4 !== true ) ) return null;
	const { source } = capturedUniformUpdateSource( node );
	if ( node.nodeType === 'mat3' && source === STOCK_HIGHP_MODEL_NORMAL_VIEW_CALLBACK ) return { kind: 'object.modelNormalViewMatrix' };
	if ( node.nodeType === 'mat4' && source === STOCK_HIGHP_MODEL_VIEW_CALLBACK ) return { kind: 'object.modelViewMatrix' };
	return null;

}

function resolveObjectPropertyUpdateNode( node ) {

	const uniformNode = node && node.uniformNode || null;
	if ( ! uniformNode || uniformNode.isUniformNode !== true || typeof node.update !== 'function' ) return null;

	let source = '';
	try { source = Function.prototype.toString.call( node.update ); } catch ( _ ) { return null; }
	if ( ! /uniformNode\s*\.\s*value\s*(?:\.copy\s*\(|=)/.test( source ) ) return null;

	const objectAliases = new Set( [ 'object' ] );
	for ( const match of source.matchAll( /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*frame\s*\.\s*object\b/g ) ) {

		objectAliases.add( match[ 1 ] );

	}

	const propertyByVariable = new Map();
	for ( const alias of objectAliases ) {

		const escaped = alias.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
		for ( const match of source.matchAll( new RegExp( `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${ escaped }\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\b`, 'g' ) ) ) {

			propertyByVariable.set( match[ 1 ], match[ 2 ] );

		}

		const directCopy = source.match( new RegExp( `uniformNode\\s*\\.\\s*value\\s*\\.\\s*copy\\s*\\(\\s*${ escaped }\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\b` ) );
		if ( directCopy ) return objectPropertyUpdateSource( uniformNode, directCopy[ 1 ] );

	}

	const copyArg = source.match( /uniformNode\s*\.\s*value\s*\.\s*copy\s*\(\s*([A-Za-z_$][\w$]*)\b/ );
	if ( copyArg && propertyByVariable.has( copyArg[ 1 ] ) ) {

		return objectPropertyUpdateSource( uniformNode, propertyByVariable.get( copyArg[ 1 ] ) );

	}

	return null;

}

function objectPropertyUpdateSource( uniformNode, property ) {

	return {
		uniformNode,
		source: {
			kind: 'object3d.nodeUniform',
			property,
			uniformType: uniformNode.nodeType || null,
		},
	};

}

/**
 * Match against well-known module-level TSL UniformNode instances (the ones
 * that don't set a descriptive `.name`). Keeps the hydrator dispatch
 * uniform across materials that use these helpers.
 *
 * @param {Object} node
 * @return {?Object}
 */
function classifyByIdentity( node ) {

	if ( node === modelNormalMatrix ) return { kind: 'object.normalMatrix' };
	if ( node === modelWorldMatrixInverse ) return { kind: 'object.worldMatrixInverse' };
	if ( node === time ) return { kind: 'frame.time' };
	if ( node === deltaTime ) return { kind: 'frame.deltaTime' };
	if ( node === frameId ) return { kind: 'frame.frameId' };
	// Scene-state TSL helpers used by Background.js (and any user TSL
	// graph that imports them). These are bare `uniform()` calls with
	// `onRenderUpdate(({scene}) => scene.<prop>)` — the extractor would
	// otherwise classify them as anonymous `uniform.live` and freeze
	// them at extraction-time values, which makes
	// `scene.backgroundBlurriness` ramps invisible at runtime.
	if ( node === backgroundBlurriness ) return { kind: 'scene.backgroundBlurriness', property: 'backgroundBlurriness' };
	if ( node === backgroundIntensity ) return { kind: 'scene.backgroundIntensity', property: 'backgroundIntensity' };
	if ( node === backgroundRotation ) return { kind: 'scene.backgroundRotation', property: 'backgroundRotation' };
	// MaterialProperties.js chooses between material.envMap* and
	// scene.environment* on every object update. Keep that choice live instead
	// of baking whichever owner happened to be present during capture.
	if ( node === materialEnvIntensity ) return { kind: 'environment.intensity' };
	if ( node === materialEnvRotation ) return { kind: 'environment.rotation' };
	// toneMappingExposure is a bare `uniform()` with onRenderUpdate that reads
	// renderer.toneMappingExposure. Without this identity check the slot falls
	// through to `uniform.live` and freezes at extraction-time — animated
	// exposure ramps never propagate on replay.
	if ( node === toneMappingExposure ) return { kind: 'renderer.toneMappingExposure' };
	return null;

}

/**
 * Wave 5+ — detect `uniform(...).onFrameUpdate( ( frame ) => frame.time )` style
 * callbacks by INVOKING the registered update function with two stub frames
 * and checking whether `node.value` tracks `frame.time` (or `frame.deltaTime`).
 *
 * Why this works: `UniformNode.onUpdate` overrides `Node.onUpdate` to wrap the
 * user callback so any return value is auto-assigned to `this.value`. So
 * after `node.update({ time: 7, ... })`, if `node.value === 7`, the slot is a
 * pure `frame.time` passthrough — lift it to the `frame.time` kind so the
 * AOT updater + `__tslpPinnedClock` infrastructure pick it up.
 *
 * Detects exact identity (return value === input time). Doesn't try to
 * recognise scaled / sin / cos / mod transforms — those stay as
 * `uniform.live` and would need a runtime-side callback ledger to update,
 * which is a separate workstream.
 *
 * Side effects: invokes `node.update(...)` twice during extraction, which can
 * mutate `node.value`. We save/restore the original value, so the final
 * captured snapshot is unchanged.
 *
 * @param {Object} node - a UniformNode with `.update` and `.updateType` set.
 * @returns {?{ kind: string }}
 */
function classifyByCallback( node ) {

	if ( typeof node.update !== 'function' ) return null;
	if ( node.updateType !== 'frame' && node.updateType !== 'render' ) return null;

	const originalValue = node.value;
	try {

		// Wave 6 S1: invoke the callback with 3 stub frames so we can recognise
		// not just exact passthrough but also linear scaling (`frame => frame.time * k`).
		// Linear-detection requires at least two divergent (time, value) pairs;
		// the third frame guards against false positives from non-linear callbacks
		// that happen to be linear over the first two samples.
		const frameA = { time: 1.0, deltaTime: 0.016, frameId: 1 };
		const frameB = { time: 2.0, deltaTime: 0.016, frameId: 2 };
		const frameC = { time: 3.0, deltaTime: 0.016, frameId: 3 };

		node.update( frameA );
		const valueA = node.value;
		node.update( frameB );
		const valueB = node.value;
		node.update( frameC );
		const valueC = node.value;

		// Restore the captured snapshot value so we don't leak stub data
		// into the artifact's `valueSnapshot`.
		node.value = originalValue;

		if ( typeof valueA === 'number' && typeof valueB === 'number' && typeof valueC === 'number' ) {

			// Exact `frame.time` passthrough.
			if ( valueA === frameA.time && valueB === frameB.time && valueC === frameC.time ) {

				return { kind: 'frame.time' };

			}
			// Exact `frame.deltaTime` passthrough — the callback returns the
			// per-frame delta. All three stubs use the same deltaTime, so we
			// just confirm constancy at that value.
			if ( valueA === frameA.deltaTime && valueB === frameB.deltaTime && valueC === frameC.deltaTime ) {

				return { kind: 'frame.deltaTime' };

			}
			// Wave 6 S1: linear-time scaling — `frame => frame.time * k`. Compute
			// `k = (v2 - v1) / (t2 - t1)` from the first two samples and confirm
			// the third sample agrees AND that `v = k * t` exactly for each frame.
			// "Exactly" tolerates float-mul ulp drift via a relative tolerance.
			const k = ( valueB - valueA ) / ( frameB.time - frameA.time );
			if ( Number.isFinite( k ) && k !== 0 ) {

				const predictA = k * frameA.time;
				const predictB = k * frameB.time;
				const predictC = k * frameC.time;
				const tol = Math.max( 1e-6, Math.abs( k ) * 1e-6 );
				const closeA = Math.abs( valueA - predictA ) <= tol;
				const closeB = Math.abs( valueB - predictB ) <= tol;
				const closeC = Math.abs( valueC - predictC ) <= tol;
				if ( closeA && closeB && closeC ) {

					return { kind: 'frame.time.scaled', scale: k };

				}

			}

		}

	} catch ( _ ) {

		// Restore value on any callback throw. The user callback might
		// access frame properties we didn't stub or do unexpected things;
		// we don't want a thrown callback to break extraction.
		try { node.value = originalValue; } catch ( __ ) {}

	}
	return null;

}

/**
 * Map a declared uniform name to a known source kind. Unknown names get
 * a `constant` kind — the hydrator snapshots the current value at
 * extraction time and emits a no-op updater.
 *
 * @param {string} name
 * @return {Object} A source descriptor.
 */
function classifyByName( name ) {

	switch ( name ) {

		case 'cameraProjectionMatrix': return { kind: 'camera.projectionMatrix' };
		case 'cameraProjectionMatrixInverse': return { kind: 'camera.projectionMatrixInverse' };
		case 'cameraViewMatrix': return { kind: 'camera.viewMatrix' };
		case 'cameraWorldMatrix': return { kind: 'camera.worldMatrix' };
		case 'cameraPosition': return { kind: 'camera.position' };
		case 'cameraNear': return { kind: 'camera.near' };
		case 'cameraFar': return { kind: 'camera.far' };
		// Unnamed UniformNode in updateNodes → live-read from its `.value`.
		// The extractor attaches `_liveNode` on the slot; the hydrator's
		// `uniform.live` path picks up whatever onRenderUpdate / onFrameUpdate
		// / LightNode.update() writes to the node. Covers shadow matrices,
		// light positions / directions, and any other dynamically-driven
		// UniformNode that doesn't route through a ReferenceNode.
		default: return { kind: 'uniform.live', name: name || null };

	}

}

/**
 * Serialize a current uniform value so a hydrator running in a different
 * bundle can reconstruct it without introspecting Color / Matrix4 etc.
 *
 * @param {any} value
 * @return {?{ type: string, data: Array<number>|number }}
 */
function snapshotUniformValue( value ) {

	if ( value === null || value === undefined ) return null;

	if ( typeof value === 'number' ) {

		return { type: 'number', data: value };

	}

	if ( value.isColor ) {

		return { type: 'color', data: [ value.r, value.g, value.b ] };

	}

	if ( value.isVector2 ) return { type: 'vec2', data: [ value.x, value.y ] };
	if ( value.isVector3 ) return { type: 'vec3', data: [ value.x, value.y, value.z ] };
	if ( value.isVector4 ) return { type: 'vec4', data: [ value.x, value.y, value.z, value.w ] };

	if ( value.isMatrix3 ) return { type: 'mat3', data: Array.from( value.elements ) };
	if ( value.isMatrix4 ) return { type: 'mat4', data: Array.from( value.elements ) };

	return null;

}

/**
 * Classify an internal `Uniform` (std140 slot inside a UniformsGroup) into
 * a shader-facing dtype the hydrator switches on.
 *
 * @param {Object} uniform
 * @return {string}
 */
function uniformDtype( uniform ) {

	if ( uniform.isNumberUniform ) {

		const type = typeof uniform.getType === 'function' ? uniform.getType() : null;
		if ( type === 'int' || type === 'uint' ) return type;
		return 'number';

	}
	if ( uniform.isVector2Uniform ) return 'vec2';
	if ( uniform.isVector3Uniform ) return 'vec3';
	if ( uniform.isVector4Uniform ) return 'vec4';
	if ( uniform.isColorUniform ) return 'color';
	if ( uniform.isMatrix3Uniform ) return 'mat3';
	if ( uniform.isMatrix4Uniform ) return 'mat4';

	return 'unknown';

}

/**
 * Classify a sampled-texture binding by its texture-type dimensionality.
 *
 * @param {Object} binding
 * @return {string}
 */
function classifyTextureBinding( binding ) {

	if ( binding.isSampledCubeTexture ) return 'cube';
	if ( binding.isSampledArrayTexture ) return '2d-array';
	if ( binding.isSampled3DTexture || binding.isSampledTexture3D ) return '3d';
	if ( binding.isSampledTexture ) return '2d';
	return 'unknown';

}

/**
 * Walk `state.updateNodes` for `AnalyticLightNode` instances and harvest the
 * UniformNodes each one owns. Each entry maps a UniformNode to a `light.<prop>`
 * source descriptor tagged with the light's traversal index (0..N-1) so the
 * runtime hydrator can locate the live `Light` object on `frame.scene` at
 * render time. Without this, three.js's per-light uniforms (color * intensity,
 * cutoff distance, decay exponent, cone/penumbra cosines, view-space position)
 * fall through to the unnamed `uniform.live` path and freeze at extraction-time
 * snapshots — so animated `light.intensity` / `light.position` never propagate.
 *
 * The matching helpers `lightPosition()` / `lightTargetPosition()` /
 * `lightViewPosition()` from `three/tsl` are memoised by the live light
 * instance, so calling them here returns the SAME UniformNode the original
 * setup built — no duplicate uniform allocation.
 *
 * @param {Object} state - A built NodeBuilderState.
 * @return {Map<Object, Object>} UniformNode → light source descriptor.
 */
function collectLightUniformSources( state ) {

	const out = new Map();
	if ( ! state || ! Array.isArray( state.updateNodes ) ) return out;

	let lightIndex = 0;
	for ( const node of state.updateNodes ) {

		if ( ! node || node.isAnalyticLightNode !== true ) continue;
		const light = node.light;
		if ( ! light ) continue;

		const base = createLightSourceIdentityMetadata( light, lightIndex );

		// `colorNode` is `uniform(this.color)` — `this.color` is the
		// AnalyticLightNode's internal Color that `update()` sets to
		// `light.color * light.intensity`. We want the runtime to compute
		// the same product live, so we tag it as `light.colorScaled` and
		// the hydrator/emit-updater multiply at write time.
		const lightColorNode = node.baseColorNode || node.colorNode;
		if ( lightColorNode ) {

			out.set( lightColorNode, { kind: 'light.colorScaled', ...base } );

		}
		// PointLight / SpotLight expose cutoffDistance + decay as uniforms.
		if ( node.cutoffDistanceNode ) {

			out.set( node.cutoffDistanceNode, { kind: 'light.distance', property: 'distance', ...base } );

		}
		if ( node.decayExponentNode ) {

			out.set( node.decayExponentNode, { kind: 'light.decay', property: 'decay', ...base } );

		}
		// SpotLight only — `coneCos = cos(angle)`, `penumbraCos = cos(angle*(1-penumbra))`.
		// `update()` writes Math.cos products into these UniformNodes; the runtime
		// recomputes the same product live so animated angle/penumbra propagate.
		if ( node.coneCosNode ) {

			out.set( node.coneCosNode, { kind: 'light.coneCos', ...base } );

		}
		if ( node.penumbraCosNode ) {

			out.set( node.penumbraCosNode, { kind: 'light.penumbraCos', ...base } );

		}

		// Position / target / view-space-position uniforms are NOT owned by
		// the AnalyticLightNode — they live on a WeakMap keyed by light in
		// `three/src/nodes/accessors/Lights.js`. Calling the public TSL
		// helpers re-resolves them from the same WeakMap and returns the
		// already-built UniformNode without allocating a new one. Wrapped
		// in try/catch because not every light pulls in every helper at
		// build-time — calling `lightTargetPosition` for a PointLight (no
		// `.target`) would break onRenderUpdate at write time.
		try {

			if ( typeof lightShadowMatrix === 'function' && light.shadow ) {

				const u = lightShadowMatrix( light );
				if ( u && u.value ) out.set( u, { kind: 'light.shadowMatrix', property: 'matrix', ...base } );

			}

		} catch ( _ ) { /* not all lights expose shadow matrices */ }

		try {

			if ( typeof lightPosition === 'function' ) {

				const u = lightPosition( light );
				if ( u && u.value ) out.set( u, { kind: 'light.position', ...base } );

			}

		} catch ( _ ) { /* not all lights expose position */ }

		try {

			if ( typeof lightViewPosition === 'function' ) {

				const u = lightViewPosition( light );
				if ( u && u.value ) out.set( u, { kind: 'light.viewPosition', ...base } );

			}

		} catch ( _ ) { /* not all lights expose viewPosition */ }

		try {

			if ( typeof lightTargetPosition === 'function' && light.target ) {

				const u = lightTargetPosition( light );
				if ( u && u.value ) out.set( u, { kind: 'light.targetPosition', ...base } );

			}

		} catch ( _ ) { /* PointLight has no target */ }

		// RectAreaLightNode — view-space half-width / half-height (vec3 each)
		if ( node.halfWidth ) {

			out.set( node.halfWidth, { kind: 'light.halfWidth', ...base } );

		}
		if ( node.halfHeight ) {

			out.set( node.halfHeight, { kind: 'light.halfHeight', ...base } );

		}

		lightIndex ++;

	}

	return out;

}

/**
 * Walk `state.updateNodes` for `ReferenceNode` instances whose `reference`
 * is a `LightShadow` belonging to one of the scene's `AnalyticLightNode`s.
 * Map each one to a `light.shadow<Prop>` source descriptor tagged with the
 * traversal-order `lightIndex` so the runtime can locate the live light at
 * render time and read the shadow property live (e.g. `light.shadow.bias`).
 *
 * Without this, `ShadowNode.setupShadow()` builds anonymous
 * `reference('bias', 'float', shadow)` calls which fall through to the
 * unnamed `uniform.live` path and freeze at extraction-time snapshots —
 * so animated `shadow.bias`, `shadow.normalBias`, `shadow.radius`,
 * `shadow.intensity`, `shadow.blurSamples`, `shadow.mapSize` never propagate.
 *
 * Renderer-owned VSM blur quads do not contain their originating
 * `AnalyticLightNode`; their state only retains ReferenceNodes targeting the
 * light's `LightShadow`. `context.shadowPassOwner` supplies that exact owner
 * after compileTSL correlates the private VSM material back to its ShadowNode.
 *
 * @param {Object} state - A built NodeBuilderState.
 * @param {?Object} context - Optional extraction context.
 * @return {Map<Object, Object>} UniformNode → shadow source descriptor.
 */
function collectShadowUniformSources( state, context = null ) {

	const out = new Map();
	if ( ! state || ! Array.isArray( state.updateNodes ) ) return out;

	// First pass: build a map from `LightShadow` instance → { lightIndex, lightUuid }
	// using the same AnalyticLightNode walk order that `collectLightUniformSources`
	// uses, so the indices align with the existing `light.<prop>` plan.
	const shadowToBase = new Map();
	const explicitOwner = context && context.shadowPassOwner || null;
	if ( explicitOwner && explicitOwner.light && explicitOwner.light.shadow ) {

		shadowToBase.set(
			explicitOwner.light.shadow,
			createLightSourceIdentityMetadata( explicitOwner.light, explicitOwner.lightIndex ),
		);

	}
	let lightIndex = 0;
	for ( const node of state.updateNodes ) {

		if ( ! node || node.isAnalyticLightNode !== true ) continue;
		const light = node.light;
		if ( light && light.shadow ) {

			shadowToBase.set( light.shadow, createLightSourceIdentityMetadata( light, lightIndex ) );

		}
		lightIndex ++;

	}

	if ( shadowToBase.size === 0 ) return out;

	// Map of LightShadow scalar/vector properties to (kind, uniformType)
	// pairs. These mirror the `reference()` calls inside
	// `ShadowNode.setupShadow()` and `ShadowNode.setupShadowCoord()`.
	// Property names match `LightShadow` field names verbatim.
	const SHADOW_PROP_KINDS = {
		bias: { kind: 'light.shadowBias', uniformType: 'float' },
		normalBias: { kind: 'light.shadowNormalBias', uniformType: 'float' },
		radius: { kind: 'light.shadowRadius', uniformType: 'float' },
		intensity: { kind: 'light.shadowIntensity', uniformType: 'float' },
		blurSamples: { kind: 'light.shadowBlurSamples', uniformType: 'float' },
		mapSize: { kind: 'light.shadowMapSize', uniformType: 'vec2' },
		matrix: { kind: 'light.shadowMatrix', uniformType: 'mat4' },
	};

	// Second pass: any ReferenceNode whose `reference` matches a known
	// LightShadow gets routed to the corresponding `light.shadow<prop>` kind.
	for ( const node of state.updateNodes ) {

		if ( ! node ) continue;
		const type = node.constructor ? node.constructor.type : null;
		if ( type !== 'ReferenceNode' ) continue;

		const target = node.reference;
		if ( ! target ) continue;

		const base = shadowToBase.get( target );
		if ( ! base ) continue;

		const meta = SHADOW_PROP_KINDS[ node.property ];
		if ( ! meta ) continue;
		if ( ! node.node ) continue;

		out.set( node.node, {
			kind: meta.kind,
			property: node.property,
			uniformType: node.uniformType || meta.uniformType,
			...base,
		} );

	}

	return out;

}

/**
 * Lift ShadowNode's anonymous high-precision object callback:
 * `light.shadow.matrix * object.matrixWorld`.
 *
 * The callback closes over the light-owned `lightShadowMatrix()` UniformNode,
 * so its source cannot be recovered from the anonymous result UniformNode by
 * name. Only after the captured original callback exactly matches Three's
 * stock callback do we evaluate it against a detached result matrix to expose
 * the closed-over shadow matrix. Arbitrary user callbacks are never invoked.
 */
function collectHighPrecisionShadowModelMatrixSources( state ) {

	const out = new Map();
	if ( ! state || ! Array.isArray( state.updateNodes ) ) return out;
	const shadowMatrices = new Map();
	let lightIndex = 0;
	for ( const node of state.updateNodes ) {

		if ( ! node || node.isAnalyticLightNode !== true ) continue;
		const light = node.light;
		if ( light && light.shadow ) {

			const base = createLightSourceIdentityMetadata( light, lightIndex );
			if ( light.shadow.matrix ) shadowMatrices.set( light.shadow.matrix, base );
			try {

				const shadowMatrixNode = lightShadowMatrix( light );
				if ( shadowMatrixNode && shadowMatrixNode.value ) shadowMatrices.set( shadowMatrixNode.value, base );

			} catch ( _ ) { /* malformed/custom lights can omit shadow infrastructure */ }

		}
		lightIndex ++;

	}
	if ( shadowMatrices.size === 0 ) return out;
	for ( const node of state.updateNodes ) {

		const type = node && node.constructor ? node.constructor.type : null;
		if ( type !== 'UniformNode' || node.nodeType !== 'mat4' || node.updateType !== 'object' || typeof node.update !== 'function' ) continue;
		const originalValue = node.value;
		if ( ! originalValue || originalValue.isMatrix4 !== true ) continue;
		const { callback, source } = capturedUniformUpdateSource( node );
		if ( ! callback || source !== STOCK_HIGHP_SHADOW_MODEL_CALLBACK ) continue;
		const matrixWorld = { __tslpProbe: 'matrixWorld' };
		let leftOperand = null;
		let rightOperand = null;
		let multiplyCalls = 0;
		const resultMatrix = {
			multiplyMatrices( left, right ) {

				leftOperand = left;
				rightOperand = right;
				multiplyCalls ++;
				return this;

			},
		};
		let updatedValue;
		try {

			updatedValue = callback( { object: { matrixWorld } }, { value: resultMatrix } );

		} catch ( _ ) {

			continue;

		}
		const base = shadowMatrices.get( leftOperand );
		if ( base && rightOperand === matrixWorld && multiplyCalls === 1 && updatedValue === resultMatrix ) {

			out.set( node, { kind: 'light.shadowModelMatrix', ...base } );

		}

	}
	return out;

}

/**
 * PointLight shadows use two anonymous render-group UniformNodes for
 * `shadow.camera.near` / `shadow.camera.far` inside PointShadowNode. Those
 * nodes are not reachable through ReferenceNode, so probe the live update
 * closures with temporary sentinel values and tag the matching nodes.
 *
 * @param {Object} state - A built NodeBuilderState.
 * @return {Map<Object, Object>} UniformNode → point shadow camera descriptor.
 */
function collectPointShadowCameraUniformSources( state ) {

	const out = new Map();
	if ( ! state || ! Array.isArray( state.updateNodes ) ) return out;

	const pointLights = [];
	let lightIndex = 0;
	for ( const node of state.updateNodes ) {

		if ( ! node || node.isAnalyticLightNode !== true ) continue;
		const light = node.light;
		if ( light && light.isPointLight === true && light.shadow && light.shadow.camera ) {

			pointLights.push( {
				light,
				...createLightSourceIdentityMetadata( light, lightIndex ),
			} );

		}
		lightIndex ++;

	}

	if ( pointLights.length === 0 ) return out;

	const candidates = [];
	for ( const node of state.updateNodes ) {

		const type = node && node.constructor ? node.constructor.type : null;
		if ( type !== 'UniformNode' ) continue;
		if ( typeof node.update !== 'function' ) continue;
		if ( typeof node.value !== 'number' ) continue;
		candidates.push( node );

	}

	if ( candidates.length === 0 ) return out;

	for ( let i = 0; i < pointLights.length; i ++ ) {

		const base = pointLights[ i ];
		const identity = createLightSourceIdentityMetadata( base.light, base.lightIndex );
		const camera = base.light.shadow.camera;
		const previousNear = camera.near;
		const previousFar = camera.far;
		const sentinelNear = 12345.125 + i * 2;
		const sentinelFar = sentinelNear + 1;

		camera.near = sentinelNear;
		camera.far = sentinelFar;

		try {

			for ( const candidate of candidates ) {

				if ( out.has( candidate ) ) continue;
				const previousValue = candidate.value;

				try {

					candidate.update( {} );
					if ( candidate.value === sentinelNear ) {

						out.set( candidate, {
							kind: 'light.shadowCameraNear',
							property: 'camera.near',
							uniformType: 'float',
							...identity,
						} );

					} else if ( candidate.value === sentinelFar ) {

						out.set( candidate, {
							kind: 'light.shadowCameraFar',
							property: 'camera.far',
							uniformType: 'float',
							...identity,
						} );

					}

				} catch ( _ ) {

					// Other anonymous UniformNodes may require a full frame;
					// they are not point-shadow camera uniforms.

				} finally {

					candidate.value = previousValue;

				}

			}

		} finally {

			camera.near = previousNear;
			camera.far = previousFar;

		}

	}

	return out;

}

/**
 * Some three.js addon meshes (WaterMesh, SkyMesh) store public tweakable
 * UniformNodes on the Object3D instance rather than on the material. When the
 * precompile marker is given the source object, capture those direct
 * `object.foo = uniform(...)` references so generated updaters can read
 * `frame.object.foo.value` at render time instead of freezing anonymous
 * `uniform.live` snapshots.
 *
 * @param {?Object} object
 * @return {Map<Object, Object>} UniformNode → object source descriptor.
 */
function collectObjectUniformSources( object ) {

	const out = new Map();
	if ( ! object || typeof object !== 'object' ) return out;

	for ( const property of Object.keys( object ) ) {

		const node = object[ property ];
		if ( ! node || node.isUniformNode !== true ) continue;
		out.set( node, {
			kind: 'object3d.nodeUniform',
			property,
			uniformType: node.nodeType || null,
		} );

	}
	return out;

}

function collectVelocityUniformSources( state ) {

	const uniformSources = new Map();
	const valueSources = new WeakMap();
	const nodes = [
		...( Array.isArray( state && state.updateNodes ) ? state.updateNodes : [] ),
		...( Array.isArray( state && state.updateBeforeNodes ) ? state.updateBeforeNodes : [] ),
		...( Array.isArray( state && state.updateAfterNodes ) ? state.updateAfterNodes : [] ),
	];
	for ( const node of nodes ) {

		const type = node && node.constructor && node.constructor.type;
		if ( type !== 'VelocityNode' ) continue;
		if ( node.previousProjectionMatrix ) uniformSources.set( node.previousProjectionMatrix, { kind: 'velocity.previousProjectionMatrix' } );
		if ( node.previousCameraViewMatrix ) uniformSources.set( node.previousCameraViewMatrix, { kind: 'velocity.previousCameraViewMatrix' } );
		if ( node.previousModelWorldMatrix ) uniformSources.set( node.previousModelWorldMatrix, { kind: 'velocity.previousModelWorldMatrix' } );

		// VelocityNode.setup() wraps an explicit projection override with a new
		// anonymous UniformNode, so the node itself is not reachable from the
		// VelocityNode. Its `.value`, however, is the exact projectionMatrix
		// object supplied by TRAA. Preserve that identity as a semantic source;
		// snapshot equality is intentionally insufficient because other effects
		// commonly own equal camera matrices.
		const projectionMatrix = node.projectionMatrix;
		if ( projectionMatrix && ( typeof projectionMatrix === 'object' || typeof projectionMatrix === 'function' ) ) {

			valueSources.set( projectionMatrix, { kind: 'velocity.currentProjectionMatrix' } );

		}

	}
	return { uniformSources, valueSources };

}

/**
 * PMREMNode owns three anonymous UniformNodes whose values are derived from
 * the live CubeUV atlas height. They are updated by PMREMNode.updateBefore(),
 * not by an independently serializable callback, so ordinary extraction sees
 * only divergent `uniform.live` snapshots. Correlate the private r185 fields
 * with the exact generated texture now; replay recomputes them from the
 * texture wired into artifact._textureRefs.
 *
 * Three's private `_width` / `_height` names store texel width / texel height,
 * respectively. See PMREMNode._generateCubeUVSize() in the pinned r185 source.
 *
 * @param {Object} state
 * @return {Map<Object, Object>} UniformNode → PMREM scalar source descriptor.
 */
function collectPMREMUniformSources( state ) {

	const out = new Map();
	if ( ! state || ! Array.isArray( state.updateBeforeNodes ) ) return out;

	for ( const node of state.updateBeforeNodes ) {

		const type = node && node.constructor ? node.constructor.type : null;
		if ( type !== 'PMREMNode' && node && node.isPMREMNode !== true ) continue;
		const textureNode = node._texture || null;
		const texture = textureNode && ( textureNode.value || textureNode._value ) || null;
		if ( ! texture || texture.isTexture !== true || typeof texture.uuid !== 'string' || texture.uuid.length === 0 ) continue;

		const sourceBase = { textureUuid: texture.uuid };

		if ( node._maxMip && node._maxMip.isUniformNode === true ) out.set( node._maxMip, { kind: 'pmrem.maxMip', ...sourceBase } );
		if ( node._width && node._width.isUniformNode === true ) out.set( node._width, { kind: 'pmrem.texelWidth', ...sourceBase } );
		if ( node._height && node._height.isUniformNode === true ) out.set( node._height, { kind: 'pmrem.texelHeight', ...sourceBase } );

	}
	return out;

}

/**
 * Walk `state.updateNodes` for `AnalyticLightNode` instances and try to find
 * the one that owns the given depth texture. AnalyticLightNode lazily attaches
 * a `ShadowNode` whose `setup()` allocates `shadow.map.depthTexture`; the
 * binding's TextureNode wraps that exact instance. We match by reference and
 * return the same `lightIndex` traversal index that `collectLightUniformSources`
 * uses, so the hydrator can resolve `frame.scene`'s Nth light at render time.
 *
 * Also returns `shadowMapColor: true` for the regular shadow render target's
 * color attachment (`shadow.map.texture`) and `vsm: true` for the final VSM
 * blur output (`vsmShadowMapHorizontal.texture`). These are distinct:
 * transmitted shadows sample the former directly, while VSM sampling needs
 * the filtered moments texture supplied by the shadow pipeline.
 *
 * The vertical VSM moments texture is intentionally not returned here. It is
 * an internal producer/consumer edge between the two blur passes, not a
 * light-owned final shadow texture. `artifact.internalPass` addresses that
 * binding by semantic role while retaining the ordinary artifact texture
 * sidecar as the in-process capture reference.
 *
 * @param {Object} state
 * @param {Object} depthTexture
 * @param {?Object} context
 * @return {?{ lightIndex: number, lightUuid: ?string, vsm: boolean, shadowMapColor: boolean }}
 */
function findLightForDepthTexture( state, depthTexture, context = null ) {

	if ( ! state || ! Array.isArray( state.updateNodes ) || ! depthTexture ) return null;

	const describeForOwner = ( light, lightIndex, shadowNode ) => {

		if ( ! light ) return null;
		const map = light.shadow && light.shadow.map ? light.shadow.map : null;
		if ( map ) {

			if ( map.depthTexture === depthTexture ) {

				return {
					...createLightSourceIdentityMetadata( light, lightIndex ),
					vsm: false,
					shadowMapColor: false,
				};

			}
			if ( map.texture === depthTexture ) {

				return {
					...createLightSourceIdentityMetadata( light, lightIndex ),
					vsm: false,
					shadowMapColor: true,
				};

			}

		}
		if ( shadowNode && shadowNode.vsmShadowMapHorizontal && shadowNode.vsmShadowMapHorizontal.texture === depthTexture ) {

			return {
				...createLightSourceIdentityMetadata( light, lightIndex ),
				vsm: true,
				shadowMapColor: false,
			};

		}
		return null;

	};

	const explicitOwner = context && context.shadowPassOwner || null;
	if ( explicitOwner ) {

		const described = describeForOwner( explicitOwner.light, explicitOwner.lightIndex, explicitOwner.shadowNode );
		if ( described ) return described;

	}

	let lightIndex = 0;
	for ( const node of state.updateNodes ) {

		if ( ! node || node.isAnalyticLightNode !== true ) continue;
		const light = node.light;
		const described = describeForOwner( light, lightIndex, node.shadowNode );
		if ( described ) return described;
		lightIndex ++;

	}
	return null;

}

// Stable identifying info that survives a fresh Texture instance on replay.
// Used to relink a captured texture binding (whose textureUuid is dead after
// the example reloads) back to a freshly-loaded live texture by `imageSrc`
// (loader URL) or `textureName`.
function textureIdentity( texture ) {

	if ( ! texture ) return null;
	const out = {};
	const image = texture.image || null;
	const userData = texture.userData || null;

	const src = image && ( image.src || image.currentSrc || null );
	if ( typeof src === 'string' && src.length > 0 ) out.imageSrc = canonicalTextureImageSource( src );
	const loaderSrc = userData && userData.__tslpLoaderUrl;
	if ( ! out.imageSrc && typeof loaderSrc === 'string' && loaderSrc.length > 0 ) out.imageSrc = canonicalTextureImageSource( loaderSrc );

	if ( Array.isArray( image ) && image.length > 0 ) {

		const first = image[ 0 ];
		const firstSrc = first && ( first.src || first.currentSrc || null );
		if ( typeof firstSrc === 'string' && firstSrc.length > 0 ) out.imageSrc = canonicalTextureImageSource( firstSrc );

	}

	if ( typeof texture.name === 'string' && texture.name.length > 0 ) {

		out.textureName = texture.name;

	} else if ( out.imageSrc ) {

		// TextureLoader is async: at first render `tex.image` may still be
		// undefined, so the runtime's by-imageSrc lookup hasn't been populated
		// yet. Hosts (harness, app code) conventionally set `tex.name` to the
		// URL filename so by-name lookup works synchronously. Mirror that here
		// when the user didn't name the texture, so the captured identity
		// always carries something the runtime can match before async loads
		// complete.
		const slash = out.imageSrc.lastIndexOf( '/' );
		const tail = slash >= 0 ? out.imageSrc.slice( slash + 1 ) : out.imageSrc;
		const filename = tail.split( '?' )[ 0 ].split( '#' )[ 0 ];
		if ( filename ) out.textureName = filename;

	}
	if ( typeof texture.mapping === 'number' ) out.mapping = texture.mapping;
	if ( typeof texture.wrapS === 'number' ) out.wrapS = texture.wrapS;
	if ( typeof texture.wrapT === 'number' ) out.wrapT = texture.wrapT;
	if ( typeof texture.magFilter === 'number' ) out.magFilter = texture.magFilter;
	if ( typeof texture.minFilter === 'number' ) out.minFilter = texture.minFilter;
	if ( typeof texture.anisotropy === 'number' ) out.anisotropy = texture.anisotropy;
	if ( typeof texture.generateMipmaps === 'boolean' ) out.generateMipmaps = texture.generateMipmaps;
	if ( typeof texture.colorSpace === 'string' ) out.colorSpace = texture.colorSpace;
	if ( typeof texture.flipY === 'boolean' ) out.flipY = texture.flipY;
	if ( image && typeof image.width === 'number' && typeof image.height === 'number' ) {

		out.imageWidth = image.width;
		out.imageHeight = image.height;
		if ( typeof image.depth === 'number' ) out.imageDepth = image.depth;

	}

	return Object.keys( out ).length > 0 ? out : null;

}

function textureNeedsUVFlip( texture ) {

	if ( ! texture ) return false;
	const image = texture.image || null;
	const imageBitmap = typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;
	return (
		( imageBitmap && texture.flipY === true ) ||
		texture.isRenderTargetTexture === true ||
		texture.isFramebufferTexture === true ||
		texture.isDepthTexture === true
	);

}

function createTextureUVFlipSource( texture, sampledSource ) {

	if ( ! texture ) return null;
	const textureUuid = sampledSource && typeof sampledSource.textureUuid === 'string' && sampledSource.textureUuid.length > 0
		? sampledSource.textureUuid
		: typeof texture.uuid === 'string' && texture.uuid.length > 0
			? texture.uuid
			: null;
	if ( textureUuid === null ) return null;
	const identity = textureIdentity( texture );
	return {
		kind: 'texture.uvFlipY',
		textureUuid,
		...( identity || {} ),
		valueSnapshot: {
			type: 'uint',
			data: textureNeedsUVFlip( texture ) ? 1 : 0,
		},
	};

}

function attachRenderTargetTextureSelector( source, texture ) {

	if ( ! source || ! texture || ! texture.renderTarget ) return source;
	// PMREM atlases are renderer-generated render-target textures, but their
	// durable replay identity is the environment/PMREM pipeline, not a generic
	// producer target. A selector would preempt the dedicated PMREM wiring and
	// can accidentally match another same-shaped transient atlas.
	if (
		source.kind === 'artifact.texture' &&
		( source.mapping === PMREM_CUBE_UV_MAPPING || source.textureName === 'PMREM.cubeUv' )
	) return source;
	const artifactTexture = source.kind === 'artifact.texture';
	const nonLightDepthTexture = source.kind === 'depth.texture'
		&& source.fromMaterialGraph === true
		&& source.lightUuid == null
		&& ( source.lightIndex === undefined || source.lightIndex < 0 );
	if ( ! artifactTexture && ! nonLightDepthTexture ) return source;
	try {

		// Passing the exact texture is the proof: the shared contract rejects a
		// stale `.renderTarget` back-reference unless the texture is still a
		// current color/depth attachment and records its exact role/index.
		return {
			...source,
			renderTargetSelector: createRendererRenderTargetTextureSelector(
				texture.renderTarget,
				{ texture },
			),
		};

	} catch ( _ ) {

		// A detached/replaced texture is not durable render-target evidence.
		return source;

	}

}

function reflectorBaseNodeIndex( state, baseNode ) {

	if ( ! baseNode || ! Array.isArray( state && state.updateBeforeNodes ) ) return -1;
	let reflectorIndex = 0;
	for ( const node of state.updateBeforeNodes ) {

		if ( ! node || ! node.constructor || node.constructor.type !== 'ReflectorBaseNode' ) continue;
		if ( node === baseNode ) return reflectorIndex;
		reflectorIndex ++;

	}
	return -1;

}

function canonicalViewportNode( node ) {

	const seen = new Set();
	let current = node;
	try {

		while ( current && current.referenceNode ) {

			if ( seen.has( current ) ) return null;
			seen.add( current );
			current = current.referenceNode;

		}

	} catch ( _ ) {

		return null;

	}
	return current || node;

}

function viewportSourceIdentity( textureNode ) {

	try {

		if ( ! textureNode || textureNode.constructor && textureNode.constructor.type === 'ViewportSharedTextureNode' ) return null;
		const sourceNode = canonicalViewportNode( textureNode );
		const liveReference = textureNode.value || textureNode._value || null;
		// A non-default framebuffer proves updateReference() observed a concrete
		// canvas/render-target reference during warm-up. Its UUID is persisted only
		// as an equivalence token; runtime never resolves that dead texture.
		if ( ! sourceNode || ! sourceNode.defaultFramebuffer || liveReference === sourceNode.defaultFramebuffer || liveReference && liveReference.isTexture !== true ) return null;
		return createViewportTextureIdentity( liveReference && liveReference.uuid );

	} catch ( _ ) {

		return null;

	}

}

function snapshotTexture( texture ) {

	const image = texture && texture.image;
	if ( ! image ) return null;

	const colorSpace = texture.colorSpace || '';
	const format = texture.format || null;
	const type = texture.type || null;
	const sampler = {
		mapping: texture.mapping,
		wrapS: texture.wrapS,
		wrapT: texture.wrapT,
		magFilter: texture.magFilter,
		minFilter: texture.minFilter,
		flipY: texture.flipY,
		generateMipmaps: texture.generateMipmaps,
	};

	if ( image.data && ArrayBuffer.isView( image.data ) && image.width && image.height ) {

		const data = image.data;
		if ( image.width * image.height > 262144 ) return null;
		return {
			width: image.width,
			height: image.height,
			arrayType: data.constructor && data.constructor.name || 'Uint8Array',
			data: Array.from( data ),
			format,
			type,
			colorSpace,
			...sampler,
		};

	}

	if ( typeof image.getContext === 'function' && image.width && image.height ) {

		if ( image.width * image.height > 262144 ) return null;
		try {

			const ctx = image.getContext( '2d' );
			if ( ! ctx || typeof ctx.getImageData !== 'function' ) return null;
			const imageData = ctx.getImageData( 0, 0, image.width, image.height );
			return {
				width: image.width,
				height: image.height,
				arrayType: 'Uint8Array',
				data: Array.from( imageData.data ),
				format,
				type,
				colorSpace,
				...sampler,
			};

		} catch ( _ ) {

			return null;

		}

	}

	return null;

}

/**
 * Extract a uniform plan from a built `NodeBuilderState`.
 *
 * @param {NodeBuilderState} state
 * @return {Array<Object>} One entry per bind group, in bind-order. Each
 *   entry has `{ name, shared, visibility, byteLength, slots, textures }`.
 *   Slots are per-uniform (UBO std140), textures are per-binding (sampled-
 *   textures and samplers). Either list can be empty.
 */
export function extractUniformPlan( state, context = null ) {

	if ( ! state || ! Array.isArray( state.bindings ) ) return [];

	// Build the light-uniform map FIRST — we want light sources to win over
	// the unnamed `uniform.live` fallback when both apply (a LightNode-owned
	// UniformNode is technically also reachable via `state.updateNodes` as a
	// bare UniformNode, but `resolveFromUpdateNode` returns null for it
	// because we strip the AnalyticLightNode container).
	const lightUniformSources = collectLightUniformSources( state );
	const shadowUniformSources = collectShadowUniformSources( state, context );
	const highPrecisionShadowModelMatrixSources = collectHighPrecisionShadowModelMatrixSources( state );
	const pointShadowCameraUniformSources = collectPointShadowCameraUniformSources( state );
	const objectUniformSources = collectObjectUniformSources( context && context.object || null );
	const pmremUniformSources = collectPMREMUniformSources( state );
	const {
		uniformSources: velocityUniformSources,
		valueSources: velocityValueSources,
	} = collectVelocityUniformSources( state );
	const harvestedVelocityProjectionSources = new Set(
		Array.isArray( context && context.velocityProjectionSources )
			? context.velocityProjectionSources
			: [],
	);

	// Walk updateNodes once, build two maps:
	//   - uniformNode → source (UBO slots)
	//   - textureNode → source (SampledTexture / Sampler bindings)
	const uniformNodeToSource = new Map();
	const textureNodeToSource = new Map();
	// WebGLNodeBuilder lowers TextureNode's backend-specific UV flip to an
	// anonymous uint UBO slot. That slot is encountered before its sampled
	// texture binding, so defer the precise source replacement until every
	// binding has resolved its live texture identity.
	const textureFlipUniformSources = new Map();
	// ScreenNode.setup() can replace its private `_output` UniformNode while a
	// nested node sub-build is compiling, but the replacement keeps Three's
	// renderer-owned Vector2/Vector4 value. Retain that exact value identity as
	// a narrow secondary key so the final state-local UBO still receives its
	// renderer.size / renderer.viewport provenance. Ambiguous shared values fail
	// closed to the ordinary uniform.live fallback.
	const screenValueToSource = new WeakMap();
	const ambiguousScreenValues = new WeakSet();

	// Seed the UBO map with every light-owned UniformNode found above.
	for ( const [ uniformNode, source ] of lightUniformSources ) {

		uniformNodeToSource.set( uniformNode, source );

	}

	// Seed shadow-driven UniformNodes (bias / normalBias / radius / intensity
	// / blurSamples / mapSize). These sit BEHIND `lightUniformSources` so a
	// genuine light-owned uniform always wins, but they MUST be applied
	// before the `resolveFromUpdateNode` walk so the bare `ReferenceNode`
	// classification (which would otherwise bail out and leave the slot as
	// `uniform.live`) doesn't run for these nodes.
	for ( const [ uniformNode, source ] of shadowUniformSources ) {

		if ( ! uniformNodeToSource.has( uniformNode ) ) {

			uniformNodeToSource.set( uniformNode, source );

		}

	}

	for ( const [ uniformNode, source ] of highPrecisionShadowModelMatrixSources ) {

		if ( ! uniformNodeToSource.has( uniformNode ) ) {

			uniformNodeToSource.set( uniformNode, source );

		}

	}

	for ( const [ uniformNode, source ] of pointShadowCameraUniformSources ) {

		if ( ! uniformNodeToSource.has( uniformNode ) ) {

			uniformNodeToSource.set( uniformNode, source );

		}

	}

	for ( const [ uniformNode, source ] of objectUniformSources ) {

		if ( ! uniformNodeToSource.has( uniformNode ) ) {

			uniformNodeToSource.set( uniformNode, source );

		}

	}

	for ( const [ uniformNode, source ] of pmremUniformSources ) {

		if ( ! uniformNodeToSource.has( uniformNode ) ) {

			uniformNodeToSource.set( uniformNode, source );

		}

	}

	for ( const [ uniformNode, source ] of velocityUniformSources ) {

		if ( ! uniformNodeToSource.has( uniformNode ) ) {

			uniformNodeToSource.set( uniformNode, source );

		}

	}

	for ( const node of state.updateNodes || [] ) {

		// WebGL may deduplicate several TextureNodes that share one Texture into
		// a single sampled binding. Seed every live TextureNode's private flip
		// uniform before that collapse; the representative binding below can
		// still refine the matching entry with its fully-resolved source.
		const flipTexture = node && node._flipYUniform ? node.value : null;
		if ( flipTexture && flipTexture.isTexture === true ) {

			const flipSource = createTextureUVFlipSource( flipTexture, null );
			if ( flipSource ) textureFlipUniformSources.set( node._flipYUniform, flipSource );

		}

		const entry = resolveFromUpdateNode( node, context );
		if ( ! entry || ! entry.uniformNode ) continue;

		// Don't overwrite a pre-seeded light or shadow source — bare
		// UniformNode classification returns `uniform.live` for unnamed
		// uniforms, which would clobber the precise `light.<prop>` /
		// `light.shadow<Prop>` mapping we just built.
		if ( lightUniformSources.has( entry.uniformNode ) ) continue;
		if ( shadowUniformSources.has( entry.uniformNode ) ) continue;
		if ( highPrecisionShadowModelMatrixSources.has( entry.uniformNode ) ) continue;
		if ( pointShadowCameraUniformSources.has( entry.uniformNode ) ) continue;
		if ( objectUniformSources.has( entry.uniformNode ) ) continue;
		if ( pmremUniformSources.has( entry.uniformNode ) ) continue;
		if ( velocityUniformSources.has( entry.uniformNode ) ) continue;

		if ( entry.source && ( entry.source.kind === 'renderer.size' || entry.source.kind === 'renderer.viewport' ) ) {

			const value = entry.uniformNode.value;
			if ( value && ( typeof value === 'object' || typeof value === 'function' ) ) {

				const previous = screenValueToSource.get( value );
				if ( previous && previous.kind !== entry.source.kind ) ambiguousScreenValues.add( value );
				else if ( ! previous ) screenValueToSource.set( value, entry.source );

			}

		}

		// MaterialReferenceNode with uniformType 'texture' binds its `node`
		// to a TextureNode rather than a plain UniformNode. Route it into
		// the texture map instead of the UBO map.
		const nodeType = entry.uniformNode.constructor && entry.uniformNode.constructor.type;
		if ( nodeType === 'TextureNode' || nodeType === 'CubeTextureNode' ) {

			textureNodeToSource.set( entry.uniformNode, entry.source );

		} else {

			uniformNodeToSource.set( entry.uniformNode, entry.source );

		}

	}

	// Second pass: for each textured material.<prop>, if the TextureNode has
	// lazily allocated a UV matrix uniform, tag that matrix slot so the
	// hydrator can push live `material.<prop>.matrix` every frame.
	for ( const [ textureNode, source ] of textureNodeToSource ) {

		if ( textureNode._matrixUniform && source.kind && source.kind.startsWith( 'material.' ) ) {

			uniformNodeToSource.set( textureNode._matrixUniform, {
				kind: source.kind + '.matrix',
				property: source.property,
				uniformType: 'mat3',
				...( source.bindingOwner ? { bindingOwner: source.bindingOwner } : {} )
			} );

		}

	}

	const plan = [];

	for ( const bindGroup of state.bindings ) {

		// Treat the first binding's groupNode as representative for the
		// group's shared-ness and visibility. This matches how the
		// existing backends set these flags.
		const firstBinding = bindGroup.bindings[ 0 ];
		const shared = firstBinding && firstBinding.groupNode ? firstBinding.groupNode.shared === true : false;
		const visibility = firstBinding ? ( firstBinding.visibility | 0 ) : 0;

		const groupEntry = {
			name: bindGroup.name || '',
			shared,
			visibility,
			byteLength: 0,
			// Flat per-type convenience lists — filled in below. Backward-
			// compatible with earlier plan consumers.
			slots: [],
			textures: [],
			storageBuffers: [],
			// Ordered list: each entry is one WGSL binding slot, in the
			// exact order the builder emitted. The hydrator walks THIS list
			// to preserve binding indices — without this the UBO could
			// collide with a storage buffer at @binding(0), producing
			// BufferBindingType mismatches at pipeline creation.
			orderedBindings: []
		};

		for ( const binding of bindGroup.bindings ) {

			if ( binding.isUniformsGroup ) {

				// Reading byteLength on UniformsGroup also materializes each
				// uniform's `offset` / `index`, so we must read it before we
				// iterate the slot list.
				const byteLength = binding.byteLength;
				if ( byteLength > groupEntry.byteLength ) groupEntry.byteLength = byteLength;

				const uboSlots = [];
				for ( const uniform of binding.uniforms ) {

					const dtype = uniformDtype( uniform );
					const tslUniformNode = uniform.nodeUniform ? uniform.nodeUniform.node : null;
					const value = tslUniformNode && tslUniformNode.value;
					const valueHasIdentity = value && ( typeof value === 'object' || typeof value === 'function' );
					// VelocityNode.setup() can name its anonymous projection
					// UniformNode `cameraProjectionMatrix`. Exact projection-object
					// identity is stronger evidence than that generic name: capture
					// must preserve TRAA/TAAU's unjittered current projection instead
					// of replaying the camera's jittered render projection.
					let source = valueHasIdentity
						? velocityValueSources.get( value ) || (
							isObservedVelocityProjectionSource( state, value ) || harvestedVelocityProjectionSources.has( value )
								? { kind: 'velocity.currentProjectionMatrix' }
								: null
						)
						: null;
					if ( ! source && tslUniformNode ) source = uniformNodeToSource.get( tslUniformNode ) || null;
					if ( ! source && valueHasIdentity && ! ambiguousScreenValues.has( value ) ) {

						source = screenValueToSource.get( value ) || null;

					}

					if ( ! source ) {

						// Fall back to a live read on the UniformNode's
						// `.value` each frame. `state.updateNodes` is
						// preserved side-car on the artifact so LightNode
						// / ShadowNode update() closures keep refreshing
						// those values — see hydrateArtifact.
						//
						// Serialisable snapshot kept too, so in offline
						// / cross-process flows the compile-time value is
						// at least correct as a fallback.
						source = tslUniformNode ?
							{ kind: 'uniform.live', valueSnapshot: snapshotUniformValue( uniform.getValue() ) } :
							{ kind: 'constant', valueSnapshot: snapshotUniformValue( uniform.getValue() ) };

					} else if ( source.valueSnapshot === undefined ) {

						// `uniformNodeToSource` sources come from
						// `resolveFromUpdateNode` and describe how to
						// live-read the value at runtime (material.color,
						// scene.fog.density, …). Decorate them with the
						// compile-time snapshot too so out-of-process
						// hydrators that can't evaluate the live update
						// closure still have the baked fallback —
						// critical for light directions / positions
						// written by LightNode.update().
						const snap = snapshotUniformValue( uniform.getValue() );
						if ( snap ) source = { ...source, valueSnapshot: snap };

					}

					const slot = {
						name: uniform.name || '',
						offset: uniform.offset * 4, // float-index → byte offset
						size: uniform.itemSize * 4, // float-count → byte count
						dtype,
						source
					};
					// Side-car to support `uniform.live` reads. Non-enumerable
					// so JSON.stringify skips it.
					if ( tslUniformNode ) {

						Object.defineProperty( slot, '_liveNode', { value: tslUniformNode, enumerable: false, writable: true } );
						Object.defineProperty( slot, '__tslpLiveSidecarOverlay', { value: true, enumerable: false, writable: true } );

					}

					groupEntry.slots.push( slot );
					uboSlots.push( slot );

				}

				groupEntry.orderedBindings.push( {
					type: 'ubo',
					name: binding.name || '',
					byteLength,
					visibility: binding.visibility | 0,
					slots: uboSlots
				} );

				continue;

			}

			if ( binding.isSampledTexture || binding.isSampler ) {

				const textureNode = binding.textureNode || null;
				const boundTexture = textureNode ? textureNode.value || textureNode._value || null : null;
				let source = textureNode ? textureNodeToSource.get( textureNode ) : null;

				// Enrich `material.<prop>` texture sources with the live
				// texture's identity (uuid + imageSrc + textureName + mapping
				// + flipY) and embed a snapshot when feasible. The hydrator's
				// `material.<prop>` path reads `material[prop]` live for user
				// mutation, but downstream cataloguers (apply-precompiled)
				// also use these hints to seed `_textureRefs` so the hydrator's
				// UUID lookup hits before falling back to a 1×1 white. Side
				// fields are ignored by the existing hydrator's
				// `material.<prop>` resolver — production behaviour unchanged.
				if ( source && typeof source.kind === 'string' && source.kind.startsWith( 'material.' ) && textureNode ) {

					const tex = textureNode.value || ( textureNode._value ) || null;
					if ( tex && tex.isTexture && tex.uuid ) {

						const enriched = { ...source, textureUuid: tex.uuid };
						const ident = textureIdentity( tex );
						if ( ident ) Object.assign( enriched, ident );
						const snap = snapshotTexture( tex );
						if ( snap ) enriched.snapshot = snap;
						source = enriched;

					}

				}

				// If we failed to resolve a source via updateNodes, try a few
				// fallbacks in order:
				//
				//   1. Well-known built-ins (DFG LUT for IBL) — identifiable
				//      by Texture.name. The slim runtime reconstructs these
				//      from shared data modules, no compile step needed.
				//
				//   2. Generic artifact-level textures — keyed by uuid and
				//      carried on `artifact._textureRefs`. Non-serialisable,
				//      but fine for single-process compile+hydrate flows.
				if ( ! source && textureNode ) {

					const tex = textureNode.value || ( textureNode._value ) || null;
					if ( tex && tex.isTexture ) {

						// Lazily-filled `{ lightIndex, lightUuid, vsm }` (or null) for shadow
						// textures — covers both raw `DepthTexture` shadow maps and VSM
						// blur-output RG render targets that aren't `DepthTexture` instances.
						let shadowLightInfo = undefined;

						if ( tex.name === 'DFG_LUT' ) {

							source = { kind: 'builtin.dfgLUT' };

						} else if ( textureNode && ( textureNode.isViewportTextureNode === true
							|| textureNode.isOutputTextureNode === true
							|| ( textureNode.constructor && (
								textureNode.constructor.type === 'ViewportTextureNode'
								|| textureNode.constructor.type === 'ViewportDepthTextureNode'
								|| textureNode.constructor.type === 'ViewportSharedTextureNode' ) ) ) ) {

							// Viewport texture nodes (both color and depth variants)
							// take precedence over the generic depth-texture branch
							// below because `ViewportDepthTextureNode` extends
							// `ViewportTextureNode` and exposes a `DepthTexture` as
							// its `.value`. Without this ordering, `viewportSafeUV`'s
							// depth probe is mis-tagged as `depth.texture`/`fromMaterialGraph`
							// and the hydrator's shadow rebinder fails to resolve it
							// (the depth lives on the shared viewport depth buffer,
							// not in the material graph), leaving the binding at the
							// 1×1 fallback and breaking refraction depth checks.
							const isSharedViewport = textureNode.constructor && textureNode.constructor.type === 'ViewportSharedTextureNode';
							const viewportIdentity = viewportSourceIdentity( textureNode );
							source = {
								kind: 'viewport.texture',
								...( viewportIdentity ? { viewportIdentity } : {} ),
								generateMipmaps: !! ( textureNode && textureNode.generateMipmaps ),
								isDepth: tex.isDepthTexture === true,
							};
							if ( isSharedViewport ) source.shared = true;

						} else if ( tex.isDepthTexture === true || ( shadowLightInfo = findLightForDepthTexture( state, tex, context ) ) ) {

							// Shadow depth textures live on `light.shadow.map.depthTexture`
							// (raw depth, PCF/Hard). Transmitted shadows also sample the regular
							// `light.shadow.map.texture` color attachment, while VSM samples the
							// shadow node's filtered moments target. The two color textures are
							// not DepthTexture instances, hence the explicit
							// `findLightForDepthTexture` fallback above. All three resources are
							// (re)allocated by the renderer's shadow pass, so their captured uuid
							// is dead after reload. Tag the binding with the owning light identity
							// and exact shadow attachment role instead.
							//
							// When no AnalyticLightNode owns this DepthTexture
							// (e.g. a `RenderTarget.depthTexture` sampled via
							// `texture(depthTexture)` in a user material), emit
							// `lightIndex: -1, fromMaterialGraph: true` — the
							// runtime rebinder then resolves the live instance
							// from the binding's owning material node graph.
							const lightInfo = shadowLightInfo !== undefined ? shadowLightInfo : findLightForDepthTexture( state, tex, context );
							const reflectorBaseNode = textureNode && textureNode.constructor
								&& textureNode.constructor.type === 'ReflectorNode'
								? textureNode._reflectorBaseNode || null
								: null;
							const reflectorIndex = reflectorBaseNodeIndex( state, reflectorBaseNode );
							source = lightInfo ? {
								kind: 'depth.texture',
								textureUuid: tex.uuid,
								...lightInfo,
								// `vsm` indicates a VSM blur-output texture (RG colour)
								// rather than a raw depth texture; the runtime resolves
								// the live VSM blur output instead of `shadow.map.depthTexture`.
								vsm: !! lightInfo.vsm,
								// `shadowMapColor` is the unfiltered color attachment used
								// by transmitted-shadow sampling. It must never fall through
								// to the VSM moments resolver.
								shadowMapColor: !! lightInfo.shadowMapColor,
							} : {
								kind: 'depth.texture',
								textureUuid: tex.uuid,
								lightIndex: -1,
								lightUuid: null,
								vsm: false,
								shadowMapColor: false,
								fromMaterialGraph: true,
								...( reflectorIndex >= 0 ? { reflectorIndex } : {} ),
							};

						} else if ( textureNode && textureNode.constructor && textureNode.constructor.type === 'ReflectorNode' ) {

							// TSL `reflector()` allocates a per-camera RenderTarget
							// inside `ReflectorBaseNode.updateBefore` and assigns
							// `textureNode.value = renderTarget.texture` each frame.
							// At capture time the value is the module-private
							// `_defaultRT.texture` — its uuid is dead the moment
							// the example reloads (and is shared across every
							// reflector globally). Tag the binding with the index
							// of the owning `ReflectorBaseNode` in
							// `state.updateBeforeNodes`; the runtime rebinder uses
							// that index to look up the live ReflectorBaseNode in
							// `artifact._liveUpdateBeforeNodes` and pull its
							// per-camera `renderTarget.texture` at draw time.
							const baseNode = textureNode._reflectorBaseNode || null;
							const reflectorIndex = reflectorBaseNodeIndex( state, baseNode );
							source = {
								kind: 'reflector.texture',
								textureUuid: tex.uuid,
								reflectorIndex,
							};
							if ( baseNode ) {

								if ( typeof baseNode.generateMipmaps === 'boolean' ) source.generateMipmaps = baseNode.generateMipmaps;
								if ( typeof baseNode.resolutionScale === 'number' ) source.resolutionScale = baseNode.resolutionScale;
								if ( typeof baseNode.samples === 'number' ) source.samples = baseNode.samples;
								if ( typeof baseNode.bounces === 'boolean' ) source.bounces = baseNode.bounces;
								if ( typeof baseNode.depth === 'boolean' ) source.depth = baseNode.depth;

							}

						} else if ( textureNode && ( textureNode.isViewportTextureNode === true
							|| textureNode.isOutputTextureNode === true
							|| ( textureNode.constructor && textureNode.constructor.type === 'ViewportTextureNode' ) ) ) {

							// `viewportMipTexture()` / `viewportOpaqueMipTexture()` /
							// `viewportTexture()` produce ViewportTextureNode instances
							// whose `.value` is a per-render-target FramebufferTexture
							// refreshed each frame via `renderer.copyFramebufferToTexture`.
							// KHR_materials_transmission glass samples this for
							// background refraction. The captured uuid is dead on
							// replay (a fresh FramebufferTexture is allocated each
							// run), and the framebuffer copy never runs without a
							// live ViewportTextureNode driving it — so the lamp
							// glass renders opaque/black. Tag the binding so the
							// runtime can drive a real ViewportTextureNode each
							// frame and rebind to its live FramebufferTexture.
							// Plain FramebufferTexture instances sampled by a
							// material graph (e.g. LensflareMesh temp/occlusion
							// maps) intentionally fall through to artifact.texture
							// so replay can bind that material's live texture rather
							// than copying the whole viewport over it.
							const viewportIdentity = viewportSourceIdentity( textureNode );
							source = {
								kind: 'viewport.texture',
								...( viewportIdentity ? { viewportIdentity } : {} ),
								generateMipmaps: !! ( textureNode && textureNode.generateMipmaps ),
							};

						} else {

							source = {
								kind: 'artifact.texture',
								textureUuid: tex.uuid
							};

							// Stable identifiers that survive a fresh Texture
							// instance on replay (same image.src, same name).
							// Production uses UUID match; harness/test paths
							// use these to relink a freshly-loaded texture.
							const ident = textureIdentity( tex );
							if ( ident ) Object.assign( source, ident );

							const snapshot = snapshotTexture( tex );
							if ( snapshot ) source.snapshot = snapshot;

						}

					}

					}

					source = attachRenderTargetTextureSelector( source, boundTexture );
					if ( binding.isSampledTexture === true && textureNode && textureNode._flipYUniform ) {

						const flipSource = createTextureUVFlipSource( boundTexture, source );
						if ( flipSource ) textureFlipUniformSources.set( textureNode._flipYUniform, flipSource );

					}

					const texEntry = {
					bindingKind: binding.isSampledTexture ? 'sampled-texture' : 'sampler',
					name: binding.name || '',
					textureType: classifyTextureBinding( binding ),
					access: binding.access || null,
					visibility: binding.visibility | 0,
					source: source || { kind: 'unsupported' }
				};
				if ( binding.isSampledTexture !== true ) texEntry.comparison = isComparisonSamplerBinding( binding );
				groupEntry.textures.push( texEntry );
				groupEntry.orderedBindings.push( {
					type: binding.isSampledTexture ? 'sampled-texture' : 'sampler',
					ref: texEntry
				} );
				continue;

			}

			// Storage buffers — backing data for compute shaders. Capture the
			// attribute's typed array, length, and access so the hydrator
			// can reconstruct an equivalent StorageBufferAttribute without
			// running the builder. The actual array bytes ride along in-
			// process; downstream serialisers can discard and re-seed if
			// they know the init kernel runs first at runtime.
			// Standalone uniform buffers (NodeUniformBuffer) — a single
			// named BufferNode mapped to a whole UBO, distinct from the
			// multi-uniform `UniformsGroup` path. FXAA + DoF + several
			// post-process shaders use these.
			if ( binding.isNodeUniformBuffer || ( binding.isUniformBuffer && ! binding.isUniformsGroup ) ) {

				const nodeUniform = binding.nodeUniform || null;
				const array = nodeUniform && nodeUniform.value && nodeUniform.value.buffer ? nodeUniform.value : null;
				const ubEntry = {
					name: binding.name || '',
					byteLength: array ? array.byteLength : ( binding.byteLength | 0 ),
					arrayType: array ? array.constructor.name : 'Float32Array',
					visibility: binding.visibility | 0
				};
				// Side-car live reference — the in-process hydrator shares
				// the same Float32Array, so any update-path that writes
				// into it (user code, a nodeUniform.update closure)
				// shows up on the GPU without extra wiring.
				if ( array ) {

					Object.defineProperty( ubEntry, '_liveArray', { value: array, enumerable: false, writable: true } );

					// Serialisable snapshot of the array contents so an
					// out-of-process hydrator (JSON-loaded artifact) can
					// seed the UBO with the same values. Typed arrays
					// round-trip as plain Arrays through JSON, which the
					// hydrator handles.
					ubEntry.valueSnapshot = Array.from( array );

				}

				if ( nodeUniform ) {

					Object.defineProperty( ubEntry, '_liveNode', { value: nodeUniform, enumerable: false, writable: true } );

				}

				groupEntry.orderedBindings.push( { type: 'buffer-uniform', ref: ubEntry } );

				continue;

			}

			if ( binding.isStorageBuffer ) {

				const attr = binding.attribute || null;
				const array = attr && attr.array ? attr.array : null;
				const arrayType = array ? array.constructor.name : 'Float32Array';
				const authoredAttributeName = binding.nodeUniform && typeof binding.nodeUniform.name === 'string' && binding.nodeUniform.name.length > 0
					? binding.nodeUniform.name
					: null;
				const authoredElementType = binding.nodeUniform && typeof binding.nodeUniform.bufferType === 'string' && binding.nodeUniform.bufferType.trim().length > 0
					? binding.nodeUniform.bufferType.trim()
					: null;

				const sbEntry = {
					name: binding.name || '',
					access: binding.access || 'read_write',
					// Visibility is a GPUShaderStage bitmask. The backend
					// reads it when building the BindGroupLayout — if we
					// don't propagate it the compute pipeline fails with
					// "entry-point's stage is not in the binding visibility
					// (ShaderStage::None)".
					visibility: binding.visibility | 0,
					arrayType,
					// Capture count + itemSize instead of full array for
					// hydrators that seed via an init kernel. Keep a live
					// reference on the plan for the in-process path so the
					// demo flow doesn't need separate serialisation.
					count: attr && typeof attr.count === 'number' ? attr.count : ( array ? array.length : 0 ),
					itemSize: attr && typeof attr.itemSize === 'number' ? attr.itemSize : 1,
					...( authoredAttributeName !== null || authoredElementType !== null ? {
						source: {
							kind: 'storage.buffer',
							...( authoredAttributeName !== null ? { attributeName: authoredAttributeName } : {} ),
							...( authoredElementType !== null ? { elementType: authoredElementType } : {} ),
						}
					} : {} )
				};
				// These process-local identities must never become artifact data.
				// Define them before the entry is nested into orderedBindings so
				// every serializer observes the same non-enumerable ownership seam.
				Object.defineProperties( sbEntry, {
					_liveArray: { value: array, enumerable: false, configurable: true, writable: true },
					_liveAttribute: { value: attr, enumerable: false, configurable: true, writable: true }
				} );
				groupEntry.storageBuffers.push( sbEntry );
				groupEntry.orderedBindings.push( { type: 'storage-buffer', ref: sbEntry } );

				continue;

			}

			// Unrecognised binding type. Record a placeholder entry so the
			// hydrator preserves the binding-index and the WGSL layout
			// validation in the backend doesn't choke. The placeholder
			// carries the `is*` flags so future hydrator work can
			// materialise the right binding kind.
			const flags = [];
			for ( const k of Object.keys( binding ) ) {

				if ( typeof binding[ k ] === 'boolean' && binding[ k ] && k.startsWith( 'is' ) ) flags.push( k );

			}

			groupEntry.orderedBindings.push( {
				type: 'unknown',
				name: binding.name || '',
				flags,
				visibility: binding.visibility | 0
			} );

		}

		plan.push( groupEntry );

	}

	for ( const group of plan ) {

		for ( const slot of group.slots ) {

			const source = textureFlipUniformSources.get( slot._liveNode );
			if ( source ) slot.source = source;

		}

	}

	annotateAnonymousStorageResourceIdentity( [ plan ] );
	return plan;

}

function anonymousStorageShapeKey( entry ) {

	const source = entry && entry.source;
	if ( source && typeof source.attributeName === 'string' && source.attributeName.trim().length > 0 ) return null;
	return JSON.stringify( [
		entry && entry.arrayType || '',
		entry && entry.count || 0,
		entry && entry.itemSize || 0,
		source && source.elementType || '',
	] );

}

function hasExactStorageUserPath( entry ) {

	return Array.isArray( entry && entry.userPath ) && entry.userPath.length > 0;

}

function clearAnonymousStorageResourceIdentity( entry ) {

	const source = entry && entry.source;
	if ( ! source || (
		source.anonymousResourceOrdinal === undefined
		&& source.anonymousResourceCount === undefined
	) ) return;
	const {
		anonymousResourceOrdinal: _staleOrdinal,
		anonymousResourceCount: _staleCount,
		...sourceWithoutIdentity
	} = source;
	entry.source = sourceWithoutIdentity;

}

/**
 * Preserve capture-time object identity for otherwise indistinguishable
 * anonymous storage resources. The ordinal is the relative rank of each exact
 * live attribute's monotonic BufferAttribute.id; repeated bindings of the same
 * attribute retain one ordinal. Replay may use this only when it observes the
 * complete signed resource cardinality and valid distinct construction IDs for
 * the same shape. Exact userPath resources are outside that cardinality: replay
 * resolves them before anonymous matching, so counting a path-only sibling
 * would make the remaining anonymous family impossible to satisfy. An identity
 * still participates when another entry aliases it without an exact path.
 */
export function annotateAnonymousStorageResourceIdentity( plans ) {

	const buckets = new Map();
	for ( const plan of plans || [] ) for ( const group of plan || [] ) for ( const entry of group && group.storageBuffers || [] ) {

		clearAnonymousStorageResourceIdentity( entry );
		if ( hasExactStorageUserPath( entry ) ) continue;
		const key = anonymousStorageShapeKey( entry );
		const identity = entry && entry._liveAttribute;
		if ( key === null || ! identity || ( typeof identity !== 'object' && typeof identity !== 'function' ) ) continue;
		let bucket = buckets.get( key );
		if ( ! bucket ) buckets.set( key, bucket = { entries: [], identities: new Set() } );
		bucket.identities.add( identity );
		bucket.entries.push( { entry, identity } );

	}
	for ( const bucket of buckets.values() ) {

		const count = bucket.identities.size;
		if ( count < 2 ) continue;
		const ranked = [ ...bucket.identities ].sort( ( left, right ) => left.id - right.id );
		if ( ranked.some( ( identity ) => ! Number.isSafeInteger( identity.id ) || identity.id < 0 ) ) continue;
		if ( new Set( ranked.map( ( identity ) => identity.id ) ).size !== count ) continue;
		const ordinalByIdentity = new Map( ranked.map( ( identity, ordinal ) => [ identity, ordinal ] ) );
		for ( const { entry, identity } of bucket.entries ) entry.source = {
			...( entry.source || {} ),
			kind: 'storage.buffer',
			anonymousResourceOrdinal: ordinalByIdentity.get( identity ),
			anonymousResourceCount: count,
		};

	}

}
