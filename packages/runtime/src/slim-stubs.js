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

import {
	BackSide,
	DepthTexture,
	FloatType,
	HalfFloatType,
	LineBasicMaterial,
	LineDashedMaterial,
	Material,
	MeshBasicMaterial,
	MeshLambertMaterial,
	MeshMatcapMaterial,
	MeshNormalMaterial,
	MeshPhongMaterial,
	MeshPhysicalMaterial,
	MeshStandardMaterial,
	MeshToonMaterial,
	PointsMaterial,
	RenderTarget,
	ShadowMaterial,
	SpriteMaterial,
	Vector2,
	Vector4,
} from 'three/src/Three.Core.js';
import StorageBufferAttribute from 'three/src/renderers/common/StorageBufferAttribute.js';
import StorageInstancedBufferAttribute from 'three/src/renderers/common/StorageInstancedBufferAttribute.js';
import { hashArray } from 'three/src/nodes/core/NodeUtils.js';
import { registerLiveUniformNode } from './slim-support/live-uniform-registry.js';
import { attachLiveNodeDependency } from './slim-support/node-dependencies.js';

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

const SLIM_NODE_CHAIN_METHODS = [
	'add', 'sub', 'mul', 'div', 'mod', 'pow', 'min', 'max', 'mix',
	'clamp', 'normalize', 'dot', 'cross', 'abs', 'sign',
	'floor', 'ceil', 'fract', 'sin', 'cos', 'tan', 'toVar', 'assign',
];

function getSlimNodeProperties( node, builder ) {

	if ( builder && typeof builder.getNodeProperties === 'function' ) return builder.getNodeProperties( node );
	if ( ! Object.prototype.hasOwnProperty.call( node, '__slimNodeProperties' ) ) {

		Object.defineProperty( node, '__slimNodeProperties', { value: {}, configurable: true } );

	}

	return node.__slimNodeProperties;

}

function slimOutputType( node, output = null ) {

	if ( typeof output === 'string' && output !== 'void' && output !== 'OutputType' ) return output;
	return node && node.nodeType || 'float';

}

function generateSlimConst( builder, type = 'float', value = null ) {

	if ( builder && typeof builder.generateConst === 'function' ) {

		try { return builder.generateConst( type, value ); } catch ( _ ) { /* fall through */ }

	}

	if ( type === 'bool' ) return value ? 'true' : 'false';
	if ( type === 'int' ) return String( Math.round( value ?? 0 ) );
	if ( type === 'uint' ) return `${ Math.max( 0, Math.round( value ?? 0 ) ) }u`;
	if ( type === 'vec2' ) return 'vec2( 0.0 )';
	if ( type === 'vec3' || type === 'color' ) return 'vec3( 0.0 )';
	if ( type === 'vec4' ) return 'vec4( 0.0 )';
	return `${ Number( value ?? 0 ).toFixed( 1 ) }`;

}

function traverseSlimNode( node, callback, seen = new Set() ) {

	if ( ! node || node.isNode !== true || seen.has( node ) ) return;
	seen.add( node );
	callback( node );

	const visitChild = ( child ) => traverseSlimNode( child, callback, seen );
	if ( Object.prototype.hasOwnProperty.call( node, '_children' ) && Array.isArray( node._children ) ) {

		for ( const child of node._children ) visitChild( child );

	}

	for ( const key of Object.getOwnPropertyNames( node ) ) {

		if ( key.startsWith( '_' ) ) continue;
		const value = node[ key ];
		if ( value && value.isNode === true ) visitChild( value );
		else if ( Array.isArray( value ) ) {

			for ( const child of value ) if ( child && child.isNode === true ) visitChild( child );

		} else if ( value && Object.getPrototypeOf( value ) === Object.prototype ) {

			for ( const child of Object.values( value ) ) if ( child && child.isNode === true ) visitChild( child );

		}

	}

}

function inertNodeStub( children = [], props = {} ) {

	const fn = function inertSlimNodeStub() { return proxy; };
	Object.defineProperty( fn, 'name', { value: '', writable: true, configurable: true } );
	Object.assign( fn, props );
	fn.isNode = true;
	fn.nodeType = fn.nodeType || 'float';
	fn.global = fn.global || false;
	fn.parents = fn.parents || false;
	fn.version = fn.version || 0;
	fn._children = children.filter( ( child ) => child && child.isNode === true );
	fn.getNodeType = ( _builder, output = null ) => slimOutputType( fn, output );
	fn.getMemberType = () => 'float';
	fn.getElementType = () => 'float';
	fn.getCacheKey = () => 'slim-inert-node';
	fn.getHash = () => 'slim-inert-node';
	fn.getScope = () => proxy;
	fn.getArrayCount = () => null;
	fn.isGlobal = () => fn.global === true;
	fn.getChildren = function* getChildren() { yield* fn._children; };
	fn.getUpdateType = () => 'none';
	fn.getUpdateBeforeType = () => 'none';
	fn.getUpdateAfterType = () => 'none';
	fn.updateReference = () => proxy;
	fn.setup = () => null;
	fn.analyze = () => {};
	fn.generate = ( builder, output = null ) => generateSlimConst( builder, slimOutputType( fn, output ) );
	fn.build = ( builder, output = null ) => fn.generate( builder, output );
	fn.dispose = () => {};
	fn.traverse = ( callback ) => traverseSlimNode( proxy, callback );
	for ( const method of SLIM_NODE_CHAIN_METHODS ) {

		fn[ method ] = ( ...args ) => inertNodeStub( [ proxy, ...args ] );

	}

	const proxy = new Proxy( fn, {
		get( target, prop ) {

			if ( prop === Symbol.toPrimitive ) return () => 0;
			if ( prop === 'toString' ) return () => '[inert slim node]';
			if ( prop === 'then' ) return undefined;
			if ( prop === 'isStackTrace' ) return false;
			if ( prop === 'message' || prop === 'stack' || prop === 'cause' ) return undefined;
			if ( prop === 'length' ) return ( ...args ) => inertNodeStub( [ proxy, ...args ] );
			if ( prop in target ) return target[ prop ];
			if ( prop === 'type' ) return '';
			if ( isMissingNodeIntrospectionProp( prop ) ) return undefined;
			if ( isMissingNodeFlagProp( prop ) ) return false;
			return proxy;

		},
		set( target, prop, value ) {

			target[ prop ] = value;
			return true;

		},
		apply() { return proxy; },
		construct() { return proxy; },
	} );
	return proxy;

}

