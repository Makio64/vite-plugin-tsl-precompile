import test from 'node:test';
import assert from 'node:assert/strict';

import { hydrateNodeBuilderState } from '../src/hydrator.js';

function bindingByName( groups, name ) {

	for ( const group of groups ) {

		const binding = group.bindings.find( ( item ) => item.name === name );
		if ( binding ) return binding;

	}
	return null;

}

test( 'shared material updates each render object\'s cloned generated and live UBOs', () => {

	const material = {};
	const artifact = {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'object', kind: 'uniform-buffer', byteLength: 16, visibility: 3 },
				{ name: 'UniformBuffer_0', kind: 'uniform-buffer', byteLength: 16, visibility: 3 },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			shared: false,
			byteLength: 16,
			slots: [ {
				name: 'perObjectValue',
				offset: 0,
				dtype: 'float',
				source: { kind: 'object3d.userData', property: 'perObjectValue', valueSnapshot: { type: 'float', data: 0 } },
			} ],
			orderedBindings: [ {
				type: 'buffer-uniform',
				ref: { name: 'UniformBuffer_0', byteLength: 16, valueSnapshot: [ 0, 0, 0, 0 ] },
			} ],
		} ],
		_generatedUpdateGroup( frame, _material, view, _baseOffset, groupName ) {

			if ( groupName === 'object' ) view.setFloat32( 0, frame.object.userData.perObjectValue, true );

		},
	};
	const objectA = {
		userData: { perObjectValue: 0.25 },
		instanceMatrix: { array: new Float32Array( [ 1, 2, 3, 4 ] ) },
	};
	const objectB = {
		userData: { perObjectValue: 0.75 },
		instanceMatrix: { array: new Float32Array( [ 5, 6, 7, 8 ] ) },
	};
	const state = hydrateNodeBuilderState( artifact, material );
	const updater = state.updateNodes.find( ( node ) => node.getUpdateType() === 'object' );

	// Renderer order is updateForRender() followed by getBindings(). On the
	// first visit the updated base bytes are cloned and registered to the
	// current frame.object.
	updater.update( { object: objectA, material } );
	const bindingsA = state.createBindings();
	const generatedA = bindingByName( bindingsA, 'object' );
	const liveA = bindingByName( bindingsA, 'UniformBuffer_0' );
	liveA.update();

	updater.update( { object: objectB, material } );
	const bindingsB = state.createBindings();
	const generatedB = bindingByName( bindingsB, 'object' );
	const liveB = bindingByName( bindingsB, 'UniformBuffer_0' );
	liveB.update();

	assert.notEqual( generatedA, generatedB );
	assert.notEqual( liveA, liveB );
	assert.equal( generatedA.buffer[ 0 ], 0.25 );
	assert.equal( generatedB.buffer[ 0 ], 0.75 );
	assert.deepEqual( Array.from( liveA.buffer ), [ 1, 2, 3, 4 ] );
	assert.deepEqual( Array.from( liveB.buffer ), [ 5, 6, 7, 8 ] );

	// Later updates must target only the current object's clones. Previously
	// these writes landed on the unused base UBO, freezing both objects at
	// their first-render values.
	objectA.userData.perObjectValue = 0.5;
	objectA.instanceMatrix.array.set( [ 9, 10, 11, 12 ] );
	updater.update( { object: objectA, material } );
	liveA.update();

	assert.equal( generatedA.buffer[ 0 ], 0.5 );
	assert.equal( generatedB.buffer[ 0 ], 0.75 );
	assert.deepEqual( Array.from( liveA.buffer ), [ 9, 10, 11, 12 ] );
	assert.deepEqual( Array.from( liveB.buffer ), [ 5, 6, 7, 8 ] );

	objectB.userData.perObjectValue = 1;
	objectB.instanceMatrix.array.set( [ 13, 14, 15, 16 ] );
	updater.update( { object: objectB, material } );
	liveB.update();

	assert.equal( generatedA.buffer[ 0 ], 0.5 );
	assert.equal( generatedB.buffer[ 0 ], 1 );
	assert.deepEqual( Array.from( liveA.buffer ), [ 9, 10, 11, 12 ] );
	assert.deepEqual( Array.from( liveB.buffer ), [ 13, 14, 15, 16 ] );

} );
