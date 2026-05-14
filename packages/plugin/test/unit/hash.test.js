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

test( 'hash — different graph → different hash', () => {

	const matA = fakeMat( { colorNode: { constructor: { type: 'ColorNode' }, isUniformNode: true, value: { isColor: true, r: 1, g: 0, b: 0 } } } );
	const matB = fakeMat( { colorNode: { constructor: { type: 'ColorNode' }, isUniformNode: true, value: { isColor: true, r: 0, g: 0, b: 1 } } } );
	const a = computeArtifactHash( matA, { name: 'x', threeVersion: '175', pluginVersion: '0.0.0' } );
	const b = computeArtifactHash( matB, { name: 'x', threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.notEqual( a, b );

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
