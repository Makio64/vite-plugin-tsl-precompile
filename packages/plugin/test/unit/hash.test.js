import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeArtifactHash, normalizeMaterialGraph } from '../../src/hash.js';

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
