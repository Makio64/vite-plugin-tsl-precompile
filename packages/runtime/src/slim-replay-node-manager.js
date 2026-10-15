/**
 * Replay-native replacement for Three's NodeManager.
 *
 * Shader compilation is absent: render/compute states are hydrated directly
 * from captured artifacts. The class keeps Three's renderer-facing lifecycle
 * and a replay-owned frame scheduler while avoiding NodeFrame,
 * NodeBuilderState, ChainMap, build queues, and every builder recovery path.
 */

import DataMap from 'three/src/renderers/common/DataMap.js';
import { RenderObjectRefreshType } from 'three/src/constants.js';
import {
	createRenderObjectContextSelector,
	RENDER_BINDING_OWNER_KINDS,
	resolveRenderObjectBindingOwner,
} from '@tsl-precompile/contract/render-selector';
import { GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR } from '@tsl-precompile/contract/variant-selector-sidecar';
import { hydrateNodeBuilderState } from './hydrator.js';
import ReplayNodeFrame from './slim-replay-node-frame.js';
import { NodeUpdateType } from './slim-replay-node-core-primitives.js';
import { getSlimRenderFallback } from './slim-support/render-fallback-registry.js';
import { normalizeSlimRenderFallbackState } from './slim-support/render-fallback-state.js';
import { createRendererRenderTargetTextureRegistry } from './slim-support/render-target-texture-registry.js';
import { createReplaySceneNodeCompatibility } from './slim-replay-scene-nodes.js';
import { createReplayPMREMResolver } from './slim-support/renderer-pmrem.js';
import { createRendererShadowScheduler } from './slim-support/renderer-shadows.js';

class ReplayNodeManager extends DataMap {

	constructor( renderer, backend ) {

		super();
		this.renderer = renderer;
		this.backend = backend;
		this.nodeFrame = new ReplayNodeFrame();
		this.nodeBuilderCache = new Map();
		this.groupsData = new WeakMap();
		this._materialIds = new WeakMap();
		this._nextMaterialId = 1;
		this._outputLayerIndexNode = { value: 0 };
		if ( renderer && typeof renderer.setRenderTarget === 'function' ) createRendererRenderTargetTextureRegistry( renderer );
		this._sceneNodes = createReplaySceneNodeCompatibility( this );
		this._resolvePMREMTexture = createReplayPMREMResolver( renderer );
		this._shadowScheduler = createRendererShadowScheduler( renderer );
		this.cacheLib = this._sceneNodes.cacheLib;

	}

	updateGroup( nodeUniformsGroup ) {

		const groupNode = nodeUniformsGroup.groupNode;
		if ( groupNode.updateType === NodeUpdateType.OBJECT ) return true;
		let byBinding = this.groupsData.get( groupNode );
		if ( byBinding === undefined ) {

			byBinding = new WeakMap();
			this.groupsData.set( groupNode, byBinding );

		}
		let groupData = byBinding.get( nodeUniformsGroup );
		if ( groupData === undefined ) {

			groupData = {};
			byBinding.set( nodeUniformsGroup, groupData );

		}
		if ( groupData.version !== groupNode.version ) {

			groupData.version = groupNode.version;
			return true;

		}
		return false;

	}

	getForRenderCacheKey( renderObject ) {

		return renderObject.initialCacheKey;

	}

