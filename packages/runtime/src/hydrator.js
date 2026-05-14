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
import { dispatchTextureBinding } from './hydrate/artifact-texture-resolver.js';
import { findLightBySource, lightDiagnosticShape, recordShadowBindingDiagnostic } from './hydrate/light-writers.js';
import { writeUniformGroup } from './hydrate/material-writers.js';
import { writeSnapshot } from './hydrate/snapshot-writers.js';
import { installLiveTextureRegistryPatches } from './hydrate/live-texture-registry.js';
import { createRuntimeBindingFromKind } from './hydrate/kinds/runtime-binding-dispatcher.js';
import { classifyDynamicTextureBinding, indexDynamicTextureBindings } from './hydrate/kinds/dynamic-texture-classifier.js';
import { createDynamicBindingResolvers } from './hydrate/rebinders/dynamic-binding-resolver.js';
import { collectMaterialReflectorBaseNodes, findReflectorBaseNodeInMaterial } from './hydrate/rebinders/reflector-texture-rebinder.js';
import { shouldSkipViewportCopyForZeroThicknessTransmission } from './hydrate/rebinders/viewport-texture-rebinder.js';
import { resolveTypedArrayCtor } from './hydrate/typed-arrays.js';
import { inferTextureTypeFromShader, shaderDeclaresDepthTexture } from './hydrate/texture-resolver.js';
import { textureBindingFallbacks, makeViewportFallback } from './hydrate/fallback-textures.js';
import { clippingPlaneSetsForFrame, selectClippingPlaneArray } from './hydrate/clipping-planes.js';
import { applyCapturedInstancedDrawCount, bindUserNodeAttributesToArtifact, bindUserStorageBuffersToArtifact, hydrateNodeAttributes } from './hydrate/user-attributes.js';

export { clearLiveTextureIndex, registerLiveTexture } from './hydrate/live-texture-registry.js';

installLiveTextureRegistryPatches();

/**
 * Produce a NodeBuilderState-compatible object for a precompiled material.
 *
 * @param {Object} artifact - The `precompiledArtifact` carried on the material.
 * @param {?Object} [material] - The runtime material (provides live texture/node references).
 * @param {?Object} [object] - The renderObject's `object` (for instanced/skinned info).
 * @param {?number} [cacheKey] - The live `renderObject.cacheKey`. When the artifact
 *   carries a `variants` map (Tier C), the matching variant's shader/uniformPlan/
 *   attributes/bindings override the top-level fields. Legacy single-variant
 *   artifacts ignore this and use the top-level fields directly.
 * @return {Object} A plain object with the fields `Pipelines.js` + `RenderObject.js` read.
 */
