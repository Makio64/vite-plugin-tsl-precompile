/**
 * Slim-bundle stub exports.
 *
 * Stock `three.webgpu.js` exports a `TSL` namespace (re-exports every TSL
 * helper) and a handful of other symbols (`InspectorBase`, `PassNode`, …)
 * used by three.js examples for dev-tools / post-process. Our allowlist
 * drops them because they transitively drag the node builder. But examples
 * still do `import { TSL, InspectorBase } from 'three/webgpu'` — a missing
 * named export fails at module-load, before any of the example's JS even
 * executes.
 *
 * Fix: export STUB objects so imports resolve. Any call through the stub
 * throws a clear "only precompiled materials are supported in slim mode"
 * error, matching our loud-failure policy.
 *
 * @module SlimStubs
 */

function slimMessage( name ) {

	return `[tsl-precompile/slim] ${ name }() is not available in the slim bundle. Slim mode supports only PrecompiledMaterial — the TSL builder and its auxiliary nodes are stripped at build time.`;

}

const throwSlim = ( name ) => () => {

	throw new Error( slimMessage( name ) );

};

function chainableSlimStub( name ) {

	const fn = function slimStub() {

		throw new Error( slimMessage( name ) );

	};

	return new Proxy( fn, {
		get( _target, prop ) {

			if ( prop === Symbol.toPrimitive ) return () => `[${ name } slim-stub]`;
			if ( prop === 'toString' ) return () => `[${ name } slim-stub]`;
			if ( prop === 'name' ) return name;
			if ( prop === 'then' ) return undefined;
			if ( prop === '__esModule' ) return true;
			return chainableSlimStub( `${ name }.${ String( prop ) }` );

		},
		apply() {

			throw new Error( slimMessage( name ) );

		},
		construct() {

			throw new Error( slimMessage( `new ${ name }` ) );

		},
	} );

}

function inertNodeStub() {

	const fn = function inertSlimNodeStub() { return proxy; };
	Object.defineProperty( fn, 'name', { value: '', writable: true, configurable: true } );
	const proxy = new Proxy( fn, {
		get( _target, prop ) {

			if ( prop === Symbol.toPrimitive ) return () => 0;
			if ( prop === 'toString' ) return () => '[inert slim node]';
			if ( prop === 'then' ) return undefined;
			if ( prop === 'isNode' ) return true;
			if ( prop === 'getUpdateType' ) return () => 'none';
			if ( prop === 'updateReference' ) return () => proxy;
			return proxy;

		},
		apply() { return proxy; },
		construct() { return proxy; },
	} );
	return proxy;

}

/**
 * A Proxy that pretends to be the full TSL namespace. Every property access
 * returns a function that throws with a helpful message naming the accessed
 * field. Suitable for satisfying module-load-time imports without actually
 * providing any TSL functionality.
 */
export const TSL = new Proxy( {}, {
	get( _target, prop ) {

		if ( prop === Symbol.toPrimitive ) return () => '[TSL slim-stub]';
		if ( prop === 'toString' ) return () => '[TSL slim-stub]';
		// Common introspection-friendly fallthroughs.
		if ( prop === '__esModule' ) return true;
		return chainableSlimStub( `TSL.${ String( prop ) }` );

	},
} );

/**
 * Minimal `InspectorBase` stub so examples using the three.js inspector API
 * can at least load. No-op on every method.
 */
export class InspectorBase {

	constructor() { /* no-op */ }
	attach() { /* no-op */ }
	detach() { /* no-op */ }
	setRenderer() { /* no-op */ }
	onRender() { /* no-op */ }

}

/**
 * Post-process `PassNode` stub. The slim runtime cannot author pass graphs,
 * but examples may still instantiate pass objects before RenderPipeline swaps in
 * a precompiled auxiliary material. Keep the object inert and hashable.
 */
export class PassNode {

	static COLOR = 'color';
	static DEPTH = 'depth';

