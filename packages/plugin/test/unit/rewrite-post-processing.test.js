/**
 * Snapshot tests for the PostProcessing.js three.js-source rewrite.
 *
 * Expected rewrite:
 *   - `const material = new NodeMaterial()` becomes `const material = new Material()`.
 *   - `this._quadMesh.material.fragmentNode = <expr>` becomes
 *     `this._quadMesh.material = new PrecompiledMaterial(loadAux('render-output', hashNodeGraphSync(<expr>, { shape: 'render-output', ...__tslpHashOpts })))`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';

import { rewriteThreeSource } from '../../src/three-rewrite.js';
import { THREE_SRC } from '../_three-src.js';
const PATH = resolve( THREE_SRC, 'renderers/common/RenderPipeline.js' );

test( 'rewrite/PostProcessing: bare NodeMaterial → Material sentinel; fragmentNode swap', () => {

	const src = readFileSync( PATH, 'utf8' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r, 'handler should return a result' );
	assert.equal( r.warning, null, `expected no warning; got: ${ r.warning }` );

	const out = r.code;
	assert.doesNotMatch( out, /new NodeMaterial\s*\(/ );
	assert.match( out, /const\s+material\s*=\s*new\s+Material\s*\(\s*\)/ );
	assert.match( out, /this\._quadMesh\.material\s*=/ );
	assert.match( out, /new PrecompiledMaterial\s*\(/ );
	assert.match( out, /preparePrecompiledPostprocess\s*\(/ );
	assert.match( out, /attachPostprocessTextureRefs\s*\(/ );
	assert.match( out, /attachPostprocessUpdateBeforeNodes\s*\(/ );
	assert.match( out, /attachPostprocessObject3DTargets\s*\(/ );
	assert.match( out, /loadAux\s*\(\s*["']post-process["']/ );
	assert.match( out, /hashNodeGraphSync\s*\(\s*this\.outputNode/ );
	assert.match( out, /shape:\s*["']post-process["']/ );

	// Original fragmentNode assignment LHS should be gone.
	assert.doesNotMatch( out, /\.material\.fragmentNode\s*=/ );

	// Runtime imports + aux side-effect + Material import
	assert.match( out, /from ['"]@tsl-precompile\/runtime['"]/ );
	assert.match( out, /attachPostprocessObject3DTargets/ );
	assert.match( out, /virtual:tsl-precompile\/__aux/ );

} );

test( 'rewrite/PostProcessing: output parses as valid ESM', () => {

	const src = readFileSync( PATH, 'utf8' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r && r.code );
	assert.doesNotThrow( () => parse( r.code, { sourceType: 'module', plugins: [ 'importAttributes' ] } ) );

} );

test( 'rewrite/PostProcessing: shape-gate fails loudly when fragmentNode assignment is missing', () => {

	const src = readFileSync( PATH, 'utf8' )
		.replace( /this\._quadMesh\.material\.fragmentNode\s*=[^;]+;/, '' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r );
	assert.equal( r.code, null );
	assert.match( r.warning, /shape changed/ );

} );
