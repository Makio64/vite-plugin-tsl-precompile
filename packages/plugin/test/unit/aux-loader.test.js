/**
 * Runtime aux-loader — registry + lookup semantics.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	registerAuxArtifact,
	registerAuxArtifacts,
	loadAux,
	hasAux,
	listAux,
	__resetAuxRegistryForTests,
} from '../../../runtime/src/aux-loader.js';

test( 'aux-loader: register + load round-trip', () => {

	__resetAuxRegistryForTests();
	const artifact = { uniformPlan: [], vertexShader: '', fragmentShader: '' };
	registerAuxArtifact( 'background', 'abcd0123', artifact );
	assert.equal( hasAux( 'background', 'abcd0123' ), true );
	assert.equal( loadAux( 'background', 'abcd0123' ), artifact );

} );

test( 'aux-loader: miss throws with a clear diagnostic naming the shape and known hashes', () => {

	__resetAuxRegistryForTests();
	registerAuxArtifact( 'background', 'aaaa', { x: 1 } );
	registerAuxArtifact( 'background', 'bbbb', { x: 2 } );
	assert.throws(
		() => loadAux( 'background', 'cccc' ),
		( err ) => /no artifact for "background:cccc"/.test( err.message ) && /aaaa, bbbb/.test( err.message ),
	);

} );

test( 'aux-loader: different shapes with the same hash coexist', () => {

	__resetAuxRegistryForTests();
	const a = { kind: 'bg' };
	const b = { kind: 'pp' };
	registerAuxArtifact( 'background', 'same-hash', a );
	registerAuxArtifact( 'post-process', 'same-hash', b );
	assert.equal( loadAux( 'background', 'same-hash' ), a );
	assert.equal( loadAux( 'post-process', 'same-hash' ), b );

} );

test( 'aux-loader: registerAuxArtifacts (bulk) + listAux', () => {

	__resetAuxRegistryForTests();
	registerAuxArtifacts( [
		{ shape: 'background', configHash: 'h1', artifact: {} },
		{ shape: 'lights', configHash: 'h2', artifact: {} },
	] );
	const list = listAux().sort( ( a, b ) => a.shape.localeCompare( b.shape ) );
	assert.equal( list.length, 2 );
	assert.equal( list[ 0 ].shape, 'background' );
	assert.equal( list[ 0 ].configHash, 'h1' );
	assert.equal( list[ 1 ].shape, 'lights' );

} );

test( 'aux-loader: empty/invalid inputs reject', () => {

	__resetAuxRegistryForTests();
	assert.throws( () => registerAuxArtifact( '', 'abc', {} ), /shape/ );
	assert.throws( () => registerAuxArtifact( 'background', '', {} ), /configHash/ );

} );
