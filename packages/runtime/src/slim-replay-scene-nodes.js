/**
 * Temporary live-graph compatibility island for scene-owned nodes.
 *
 * Environment/fog cache keys remain as a temporary compatibility island.
 * Background and output passes own dedicated replay adapters and therefore no
 * longer construct live TSL graphs here.
 */

import {
	cubeTexture,
	densityFogFactor,
	fog,
	rangeFogFactor,
	reference,
	renderGroup,
	texture,
} from 'three/src/nodes/TSL.js';
import { hashArray } from 'three/src/nodes/core/NodeUtils.js';
import { error } from 'three/src/utils.js';

const cacheKeyValues = [];

export function createReplaySceneNodeCompatibility( manager ) {

	const cacheLib = {};
	const callHashCache = new WeakMap();
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

	function updateFog( scene ) {

		const sceneData = manager.get( scene );
		const sceneFog = scene.fog;
		if ( sceneFog ) {

			if ( sceneData.fog !== sceneFog ) {

				const fogNode = getCacheNode( 'fog', sceneFog, () => {

					if ( sceneFog.isFogExp2 ) {

						const color = reference( 'color', 'color', sceneFog ).setGroup( renderGroup );
						const density = reference( 'density', 'float', sceneFog ).setGroup( renderGroup );
						return fog( color, densityFogFactor( density ) );

					}
					if ( sceneFog.isFog ) {

						const color = reference( 'color', 'color', sceneFog ).setGroup( renderGroup );
						const near = reference( 'near', 'float', sceneFog ).setGroup( renderGroup );
						const far = reference( 'far', 'float', sceneFog ).setGroup( renderGroup );
						return fog( color, rangeFogFactor( near, far ) );

					}
					error( 'Renderer: Unsupported fog configuration.', sceneFog );
					return undefined;

				} );
				sceneData.fogNode = fogNode;
				sceneData.fog = sceneFog;

			}

		} else {

			delete sceneData.fogNode;
			delete sceneData.fog;

		}

	}

	function updateEnvironment( scene ) {

		const sceneData = manager.get( scene );
		const environment = scene.environment;
		if ( environment ) {

			if ( sceneData.environment !== environment ) {

				const environmentNode = getCacheNode( 'environment', environment, () => {

					if ( environment.isCubeTexture === true ) return cubeTexture( environment );
					if ( environment.isTexture === true ) return texture( environment );
					error( 'Nodes: Unsupported environment configuration.', environment );
					return undefined;

				} );
				sceneData.environmentNode = environmentNode;
				sceneData.environment = environment;

			}

		} else if ( sceneData.environmentNode ) {

			delete sceneData.environmentNode;
			delete sceneData.environment;

		}

	}

	function getEnvironmentNode( scene ) {

		updateEnvironment( scene );
		if ( scene.environmentNode && scene.environmentNode.isNode ) return scene.environmentNode;
		return manager.get( scene ).environmentNode || null;

	}

	function getFogNode( scene ) {

		updateFog( scene );
		return scene.fogNode || manager.get( scene ).fogNode || null;

	}

	function getCacheKey( scene, lightsNode ) {

		let byLights = callHashCache.get( scene );
		if ( byLights === undefined ) {

			byLights = new WeakMap();
			callHashCache.set( scene, byLights );

		}
		const lightsKey = lightsNode || nullLightsKey;
		const callId = manager.renderer.info.calls;
		const cacheKeyData = byLights.get( lightsKey ) || {};
		if ( cacheKeyData.callId !== callId ) {

			const environmentNode = getEnvironmentNode( scene );
			const fogNode = getFogNode( scene );
			if ( lightsNode ) cacheKeyValues.push( lightsNode.getCacheKey( true ) );
			if ( environmentNode ) cacheKeyValues.push( environmentNode.getCacheKey() );
			if ( fogNode ) cacheKeyValues.push( fogNode.getCacheKey() );
			const outputTarget = manager.renderer.getOutputRenderTarget();
			cacheKeyValues.push( outputTarget && outputTarget.multiview ? 1 : 0 );
			cacheKeyValues.push( manager.renderer.shadowMap.enabled ? 1 : 0 );
			cacheKeyValues.push( manager.renderer.shadowMap.type );
			cacheKeyData.callId = callId;
			cacheKeyData.cacheKey = hashArray( cacheKeyValues );
			byLights.set( lightsKey, cacheKeyData );
			cacheKeyValues.length = 0;

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
