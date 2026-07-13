/**
 * Snapshot tests for the Renderer.js three.js-source rewrite.
 *
 * Expected rewrite:
 *   - Construction `new QuadMesh(new NodeMaterial())` becomes
 *     `new QuadMesh(new Material())`.
 *   - Output cache/material ownership delegates to the graph-free replay
 *     adapter, including sampled texture topology and safe disposal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';

import { rewriteThreeSource } from '../../src/three-rewrite.js';
import { THREE_SRC } from '../_three-src.js';
const PATH = resolve( THREE_SRC, 'renderers/common/Renderer.js' );

test( 'rewrite/Renderer: NodeMaterial replaced with Material sentinel + fragmentNode swap', () => {

	const src = readFileSync( PATH, 'utf8' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r, 'handler should return a result' );
	assert.equal( r.warning, null, `expected no warning; got: ${ r.warning }` );

	const out = r.code;
	assert.doesNotMatch( out, /new NodeMaterial\s*\(/ );
	assert.match( out, /new QuadMesh\s*\(\s*new Material\s*\(\s*\)\s*\)/ );
	assert.match( out, /\.material\s*=\s*createReplayRenderOutputMaterial\s*\(/ );
	assert.match( out, /getReplayRenderOutputCacheKey\s*\(\s*this\s*,\s*renderTarget\.texture\s*\)/ );
	assert.match( out, /renderTarget\.texture/ );
	assert.doesNotMatch( out, /this\._nodes\.getOutputNode/ );
	assert.doesNotMatch( out, /this\._nodes\.getOutputCacheKey/ );

	// Original fragmentNode assignment LHS should be gone.
	assert.doesNotMatch( out, /\.material\.fragmentNode\s*=/ );

	// Material import added (named specifier, matches three's named export).
	assert.match( out, /import\s*\{[^}]*\bMaterial\b[^}]*\}\s*from\s*["'][^"']*\/Material\.js["']/ );

	// Runtime imports + aux side-effect
	assert.match( out, /from ['"]@tsl-precompile\/runtime['"]/ );
	assert.match( out, /createReplayRenderOutputMaterial/ );
	assert.match( out, /virtual:tsl-precompile\/__aux/ );

} );

test( 'rewrite/Renderer: output parses as valid ESM', () => {

	const src = readFileSync( PATH, 'utf8' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r && r.code );
	assert.doesNotThrow( () => parse( r.code, { sourceType: 'module', plugins: [ 'importAttributes' ] } ) );

} );

test( 'rewrite/Renderer: shape-gate fails loudly when late assignment is missing', () => {

	// Strip the fragmentNode assignment line to simulate shape drift.
	const src = readFileSync( PATH, 'utf8' )
		.replace( /quad\.material\.fragmentNode\s*=[^;]+;/g, '' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r );
	assert.equal( r.code, null );
	assert.match( r.warning, /shape changed/ );

} );
