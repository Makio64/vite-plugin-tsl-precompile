import { test } from 'node:test';
import { generateForPlan, assertGenerates } from './_helpers.js';

test( 'cell: object.worldMatrix → writeMat4', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 0, source: { kind: 'object.worldMatrix' } } ] } ] } );
	assertGenerates( r, 'writeMat4(view, byteOffset + 0, frame.object.matrixWorld)' );

} );

test( 'cell: object.normalMatrix → writeMat3', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 64, source: { kind: 'object.normalMatrix' } } ] } ] } );
	assertGenerates( r, 'writeMat3(view, byteOffset + 64, frame.object.normalMatrix)' );

} );

test( 'cell: object.modelViewMatrix → writeMat4', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 0, source: { kind: 'object.modelViewMatrix' } } ] } ] } );
	assertGenerates( r, 'writeMat4(view, byteOffset + 0, frame.object.modelViewMatrix)' );

} );
