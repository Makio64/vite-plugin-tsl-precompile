import test from 'node:test';
import assert from 'node:assert/strict';

import { Color, Matrix3, Matrix4, Vector3 } from 'three';

import { writeMaterialValue, writeUniformGroup } from '../src/hydrate/material-writers.js';

function makeView( size = 256 ) {

	return new DataView( new ArrayBuffer( size ) );

}

function makeGroup( slots ) {

	return { name: 'render', slots };

}

test( 'writeUniformGroup writes camera.projectionMatrix at the slot offset', () => {

	const view = makeView();
	const proj = new Matrix4().makeOrthographic( - 1, 1, 1, - 1, 0.1, 100 );
	const group = makeGroup( [
		{ offset: 0, dtype: 'mat4', source: { kind: 'camera.projectionMatrix' } },
	] );
	writeUniformGroup( group, { camera: { projectionMatrix: proj } }, view, null );
	// Compare via Math.fround so the float32 storage rounding matches the expected value.
	for ( let i = 0; i < 16; i ++ ) {

		assert.ok( Math.abs( view.getFloat32( i * 4, true ) - Math.fround( proj.elements[ i ] ) ) < 1e-6 );

	}

} );

test( 'writeUniformGroup writes camera.position', () => {

	const view = makeView();
	const group = makeGroup( [
		{ offset: 0, dtype: 'vec3', source: { kind: 'camera.position' } },
	] );
	writeUniformGroup( group, { camera: { position: new Vector3( 1, 2, 3 ) } }, view, null );
	assert.equal( view.getFloat32( 0, true ), 1 );
	assert.equal( view.getFloat32( 4, true ), 2 );
	assert.equal( view.getFloat32( 8, true ), 3 );

} );

test( 'writeUniformGroup writes frame.time and frame.frameId', () => {

	const view = makeView();
	const group = makeGroup( [
		{ offset: 0, dtype: 'f32', source: { kind: 'frame.time' } },
		{ offset: 4, dtype: 'u32', source: { kind: 'frame.frameId' } },
	] );
	writeUniformGroup( group, { time: 1.5, frameId: 42 }, view, null );
	assert.equal( view.getFloat32( 0, true ), 1.5 );
	assert.equal( view.getUint32( 4, true ), 42 );

} );

test( 'writeUniformGroup writes object3d.viewPosition (object position in camera space)', () => {

	const view = makeView();
	const objectMatrix = new Matrix4().setPosition( 4, 0, 0 );
	const camera = { matrixWorldInverse: new Matrix4() };
	const group = makeGroup( [
		{ offset: 0, dtype: 'vec3', source: { kind: 'object3d.viewPosition' } },
	] );
	writeUniformGroup( group, { object: { matrixWorld: objectMatrix }, camera }, view, null );
	assert.equal( view.getFloat32( 0, true ), 4 );

} );

test( 'writeUniformGroup writes object.normalMatrix from world matrix', () => {

	const view = makeView();
	const objectMatrix = new Matrix4().identity();
	const normalMatrix = new Matrix3();
	const group = makeGroup( [
		{ offset: 0, dtype: 'mat3', source: { kind: 'object.normalMatrix' } },
	] );
	writeUniformGroup( group, { object: { matrixWorld: objectMatrix, normalMatrix } }, view, null );
	// Identity → normal matrix is identity. std140: row 0 col 0 == 1.
	assert.equal( view.getFloat32( 0, true ), 1 );

} );

test( 'writeUniformGroup tracks VelocityNode previous camera and object matrices', () => {

	const group = makeGroup( [
		{ offset: 0, dtype: 'mat4', source: { kind: 'velocity.previousProjectionMatrix' } },
		{ offset: 64, dtype: 'mat4', source: { kind: 'velocity.previousCameraViewMatrix' } },
		{ offset: 128, dtype: 'mat4', source: { kind: 'velocity.previousModelWorldMatrix' } },
	] );
	const view = makeView();
	const camera = {
		projectionMatrix: new Matrix4().makeTranslation( 1, 0, 0 ),
		matrixWorldInverse: new Matrix4().makeTranslation( 2, 0, 0 ),
	};
	const object = { matrixWorld: new Matrix4().makeTranslation( 3, 0, 0 ) };

	writeUniformGroup( group, { frameId: 1, camera, object }, view, null );
	assert.equal( view.getFloat32( 12 * 4, true ), 1 );
	assert.equal( view.getFloat32( 64 + 12 * 4, true ), 2 );
	assert.equal( view.getFloat32( 128 + 12 * 4, true ), 3 );

	camera.projectionMatrix.makeTranslation( 10, 0, 0 );
	camera.matrixWorldInverse.makeTranslation( 20, 0, 0 );
	object.matrixWorld.makeTranslation( 30, 0, 0 );

	const sameFrame = makeView();
	writeUniformGroup( group, { frameId: 1, camera, object }, sameFrame, null );
	assert.equal( sameFrame.getFloat32( 12 * 4, true ), 1 );
	assert.equal( sameFrame.getFloat32( 64 + 12 * 4, true ), 2 );
	assert.equal( sameFrame.getFloat32( 128 + 12 * 4, true ), 3 );

	const nextFrame = makeView();
	writeUniformGroup( group, { frameId: 2, camera, object }, nextFrame, null );
	assert.equal( nextFrame.getFloat32( 12 * 4, true ), 1 );
	assert.equal( nextFrame.getFloat32( 64 + 12 * 4, true ), 2 );
	assert.equal( nextFrame.getFloat32( 128 + 12 * 4, true ), 3 );

	camera.projectionMatrix.makeTranslation( 100, 0, 0 );
	camera.matrixWorldInverse.makeTranslation( 200, 0, 0 );
	object.matrixWorld.makeTranslation( 300, 0, 0 );

	const thirdFrame = makeView();
	writeUniformGroup( group, { frameId: 3, camera, object }, thirdFrame, null );
	assert.equal( thirdFrame.getFloat32( 12 * 4, true ), 10 );
	assert.equal( thirdFrame.getFloat32( 64 + 12 * 4, true ), 20 );
	assert.equal( thirdFrame.getFloat32( 128 + 12 * 4, true ), 30 );

} );

