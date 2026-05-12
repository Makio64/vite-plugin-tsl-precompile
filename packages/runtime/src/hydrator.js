/**
 * Precompiled artifact → NodeBuilderState hydration.
 *
 * The slim bundle deletes `WGSLNodeBuilder` and short-circuits
 * `Nodes.js:getForRender` to call `hydrateNodeBuilderState` instead of
 * `this.backend.createNodeBuilder()`. This function produces a plain
 * object shaped like three.js's internal `NodeBuilderState` from a
 * precompiled artifact — enough for the renderer's pipeline dispatch
 * (`Pipelines.js`), render-object wiring (`RenderObject.js`), and the
 * per-frame update loop to find the fields they read off of it.
 *
 * Non-goals of this POC hydrator:
 *   - Full runtime parity with the TSL builder. Live-binding / shadow /
 *     complex-uniform paths that depend on the full binding class tree
 *     are deferred. This version returns empty bindings, empty update
 *     arrays, and a minimal observer, which is enough for static-material rendering but NOT for
 *     materials that need per-frame updates through the node system.
 *   - The UBO write path goes through `PrecompiledMaterial`'s generated
 *     updater instead — that's already wired via `apply-precompiled.js`.
 *
 * @module Hydrator
 */

import BindGroup from 'three/src/renderers/common/BindGroup.js';
import UniformBuffer from 'three/src/renderers/common/UniformBuffer.js';
import StorageBufferAttribute from 'three/src/renderers/common/StorageBufferAttribute.js';
import { DataTexture, Data3DTexture, DataArrayTexture, DepthTexture, CubeDepthTexture, CubeTexture, FramebufferTexture, RGBAFormat, DepthFormat, UnsignedByteType, UnsignedIntType, LessEqualCompare, LinearMipmapLinearFilter, WebGPUCoordinateSystem, Vector2, Vector3, Vector4, Matrix4, Matrix3, Plane, InstancedBufferAttribute } from 'three';
import { recordTextureResolutionStrategy, resolveArtifactTextureBinding } from './hydrate/artifact-texture-resolver.js';
import { resolveBuiltinTextureBinding } from './hydrate/builtin-textures.js';
import { installLiveTextureRegistryPatches, lookupAnonymousDataTexture, lookupAnonymousStorageTexture, lookupLiveTextureByIdentity } from './hydrate/live-texture-registry.js';
import { createRuntimeBindingFromKind } from './hydrate/kinds/runtime-binding-dispatcher.js';
import { lookupMaterialNodeTexture } from './hydrate/material-node-textures.js';
import { collectMaterialReflectorBaseNodes, createReflectorTextureRebinder, findReflectorBaseNodeInMaterial } from './hydrate/rebinders/reflector-texture-rebinder.js';
import { createShadowDepthRebinder } from './hydrate/rebinders/shadow-depth-rebinder.js';
import { createArtifactTextureRebinder, createMaterialTextureRebinder } from './hydrate/rebinders/texture-rebinders.js';
import { createViewportTextureRebinder, shouldSkipViewportCopyForZeroThicknessTransmission } from './hydrate/rebinders/viewport-texture-rebinder.js';
import { isTrivialSnapshot, textureFromSnapshot } from './hydrate/texture-snapshot.js';
import { resolveTypedArrayCtor } from './hydrate/typed-arrays.js';
import { findPlanTextureSource, inferTextureTypeFromShader, resolvePlanTextureTypeHint, selectFallbackTextureForBinding, shaderDeclaresDepthTexture, shaderDeclaresMultisampledTexture } from './hydrate/texture-resolver.js';

export { clearLiveTextureIndex, registerLiveTexture } from './hydrate/live-texture-registry.js';

const fallbackTexture = new DataTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1, RGBAFormat );
fallbackTexture.needsUpdate = true;

// Cube fallback: a six-face neutral grey cube. Supplied to texture_cube
// bindings whose live cubemap could not be resolved (e.g. capture-side
// uuids no longer match anything on replay). Without this fallback a
// pipeline that declares texture_cube<f32> ends up bound to a 2D fallback
// texture, the WebGPU validator silently rejects the bind group, and the
// draw is skipped — producing an empty canvas with no error surfaced.
function makeCubeFallback() {

	const faces = [];
	for ( let i = 0; i < 6; i ++ ) {

		const data = new Uint8Array( [ 128, 128, 128, 255 ] );
		const tex = new DataTexture( data, 1, 1, RGBAFormat );
		tex.needsUpdate = true;
		faces.push( tex.image );

	}
	const cube = new CubeTexture( faces );
	cube.format = RGBAFormat;
	cube.type = UnsignedByteType;
	cube.needsUpdate = true;
	return cube;

}
const fallbackCubeTexture = makeCubeFallback();
const fallback3DTexture = new Data3DTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1, 1 );
fallback3DTexture.format = RGBAFormat;
fallback3DTexture.type = UnsignedByteType;
fallback3DTexture.needsUpdate = true;
const fallbackArrayTexture = new DataArrayTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1, 1 );
fallbackArrayTexture.format = RGBAFormat;
fallbackArrayTexture.type = UnsignedByteType;
fallbackArrayTexture.needsUpdate = true;
const fallbackDepthTexture = new DepthTexture( 1, 1 );
fallbackDepthTexture.format = DepthFormat;
fallbackDepthTexture.type = UnsignedIntType;
fallbackDepthTexture.renderTarget = { samples: 1 };
const fallbackDepthArrayTexture = new DepthTexture( 1, 1, UnsignedIntType, undefined, undefined, undefined, undefined, undefined, undefined, DepthFormat, 1 );
fallbackDepthArrayTexture.format = DepthFormat;
fallbackDepthArrayTexture.type = UnsignedIntType;
fallbackDepthArrayTexture.isArrayTexture = true;
fallbackDepthArrayTexture.image.depth = 1;
fallbackDepthArrayTexture.renderTarget = { samples: 1 };
const fallbackComparisonDepthTexture = new DepthTexture( 1, 1 );
fallbackComparisonDepthTexture.format = DepthFormat;
fallbackComparisonDepthTexture.type = UnsignedIntType;
fallbackComparisonDepthTexture.compareFunction = LessEqualCompare;
fallbackComparisonDepthTexture.renderTarget = { samples: 1 };
const fallbackMultisampledDepthTexture = new DepthTexture( 1, 1 );
fallbackMultisampledDepthTexture.format = DepthFormat;
fallbackMultisampledDepthTexture.type = UnsignedIntType;
fallbackMultisampledDepthTexture.renderTarget = { samples: 4 };
const fallbackDepthCubeTexture = new CubeDepthTexture( 1 );
fallbackDepthCubeTexture.format = DepthFormat;
fallbackDepthCubeTexture.type = UnsignedIntType;
fallbackDepthCubeTexture.compareFunction = LessEqualCompare;
fallbackDepthCubeTexture.renderTarget = { samples: 1 };

// Per-binding 1×1 fallback for `viewport.texture` bindings. The live
// viewport texture is swapped in by `createViewportTextureRebinder` on the
// first render-before; this fallback only exists so WebGPU bind-group
// validation passes before that runs. Allocate fresh instances (rather than
// a module singleton) so that aux-bg / postprocess paths whose own viewport
// fallbacks are seeded by `wireViewportTextureRefs` aren't accidentally
// pointed at the same texture.
function makeViewportFallback( artifact, bindingName, source = null ) {

	const isDepth = source && source.isDepth === true ||
		( artifact && bindingName && shaderDeclaresDepthTexture( artifact, bindingName ) );
	if ( isDepth ) {

		const tex = new DepthTexture( 1, 1 );
		tex.format = DepthFormat;
		tex.type = UnsignedIntType;
		tex.renderTarget = { samples: 1 };
		tex.needsUpdate = true;
		return tex;

	}

	const tex = new FramebufferTexture( 1, 1 );
	tex.minFilter = LinearMipmapLinearFilter;
	tex.needsUpdate = true;
	return tex;

}

installLiveTextureRegistryPatches();

// Module-level scratch objects — reused per frame to avoid GC pressure.
const _rSize = new Vector2( 1, 1 );
const _rViewport = new Vector4( 0, 0, 1, 1 );
const _ovp = new Vector3();
const _odir = new Vector3();
const _mwi = new Matrix4();
const _m4rot = new Matrix4();
const _lvec = new Vector3();
const _lightMatchVec = new Vector3();
const _clipPlane = new Plane();
const _clipNormalMatrix = new Matrix3();

// Find the Nth light in a scene by traversal order. Mirrors the cache
// strategy emit-updater.js bakes into AOT modules — both the AOT and
// snapshot-based hydration paths use this as a fallback when a captured
// light UUID is unavailable.
//
// The cache key is the Scene instance; lights added/removed mid-session
// won't invalidate the cache. That's acceptable for now: scene-graph
// lighting changes are rare and the alternative (per-frame retraversal)
// would tax every UBO update for materials with many light-driven slots.
function getSceneLights( scene ) {

	if ( ! scene ) return [];
	let cache = scene._tslpLightCache;
	if ( ! cache || cache.scene !== scene ) {

		cache = { scene, lights: [] };
		scene._tslpLightCache = cache;
		if ( typeof scene.traverse === 'function' ) {

			scene.traverse( ( o ) => {

				if ( o && o.isLight === true ) cache.lights.push( o );

			} );

		}

	}
	return cache.lights;

}

