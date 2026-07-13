/**
 * Snapshot tests for the Renderer.js three.js-source rewrite.
 *
 * Expected rewrite:
 *   - Construction `new QuadMesh(new NodeMaterial())` becomes
 *     `new QuadMesh(new Material())`.
 *   - Output cache/material ownership delegates to the graph-free replay
 *     adapter, including sampled texture topology and safe disposal.
 *   - Renderer context identity and high-precision state delegate to a
 *     graph-free replay carrier.
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

	// Renderer output imports only its exact replay owner.
	assert.match( out, /import\s*\{[^}]*getReplayRenderOutputCacheKey[^}]*createReplayRenderOutputMaterial[^}]*\}\s*from\s*["']virtual:tsl-precompile\/__slim-rewrite-runtime\/renderer-output["']/ );
	assert.doesNotMatch( out, /@tsl-precompile\/runtime['"]/ );
	assert.doesNotMatch( out, /__slim-rewrite-runtime\/render-pipeline/ );
	assert.doesNotMatch( out, /virtual:tsl-precompile\/__aux/ );

	// Renderer cache identity and high-precision selection no longer retain
	// ContextNode or the highp ModelNode graph in compiler-free replay.
	assert.match( out, /this\.contextNode\s*=\s*createReplayRendererContext\s*\(\s*\)/ );
	assert.match( out, /setReplayRendererHighPrecision\s*\(\s*this\s*,\s*value\s*\)/ );
	assert.match( out, /return getReplayRendererHighPrecision\s*\(\s*this\s*\)/ );
	assert.match( out, /from\s*["']virtual:tsl-precompile\/__slim-rewrite-runtime\/renderer-context["']/ );
	assert.doesNotMatch( out, /nodes\/core\/ContextNode\.js/ );
	assert.doesNotMatch( out, /\bhighpModel(?:Normal)?ViewMatrix\b/ );

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

test( 'rewrite/Renderer: shape-gate fails loudly when renderer context construction drifts', () => {

	const src = readFileSync( PATH, 'utf8' )
		.replace( 'this.contextNode = context();', 'this.contextNode = null;' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r );
	assert.equal( r.code, null );
	assert.match( r.warning, /contextNode.*shape changed|shape changed.*contextNode/ );

} );

test( 'rewrite/Renderer: shape-gate fails loudly when highPrecision semantics drift', () => {

	const src = readFileSync( PATH, 'utf8' )
		.replace(
			'contextNodeData.modelViewMatrix = highpModelViewMatrix;',
			'contextNodeData.modelViewMatrix = null;',
		);
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r );
	assert.equal( r.code, null );
	assert.match( r.warning, /highPrecision setter shape changed/ );

} );

test( 'rewrite/Renderer: ignores unrelated highPrecision accessors', () => {

	const src = readFileSync( PATH, 'utf8' ) + '\nclass ForeignPrecision { set highPrecision(value) { this.value = value; } get highPrecision() { return "foreign"; } }\n';
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r && r.code );
	assert.match( r.code, /class ForeignPrecision/ );
	assert.match( r.code, /return ["']foreign["']/ );
	assert.match( r.code, /this\.value\s*=\s*value/ );

} );
