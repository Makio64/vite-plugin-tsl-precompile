import test from 'node:test';
import assert from 'node:assert/strict';
import { DataTexture } from 'three';

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
	const renderCloneA = liveA.clone();
	renderCloneA.update();

	updater.update( { object: objectB, material } );
	const bindingsB = state.createBindings();
	const generatedB = bindingByName( bindingsB, 'object' );
	const liveB = bindingByName( bindingsB, 'UniformBuffer_0' );
	liveB.update();

	assert.notEqual( generatedA, generatedB );
	assert.notEqual( liveA, liveB );
	assert.equal( typeof renderCloneA.__tslpLiveArrayResolver, 'function' );
	assert.deepEqual( Array.from( renderCloneA.buffer ), [ 1, 2, 3, 4 ] );
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

test( 'non-shared bind groups clone wrappers around shared resources with one per-object group node', () => {

	const texture = new DataTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1 );
	const material = { map: texture };
	const artifact = {
		vertexShader: '',
		fragmentShader: '',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'object', kind: 'uniform-buffer', byteLength: 16, visibility: 3 },
				{ name: 'nodeUniform0_sampler', kind: 'sampler', textureType: '2d', visibility: 2 },
				{ name: 'nodeUniform0', kind: 'sampled-texture', textureType: '2d', visibility: 2 },
				{ name: 'NodeBuffer_0', kind: 'storage-buffer', access: 'read_write', visibility: 3 },
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
			textures: [
				{ name: 'nodeUniform0_sampler', bindingKind: 'sampler', source: { kind: 'material.map', property: 'map' } },
				{ name: 'nodeUniform0', bindingKind: 'sampled-texture', source: { kind: 'material.map', property: 'map' } },
			],
			storageBuffers: [ {
				name: 'NodeBuffer_0',
				count: 2,
				itemSize: 4,
				arrayType: 'Float32Array',
			} ],
		} ],
	};
	const objectA = { userData: { perObjectValue: 0.25 } };
	const objectB = { userData: { perObjectValue: 0.75 } };
	const state = hydrateNodeBuilderState( artifact, material );
	const updater = state.updateNodes.find( ( node ) => node.getUpdateType() === 'object' );

	updater.update( { object: objectA, material } );
	const groupA = state.createBindings()[ 0 ];
	updater.update( { object: objectB, material } );
	const groupB = state.createBindings()[ 0 ];
	const bindingsA = Object.fromEntries( groupA.bindings.map( ( binding ) => [ binding.name, binding ] ) );
	const bindingsB = Object.fromEntries( groupB.bindings.map( ( binding ) => [ binding.name, binding ] ) );
	const names = [ 'object', 'nodeUniform0_sampler', 'nodeUniform0', 'NodeBuffer_0' ];
	const groupNodeA = bindingsA.object.groupNode;
	const groupNodeB = bindingsB.object.groupNode;

	for ( const name of names ) {

		assert.notEqual( bindingsA[ name ], bindingsB[ name ], `${ name } wrapper is per object` );
		assert.equal( bindingsA[ name ].groupNode, groupNodeA, `${ name } shares object A's group node` );
		assert.equal( bindingsB[ name ].groupNode, groupNodeB, `${ name } shares object B's group node` );

	}
	assert.notEqual( groupNodeA, groupNodeB, 'render objects own distinct group nodes' );
	assert.notEqual( bindingsA.object.buffer, bindingsB.object.buffer, 'UBO backing arrays are deep-cloned' );
	assert.equal( bindingsA.object.buffer[ 0 ], 0.25 );
	assert.equal( bindingsB.object.buffer[ 0 ], 0.75 );
	assert.equal( bindingsA.nodeUniform0_sampler.texture, texture );
	assert.equal( bindingsB.nodeUniform0_sampler.texture, texture );
	assert.equal( bindingsA.nodeUniform0.texture, texture );
	assert.equal( bindingsB.nodeUniform0.texture, texture );
	assert.equal( bindingsA.NodeBuffer_0.attribute, bindingsB.NodeBuffer_0.attribute, 'storage attribute remains shared' );

	const textureBindings = [
		bindingsA.nodeUniform0_sampler,
		bindingsA.nodeUniform0,
		bindingsB.nodeUniform0_sampler,
		bindingsB.nodeUniform0,
	];
	for ( const binding of textureBindings ) assert.equal( binding.update(), true, 'clone observes its initial texture version' );
	const textureRebinder = state.updateBeforeNodes.find( ( node ) => typeof node.updateBefore === 'function' );
	assert.ok( textureRebinder, 'material texture rebinder is installed' );
	const textureFrame = { renderer: { backend: new WeakMap() } };
	textureRebinder.updateBefore( textureFrame );
	const versionA = groupNodeA.version;
	const versionB = groupNodeB.version;
	texture.needsUpdate = true;
	textureRebinder.updateBefore( textureFrame );

	assert.equal( groupNodeA.version, versionA + 2, 'late sampler and texture changes revalidate object A bind group' );
	assert.equal( groupNodeB.version, versionB + 2, 'late sampler and texture changes revalidate object B bind group' );
	for ( const binding of textureBindings ) {

		assert.equal( binding.update(), true, 'each wrapper observes the late texture version' );
		assert.equal( binding.version, texture.version );

	}

} );

test( 'skinned object UBOs use each live bind matrix instead of identity snapshots', () => {

	const identity = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];
	const artifact = {
		vertexShader: `
			nodeVar0 = ( object.bindSlot * vec4<f32>( varyings.positionLocal, 1.0 ) );
			varyings.positionLocal = ( object.inverseSlot * ( skinWeight.x * NodeBuffer.value[ skinIndex.x ] * nodeVar0 ) ).xyz;
		`,
		fragmentShader: '',
		bindings: [ {
			name: 'object',
			bindings: [ { name: 'object', kind: 'uniform-buffer', byteLength: 128, visibility: 3 } ],
		} ],
		uniformPlan: [ {
			name: 'object',
			shared: false,
			byteLength: 128,
			slots: [
				{ name: 'inverseSlot', offset: 0, dtype: 'mat4', source: { kind: 'uniform.live', valueSnapshot: { type: 'mat4', data: identity } } },
				{ name: 'bindSlot', offset: 64, dtype: 'mat4', source: { kind: 'uniform.live', valueSnapshot: { type: 'mat4', data: identity } } },
			],
		} ],
	};
	const matrix = base => ( { elements: Array.from( { length: 16 }, ( _, index ) => base + index ) } );
	const object = {
		isSkinnedMesh: true,
		bindMatrix: matrix( 20 ),
		bindMatrixInverse: matrix( 40 ),
	};
	const state = hydrateNodeBuilderState( artifact, {} );
	const updater = state.updateNodes.find( node => node.getUpdateType() === 'object' );

	updater.update( { object, material: {} } );
	const binding = bindingByName( state.createBindings(), 'object' );

	assert.deepEqual( Array.from( binding.buffer.slice( 0, 16 ) ), object.bindMatrixInverse.elements );
	assert.deepEqual( Array.from( binding.buffer.slice( 16, 32 ) ), object.bindMatrix.elements );

} );
