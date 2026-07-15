/**
 * Graph-free LightsNode compatibility used by the replay renderer.
 *
 * Keep this module independent from `slim-stubs.js`: renderer lighting is a
 * core replay path, while the broad Node/TSL compatibility surface should be
 * retained only when an application imports it. Shader compilation remains
 * intentionally absent; the node only carries sorted light state and the
 * topology cache key consumed by the replay renderer.
 */

import { hashArray } from './slim-replay-node-core-primitives.js';
import { Node } from './slim-node-compat.js';

const lightsNodeHashData = [];

function numericLightId( light ) {

	return light && Number.isFinite( light.id ) ? light.id : 0;

}

export class LightsNode extends Node {

	constructor() {

		super( 'vec3' );
		this.global = true;
		this.isLightsNode = true;
		this._lights = [];
		this._lightNodes = null;
		this._lightNodesHash = null;

	}

	setLights( lights = [] ) {

		this._lights = Array.isArray( lights ) ? lights : [];
		this._lights.sort( ( a, b ) => numericLightId( a ) - numericLightId( b ) );
		this._lightNodes = null;
		this._lightNodesHash = null;
		return this;

	}

	getLights() { return this._lights; }

	get hasLights() { return this._lights.length > 0; }

	customCacheKey() {

		for ( const light of this._lights ) {

			lightsNodeHashData.push( numericLightId( light ) );
			lightsNodeHashData.push( light && light.castShadow === true ? 1 : 0 );
			if ( light && light.isSpotLight === true ) {

				lightsNodeHashData.push( light.map && Number.isFinite( light.map.id ) ? light.map.id : - 1 );
				lightsNodeHashData.push( light.colorNode && typeof light.colorNode.getCacheKey === 'function'
					? Number( light.colorNode.getCacheKey() ) || 0
					: - 1 );

			}

		}
		const cacheKey = hashArray( lightsNodeHashData );
		lightsNodeHashData.length = 0;
		return cacheKey;

	}

	getHash() { return this._lights.length === 0 ? 'slim-lights-node' : `slim-lights-node:${ this.customCacheKey() }`; }
	getCacheKey() { return this.customCacheKey(); }
	setup() { return this; }
	build() { return ''; }
	updateReference() { return this; }

}
