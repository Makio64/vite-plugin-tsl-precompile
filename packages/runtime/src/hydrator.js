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
import { DataTexture, Data3DTexture, DataArrayTexture, DepthTexture, CubeDepthTexture, CubeTexture, FramebufferTexture, RGBAFormat, DepthFormat, UnsignedByteType, UnsignedIntType, LessEqualCompare, LinearMipmapLinearFilter, Matrix3, Plane, InstancedBufferAttribute } from 'three';
import { dispatchTextureBinding } from './hydrate/artifact-texture-resolver.js';
import { findLightBySource, lightDiagnosticShape, recordShadowBindingDiagnostic } from './hydrate/light-writers.js';
import { writeUniformGroup } from './hydrate/material-writers.js';
import { writeSnapshot } from './hydrate/snapshot-writers.js';
import { installLiveTextureRegistryPatches } from './hydrate/live-texture-registry.js';
import { createRuntimeBindingFromKind } from './hydrate/kinds/runtime-binding-dispatcher.js';
import { collectMaterialReflectorBaseNodes, createReflectorTextureRebinder, findReflectorBaseNodeInMaterial } from './hydrate/rebinders/reflector-texture-rebinder.js';
import { createShadowDepthRebinder } from './hydrate/rebinders/shadow-depth-rebinder.js';
import { createArtifactTextureRebinder, createMaterialTextureRebinder } from './hydrate/rebinders/texture-rebinders.js';
import { createViewportTextureRebinder, shouldSkipViewportCopyForZeroThicknessTransmission } from './hydrate/rebinders/viewport-texture-rebinder.js';
import { resolveTypedArrayCtor } from './hydrate/typed-arrays.js';
import { findPlanTextureSource, inferTextureTypeFromShader, shaderDeclaresDepthTexture } from './hydrate/texture-resolver.js';

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

// One bag, passed through to `dispatchTextureBinding` whenever the dispatcher
// needs a shape-appropriate fallback. `selectFallbackTextureForBinding`
// (texture-resolver.js) keys off the shader-declared type to pick which of
// these to return — keep keys in sync with that selector.
const textureBindingFallbacks = {
	texture: fallbackTexture,
	comparisonDepth: fallbackComparisonDepthTexture,
	depth: fallbackDepthTexture,
	depthCube: fallbackDepthCubeTexture,
	depthArray: fallbackDepthArrayTexture,
	multisampledDepth: fallbackMultisampledDepthTexture,
	cube: fallbackCubeTexture,
	texture3D: fallback3DTexture,
	array: fallbackArrayTexture,
};

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

// Module-level scratch reused per frame to avoid GC pressure. Writer-side
// scratch (camera/object/material/light/scene UBO writes) lives next to its
// writer in `hydrate/material-writers.js` and `hydrate/light-writers.js`.
const _clipPlane = new Plane();
const _clipNormalMatrix = new Matrix3();

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

// `dispatchTextureBinding` in `hydrate/artifact-texture-resolver.js` owns the
// full source.kind → live-texture dispatch (depth fallback / builtin /
// material slot / viewport fallback / artifact-texture strategies). It also
// emits the loud-warn-on-miss diagnostic gated by `TSLP_WARN_TEXTURE_MISS`.
// The hydrator passes through its locally-owned fallback texture singletons
// + the `makeViewportFallback` factory; everything else is sibling imports.
function resolveTextureBinding( artifact, groupName, bindingName, material, options = null ) {

	return dispatchTextureBinding( {
		artifact,
		groupName,
		bindingName,
		material,
		options,
		deps: {
			fallbacks: textureBindingFallbacks,
			makeViewportFallback,
		},
	} );

}

function artifactUsesClippingUniformBuffers( artifact ) {

	const wgsl = `${ artifact && artifact.vertexShader || '' }\n${ artifact && artifact.fragmentShader || '' }`;
	return /\bclip_distances\b|\bhw_clip_distances\b|\bclipped\b|\bclipOpacity\b|\bdistanceToPlane\b/.test( wgsl );

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