export function hydrateNodeBuilderState( artifact, material = null, object = null, cacheKey = null ) {

	if ( ! artifact ) {

		throw new Error( '[tsl-precompile/hydrator] artifact is required (material.isPrecompiledMaterial but material.precompiledArtifact is null)' );

	}

	// Tier C — variant-keyed artifact family. When the artifact has a
	// `variants` map AND the live `cacheKey` matches one of them, swap the
	// shader/uniformPlan/attributes/bindings fields with that variant's
	// payload. The original artifact identity is preserved (same _textureRefs,
	// same _liveUpdateNodes, same captureClock, etc.) — we only swap the
	// fields that depend on the render-state cacheKey.
	const effective = selectArtifactVariant( artifact, cacheKey );

	// Bind live BufferAttributes from the user's `*Node` material props
	// (e.g. `material.positionNode = instancedBufferAttribute(buf)`) onto
	// the artifact's node-attribute entries before hydration walks them.
	// Idempotent and a no-op when capture didn't record `userPath` or the
	// material has no matching node tree yet.
	bindUserNodeAttributesToArtifact( effective, material );
	applyCapturedInstancedDrawCount( effective, object || material && material.__tslpPrecompileObject || null );
	// Same trick for compute-storage buffers wired through the user's
	// `material.colorNode = colors.element( instanceIndex )` etc. — the
	// kernel writes into `colors`, the render reads from the same buffer.
	bindUserStorageBuffersToArtifact( effective, material );

	const runtimeBindings = hydrateRuntimeBindings( effective, material );
	const { bindings, uniformBuffers, clippingUniformBuffers } = runtimeBindings;
	const updateNode = createUniformUpdateNode( effective, uniformBuffers, material );
	const clippingUniformUpdateNode = clippingUniformBuffers.length > 0
		? createClippingUniformUpdateNode( clippingUniformBuffers, material )
		: null;

	// One descriptor-driven entry point owns rebinder construction +
	// ordering. The hydrator just supplies the grouped bindings and the
	// dependency bag (light-finder + diagnostics + texture resolver). See
	// `hydrate/rebinders/dynamic-binding-resolver.js` for the descriptor-
	// to-rebinder mapping.
	const { earlyUpdateBefore, lateUpdateBefore } = createDynamicBindingResolvers( runtimeBindings, {
		resolveTextureBinding,
		findLightBySource,
		recordShadowDiagnostic: recordShadowBindingDiagnostic,
		describeLight: lightDiagnosticShape,
	} );

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
		vertexShader: String( effective.vertexShader || '' ),
		fragmentShader: String( effective.fragmentShader || '' ),
		computeShader: String( effective.computeShader || '' ),
		transforms: effective.transforms || [],
		nodeAttributes: hydrateNodeAttributes( effective.nodeAttributes || effective.attributes || [] ),
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
			// `earlyUpdateBefore` runs first: shadow-depth, artifact-texture,
			// material-texture, viewport-texture rebinders. Each updates
			// SampledTexture bindings to live resources before three.js reads
			// bind-group versions for the upcoming draw.
			...earlyUpdateBefore,
			...liveUpdateBeforeNodes,
			...materialReflectorUpdateBeforeNodes,
			// `lateUpdateBefore` runs after the live-node + reflector sidecars:
			// material-graph depth-texture rebinder and reflector-texture
			// rebinder, both of which depend on those sidecars having already
			// keyed their per-frame state.
			...lateUpdateBefore,
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

	// Pre-classified dynamic-texture entries from `artifact.dynamicBindings`,
	// indexed by `${groupName}::${bindingName}`. Replaces the old per-binding
	// `findPlanTextureSource(...)` walk with O(1) lookup. The classifier
	// dispatches each entry to the right typed bag below.
	const dynamicTextureIndex = indexDynamicTextureBindings( artifact );
	const classifierContext = {
		artifact,
		material,
		shadowDepthBindings,
		materialDepthBindings,
		artifactTextureBindings,
		materialTextureBindings,
		viewportTextureBindings,
		reflectorTextureBindings,
		recordShadowBindingDiagnostic,
		findReflectorBaseNodeInMaterial,
		shaderDeclaresDepthTexture,
		shouldSkipViewportCopyForZeroThicknessTransmission,
	};

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

			if ( descriptor.kind === 'sampled-texture' || descriptor.kind === 'sampler' ) {

				const dynamicEntry = dynamicTextureIndex.get( `${ group.name || '' }::${ descriptor.name || '' }` );
				if ( dynamicEntry ) classifyDynamicTextureBinding( dynamicEntry, runtimeBinding, descriptor, classifierContext );

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

/**
 * Tier C — variant-keyed artifact family lookup.
 *
 * When an artifact carries `variants` (a map keyed by capture-time `cacheKey`)
 * AND the live `cacheKey` matches one of them, return a "view" object that
 * exposes the variant's render-state fields (vertexShader, fragmentShader,
 * uniformPlan, bindings, attributes, …) while still forwarding the top-level
 * sidecars (_textureRefs, _liveUpdateNodes, captureClock, mrtOutputCount, …)
 * from the artifact.
 *
 * Falls back to returning `artifact` unchanged when:
 *   - the artifact has no `variants` field (legacy single-variant capture)
 *   - the live `cacheKey` is null/undefined (in-process flows that don't
 *     route through the patched `Nodes.js:getForRender`)
 *   - no variant entry matches the live `cacheKey` (render-state diverged
 *     from anything captured — caller should fall through to a full-renderer
 *     fallback when this happens, but we still return something usable so
 *     today's hot path doesn't throw)
 *
 * The returned object preserves identity for non-enumerable sidecar access
 * via property forwarding — `effective._textureRefs` reads from `artifact._textureRefs`,
 * but `effective.vertexShader` reads from the variant.
 *
 * @param {Object} artifact
 * @param {?number|?string} cacheKey
 * @returns {Object} `artifact` (when no variant lookup applies) or a merged view
 */
function selectArtifactVariant( artifact, cacheKey ) {

	if ( ! artifact || ! artifact.variants || cacheKey === null || cacheKey === undefined ) {

		return artifact;

	}

	const key = String( cacheKey );
	const variant = artifact.variants[ key ];
	if ( ! variant ) return artifact;

	// Shallow merge: variant fields override top-level. Object.assign skips
	// non-enumerable properties (which is what we want — _textureRefs,
	// _liveUpdateNodes, _generatedUpdateGroup etc. are non-enumerable
	// sidecars set via Object.defineProperty and accessed by reference
	// through the original `artifact` in this hydrator). We construct the
	// merged view from the artifact base so any non-variant enumerable
	// fields (mrtOutputCount on the parent if not on the variant, name,
	// __hash, etc.) survive.
	const merged = Object.assign( Object.create( Object.getPrototypeOf( artifact ) || null ), artifact, variant );

	// Re-attach non-enumerable sidecars by reference so the rebinder and
	// texture-resolution paths see the same identity. We copy by property
	// descriptor to preserve writable/configurable flags too.
	for ( const sidecar of [ '_textureRefs', '_liveUpdateNodes', '_liveUpdateBeforeNodes', '_liveUpdateAfterNodes', '_generatedUpdateGroup', '_unsupportedKinds', '_textureResolutionStrategies' ] ) {

		const desc = Object.getOwnPropertyDescriptor( artifact, sidecar );
		if ( desc ) Object.defineProperty( merged, sidecar, desc );

	}

	return merged;

}
