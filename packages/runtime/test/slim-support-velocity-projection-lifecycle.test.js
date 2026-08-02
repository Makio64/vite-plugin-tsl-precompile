import test from 'node:test';
import assert from 'node:assert/strict';

import {
	VELOCITY_PROJECTION_MATRIX,
	installVelocityProjectionLifecycle,
} from '../src/slim-support/velocity-projection-lifecycle.js';
import { attachLiveNodeDependency } from '../src/slim-support/node-dependencies.js';

function makeTemporalNode( type, options = {} ) {

	const camera = options.camera || {};
	const events = options.events || [];
	return {
		constructor: { type },
		[ type === 'TRAANode' ? 'isTRAANode' : 'isTAAUNode' ]: true,
		camera,
		_originalProjectionMatrix: options.projectionMatrix || { name: type + ':projection' },
		setViewOffset() {

			events.push( type + ':set' );
			if ( options.setError ) throw options.setError;

		},
		clearViewOffset() {

			events.push( type + ':clear' );
			if ( typeof options.onClear === 'function' ) options.onClear( this );
			if ( options.clearError ) throw options.clearError;

		},
	};

}

test( 'walks cyclic output graphs and installs TRAA/TAAU instance lifecycles idempotently', () => {

	const traa = makeTemporalNode( 'TRAANode' );
	const taau = makeTemporalNode( 'TAAUNode' );
	traa.beautyNode = taau;
	const lookalike = {
		type: 'OtherNode',
		camera: {},
		_originalProjectionMatrix: {},
		setViewOffset() {},
		clearViewOffset() {},
	};
	const originalLookalikeSet = lookalike.setViewOffset;
	const root = {
		left: { _temporal: traa },
		right: [ lookalike ],
	};
	const hiddenTAAU = makeTemporalNode( 'TAAUNode' );
	attachLiveNodeDependency( root, hiddenTAAU, { role: 'closure-hidden-temporal-effect' } );
	const virtualTRAA = makeTemporalNode( 'TRAANode' );
	root.virtualGraph = {
		isNode: true,
		getChildren() {

			return [ virtualTRAA ];

		},
	};
	root.cycle = root;
	root.right.push( root.right );

	assert.equal( installVelocityProjectionLifecycle( root ), 4 );
	const wrappedTRAASet = traa.setViewOffset;
	const wrappedTAAUSet = taau.setViewOffset;
	const wrappedHiddenTAAUSet = hiddenTAAU.setViewOffset;
	const wrappedVirtualTRAASet = virtualTRAA.setViewOffset;
	assert.equal( installVelocityProjectionLifecycle( root ), 0 );
	assert.equal( traa.setViewOffset, wrappedTRAASet );
	assert.equal( taau.setViewOffset, wrappedTAAUSet );
	assert.equal( hiddenTAAU.setViewOffset, wrappedHiddenTAAUSet );
	assert.equal( virtualTRAA.setViewOffset, wrappedVirtualTRAASet );
	assert.equal( lookalike.setViewOffset, originalLookalikeSet );

} );

test( 'publishes only inside the jitter window and restores inherited or own camera state', () => {

	const inheritedProjection = { name: 'inherited' };
	const cameraPrototype = { [ VELOCITY_PROJECTION_MATRIX ]: inheritedProjection };
	const camera = Object.create( cameraPrototype );
	const projectionMatrix = { name: 'unjittered' };
	const node = makeTemporalNode( 'TRAANode', { camera, projectionMatrix } );

	assert.equal( installVelocityProjectionLifecycle( node ), 1 );
	assert.equal( Object.hasOwn( camera, VELOCITY_PROJECTION_MATRIX ), false );
	node.setViewOffset();
	assert.equal( Object.hasOwn( camera, VELOCITY_PROJECTION_MATRIX ), true );
	assert.equal( camera[ VELOCITY_PROJECTION_MATRIX ], projectionMatrix );
	node.clearViewOffset();
	assert.equal( Object.hasOwn( camera, VELOCITY_PROJECTION_MATRIX ), false );
	assert.equal( camera[ VELOCITY_PROJECTION_MATRIX ], inheritedProjection );

	const priorProjection = { name: 'prior-own' };
	Object.defineProperty( camera, VELOCITY_PROJECTION_MATRIX, {
		value: priorProjection,
		configurable: true,
		enumerable: true,
		writable: false,
	} );
	const priorDescriptor = Object.getOwnPropertyDescriptor( camera, VELOCITY_PROJECTION_MATRIX );
	node.setViewOffset();
	assert.equal( camera[ VELOCITY_PROJECTION_MATRIX ], projectionMatrix );
	node.clearViewOffset();
	assert.deepEqual(
		Object.getOwnPropertyDescriptor( camera, VELOCITY_PROJECTION_MATRIX ),
		priorDescriptor,
	);

} );

