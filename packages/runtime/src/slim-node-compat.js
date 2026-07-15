/**
 * Graph-free Node compatibility primitives shared by replay-owned adapters
 * and the broad slim TSL stub surface. This module deliberately has no Three
 * imports and cannot recover NodeBuilder or shader compilation.
 */

const SLIM_NODE_CHAIN_METHODS = [
	'add', 'sub', 'mul', 'div', 'mod', 'pow', 'min', 'max', 'mix',
	'clamp', 'normalize', 'dot', 'cross', 'abs', 'sign',
	'floor', 'ceil', 'fract', 'sin', 'cos', 'tan', 'toVar', 'assign',
];

export const NodeUpdateType = Object.freeze( {
	NONE: 'none',
	FRAME: 'frame',
	RENDER: 'render',
	OBJECT: 'object',
} );

function getSlimNodeProperties( node, builder ) {

	if ( builder && typeof builder.getNodeProperties === 'function' ) return builder.getNodeProperties( node );
	if ( ! Object.prototype.hasOwnProperty.call( node, '__slimNodeProperties' ) ) {

		Object.defineProperty( node, '__slimNodeProperties', { value: {}, configurable: true } );

	}

	return node.__slimNodeProperties;

}

export function slimOutputType( node, output = null ) {

	if ( typeof output === 'string' && output !== 'void' && output !== 'OutputType' ) return output;
	return node && node.nodeType || 'float';

}

export function generateSlimConst( builder, type = 'float', value = null ) {

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

export function traverseSlimNode( node, callback, seen = new Set() ) {

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

export function inertNodeStub( children = [], props = {} ) {

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

export function wrapWithSlimNodeChainFallback( instance ) {

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
