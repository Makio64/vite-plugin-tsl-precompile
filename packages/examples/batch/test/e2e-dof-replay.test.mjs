import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync( new URL( '../e2e-slim-replay-module.mjs', import.meta.url ), 'utf8' );

test( 'DoF full-renderer replay shares both producer input graphs', () => {

	const start = source.indexOf( 'function __shareDOFInputTexturesBetweenRenderers(' );
	const end = source.indexOf( 'function __renderDOFNodeWithFullRenderer(', start );
	assert.ok( start >= 0 && end > start, 'expected the DoF input-sharing helper' );

	const color = { isTexture: true, name: 'output' };
	const depth = { isTexture: true, name: 'depth' };
	const shared = [];
	const collectCalls = [];
	const share = Function(
		'__collectGraphTexturesByName',
		'__shareGPUTextureEntry',
		`"use strict";\n${ source.slice( start, end ) }\nreturn __shareDOFInputTexturesBetweenRenderers;`,
	)(
		( inputNode ) => {

			collectCalls.push( inputNode );
			return inputNode.kind === 'color'
				? new Map( [ [ 'output', [ color ] ], [ '__dimension:2d', [ color ] ] ] )
				: new Map( [ [ 'depth', [ depth ] ] ] );

		},
		( targetRenderer, sourceRenderer, texture ) => {

			shared.push( { targetRenderer, sourceRenderer, texture } );

		},
	);
	const targetRenderer = {};
	const sourceRenderer = {};
	const textureNode = { kind: 'color' };
	const viewZNode = { kind: 'depth' };

	assert.equal( share( targetRenderer, sourceRenderer, { textureNode, viewZNode } ), 2 );
	assert.deepEqual( collectCalls, [ textureNode, viewZNode ] );
	assert.deepEqual( shared, [
		{ targetRenderer, sourceRenderer, texture: color },
		{ targetRenderer, sourceRenderer, texture: depth },
	] );

} );

test( 'DoF replay diagnostics retain live effect-control uniform values', () => {

	const start = source.indexOf( 'function __readDOFUniformValue(' );
	const end = source.indexOf( 'function __renderDOFNodeWithFullRenderer(', start );
	assert.ok( start >= 0 && end > start, 'expected the DoF uniform reader' );

	const read = Function(
		'__readGraphOwnValue',
		`"use strict";\n${ source.slice( start, end ) }\nreturn __readDOFUniformValue;`,
	)( ( node, key ) => node[ key ] );

	assert.equal( read( { value: 500 } ), 500 );
	assert.equal( read( { _value: 200 } ), 200 );
	assert.equal( read( { value: { x: 1 } } ), null );
	assert.equal( read( null ), null );

} );

test( 'DoF fallback limits cross-renderer input sharing to producer graphs', () => {

	const start = source.indexOf( 'function __renderDOFNodeWithFullRenderer(' );
	const end = source.indexOf( 'function __patchDOFNodeUpdateBefore(', start );
	assert.ok( start >= 0 && end > start, 'expected the DoF full-renderer fallback' );
	const helper = source.slice( start, end );

	assert.match( helper, /__shareDOFInputTexturesBetweenRenderers\( fullRenderer, slimRenderer, dofNode \)/ );
	assert.doesNotMatch( helper, /__shareGraphTexturesBetweenRenderers\( fullRenderer, slimRenderer, dofNode/ );

} );
