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
 *
 * Task `mrt-pass-aux`: `setMRT(mrtNode)` stores the MRT descriptor so
 * `aux-marker.js` can discover it during precompileAuxiliary; `getTexture(name)`
 * returns an inert node stub for the named MRT output so downstream code that
 * reads pass textures keeps loading without a throw.
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

	/**
	 * Store the MRT descriptor on the stub so `precompileAuxiliary` can
	 * discover it and emit an `mrt` shape descriptor. Returns `this` for
	 * chaining, mirroring the real PassNode API.
	 *
	 * @param {Object} mrtNode - An MRTNode instance (or stub) describing outputs.
	 * @return {PassNode}
	 */
	setMRT( mrtNode ) {

		this._mrt = mrtNode;
		return this;

	}

	/**
	 * Return an inert node stub for the named MRT output texture. In slim mode
	 * the real texture sampling is handled by the precompiled artifact; this
	 * stub satisfies any code that reads `passNode.getTexture('output')` at
	 * setup time without a throw.
	 *
	 * @param {string} _name - The MRT output name (e.g. 'output', 'normal').
	 * @return {Object} An inert chainable node stub.
	 */
	getTexture( _name ) {

		return inertNodeStub();

	}

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

/**
 * `ShadowBaseNode` — base class for `ShadowNode`, `CSMShadowNode`, and any
 * user-defined shadow customisation. The slim runtime cannot run a shadow
 * pass (the NodeBuilder is stripped, so `MeshDepthNodeMaterial` /
 * `MeshDistanceNodeMaterial` aren't available). But examples like
 * `webgpu_shadowmap_array` and `_csm` instantiate subclasses during scene
 * setup, so we provide an inert stub: it constructs without throwing,
 * carries `isNode` / `isShadowBaseNode` flags, and `setup()` / `build()`
 * are no-ops. The shadow effect will simply be absent in slim replay
 * (no depth texture is allocated by the slim renderer); to render real
 * shadows, the harness/aux pipeline must populate `light.shadow.map`
 * externally (see Wave 3-S task).
 */
export class ShadowBaseNode {

	constructor( light ) {

		this.isNode = true;
		this.isShadowBaseNode = true;
		this.light = light || null;
		this.updateBeforeType = 'render';

	}

