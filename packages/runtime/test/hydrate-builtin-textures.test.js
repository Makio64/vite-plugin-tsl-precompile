import test from 'node:test';
import assert from 'node:assert/strict';

import {
	ClampToEdgeWrapping,
	HalfFloatType,
	LinearFilter,
	NearestFilter,
} from 'three';

import {
	buildLtcTexture,
	resolveBuiltinTextureBinding,
} from '../src/hydrate/builtin-textures.js';

test( 'builtin textures reconstruct and cache LTC half-float textures', () => {

	const raw = new Array( 64 * 64 * 4 ).fill( 0 );
	raw[ 0 ] = 15360;
	const artifact = { ltcTextures: [ raw ] };
	const source = { kind: 'builtin.ltcTexture', ltcIndex: 0 };

	const first = buildLtcTexture( artifact, source );
	const second = buildLtcTexture( artifact, source );

	assert.equal( first, second );
	assert.equal( first.type, HalfFloatType );
	assert.equal( first.image.width, 64 );
	assert.equal( first.image.height, 64 );
	assert.ok( first.image.data instanceof Uint16Array );
	assert.equal( first.image.data[ 0 ], 15360 );
	assert.equal( first.magFilter, LinearFilter );
	assert.equal( first.minFilter, NearestFilter );
	assert.equal( first.wrapS, ClampToEdgeWrapping );
	assert.equal( first.wrapT, ClampToEdgeWrapping );
	assert.ok( first.version > 0 );
	assert.equal( artifact._ltcTextureCache.size, 1 );

} );

test( 'builtin texture resolver returns DFG LUTs through injectable lookup', () => {

	const fallback = { uuid: 'fallback' };
	const dfg = { uuid: 'dfg' };
	const resolved = resolveBuiltinTextureBinding( {
		artifact: {},
		bindingName: 'dfgLUT',
		source: { kind: 'builtin.dfgLUT' },
		fallbackTextureForBinding: () => fallback,
		getDfgLut: () => dfg,
	} );

	assert.equal( resolved, dfg );

} );

test( 'builtin texture resolver falls back for unavailable LTC data and ignores unknown kinds', () => {

	const fallback = { uuid: 'fallback' };
	const fallbackTextureForBinding = ( artifact, bindingName ) => {

		assert.equal( bindingName, 'ltc' );
		return fallback;

	};

	assert.equal( resolveBuiltinTextureBinding( {
		artifact: { ltcTextures: [ [ 1, 2, 3 ] ] },
		bindingName: 'ltc',
		source: { kind: 'builtin.ltcTexture', ltcIndex: 0 },
		fallbackTextureForBinding,
	} ), fallback );

	assert.equal( resolveBuiltinTextureBinding( {
		artifact: {},
		bindingName: 'regularTexture',
		source: { kind: 'material.map' },
		fallbackTextureForBinding,
	} ), undefined );

} );
