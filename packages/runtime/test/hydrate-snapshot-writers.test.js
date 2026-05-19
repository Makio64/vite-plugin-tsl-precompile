import test from 'node:test';
import assert from 'node:assert/strict';

import {
	writeColor,
	writeInt,
	writeLiveValue,
	writeMat3,
	writeMat4,
	writeNumber,
	writeSnapshot,
	writeUint,
	writeVec2,
	writeVec3,
	writeVec4,
} from '../src/hydrate/snapshot-writers.js';

function makeView( size = 64 ) {

	return new DataView( new ArrayBuffer( size ) );

}

test( 'snapshot writers: writeNumber falls back to snapshot when value is null', () => {

	const view = makeView();
	writeNumber( view, 0, null, { type: 'f32', data: 1.5 } );
	assert.equal( view.getFloat32( 0, true ), 1.5 );

} );

test( 'snapshot writers: writeNumber prefers live value over snapshot', () => {

	const view = makeView();
	writeNumber( view, 0, 2.5, { type: 'f32', data: 1.5 } );
	assert.equal( view.getFloat32( 0, true ), 2.5 );

} );

test( 'snapshot writers: writeColor writes RGB at the correct offsets', () => {

	const view = makeView();
	writeColor( view, 4, { r: 0.25, g: 0.5, b: 0.75 } );
	assert.equal( view.getFloat32( 4, true ), 0.25 );
	assert.equal( view.getFloat32( 8, true ), 0.5 );
	assert.equal( view.getFloat32( 12, true ), 0.75 );

} );

test( 'snapshot writers: writeColor falls back to snapshot when value missing', () => {

	const view = makeView();
	writeColor( view, 0, null, { type: 'color', data: [ 0.1, 0.2, 0.3 ] } );
	assert.ok( Math.abs( view.getFloat32( 0, true ) - 0.1 ) < 1e-6 );
	assert.ok( Math.abs( view.getFloat32( 4, true ) - 0.2 ) < 1e-6 );
	assert.ok( Math.abs( view.getFloat32( 8, true ) - 0.3 ) < 1e-6 );

} );

test( 'snapshot writers: writeVec2/3/4 write components in order', () => {

	const view = makeView();
	writeVec4( view, 0, { x: 1, y: 2, z: 3, w: 4 } );
	assert.equal( view.getFloat32( 0, true ), 1 );
	assert.equal( view.getFloat32( 4, true ), 2 );
	assert.equal( view.getFloat32( 8, true ), 3 );
	assert.equal( view.getFloat32( 12, true ), 4 );

	writeVec3( view, 16, { x: 5, y: 6, z: 7 } );
	assert.equal( view.getFloat32( 16, true ), 5 );
	assert.equal( view.getFloat32( 20, true ), 6 );
	assert.equal( view.getFloat32( 24, true ), 7 );

	writeVec2( view, 32, { x: 8, y: 9 } );
	assert.equal( view.getFloat32( 32, true ), 8 );
	assert.equal( view.getFloat32( 36, true ), 9 );

} );

test( 'snapshot writers: writeMat3 uses std140 16-byte row stride', () => {

	const view = makeView();
	const m = { elements: [ 1, 2, 3, 4, 5, 6, 7, 8, 9 ] };
	writeMat3( view, 0, m );
	// row 0: cols 0..2 at byte 0,4,8
	assert.equal( view.getFloat32( 0, true ), 1 );
	assert.equal( view.getFloat32( 4, true ), 2 );
	assert.equal( view.getFloat32( 8, true ), 3 );
	// row 1: at byte 16,20,24 (the +12 slot is padding)
	assert.equal( view.getFloat32( 12, true ), 0 );
	assert.equal( view.getFloat32( 16, true ), 4 );
	assert.equal( view.getFloat32( 20, true ), 5 );
	assert.equal( view.getFloat32( 24, true ), 6 );
	// row 2: at byte 32,36,40
	assert.equal( view.getFloat32( 32, true ), 7 );
	assert.equal( view.getFloat32( 36, true ), 8 );
	assert.equal( view.getFloat32( 40, true ), 9 );

} );

test( 'snapshot writers: writeMat4 writes 16 floats sequentially', () => {

	const view = makeView();
	const e = Array.from( { length: 16 }, ( _, i ) => i + 1 );
	writeMat4( view, 0, { elements: e } );
	for ( let i = 0; i < 16; i ++ ) assert.equal( view.getFloat32( i * 4, true ), i + 1 );

} );

test( 'snapshot writers: writeInt and writeUint coerce types correctly', () => {

	const view = makeView();
	writeInt( view, 0, - 42 );
	assert.equal( view.getInt32( 0, true ), - 42 );
	writeUint( view, 4, 4294967295 );
	assert.equal( view.getUint32( 4, true ), 4294967295 );

} );

test( 'snapshot writers: writeSnapshot dispatches by type', () => {

	const view = makeView();
	writeSnapshot( view, 0, { type: 'f32', data: 1.25 } );
	assert.equal( view.getFloat32( 0, true ), 1.25 );

	writeSnapshot( view, 4, { type: 'vec3', data: [ 9, 8, 7 ] } );
	assert.equal( view.getFloat32( 4, true ), 9 );
	assert.equal( view.getFloat32( 8, true ), 8 );
	assert.equal( view.getFloat32( 12, true ), 7 );

	writeSnapshot( view, 16, { type: 'color', data: [ 0.5, 0.5, 0.5 ] } );
	assert.ok( Math.abs( view.getFloat32( 16, true ) - 0.5 ) < 1e-6 );

	writeSnapshot( view, 28, { type: 'number', data: 2 }, 'int' );
	assert.equal( view.getInt32( 28, true ), 2 );
	assert.notEqual( view.getFloat32( 28, true ), 2 );

	// Unknown / falsy snapshot: no-op (no throw, no write past the float we just made).
	writeSnapshot( view, 32, null );
	writeSnapshot( view, 32, { type: 'unknown', data: 0 } );
	assert.equal( view.getFloat32( 32, true ), 0 );

} );

test( 'snapshot writers: writeLiveValue dispatches by value isXxx flags', () => {

	const view = makeView();
	writeLiveValue( view, 0, 3.5 ); // scalar
	assert.equal( view.getFloat32( 0, true ), 3.5 );

	writeLiveValue( view, 28, 2, 'int' );
	assert.equal( view.getInt32( 28, true ), 2 );
	assert.notEqual( view.getFloat32( 28, true ), 2 );

	writeLiveValue( view, 4, { isColor: true, r: 1, g: 0, b: 0 } );
	assert.equal( view.getFloat32( 4, true ), 1 );
	assert.equal( view.getFloat32( 8, true ), 0 );
	assert.equal( view.getFloat32( 12, true ), 0 );

	writeLiveValue( view, 16, { isVector3: true, x: 7, y: 8, z: 9 } );
	assert.equal( view.getFloat32( 16, true ), 7 );

	// dtype hint fallback
	writeLiveValue( view, 32, { x: 1, y: 2 }, 'vec2' );
	assert.equal( view.getFloat32( 32, true ), 1 );
	assert.equal( view.getFloat32( 36, true ), 2 );

} );
