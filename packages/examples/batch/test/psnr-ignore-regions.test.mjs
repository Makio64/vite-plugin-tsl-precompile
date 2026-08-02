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
