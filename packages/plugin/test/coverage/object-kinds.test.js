import { test } from 'node:test';
import { generateForPlan, assertGenerates } from './_helpers.js';

test( 'cell: object.worldMatrix → writeMat4', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 0, source: { kind: 'object.worldMatrix' } } ] } ] } );
	assertGenerates( r, 'writeMat4(view, byteOffset + 0, frame.object.matrixWorld)' );

} );

test( 'cell: object.normalMatrix → writeMat3', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 64, source: { kind: 'object.normalMatrix' } } ] } ] } );
	assertGenerates( r, 'frame.object.normalMatrix.getNormalMatrix(frame.object.matrixWorld)' );
	assertGenerates( r, 'writeMat3(view, byteOffset + 64, frame.object && frame.object.normalMatrix)' );
	// Recompute is gated for SkinnedMesh / InstancedMesh / PointsNodeMaterial
	// — their renderer path already encodes additional transforms we'd clobber.
	assertGenerates( r, 'frame.object.isSkinnedMesh !== true' );
	assertGenerates( r, 'frame.object.isInstancedMesh !== true' );
	assertGenerates( r, 'frame.object.material.isPointsNodeMaterial !== true' );

} );

test( 'cell: object.modelViewMatrix → writeMat4', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 0, source: { kind: 'object.modelViewMatrix' } } ] } ] } );
	assertGenerates( r, 'frame.object.modelViewMatrix.multiplyMatrices(frame.camera.matrixWorldInverse, frame.object.matrixWorld)' );
	assertGenerates( r, 'writeMat4(view, byteOffset + 0, frame.object && frame.object.modelViewMatrix)' );
	// Same gate as normalMatrix above.
	assertGenerates( r, 'frame.object.isSkinnedMesh !== true' );
	assertGenerates( r, 'frame.object.isInstancedMesh !== true' );
	assertGenerates( r, 'frame.object.material.isPointsNodeMaterial !== true' );

} );
