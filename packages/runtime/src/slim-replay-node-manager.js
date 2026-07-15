/**
 * Replay-native replacement for Three's NodeManager.
 *
 * Shader compilation is absent: render/compute states are hydrated directly
 * from captured artifacts. The class keeps Three's renderer-facing lifecycle
 * and a replay-owned frame scheduler while avoiding NodeFrame,
 * NodeBuilderState, ChainMap, build queues, and every builder recovery path.
 */

import DataMap from 'three/src/renderers/common/DataMap.js';
import {
	createRenderObjectContextSelector,
	projectRenderObjectContextSelector,
	RENDER_BINDING_OWNER_KINDS,
	resolveRenderObjectBindingOwner,
} from '@tsl-precompile/contract/render-selector';
import { hydrateNodeBuilderState } from './hydrator.js';
import ReplayNodeFrame from './slim-replay-node-frame.js';
import { getSlimRenderFallback } from './slim-support/render-fallback-registry.js';
import { normalizeSlimRenderFallbackState } from './slim-support/render-fallback-state.js';
import { createReplaySceneNodeCompatibility } from './slim-replay-scene-nodes.js';

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
		this._sceneNodes = createReplaySceneNodeCompatibility( this );
		this.cacheLib = this._sceneNodes.cacheLib;

	}

	updateGroup( nodeUniformsGroup ) {

		const groupNode = nodeUniformsGroup.groupNode;
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

	getForRender( renderObject ) {

		const renderObjectData = this.get( renderObject );
		if ( renderObjectData.nodeBuilderState !== undefined ) return renderObjectData.nodeBuilderState;

		const material = renderObject.material;
		if ( ! material || material.isPrecompiledMaterial !== true ) {

			const fallback = getSlimRenderFallback();
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

	async getForRenderAsync( renderObject ) {

		return this.getForRender( renderObject );

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

		const computeData = this.get( computeNode );
		if ( computeData.nodeBuilderState !== undefined ) return computeData.nodeBuilderState;
		if ( ! computeNode || computeNode.isPrecompiledCompute !== true ) {

			throw new Error( '[tsl-precompile/slim] only PrecompiledComputeNode is supported in the slim bundle. Did you forget to wrap a compute artifact?' );

		}
		const ownerFrame = computeNode.__tslpMaterialComputeFrame || null;
		const ownerMaterial = computeNode.__tslpMaterialComputeOwner || null;
		const state = hydrateNodeBuilderState(
			computeNode.precompiledArtifact,
			ownerMaterial,
			ownerFrame && ownerFrame.object || null,
		);
		computeData.nodeBuilderState = state;
		return state;

	}

	_createReplaySelection( renderObject ) {

		const bindingOwner = resolveRenderObjectBindingOwner( renderObject );
		const selector = createRenderObjectContextSelector( renderObject, renderObject.renderer || this.renderer );
		const artifact = renderObject.material && renderObject.material.precompiledArtifact;
		const auxShape = artifact && ( artifact.__tslpAuxShape || artifact.materialShape );
		const selectorProfile = auxShape === 'background' || auxShape === 'shadow-depth' || auxShape === 'post-process' || auxShape === 'render-output' || auxShape === 'cube-render-target' || auxShape === 'mesh-basic'
			? auxShape
			: null;
		return {
			cacheKey: this.getForRenderCacheKey( renderObject ),
			bindingMaterial: bindingOwner.kind === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER ? bindingOwner.material : null,
			bindingOwnerKind: bindingOwner.kind,
			renderObject,
			// Project before both cache identity and variant selection. Cube faces
			// and mip levels share one fixed conversion shader; retaining their raw
			// values here would hydrate six equivalent states before the selector
			// layer projects them away.
			renderContextSelector: projectRenderObjectContextSelector( selector, selectorProfile ),
			renderContextSelectorProfile: selectorProfile,
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

	get isToneMappingState() {

		return this.renderer.getRenderTarget() ? false : true;

	}

	getNodeFrame( renderer = this.renderer, scene = null, object = null, camera = null, material = null ) {

		const nodeFrame = this.nodeFrame;
		nodeFrame.renderer = renderer;
		nodeFrame.scene = scene;
		nodeFrame.object = object;
		nodeFrame.camera = camera;
		nodeFrame.material = material;
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

	getOutputCacheKey() {

		const renderer = this.renderer;
		return renderer.toneMapping + ',' + renderer.currentColorSpace + ',' + renderer.xr.isPresenting;

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

		const ownerFrame = computeNode && computeNode.__tslpMaterialComputeFrame || null;
		const nodeFrame = ownerFrame
			? this.getNodeFrame(
				ownerFrame.renderer || this.renderer,
				ownerFrame.scene || null,
				ownerFrame.object || null,
				ownerFrame.camera || null,
				ownerFrame.material || computeNode.__tslpMaterialComputeOwner || null,
			)
			: this.getNodeFrame();
		const state = this.getForCompute( computeNode );
		for ( const node of state.updateNodes || [] ) nodeFrame.updateNode( node );

	}

	updateForRender( renderObject ) {

		const nodeFrame = this.getNodeFrameForRender( renderObject );
		const state = renderObject.getNodeBuilderState();
		for ( const node of state.updateNodes || [] ) nodeFrame.updateNode( node );

	}

	needsRefresh( renderObject ) {

		return renderObject.getMonitor().needsRefresh( renderObject, this.getNodeFrameForRender( renderObject ) );

	}

	dispose() {

		super.dispose();
		this.nodeFrame = new ReplayNodeFrame();
		this.nodeBuilderCache = new Map();
		this.groupsData = new WeakMap();
		this._materialIds = new WeakMap();
		this._nextMaterialId = 1;
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
