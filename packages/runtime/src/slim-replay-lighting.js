/**
 * Graph-free lighting registry for the compiler-free slim renderer.
 * RenderList only needs one mutable lights-state object per scene; shader
 * generation consumes the captured artifact instead of a live LightsNode.
 */

import { LightsNode } from './slim-replay-lights-node.js';

const defaultLights = /*@__PURE__*/ new LightsNode();

class Lighting {

	constructor() {

		this.enabled = true;
		this._cache = [];
		this._lightsNodes = [];
		this._lightsByScene = new WeakMap();

	}

	createNode( lights = [] ) {

		const node = new LightsNode().setLights( lights );
		this._lightsNodes.push( new WeakRef( node ) );
		return node;

	}

	getNode( scene ) {

		// QuadMesh is Three's post-processing scene and intentionally has no
		// scene-light family.
		if ( scene && scene.isQuadMesh === true ) return defaultLights;

		let node = this._lightsByScene.get( scene );
		if ( node === undefined ) {

			node = this.createNode();
			this._lightsByScene.set( scene, node );

		}
		return node;

	}

	beginRender( scene ) {

		this._cache.push( this.getNode( scene ).getLights() );

	}

	finishRender( scene ) {

		this.getNode( scene ).setLights( this._cache.pop() );

	}

	dispose() {

		for ( const ref of this._lightsNodes ) {

			const node = ref.deref();
			if ( node ) node.dispose();

		}
		this._lightsNodes.length = 0;
		this._lightsByScene = new WeakMap();

	}

}

export { Lighting, Lighting as ReplayLighting, LightsNode as ReplayLightsNode };
export default Lighting;
