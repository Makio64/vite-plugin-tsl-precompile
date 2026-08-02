/**
 * Walk a live TSL node DAG once per node.
 *
 * Three's public `Node.traverse()` recursively revisits shared descendants.
 * That is harmless for tree-shaped graphs, but large TSL DAGs can expand
 * exponentially. Prefer `getChildren()` plus an identity set, and retain a
 * narrow `traverse()` fallback for custom node-like objects that expose no
 * child iterator or inspectable node properties.
 */

function isObjectLike( value ) {

	return value !== null && ( typeof value === 'object' || typeof value === 'function' );

}

function readMember( value, key ) {

	try {

		return value[ key ];

	} catch ( _ ) {

		return undefined;

	}

}

function ownPropertyNames( value ) {

	try {

		return Object.getOwnPropertyNames( value );

	} catch ( _ ) {

		return [];

	}

}

function isNodeLike( value ) {

	if ( ! isObjectLike( value ) ) return false;
	if ( readMember( value, 'isNode' ) === true ) return true;

	for ( const key of ownPropertyNames( value ) ) {

		if ( /^is[A-Z].*Node$/.test( key ) && readMember( value, key ) === true ) return true;

	}
	// Some Three/custom `traverse()` implementations yield a lightweight
	// wrapper around the live attribute instead of a Node subclass. Those
	// wrappers are part of the observable graph and must reach visitors,
	// but their BufferAttribute payloads must not be recursively explored.
	if (
		readMember( readMember( value, 'attribute' ), 'isBufferAttribute' ) === true ||
		readMember( readMember( value, 'value' ), 'isBufferAttribute' ) === true
	) return true;
	return false;

}

function isPlainObject( value ) {

	if ( ! value || typeof value !== 'object' ) return false;
	try { return Object.getPrototypeOf( value ) === Object.prototype; } catch ( _ ) { return false; }

}

function isTerminalResource( value ) {

	return readMember( value, 'isTexture' ) === true
		|| readMember( value, 'isBufferAttribute' ) === true
		|| readMember( value, 'isInterleavedBuffer' ) === true;

}

function isGraphValue( value ) {

	return ! isTerminalResource( value ) && ( isNodeLike( value ) || isPlainObject( value ) );

}

function appendGraphValues( value, children, seenChildren ) {

	if ( seenChildren.has( value ) ) return;

	if ( Array.isArray( value ) ) {

		seenChildren.add( value );
		for ( const item of value ) appendGraphValues( item, children, seenChildren );
		return;

	}
	if ( ! isGraphValue( value ) ) return;
	seenChildren.add( value );
	children.push( value );

}

function collectNodeChildren( node ) {

	const children = [];
	const seenChildren = new Set();
	const getChildren = readMember( node, 'getChildren' );
	const traverse = readMember( node, 'traverse' );
	let traversalComplete = false;
	const appendTraverseChildren = () => {

		if ( typeof traverse !== 'function' ) return;
		try {

			traverse.call( node, ( child ) => {

				if ( child !== node ) appendGraphValues( child, children, seenChildren );

			} );
			traversalComplete = true;

		} catch ( _ ) {

			// Graph discovery is best-effort; callers decide how to handle a
			// missing live sidecar or resource.

		}

	};

	let iteratorChildCount = 0;
	if ( typeof getChildren === 'function' ) {

		try {

			const iterable = getChildren.call( node );
			if ( iterable && typeof readMember( iterable, Symbol.iterator ) === 'function' ) {

				for ( const child of iterable ) {

					iteratorChildCount ++;
					appendGraphValues( child, children, seenChildren );

				}
				traversalComplete = true;

			}

		} catch ( _ ) {

			// Custom nodes can require a builder for child introspection. The
			// reflective and traverse-only compatibility paths remain below.

		}

	}

	// A leaf iterator plus a custom traverse() can still expose virtual
	// descendants. Calling stock traverse() for a true leaf only revisits the
	// leaf and cannot trigger shared-DAG expansion.
	if ( ! traversalComplete || iteratorChildCount === 0 ) {

		appendTraverseChildren();
	}

	// Three/slim traversal APIs are authoritative. Reflecting successful nodes
	// would walk private PassNode scene/camera state and function prototypes,
	// importing resources that are not TSL graph children. Reflection remains a
	// compatibility fallback only for marker-only nodes and plain wrappers.
	if ( traversalComplete || isTerminalResource( node ) ) return children;

	for ( const key of ownPropertyNames( node ) ) {

		if ( key[ 0 ] === '_' || key === 'prototype' || key === 'constructor' ) continue;
		appendGraphValues( readMember( node, key ), children, seenChildren );

	}

	return children;

}

/**
 * @param {?Object} root
 * @param {(node: Object) => void} visit
 * @param {{ seen?: Set<Object> }} [options]
 * @return {Set<Object>} the identity set used by the walk
 */
export function walkNodeGraphUnique( root, visit, options = {} ) {

	const seen = options.seen instanceof Set ? options.seen : new Set();
	if ( ! isGraphValue( root ) ) return seen;
	const stack = [ root ];

	while ( stack.length > 0 ) {

		const node = stack.pop();
		if ( seen.has( node ) ) continue;
		seen.add( node );
		visit( node );

		const children = collectNodeChildren( node );
		for ( let index = children.length - 1; index >= 0; index -- ) {

			const child = children[ index ];
			if ( ! seen.has( child ) ) stack.push( child );

		}

	}

	return seen;

}

/**
 * Walk every live node root on a material with one shared identity set.
 * Non-enumerable roots and array/plain-object root containers are supported;
 * material resources such as BufferAttributes and typed arrays are never
 * reflected as graph containers.
 *
 * @param {?Object} material
 * @param {(node: Object) => void} visit
 * @return {Set<Object>}
 */
export function walkMaterialNodeGraphUnique( material, visit ) {

	const seen = new Set();
	if ( ! material ) return seen;
	const roots = [];
	const seenRoots = new Set();
	for ( const key of ownPropertyNames( material ) ) appendGraphValues( readMember( material, key ), roots, seenRoots );
	for ( const root of roots ) walkNodeGraphUnique( root, visit, { seen } );
	return seen;

}
