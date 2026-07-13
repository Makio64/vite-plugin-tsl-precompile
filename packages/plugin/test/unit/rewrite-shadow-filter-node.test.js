/**
 * Snapshot tests for the ShadowFilterNode.js three.js-source rewrite.
 *
 * Expected rewrite:
 *   - `material = new NodeMaterial()` becomes a `PrecompiledMaterial` built
 *     from `getShadowArtifact(light)`.
 *   - The baked `material.colorNode = vec4(...)` graph assignment is removed.
 *   - Shadow-pass material flags remain assigned on the replacement material.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';

import { rewriteThreeSource } from '../../src/three-rewrite.js';
import { THREE_SRC } from '../_three-src.js';

const PATH = resolve( THREE_SRC, 'nodes/lighting/ShadowFilterNode.js' );

test( 'rewrite/ShadowFilterNode: shadow material uses registered precompiled artifact', () => {

	const src = readFileSync( PATH, 'utf8' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '184', pluginVersion: '0.0.0' } );
	assert.ok( r, 'handler should return a result' );
	assert.equal( r.warning, null, `expected no warning; got: ${ r.warning }` );

	const out = r.code;
	assert.doesNotMatch( out, /new NodeMaterial\s*\(/ );
	assert.doesNotMatch( out, /material\.colorNode\s*=/ );
	assert.match( out, /const\s+artifact\s*=\s*getShadowArtifact\s*\(\s*light\s*\)/ );
	assert.match( out, /new PrecompiledMaterial\s*\(\s*artifact\s*\)/ );
	assert.match( out, /material\.isShadowPassMaterial\s*=\s*true/ );
	assert.match( out, /material\.name\s*=\s*['"]ShadowMaterial['"]/ );
	assert.match( out, /material\.blending\s*=\s*NoBlending/ );
	assert.match( out, /material\.fog\s*=\s*false/ );
	assert.match( out, /shadowMaterialLib\.set\s*\(\s*light\s*,\s*material\s*\)/ );
	assert.match( out, /no shadow-depth artifact is registered/ );

	assert.match( out, /import PrecompiledMaterial from ["']virtual:tsl-precompile\/__slim-rewrite-runtime\/precompiled-material["']/ );
	assert.match( out, /import\s*\{\s*getShadowArtifact\s*\}\s*from\s*["']virtual:tsl-precompile\/__slim-rewrite-runtime\/artifact-registry["']/ );
	assert.doesNotMatch( out, /@tsl-precompile\/runtime['"]/ );
	assert.doesNotMatch( out, /virtual:tsl-precompile\/__aux/ );

} );

test( 'rewrite/ShadowFilterNode: output parses as valid ESM', () => {

	const src = readFileSync( PATH, 'utf8' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '184', pluginVersion: '0.0.0' } );
	assert.ok( r && r.code );
	assert.doesNotThrow( () => parse( r.code, { sourceType: 'module', plugins: [ 'importAttributes' ] } ) );

} );

test( 'rewrite/ShadowFilterNode: shape-gate fails loudly when colorNode assignment is missing', () => {

	const src = readFileSync( PATH, 'utf8' )
		.replace( /material\.colorNode\s*=\s*vec4\([^;]+;/, '' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '184', pluginVersion: '0.0.0' } );
	assert.ok( r );
	assert.equal( r.code, null );
	assert.match( r.warning, /shape changed/ );

} );