	constructor( scope = PassNode.COLOR, scene = null, camera = null ) {

		this.isNode = true;
		this.isPassNode = true;
		this.scope = scope;
		this.scene = scene;
		this.camera = camera;
		this.renderTarget = {
			width: 1,
			height: 1,
			scissorTest: false,
			scissor: { set() {} },
			viewport: { set() {} },
		};
		this._previousTextures = {};
		this._mrt = null;
		this._cameraNear = { value: 0 };
		this._cameraFar = { value: 1 };

	}

	setSize( width = 1, height = 1 ) { this.renderTarget.width = width; this.renderTarget.height = height; return this; }
	toggleTexture() { return this; }
	getUpdateType() { return 'none'; }
	updateReference() { return this; }
	updateBefore() {}
	setup() { return this; }
	toVar() { return this; }
	getCacheKey() { return `slim-pass-node:Object`; }

}

/**
 * `NodeMaterial` stub — some examples import the class directly (e.g. for
 * custom-material hacks). Construction throws; users must use
 * `PrecompiledMaterial` instead.
 */
export class NodeMaterial {

	constructor() {

		throw new Error( '[tsl-precompile/slim] new NodeMaterial() is not available. Use .precompile(name) in dev and PrecompiledMaterial at runtime.' );

	}

}

/**
 * `warnOnce(msg)` — three.js re-exports this helper for examples that
 * want a throttled-console-warn. No-op is safe.
 */
const _warned = new Set();
export function warnOnce( msg ) {

	if ( _warned.has( msg ) ) return;
	_warned.add( msg );
	if ( typeof console !== 'undefined' && typeof console.warn === 'function' ) console.warn( msg );

}

/**
 * `Node` base class stub. Many examples use `Node` as the base class for
 * custom TSL derivatives; in slim mode you cannot author custom node
 * classes — all TSL paths must be precompiled — so constructing Node
 * throws. The class IS exported so `import { Node } from 'three/webgpu'`
 * succeeds, and `extends Node` subclasses load (though they throw on `new`).
 */
export class Node {

	constructor() {

		return inertNodeStub();

	}

	getUpdateType() { return 'none'; }
	updateReference() { return this; }
	toVar() { return chainableSlimStub( 'Node.toVar' ); }

}

/**
 * `NodeUpdateType` — three.js enum used to tag node update cadence.
 * Exported as a plain object so references like `NodeUpdateType.FRAME` work.
 */
export const NodeUpdateType = Object.freeze( {
	NONE: 'none',
	FRAME: 'frame',
	RENDER: 'render',
	OBJECT: 'object',
} );

/**
 * `TempNode`, `CubeMapNode` — more TSL base classes. Same rationale as Node.
 */
export class TempNode {

	constructor() {

		return inertNodeStub();

	}

	getUpdateType() { return 'none'; }
	updateReference() { return this; }
	toVar() { return chainableSlimStub( 'TempNode.toVar' ); }

}

export class CubeMapNode {

	constructor() {

		return inertNodeStub();

	}

	getUpdateType() { return 'none'; }
	updateReference() { return this; }
	toVar() { return chainableSlimStub( 'CubeMapNode.toVar' ); }

}

/**
 * `RendererUtils` — three.js exposes a namespace of renderer helper
 * functions. Ship as a throwing Proxy (same pattern as TSL).
 */
export const RendererUtils = new Proxy( {}, {
	get( _target, prop ) {

		if ( prop === Symbol.toPrimitive || prop === 'toString' ) return () => '[RendererUtils slim-stub]';
		if ( prop === '__esModule' ) return true;
		if ( prop === 'resetRendererState' ) return () => ( {} );
		if ( prop === 'restoreRendererState' ) return () => {};
		return throwSlim( `RendererUtils.${ String( prop ) }` );

	},
} );

/**
 * *NodeMaterial stubs — examples that import specific node material classes
 * hit these. Construction throws with a clear migration hint.
 */
function makeNodeMaterialStub( name ) {

	return class extends Object {

		constructor() {

			super();
			throw new Error( `[tsl-precompile/slim] new ${ name }() is not available. Build a PrecompiledMaterial via .precompile() in dev.` );

		}

	};

}

