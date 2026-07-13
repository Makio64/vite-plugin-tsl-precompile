/**
 * Temporary live-graph compatibility island for scene-owned nodes.
 *
 * The replay NodeManager itself is compiler-free, but Three's stock
 * Background still asks it to turn texture backgrounds into TSL nodes. Keep
 * that exact behavior isolated here until Background gets its own replay
 * adapter. Environment/fog cache keys and the private output-node method are
 * retained for compatibility with older unsigned artifacts and Three's
 * private renderer surface.
 */

import { cubeMapNode } from 'three/src/nodes/utils/CubeMapNode.js';
import {
	cubeTexture,
	densityFogFactor,
	fog,
	pmremTexture,
	rangeFogFactor,
	reference,
	renderGroup,
	screenUV,
	texture,
} from 'three/src/nodes/TSL.js';
import { builtin } from 'three/src/nodes/accessors/BuiltinNode.js';
import {
	CubeUVReflectionMapping,
	EquirectangularReflectionMapping,
	EquirectangularRefractionMapping,
} from 'three/src/constants.js';
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

	function updateBackground( scene ) {

		const sceneData = manager.get( scene );
		const background = scene.background;
		if ( background ) {

			const forceUpdate = ( scene.backgroundBlurriness === 0 && sceneData.backgroundBlurriness > 0 )
				|| ( scene.backgroundBlurriness > 0 && sceneData.backgroundBlurriness === 0 );
			if ( sceneData.background !== background || forceUpdate ) {

				const backgroundNode = getCacheNode( 'background', background, () => {

					if ( background.isCubeTexture === true || (
						background.mapping === EquirectangularReflectionMapping
						|| background.mapping === EquirectangularRefractionMapping
						|| background.mapping === CubeUVReflectionMapping
					) ) {

						if ( scene.backgroundBlurriness > 0 || background.mapping === CubeUVReflectionMapping ) {

							return pmremTexture( background );

						}
						const envMap = background.isCubeTexture === true ? cubeTexture( background ) : texture( background );
						return cubeMapNode( envMap );

					}
					if ( background.isTexture === true ) return texture( background, screenUV.flipY() ).setUpdateMatrix( true );
					if ( background.isColor !== true ) error( 'WebGPUNodes: Unsupported background configuration.', background );
					return undefined;

				}, forceUpdate );
				sceneData.backgroundNode = backgroundNode;
				sceneData.background = background;
				sceneData.backgroundBlurriness = scene.backgroundBlurriness;

			}

		} else if ( sceneData.backgroundNode ) {

			delete sceneData.backgroundNode;
			delete sceneData.background;

		}

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

	function getBackgroundNode( scene ) {

		updateBackground( scene );
		if ( scene.backgroundNode && scene.backgroundNode.isNode ) return scene.backgroundNode;
		return manager.get( scene ).backgroundNode || null;

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

	function getOutputNode( outputTarget ) {

		const renderer = manager.renderer;
		return outputTarget.isArrayTexture
			? texture( outputTarget, screenUV ).depth( builtin( 'gl_ViewID_OVR' ) ).renderOutput( renderer.toneMapping, renderer.currentColorSpace )
			: texture( outputTarget, screenUV ).renderOutput( renderer.toneMapping, renderer.currentColorSpace );

	}

	return {
		cacheLib,
		getBackgroundNode,
		getCacheKey,
		getCacheNode,
		getEnvironmentNode,
		getFogNode,
		getOutputNode,
		updateBackground,
		updateEnvironment,
		updateFog,
	};

}

