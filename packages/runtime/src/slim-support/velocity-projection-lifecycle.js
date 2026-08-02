/**
 * Expose r185 TRAA/TAAU's unjittered projection matrix to generated velocity
 * writers for exactly the interval between setViewOffset() and
 * clearViewOffset().
 *
 * Three keeps this matrix on the temporal node, while replay's generated
 * material writer only receives the camera. A symbol is used instead of a
 * public camera property so the handoff remains private to the runtime.
 */

import { getLiveNodeDependencies } from './node-dependencies.js';
import { walkNodeGraphUnique } from './node-graph-walker.js';

export const VELOCITY_PROJECTION_MATRIX = Symbol.for( '@tsl-precompile/runtime/velocity-projection-matrix@1' );

const LIFECYCLE_STATE = Symbol.for( '@tsl-precompile/runtime/velocity-projection-lifecycle@1' );
const LIFECYCLE_SCHEMA = 'velocity-projection-lifecycle@1';
const MAX_GRAPH_DEPTH = 96;
const CAMERA_WINDOWS = new WeakMap();
const GRAPH_SKIP_KEYS = new Set( [
	'parent', 'children', '_cache', 'scene', 'camera', 'renderer',
	'geometry', 'material', 'domElement', 'prototype', 'constructor',
] );

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

function temporalNodeType( node ) {

	const constructor = readMember( node, 'constructor' );
	return readMember( constructor, 'type' ) || readMember( constructor, 'name' ) || readMember( node, 'type' ) || '';

}

function isR185TemporalProjectionNode( node ) {

	if ( ! isObjectLike( node ) ) return false;
	const type = temporalNodeType( node );
	const isTRAA = readMember( node, 'isTRAANode' ) === true || type === 'TRAANode';
	const isTAAU = readMember( node, 'isTAAUNode' ) === true || type === 'TAAUNode';
	return ( isTRAA || isTAAU )
		&& typeof readMember( node, 'setViewOffset' ) === 'function'
		&& typeof readMember( node, 'clearViewOffset' ) === 'function'
		&& isObjectLike( readMember( node, 'camera' ) )
		&& isObjectLike( readMember( node, '_originalProjectionMatrix' ) );

}

function readOwnDescriptor( target, key ) {

	try {

		return Object.getOwnPropertyDescriptor( target, key );

	} catch ( _ ) {

		return undefined;

	}

}

function writeProjectionOverride( camera, projectionMatrix ) {

	const priorDescriptor = readOwnDescriptor( camera, VELOCITY_PROJECTION_MATRIX );
	try {

		if ( priorDescriptor && priorDescriptor.configurable !== true ) {

			if ( ! Object.hasOwn( priorDescriptor, 'value' ) || priorDescriptor.writable !== true ) return null;
			if ( Reflect.set( camera, VELOCITY_PROJECTION_MATRIX, projectionMatrix ) !== true ) return null;

		} else {

			Object.defineProperty( camera, VELOCITY_PROJECTION_MATRIX, {
				value: projectionMatrix,
				configurable: true,
				enumerable: priorDescriptor ? priorDescriptor.enumerable === true : false,
				writable: true,
			} );

		}

	} catch ( _ ) {

		return null;

	}

	return {
		camera,
		priorDescriptor,
		ended: false,
	};

}

function restoreProjectionOverride( window ) {

	const { camera, priorDescriptor } = window;
	try {

		if ( priorDescriptor ) {

			if ( priorDescriptor.configurable === true ) {

				Object.defineProperty( camera, VELOCITY_PROJECTION_MATRIX, priorDescriptor );

			} else if ( Object.hasOwn( priorDescriptor, 'value' ) && priorDescriptor.writable === true ) {

				Reflect.set( camera, VELOCITY_PROJECTION_MATRIX, priorDescriptor.value );

			}

		} else {

			delete camera[ VELOCITY_PROJECTION_MATRIX ];

		}

	} catch ( _ ) {

		// Projection handoff is auxiliary state. Never replace a renderer error
		// with a cleanup error if a host freezes or seals its camera mid-frame.

	}

}

function beginProjectionWindow( node ) {

	const camera = readMember( node, 'camera' );
	const projectionMatrix = readMember( node, '_originalProjectionMatrix' );
	if ( ! isObjectLike( camera ) || ! isObjectLike( projectionMatrix ) ) return null;

	const window = writeProjectionOverride( camera, projectionMatrix );
	if ( ! window ) return null;
	let windows = CAMERA_WINDOWS.get( camera );
	if ( ! windows ) {

		windows = [];
		CAMERA_WINDOWS.set( camera, windows );

	}
	windows.push( window );
	return window;

}