	getForRender( renderObject, yieldFn = null ) {

		const renderObjectData = this.get( renderObject );
		if ( renderObjectData.nodeBuilderState !== undefined ) return renderObjectData.nodeBuilderState;
		// r187 supplies the renderer's preparation scheduler. Replay has no
		// asynchronous node builder, but must honor that barrier on a cold state.
		if ( typeof yieldFn === 'function' ) return Promise.resolve().then( yieldFn ).then( () => this.getForRender( renderObject ) );

		const material = renderObject.material;
		if ( ! material || material.isPrecompiledMaterial !== true ) {

			const fallback = getSlimRenderFallback( this.renderer );
			if ( fallback ) {

				const fallbackResult = fallback( renderObject );
				if ( fallbackResult && typeof fallbackResult.then === 'function' ) {

					throw new Error( '[tsl-precompile/slim] render fallback must return synchronously from getForRender().' );

				}
				if ( fallbackResult ) {

					const fallbackState = normalizeSlimRenderFallbackState( fallbackResult );
					renderObjectData.nodeBuilderState = fallbackState;
					renderObjectData.fallbackHandler = fallback;
					return fallbackState;

				}

			}
			throw slimOnlyMaterialError( renderObject, material );

		}

		const selection = this._createReplaySelection( renderObject );
		const cacheKey = this._createReplayCacheKey( material, selection );
		let state = this.nodeBuilderCache.get( cacheKey );
		if ( state === undefined ) {

			state = hydrateNodeBuilderState(
				material.precompiledArtifact,
				material,
				renderObject.object,
				selection,
			);
			this.nodeBuilderCache.set( cacheKey, state );

		}
		state.usedTimes ++;
		renderObjectData.nodeBuilderState = state;
		renderObjectData.nodeBuilderCacheKey = cacheKey;
		return state;

	}

	async getForRenderAsync( renderObject, yieldFn = null ) {

		return this.getForRender( renderObject, yieldFn );

	}

	getForRenderDeferred( renderObject ) {

		return this.getForRender( renderObject );

	}

	delete( object ) {

		let deleted;
		try {

			if ( object && object.isRenderObject ) {

				const data = this.get( object );
				const state = data.nodeBuilderState;
				if ( data.fallbackHandler ) {

					if ( typeof data.fallbackHandler.release === 'function' ) data.fallbackHandler.release( object );

				} else if ( state !== undefined && data.nodeBuilderCacheKey !== undefined ) {

					state.usedTimes --;
					if ( state.usedTimes <= 0 && this.nodeBuilderCache.get( data.nodeBuilderCacheKey ) === state ) {

						this.nodeBuilderCache.delete( data.nodeBuilderCacheKey );

					}

				}

			}

		} finally {

			deleted = super.delete( object );

		}
		return deleted;

	}

	getForCompute( computeNode ) {

		if ( ! computeNode || computeNode.isPrecompiledCompute !== true ) {

			throw new Error( '[tsl-precompile/slim] only PrecompiledComputeNode is supported in the slim bundle. Did you forget to wrap a compute artifact?' );

		}
		const computeData = this.get( computeNode );
		if ( computeData.nodeBuilderState !== undefined && computeData.version === computeNode.version ) return computeData.nodeBuilderState;
		const ownerFrame = computeNode.__tslpMaterialComputeFrame || null;
		const ownerMaterial = computeNode.__tslpMaterialComputeOwner || null;
		const state = hydrateNodeBuilderState(
			computeNode.precompiledArtifact,
			ownerMaterial,
			ownerFrame && ownerFrame.object || null,
			{ renderer: this.renderer },
		);
		computeData.nodeBuilderState = state;
		computeData.version = computeNode.version;
		return state;

	}

	async getForComputeAsync( computeNode ) {

		return this.getForCompute( computeNode );

	}

