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
	findAux,
	bindAuxByName,
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
	assert.throws(
		() => loadAux( 'background', 'cccc' ),
		( err ) => /no artifact for "background:cccc"/.test( err.message ) && /\(none\)/.test( err.message ),
	);

} );

test( 'aux-loader: miss falls back to the first artifact for the shape with a warning', () => {

	__resetAuxRegistryForTests();
	const artifact = { x: 1 };
	const second = { x: 2 };
	registerAuxArtifact( 'background', 'aaaa', artifact );
	registerAuxArtifact( 'background', 'bbbb', second );
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = ( message ) => warnings.push( message );
	try {

		assert.equal( loadAux( 'background', 'stub-hash' ), artifact );

	} finally {

		console.warn = originalWarn;

	}
	assert.equal( warnings.length, 1 );
	assert.match( warnings[ 0 ], /shape-compatible fallback/ );
	assert.match( warnings[ 0 ], /background:stub-hash/ );
	assert.match( warnings[ 0 ], /background:aaaa/ );

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

test( 'aux-loader: render-output fragCoord divisor uses live renderer size', () => {

	__resetAuxRegistryForTests();
	const artifact = {
		materialShape: 'render-output',
		vertexShader: '',
		fragmentShader: 'nodeVar0 = textureSample( nodeUniform0, nodeUniform0_sampler, ( fragCoord.xy / object.nodeUniform1 ) );',
		uniformPlan: [ {
			name: 'object',
			slots: [
				{
					name: 'nodeUniform1',
					dtype: 'vec2',
					source: { kind: 'uniform.live', valueSnapshot: { type: 'vec2', data: [ 512, 512 ] } },
				},
			],
			orderedBindings: [ {
				type: 'ubo',
				slots: [
					{
						name: 'nodeUniform1',
						dtype: 'vec2',
						source: { kind: 'uniform.live', valueSnapshot: { type: 'vec2', data: [ 512, 512 ] } },
					},
				],
			} ],
		} ],
	};

	registerAuxArtifact( 'render-output', 'hash-ro', artifact );
	const loaded = loadAux( 'render-output', 'hash-ro' );

	assert.equal( loaded.uniformPlan[ 0 ].slots[ 0 ].source.kind, 'renderer.size' );
	assert.equal( loaded.uniformPlan[ 0 ].orderedBindings[ 0 ].slots[ 0 ].source.kind, 'renderer.size' );

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

test( 'aux-loader: named aux captures can be found and bound to a node', () => {

	__resetAuxRegistryForTests();
	const artifact = { kind: 'pp' };
	registerAuxArtifact( 'post-process', 'hash-pp', artifact, { name: 'scene-bloom' } );

	const listed = listAux();
	assert.equal( listed.length, 1 );
	assert.equal( listed[ 0 ].name, 'scene-bloom' );
	assert.equal( findAux( 'post-process', 'scene-bloom' ).configHash, 'hash-pp' );

	const node = { isNode: true };
	bindAuxByName( node, 'post-process', 'scene-bloom' );
	assert.equal( node.__tslpAuxConfigHash, 'hash-pp' );
	assert.equal( node.__tslpAuxShape, 'post-process' );

} );

test( 'aux-loader: empty/invalid inputs reject', () => {

	__resetAuxRegistryForTests();
	assert.throws( () => registerAuxArtifact( '', 'abc', {} ), /shape/ );
	assert.throws( () => registerAuxArtifact( 'background', '', {} ), /configHash/ );

} );