function endProjectionWindow( window ) {

	if ( ! window || window.ended === true ) return;
	window.ended = true;
	const windows = CAMERA_WINDOWS.get( window.camera );
	if ( ! windows ) return;

	while ( windows.length > 0 && windows[ windows.length - 1 ].ended === true ) {

		restoreProjectionOverride( windows.pop() );

	}
	if ( windows.length === 0 ) CAMERA_WINDOWS.delete( window.camera );

}

function restoreOwnMethod( node, key, descriptor ) {

	try {

		if ( descriptor ) Object.defineProperty( node, key, descriptor );
		else delete node[ key ];

	} catch ( _ ) {

		// Installation is best-effort and only reaches extensible r185 nodes.

	}

}

function defineInstanceMethod( node, key, method, priorDescriptor ) {

	Object.defineProperty( node, key, {
		value: method,
		configurable: true,
		enumerable: priorDescriptor ? priorDescriptor.enumerable === true : false,
		writable: true,
	} );

}

function installTemporalNodeLifecycle( node ) {

	const installedState = readMember( node, LIFECYCLE_STATE );
	if ( installedState && installedState.schema === LIFECYCLE_SCHEMA ) return false;
	if ( ! isR185TemporalProjectionNode( node ) ) return false;

	const originalSetViewOffset = readMember( node, 'setViewOffset' );
	const originalClearViewOffset = readMember( node, 'clearViewOffset' );
	const setDescriptor = readOwnDescriptor( node, 'setViewOffset' );
	const clearDescriptor = readOwnDescriptor( node, 'clearViewOffset' );
	const state = {
		schema: LIFECYCLE_SCHEMA,
		windows: [],
	};

	const setViewOffset = function ( ...args ) {

		const result = originalSetViewOffset.apply( this, args );
		// Preserve one entry per successful setViewOffset(), including a null
		// entry when a non-configurable host camera cannot accept the handoff.
		state.windows.push( beginProjectionWindow( this ) );
		return result;

	};
	const clearViewOffset = function ( ...args ) {

		try {

			return originalClearViewOffset.apply( this, args );

		} finally {

			endProjectionWindow( state.windows.pop() || null );

		}

	};

	try {

		defineInstanceMethod( node, 'setViewOffset', setViewOffset, setDescriptor );
		try {

			defineInstanceMethod( node, 'clearViewOffset', clearViewOffset, clearDescriptor );
			Object.defineProperty( node, LIFECYCLE_STATE, {
				value: state,
				configurable: true,
			} );

		} catch ( error ) {

			restoreOwnMethod( node, 'setViewOffset', setDescriptor );
			restoreOwnMethod( node, 'clearViewOffset', clearDescriptor );
			throw error;

		}

	} catch ( _ ) {

		return false;

	}

	return true;

}

function appendGraphValue( stack, value, depth ) {

	if ( ! isObjectLike( value ) ) return;
	if (
		readMember( value, 'isTexture' ) === true
		|| readMember( value, 'isBufferAttribute' ) === true
		|| readMember( value, 'isInterleavedBuffer' ) === true
		|| readMember( value, 'isRenderTarget' ) === true
		|| readMember( value, 'isMaterial' ) === true
		|| readMember( value, 'isBufferGeometry' ) === true
		|| readMember( value, 'isObject3D' ) === true
	) return;
	stack.push( { value, depth } );

}

/**
 * Install the temporal projection handoff on every r185 TRAA/TAAU node
 * reachable from an output graph. The operation is cycle-safe and idempotent.
 *
 * @param {*} root
 * @return {number} number of newly wrapped temporal nodes
 */
export function installVelocityProjectionLifecycle( root ) {

	if ( ! isObjectLike( root ) ) return 0;
	const seen = new Set();
	const stack = [ { value: root, depth: 0 } ];
	let installed = 0;
	// Prefer Three's getChildren()/traverse() protocol for real TSL nodes,
	// including virtual descendants retained behind a custom iterator.
	walkNodeGraphUnique( root, ( value ) => {

		if ( installTemporalNodeLifecycle( value ) ) installed ++;

	} );

	// Retain reflective compatibility for plain wrappers, private effect
	// properties, and explicit closure-hidden dependency sidecars.
	while ( stack.length > 0 ) {

		const { value, depth } = stack.pop();
		if ( seen.has( value ) || depth > MAX_GRAPH_DEPTH ) continue;
		seen.add( value );
		if ( isR185TemporalProjectionNode( value ) ) {

			if ( installTemporalNodeLifecycle( value ) ) installed ++;

		}
		for ( const dependency of getLiveNodeDependencies( value ) ) {

			appendGraphValue( stack, dependency.node, depth + 1 );

		}

		let keys = [];
		try { keys = Object.getOwnPropertyNames( value ); } catch ( _ ) { continue; }
		for ( let index = keys.length - 1; index >= 0; index -- ) {

			const key = keys[ index ];
			if ( GRAPH_SKIP_KEYS.has( key ) ) continue;
			appendGraphValue( stack, readMember( value, key ), depth + 1 );

		}

	}

	return installed;

}