function itemSizeFromNodeType( type ) {

	if ( typeof type !== 'string' ) return 1;
	if ( /vec4|mat2/.test( type ) ) return 4;
	if ( /vec3/.test( type ) ) return 3;
	if ( /vec2/.test( type ) ) return 2;
	return 1;

}

function nodeTypeFromAttribute( attribute, fallback = 'float' ) {

	const itemSize = attribute && attribute.itemSize || 0;
	if ( itemSize === 4 ) return 'vec4';
	if ( itemSize === 3 ) return 'vec3';
	if ( itemSize === 2 ) return 'vec2';
	return fallback;

}

function attributeCarrierNode( attribute, nodeType = null, extraProps = {} ) {

	return inertNodeStub( [], {
		isBufferAttributeNode: true,
		attribute,
		value: attribute,
		nodeType: nodeType || nodeTypeFromAttribute( attribute ),
		...extraProps,
	} );

}

function makeStorageAttribute( source, nodeType = 'float', instanced = true ) {

	if ( source && source.isBufferAttribute === true ) return source;
	const itemSize = itemSizeFromNodeType( nodeType );
	const Ctor = instanced ? StorageInstancedBufferAttribute : StorageBufferAttribute;
	if ( ArrayBuffer.isView( source ) ) return new Ctor( source, itemSize );
	const count = Math.max( 1, Number.isFinite( source ) ? Math.floor( source ) : 1 );
	return new Ctor( count, itemSize );

}

