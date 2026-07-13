/**
 * Snapshot tests for the Background.js three.js-source rewrite.
 *
 * Expected:
 *   - `const nodeMaterial = new NodeMaterial()` becomes
 *     `const nodeMaterial = new PrecompiledMaterial(loadAux('background',
 *         hashNodeGraphSync(backgroundNode, { shape: 'background', ...__tslpHashOpts })))`.
 *   - The `.vertexNode` and `.colorNode` assignments are removed.
 *   - Non-graph assignments (side, depthTest, depthWrite, fog, lights, etc.) remain.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';

import { rewriteThreeSource } from '../../src/three-rewrite.js';
import { THREE_SRC } from '../_three-src.js';
const PATH = resolve( THREE_SRC, 'renderers/common/Background.js' );

test( 'rewrite/Background: NodeMaterial → PrecompiledMaterial(loadAux(background, …))', () => {

	const src = readFileSync( PATH, 'utf8' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r, 'handler should return a result' );
	assert.equal( r.warning, null, `expected no warning; got: ${ r.warning }` );

	const out = r.code;
	assert.doesNotMatch( out, /new NodeMaterial\s*\(/ );
	assert.match( out, /const\s+nodeMaterial\s*=\s*new\s+PrecompiledMaterial\s*\(/ );
	assert.match( out, /loadAux\s*\(\s*["']background["']/ );
	assert.match( out, /hashNodeGraphSync\s*\(\s*backgroundNode/ );
	assert.match( out, /shape:\s*["']background["']/ );
	assert.match( out, /import PrecompiledMaterial from ["']virtual:tsl-precompile\/__slim-rewrite-runtime\/precompiled-material["']/ );
	assert.match( out, /__slim-rewrite-runtime\/aux-loader/ );
	assert.match( out, /__slim-rewrite-runtime\/graph-hash/ );
	assert.doesNotMatch( out, /@tsl-precompile\/runtime['"]/ );

	// Graph assignments gone.
	assert.doesNotMatch( out, /nodeMaterial\.colorNode\s*=/ );
	assert.doesNotMatch( out, /nodeMaterial\.vertexNode\s*=/ );

	// Non-graph assignments retained.
	assert.match( out, /nodeMaterial\.side\s*=\s*BackSide/ );
	assert.match( out, /nodeMaterial\.depthTest\s*=\s*false/ );
	assert.match( out, /nodeMaterial\.allowOverride\s*=\s*false/ );
	assert.match( out, /nodeMaterial\.fog\s*=\s*false/ );

} );

test( 'rewrite/Background: output parses as valid ESM', () => {

	const src = readFileSync( PATH, 'utf8' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r && r.code );
	assert.doesNotThrow( () => parse( r.code, { sourceType: 'module', plugins: [ 'importAttributes' ] } ) );

} );

test( 'rewrite/Background: shape-gate fails loudly when colorNode assignment is missing', () => {

	const src = readFileSync( PATH, 'utf8' )
		.replace( /nodeMaterial\.colorNode\s*=[^;]+;/, '' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r );
	assert.equal( r.code, null );
	assert.match( r.warning, /shape changed/ );

} );
