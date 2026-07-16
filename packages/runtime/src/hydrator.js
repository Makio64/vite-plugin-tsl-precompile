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
import { linkArtifactLightIdentities } from './hydrate/light-identities.js';
import { findLightBySource, lightDiagnosticShape, recordShadowBindingDiagnostic } from './hydrate/light-writers.js';
import { writeUniformGroup } from './hydrate/material-writers.js';
import { artifactRequiresShadowCasterBinding, createMaterialBindingOwnerContext } from './hydrate/material-binding-owner.js';
import { writeLiveValue, writeSnapshot } from './hydrate/snapshot-writers.js';
import { installLiveTextureRegistryPatches } from './hydrate/live-texture-registry.js';
import { createRuntimeBindingFromKind } from './hydrate/kinds/runtime-binding-dispatcher.js';
import { classifyDynamicTextureBinding, indexDynamicTextureBindings } from './hydrate/kinds/dynamic-texture-classifier.js';
import { createDynamicBindingResolvers } from './hydrate/rebinders/dynamic-binding-resolver.js';
import { createFrameScopedResolutionMemo } from './hydrate/rebinders/resolution-memo.js';
import { collectMaterialReflectorBaseNodes, findReflectorBaseNodeInMaterial } from './hydrate/rebinders/reflector-texture-rebinder.js';
import { shouldSkipViewportCopyForZeroThicknessTransmission } from './hydrate/rebinders/viewport-texture-rebinder.js';
import { resolveTypedArrayCtor } from './hydrate/typed-arrays.js';
import { inferTextureTypeFromShader, shaderDeclaresDepthTexture } from './hydrate/texture-resolver.js';
import { textureBindingFallbacks, makeViewportFallback } from './hydrate/fallback-textures.js';
import { clippingPlaneSetsForFrame, selectClippingPlaneArray } from './hydrate/clipping-planes.js';
import { applyCapturedInstancedDrawCount, bindUserNodeAttributesToArtifact, bindUserStorageBuffersToArtifact, createHydrationBindingArtifactView, hydrateNodeAttributes } from './hydrate/user-attributes.js';
import { updateDynamicLightUniforms } from './hydrate/dynamic-light-buffers.js';
import { selectArtifactVariant } from './hydrate/variants/artifact-variant-selector.js';
import { logicalFrameKey, shouldAdvanceTemporalState } from './slim-support/temporal-frame.js';
import { wireLiveNodeSidecarsToArtifact } from './slim-support/live-node-sidecars.js';
import { applyMaterialComputeAttributeBindings } from './hydrate/material-compute-bindings.js';
import { hydrateMaterialCompute } from './hydrate/material-compute.js';

export { clearLiveTextureIndex, installTextureLoaderTracking, registerLiveTexture } from './hydrate/live-texture-registry.js';

installLiveTextureRegistryPatches();

const liveSkeletonBufferStates = new WeakMap();
const skinnedBindMatrixSlots = new WeakMap();

/**
 * Produce a NodeBuilderState-compatible object for a precompiled material.
 *
 * @param {Object} artifact - The `precompiledArtifact` carried on the material.
 * @param {?Object} [material] - The runtime material (provides live texture/node references).
 * @param {?Object} [object] - The renderObject's `object` (for instanced/skinned info).
 * @param {?number|?string|Object} [variantSelection] - A legacy live cache key,
 *   or `{ cacheKey, renderObject, bindingMaterial, renderContextSelector }`.
 *   `bindingMaterial` is the exact pre-override material for integrations that
 *   cannot provide a Three RenderObject. Semantic render context is preferred
 *   when present; private cache keys remain compatible.
 * @return {Object} A plain object with the fields `Pipelines.js` + `RenderObject.js` read.
 */