function storageCarrierNode( attribute, nodeType = null ) {

	const node = attributeCarrierNode( attribute, nodeType, {
		isStorageBufferNode: true,
		isBufferAttributeNode: true,
	} );
	node.setName = ( name ) => {

		if ( attribute ) attribute.name = name;
		node.name = name;
		return node;

	};
	node.setPBO = () => node;
	node.toReadOnly = () => node;
	node.toAttribute = () => attributeCarrierNode( attribute, node.nodeType );
	node.element = ( ...args ) => inertNodeStub( [ node, ...args ], {
		isStorageBufferNode: true,
		value: attribute,
		nodeType: node.nodeType,
	} );
	return node;

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
		if ( prop === 'builtinAOContext' ) return builtinAOContext;
		if ( prop === 'builtinShadowContext' ) return builtinShadowContext;
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
 * Post-process `PassNode` stub. The slim runtime cannot compile pass graphs,
 * but post-processing pipelines still need live render-target textures so
 * precompiled artifacts can sample the current scene pass.
 *
 * Task `mrt-pass-aux`: `setMRT(mrtNode)` stores the MRT descriptor so
 * `aux-marker.js` can discover it during precompileAuxiliary; `getTexture(name)`
 * returns a real render-target texture for the named MRT output so downstream
 * postprocess artifacts can rebind by texture name.
 */
export class PassNode {

	static COLOR = 'color';
	static DEPTH = 'depth';

	constructor( scope = PassNode.COLOR, scene = null, camera = null, options = {} ) {

		this.isNode = true;
		this.isPassNode = true;
		this.nodeType = scope === PassNode.DEPTH ? 'float' : 'vec4';
		this.updateBeforeType = NodeUpdateType.FRAME;
		this.global = true;
		this.scope = scope;
		this.scene = scene;
		this.camera = camera;
		this.options = options || {};
		this._pixelRatio = 1;
		this._width = 1;
		this._height = 1;
		this._resolutionScale = 1;
		this._viewport = null;
		this._scissor = null;
		this._layers = null;
		const depthTexture = new DepthTexture();
		depthTexture.isRenderTargetTexture = true;
		depthTexture.name = 'depth';

		const renderTarget = new RenderTarget( 1, 1, { type: HalfFloatType, ...this.options } );
		renderTarget.texture.name = 'output';
		renderTarget.depthTexture = depthTexture;

		this.renderTarget = renderTarget;
		this._textures = {
			output: renderTarget.texture,
			depth: depthTexture,
		};
		this._textureNodes = {};
		this._previousTextures = {};
		this._previousTextureNodes = {};
		this._linearDepthNodes = {};
		this._viewZNodes = {};
		this._cameraNear = uniform( 0 );
		this._cameraFar = uniform( 1 );
		this._mrt = null;
		this.overrideMaterial = null;
		this.transparent = true;
		this.opaque = true;
		this.contextNode = null;
		this._contextNodeCache = null;
		return wrapWithSlimNodeChainFallback( this );

	}

	setResolutionScale( resolutionScale ) { this._resolutionScale = resolutionScale || 1; this.setSize( this._width, this._height ); return this; }
	getResolutionScale() { return this._resolutionScale; }
	setResolution( resolution ) { return this.setResolutionScale( resolution ); }
	getResolution() { return this.getResolutionScale(); }
	setLayers( layers ) { this._layers = layers; return this; }
	getLayers() { return this._layers; }
	getUpdateType() { return 'none'; }
	getUpdateBeforeType() { return NodeUpdateType.FRAME; }
	updateReference() { return this; }
	setup( { renderer } = {} ) {

		if ( renderer ) {

			try { this.renderTarget.samples = this.options.samples === undefined ? renderer.samples : this.options.samples; } catch ( _ ) {}
			try { if ( typeof renderer.getOutputBufferType === 'function' ) this.renderTarget.texture.type = renderer.getOutputBufferType(); } catch ( _ ) {}
			try { if ( renderer.reversedDepthBuffer === true ) this.renderTarget.depthTexture.type = FloatType; } catch ( _ ) {}

		}
		return this.scope === PassNode.DEPTH ? this.getLinearDepthNode() : this.getTextureNode();

	}
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
		syncPassRenderTargetTextures( this, mrtNode );
		return this;

	}
	getMRT() { return this._mrt; }

	/**
	 * Return the live render-target texture for the named output. The shader is
	 * still precompiled, but post-processing artifacts need stable texture
	 * objects to rebind by name at runtime.
	 *
	 * @param {string} name - The MRT output name (e.g. 'output', 'normal').
	 * @return {Object} The live texture object.
	 */
	getTexture( name = 'output' ) {

		let texture = this._textures[ name ];
		if ( texture === undefined ) {

			const refTexture = this.renderTarget.texture;
			texture = refTexture && typeof refTexture.clone === 'function' ? refTexture.clone() : refTexture;
			if ( texture ) {

				texture.name = name;
				texture.isRenderTargetTexture = true;
				texture.renderTarget = this.renderTarget;

			}
			this._textures[ name ] = texture;
			if ( this.renderTarget && Array.isArray( this.renderTarget.textures ) && texture && ! this.renderTarget.textures.includes( texture ) ) {

				this.renderTarget.textures.push( texture );

			}

		}
		return texture;

	}

	getPreviousTexture( name = 'output' ) {

		let texture = this._previousTextures[ name ];
		if ( texture === undefined ) {

			const current = this.getTexture( name );
			texture = current && typeof current.clone === 'function' ? current.clone() : current;
			if ( texture ) {

				texture.name = name + '.previous';
				texture.isRenderTargetTexture = true;
				texture.renderTarget = this.renderTarget;

			}
			this._previousTextures[ name ] = texture;

		}
		return texture;

	}

	toggleTexture( name = 'output' ) {

		const prevTexture = this._previousTextures[ name ];
		if ( prevTexture === undefined ) return;
		const texture = this._textures[ name ];
		if ( this.renderTarget && Array.isArray( this.renderTarget.textures ) ) {

			const index = this.renderTarget.textures.indexOf( texture );
			if ( index >= 0 ) this.renderTarget.textures[ index ] = prevTexture;

		}
		this._textures[ name ] = prevTexture;
		this._previousTextures[ name ] = texture;
		if ( this._textureNodes[ name ] && typeof this._textureNodes[ name ].updateTexture === 'function' ) this._textureNodes[ name ].updateTexture();
		if ( this._previousTextureNodes[ name ] && typeof this._previousTextureNodes[ name ].updateTexture === 'function' ) this._previousTextureNodes[ name ].updateTexture();

	}

	getTextureNode( name = 'output' ) {

		let textureNode = this._textureNodes[ name ];
		if ( textureNode === undefined ) this._textureNodes[ name ] = textureNode = makePassTextureNode( this, name, false );
		return textureNode;

	}

	getPreviousTextureNode( name = 'output' ) {

		let textureNode = this._previousTextureNodes[ name ];
		if ( textureNode === undefined ) this._previousTextureNodes[ name ] = textureNode = makePassTextureNode( this, name, true );
		return textureNode;

	}

	getViewZNode( name = 'depth' ) {

		if ( this._viewZNodes[ name ] === undefined ) this._viewZNodes[ name ] = inertNodeStub( [ this.getTextureNode( name ), this._cameraNear, this._cameraFar ] );
		return this._viewZNodes[ name ];

	}

	getLinearDepthNode( name = 'depth' ) {

		if ( this._linearDepthNodes[ name ] === undefined ) this._linearDepthNodes[ name ] = inertNodeStub( [ this.getViewZNode( name ) ] );
		return this._linearDepthNodes[ name ];

	}

	context( ...args ) { return this.getTextureNode().context( ...args ); }

	updateBefore( frame = {} ) {

		const renderer = frame.renderer;
		const scene = this.scene;
		let camera = this.camera;
		if ( ! renderer || ! scene || ! camera ) return;

		const size = new Vector2( 1, 1 );
		try {

			if ( typeof renderer.getSize === 'function' ) renderer.getSize( size );
			else if ( typeof renderer.getDrawingBufferSize === 'function' ) renderer.getDrawingBufferSize( size );

		} catch ( _ ) {}
		try { this._pixelRatio = typeof renderer.getPixelRatio === 'function' ? renderer.getPixelRatio() : 1; } catch ( _ ) { this._pixelRatio = 1; }
		this.setSize( size.width || 1, size.height || 1 );

		let currentRenderTarget = null;
		let currentMRT = null;
		let currentAutoClear;
		let currentTransparent;
		let currentOpaque;
		let currentMask;
		let currentOverrideMaterial;
		try { currentRenderTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null; } catch ( _ ) {}
		try { currentMRT = typeof renderer.getMRT === 'function' ? renderer.getMRT() : null; } catch ( _ ) {}
		try { currentAutoClear = renderer.autoClear; } catch ( _ ) {}
		try { currentTransparent = renderer.transparent; } catch ( _ ) {}
		try { currentOpaque = renderer.opaque; } catch ( _ ) {}
		try { currentMask = camera.layers && camera.layers.mask; } catch ( _ ) {}
		try { currentOverrideMaterial = scene.overrideMaterial; } catch ( _ ) {}

		try { this._cameraNear.value = camera.near || 0; } catch ( _ ) {}
		try { this._cameraFar.value = camera.far || 1; } catch ( _ ) {}
		for ( const name in this._previousTextures ) this.toggleTexture( name );
		try { if ( this._layers !== null && camera.layers ) camera.layers.mask = this._layers.mask; } catch ( _ ) {}
		try { if ( this.overrideMaterial !== null ) scene.overrideMaterial = this.overrideMaterial; } catch ( _ ) {}

		try {

			if ( typeof renderer.setRenderTarget === 'function' ) renderer.setRenderTarget( this.renderTarget );
			if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( this._mrt );
			renderer.autoClear = true;
			renderer.transparent = this.transparent;
			renderer.opaque = this.opaque;
			if ( typeof renderer.render === 'function' ) renderer.render( scene, camera );

		} finally {

			try { scene.overrideMaterial = currentOverrideMaterial; } catch ( _ ) {}
			try { if ( typeof renderer.setRenderTarget === 'function' ) renderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
			try { if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( currentMRT ); } catch ( _ ) {}
			try { renderer.autoClear = currentAutoClear; } catch ( _ ) {}
			try { renderer.transparent = currentTransparent; } catch ( _ ) {}
			try { renderer.opaque = currentOpaque; } catch ( _ ) {}
			try { if ( camera.layers && currentMask !== undefined ) camera.layers.mask = currentMask; } catch ( _ ) {}

		}

	}

	setSize( width = 1, height = 1 ) {

		this._width = width;
		this._height = height;
		const scale = this._pixelRatio * this._resolutionScale;
		const effectiveWidth = Math.max( 1, Math.floor( width * scale ) );
		const effectiveHeight = Math.max( 1, Math.floor( height * scale ) );
		if ( this.renderTarget && typeof this.renderTarget.setSize === 'function' ) this.renderTarget.setSize( effectiveWidth, effectiveHeight );
		if ( this._scissor !== null && this.renderTarget && this.renderTarget.scissor ) {

			this.renderTarget.scissor.copy( this._scissor ).multiplyScalar( scale ).floor();
			this.renderTarget.scissorTest = true;

		} else if ( this.renderTarget ) {

			this.renderTarget.scissorTest = false;

		}
		if ( this._viewport !== null && this.renderTarget && this.renderTarget.viewport ) this.renderTarget.viewport.copy( this._viewport ).multiplyScalar( scale ).floor();
		return this;

	}

	setScissor( x, y, width, height ) {

		if ( x === null ) this._scissor = null;
		else {

			if ( this._scissor === null ) this._scissor = new Vector4();
			if ( x && x.isVector4 ) this._scissor.copy( x );
			else this._scissor.set( x, y, width, height );

		}
		return this;

	}

	setViewport( x, y, width, height ) {

		if ( x === null ) this._viewport = null;
		else {

			if ( this._viewport === null ) this._viewport = new Vector4();
			if ( x && x.isVector4 ) this._viewport.copy( x );
			else this._viewport.set( x, y, width, height );

		}
		return this;

	}

	setPixelRatio( pixelRatio ) { this._pixelRatio = pixelRatio || 1; this.setSize( this._width, this._height ); return this; }
	dispose() { try { if ( this.renderTarget && typeof this.renderTarget.dispose === 'function' ) this.renderTarget.dispose(); } catch ( _ ) {} }

}

function makePassTextureNode( passNode, name, previousTexture ) {

	const node = inertNodeStub( [], {
		isTextureNode: true,
		isPassTextureNode: true,
		isPassMultipleTextureNode: true,
		passNode,
		textureName: name,
		previousTexture: previousTexture === true,
		value: null,
		updateTexture() {

			this.value = this.previousTexture ? passNode.getPreviousTexture( name ) : passNode.getTexture( name );
			return this.value;

		},
		clone() {

			return makePassTextureNode( passNode, name, previousTexture );

		},
	} );
	node.updateTexture();
	return node;

}

function syncPassRenderTargetTextures( passNode, mrtNode ) {

	if ( ! passNode || ! passNode.renderTarget ) return;
	const outputNodes = mrtNode && ( mrtNode.outputNodes || mrtNode.outputs );
	const names = outputNodes && typeof outputNodes === 'object' ? Object.keys( outputNodes ) : [];
	if ( names.length === 0 ) return;
	const textures = names.map( ( name ) => passNode.getTexture( name ) ).filter( Boolean );
	if ( textures.length > 0 ) {

		passNode.renderTarget.textures = textures;
		passNode.renderTarget.texture = textures[ 0 ];

	}


}

/**
 * `NodeMaterial` stub — some examples import the class directly (e.g. for
 * custom-material hacks). It behaves like a lightweight material shell so
 * transformed `.precompile()` calls can wrap or adopt it before render.
 */
export class NodeMaterial extends Material {

	constructor( params = undefined ) {

		super();
		this.isNodeMaterial = true;
		this.type = 'NodeMaterial';
		if ( params && typeof params === 'object' ) this.setValues( params );

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
 * `Node` base class stub. Custom subclasses still need to exist at replay
 * time because their update hooks can drive `uniform.live` values captured
 * in the precompiled artifact. This lightweight class preserves graph shape
 * and update metadata without pulling in the real TSL builder.
 */
// Wrap a Node-like instance so unknown property access — swizzles (`.xy`,
// `.r`), addon-shader-graph helpers (`.negate()`), and other methods we
// haven't hand-stubbed — return an inert node stub instead of throwing.
// Lets addon objects like WaterMesh build their TSL graphs in slim mode
// without per-method stubs (e.g. `this.sunDirection.negate()` in WaterMesh's
// constructor).
function wrapWithSlimNodeChainFallback( instance ) {

	return new Proxy( instance, {
		get( target, prop, receiver ) {

			if ( typeof prop === 'symbol' ) return Reflect.get( target, prop, target );
			if ( prop === 'then' ) return undefined;
			if ( prop === 'isStackTrace' ) return false;
			if ( prop === 'message' || prop === 'stack' || prop === 'cause' ) return undefined;
			if ( prop === 'type' && ! ( prop in target ) ) return '';
			if ( prop in target ) return Reflect.get( target, prop, receiver );
			if ( isMissingNodeIntrospectionProp( prop ) ) return undefined;
			if ( isMissingNodeFlagProp( prop ) ) return false;
			return inertNodeStub( [ target ] );

		},
	} );

}

function isMissingNodeIntrospectionProp( prop ) {

	return typeof prop === 'string'
		&& ( prop.charCodeAt( 0 ) === 95
			|| prop === 'updateBefore'
			|| prop === 'updateAfter'
			|| prop === 'onBeforeRender'
			|| prop === 'onAfterRender' );

}

function isMissingNodeFlagProp( prop ) {

	return typeof prop === 'string' && /^is[A-Z]/.test( prop );

}

export class Node {

	constructor( nodeType = null ) {

		this.nodeType = nodeType;
			this.updateType = NodeUpdateType.NONE;
			this.updateBeforeType = NodeUpdateType.NONE;
			this.updateAfterType = NodeUpdateType.NONE;
			this.version = 0;
			this.name = '';
			this.global = false;
			this.parents = false;
			this.isNode = true;
			this._beforeNodes = null;
			return wrapWithSlimNodeChainFallback( this );

		}

	getNodeType( builder, output = null ) {

		const outputNode = getSlimNodeProperties( this, builder ).outputNode;
		if ( outputNode && outputNode !== this && typeof outputNode.getNodeType === 'function' ) return outputNode.getNodeType( builder, output );
		return slimOutputType( this, output );

	}

	getMemberType() { return 'float'; }
	getElementType() { return 'float'; }
	getCacheKey() { return this.getHash(); }
	getHash() { return `slim-node:${ this.constructor && this.constructor.name || 'Node' }:${ this.nodeType || 'float' }`; }
	getScope() { return this; }
	getArrayCount() { return null; }
	isGlobal() { return this.global === true; }
	* getChildren() {

		const properties = getSlimNodeProperties( this, null );
		for ( const childNode of Object.values( properties ) ) {

			if ( childNode && childNode.isNode === true ) yield childNode;

		}

	}
	getUpdateType() { return this.updateType || NodeUpdateType.NONE; }
	getUpdateBeforeType() { return this.updateBeforeType || NodeUpdateType.NONE; }
	getUpdateAfterType() { return this.updateAfterType || NodeUpdateType.NONE; }
	updateReference() { return this; }
	setup() { return null; }
	analyze( builder, output = null ) {

		const outputNode = getSlimNodeProperties( this, builder ).outputNode;
		if ( outputNode && outputNode !== this && typeof outputNode.build === 'function' ) outputNode.build( builder, output );

	}

	generate( builder, output = null ) {

		const outputNode = getSlimNodeProperties( this, builder ).outputNode;
		if ( outputNode && outputNode !== this && typeof outputNode.build === 'function' ) return outputNode.build( builder, output );
		return generateSlimConst( builder, slimOutputType( this, output ) );

	}

	build( builder, output = null ) {

		const properties = getSlimNodeProperties( this, builder );
		const buildStage = builder && typeof builder.getBuildStage === 'function' ? builder.getBuildStage() : null;

		const ensureSetup = () => {

			if ( properties.initialized === true ) return;
			properties.initialized = true;
			const outputNode = this.setup( builder );
			if ( outputNode && outputNode !== this ) properties.outputNode = outputNode;

		};

		if ( buildStage === 'setup' ) {

			ensureSetup();
			return properties.outputNode || null;

		}

		if ( properties.initialized !== true ) {

			if ( builder && typeof builder.setBuildStage === 'function' && buildStage ) {

				try {

					builder.setBuildStage( 'setup' );
					ensureSetup();

				} finally {

					builder.setBuildStage( buildStage );

				}

			} else {

				ensureSetup();

			}

		}

		if ( buildStage === 'analyze' ) {

			this.analyze( builder, output );
			return null;

		}

		return this.generate( builder, output );

	}

	dispose() {}
	traverse( callback ) { traverseSlimNode( this, callback ); }
	toVar() { return inertNodeStub( [ this ] ); }
	add( ...args ) { return inertNodeStub( [ this, ...args ] ); }
	sub( ...args ) { return inertNodeStub( [ this, ...args ] ); }
	mul( ...args ) { return inertNodeStub( [ this, ...args ] ); }
	div( ...args ) { return inertNodeStub( [ this, ...args ] ); }

}

class UniformNode extends Node {

	constructor( value, nodeType = null ) {

		super( nodeType );
		this.isUniformNode = true;
		this.value = value;
		this.name = '';
		this.groupNode = null;

	}

	setName( name ) { this.name = name; return this; }
	label( name ) { return this.setName( name ); }
	setGroup( group ) { this.groupNode = group; return this; }

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

	constructor( nodeType = null ) {

		this.nodeType = nodeType;
		this.updateType = NodeUpdateType.NONE;
		this.updateBeforeType = NodeUpdateType.NONE;
		this.updateAfterType = NodeUpdateType.NONE;
		this.version = 0;
		this.name = '';
		this.global = false;
		this.parents = false;
		this.isNode = true;
		return wrapWithSlimNodeChainFallback( this );

	}

	getUpdateType() { return 'none'; }
	getUpdateBeforeType() { return this.updateBeforeType || 'none'; }
	getUpdateAfterType() { return this.updateAfterType || 'none'; }
	getNodeType( _builder, output = null ) { return slimOutputType( this, output ); }
	getHash() { return `slim-temp-node:${ this.constructor && this.constructor.name || 'TempNode' }:${ this.nodeType || 'float' }`; }
	getCacheKey() { return this.getHash(); }
	updateReference() { return this; }
	setup() { return null; }
	build( builder, output = null ) { return this.generate( builder, output ); }
	generate( builder, output = null ) { return generateSlimConst( builder, slimOutputType( this, output ) ); }
	dispose() {}
	traverse( callback ) { traverseSlimNode( this, callback ); }
	toVar() { return inertNodeStub( [ this ] ); }

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
			if ( prop === 'resetRendererAndSceneState' ) return () => ( {} );
			if ( prop === 'restoreRendererAndSceneState' ) return () => {};
			return throwSlim( `RendererUtils.${ String( prop ) }` );

	},
} );

/**
 * *NodeMaterial stubs — examples construct these before the transformed
 * `.precompile()` call runs. Use the nearest non-node material base so
 * constructor params (`color`, `roughness`, maps, render state...) survive
 * until `__applyPrecompiled()` copies them onto the precompiled wrapper.
 */
function makeNodeMaterialStub( name, Base = Material ) {

	return class extends Base {

			constructor( params = undefined ) {

				super( params );
				this.isNodeMaterial = true;
				this[ `is${ name }` ] = true;
				this.type = name;

			}

	};

}

export const MeshBasicNodeMaterial = makeNodeMaterialStub( 'MeshBasicNodeMaterial', MeshBasicMaterial );
export const MeshStandardNodeMaterial = makeNodeMaterialStub( 'MeshStandardNodeMaterial', MeshStandardMaterial );
export const MeshPhysicalNodeMaterial = makeNodeMaterialStub( 'MeshPhysicalNodeMaterial', MeshPhysicalMaterial );
export const MeshLambertNodeMaterial = makeNodeMaterialStub( 'MeshLambertNodeMaterial', MeshLambertMaterial );
export const MeshPhongNodeMaterial = makeNodeMaterialStub( 'MeshPhongNodeMaterial', MeshPhongMaterial );
export const MeshToonNodeMaterial = makeNodeMaterialStub( 'MeshToonNodeMaterial', MeshToonMaterial );
export const MeshNormalNodeMaterial = makeNodeMaterialStub( 'MeshNormalNodeMaterial', MeshNormalMaterial );
export const MeshMatcapNodeMaterial = makeNodeMaterialStub( 'MeshMatcapNodeMaterial', MeshMatcapMaterial );
export const LineBasicNodeMaterial = makeNodeMaterialStub( 'LineBasicNodeMaterial', LineBasicMaterial );
export const LineDashedNodeMaterial = makeNodeMaterialStub( 'LineDashedNodeMaterial', LineDashedMaterial );
export const Line2NodeMaterial = makeNodeMaterialStub( 'Line2NodeMaterial', LineBasicMaterial );
export const PointsNodeMaterial = makeNodeMaterialStub( 'PointsNodeMaterial', PointsMaterial );
export const SpriteNodeMaterial = makeNodeMaterialStub( 'SpriteNodeMaterial', SpriteMaterial );
export const ShadowNodeMaterial = makeNodeMaterialStub( 'ShadowNodeMaterial', ShadowMaterial );
export const MeshSSSNodeMaterial = makeNodeMaterialStub( 'MeshSSSNodeMaterial', MeshPhysicalMaterial );

export class VolumeNodeMaterial extends NodeMaterial {

	constructor( params = undefined ) {

		super();
		this.isVolumeNodeMaterial = true;
		this.type = 'VolumeNodeMaterial';
		this.steps = 25;
		this.offsetNode = null;
		this.scatteringNode = null;
		this.lights = true;
		this.transparent = true;
		this.side = BackSide;
		this.depthTest = false;
		this.depthWrite = false;
		if ( params && typeof params === 'object' ) this.setValues( params );

	}

}

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
const lightsNodeHashData = [];

export class LightsNode extends Node {

	constructor() {

		super( 'vec3' );
		this.isNode = true;
		this.isLightsNode = true;
		this.global = true;
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

function numericLightId( light ) {

	return light && Number.isFinite( light.id ) ? light.id : 0;

}

export class RectAreaLightNode {

	static setLTC() {}

	constructor() {

		this.isNode = true;
		this.isRectAreaLightNode = true;
		return wrapWithSlimNodeChainFallback( this );

	}

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
export class ShadowBaseNode extends Node {

	constructor( light ) {

		super( 'float' );
		this.isShadowBaseNode = true;
		this.light = light || null;
		this.updateBeforeType = NodeUpdateType.RENDER;

	}

	getCacheKey() { return 'slim-shadow-base-node'; }
	getHash() { return 'slim-shadow-base-node'; }
	setup() { return null; }
	setupShadowPosition() { /* no-op */ }
	generate( builder, output = null ) { return generateSlimConst( builder, slimOutputType( this, output ), 1 ); }
	updateBefore() { /* no-op */ }
	updateReference() { return this; }
	getUpdateBeforeType() { return NodeUpdateType.RENDER; }

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

	return inertNodeStub( [], {
		isMRTNode: true,
		outputNodes: _outputs && typeof _outputs === 'object' ? _outputs : {},
		outputs: _outputs && typeof _outputs === 'object' ? _outputs : {},
	} );

}

export function pass( scene, camera, options ) {

	return new PassNode( PassNode.COLOR, scene || null, camera || null, options || {} );

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
export const PI = inertNodeStub();

/**
 * TSL callable stubs — these are called as functions (`mix(a, b, t)`).
 * Each returns an inert node stub.
 */
export function mix( ...args ) { return inertNodeStub( args ); }
export function step( ...args ) { return inertNodeStub( args ); }
export function texture( source, ...args ) { return inertNodeStub( [ source, ...args ], source && source.isTexture === true ? { isTextureNode: true, value: source } : {} ); }
export function cubeTexture( source, ...args ) { return inertNodeStub( [ source, ...args ], source && source.isTexture === true ? { isTextureNode: true, value: source } : {} ); }
export function passTexture( passNode, textureValue ) {

	return inertNodeStub( [], {
		isTextureNode: true,
		isPassTextureNode: true,
		passNode: passNode || null,
		value: textureValue || null,
	} );

}
// Retain the source texture passed to pmremTexture(map, ...) so the e2e
// harness (and any production wiring code) can recover it and run
// PMREMGenerator on the same cubemap/equirect at replay time. The slim
// stub itself is otherwise inert.
const __pmremStubSources = new WeakMap();
export function pmremTexture( source, ..._ ) {

	const stub = inertNodeStub();
	if ( source && ( source.isTexture === true || source.isCubeTexture === true ) ) __pmremStubSources.set( stub, source );
	return stub;

}
export function __getPmremStubSource( stub ) { return __pmremStubSources.get( stub ); }
export function vec2( ...args ) { return inertNodeStub( args ); }
export function vec3( ...args ) { return inertNodeStub( args ); }
export function vec4( ...args ) { return inertNodeStub( args ); }
export function float( ...args ) { return inertNodeStub( args ); }
export function int( ...args ) { return inertNodeStub( args ); }
export function uint( ...args ) { return inertNodeStub( args ); }
export function bool( ...args ) { return inertNodeStub( args ); }
export function color( ...args ) { return inertNodeStub( args ); }
export function uniform( value, nodeType = null ) { return registerLiveUniformNode( new UniformNode( value, nodeType ) ); }
export function uniformArray( values = [] ) {

	const node = inertNodeStub( [], { values: Array.isArray( values ) ? values : [] } );
	node.element = () => inertNodeStub();
	return node;

}
export function nodeObject( value ) { return value && value.isNode === true ? value : inertNodeStub(); }
export function attribute( ...args ) { return inertNodeStub( args ); }
export function bufferAttribute( attribute, nodeType = null ) { return attributeCarrierNode( attribute, nodeType ); }
export function instancedBufferAttribute( attribute, nodeType = null ) { return attributeCarrierNode( attribute, nodeType ); }
export function storageBufferAttribute( attribute, nodeType = null ) { return storageCarrierNode( attribute, nodeType ); }
export function instancedArray( source, nodeType = 'float' ) { return storageCarrierNode( makeStorageAttribute( source, nodeType, true ), nodeType ); }
export function storage( source, nodeType = 'float' ) { return storageCarrierNode( makeStorageAttribute( source, nodeType, false ), nodeType ); }
export function reference( ...args ) { return inertNodeStub( args ); }
export function add( ...args ) { return inertNodeStub( args ); }
export function sub( ...args ) { return inertNodeStub( args ); }
export function mul( ...args ) { return inertNodeStub( args ); }
export function div( ...args ) { return inertNodeStub( args ); }
export function dot( ...args ) { return inertNodeStub( args ); }
export function cross( ...args ) { return inertNodeStub( args ); }
export function normalize( ...args ) { return inertNodeStub( args ); }
export function length( ...args ) { return inertNodeStub( args ); }
export function clamp( ...args ) { return inertNodeStub( args ); }
export function smoothstep( ...args ) { return inertNodeStub( args ); }
export function pow( ...args ) { return inertNodeStub( args ); }
export function pow2( ...args ) { return inertNodeStub( args ); }
export function pow3( ...args ) { return inertNodeStub( args ); }
export function pow4( ...args ) { return inertNodeStub( args ); }
export function abs( ...args ) { return inertNodeStub( args ); }
export function sign( ...args ) { return inertNodeStub( args ); }
export function floor( ...args ) { return inertNodeStub( args ); }
export function ceil( ...args ) { return inertNodeStub( args ); }
export function fract( ...args ) { return inertNodeStub( args ); }
export function mod( ...args ) { return inertNodeStub( args ); }
export function min( ...args ) { return inertNodeStub( args ); }
export function max( ...args ) { return inertNodeStub( args ); }
export function sin( ...args ) { return inertNodeStub( args ); }
export function cos( ...args ) { return inertNodeStub( args ); }
export function tan( ...args ) { return inertNodeStub( args ); }
export function atan( ...args ) { return inertNodeStub( args ); }
export function atan2( ...args ) { return inertNodeStub( args ); }
export function acos( ...args ) { return inertNodeStub( args ); }
export function sqrt( ...args ) { return inertNodeStub( args ); }
export function exp( ...args ) { return inertNodeStub( args ); }
export function exp2( ...args ) { return inertNodeStub( args ); }
export function log( ...args ) { return inertNodeStub( args ); }
export function log2( ...args ) { return inertNodeStub( args ); }
export function saturate( ...args ) { return inertNodeStub( args ); }
export function oneMinus( ...args ) { return inertNodeStub( args ); }
export function negate( ...args ) { return inertNodeStub( args ); }
export function invert( ...args ) { return inertNodeStub( args ); }
export function dFdx( ...args ) { return inertNodeStub( args ); }
export function dFdy( ...args ) { return inertNodeStub( args ); }
export function fwidth( ...args ) { return inertNodeStub( args ); }
export function select( ...args ) { return inertNodeStub( args ); }
export function cond( ...args ) { return inertNodeStub( args ); }
export function If( ...args ) { return inertNodeStub( args ); }
export function Loop( ...args ) { return inertNodeStub( args ); }
export function Break( ...args ) { return inertNodeStub( args ); }
export function Fn( ...args ) { return inertNodeStub( args ); }
export function context( ...args ) { return inertNodeStub( args ); }
export function renderOutput( ...args ) { return inertNodeStub( args ); }
export function convertToTexture( node, ..._ ) {

	if ( node && ( node.isSampleNode === true || node.isTextureNode === true ) ) return node;
	if ( node && node.isPassNode === true && typeof node.getTextureNode === 'function' ) return node.getTextureNode();
	return inertNodeStub( [ node ] );

}
export function viewportSharedTexture( ...args ) { return inertNodeStub( args ); }
export function viewportTexture( ...args ) { return inertNodeStub( args ); }
export function cubeMapNode( ...args ) { return inertNodeStub( args ); }
export function equirectUV( ...args ) { return inertNodeStub( args ); }
export function fog( ...args ) { return inertNodeStub( args ); }
export function rangeFogFactor( ...args ) { return inertNodeStub( args ); }
export function densityFogFactor( ...args ) { return inertNodeStub( args ); }
export function logarithmicDepthToViewZ( ...args ) { return inertNodeStub( args ); }
export function viewZToPerspectiveDepth( ...args ) { return inertNodeStub( args ); }
export function getNormalFromDepth( ...args ) { return inertNodeStub( args ); }
export function getScreenPosition( ...args ) { return inertNodeStub( args ); }
export function getViewPosition( ...args ) { return inertNodeStub( args ); }
export function textureSize( ...args ) { return inertNodeStub( args ); }
export function luminance( ...args ) { return inertNodeStub( args ); }
export function builtin( ...args ) { return inertNodeStub( args ); }
export function builtinAOContext( aoNode, node = null ) {

	return attachLiveNodeDependency( inertNodeStub( node ? [ node ] : [] ), aoNode, { role: 'ambient-occlusion' } );

}
export function builtinShadowContext( shadowNode, light = null, node = null ) {

	return attachLiveNodeDependency( inertNodeStub( node ? [ node ] : [] ), shadowNode, { role: 'shadow', light } );

}
export function mat3( ...args ) { return inertNodeStub( args ); }
export function mat4( ...args ) { return inertNodeStub( args ); }
export function ivec2( ...args ) { return inertNodeStub( args ); }
export function ivec3( ...args ) { return inertNodeStub( args ); }
export function ivec4( ...args ) { return inertNodeStub( args ); }
export function uvec2( ...args ) { return inertNodeStub( args ); }
export function uvec3( ...args ) { return inertNodeStub( args ); }
export function uvec4( ...args ) { return inertNodeStub( args ); }
export function varyingProperty( ...args ) { return inertNodeStub( args ); }
export function OnMaterialUpdate( ...args ) { return inertNodeStub( args ); }
export function reflect( ...args ) { return inertNodeStub( args ); }
export function reflector( ...args ) { return inertNodeStub( args ); }

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