	_createReplaySelection( renderObject ) {

		const bindingOwner = resolveRenderObjectBindingOwner( renderObject );
		const artifact = renderObject.material && renderObject.material.precompiledArtifact;
		const auxShape = artifact && ( artifact.__tslpAuxShape || artifact.materialShape );
		const selectorProfile = auxShape === 'background' || auxShape === 'shadow-depth' || auxShape === 'post-process' || auxShape === 'render-output' || auxShape === 'cube-render-target' || auxShape === 'mesh-basic'
			? auxShape
			: null;
		const selectorAdapter = artifact && artifact[ GENERATED_VARIANT_SELECTOR_ADAPTER_SIDECAR ];
		const renderer = renderObject.renderer || this.renderer;
		let selector;
		if ( selectorAdapter && typeof selectorAdapter.create === 'function' ) {

			selector = selectorAdapter.create( renderObject, renderer, selectorProfile );

		} else {

			selector = createRenderObjectContextSelector( renderObject, renderer );
			if ( selectorAdapter && typeof selectorAdapter.project === 'function' ) selector = selectorAdapter.project( selector, selectorProfile );

		}
		return {
			cacheKey: this.getForRenderCacheKey( renderObject ),
			bindingMaterial: bindingOwner.kind === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER ? bindingOwner.material : null,
				bindingOwnerKind: bindingOwner.kind,
				renderObject,
				renderer: this.renderer,
			// Project before both cache identity and variant selection. Cube faces
			// and mip levels share one fixed conversion shader; retaining their raw
			// values here would hydrate six equivalent states before the selector
			// layer projects them away.
			renderContextSelector: selector,
			renderContextSelectorProfile: selectorProfile,
			outputLayerIndexNode: selectorProfile === 'render-output' ? this._outputLayerIndexNode : null,
			resolvePMREMTexture: this._resolvePMREMTexture,
		};

	}

	_createReplayCacheKey( material, selection ) {

		const materialId = this._getMaterialId( material );
		const bindingMaterialId = selection.bindingMaterial && selection.bindingMaterial !== material
			? this._getMaterialId( selection.bindingMaterial )
			: null;
		return JSON.stringify( [ materialId, bindingMaterialId, selection.cacheKey ?? null, selection.renderContextSelector || '' ] );

	}

	_getMaterialId( material ) {

		let materialId = this._materialIds.get( material );
		if ( materialId === undefined ) {

			materialId = this._nextMaterialId ++;
			this._materialIds.set( material, materialId );

		}
		return materialId;

	}

	getEnvironmentNode( scene ) { return this._sceneNodes.getEnvironmentNode( scene ); }
	getFogNode( scene ) { return this._sceneNodes.getFogNode( scene ); }
	getCacheKey( scene, lightsNode ) { return this._sceneNodes.getCacheKey( scene, lightsNode ); }
	getCacheNode( type, object, callback, forceUpdate = false ) { return this._sceneNodes.getCacheNode( type, object, callback, forceUpdate ); }
	updateFog( scene ) { return this._sceneNodes.updateFog( scene ); }
	updateEnvironment( scene ) { return this._sceneNodes.updateEnvironment( scene ); }

	getCustomProgramCacheKey( material, scene ) {

		// Overrides can change their node properties within one material version.
		if ( material === scene.overrideMaterial ) return material.customProgramCacheKey();
		const data = this.get( material );
		if ( data.cacheKey === undefined || data.cacheKeyVersion !== material.version ) {

			data.cacheKey = material.customProgramCacheKey();
			data.cacheKeyVersion = material.version;

		}
		return data.cacheKey;

	}

	get isToneMappingState() {

		return this.renderer.getRenderTarget() ? false : true;

	}

	getNodeFrame( renderer = this.renderer, scene = null, object = null, camera = null, material = null, compute = null ) {

		const nodeFrame = this.nodeFrame;
		nodeFrame.renderer = renderer;
		nodeFrame.scene = scene;
		nodeFrame.object = object;
		nodeFrame.camera = camera;
		nodeFrame.material = material;
		nodeFrame.compute = compute;
		nodeFrame.lightsNode = null;
		nodeFrame.renderObject = null;
		return nodeFrame;

	}

	getNodeFrameForRender( renderObject ) {

		const nodeFrame = this.getNodeFrame( renderObject.renderer, renderObject.scene, renderObject.object, renderObject.camera, renderObject.material );
		nodeFrame.lightsNode = renderObject.lightsNode || null;
		nodeFrame.renderObject = renderObject;
		return nodeFrame;

	}