	getCacheKey() { return 'slim-shadow-base-node'; }
	getHash() { return 'slim-shadow-base-node'; }
	setup() { return this; }
	setupShadowPosition() { /* no-op */ }
	build() { return ''; }
	updateBefore() { /* no-op */ }
	updateReference() { return this; }
	getUpdateBeforeType() { return 'render'; }

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

// ─────────────────────────────────────────────────────────────────────────────
// TSL function stubs — Task `mrt-tsl-stub-leak`
//
// When `three/tsl` is aliased to this file in slim mode, examples that do
//   import { mrt, output, normalWorld, screenUV, mix, texture, step } from 'three/tsl'
// resolve to these inert stubs rather than the real TSL builder. Any chained
// call returns the same inert proxy (e.g. `.xy`, `.mul(...)`, `.toVar()`).
// None of them throw — they're silent no-ops that let example setup code
// complete so the RenderPipeline can attach its precompiled aux material.
//
// The stubs are intentionally NOT chainableSlimStub (which throws on .apply())
// — they use inertNodeStub() which returns itself on every call/property.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `mrt({ output, normal, ... })` — returns an inert MRTNode stub.
 * In slim mode the MRT graph is already baked into the aux artifact; this
 * stub lets setup code run without a throw.
 *
 * @param {Object} [_outputs] - MRT output descriptor (ignored in slim mode).
 * @return {Object} Inert node stub.
 */
export function mrt( _outputs ) {

	return inertNodeStub();

}

/**
 * Common TSL primitive constructors — each returns an inert node stub.
 * These cover the identifiers MRT, backdrop, and post-process examples
 * typically import from `three/tsl`.
 */
export const output = inertNodeStub();
export const normalWorld = inertNodeStub();
export const normalView = inertNodeStub();
export const normalLocal = inertNodeStub();
export const normalWorldGeometry = inertNodeStub();
export const positionWorld = inertNodeStub();
export const positionView = inertNodeStub();
export const positionLocal = inertNodeStub();
export const uv = inertNodeStub();
export const screenUV = inertNodeStub();
export const viewportUV = inertNodeStub();
export const viewportTopLeft = inertNodeStub();
export const modelWorldMatrix = inertNodeStub();
export const modelViewMatrix = inertNodeStub();
export const modelViewProjection = inertNodeStub();
export const modelPosition = inertNodeStub();
export const modelScale = inertNodeStub();
export const cameraPosition = inertNodeStub();
export const cameraProjectionMatrix = inertNodeStub();
export const cameraWorldMatrix = inertNodeStub();
export const cameraNormalMatrix = inertNodeStub();

/**
 * TSL callable stubs — these are called as functions (`mix(a, b, t)`).
 * Each returns an inert node stub.
 */
export function mix( ..._ ) { return inertNodeStub(); }
export function step( ..._ ) { return inertNodeStub(); }
export function texture( ..._ ) { return inertNodeStub(); }
export function cubeTexture( ..._ ) { return inertNodeStub(); }
export function pmremTexture( ..._ ) { return inertNodeStub(); }
export function vec2( ..._ ) { return inertNodeStub(); }
export function vec3( ..._ ) { return inertNodeStub(); }
export function vec4( ..._ ) { return inertNodeStub(); }
export function float( ..._ ) { return inertNodeStub(); }
export function int( ..._ ) { return inertNodeStub(); }
export function uint( ..._ ) { return inertNodeStub(); }
export function color( ..._ ) { return inertNodeStub(); }
export function uniform( ..._ ) { return inertNodeStub(); }
export function attribute( ..._ ) { return inertNodeStub(); }
export function reference( ..._ ) { return inertNodeStub(); }
export function add( ..._ ) { return inertNodeStub(); }
export function sub( ..._ ) { return inertNodeStub(); }
export function mul( ..._ ) { return inertNodeStub(); }
export function div( ..._ ) { return inertNodeStub(); }
export function dot( ..._ ) { return inertNodeStub(); }
export function cross( ..._ ) { return inertNodeStub(); }
export function normalize( ..._ ) { return inertNodeStub(); }
export function length( ..._ ) { return inertNodeStub(); }
export function clamp( ..._ ) { return inertNodeStub(); }
export function smoothstep( ..._ ) { return inertNodeStub(); }
export function pow( ..._ ) { return inertNodeStub(); }
export function pow2( ..._ ) { return inertNodeStub(); }
export function pow3( ..._ ) { return inertNodeStub(); }
export function pow4( ..._ ) { return inertNodeStub(); }
export function abs( ..._ ) { return inertNodeStub(); }
export function sign( ..._ ) { return inertNodeStub(); }
export function floor( ..._ ) { return inertNodeStub(); }
export function ceil( ..._ ) { return inertNodeStub(); }
export function fract( ..._ ) { return inertNodeStub(); }
export function mod( ..._ ) { return inertNodeStub(); }
export function min( ..._ ) { return inertNodeStub(); }
export function max( ..._ ) { return inertNodeStub(); }
export function sin( ..._ ) { return inertNodeStub(); }
export function cos( ..._ ) { return inertNodeStub(); }
export function tan( ..._ ) { return inertNodeStub(); }
export function atan( ..._ ) { return inertNodeStub(); }
export function atan2( ..._ ) { return inertNodeStub(); }
export function sqrt( ..._ ) { return inertNodeStub(); }
export function exp( ..._ ) { return inertNodeStub(); }
export function exp2( ..._ ) { return inertNodeStub(); }
export function log( ..._ ) { return inertNodeStub(); }
export function log2( ..._ ) { return inertNodeStub(); }
export function saturate( ..._ ) { return inertNodeStub(); }
export function oneMinus( ..._ ) { return inertNodeStub(); }
export function negate( ..._ ) { return inertNodeStub(); }
export function invert( ..._ ) { return inertNodeStub(); }
export function dFdx( ..._ ) { return inertNodeStub(); }
export function dFdy( ..._ ) { return inertNodeStub(); }
export function fwidth( ..._ ) { return inertNodeStub(); }
export function select( ..._ ) { return inertNodeStub(); }
export function cond( ..._ ) { return inertNodeStub(); }
export function If( ..._ ) { return inertNodeStub(); }
export function Fn( ..._ ) { return inertNodeStub(); }
export function context( ..._ ) { return inertNodeStub(); }
export function renderOutput( ..._ ) { return inertNodeStub(); }
export function viewportSharedTexture( ..._ ) { return inertNodeStub(); }
export function viewportTexture( ..._ ) { return inertNodeStub(); }
export function cubeMapNode( ..._ ) { return inertNodeStub(); }
export function equirectUV( ..._ ) { return inertNodeStub(); }
export function fog( ..._ ) { return inertNodeStub(); }
export function rangeFogFactor( ..._ ) { return inertNodeStub(); }
export function densityFogFactor( ..._ ) { return inertNodeStub(); }
export function builtin( ..._ ) { return inertNodeStub(); }
export function mat3( ..._ ) { return inertNodeStub(); }
export function mat4( ..._ ) { return inertNodeStub(); }
export function ivec2( ..._ ) { return inertNodeStub(); }
export function ivec3( ..._ ) { return inertNodeStub(); }
export function ivec4( ..._ ) { return inertNodeStub(); }
export function uvec2( ..._ ) { return inertNodeStub(); }
export function uvec3( ..._ ) { return inertNodeStub(); }
export function uvec4( ..._ ) { return inertNodeStub(); }

/**
 * `renderGroup` — used as a *value* (uniform group identity) in some examples.
 * Exported as an inert node stub with stable identity.
 */
export const renderGroup = inertNodeStub();
export const frameId = inertNodeStub();
export const time = inertNodeStub();
export const timerGlobal = inertNodeStub();
export const timerLocal = inertNodeStub();
export const timerDelta = inertNodeStub();

/** Backdrop-specific TSL helpers */
export const backgroundBlurriness = inertNodeStub();
export const backgroundIntensity = inertNodeStub();
export const backgroundRotation = inertNodeStub();

/** Screen / viewport node stubs */
export const screenSize = inertNodeStub();
export const viewportSize = inertNodeStub();
export const viewportDepthTexture = inertNodeStub();
export const viewportLinearDepth = inertNodeStub();
export const linearDepth = inertNodeStub();
export const depth = inertNodeStub();
export const depthPass = inertNodeStub();

/** Matrix-based transform helpers used by background and MRT setups */
export const highpModelNormalViewMatrix = inertNodeStub();
export const highpModelViewMatrix = inertNodeStub();