export const MeshBasicNodeMaterial = makeNodeMaterialStub( 'MeshBasicNodeMaterial' );
export const MeshStandardNodeMaterial = makeNodeMaterialStub( 'MeshStandardNodeMaterial' );
export const MeshPhysicalNodeMaterial = makeNodeMaterialStub( 'MeshPhysicalNodeMaterial' );
export const MeshLambertNodeMaterial = makeNodeMaterialStub( 'MeshLambertNodeMaterial' );
export const MeshPhongNodeMaterial = makeNodeMaterialStub( 'MeshPhongNodeMaterial' );
export const MeshToonNodeMaterial = makeNodeMaterialStub( 'MeshToonNodeMaterial' );
export const MeshNormalNodeMaterial = makeNodeMaterialStub( 'MeshNormalNodeMaterial' );
export const MeshMatcapNodeMaterial = makeNodeMaterialStub( 'MeshMatcapNodeMaterial' );
export const LineBasicNodeMaterial = makeNodeMaterialStub( 'LineBasicNodeMaterial' );
export const LineDashedNodeMaterial = makeNodeMaterialStub( 'LineDashedNodeMaterial' );
export const Line2NodeMaterial = makeNodeMaterialStub( 'Line2NodeMaterial' );
export const PointsNodeMaterial = makeNodeMaterialStub( 'PointsNodeMaterial' );
export const SpriteNodeMaterial = makeNodeMaterialStub( 'SpriteNodeMaterial' );
export const ShadowNodeMaterial = makeNodeMaterialStub( 'ShadowNodeMaterial' );
export const MeshSSSNodeMaterial = makeNodeMaterialStub( 'MeshSSSNodeMaterial' );

/**
 * `WebGLBackend` stub — slim mode is WebGPU-only, but examples still
 * import the class. Construction throws. Keeps module-load succeeding.
 */
export class WebGLBackend {

	constructor() {

		throw new Error( '[tsl-precompile/slim] WebGLBackend is stripped from the slim bundle. Remove `forceWebGL: true` or use the full three.webgpu.js.' );

	}

}

/**
 * `LightsNode` + `ShadowBaseNode` — more TSL base classes referenced by
 * example light/shadow customisations.
 */
export class LightsNode {

	constructor() {

		this.isNode = true;
		this.isLightsNode = true;

	}

	setLights() { return this; }
	getHash() { return 'slim-lights-node'; }
	getCacheKey() { return 'slim-lights-node'; }
	setup() { return this; }
	build() { return ''; }
	updateReference() { return this; }

}

export class RectAreaLightNode {

	static setLTC() {}

}

export class LightingModel {

	constructor() { /* no-op: allows custom subclasses to define before TSL use fails loudly. */ }
	start() { /* no-op */ }
	direct() { /* no-op */ }
	indirect() { /* no-op */ }
	finish() { /* no-op */ }

}

export class ShadowBaseNode {

	constructor() { throw new Error( '[tsl-precompile/slim] ShadowBaseNode is not available.' ); }

}

/**
 * Compressed-texture format constants added in recent three.js versions.
 * Plain numeric stubs so destructuring succeeds; runtime texture uploads
 * would fail upstream if actually used.
 */
export const R11_EAC_Format = 37488;
export const RG11_EAC_Format = 37490;
export const R_EAC_Signed_Format = 37489;
export const RG_EAC_Signed_Format = 37491;

/**
 * `CanvasTarget` — three.js's WebGPU canvas-target helper. Examples
 * commonly import it; slim mode provides a no-op stub that throws on use.
 */
export class CanvasTarget {

	constructor() {

		throw new Error( '[tsl-precompile/slim] CanvasTarget is not available in slim mode.' );

	}

}

/**
 * `NodeUtils` — namespace of TSL utility helpers. Same Proxy-throw pattern.
 */
export const NodeUtils = new Proxy( {}, {
	get( _target, prop ) {

		if ( prop === Symbol.toPrimitive || prop === 'toString' ) return () => '[NodeUtils slim-stub]';
		if ( prop === '__esModule' ) return true;
		return throwSlim( `NodeUtils.${ String( prop ) }` );

	},
} );
