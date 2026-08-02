/**
 * Graph-free lighting registry for the compiler-free slim renderer.
 * RenderList only needs one mutable lights-state object per scene; shader
 * generation consumes the captured artifact instead of a live LightsNode.
 */

import { LightsNode } from './slim-replay-lights-node.js';

const defaultLights = /*@__PURE__*/ new LightsNode();
const lightsByScene = /*@__PURE__*/ new WeakMap();

class Lighting {

	constructor() {

		this.enabled = true;
		this._cache = [];

	}

	createNode( lights = [] ) {

		return new LightsNode().setLights( lights );

	}

	getNode( scene ) {

		// QuadMesh is Three's post-processing scene and intentionally has no
		// scene-light family.
		if ( scene && scene.isQuadMesh === true ) return defaultLights;

		let node = lightsByScene.get( scene );
		if ( node === undefined ) {

			node = this.createNode();
			lightsByScene.set( scene, node );

		}
		return node;

	}

	beginRender( scene ) {

		this._cache.push( this.getNode( scene ).getLights() );

	}

	finishRender( scene ) {

		this.getNode( scene ).setLights( this._cache.pop() );

	}

}

export { Lighting, Lighting as ReplayLighting, LightsNode as ReplayLightsNode };
export default Lighting;
