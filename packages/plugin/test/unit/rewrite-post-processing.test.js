/**
 * Snapshot tests for the PostProcessing.js three.js-source rewrite.
 *
 * Expected rewrite:
 *   - `const material = new NodeMaterial()` becomes `const material = new Material()`.
 *   - `this._quadMesh.material.fragmentNode = <expr>` delegates to the
 *     graph-free replay adapter, which selects the captured real pipeline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';

import { rewriteThreeSource } from '../../src/three-rewrite.js';
import { THREE_SRC } from '../_three-src.js';
const PATH = resolve( THREE_SRC, 'renderers/common/RenderPipeline.js' );
const WRAPPER_PATH = resolve( THREE_SRC, 'renderers/common/PostProcessing.js' );

test( 'rewrite/PostProcessing: bare NodeMaterial → Material sentinel; fragmentNode swap', () => {

	const src = readFileSync( PATH, 'utf8' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r, 'handler should return a result' );
	assert.equal( r.warning, null, `expected no warning; got: ${ r.warning }` );

	const out = r.code;
	assert.doesNotMatch( out, /new NodeMaterial\s*\(/ );
	assert.match( out, /const\s+material\s*=\s*new\s+Material\s*\(\s*\)/ );
	assert.match( out, /this\._quadMesh\.material\s*=/ );
	assert.match( out, /createReplayRenderPipelineMaterial\s*\(\s*this\s*,\s*this\._quadMesh\.material\s*\)/ );
	assert.doesNotMatch( out, /outputNode\s*=\s*renderOutput\s*\(/ );
	assert.doesNotMatch( out, /import\s*\{[^}]*renderOutput[^}]*\}\s*from/ );
	assert.doesNotMatch( out, /nodes\/TSL\.js/ );

	// Original fragmentNode assignment LHS should be gone.
	assert.doesNotMatch( out, /\.material\.fragmentNode\s*=/ );

	// RenderPipeline imports only its exact replay owner.
	assert.match( out, /import\s*\{\s*createReplayRenderPipelineMaterial\s*\}\s*from\s*["']virtual:tsl-precompile\/__slim-rewrite-runtime\/render-pipeline["']/ );
	assert.doesNotMatch( out, /@tsl-precompile\/runtime['"]/ );
	assert.doesNotMatch( out, /__slim-rewrite-runtime\/renderer-output/ );
	assert.doesNotMatch( out, /virtual:tsl-precompile\/__aux/ );

} );

test( 'rewrite/PostProcessing: output parses as valid ESM', () => {

	const src = readFileSync( PATH, 'utf8' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r && r.code );
	assert.doesNotThrow( () => parse( r.code, { sourceType: 'module', plugins: [ 'importAttributes' ] } ) );

} );

test( 'rewrite/PostProcessing: verified RenderPipeline wrapper is an explicit safe no-op', () => {

	const source = readFileSync( WRAPPER_PATH, 'utf8' );
	const result = rewriteThreeSource( source, WRAPPER_PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.equal( result.noop, true );
	assert.equal( result.code, source );
	assert.equal( result.warning, null );

} );

test( 'rewrite/PostProcessing: shape-gate fails loudly when fragmentNode assignment is missing', () => {

	const src = readFileSync( PATH, 'utf8' )
		.replace( /this\._quadMesh\.material\.fragmentNode\s*=[^;]+;/, '' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r );
	assert.equal( r.code, null );
	assert.match( r.warning, /shape changed/ );

} );