test( 'nested nodes sharing a camera restore in stack order and tolerate out-of-order clears', () => {

	const priorProjection = { name: 'prior' };
	const camera = { [ VELOCITY_PROJECTION_MATRIX ]: priorProjection };
	const traaProjection = { name: 'traa' };
	const taauProjection = { name: 'taau' };
	const traa = makeTemporalNode( 'TRAANode', { camera, projectionMatrix: traaProjection } );
	const taau = makeTemporalNode( 'TAAUNode', { camera, projectionMatrix: taauProjection } );

	assert.equal( installVelocityProjectionLifecycle( { traa, taau } ), 2 );
	traa.setViewOffset();
	taau.setViewOffset();
	assert.equal( camera[ VELOCITY_PROJECTION_MATRIX ], taauProjection );

	traa.clearViewOffset();
	assert.equal(
		camera[ VELOCITY_PROJECTION_MATRIX ],
		taauProjection,
		'ending the outer window must not clobber the active inner window',
	);
	taau.clearViewOffset();
	assert.equal( camera[ VELOCITY_PROJECTION_MATRIX ], priorProjection );

} );

test( 'set and clear failures cannot leak or mask projection lifecycle state', () => {

	const setError = new Error( 'set failed' );
	const setCamera = {};
	const setFailing = makeTemporalNode( 'TRAANode', { camera: setCamera, setError } );
	installVelocityProjectionLifecycle( setFailing );
	assert.throws( () => setFailing.setViewOffset(), setError );
	assert.equal( Object.hasOwn( setCamera, VELOCITY_PROJECTION_MATRIX ), false );

	const clearError = new Error( 'clear failed' );
	const priorProjection = { name: 'prior' };
	const clearCamera = { [ VELOCITY_PROJECTION_MATRIX ]: priorProjection };
	const currentProjection = { name: 'current' };
	let projectionSeenByClear = null;
	const clearFailing = makeTemporalNode( 'TAAUNode', {
		camera: clearCamera,
		projectionMatrix: currentProjection,
		clearError,
		onClear() {

			projectionSeenByClear = clearCamera[ VELOCITY_PROJECTION_MATRIX ];

		},
	} );
	installVelocityProjectionLifecycle( clearFailing );
	clearFailing.setViewOffset();
	assert.throws( () => clearFailing.clearViewOffset(), clearError );
	assert.equal( projectionSeenByClear, currentProjection );
	assert.equal( clearCamera[ VELOCITY_PROJECTION_MATRIX ], priorProjection );

	const lockedProjection = { name: 'locked' };
	const lockedCamera = {};
	Object.defineProperty( lockedCamera, VELOCITY_PROJECTION_MATRIX, {
		value: lockedProjection,
		configurable: false,
		writable: false,
	} );
	const lockedNode = makeTemporalNode( 'TRAANode', { camera: lockedCamera } );
	installVelocityProjectionLifecycle( lockedNode );
	assert.doesNotThrow( () => {

		lockedNode.setViewOffset();
		lockedNode.clearViewOffset();

	} );
	assert.equal( lockedCamera[ VELOCITY_PROJECTION_MATRIX ], lockedProjection );

} );
