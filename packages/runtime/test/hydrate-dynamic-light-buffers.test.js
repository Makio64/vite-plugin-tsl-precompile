import test from 'node:test';
import assert from 'node:assert/strict';

import { Color, Matrix4 } from 'three';

import { updateDynamicLightUniforms } from '../src/hydrate/dynamic-light-buffers.js';

function makeLight( opts ) {

	const light = {
		isLight: true,
		isPointLight: opts.type === 'point',
		isAmbientLight: opts.type === 'ambient',
		id: opts.id || 0,
		color: opts.color || new Color( 1, 1, 1 ),
		intensity: opts.intensity ?? 1,
		distance: opts.distance ?? 0,
		decay: opts.decay ?? 2,
		matrixWorld: new Matrix4().makeTranslation( opts.x || 0, opts.y || 0, opts.z || 0 ),
	};
	return light;

}

function makeScene( lights ) {

	return {
		traverse( fn ) {

			for ( const light of lights ) fn( light );

		},
	};

}

test( 'updateDynamicLightUniforms refreshes DynamicLightsNode point arrays from the live scene', () => {

	const shader = `
struct NodeBuffer_PosStruct { value : array< vec4<f32>, 16 > };
@binding( 1 ) @group( 0 ) var<uniform> NodeBuffer_Pos : NodeBuffer_PosStruct;
struct NodeBuffer_ColorStruct { value : array< vec4<f32>, 16 > };
@binding( 2 ) @group( 0 ) var<uniform> NodeBuffer_Color : NodeBuffer_ColorStruct;
struct NodeBuffer_DecayStruct { value : array< vec4<f32>, 16 > };
@binding( 3 ) @group( 0 ) var<uniform> NodeBuffer_Decay : NodeBuffer_DecayStruct;
fn main() {
	var irradiance : vec3<f32>;
	var dynPointDiffuse : vec3<f32>;
	for ( var i : i32 = 0; i < render.pointCount; i ++ ) {
		let lightVector = NodeBuffer_Pos.value[ i ].xyz - v_positionView;
		let attenuation = pow( length( lightVector ), NodeBuffer_Decay.value[ i ].x );
		dynPointDiffuse = NodeBuffer_Color.value[ i ].xyz * attenuation;
		if ( NodeBuffer_Pos.value[ i ].w > 0.0 ) {}
	}
	irradiance = irradiance + render.ambientColor;
}
`;
	const bindingGroup = {
		name: 'render',
		bindings: [
			{ name: 'render', kind: 'uniform-buffer', byteLength: 32 },
			{ name: 'UniformBuffer_0', kind: 'uniform-buffer', byteLength: 256 },
			{ name: 'UniformBuffer_1', kind: 'uniform-buffer', byteLength: 256 },
			{ name: 'UniformBuffer_2', kind: 'uniform-buffer', byteLength: 256 },
		],
	};
	const group = {
		name: 'render',
		slots: [
			{ name: 'ambientColor', offset: 0, dtype: 'color' },
			{ name: 'pointCount', offset: 12, dtype: 'int' },
		],
	};
	const artifact = {
		vertexShader: '',
		fragmentShader: shader,
		bindings: [ bindingGroup ],
	};
	const renderBytes = new ArrayBuffer( 32 );
	const renderView = new DataView( renderBytes );
	const uniformBuffers = new Map( [
		[ 'UniformBuffer_0', { buffer: new Float32Array( 64 ) } ],
		[ 'UniformBuffer_1', { buffer: new Float32Array( 64 ) } ],
		[ 'UniformBuffer_2', { buffer: new Float32Array( 64 ) } ],
	] );
	const pointB = makeLight( {
		type: 'point',
		id: 20,
		color: new Color( 0.2, 0.3, 0.4 ),
		intensity: 10,
		distance: 30,
		decay: 1.5,
		x: 4,
		y: 5,
		z: 6,
	} );
	const pointA = makeLight( {
		type: 'point',
		id: 10,
		color: new Color( 1, 0.5, 0.25 ),
		intensity: 2,
		distance: 12,
		decay: 2,
		x: 1,
		y: 2,
		z: 3,
	} );
	const ambient = makeLight( {
		type: 'ambient',
		color: new Color( 0.1, 0.2, 0.3 ),
		intensity: 3,
	} );
	const frame = {
		scene: makeScene( [ pointB, ambient, pointA ] ),
		camera: { matrixWorldInverse: new Matrix4() },
	};

	assert.equal( updateDynamicLightUniforms( artifact, group, renderView, uniformBuffers, frame ), true );

	assert.equal( renderView.getInt32( 12, true ), 2 );
	assert.equal( Math.fround( renderView.getFloat32( 0, true ) ), Math.fround( 0.3 ) );
	assert.equal( Math.fround( renderView.getFloat32( 4, true ) ), Math.fround( 0.6 ) );
	assert.equal( Math.fround( renderView.getFloat32( 8, true ) ), Math.fround( 0.9 ) );

	const positions = uniformBuffers.get( 'UniformBuffer_0' ).buffer;
	const colors = uniformBuffers.get( 'UniformBuffer_1' ).buffer;
	const decays = uniformBuffers.get( 'UniformBuffer_2' ).buffer;
	assert.deepEqual( Array.from( positions.slice( 0, 4 ) ), [ 1, 2, 3, 12 ] );
	assert.deepEqual( Array.from( colors.slice( 0, 4 ) ), [ 2, 1, 0.5, 0 ] );
	assert.deepEqual( Array.from( decays.slice( 0, 4 ) ), [ 2, 0, 0, 1 ] );
	assert.deepEqual( Array.from( positions.slice( 4, 8 ) ), [ 4, 5, 6, 30 ] );
	assert.deepEqual( Array.from( colors.slice( 4, 8 ) ), [ 2, 3, 4, 0 ] );
	assert.deepEqual( Array.from( decays.slice( 4, 8 ) ), [ 1.5, 0, 0, 1 ] );

} );
