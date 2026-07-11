import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeArtifactHash, normalizeMaterialGraph } from '../../src/hash.js';
import { registerMaterial, unregisterMaterial, materialIdentity } from '@tsl-precompile/contract/graph-normalize';

test( 'hash — same material, same name, same versions → same hash', () => {

	const mat = fakeMat();
	const a = computeArtifactHash( mat, { name: 'x', threeVersion: '175', pluginVersion: '0.0.0' } );
	const b = computeArtifactHash( mat, { name: 'x', threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.equal( a, b );

} );

test( 'hash — different name → different hash', () => {

	const mat = fakeMat();
	const a = computeArtifactHash( mat, { name: 'x', threeVersion: '175', pluginVersion: '0.0.0' } );
	const b = computeArtifactHash( mat, { name: 'y', threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.notEqual( a, b );

} );

test( 'hash — different three version → different hash', () => {

	const mat = fakeMat();
	const a = computeArtifactHash( mat, { name: 'x', threeVersion: '175', pluginVersion: '0.0.0' } );
	const b = computeArtifactHash( mat, { name: 'x', threeVersion: '176', pluginVersion: '0.0.0' } );
	assert.notEqual( a, b );

} );

test( 'hash — live uniform value changes do not change the source hash', () => {

	const matA = fakeMat( { colorNode: { constructor: { type: 'ColorNode' }, isUniformNode: true, value: { isColor: true, r: 1, g: 0, b: 0 } } } );
	const matB = fakeMat( { colorNode: { constructor: { type: 'ColorNode' }, isUniformNode: true, value: { isColor: true, r: 0, g: 0, b: 1 } } } );
	const a = computeArtifactHash( matA, { name: 'x', threeVersion: '175', pluginVersion: '0.0.0' } );
	const b = computeArtifactHash( matB, { name: 'x', threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.equal( a, b );

} );

test( 'hash — shader constants remain part of source topology', () => {

	const matA = fakeMat( { colorNode: { constructor: { type: 'ColorNode' }, isConstNode: true, value: 1 } } );
	const matB = fakeMat( { colorNode: { constructor: { type: 'ColorNode' }, isConstNode: true, value: 2 } } );
	const opts = { name: 'x', threeVersion: '175', pluginVersion: '0.0.0' };
	assert.notEqual( computeArtifactHash( matA, opts ), computeArtifactHash( matB, opts ) );

} );

test( 'hash — random node/texture UUIDs and volatile clocks are ignored', () => {

	const textureA = { isTexture: true, uuid: 'random-a', type: 1009, format: 1023, colorSpace: 'srgb' };
	const textureB = { isTexture: true, uuid: 'random-b', type: 1009, format: 1023, colorSpace: 'srgb' };
	const matA = fakeMat( {
		map: textureA,
		colorNode: { constructor: { type: 'TextureNode' }, isNode: true, isUniformNode: true, isTextureNode: true, uuid: 'node-a', time: 1, value: textureA },
	} );
	const matB = fakeMat( {
		map: textureB,
		colorNode: { constructor: { type: 'TextureNode' }, isNode: true, isUniformNode: true, isTextureNode: true, uuid: 'node-b', time: 9999, value: textureB },
	} );
	const opts = { name: 'x', threeVersion: '175', pluginVersion: '0.0.0' };
	assert.equal( computeArtifactHash( matA, opts ), computeArtifactHash( matB, opts ) );

} );

test( 'hash — material map presence/type and topology flags invalidate', () => {

	const opts = { name: 'x', threeVersion: '175', pluginVersion: '0.0.0' };
	const base = computeArtifactHash( fakeMat( { side: 0, transparent: false, map: null } ), opts );
	assert.notEqual( base, computeArtifactHash( fakeMat( { side: 2, transparent: false, map: null } ), opts ) );
	assert.notEqual( base, computeArtifactHash( fakeMat( { side: 0, transparent: true, map: null } ), opts ) );
	assert.notEqual( base, computeArtifactHash( fakeMat( { side: 0, transparent: false, map: { isTexture: true } } ), opts ) );
	assert.notEqual(
		computeArtifactHash( fakeMat( { map: { isTexture: true } } ), opts ),
		computeArtifactHash( fakeMat( { map: { isTexture: true, isCubeTexture: true } } ), opts ),
	);

} );

test( 'hash — defines are canonical, while dynamic material scalars are ignored', () => {

	const opts = { name: 'x', threeVersion: '175', pluginVersion: '0.0.0' };
	const a = fakeMat( { roughness: 0.1, defines: { SECOND: 2, FIRST: 1 } } );
	const b = fakeMat( { roughness: 0.9, defines: { FIRST: 1, SECOND: 2 } } );
	assert.equal( computeArtifactHash( a, opts ), computeArtifactHash( b, opts ) );
	b.defines.SECOND = 3;
	assert.notEqual( computeArtifactHash( a, opts ), computeArtifactHash( b, opts ) );

} );

test( 'hash — physical feature values hash only their topology bucket', () => {

	const opts = { name: 'x', threeVersion: '175', pluginVersion: '0.0.0' };
	const disabled = computeArtifactHash( fakeMat( { transmission: 0 } ), opts );
	const enabledLow = computeArtifactHash( fakeMat( { transmission: 0.1 } ), opts );
	const enabledHigh = computeArtifactHash( fakeMat( { transmission: 1 } ), opts );
	assert.notEqual( disabled, enabledLow );
	assert.equal( enabledLow, enabledHigh );

} );

test( 'hash — render context remains separate from source identity', () => {

	const mat = fakeMat();
	const base = { name: 'x', threeVersion: '175', pluginVersion: '0.0.0' };
	const a = computeArtifactHash( mat, { ...base, renderContextSignature: { shadows: true, lights: [ 'Point', 'Ambient' ] } } );
	const b = computeArtifactHash( mat, { ...base, renderContextSignature: { lights: [ 'Point', 'Ambient' ], shadows: true } } );
	const c = computeArtifactHash( mat, { ...base, renderContextSignature: { lights: [ 'Ambient' ], shadows: true } } );
	assert.equal( a, b );
	assert.equal( a, c );

} );

test( 'normalize — empty name throws', () => {

	assert.throws( () => computeArtifactHash( fakeMat(), { name: '', threeVersion: '1', pluginVersion: '1' } ), TypeError );

} );

test( 'normalize — cycle-safe', () => {

	const a = { constructor: { type: 'A' } };
	const b = { constructor: { type: 'B' }, aNode: a };
	a.bNode = b;

	const mat = fakeMat( { colorNode: a } );
	// Should not stack overflow.
	const s = normalizeMaterialGraph( mat );
	assert.match( s, /cycle/ );

} );

function fakeMat( overrides = {} ) {

	return {
		constructor: { type: 'MeshStandardNodeMaterial' },
		colorNode: { constructor: { type: 'ColorNode' }, isUniformNode: true, value: { isColor: true, r: 0.5, g: 0.5, b: 0.5 } },
		roughnessNode: { constructor: { type: 'FloatNode' }, isUniformNode: true, value: 0.5 },
		...overrides,
	};

}

test( 'registerMaterial pins identity for a subclass across minified class names', () => {

	// Simulate a minifier-renamed subclass: the dev build's class name is
	// `MyMaterial`, the prod build's is `m`. Without registerMaterial the hash
	// would differ. With it, both builds resolve to the same identity.
	class DevClass {}
	class ProdClass {}      // pretends to be minified
	unregisterMaterial( DevClass );
	unregisterMaterial( ProdClass );

	registerMaterial( DevClass, { type: 'MyMaterial' } );
	registerMaterial( ProdClass, { type: 'MyMaterial' } );

	const dev = Object.create( DevClass.prototype );
	const prod = Object.create( ProdClass.prototype );

	assert.equal( materialIdentity( dev ), 'MyMaterial' );
	assert.equal( materialIdentity( prod ), 'MyMaterial' );
	assert.equal( normalizeMaterialGraph( dev ), normalizeMaterialGraph( prod ) );

	unregisterMaterial( DevClass );
	unregisterMaterial( ProdClass );

} );

test( 'registerMaterial is idempotent on identical descriptors; conflicts throw', () => {

	class FoxMaterial {}
	unregisterMaterial( FoxMaterial );
	registerMaterial( FoxMaterial, { type: 'Fox' } );
	const second = registerMaterial( FoxMaterial, { type: 'Fox' } );
	assert.equal( second, 'Fox' );
	assert.throws( () => registerMaterial( FoxMaterial, { type: 'Wolf' } ), /already registered/ );
	unregisterMaterial( FoxMaterial );

} );

test( 'registerMaterial validates inputs', () => {

	assert.throws( () => registerMaterial( null, { type: 'x' } ), /constructor/ );
	assert.throws( () => registerMaterial( class A {}, null ), /descriptor/ );
	assert.throws( () => registerMaterial( class B {}, {} ), /type must be a non-empty string/ );

} );

test( 'materialIdentity falls back to constructor.type then constructor.name', () => {

	assert.equal( materialIdentity( { constructor: { type: 'TypeWins' } } ), 'TypeWins' );
	assert.equal( materialIdentity( { constructor: { name: 'NameAsFallback' } } ), 'NameAsFallback' );
	assert.equal( materialIdentity( null ), 'UnknownMaterial' );

} );