export function hydrateNodeBuilderState( artifact, material = null, object = null, variantSelection = null ) {

	if ( ! artifact ) {

		throw new Error( '[tsl-precompile/hydrator] artifact is required (material.isPrecompiledMaterial but material.precompiledArtifact is null)' );

	}

	// Tier C — variant-keyed artifact family. When the artifact has a
	// `variants` map AND the live `cacheKey` matches one of them, swap the
	// shader/uniformPlan/attributes/bindings fields with that variant's
	// payload. The original artifact identity is preserved (same _textureRefs,
	// same _liveUpdateNodes, same captureClock, etc.) — we only swap the
	// fields that depend on the render-state cacheKey.
	const selection = variantSelection && typeof variantSelection === 'object'
		? { ...variantSelection, material: variantSelection.material || material }
		: { cacheKey: variantSelection, material };
	const selectedArtifact = selectArtifactVariant( artifact, selection );
	const requiresShadowCaster = artifactRequiresShadowCasterBinding( selectedArtifact );
	const effective = createHydrationBindingArtifactView( selectedArtifact, { resetLiveNodeSidecars: requiresShadowCaster } );
	// Frozen serialized sources are linked through a WeakMap because they
	// cannot accept non-enumerable sidecars. Link the state-local view after
	// cloning so those process-local identity records follow the exact slots
	// that the updater will read.
	linkArtifactLightIdentities( effective );
	const materialBindingOwner = createMaterialBindingOwnerContext( effective, {
		renderMaterial: material,
		bindingMaterial: selection.bindingMaterial || null,
		renderObject: selection.renderObject || null,
	} );
	const graphMaterial = materialBindingOwner.materialForArtifactGraph();
	if ( requiresShadowCaster || material && material.isShadowPassMaterial === true ) {

		const sidecarMaterials = collectOwnedLiveSidecarMaterials( effective, materialBindingOwner, graphMaterial );
		let replaceUpdateNodes = requiresShadowCaster;
		for ( const sourceMaterial of sidecarMaterials ) {

			wireLiveNodeSidecarsToArtifact( effective, sourceMaterial, {
				includeRegisteredUniforms: ! requiresShadowCaster,
				includeVariants: false,
				overlay: true,
				replaceUpdateNodes,
				slotFilter: ( slot ) => materialBindingOwner.materialForSource( slot && slot.source ) === sourceMaterial,
			} );
			replaceUpdateNodes = false;

		}

	}

	// Material-owned ComputeNodes can expose writable attributes only through
	// their compiled bind groups. Apply the dispatcher-discovered owner-local
	// mapping immediately after exact variant selection. This proven mapping
	// must precede the generic anonymous-node heuristic below; otherwise a
	// same-shape render input (for example particle speed) can steal the compute
	// output's position slot. A shared artifact still never retains the first
	// material instance's GPU resource because `effective` is state-local.
	if ( ! effective.materialCompute || effective.materialCompute.mode !== 'precompiled' ) applyMaterialComputeAttributeBindings( effective, material );
	// Bind live BufferAttributes from the user's `*Node` material props
	// (e.g. `material.positionNode = instancedBufferAttribute(buf)`) onto
	// remaining artifact node-attribute entries before hydration walks them.
	// Explicit userPath entries are outside auto-compute eligibility.
	bindUserNodeAttributesToArtifact( effective, graphMaterial );
	applyCapturedInstancedDrawCount( effective, object || material && material.__tslpPrecompileObject || null );
	// Same trick for compute-storage buffers wired through the user's
	// `material.colorNode = colors.element( instanceIndex )` etc. — the
	// kernel writes into `colors`, the render reads from the same buffer.
	bindUserStorageBuffersToArtifact( effective, graphMaterial );
	const materialComputeUpdateBeforeNodes = hydrateMaterialCompute( artifact, effective, material, graphMaterial );

	const resolveInitialTextureBinding = createOwnedTextureBindingResolver( materialBindingOwner, resolveTextureBinding );
	const resolveLiveTextureBinding = createOwnedTextureBindingResolver( materialBindingOwner, memoizedResolveTextureBinding );
	const runtimeBindings = hydrateRuntimeBindings( effective, material, graphMaterial, resolveInitialTextureBinding );
	const { bindings, uniformBuffers, clippingUniformBuffers } = runtimeBindings;
	const uniformBufferTargets = createUniformBufferTargets( uniformBuffers );
	const updateNode = createUniformUpdateNode( effective, uniformBuffers, material, uniformBufferTargets, materialBindingOwner );
	const clippingUniformUpdateNode = clippingUniformBuffers.length > 0
		? createClippingUniformUpdateNode( clippingUniformBuffers, material, uniformBufferTargets )
		: null;

	// One descriptor-driven entry point owns rebinder construction +
	// ordering. The hydrator just supplies the grouped bindings and the
	// dependency bag (light-finder + diagnostics + texture resolver). See
	// `hydrate/rebinders/dynamic-binding-resolver.js` for the descriptor-
	// to-rebinder mapping.
	const { earlyUpdateBefore, lateUpdateBefore } = createDynamicBindingResolvers( runtimeBindings, {
		resolveTextureBinding: resolveLiveTextureBinding,
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
	const liveUpdateNodes = Array.isArray( effective._liveUpdateNodes ) ? effective._liveUpdateNodes : [];
	const liveUpdateBeforeNodes = Array.isArray( effective._liveUpdateBeforeNodes ) ? effective._liveUpdateBeforeNodes : [];
	const liveUpdateAfterNodes = Array.isArray( effective._liveUpdateAfterNodes ) ? effective._liveUpdateAfterNodes : [];
	const materialReflectorUpdateBeforeNodes = collectMaterialReflectorBaseNodes( graphMaterial )
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
			...materialComputeUpdateBeforeNodes,
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

			const objectBindings = cloneBindingsForObject( this.bindings, artifact, material );
			uniformBufferTargets.registerCurrentObject( objectBindings );
			return objectBindings;

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
	recordHydratedAttributeDiagnostic( artifact, selectedArtifact, base, material, object );

	// Wrap in a Proxy that returns a no-op function for any OTHER method
	// lookup the renderer might do. Keeps forward-compatibility with
	// three.js version bumps without shape-gating every method name.
	return new Proxy( base, {
		get( target, prop ) {

			if ( prop in target ) return target[ prop ];
			// Promise resolution probes `.then`. Treating that lookup as one of
			// the generic no-op methods makes every hydrated state an unresolved
			// thenable, which breaks compileAsync/getForRenderAsync.
			if ( prop === 'then' ) return undefined;
			// Unknown property: return a no-op function. Common for
			// renderer helpers that probe for optional methods.
			return () => undefined;

		},
	} );

}

function collectOwnedLiveSidecarMaterials( artifact, materialBindingOwner, graphMaterial ) {

	const materials = [];
	const add = ( candidate ) => {

		if ( candidate && ! materials.includes( candidate ) ) materials.push( candidate );

	};
	add( graphMaterial );
	for ( const group of artifact && Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [] ) {

		for ( const slot of Array.isArray( group.slots ) ? group.slots : [] ) {

			const source = slot && slot.source || {};
			if ( source.kind !== 'uniform.live' || source.property ) continue;
			add( materialBindingOwner.materialForSource( source ) );

		}

	}
	return materials;

}

function recordHydratedAttributeDiagnostic( artifact, effective, state, material, object ) {

	if ( typeof globalThis === 'undefined' || ! globalThis.__tslpHarnessDiagnostics ) return;
	const diag = globalThis.__tslpHarnessDiagnostics;
	const list = diag.hydratedNodeAttributes || ( diag.hydratedNodeAttributes = [] );
	if ( list.length >= 24 ) return;
	const dataIds = new Map();
	let nextDataId = 0;
	const attributes = Array.isArray( state && state.nodeAttributes ) ? state.nodeAttributes : [];
	list.push( {
		name: artifact && ( artifact.name || artifact.__name ) || effective && ( effective.name || effective.materialShape ) || '',
		material: material && ( material.name || material.type ) || '',
		objectType: object && object.type || '',
		isInstancedMesh: object && object.isInstancedMesh === true,
		objectCount: object && object.count,
		attributes: attributes.map( ( entry ) => {

			const attribute = entry && entry.node && entry.node.attribute || null;
			const data = attribute && attribute.data || null;
			let dataId = null;
			if ( data ) {

				if ( ! dataIds.has( data ) ) dataIds.set( data, ++ nextDataId );
				dataId = dataIds.get( data );

			}
			return {
				name: entry && entry.name || '',
				count: attribute && attribute.count,
				itemSize: attribute && attribute.itemSize,
				interleaved: attribute && attribute.isInterleavedBufferAttribute === true,
				instanced: attribute && ( attribute.isInstancedBufferAttribute === true || data && data.isInstancedInterleavedBuffer === true ),
				stride: data && data.stride,
				offset: attribute && attribute.offset,
				dataId,
			};

		} ),
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
		const groupNode = { shared: false, version: 0 };
		const clonedBindings = ( bg.bindings || [] ).map( ( b ) => cloneBinding( b, groupNode ) );
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

function cloneBinding( binding, groupNode ) {

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
		cloned.groupNode = groupNode;
		if ( binding.__tslpLiveArrayResolver ) attachLiveUniformBufferUpdater( cloned, binding.__tslpLiveArrayResolver );
		return cloned;

	}
	// Match NodeBuilderState.createBindings(): each render object owns its
	// binding wrappers, while the wrapped GPU resources remain shared. Every
	// wrapper in the cloned bind group must also reference the same groupNode;
	// Bindings._update() gates texture/storage refresh through that identity.
	const cloned = binding.clone();
	cloned.groupNode = groupNode;
	return cloned;

}

/**
 * NodeBuilderState instances are cache-shared, but non-shared bind groups are
 * cloned by RenderObject. Keep an object-keyed index of those clones so the
 * cache-shared update node writes into the exact buffers that the current
 * render object will upload. The first update for a render object happens
 * before RenderObject calls createBindings(); in that one pass the base
 * buffers are updated and then cloned, after which every update goes directly
 * to the registered clones.
 */
function createUniformBufferTargets( baseUniformBuffers ) {

	const perObject = new WeakMap();
	let currentObject = null;

	return {
		forFrame( frame ) {

			const object = frame && frame.object;
			currentObject = isObjectKey( object ) ? object : null;
			return currentObject && perObject.get( currentObject ) || baseUniformBuffers;

		},
		registerCurrentObject( bindings ) {

			if ( ! currentObject ) return;
			perObject.set( currentObject, indexUniformBuffers( bindings ) );

		},
	};

}

function isObjectKey( value ) {

	return value !== null && ( typeof value === 'object' || typeof value === 'function' );

}

function indexUniformBuffers( bindings ) {

	const out = new Map();
	for ( const group of Array.isArray( bindings ) ? bindings : [] ) {

		let firstUniformBuffer = null;
		for ( const binding of group && Array.isArray( group.bindings ) ? group.bindings : [] ) {

			if ( ! binding || binding.isUniformBuffer !== true ) continue;
			if ( ! firstUniformBuffer ) firstUniformBuffer = binding;
			if ( binding.name ) out.set( binding.name, binding );

		}
		// Uniform plans address their primary UBO by group name. Standalone
		// NodeUniformBuffers in the same group retain their own binding names.
		if ( group && group.name && ! out.has( group.name ) && firstUniformBuffer ) out.set( group.name, firstUniformBuffer );

	}
	return out;

}

function hydrateRuntimeBindings( artifact, material, graphMaterial, textureResolver ) {

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

	// Dynamic-texture entries indexed by `${groupName}::${bindingName}`. Generated
	// modules reconstruct their public `dynamicBindings` view from uniform-plan
	// references without serializing it twice; compact direct consumers can let
	// the classifier derive the texture subset from `uniformPlan[].textures`.
	// The classifier dispatches each entry to the right typed bag below.
	const dynamicTextureIndex = indexDynamicTextureBindings( artifact );
	const classifierContext = {
		artifact,
		material,
		graphMaterial,
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

			const runtimeBinding = createRuntimeBinding( artifact, group, descriptor, material, groupNode, textureResolver );
			if ( ! runtimeBinding ) continue;

			runtimeBindings.push( runtimeBinding );
			if ( runtimeBinding.isUniformBuffer ) uniformBuffers.set( descriptor.name || group.name || '', runtimeBinding );
			if ( hasClippingUniformBuffers && runtimeBinding.isUniformBuffer && /^UniformBuffer_/.test( descriptor.name || '' ) ) {

				clippingUniformBuffers.push( {
					binding: runtimeBinding,
					bindingName: descriptor.name || group.name || '',
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

function createLiveUniformArrayResolver( bindingName, byteLength, material, artifact = null, groupName = '' ) {

	if ( ! /^UniformBuffer_/.test( bindingName || '' ) ) return null;
	if ( ! material ) return null;
	const skeletonRole = skeletonUniformBufferRole( artifact, groupName, bindingName, byteLength );
	return function resolveLiveUniformArray() {

		const object = material.__tslpCurrentFrame && material.__tslpCurrentFrame.object || material.__tslpPrecompileObject;
		if ( ! object ) return null;

		const skeleton = object.skeleton;
		const boneMatrices = skeleton && resolveLiveSkeletonMatrices( skeleton, byteLength, skeletonRole, material );
		if ( boneMatrices && boneMatrices.byteLength === byteLength ) {

			return boneMatrices;

		}

		const instanceArray = object.instanceMatrix && object.instanceMatrix.array;
		if ( instanceArray && instanceArray.byteLength === byteLength ) return instanceArray;

		return null;

	};

}

function skeletonUniformBufferRole( artifact, groupName, bindingName, byteLength ) {

	if ( ! artifact || ! /positionPrevious/.test( artifact.vertexShader || '' ) ) return 'current';
	const bindingGroups = Array.isArray( artifact.bindings ) ? artifact.bindings : [];
	const group = bindingGroups.find( ( entry ) => entry && entry.name === groupName );
	const descriptors = group && Array.isArray( group.bindings ) ? group.bindings : [];
	const skeletonBuffers = descriptors.filter( ( descriptor ) => (
		descriptor &&
		descriptor.kind === 'uniform-buffer' &&
		/^UniformBuffer_/.test( descriptor.name || '' ) &&
		( descriptor.byteLength | 0 ) === ( byteLength | 0 )
	) );
	if ( skeletonBuffers.length < 2 ) return 'current';
	return skeletonBuffers[ 0 ] && skeletonBuffers[ 0 ].name === bindingName ? 'previous' : 'current';

}

function liveFrameKeyForMaterial( material ) {

	const frame = material && material.__tslpCurrentFrame || null;
	const root = typeof globalThis !== 'undefined' ? globalThis : null;
	const fallback = root && Number.isFinite( root.__tslpRafTick ) ? root.__tslpRafTick : 0;
	return logicalFrameKey( frame, fallback );

}

function shouldFreezeLiveSkeletonState( material ) {

	const frame = material && material.__tslpCurrentFrame || null;
	return ! shouldAdvanceTemporalState( frame );

}

function liveSkeletonMatricesNeedBootstrap( boneMatrices ) {

	if ( ! boneMatrices || boneMatrices.length === 0 ) return false;
	for ( let i = 0; i < boneMatrices.length; i ++ ) {

		const value = boneMatrices[ i ];
		if ( Number.isFinite( value ) && value !== 0 ) return false;

	}
	return true;

}

function resolveLiveSkeletonMatrices( skeleton, byteLength, role, material ) {

	if ( ! skeleton || ! skeleton.boneMatrices || skeleton.boneMatrices.byteLength !== byteLength ) return null;
	const frameId = liveFrameKeyForMaterial( material );
	let state = liveSkeletonBufferStates.get( skeleton );
	if ( ! state ) {

		const needsBootstrap = liveSkeletonMatricesNeedBootstrap( skeleton.boneMatrices );
		if ( needsBootstrap && typeof skeleton.update === 'function' ) skeleton.update();
		state = {
			frameId: needsBootstrap ? frameId : null,
			previousBoneMatrices: new Float32Array( skeleton.boneMatrices ),
		};
		liveSkeletonBufferStates.set( skeleton, state );
		if ( needsBootstrap ) {

			if ( skeleton.previousBoneMatrices && skeleton.previousBoneMatrices.length === state.previousBoneMatrices.length ) {
				skeleton.previousBoneMatrices.set( state.previousBoneMatrices );
			} else {
				skeleton.previousBoneMatrices = new Float32Array( state.previousBoneMatrices );
			}

		}

	}
	if ( state.frameId !== frameId && ! shouldFreezeLiveSkeletonState( material ) ) {

		state.frameId = frameId;
		if ( state.previousBoneMatrices.length !== skeleton.boneMatrices.length ) state.previousBoneMatrices = new Float32Array( skeleton.boneMatrices.length );
		state.previousBoneMatrices.set( skeleton.boneMatrices );
		if ( typeof skeleton.update === 'function' ) skeleton.update();
		if ( skeleton.previousBoneMatrices && skeleton.previousBoneMatrices.length === state.previousBoneMatrices.length ) {
			skeleton.previousBoneMatrices.set( state.previousBoneMatrices );
		} else {
			skeleton.previousBoneMatrices = new Float32Array( state.previousBoneMatrices );
		}

	} else if ( role !== 'previous' && typeof skeleton.update === 'function' && state.frameId === null ) {

		skeleton.update();

	}
	return role === 'previous' ? state.previousBoneMatrices : skeleton.boneMatrices;

}

function attachLiveUniformBufferUpdater( uniformBuffer, liveArrayResolver ) {

	if ( ! uniformBuffer || typeof liveArrayResolver !== 'function' ) return;
	Object.defineProperty( uniformBuffer, '__tslpLiveArrayResolver', {
		value: liveArrayResolver,
		configurable: true,
		// NodeBuilderState.createBindings() clones bindings with Object.assign.
		// Keep the resolver enumerable so the final per-render clone retains it.
		enumerable: true,
	} );
	uniformBuffer.update = function updateLiveUniformBuffer() {

		const liveArray = this.__tslpLiveArrayResolver && this.__tslpLiveArrayResolver();
		if ( liveArray && this.buffer && typeof this.buffer.set === 'function' ) {

			this.buffer.set( liveArray.subarray ? liveArray.subarray( 0, this.buffer.length ) : liveArray.slice( 0, this.buffer.length ) );

		}
		return true;

	};

}

function createRuntimeBinding( artifact, group, descriptor, material, groupNode, textureResolver = resolveTextureBinding ) {

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
			resolveTextureBinding: textureResolver,
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
	if ( typeof globalThis !== 'undefined' && groupName === 'object' && globalThis.__tslpHarnessDiagnostics ) {
		const list = globalThis.__tslpHarnessDiagnostics.seededObjectBuffers || ( globalThis.__tslpHarnessDiagnostics.seededObjectBuffers = [] );
		if ( list.length < 24 ) list.push( {
			name: artifact && artifact.sourceMaterial && artifact.sourceMaterial.name || artifact && artifact.materialShape || '',
			color: Array.from( buffer.slice( 0, 3 ) ),
			emissive: Array.from( buffer.slice( 20, 23 ) ),
			emissiveIntensity: buffer[ 23 ],
		} );
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

function createOwnedTextureBindingResolver( ownerContext, resolve ) {

	return function resolveOwnedTextureBinding( artifact, groupName, bindingName, material, options = null ) {

		const source = findUniformTextureSource( artifact, groupName, bindingName );
		const frame = options && options.frame || null;
		let bindingMaterial = material;
		if ( source && source.kind && source.kind.startsWith( 'material.' ) ) {

			bindingMaterial = ownerContext.materialForSource( source, frame );

		} else if ( source && (
			source.kind === 'artifact.texture'
			|| source.kind === 'reflector.texture'
			|| source.kind === 'depth.texture' && source.fromMaterialGraph === true
		) ) {

			bindingMaterial = ownerContext.materialForArtifactGraph( frame );

		}
		return resolve( artifact, groupName, bindingName, bindingMaterial, options );

	};

}

// Module-level so every render object of a material shares one memo — the
// rebinders thread `options.frame` through, scoping reuse to a single render.
const memoizedResolveTextureBinding = createFrameScopedResolutionMemo( resolveTextureBinding );

function artifactUsesClippingUniformBuffers( artifact ) {

	const wgsl = `${ artifact && artifact.vertexShader || '' }\n${ artifact && artifact.fragmentShader || '' }`;
	return /\bclip_distances\b|\bhw_clip_distances\b|\bclipped\b|\bclipOpacity\b|\bdistanceToPlane\b/.test( wgsl );

}

// Per-artifact `(groupName, bindingName) → plan group` memo. The uniform plan
// is never mutated after load, and hydration probes the same names repeatedly
// (seeding, byte-length, required-byte-length per binding).
const _uniformGroupIndex = new WeakMap();

function findUniformGroup( artifact, groupName, bindingName ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	if ( plan.length === 0 ) return null;
	let cache = _uniformGroupIndex.get( artifact );
	if ( ! cache ) {

		cache = new Map();
		_uniformGroupIndex.set( artifact, cache );

	}

	const key = `${ groupName }::${ bindingName }`;
	if ( cache.has( key ) ) return cache.get( key );
	const group = plan.find( ( item ) => item.name === groupName || item.name === bindingName ) || null;
	cache.set( key, group );
	return group;

}

function findUniformTextureSource( artifact, groupName, bindingName ) {

	const group = findUniformGroup( artifact, groupName, bindingName );
	const texture = group && Array.isArray( group.textures )
		? group.textures.find( ( item ) => item && item.name === bindingName )
		: null;
	return texture && texture.source || null;

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

function createClippingUniformUpdateNode( entries, material, uniformBufferTargets ) {

	return {
		getUpdateType() {

			return 'object';

		},
		updateReference() {

			return this;

		},
		update( frame ) {

			const sets = clippingPlaneSetsForFrame( frame, frame && frame.material || material );
			const frameUniformBuffers = uniformBufferTargets.forFrame( frame );
			for ( const entry of entries ) {

				const binding = entry && ( frameUniformBuffers.get( entry.bindingName ) || entry.binding );
				if ( ! binding || ! binding.buffer || typeof binding.buffer.fill !== 'function' ) continue;
				const values = selectClippingPlaneArray( entry, sets );
				const buffer = binding.buffer;

				// Bumping groupNode.version forces bind-group revalidation, so only
				// commit when the plane data actually changed since last frame.
				const count = values ? Math.min( values.length, buffer.length ) : 0;
				let changed = false;
				for ( let i = 0; i < count; i ++ ) {

					if ( buffer[ i ] !== values[ i ] ) { changed = true; break; }

				}

				if ( ! changed ) {

					for ( let i = count; i < buffer.length; i ++ ) {

						if ( buffer[ i ] !== 0 ) { changed = true; break; }

					}

				}

				if ( ! changed ) continue;

				buffer.fill( 0 );
				if ( values ) buffer.set( values.subarray ? values.subarray( 0, count ) : values.slice( 0, count ) );
				if ( binding.groupNode ) binding.groupNode.version ++;

			}

		},
	};

}

function createUniformUpdateNode( artifact, uniformBuffers, material, uniformBufferTargets, materialBindingOwner ) {

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
			materialBindingOwner.stampFrame( frame );
			const generatedMaterial = generatedUpdateGroup
				? materialBindingOwner.materialForGeneratedUpdater( frame )
				: null;
			const frameUniformBuffers = uniformBufferTargets.forFrame( frame );
			for ( const group of plan ) {

				const binding = frameUniformBuffers.get( group.name );
				if ( ! binding ) continue;

				// The staging typed array survives across frames; rebuilding a DataView
				// per group per object per frame is the only allocation that scales with
				// object count. Cache it until the staging array itself is replaced.
				let view = binding.__tslpView;
				if ( ! view || binding.__tslpViewSource !== binding.buffer ) {

					view = new DataView( binding.buffer.buffer, binding.buffer.byteOffset, binding.buffer.byteLength );
					binding.__tslpView = view;
					binding.__tslpViewSource = binding.buffer;

				}
				if ( generatedUpdateGroup && generatedMaterial ) {

					generatedUpdateGroup( frame, generatedMaterial, view, 0, group.name || '' );
					writeFrozenUniformLiveSnapshots( group, view );
					writeLiveUniformSidecars( group, view );

				} else {

					writeUniformGroup( group, frame, view, frameMaterial, materialBindingOwner );

				}
				writeSkinnedBindMatrices( artifact, group, view, frame );
				updateDynamicLightUniforms( artifact, group, view, frameUniformBuffers, frame );
				recordUniformUpdateDiagnostic( artifact, group, view );
				binding.groupNode.version ++;

			}

		},
	};

}

function resolveSkinnedBindMatrixSlots( artifact ) {

	let cached = skinnedBindMatrixSlots.get( artifact );
	if ( cached !== undefined ) return cached;
	const shader = artifact && artifact.vertexShader || '';
	const bindMatch = /\b\w+\s*=\s*\(\s*object\.(\w+)\s*\*\s*vec4<f32>\(\s*(?:varyings\.)?positionLocal\b/.exec( shader );
	const inverseMatch = /\bpositionLocal\s*=\s*\(\s*object\.(\w+)\s*\*[^;]*\bskinWeight\b/.exec( shader );
	cached = bindMatch && inverseMatch && bindMatch[ 1 ] !== inverseMatch[ 1 ]
		? { bindMatrix: bindMatch[ 1 ], bindMatrixInverse: inverseMatch[ 1 ] }
		: null;
	skinnedBindMatrixSlots.set( artifact, cached );
	return cached;

}

function writeSkinnedBindMatrices( artifact, group, view, frame ) {

	if ( ! group || group.name !== 'object' ) return;
	const object = frame && frame.object;
	if ( ! object || object.isSkinnedMesh !== true ) return;
	const names = resolveSkinnedBindMatrixSlots( artifact );
	if ( ! names ) return;
	for ( const [ property, name ] of Object.entries( names ) ) {

		const matrix = object[ property ];
		const slot = ( group.slots || [] ).find( item => item && item.name === name );
		if ( ! matrix || ! matrix.elements || ! slot || slot.dtype !== 'mat4' || slot.source && slot.source.kind !== 'uniform.live' ) continue;
		writeSnapshot( view, slot.offset ?? slot.byteOffset ?? 0, { type: 'mat4', data: matrix.elements }, 'mat4' );

	}

}

function writeFrozenUniformLiveSnapshots( group, view ) {

	for ( const slot of group && group.slots || [] ) {

		const source = slot && slot.source || {};
		if ( source.kind !== 'uniform.live' || source.property ) continue;
		const value = slot && slot._liveNode && slot._liveNode.value;
		if ( slot.__tslpLiveSidecarOverlay === true && value !== null && value !== undefined ) continue;
		const snapshot = source.valueSnapshot || ( Object.prototype.hasOwnProperty.call( source, 'value' )
			? { type: source.valueType, data: source.value }
			: null );
		if ( ! snapshot ) continue;
		const offset = slot.offset ?? slot.byteOffset ?? 0;
		writeSnapshot( view, offset, snapshot, slot.dtype );

	}

}

function recordUniformUpdateDiagnostic( artifact, group, view ) {

	if ( typeof globalThis === 'undefined' || globalThis.__TSLP_DEBUG_FRAME_TEXTURES !== true ) return;
	if ( ! artifact || artifact.materialShape !== 'mesh-basic' ) return;
	const diag = globalThis.__tslpHarnessDiagnostics || ( globalThis.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
	const list = diag.uniformUpdateSamples || ( diag.uniformUpdateSamples = [] );
	if ( list.length >= 40 ) return;
	const wanted = new Set( [ 'nodeUniform1', 'nodeUniform2', 'nodeUniform3', 'nodeUniform4', 'nodeUniform8', 'nodeUniform9', 'nodeUniform10', 'nodeUniform11', 'nodeUniform13', 'nodeUniform18', 'nodeUniform19', 'nodeUniform20' ] );
	const values = {};
	for ( const slot of group && group.slots || [] ) {

		if ( ! wanted.has( slot.name ) ) continue;
		const offset = slot.offset ?? slot.byteOffset ?? 0;
		if ( slot.dtype === 'vec2' ) values[ slot.name ] = [ view.getFloat32( offset, true ), view.getFloat32( offset + 4, true ) ];
		else if ( slot.dtype === 'vec3' || slot.dtype === 'color' ) values[ slot.name ] = [ view.getFloat32( offset, true ), view.getFloat32( offset + 4, true ), view.getFloat32( offset + 8, true ) ];
		else if ( slot.dtype === 'number' || slot.dtype === 'float' ) values[ slot.name ] = view.getFloat32( offset, true );

	}
	if ( Object.keys( values ).length > 0 ) list.push( {
		name: artifact.name || artifact.sourceMaterial && artifact.sourceMaterial.name || artifact.materialShape || '',
		group: group && group.name || '',
		values,
	} );

}

function writeLiveUniformSidecars( group, view ) {

	for ( const slot of group && group.slots || [] ) {

		const source = slot && slot.source || {};
		const value = slot && slot._liveNode && slot._liveNode.value;
		if ( source.kind !== 'uniform.live' || source.property || slot.__tslpLiveSidecarOverlay !== true || value === null || value === undefined ) continue;
		const offset = slot.offset ?? slot.byteOffset ?? 0;
		writeLiveValue( view, offset, value, slot.dtype );

	}

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
