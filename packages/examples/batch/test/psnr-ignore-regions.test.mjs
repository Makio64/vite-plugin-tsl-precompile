import assert from 'node:assert/strict';
import test from 'node:test';

import { PNG } from 'pngjs';

import { comparePngBuffers } from '../psnr.mjs';

function solidPng( width, height, value = 128 ) {

	const png = new PNG( { width, height } );
	for ( let offset = 0; offset < png.data.length; offset += 4 ) {

		png.data[ offset ] = value;
		png.data[ offset + 1 ] = value;
		png.data[ offset + 2 ] = value;
		png.data[ offset + 3 ] = 255;

	}
	return PNG.sync.write( png );

}

test( 'identical bytes still require a valid PNG', () => {

	for ( const invalid of [ Buffer.from( 'not a PNG' ), solidPng( 4, 4 ).subarray( 0, 30 ) ] ) {

		assert.ok( comparePngBuffers( invalid, Buffer.from( invalid ) ).error );

	}

} );

test( 'equal screenshots retain dimensions and pixel accounting', () => {

	const image = solidPng( 4, 3 );
	assert.deepEqual( comparePngBuffers( image, Buffer.from( image ) ), {
		psnr: 'inf', width: 4, height: 3,
		comparedPixels: 12, comparedFraction: 1, ignoredRegions: [],
	} );
	const reencoded = PNG.sync.write( PNG.sync.read( image ), { deflateLevel: 0 } );
	assert.equal( comparePngBuffers( image, reencoded ).psnr, 'inf' );
	assert.match( comparePngBuffers( image, solidPng( 3, 4 ) ).error, /dim mismatch/ );

} );

test( 'different screenshots preserve RGB error and unrounded PSNR', () => {

	const a = solidPng( 4, 4, 100 );
	const b = solidPng( 4, 4, 110 );
	const expected = 10 * Math.log10( 255 * 255 / 100 );
	assert.equal( comparePngBuffers( a, b, { round: false } ).psnr, expected );
	assert.equal( comparePngBuffers( a, b ).psnr, +expected.toFixed( 2 ) );
	const alphaOnly = PNG.sync.read( a );
	alphaOnly.data[ 3 ] = 0;
	assert.equal( comparePngBuffers( a, PNG.sync.write( alphaOnly ) ).psnr, 'inf' );

} );

test( 'overlapping ignore regions count each pixel once', () => {

	const image = solidPng( 4, 4 );
	const result = comparePngBuffers( image, image, {
		ignoreRegions: [ { x: 0, y: 0, width: 2, height: 2 }, { x: 1, y: 1, width: 2, height: 2 } ],
	} );
	assert.equal( result.comparedPixels, 9 );
	assert.equal( result.comparedFraction, 9 / 16 );
	assert.equal( result.psnr, 'inf' );

} );

test( 'PSNR comparison rejects ignore regions that erase the evidence', () => {

	const image = solidPng( 4, 4 );
	const result = comparePngBuffers( image, image, {
		ignoreRegions: [ { x: 0, y: 0, width: 4, height: 4 } ],
	} );
	assert.match( result.error, /insufficient compared pixels/ );

} );

test( 'PSNR comparison rejects malformed or out-of-bounds ignore regions', () => {

	const image = solidPng( 4, 4 );
	for ( const region of [
		{ x: -1, y: 0, width: 1, height: 1 },
		{ x: 0, y: 0, width: 5, height: 1 },
		{ x: 0, y: 0, width: 1.5, height: 1 },
	] ) {

		const result = comparePngBuffers( image, image, { ignoreRegions: [ region ] } );
		assert.match( result.error, /invalid ignore region/ );

	}

} );

test( 'PSNR comparison records a valid compared-pixel fraction', () => {

	const image = solidPng( 4, 4 );
	const result = comparePngBuffers( image, image, {
		ignoreRegions: [ { x: 0, y: 0, width: 1, height: 1 } ],
	} );
	assert.equal( result.psnr, 'inf' );
	assert.equal( result.comparedPixels, 15 );
	assert.equal( result.comparedFraction, 15 / 16 );

} );
