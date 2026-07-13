/**
 * Graph-free scene topology state for compiler-free replay.
 *
 * Captured render artifacts already contain environment and fog WGSL. The
 * slim renderer therefore needs only a semantic invalidation key; constructing
 * TextureNode/FogNode graphs here would retain the TSL runtime without
 * producing any shader code.
 */

import { createSceneRenderTopologySelector } from '@tsl-precompile/contract/render-selector';
import { hashArray, hashString } from './slim-replay-node-core-primitives.js';

export function createReplaySceneNodeCompatibility( manager ) {

	const cacheLib = {};
	const callHashCache = new WeakMap();
	const observedCustomNodes = new WeakMap();
	const nullLightsKey = {};

	function getCacheNode( type, object, callback, forceUpdate = false ) {

		const nodeCache = cacheLib[ type ] || ( cacheLib[ type ] = new WeakMap() );
		let node = nodeCache.get( object );
		if ( node === undefined || forceUpdate ) {

			node = callback();
			nodeCache.set( object, node );

		}
		return node;

	}

	function observeCustomNode( scene, property ) {

		if ( ! scene ) return null;
		const node = scene[ property ] || null;
		if ( ! node ) return null;
		let observed = observedCustomNodes.get( scene );
		if ( observed === undefined ) {

			observed = {};
			observedCustomNodes.set( scene, observed );

		}
		const previous = observed[ property ];
		if ( previous && previous !== node ) {

			throw new Error(
				`[tsl-precompile/slim] scene.${ property } was replaced after replay started. ` +
				'Custom scene-node topology is captured WGSL and cannot be inferred from an inert slim node. ' +
				'Recapture the scene for the new graph or keep one node instance and update only its live values.',
			);

		}
		observed[ property ] = node;
		return node;

	}

	function updateFog( scene ) {

		observeCustomNode( scene, 'fogNode' );

	}

	function updateEnvironment( scene ) {

		observeCustomNode( scene, 'environmentNode' );

	}

	function getEnvironmentNode( scene ) {

		updateEnvironment( scene );
		const node = scene && scene.environmentNode;
		return node && node.isNode === true ? node : null;

	}

	function getFogNode( scene ) {

		updateFog( scene );
		return scene && scene.fogNode || null;

	}

	function getCacheKey( scene, lightsNode ) {

		// Observe explicit custom graphs on every request so an identity swap
		// cannot hide behind the per-draw cache below.
		updateEnvironment( scene );
		updateFog( scene );

		let byLights = callHashCache.get( scene );
		if ( byLights === undefined ) {

			byLights = new WeakMap();
			callHashCache.set( scene, byLights );

		}
		const lightsKey = lightsNode || nullLightsKey;
		const callId = manager.renderer.info.calls;
		const cacheKeyData = byLights.get( lightsKey ) || {};
		if ( cacheKeyData.callId !== callId ) {

			const cacheKeyValues = [];
			if ( lightsNode ) cacheKeyValues.push( lightsNode.getCacheKey( true ) );
			cacheKeyValues.push( hashString( createSceneRenderTopologySelector( scene ) ) );
			const outputTarget = manager.renderer.getOutputRenderTarget();
			cacheKeyValues.push( outputTarget && outputTarget.multiview ? 1 : 0 );
			cacheKeyValues.push( manager.renderer.shadowMap.enabled ? 1 : 0 );
			cacheKeyValues.push( manager.renderer.shadowMap.type );
			cacheKeyData.callId = callId;
			cacheKeyData.cacheKey = hashArray( cacheKeyValues );
			byLights.set( lightsKey, cacheKeyData );

		}
		return cacheKeyData.cacheKey;

	}

	return {
		cacheLib,
		getCacheKey,
		getCacheNode,
		getEnvironmentNode,
		getFogNode,
		updateEnvironment,
		updateFog,
	};

}
