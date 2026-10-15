import test from 'node:test';
import assert from 'node:assert/strict';
import { readCanvasBrightFraction } from '../e2e-canvas-brightness.mjs';

function environment( canvases, run ) {

	const savedDocument = Object.getOwnPropertyDescriptor( globalThis, 'document' );
	const savedCanvas = Object.getOwnPropertyDescriptor( globalThis, 'OffscreenCanvas' );
	let allocations = 0;
	class Surface {

		constructor( width, height ) { allocations ++; this.width = width; this.height = height; this.pixels = new Uint8ClampedArray( width * height * 4 ); }
		getContext() {

			return {
				clearRect: () => { this.pixels = new Uint8ClampedArray( this.width * this.height * 4 ); },
				drawImage: source => {

					if ( source.error ) throw new Error( 'Tainted canvas' );
					for ( let offset = 0; offset < source.pixels.length; offset += 4 ) {

						if ( source.pixels[ offset + 3 ] ) this.pixels.set( source.pixels.subarray( offset, offset + 4 ), offset );

					}

				},
				getImageData: () => ( { data: this.pixels } ),
			};

		}

	}
	Object.defineProperty( globalThis, 'document', { value: { querySelectorAll: () => canvases }, configurable: true } );
	Object.defineProperty( globalThis, 'OffscreenCanvas', { value: Surface, configurable: true } );
	try { run( () => allocations ); }
	finally {

		if ( savedDocument ) Object.defineProperty( globalThis, 'document', savedDocument ); else delete globalThis.document;
		if ( savedCanvas ) Object.defineProperty( globalThis, 'OffscreenCanvas', savedCanvas ); else delete globalThis.OffscreenCanvas;

	}

}

const canvas = ( ...values ) => ( { width: values.length, height: 1, pixels: Uint8ClampedArray.from( values.flatMap( value => [ value, value, value, value ? 255 : 0 ] ) ) } );

test( 'repeated full-resolution samples reuse surfaces and retain the brightest canvas', () => {

	const a = canvas( 255, 0 ), b = canvas( 11, 11, 0, 0 );
	environment( [ a, b ], allocations => {

		assert.equal( readCanvasBrightFraction(), 0.5 );
		assert.equal( readCanvasBrightFraction(), 0.5 );
		assert.equal( allocations(), 2 );
		assert.deepEqual( Object.keys( a ), [ 'width', 'height', 'pixels' ], 'cache does not enter enumerable capture inputs' );

	} );

} );

test( 'transparent and resized frames replace all pixels from previous samples', () => {

	const a = canvas( 255, 255 );
	environment( [ a ], allocations => {

		assert.equal( readCanvasBrightFraction(), 1 );
		a.pixels.fill( 0 );
		assert.equal( readCanvasBrightFraction(), 0 );
		a.width = 4; a.pixels = canvas( 255, 0, 0, 0 ).pixels;
		assert.equal( readCanvasBrightFraction(), 0.25 );
		assert.equal( allocations(), 1 );

	} );

} );

test( 'nonextensible canvases retain an uncached readback and tainted canvases stay isolated', () => {

	const a = Object.freeze( canvas( 255, 0 ) ), b = { ...canvas( 255 ), error: true };
	environment( [ a, b, { width: 0, height: 0 } ], allocations => {

		assert.equal( readCanvasBrightFraction(), 0.5 );
		assert.equal( readCanvasBrightFraction(), 0.5 );
		assert.equal( allocations(), 3 );

	} );

} );