	getNodeFrameForCompute( computeNode ) {

		const owner = computeNode && computeNode.__tslpMaterialComputeFrame;
		return owner
			? this.getNodeFrame( owner.renderer || this.renderer, owner.scene || null, owner.object || null, owner.camera || null, owner.material || computeNode.__tslpMaterialComputeOwner || null, computeNode )
			: this.getNodeFrame( this.renderer, null, null, null, null, computeNode );

	}

	getOutputCacheKey() {

		const renderer = this.renderer;
		return renderer.toneMapping + ',' + renderer.currentColorSpace + ',' + renderer.xr.isPresenting;

	}

	setOutputLayerIndex( index ) {

		this._outputLayerIndexNode.value = index;

	}

	updateBefore( renderObject ) {

		const state = renderObject.getNodeBuilderState();
		for ( const node of state.updateBeforeNodes || [] ) this.getNodeFrameForRender( renderObject ).updateBeforeNode( node );

	}

	updateAfter( renderObject ) {

		const state = renderObject.getNodeBuilderState();
		for ( const node of state.updateAfterNodes || [] ) this.getNodeFrameForRender( renderObject ).updateAfterNode( node );

	}

	updateForCompute( computeNode ) {

		const nodeFrame = this.getNodeFrameForCompute( computeNode );
		const state = this.getForCompute( computeNode );
		for ( const node of state.updateNodes || [] ) nodeFrame.updateNode( node );

	}

	updateBeforeForCompute( computeNode ) {

		const state = this.getForCompute( computeNode );
		for ( const node of state.updateBeforeNodes || [] ) this.getNodeFrameForCompute( computeNode ).updateBeforeNode( node );

	}

	updateAfterForCompute( computeNode ) {

		const state = this.getForCompute( computeNode );
		for ( const node of state.updateAfterNodes || [] ) this.getNodeFrameForCompute( computeNode ).updateAfterNode( node );

	}

	updateForRender( renderObject ) {

		const nodeFrame = this.getNodeFrameForRender( renderObject );
		const state = renderObject.getNodeBuilderState();
		for ( const node of state.updateNodes || [] ) nodeFrame.updateNode( node );

	}

	needsRefresh( renderObject ) {

		const refresh = renderObject.getMonitor().needsRefresh( renderObject, this.getNodeFrameForRender( renderObject ) );
		// Replay and legacy fallback observers use a boolean. Native r186/r187
		// Renderer compares numeric FULL/SHARED values rather than truthiness.
		return refresh === true ? RenderObjectRefreshType.FULL : refresh === false ? RenderObjectRefreshType.NONE : refresh;

	}

	renderShadows( scene, camera ) {

		this._shadowScheduler.render( scene, camera );

	}

	disposeRendererResources() {

		this._resolvePMREMTexture.dispose();
		this._shadowScheduler.dispose();

	}

	dispose() {

		this.disposeRendererResources();
		super.dispose();
		this.nodeFrame = new ReplayNodeFrame();
		this.nodeBuilderCache = new Map();
		this.groupsData = new WeakMap();
		this._materialIds = new WeakMap();
		this._nextMaterialId = 1;
		this._outputLayerIndexNode = { value: 0 };
		this._sceneNodes = createReplaySceneNodeCompatibility( this );
		this.cacheLib = this._sceneNodes.cacheLib;

	}

}

function slimOnlyMaterialError( renderObject, material ) {

	const materialLabel = material ? ( material.type || material.constructor && material.constructor.name || 'Material' ) : String( material );
	const object = renderObject && renderObject.object;
	const objectLabel = object ? ( object.name || object.type || object.constructor && object.constructor.name || 'Object3D' ) : 'unknown object';
	const error = new Error( '[tsl-precompile/slim] only PrecompiledMaterial is supported in the slim bundle. Got material=' + materialLabel + ' object=' + objectLabel + '. Either call .precompile() on the material at capture time, or boot a full-renderer fallback via createSlimSceneSupport({ fullRendererFallback: true }) and call await support.ensureFallback() before rendering.' );
	error.tslPrecompileSlimOnly = true;
	return error;

}

export { ReplayNodeManager };
export default ReplayNodeManager;
