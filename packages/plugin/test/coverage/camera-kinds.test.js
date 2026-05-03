import { test } from 'node:test';
import { generateForPlan, assertGenerates } from './_helpers.js';

test( 'cell: camera.projectionMatrix → writeMat4', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 0, source: { kind: 'camera.projectionMatrix' } } ] } ] } );
	assertGenerates( r, 'writeMat4(view, byteOffset + 0, frame.camera.projectionMatrix)' );

} );

test( 'cell: camera.viewMatrix → matrixWorldInverse', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 64, source: { kind: 'camera.viewMatrix' } } ] } ] } );
	assertGenerates( r, 'writeMat4(view, byteOffset + 64, frame.camera.matrixWorldInverse)' );

} );

test( 'cell: camera.position → vec3', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 0, source: { kind: 'camera.position' } } ] } ] } );
	assertGenerates( r, 'writeVec3(view, byteOffset + 0, frame.camera.position)' );

} );

test( 'cell: camera.near + camera.far → f32', () => {

	const r = generateForPlan( { groups: [ { slots: [
		{ byteOffset: 0, source: { kind: 'camera.near' } },
		{ byteOffset: 4, source: { kind: 'camera.far' } },
	] } ] } );
	assertGenerates( r, 'writeF32(view, byteOffset + 0, frame.camera.near)' );
	assertGenerates( r, 'writeF32(view, byteOffset + 4, frame.camera.far)' );

} );
