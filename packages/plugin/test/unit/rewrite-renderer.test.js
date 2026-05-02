/**
 * Snapshot tests for the Renderer.js three.js-source rewrite.
 *
 * Expected rewrite:
 *   - Construction `new QuadMesh(new NodeMaterial())` becomes
 *     `new QuadMesh(new Material())`.
 *   - Late `quad.material.fragmentNode = this._nodes.getOutputNode(renderTarget.texture)`
 *     becomes `quad.material = new PrecompiledMaterial(attachArtifactTextureRefs(loadAux('render-output', hashNodeGraphSync(..., { shape: 'render-output', ...__tslpHashOpts })), renderTarget.texture))`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

import { rewriteThreeSource } from '../../src/three-rewrite.js';

const HERE = dirname( fileURLToPath( import.meta.url ) );
const THREE_SRC = resolve( HERE, '../../../../node_modules/three/src' );
const PATH = resolve( THREE_SRC, 'renderers/common/Renderer.js' );

test( 'rewrite/Renderer: NodeMaterial replaced with Material sentinel + fragmentNode swap', () => {

	const src = readFileSync( PATH, 'utf8' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '175', pluginVersion: '0.0.0' } );
	assert.ok( r, 'handler should return a result' );
	assert.equal( r.warning, null, `expected no warning; got: ${ r.warning }` );

	const out = r.code;
	assert.doesNotMatch( out, /new NodeMaterial\s*\(/ );
	assert.match( out, /new QuadMesh\s*\(\s*new Material\s*\(\s*\)\s*\)/ );
	assert.match( out, /\.material\s*=\s*new PrecompiledMaterial\s*\(/ );
	assert.match( out, /loadAux\s*\(\s*["']render-output["']/ );
	assert.match( out, /attachArtifactTextureRefs\s*\(/ );
	assert.match( out, /renderTarget\.texture/ );
	assert.match( out, /hashNodeGraphSync\s*\(/ );
	assert.match( out, /shape:\s*["']render-output["']/ );
	assert.match( out, /\.\.\.__tslpHashOpts/ );

	// Original fragmentNode assignment LHS should be gone.
	assert.doesNotMatch( out, /\.material\.fragmentNode\s*=/ );

	// Material import added (named specifier, matches three's named export).
	assert.match( out, /import\s*\{[^}]*\bMaterial\b[^}]*\}\s*from\s*["'][^"']*\/Material\.js["']/ );

	// Runtime imports + aux side-effect
	assert.match( out, /from ['"]@tsl-precompile\/runtime['"]/ );
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