function findLightInScene( scene, index ) {

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

function findLightBySnapshot( scene, source, frame = null ) {

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

function findLightBySource( scene, source, frame = null ) {

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

function recordLightLinkDiagnostic( event ) {

	try {

		const root = typeof globalThis !== 'undefined' ? globalThis : null;
		if ( ! root || root.__TSLP_DEBUG_LIGHT_LINKAGE !== true ) return;
		const diag = root.__tslpHarnessDiagnostics || ( root.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
		const list = diag.lightLinkage || ( diag.lightLinkage = [] );
		if ( list.length < 120 ) list.push( event );

	} catch ( _ ) {}

}

function recordShadowBindingDiagnostic( event ) {

	try {

		const root = typeof globalThis !== 'undefined' ? globalThis : null;
		if ( ! root || root.__TSLP_DEBUG_SHADOW_BINDINGS !== true ) return;
		const diag = root.__tslpHarnessDiagnostics || ( root.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
		const list = diag.shadowBindings || ( diag.shadowBindings = [] );
		if ( list.length < 500 ) list.push( event );

	} catch ( _ ) {}

}

function lightDiagnosticShape( light ) {

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
 * Produce a NodeBuilderState-compatible object for a precompiled material.
 *
 * @param {Object} artifact - The `precompiledArtifact` carried on the material.
 * @return {Object} A plain object with the fields `Pipelines.js` + `RenderObject.js` read.
 */
export function hydrateNodeBuilderState( artifact, material = null ) {

	if ( ! artifact ) {

		throw new Error( '[tsl-precompile/hydrator] artifact is required (material.isPrecompiledMaterial but material.precompiledArtifact is null)' );

	}

	// Bind live BufferAttributes from the user's `*Node` material props
	// (e.g. `material.positionNode = instancedBufferAttribute(buf)`) onto
	// the artifact's node-attribute entries before hydration walks them.
	// Idempotent and a no-op when capture didn't record `userPath` or the
	// material has no matching node tree yet.
	bindUserNodeAttributesToArtifact( artifact, material );
	// Same trick for compute-storage buffers wired through the user's
	// `material.colorNode = colors.element( instanceIndex )` etc. — the
	// kernel writes into `colors`, the render reads from the same buffer.
	bindUserStorageBuffersToArtifact( artifact, material );

	const { bindings, uniformBuffers, shadowDepthBindings, materialDepthBindings, artifactTextureBindings, materialTextureBindings, viewportTextureBindings, reflectorTextureBindings, clippingUniformBuffers } = hydrateRuntimeBindings( artifact, material );
	const updateNode = createUniformUpdateNode( artifact, uniformBuffers, material );
	const clippingUniformUpdateNode = clippingUniformBuffers.length > 0
		? createClippingUniformUpdateNode( clippingUniformBuffers, material )
		: null;
	const shadowRebinderDeps = {
		findLightBySource,
		recordDiagnostic: recordShadowBindingDiagnostic,
		describeLight: lightDiagnosticShape,
	};
	const shadowDepthRebinder = shadowDepthBindings.length > 0
		? createShadowDepthRebinder( shadowDepthBindings, shadowRebinderDeps )
		: null;
	const materialDepthRebinder = materialDepthBindings.length > 0
		? createShadowDepthRebinder( materialDepthBindings, shadowRebinderDeps )
		: null;
	const artifactTextureRebinder = artifactTextureBindings.length > 0
		? createArtifactTextureRebinder( artifactTextureBindings, { resolveTextureBinding } )
		: null;
	const materialTextureRebinder = materialTextureBindings.length > 0
		? createMaterialTextureRebinder( materialTextureBindings, { resolveTextureBinding } )
		: null;
	const viewportTextureRebinder = viewportTextureBindings.length > 0
		? createViewportTextureRebinder( viewportTextureBindings )
		: null;
	const reflectorTextureRebinder = reflectorTextureBindings.length > 0
		? createReflectorTextureRebinder( reflectorTextureBindings )
		: null;

	// In-process flows (dev-server capture → immediate render) carry live
	// update node instances as non-enumerable sidecars on the artifact. Include
	// them BEFORE the snapshot-based updater so LightNode.update() / ShadowNode
	// / onRenderUpdate closures write fresh values into _liveNode.value before
	// the snapshot writer reads them. In JSON-loaded flows these are absent and
	// the snapshot-only path is used instead.
	const liveUpdateNodes = Array.isArray( artifact._liveUpdateNodes ) ? artifact._liveUpdateNodes : [];
	const liveUpdateBeforeNodes = Array.isArray( artifact._liveUpdateBeforeNodes ) ? artifact._liveUpdateBeforeNodes : [];
	const liveUpdateAfterNodes = Array.isArray( artifact._liveUpdateAfterNodes ) ? artifact._liveUpdateAfterNodes : [];
	const materialReflectorUpdateBeforeNodes = collectMaterialReflectorBaseNodes( material )
		.filter( ( node ) => ! liveUpdateBeforeNodes.includes( node ) );

	const base = {
		vertexShader: String( artifact.vertexShader || '' ),
		fragmentShader: String( artifact.fragmentShader || '' ),
		computeShader: String( artifact.computeShader || '' ),
		transforms: artifact.transforms || [],
		nodeAttributes: hydrateNodeAttributes( artifact.nodeAttributes || artifact.attributes || [] ),
		bindings,
		updateNodes: [ ...liveUpdateNodes, ...( updateNode ? [ updateNode ] : [] ), ...( clippingUniformUpdateNode ? [ clippingUniformUpdateNode ] : [] ) ],
		// `shadowDepthRebinder` runs FIRST among updateBefore so the SampledTexture
		// bindings point at the live `light.shadow.map.depthTexture` before the
		// renderer reads bind-group versions for the upcoming draw.
		// `artifactTextureRebinder` follows: artifact.texture bindings may resolve
		// after first hydration (PMREM/environment maps, compute-written storage
		// textures, late loader identity matches). Bumping `groupNode.version` here
		// forces the renderer to rebuild the bind group with the fresh texture.
		updateBeforeNodes: [
			...( shadowDepthRebinder ? [ shadowDepthRebinder ] : [] ),
			...( artifactTextureRebinder ? [ artifactTextureRebinder ] : [] ),
			...( materialTextureRebinder ? [ materialTextureRebinder ] : [] ),
			// `viewportTextureRebinder` runs alongside the other rebinders so
			// transmissive materials (KHR_materials_transmission glass) sample
			// a freshly-copied framebuffer instead of the 1×1 fallback.
			...( viewportTextureRebinder ? [ viewportTextureRebinder ] : [] ),
			...liveUpdateBeforeNodes,
			...materialReflectorUpdateBeforeNodes,
			// Material-graph depth textures include reflector depth nodes. Those
			// are assigned by ReflectorBaseNode.updateBefore, so they must rebind
			// after live/material reflector update-before nodes have run.
			...( materialDepthRebinder ? [ materialDepthRebinder ] : [] ),
			// `reflectorTextureRebinder` runs LAST: the live ReflectorBaseNode
			// sidecar (or the replay-side material reflector list) keys its
			// per-camera RenderTarget during its own `updateBefore`; only
			// afterwards can we swap the binding to the live
			// `renderTarget.texture`.
			...( reflectorTextureRebinder ? [ reflectorTextureRebinder ] : [] ),
		],
		updateAfterNodes: [ ...liveUpdateAfterNodes ],
		observer: createStaticObserver(),
		usedTimes: 0,
		// Three.js's renderer/pipeline calls these methods across versions.
		// Each returns a structurally-correct default; in slim mode the
		// rendering paths that need richer semantics aren't exercised.
		// `createBindings()` is called per-renderObject by RenderObject.js;
		// for materials shared across many objects (e.g. 200 sprites all
		// using the same SpriteNodeMaterial) we MUST return per-call
		// instances of any non-shared UBO so each object writes its own
		// per-frame uniforms. Shared UBOs (render group: camera matrices)
		// keep the same instance.
		createBindings() {

			return cloneBindingsForObject( this.bindings, artifact, material );

		},
		getAttributesArray() {

			return this.nodeAttributes;

		},
		getBindings() {

			return this.bindings;

		},
		build() { /* no-op: artifact is already baked */ },
		buildAsync: async () => { /* no-op */ },
	};

	// Wrap in a Proxy that returns a no-op function for any OTHER method
	// lookup the renderer might do. Keeps forward-compatibility with
	// three.js version bumps without shape-gating every method name.
	return new Proxy( base, {
		get( target, prop ) {

			if ( prop in target ) return target[ prop ];
			// Unknown property: return a no-op function. Common for
			// renderer helpers that probe for optional methods.
			return () => undefined;

		},
	} );

}

/**
 * Walk `artifact.attributes` (or legacy `nodeAttributes`) and seed
 * `entry._liveAttribute` from the user material's TSL node graph.
 *
 * At capture time `compileTSL` records `userPath` (e.g. `["positionNode"]`)
 * for each node-sourced attribute — naming the property on the source
 * material whose node tree contains the attribute leaf. The
 * BufferAttribute reference itself is non-serialisable, so out-of-process
 * replay loses it. The user's JS still does `material.positionNode =
 * instancedBufferAttribute(buf)` on the wrapped material in the new
 * process; here we rewalk that node tree and bind the leaf attribute the
 * user just constructed. Without this the fallback below allocates a
 * zero-filled StorageBufferAttribute and every instance reads (0,0,0).
 *
 * Idempotent — skips entries that already carry a live attribute. Tolerates
 * missing/mistyped paths and node-shaped slim stubs (which lack `traverse`).
 *
 * @param {Object} artifact - Artifact to mutate.
 * @param {?Object} sourceMaterial - The wrapped PrecompiledMaterial whose
 *   `*Node` properties the user assigns after construction.
 */
function bindUserNodeAttributesToArtifact( artifact, sourceMaterial ) {

	if ( ! sourceMaterial ) return;
	const entries = Array.isArray( artifact.attributes )
		? artifact.attributes
		: Array.isArray( artifact.nodeAttributes ) ? artifact.nodeAttributes : null;
	if ( ! entries || entries.length === 0 ) return;

	let nodeRoots = null;
	const collectNodeRoots = () => {

		if ( nodeRoots ) return nodeRoots;
		nodeRoots = [];
		for ( const key in sourceMaterial ) {

			const v = sourceMaterial[ key ];
			if ( v && v.isNode === true ) nodeRoots.push( v );

		}
		return nodeRoots;

	};

	const sourceObject = sourceMaterial.__tslpPrecompileObject || null;

	for ( const entry of entries ) {

		if ( ! entry || entry.source !== 'node' ) continue;
		if ( entry._liveAttribute && entry._liveAttribute.isBufferAttribute === true ) continue;

		let live = null;
		const path = entry.userPath;
		if ( Array.isArray( path ) && path.length > 0 ) {

			const root = sourceMaterial[ path[ 0 ] ];
			if ( root && root.isNode === true ) live = findFirstAttributeMatchingEntry( root, entry );

		}

		if ( ! live ) {

			for ( const root of collectNodeRoots() ) {

				live = findFirstAttributeMatchingEntry( root, entry );
				if ( live ) break;

			}

		}

		if ( ! live ) live = findInstancedObjectAttributeMatchingEntry( sourceObject, entry, entries );
		if ( ! live ) continue;

		Object.defineProperty( entry, '_liveAttribute', {
			value: live,
			enumerable: false,
			configurable: true,
			writable: true,
		} );

	}

}

function findInstancedObjectAttributeMatchingEntry( object, entry, entries ) {

	if ( ! object || object.isInstancedMesh !== true ) return null;
	const count = object.count || 0;
	if ( ! count || entry.count !== count ) return null;
	const itemSize = entry.itemSize || itemSizeFromAttributeType( entry.type );

	if ( object.instanceColor && object.instanceColor.isBufferAttribute === true ) {

		const color = object.instanceColor;
		if ( itemSize === color.itemSize ) return color;

	}

	if ( itemSize !== 4 || ! object.instanceMatrix || ! object.instanceMatrix.array ) return null;

	const matrixEntries = entries.filter( ( candidate ) => {

		if ( ! candidate || candidate.source !== 'node' ) return false;
		if ( candidate.count !== count ) return false;
		const size = candidate.itemSize || itemSizeFromAttributeType( candidate.type );
		return size === 4;

	} );
	const column = matrixEntries.indexOf( entry );
	if ( column < 0 || column > 3 ) return null;

	return getInstancedMatrixColumnAttribute( object, column );

}

function getInstancedMatrixColumnAttribute( object, column ) {

	const source = object && object.instanceMatrix;
	const sourceArray = source && source.array;
	const count = object && object.count || 0;
	if ( ! sourceArray || ! count ) return null;

	const cacheKey = '__tslpMatrixColumnAttributes';
	let cache = object[ cacheKey ];
	if ( ! cache || cache.sourceArray !== sourceArray || cache.count !== count ) {

		cache = {
			sourceArray,
			count,
			attributes: [
				new InstancedBufferAttribute( new Float32Array( count * 4 ), 4 ),
				new InstancedBufferAttribute( new Float32Array( count * 4 ), 4 ),
				new InstancedBufferAttribute( new Float32Array( count * 4 ), 4 ),
				new InstancedBufferAttribute( new Float32Array( count * 4 ), 4 ),
			],
		};
		for ( const attribute of cache.attributes ) attribute.needsUpdate = true;
		try { Object.defineProperty( object, cacheKey, { value: cache, configurable: true } ); } catch ( _ ) { object[ cacheKey ] = cache; }

	}

	const attribute = cache.attributes[ column ];
	const dst = attribute && attribute.array;
	if ( ! dst ) return null;
	for ( let i = 0; i < count; i ++ ) {

		const srcOffset = i * 16 + column * 4;
		const dstOffset = i * 4;
		dst[ dstOffset + 0 ] = sourceArray[ srcOffset + 0 ];
		dst[ dstOffset + 1 ] = sourceArray[ srcOffset + 1 ];
		dst[ dstOffset + 2 ] = sourceArray[ srcOffset + 2 ];
		dst[ dstOffset + 3 ] = sourceArray[ srcOffset + 3 ];

	}
	attribute.needsUpdate = true;
	return attribute;

}

function findFirstAttributeMatchingEntry( node, entry ) {

	const wantSize = entry.itemSize || 0;
	const wantCount = entry.count || 0;
	const wantArray = entry.arrayType || '';

	let found = null;
	const probe = ( n ) => {

		if ( found || ! n ) return;
		const cands = [ n.attribute, n.value ];
		for ( const cand of cands ) {

			if ( ! cand || cand.isBufferAttribute !== true ) continue;
			// vec3 storage attributes get padded to itemSize=4 when WebGPU
			// touches them. Accept (3 → 4) so a freshly-built live attribute
			// matches an artifact entry recorded after the pad fired.
			if ( wantSize && cand.itemSize !== wantSize
				&& ! ( cand.itemSize === 3 && wantSize === 4 ) ) continue;
			if ( wantCount && cand.count !== wantCount ) continue;
			if ( wantArray
				&& cand.array
				&& cand.array.constructor
				&& cand.array.constructor.name !== wantArray ) continue;
			found = cand;
			return;

		}

	};

	probe( node );
	if ( ! found && typeof node.traverse === 'function' ) node.traverse( probe );
	return found;

}

/**
 * Walk every `storageBuffers[]` entry in `artifact.uniformPlan` and seed
 * `entry._liveAttribute` from the user material's TSL node graph.
 *
 * Compute kernels write into `instancedArray(...)` storage buffers; the
 * render side reads them via `material.colorNode = colors.element( i )`
 * (etc.) — same node-tree walk pattern as `bindUserNodeAttributesToArtifact`,
 * but matching against `StorageBufferNode.value` instead of
 * `BufferAttributeNode.attribute/value`. Without this the hydrator's
 * storage-buffer wiring at `createBindingFromDescriptor` allocates a fresh
 * empty `StorageBufferAttribute` and the compute output is invisible to
 * the render path.
 *
 * @param {Object} artifact
 * @param {?Object} sourceMaterial
 */
function bindUserStorageBuffersToArtifact( artifact, sourceMaterial ) {

	if ( ! sourceMaterial ) return;
	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : null;
	if ( ! plan || plan.length === 0 ) return;

	// Compute kernel storage buffers can be referenced from inside an Fn() body
	// assigned to any *Node slot. Capture writes `entry.userPath` based on the
	// node tree it walks, but Fn bodies that assign sibling material slots as a
	// side effect (e.g. cloth's `positionNode = Fn(() => { material.normalNode = ...; vertexPositionBuffer.element(...) })()`)
	// leave `userPath` pointing at the wrong slot, and some materials lose
	// `userPath` to `undefined` entirely. When the path-rooted lookup misses,
	// fall back to scanning every *Node property on the material.
	let nodeRoots = null;
	const collectNodeRoots = () => {

		if ( nodeRoots ) return nodeRoots;
		nodeRoots = [];
		for ( const key in sourceMaterial ) {

			const v = sourceMaterial[ key ];
			if ( v && v.isNode === true ) nodeRoots.push( v );

		}
		return nodeRoots;

	};

	for ( const group of plan ) {

		const entries = group && Array.isArray( group.storageBuffers ) ? group.storageBuffers : null;
		if ( ! entries || entries.length === 0 ) continue;
		for ( const entry of entries ) {

			if ( ! entry ) continue;
			if ( entry._liveAttribute
				&& entry._liveAttribute.array
				&& ArrayBuffer.isView( entry._liveAttribute.array ) ) continue;

			let live = null;
			const path = entry.userPath;
			if ( Array.isArray( path ) && path.length > 0 ) {

				const root = sourceMaterial[ path[ 0 ] ];
				if ( root && root.isNode === true ) {

					live = findFirstAttributeMatchingEntry( root, entry );

				}

			}

			if ( ! live ) {

				for ( const root of collectNodeRoots() ) {

					live = findFirstAttributeMatchingEntry( root, entry );
					if ( live ) break;

				}

			}

			if ( ! live ) continue;

			Object.defineProperty( entry, '_liveAttribute', {
				value: live,
				enumerable: false,
				configurable: true,
				writable: true,
			} );

		}

	}

}

function hydrateNodeAttributes( attributes ) {

	if ( ! Array.isArray( attributes ) ) return [];

	return attributes.map( ( attribute, i ) => {

		if ( ! attribute || attribute.source !== 'node' ) {
			return attribute;
		}

		const liveAttribute = attribute._liveAttribute || ( attribute.node && attribute.node.attribute );
		if ( liveAttribute ) return { ...attribute, node: { attribute: liveAttribute } };

		const itemSize = attribute.itemSize || itemSizeFromAttributeType( attribute.type );
		const count = Math.max( 1, attribute.count || 1 );
		const TypeArray = resolveTypedArrayCtor( attribute.arrayType );

		return {
			...attribute,
			node: {
				attribute: new StorageBufferAttribute( count, itemSize, TypeArray ),
			},
		};

	} );

}

function itemSizeFromAttributeType( type ) {

	switch ( type ) {

		case 'float':
		case 'number':
		case 'int':
		case 'uint':
			return 1;
		case 'vec2':
		case 'ivec2':
		case 'uvec2':
			return 2;
		case 'vec4':
		case 'ivec4':
		case 'uvec4':
			return 4;
		case 'vec3':
		case 'ivec3':
		case 'uvec3':
		default:
			return 3;

	}

}

/**
 * Per-renderObject bindings. Materials shared across many meshes (e.g.
 * 200 sprites all using the same SpriteNodeMaterial) need their own
 * per-object UBO instance so each frame each object writes its own
 * model/position/rotation values into a distinct GPU buffer; without
 * this, every object overwrites the previous one and only the LAST
 * draw's uniforms reach the GPU.
 *
 * Shared groups (the 'render' group with camera/time uniforms) keep the
 * same instance so the renderer uploads them once per frame.
 *
 * @param {Array<BindGroup>} bindings - The base bindings created at hydration time.
 * @param {Object} artifact
 * @param {?Material} material
 * @return {Array<BindGroup>}
 */
function cloneBindingsForObject( bindings, artifact, material ) {

	if ( ! Array.isArray( bindings ) || bindings.length === 0 ) return bindings;
	const out = [];
	for ( const bg of bindings ) {

		if ( ! bg ) { out.push( bg ); continue; }
		if ( isBindGroupShared( bg ) ) { out.push( bg ); continue; }
		const clonedBindings = ( bg.bindings || [] ).map( ( b ) => cloneBinding( b ) );
		const newGroup = new BindGroup( bg.name || '', clonedBindings );
		out.push( newGroup );

	}
	return out;

}

function isBindGroupShared( bg ) {

	const list = bg.bindings || [];
	for ( const b of list ) {

		if ( b && b.groupNode && b.groupNode.shared === true ) return true;

	}
	return false;

}

function cloneBinding( binding ) {

	if ( ! binding ) return binding;
	// UniformBuffer: clone the underlying Float32Array so each
	// per-object UBO has its own backing storage. Three.js's
	// `_bindings.updateForRender` copies bytes from this JS buffer
	// into the GPU buffer per-object; without the clone, every object
	// shares one Float32Array and the LAST writer wins.
	if ( binding.isUniformBuffer ) {

		const view = binding.buffer;
		const newBuffer = view ? new view.constructor( view ) : new Float32Array( 0 );
		const cloned = new UniformBuffer( binding.name, newBuffer );
		cloned.visibility = binding.visibility | 0;
		cloned.groupNode = { shared: false, version: 0 };
		if ( binding.__tslpLiveArrayResolver ) attachLiveUniformBufferUpdater( cloned, binding.__tslpLiveArrayResolver );
		return cloned;

	}
	// SampledTexture / Sampler / StorageBuffer share their resources
	// across objects (textures are global; storage buffers are
	// compute-shared). Reuse instances to keep the renderer's
	// resource cache hot.
	return binding;

}

function hydrateRuntimeBindings( artifact, material ) {

	const uniformBuffers = new Map();
	const shadowDepthBindings = [];
	const materialDepthBindings = [];
	const artifactTextureBindings = [];
	const materialTextureBindings = [];
	const viewportTextureBindings = [];
	const reflectorTextureBindings = [];
	const clippingUniformBuffers = [];
	const bindings = artifact.bindings;
	if ( ! Array.isArray( bindings ) ) return { bindings: [], uniformBuffers, shadowDepthBindings, materialDepthBindings, artifactTextureBindings, materialTextureBindings, viewportTextureBindings, reflectorTextureBindings, clippingUniformBuffers };
	const hasClippingUniformBuffers = artifactUsesClippingUniformBuffers( artifact );

	// Full three.js artifacts contain JSON descriptors. Rehydrate the subset
	// needed by WGSL pipeline layout creation and UBO uploads. Texture/storage
	// descriptors still need dedicated runtime registries, so leave them out
	// until those resources can be resolved safely.
	const groups = [];

	for ( const group of bindings ) {

		const runtimeBindings = [];
		const groupNode = {
			shared: findUniformGroupShared( artifact, group.name ),
			version: 0,
		};

		for ( const descriptor of group.bindings || [] ) {

			const runtimeBinding = createRuntimeBinding( artifact, group, descriptor, material, groupNode );
			if ( ! runtimeBinding ) continue;

			runtimeBindings.push( runtimeBinding );
			if ( runtimeBinding.isUniformBuffer ) uniformBuffers.set( descriptor.name || group.name || '', runtimeBinding );
			if ( hasClippingUniformBuffers && runtimeBinding.isUniformBuffer && /^UniformBuffer_/.test( descriptor.name || '' ) ) {

				clippingUniformBuffers.push( {
					binding: runtimeBinding,
					byteLength: runtimeBinding.buffer ? runtimeBinding.buffer.byteLength : descriptor.byteLength || 0,
					visibility: descriptor.visibility | 0,
				} );

			}

			// Track depth-texture bindings so the per-frame rebinder can swap
			// them to the live shadow map. The plan source carries `lightIndex`
			// and `vsm` flags; we resolve the actual texture at update time
			// because the renderer's shadow pass hasn't allocated it yet.
			const planSource = descriptor.kind === 'sampled-texture' || descriptor.kind === 'sampler'
				? findPlanTextureSource( artifact, group.name, descriptor.name )
				: null;
			if ( planSource && planSource.kind === 'depth.texture' ) {

				const depthBinding = {
					binding: runtimeBinding,
					artifact,
					bindingName: descriptor.name || '',
					lightIndex: Number.isInteger( planSource.lightIndex ) ? planSource.lightIndex : 0,
					lightUuid: typeof planSource.lightUuid === 'string' ? planSource.lightUuid : null,
					vsm: planSource.vsm === true,
					// Non-light depth textures (e.g. RenderTarget.depthTexture
					// sampled via `material.colorNode = texture(depthTexture)`)
					// have no owning AnalyticLightNode. The plan source signals
					// this with `lightIndex: -1, fromMaterialGraph: true`. The
					// rebinder resolves the live DepthTexture by walking the
					// owning material's node graph instead of `light.shadow.map`.
					fromMaterialGraph: planSource.fromMaterialGraph === true,
					textureUuid: typeof planSource.textureUuid === 'string' ? planSource.textureUuid : null,
					material,
				};
				recordShadowBindingDiagnostic( {
					phase: 'hydrateDepth',
					bindingName: depthBinding.bindingName,
					lightIndex: depthBinding.lightIndex,
					lightUuid: depthBinding.lightUuid,
					fromMaterialGraph: depthBinding.fromMaterialGraph,
					vsm: depthBinding.vsm,
					textureUuid: depthBinding.textureUuid,
					artifactName: artifact && artifact.name || material && material.name || null,
					bindingKind: descriptor.kind || null,
					textureType: descriptor.textureType || null,
				} );
				if ( depthBinding.fromMaterialGraph ) materialDepthBindings.push( depthBinding );
				else shadowDepthBindings.push( depthBinding );

			}

			// Artifact textures: tracked for late relinking and stale GPUTexture fixes.
			//
			// (a) Late-arriving live texture: hydration ran before a live texture was
			//     registered or generated (PMREM/environment maps, loader identity
			//     matches, compute storage textures), so binding.texture is a 1×1
			//     fallback. The rebinder re-resolves on each render-before and swaps to
			//     the real instance once available.
			//
			// (b) Stale GPUTexture under the same JS texture: the harness shares
			//     full's GPUTexture into slim's data map AFTER the bind group was
			//     built (`slimRenderer.backend.get(tex).texture =
			//     fullTexData.texture`). The rebinder bumps version + generation
			//     to force three.js to rebuild the view from the now-shared
			//     GPUTexture.
			if ( ( descriptor.kind === 'sampled-texture' || descriptor.kind === 'sampler' )
				&& ( runtimeBinding.isSampledTexture || runtimeBinding.isSampler )
				&& planSource && planSource.kind === 'artifact.texture' ) {

				const _planGroup = ( artifact.uniformPlan || [] ).find( ( g ) => g.name === group.name ) || {};
				const _planTex = ( _planGroup.textures || [] ).find( ( t ) => t.name === descriptor.name ) || {};
				artifactTextureBindings.push( {
					binding: runtimeBinding,
					artifact,
					groupName: group.name || '',
					bindingName: descriptor.name || '',
					source: planSource,
					textureType: _planTex.textureType || '2d',
					material,
				} );

			}

			if ( ( descriptor.kind === 'sampled-texture' || descriptor.kind === 'sampler' )
				&& ( runtimeBinding.isSampledTexture || runtimeBinding.isSampler )
				&& planSource && planSource.kind && planSource.kind.startsWith( 'material.' ) ) {

				materialTextureBindings.push( {
					binding: runtimeBinding,
					artifact,
					groupName: group.name || '',
					bindingName: descriptor.name || '',
					source: planSource,
					material,
				} );

			}

			// TSL `reflector()` bindings: each frame `ReflectorBaseNode.updateBefore`
			// renders the scene from a mirrored camera into a per-camera RT and
			// reassigns `textureNode.value`. The captured uuid points at the
			// module-private `_defaultRT.texture` and is dead at replay; the
			// artifact's `_liveUpdateBeforeNodes` sidecar is non-enumerable and
			// lost across the e2e capture→replay JSON boundary, so resolve the
			// live ReflectorBaseNode by walking the replay-side material's own
			// node graph — `reflector()` ran on the replay page when the user
			// HTML was imported, attaching a fresh ReflectorBaseNode to the
			// material. Each material in the failing examples carries a single
			// reflector, so the first ReflectorNode in the graph is correct;
			// `reflectorIndex` is reserved for future multi-reflector support.
			if ( ( descriptor.kind === 'sampled-texture' || descriptor.kind === 'sampler' )
				&& ( runtimeBinding.isSampledTexture || runtimeBinding.isSampler )
				&& planSource && planSource.kind === 'reflector.texture' ) {

				const baseNode = findReflectorBaseNodeInMaterial( material, planSource.reflectorIndex );
				if ( baseNode ) {

					reflectorTextureBindings.push( {
						binding: runtimeBinding,
						baseNode,
					} );

				}

			}

			// Viewport-texture bindings (transmission FBO etc.): captured WGSL
			// samples a `viewportMipTexture()` / `viewportTexture()` whose
			// FramebufferTexture is refreshed each frame. Track here so the
			// per-frame rebinder can drive the framebuffer copy and swap in
			// the live texture.
			if ( descriptor.kind === 'sampled-texture'
				&& runtimeBinding.isSampledTexture
				&& planSource && planSource.kind === 'viewport.texture' ) {

				viewportTextureBindings.push( {
					binding: runtimeBinding,
					fallbackTexture: runtimeBinding.texture,
					generateMipmaps: planSource.generateMipmaps !== false,
					isDepth: planSource.isDepth === true || shaderDeclaresDepthTexture( artifact, descriptor.name || '' ),
					material,
					skipZeroThicknessTransmission: shouldSkipViewportCopyForZeroThicknessTransmission( artifact ),
				} );

			}

		}

		if ( runtimeBindings.length > 0 ) groups.push( new BindGroup( group.name || '', runtimeBindings ) );

	}

	return { bindings: groups, uniformBuffers, shadowDepthBindings, materialDepthBindings, artifactTextureBindings, materialTextureBindings, viewportTextureBindings, reflectorTextureBindings, clippingUniformBuffers };

}

function createLiveUniformArrayResolver( bindingName, byteLength, material ) {

	if ( ! /^UniformBuffer_/.test( bindingName || '' ) ) return null;
	if ( ! material ) return null;
	return function resolveLiveUniformArray() {

		const object = material.__tslpPrecompileObject;
		if ( ! object ) return null;

		const skeleton = object.skeleton;
		const boneMatrices = skeleton && skeleton.boneMatrices;
		if ( boneMatrices && boneMatrices.byteLength === byteLength ) {

			if ( typeof skeleton.update === 'function' ) skeleton.update();
			return boneMatrices;

		}

		const instanceArray = object.instanceMatrix && object.instanceMatrix.array;
		if ( instanceArray && instanceArray.byteLength === byteLength ) return instanceArray;

		return null;

	};

}

function attachLiveUniformBufferUpdater( uniformBuffer, liveArrayResolver ) {

	if ( ! uniformBuffer || typeof liveArrayResolver !== 'function' ) return;
	Object.defineProperty( uniformBuffer, '__tslpLiveArrayResolver', {
		value: liveArrayResolver,
		configurable: true,
	} );
	uniformBuffer.update = function updateLiveUniformBuffer() {

		const liveArray = this.__tslpLiveArrayResolver && this.__tslpLiveArrayResolver();
		if ( liveArray && this.buffer && typeof this.buffer.set === 'function' ) {

			this.buffer.set( liveArray.subarray ? liveArray.subarray( 0, this.buffer.length ) : liveArray.slice( 0, this.buffer.length ) );

		}
		return true;

	};

}

function createRuntimeBinding( artifact, group, descriptor, material, groupNode ) {

	return createRuntimeBindingFromKind( {
		artifact,
		group,
		descriptor,
		material,
		groupNode,
		deps: {
			attachLiveUniformBufferUpdater,
			createLiveUniformArrayResolver,
			findUniformGroupByteLength,
			findUniformGroupRequiredByteLength,
			inferTextureTypeFromShader,
			resolvePlanBufferUniform,
			resolvePlanStorageBuffer,
			resolveTextureBinding,
			seedUniformBufferSnapshots,
		},
	} );

}

function seedUniformBufferSnapshots( artifact, groupName, bindingName, buffer ) {

	const group = findUniformGroup( artifact, groupName, bindingName );
	if ( ! group || ! Array.isArray( group.slots ) || group.slots.length === 0 ) return;

	const view = new DataView( buffer.buffer, buffer.byteOffset, buffer.byteLength );
	for ( const slot of group.slots ) {

		const source = slot.source || {};
		const snapshot = source.valueSnapshot || ( source.valueType ? { type: source.valueType, data: source.value } : null );
		if ( ! snapshot ) continue;
		writeSnapshot( view, slot.offset ?? slot.byteOffset ?? 0, snapshot );

	}

}

function applyTextureSourceSettings( texture, source ) {

	if ( ! texture || ! source ) return texture;
	if ( texture.isRenderTargetTexture === true || texture.isFramebufferTexture === true ) return texture;
	let changed = false;
	for ( const prop of [ 'mapping', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'anisotropy' ] ) {

		if ( typeof source[ prop ] === 'number' && texture[ prop ] !== source[ prop ] ) {

			texture[ prop ] = source[ prop ];
			changed = true;

		}

	}
	if ( typeof source.generateMipmaps === 'boolean' && texture.generateMipmaps !== source.generateMipmaps ) {

		texture.generateMipmaps = source.generateMipmaps;
		changed = true;

	}
	if ( typeof source.colorSpace === 'string' && texture.colorSpace !== source.colorSpace ) {

		texture.colorSpace = source.colorSpace;
		changed = true;

	}
	if ( typeof source.flipY === 'boolean' && texture.flipY !== source.flipY ) {

		texture.flipY = source.flipY;
		changed = true;

	}
	if ( changed ) texture.needsUpdate = true;
	return texture;

}

function textureResolutionDiagnosticDetails( source, textureEntry, textureTypeHint, resolvedTexture ) {

	const image = resolvedTexture && resolvedTexture.image || null;
	return {
		sourceKind: source && source.kind || null,
		textureUuid: source && source.textureUuid || null,
		textureName: source && source.textureName || null,
		imageSrc: source && source.imageSrc || null,
		planTextureType: textureEntry && textureEntry.textureType || null,
		textureTypeHint: textureTypeHint || null,
		resolvedTextureUuid: resolvedTexture && resolvedTexture.uuid || null,
		resolvedTextureName: resolvedTexture && resolvedTexture.name || null,
		resolvedTextureType: textureDiagnosticType( resolvedTexture ),
		resolvedTextureWidth: image && image.width || null,
		resolvedTextureHeight: image && image.height || null,
	};

}

function textureDiagnosticType( texture ) {

	if ( ! texture ) return null;
	if ( texture.isCubeTexture ) return 'cube';
	if ( texture.isData3DTexture || texture.is3DTexture ) return '3d';
	if ( texture.isDataArrayTexture || texture.isArrayTexture ) return '2d-array';
	if ( texture.isDepthTexture ) return 'depth';
	if ( texture.isRenderTargetTexture ) return 'render-target';
	if ( texture.isStorageTexture ) return 'storage';
	return texture.isTexture ? '2d' : null;

}

function resolveTextureBinding( artifact, groupName, bindingName, material, options = null ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const group = plan.find( ( item ) => item.name === groupName );
	const texture = group && ( group.textures || [] ).find( ( item ) => item.name === bindingName );
	const source = texture && texture.source || {};
	const textureTypeHint = resolvePlanTextureTypeHint( artifact, group, texture, source, bindingName );

	// Shadow depth textures: extractor tags these with `kind: 'depth.texture'`
	// and a `lightIndex` for the owning AnalyticLightNode. We can't resolve
	// the live `light.shadow.map.depthTexture` here because the renderer
	// hasn't allocated the shadow map yet at hydration time — the per-frame
	// rebinder (registerShadowDepthRebinder, below) swaps it in at draw time.
	// Return the matching fallback so the bind group is still validatable.
	if ( source.kind === 'depth.texture' ) {
		return fallbackTextureForBinding( artifact, bindingName );

	}

	const builtinTexture = resolveBuiltinTextureBinding( { artifact, source, bindingName, fallbackTextureForBinding } );
	if ( builtinTexture !== undefined ) return builtinTexture;

	if ( source.kind && source.kind.startsWith( 'material.' ) ) {

		const property = source.property || source.kind.split( '.' )[ 1 ];
		return material && material[ property ] || fallbackTextureForBinding( artifact, bindingName );

	}

	// Viewport-texture bindings (transmission FBO etc.): the live
	// FramebufferTexture is swapped in by `createViewportTextureRebinder`
	// per render. Return a 1×1 FramebufferTexture so the WebGPU bind-group
	// layout validates on the first frame (before updateBefore runs).
	if ( source.kind === 'viewport.texture' ) {

		return makeViewportFallback( artifact, bindingName, source );

	}

	// artifact.texture: resolve by UUID first (production path — same Texture
	// instance is used). Fall back to imageSrc/textureName matching against a
	// runtime-registered texture index so harness/test paths that re-create
	// Texture instances on each load can still relink. Snapshot data is the
	// last resort.
	if ( source.kind === 'artifact.texture' && source.textureUuid ) {

		const result = resolveArtifactTextureBinding( {
			artifact,
			groupName,
			bindingName,
			material,
			options,
			textureEntry: texture,
			source,
			textureTypeHint,
			deps: {
				applyTextureSourceSettings,
				fallbackDepthTexture,
				fallbackMultisampledDepthTexture,
				isTrivialSnapshot,
				lookupAnonymousDataTexture,
				lookupAnonymousStorageTexture,
				lookupLiveTextureByIdentity,
				lookupMaterialNodeTexture,
				textureFromSnapshot: ( snapshotArtifact, uuid, snapshot, snapshotBindingName, snapshotTextureTypeHint ) => textureFromSnapshot(
					snapshotArtifact,
					uuid,
					snapshot,
					snapshotBindingName,
					snapshotTextureTypeHint,
					{ fallbackTexture, fallbackTextureForBinding }
				),
			},
		} );
		if ( result ) {

			recordTextureResolutionStrategy(
				artifact,
				groupName,
				bindingName,
				result.strategy,
				textureResolutionDiagnosticDetails( source, texture, textureTypeHint, result.texture )
			);
			return result.texture;

		}
		const shaderFallbackTexture = fallbackTextureForBinding( artifact, bindingName );
		recordTextureResolutionStrategy(
			artifact,
			groupName,
			bindingName,
			'shader-fallback',
			textureResolutionDiagnosticDetails( source, texture, textureTypeHint, shaderFallbackTexture )
		);
		return shaderFallbackTexture;

	}

	return fallbackTextureForBinding( artifact, bindingName );

}

function artifactUsesClippingUniformBuffers( artifact ) {

	const wgsl = `${ artifact && artifact.vertexShader || '' }\n${ artifact && artifact.fragmentShader || '' }`;
	return /\bclip_distances\b|\bhw_clip_distances\b|\bclipped\b|\bclipOpacity\b|\bdistanceToPlane\b/.test( wgsl );

}

function fallbackTextureForBinding( artifact, bindingName ) {

	return selectFallbackTextureForBinding( artifact, bindingName, {
		texture: fallbackTexture,
		comparisonDepth: fallbackComparisonDepthTexture,
		depth: fallbackDepthTexture,
		depthCube: fallbackDepthCubeTexture,
		depthArray: fallbackDepthArrayTexture,
		multisampledDepth: fallbackMultisampledDepthTexture,
		cube: fallbackCubeTexture,
		texture3D: fallback3DTexture,
		array: fallbackArrayTexture,
	} );

}

function findUniformGroup( artifact, groupName, bindingName ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	return plan.find( ( group ) => group.name === groupName || group.name === bindingName ) || null;

}

function findUniformGroupByteLength( artifact, groupName, bindingName ) {

	const group = findUniformGroup( artifact, groupName, bindingName );
	return group && group.byteLength || 16;

}

function findUniformGroupRequiredByteLength( artifact, groupName, bindingName ) {

	const group = findUniformGroup( artifact, groupName, bindingName );
	if ( ! group || ! Array.isArray( group.slots ) ) return 16;
	let byteLength = group.byteLength || 16;
	for ( const slot of group.slots ) {

		const offset = slot.offset ?? slot.byteOffset ?? 0;
		const source = slot.source || {};
		const snapshot = source.valueSnapshot || ( source.valueType ? { type: source.valueType, data: source.value } : null );
		const snapshotSize = snapshot && Array.isArray( snapshot.data ) ? snapshot.data.length * 4 : 0;
		const slotSize = slot.byteLength || snapshotSize || uniformSlotByteLength( slot.type || slot.valueType || source.valueType );
		byteLength = Math.max( byteLength, offset + slotSize );

	}
	return Math.ceil( byteLength / 16 ) * 16;

}

function uniformSlotByteLength( type ) {

	switch ( type ) {

		case 'float':
		case 'int':
		case 'uint':
		case 'bool':
			return 4;
		case 'vec2':
			return 8;
		case 'vec3':
		case 'vec4':
			return 16;
		case 'mat3':
			return 48;
		case 'mat4':
			return 64;
		default:
			return 64;

	}

}

/**
 * Locate a storage-buffer plan entry by group and binding name.
 *
 * @param {Object} artifact
 * @param {string} groupName
 * @param {string} bindingName
 * @return {?Object}
 */
function resolvePlanStorageBuffer( artifact, groupName, bindingName ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const group = plan.find( ( g ) => g.name === groupName );
	if ( ! group ) return null;

	// storageBuffers list on the group entry
	const sbList = group.storageBuffers || [];
	const sb = sbList.find( ( s ) => s.name === bindingName );
	if ( sb ) return sb;

	// Also search orderedBindings in case only that list was serialised
	for ( const ob of group.orderedBindings || [] ) {

		if ( ob.type === 'storage-buffer' && ob.ref && ob.ref.name === bindingName ) return ob.ref;

	}

	return null;

}

/**
 * Locate a NodeUniformBuffer (buffer-uniform) plan entry by group and name.
 * These are flat UBOs used by post-process shaders (FXAA, DoF, etc.) —
 * they carry a valueSnapshot of the full typed array at capture time.
 *
 * @param {Object} artifact
 * @param {string} groupName
 * @param {string} bindingName
 * @return {?Object}
 */
function resolvePlanBufferUniform( artifact, groupName, bindingName ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const group = plan.find( ( g ) => g.name === groupName || g.name === bindingName );
	if ( ! group ) return null;

	for ( const ob of group.orderedBindings || [] ) {

		if ( ob.type === 'buffer-uniform' && ob.ref && ( ob.ref.name === bindingName || ob.ref.name === groupName ) ) return ob.ref;

	}

	return null;

}

function findUniformGroupShared( artifact, groupName, bindingName ) {

	const group = findUniformGroup( artifact, groupName, bindingName );
	return !! ( group && group.shared );

}

function collectClippingGroupsForObject( object, shadowPass = false ) {

	const groups = [];
	let cursor = object && object.parent || null;
	while ( cursor ) {

		if ( cursor.isClippingGroup === true && cursor.enabled !== false && ( ! shadowPass || cursor.clipShadows === true ) ) groups.unshift( cursor );
		cursor = cursor.parent || null;

	}
	return groups;

}

function projectClippingPlanes( planes, camera ) {

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

function clippingPlaneSetsForFrame( frame, material ) {

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

function selectClippingPlaneArray( entry, sets ) {

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

function createClippingUniformUpdateNode( entries, material ) {

	return {
		getUpdateType() {

			return 'object';

		},
		updateReference() {

			return this;

		},
		update( frame ) {

			const sets = clippingPlaneSetsForFrame( frame, frame && frame.material || material );
			for ( const entry of entries ) {

				const binding = entry && entry.binding;
				if ( ! binding || ! binding.buffer || typeof binding.buffer.fill !== 'function' ) continue;
				const values = selectClippingPlaneArray( entry, sets );
				binding.buffer.fill( 0 );
				if ( values ) binding.buffer.set( values.subarray ? values.subarray( 0, binding.buffer.length ) : values.slice( 0, binding.buffer.length ) );
				if ( binding.groupNode ) binding.groupNode.version ++;

			}

		},
	};

}

function createUniformUpdateNode( artifact, uniformBuffers, material ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	if ( plan.length === 0 || uniformBuffers.size === 0 ) return null;
	const generatedUpdateGroup = typeof artifact._generatedUpdateGroup === 'function' ? artifact._generatedUpdateGroup : null;

	return {
		getUpdateType() {

			return 'object';

		},
		updateReference() {

			return this;

		},
		update( frame ) {

			const frameMaterial = frame.material || material || null;
			for ( const group of plan ) {

				const binding = uniformBuffers.get( group.name );
				if ( ! binding ) continue;

				const view = new DataView( binding.buffer.buffer, binding.buffer.byteOffset, binding.buffer.byteLength );
				if ( generatedUpdateGroup ) generatedUpdateGroup( frame, frameMaterial, view, 0, group.name || '' );
				else writeUniformGroup( group, frame, view, frameMaterial );
				binding.groupNode.version ++;

			}

		},
	};

}

function writeUniformGroup( group, frame, view, material ) {

	for ( const slot of group.slots || [] ) {

		const source = slot.source || {};
		const offset = slot.offset ?? slot.byteOffset ?? 0;
		const kind = source.kind || 'unknown';

		if ( kind === 'camera.projectionMatrix' ) writeMat4( view, offset, frame.camera && frame.camera.projectionMatrix, source.valueSnapshot );
		else if ( kind === 'camera.projectionMatrixInverse' ) writeMat4( view, offset, frame.camera && frame.camera.projectionMatrixInverse, source.valueSnapshot );
		else if ( kind === 'camera.viewMatrix' ) writeMat4( view, offset, frame.camera && frame.camera.matrixWorldInverse, source.valueSnapshot );
		else if ( kind === 'camera.worldMatrix' ) writeMat4( view, offset, frame.camera && frame.camera.matrixWorld, source.valueSnapshot );
		else if ( kind === 'camera.position' ) writeVec3( view, offset, frame.camera && frame.camera.position, source.valueSnapshot );
		else if ( kind === 'camera.near' ) writeNumber( view, offset, frame.camera && frame.camera.near, source.valueSnapshot );
		else if ( kind === 'camera.far' ) writeNumber( view, offset, frame.camera && frame.camera.far, source.valueSnapshot );
			else if ( kind === 'frame.time' ) writeNumber( view, offset, frame.time, source.valueSnapshot );
		else if ( kind === 'frame.deltaTime' ) writeNumber( view, offset, frame.deltaTime, source.valueSnapshot );
		else if ( kind === 'frame.frameId' ) writeUint( view, offset, frame.frameId, source.valueSnapshot );
		else if ( kind === 'object.worldMatrix' || kind === 'object3d.worldMatrix' ) writeMat4( view, offset, frame.object && frame.object.matrixWorld, source.valueSnapshot );
		else if ( kind === 'object.worldMatrixInverse' ) {

			if ( frame.object ) { _mwi.copy( frame.object.matrixWorld ).invert(); writeMat4( view, offset, _mwi ); }
			else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'object.normalMatrix' || kind === 'object3d.normalMatrix' ) {

			if ( frame.object && frame.object.normalMatrix && frame.object.matrixWorld ) {
				frame.object.normalMatrix.getNormalMatrix( frame.object.matrixWorld );
				writeMat3( view, offset, frame.object.normalMatrix );
			} else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'object.modelViewMatrix' || kind === 'object3d.modelViewMatrix' ) {

			if ( frame.object && frame.object.modelViewMatrix && frame.object.matrixWorld && frame.camera && frame.camera.matrixWorldInverse ) {
				frame.object.modelViewMatrix.multiplyMatrices( frame.camera.matrixWorldInverse, frame.object.matrixWorld );
				writeMat4( view, offset, frame.object.modelViewMatrix );
			} else writeSnapshot( view, offset, source.valueSnapshot );

		}
		else if ( kind === 'object.position' || kind === 'object3d.position' ) writeVec3( view, offset, frame.object && frame.object.position, source.valueSnapshot );
		else if ( kind === 'object.scale' || kind === 'object3d.scale' ) writeVec3( view, offset, frame.object && frame.object.scale, source.valueSnapshot );
		else if ( kind === 'object3d.viewPosition' ) {

			if ( frame.object && frame.camera ) {

				_ovp.setFromMatrixPosition( frame.object.matrixWorld ).applyMatrix4( frame.camera.matrixWorldInverse );
				writeVec3( view, offset, _ovp );

			} else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'object3d.direction' ) {

			if ( frame.object ) { frame.object.getWorldDirection( _odir ); writeVec3( view, offset, _odir ); }
			else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'object3d.userData' ) {

			// Per-draw read: `frame.object.userData[property]`.
			// Supports float/int/uint today (scalars are the vast majority
			// of userData-driven uniforms — e.g. sprite rotation, opacity).
			const udProp = source.property;
			const udType = source.uniformType || 'float';
			const udRaw = ( frame.object && udProp != null && frame.object.userData != null )
				? frame.object.userData[ udProp ]
				: undefined;
			if ( udType === 'int' || udType === 'i32' ) writeInt( view, offset, Number.isFinite( udRaw ) ? udRaw : null, source.valueSnapshot );
			else if ( udType === 'uint' || udType === 'u32' ) writeUint( view, offset, Number.isFinite( udRaw ) ? udRaw : null, source.valueSnapshot );
			else writeNumber( view, offset, Number.isFinite( udRaw ) ? udRaw : null, source.valueSnapshot );

		} else if ( kind === 'object3d.radius' ) {

			const geom = frame.object && frame.object.geometry;
			const radius = geom && geom.boundingSphere ? geom.boundingSphere.radius : null;
			writeNumber( view, offset, radius, source.valueSnapshot );

		} else if ( kind === 'renderer.dpr' ) {

			writeNumber( view, offset, frame.renderer ? frame.renderer.getPixelRatio() : null, source.valueSnapshot );

		} else if ( kind === 'renderer.size' ) {

			if ( frame.renderer ) { frame.renderer.getDrawingBufferSize( _rSize ); writeVec2( view, offset, _rSize ); }
			else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'renderer.halfHeight' ) {

			if ( frame.renderer ) { frame.renderer.getSize( _rSize ); writeNumber( view, offset, 0.5 * _rSize.y, source.valueSnapshot ); }
			else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'renderer.viewport' ) {

			if ( frame.renderer ) { frame.renderer.getViewport( _rViewport ); writeVec4( view, offset, _rViewport ); }
			else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'renderer.toneMappingExposure' ) {

			view.setFloat32( offset, frame.renderer ? frame.renderer.toneMappingExposure : ( source.valueSnapshot ? Number( source.valueSnapshot.data ) : 1 ), true );

		}
		else if ( kind.startsWith( 'material.' ) ) writeMaterialValue( view, offset, frame.material || material, source, kind, slot.dtype );
		else if ( kind === 'scene.fog.color' ) writeColor( view, offset, frame.scene && frame.scene.fog && frame.scene.fog.color, source.valueSnapshot );
		else if ( kind === 'scene.fog.near' || kind === 'scene.fog.far' || kind === 'scene.fog.density' ) {

			const property = source.property || kind.split( '.' )[ 2 ];
			writeNumber( view, offset, frame.scene && frame.scene.fog && frame.scene.fog[ property ], source.valueSnapshot );

		} else if ( kind === 'scene.environmentIntensity' || kind === 'scene.backgroundIntensity' || kind === 'scene.backgroundBlurriness' ) {

			const property = source.property || kind.split( '.' )[ 1 ];
			writeNumber( view, offset, frame.scene && frame.scene[ property ], source.valueSnapshot );

		} else if ( kind === 'scene.backgroundRotation' ) {

			// Three.js's `backgroundRotation` TSL is a Matrix4 derived from
			// scene.backgroundRotation (Euler) — only emitted when the
			// background is a textured cube/equirect map. Mirror three.js's
			// SceneProperties: rotate-from-euler then transpose. Skip for
			// non-rotated scenes (Euler is zero) by writing identity.
			if ( frame.scene && frame.scene.backgroundRotation && frame.scene.background && frame.scene.background.isTexture === true ) {

				_mwi.makeRotationFromEuler( frame.scene.backgroundRotation ).transpose();
				writeMat4( view, offset, _mwi );

			} else writeMat4( view, offset, null, source.valueSnapshot );

		} else if ( kind && kind.startsWith( 'light.' ) ) {

			writeLightValue( view, offset, kind, source, frame );

		} else if ( kind === 'constant' || kind === 'uniform.constant' ) {

			writeSnapshot( view, offset, source.valueSnapshot || { type: source.valueType, data: source.value } );

		} else if ( kind === 'uniform.live' ) {

			// Prefer the live node's current value (updated by _liveUpdateNodes
			// that ran earlier this frame). Fall back to the compile-time snapshot
			// when no live node is available (JSON-loaded artifacts).
			const shadowMatrixLight = slot.dtype === 'mat4' ? findShadowMatrixLightForSlot( group, slot, frame ) : null;
			if ( shadowMatrixLight && shadowMatrixLight.shadow && shadowMatrixLight.shadow.matrix ) {

				updateLightShadowMatrixForFrame( shadowMatrixLight, frame );
				writeMat4( view, offset, shadowMatrixLight.shadow.matrix );

			} else if ( slot._liveNode && slot._liveNode.value !== null && slot._liveNode.value !== undefined ) {

				writeLiveValue( view, offset, slot._liveNode.value, slot.dtype );

			} else {

				writeSnapshot( view, offset, source.valueSnapshot || { type: source.valueType, data: source.value } );

			}

		}

	}

}

function findShadowMatrixLightForSlot( group, slot, frame ) {

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

function updateLightShadowMatrixForFrame( light, frame ) {

	if ( ! light || ! light.shadow || typeof light.shadow.updateMatrices !== 'function' ) return;
	if ( light.shadow.map && light.shadow.matrix ) return;
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

function writeMaterialValue( view, offset, material, source, kind, dtype ) {

	const property = source.property || kind.split( '.' )[ 1 ];
	const materialValue = material && material[ property ];
	let value;
	if ( kind.endsWith( '.matrix' ) && materialValue ) {

		// Mirror three.js's TextureNode.update(): refresh texture.matrix from
		// the live repeat/offset/rotation/center each frame. Without this the
		// matrix stays at the constructor-set identity and any
		// `texture.repeat.set(...)` the user wired up has no GPU-visible effect.
		if ( materialValue.matrixAutoUpdate === true && typeof materialValue.updateMatrix === 'function' ) materialValue.updateMatrix();
		value = materialValue.matrix;

	} else {

		value = materialValue;

	}
	const snapshot = source.valueSnapshot;

	if ( dtype === 'color' || ( value && value.isColor ) ) writeColor( view, offset, value, snapshot );
	else if ( dtype === 'vec2' ) writeVec2( view, offset, value, snapshot );
	else if ( dtype === 'vec3' ) writeVec3( view, offset, value, snapshot );
	else if ( dtype === 'vec4' ) writeVec4( view, offset, value, snapshot );
	else if ( dtype === 'mat3' ) writeMat3( view, offset, value, snapshot );
	else if ( dtype === 'mat4' ) writeMat4( view, offset, value, snapshot );
	else writeNumber( view, offset, value, snapshot );

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
function writeLightValue( view, offset, kind, source, frame ) {

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

function writeSnapshot( view, offset, snapshot ) {

	if ( ! snapshot ) return;
	const { type, data } = snapshot;
	if ( type === 'number' || type === 'float' || type === 'f32' ) writeNumber( view, offset, data );
	else if ( type === 'int' || type === 'i32' ) writeInt( view, offset, data );
	else if ( type === 'uint' || type === 'u32' ) writeUint( view, offset, data );
	else if ( type === 'color' ) writeColor( view, offset, { r: data[ 0 ], g: data[ 1 ], b: data[ 2 ] } );
	else if ( type === 'vec2' ) writeVec2( view, offset, { x: data[ 0 ], y: data[ 1 ] } );
	else if ( type === 'vec3' ) writeVec3( view, offset, { x: data[ 0 ], y: data[ 1 ], z: data[ 2 ] } );
	else if ( type === 'vec4' ) writeVec4( view, offset, { x: data[ 0 ], y: data[ 1 ], z: data[ 2 ], w: data[ 3 ] } );
	else if ( type === 'mat3' ) writeMat3( view, offset, { elements: data } );
	else if ( type === 'mat4' ) writeMat4( view, offset, { elements: data } );

}

function writeNumber( view, offset, value, snapshot ) {

	const n = Number.isFinite( value ) ? value : snapshot && Number( snapshot.data ) || 0;
	view.setFloat32( offset, n, true );

}

function writeInt( view, offset, value, snapshot ) {

	const n = Number.isFinite( value ) ? value : snapshot && Number( snapshot.data ) || 0;
	view.setInt32( offset, n | 0, true );

}

function writeUint( view, offset, value, snapshot ) {

	const n = Number.isFinite( value ) ? value : snapshot && Number( snapshot.data ) || 0;
	view.setUint32( offset, n >>> 0, true );

}

function writeColor( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	view.setFloat32( offset, value && value.r || 0, true );
	view.setFloat32( offset + 4, value && value.g || 0, true );
	view.setFloat32( offset + 8, value && value.b || 0, true );

}

function writeVec2( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	view.setFloat32( offset, value && value.x || 0, true );
	view.setFloat32( offset + 4, value && value.y || 0, true );

}

function writeVec3( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	view.setFloat32( offset, value && value.x || 0, true );
	view.setFloat32( offset + 4, value && value.y || 0, true );
	view.setFloat32( offset + 8, value && value.z || 0, true );

}

function writeVec4( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	view.setFloat32( offset, value && value.x || 0, true );
	view.setFloat32( offset + 4, value && value.y || 0, true );
	view.setFloat32( offset + 8, value && value.z || 0, true );
	view.setFloat32( offset + 12, value && value.w || 0, true );

}

function writeMat3( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	const e = value && value.elements || [];
	view.setFloat32( offset + 0, e[ 0 ] || 0, true );
	view.setFloat32( offset + 4, e[ 1 ] || 0, true );
	view.setFloat32( offset + 8, e[ 2 ] || 0, true );
	view.setFloat32( offset + 16, e[ 3 ] || 0, true );
	view.setFloat32( offset + 20, e[ 4 ] || 0, true );
	view.setFloat32( offset + 24, e[ 5 ] || 0, true );
	view.setFloat32( offset + 32, e[ 6 ] || 0, true );
	view.setFloat32( offset + 36, e[ 7 ] || 0, true );
	view.setFloat32( offset + 40, e[ 8 ] || 0, true );

}

function writeMat4( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	const e = value && value.elements || [];
	for ( let i = 0; i < 16; i ++ ) view.setFloat32( offset + i * 4, e[ i ] || 0, true );

}

/**
 * Write a live UniformNode value to a DataView. Dispatches by the value's
 * runtime type. Called for `uniform.live` slots when `_liveNode` is present
 * (in-process flows where the original TSL node instances are alive).
 *
 * @param {DataView} view
 * @param {number} offset
 * @param {any} value - The `UniformNode.value` field.
 * @param {string} [dtype] - Hint from the plan slot ('number','vec2',…,'mat4').
 */
function writeLiveValue( view, offset, value, dtype ) {

	if ( typeof value === 'number' ) { view.setFloat32( offset, value, true ); return; }
	if ( value && value.isColor ) { writeColor( view, offset, value ); return; }
	if ( value && value.isMatrix4 ) { writeMat4( view, offset, value ); return; }
	if ( value && value.isMatrix3 ) { writeMat3( view, offset, value ); return; }
	if ( value && value.isVector4 ) { writeVec4( view, offset, value ); return; }
	if ( value && value.isVector3 ) { writeVec3( view, offset, value ); return; }
	if ( value && value.isVector2 ) { writeVec2( view, offset, value ); return; }
	// Fallback: try dtype hint
	if ( dtype === 'mat4' ) { writeMat4( view, offset, value ); return; }
	if ( dtype === 'mat3' ) { writeMat3( view, offset, value ); return; }
	if ( dtype === 'vec4' ) { writeVec4( view, offset, value ); return; }
	if ( dtype === 'vec3' ) { writeVec3( view, offset, value ); return; }
	if ( dtype === 'vec2' ) { writeVec2( view, offset, value ); return; }
	if ( dtype === 'color' ) { writeColor( view, offset, value ); return; }
	// Scalar fallback
	view.setFloat32( offset, Number( value ) || 0, true );

}


function createStaticObserver() {

	// Always-refresh observer. Returning anything other than `true` here
	// causes three.js's renderer to skip `updateForRender(renderObject)`
	// for that draw — and since multiple renderObjects can share the same
	// node-builder state (cached by cacheKey), the second+ object in a
	// frame would re-use the FIRST object's UBO contents. That's why a
	// scene with 200 sprites of the same material would render every
	// sprite at the first sprite's position.
	//
	// Stock NodeMaterialObserver gates this with a per-render-object
	// equality check; we don't have the bandwidth for that yet, so just
	// always refresh. The cost is one DataView write + one writeBuffer
	// per object per frame, which is what stock three.js does for
	// non-bundled scenes anyway.
	return { needsRefresh() { return true; } };

}