test( 'writeUniformGroup falls back to snapshot when frame fields are missing', () => {

	const view = makeView();
	const group = makeGroup( [
		{
			offset: 0,
			dtype: 'f32',
			source: { kind: 'frame.time', valueSnapshot: { type: 'f32', data: 7.25 } },
		},
	] );
	writeUniformGroup( group, {}, view, null );
	assert.equal( view.getFloat32( 0, true ), 7.25 );

} );

test( 'writeUniformGroup writes material.color from material.color', () => {

	const view = makeView();
	const material = { color: new Color( 0.5, 0.25, 0.125 ) };
	const group = makeGroup( [
		{ offset: 0, dtype: 'color', source: { kind: 'material.color' } },
	] );
	writeUniformGroup( group, { material }, view, null );
	assert.ok( Math.abs( view.getFloat32( 0, true ) - 0.5 ) < 1e-6 );
	assert.ok( Math.abs( view.getFloat32( 4, true ) - 0.25 ) < 1e-6 );
	assert.ok( Math.abs( view.getFloat32( 8, true ) - 0.125 ) < 1e-6 );

} );

test( 'writeUniformGroup writes material scalar with property fallback to kind tail', () => {

	const view = makeView();
	const material = { opacity: 0.42 };
	const group = makeGroup( [
		{ offset: 0, dtype: 'f32', source: { kind: 'material.opacity' } },
	] );
	writeUniformGroup( group, { material }, view, null );
	assert.equal( view.getFloat32( 0, true ), Math.fround( 0.42 ) );

	const view2 = makeView();
	writeUniformGroup(
		makeGroup( [ { offset: 0, dtype: 'f32', source: { kind: 'material.opacity', property: 'opacity' } } ] ),
		{ material },
		view2,
		null
	);
	assert.equal( view2.getFloat32( 0, true ), Math.fround( 0.42 ) );

} );

test( 'writeUniformGroup dispatches light.* via the imported light writer', () => {

	const view = makeView();
	const group = makeGroup( [
		{ offset: 0, dtype: 'f32', source: { kind: 'light.distance', lightIndex: 0 } },
	] );
	const lights = [ { isLight: true, distance: 33, intensity: 1, color: { r: 1, g: 1, b: 1 }, matrixWorld: new Matrix4(), uuid: 'a' } ];
	const scene = {
		traverse( fn ) {

			for ( const l of lights ) fn( l );

		},
	};
	writeUniformGroup( group, { scene }, view, null );
	assert.equal( view.getFloat32( 0, true ), 33 );

} );

test( 'writeUniformGroup writes uniform.live via slot._liveNode when available', () => {

	const view = makeView();
	const slot = {
		offset: 0,
		dtype: 'f32',
		source: { kind: 'uniform.live' },
		_liveNode: { value: 9.5 },
	};
	const group = makeGroup( [ slot ] );
	writeUniformGroup( group, {}, view, null );
	assert.equal( view.getFloat32( 0, true ), 9.5 );

} );

test( 'writeUniformGroup writes object3d.nodeUniform from frame.object[property].value', () => {

	const view = makeView();
	const group = makeGroup( [
		{
			offset: 0,
			dtype: 'f32',
			source: { kind: 'object3d.nodeUniform', property: 'distortionScale', valueSnapshot: { type: 'number', data: 3.7 } },
		},
	] );
	writeUniformGroup( group, { object: { distortionScale: { value: 6.25 } } }, view, null );
	assert.equal( view.getFloat32( 0, true ), 6.25 );

	const fallbackView = makeView();
	writeUniformGroup( group, { object: {} }, fallbackView, null );
	assert.equal( fallbackView.getFloat32( 0, true ), Math.fround( 3.7 ) );

} );

test( 'writeUniformGroup writes constant kind via snapshot', () => {

	const view = makeView();
	const group = makeGroup( [
		{
			offset: 0,
			source: { kind: 'constant', valueSnapshot: { type: 'vec3', data: [ 7, 8, 9 ] } },
		},
	] );
	writeUniformGroup( group, {}, view, null );
	assert.equal( view.getFloat32( 0, true ), 7 );
	assert.equal( view.getFloat32( 4, true ), 8 );
	assert.equal( view.getFloat32( 8, true ), 9 );

} );

test( 'writeMaterialValue refreshes texture.matrix when matrixAutoUpdate is on', () => {

	const view = makeView();
	let calls = 0;
	const tex = {
		matrixAutoUpdate: true,
		updateMatrix() {

			calls ++;
			this.matrix = { elements: Array.from( { length: 16 }, ( _, i ) => ( i === 0 ? 9 : 0 ) ) };

		},
		matrix: { elements: Array.from( { length: 16 }, () => 0 ) },
	};
	writeMaterialValue( view, 0, { map: tex }, { kind: 'material.map.matrix' }, 'material.map.matrix', 'mat4' );
	assert.equal( calls, 1 );
	assert.equal( view.getFloat32( 0, true ), 9 );

} );
