/**
 * Snapshot test for the CubeRenderTarget three.js-source rewrite.
 *
 * Feeds the verbatim three.js CubeRenderTarget.js into `rewriteThreeSource`
 * and asserts structural properties of the output:
 *
 *   a. The exact r185 graph is replaced by the private replay adapter.
 *   b. All four graph imports and both graph statements are gone.
 *   c. Three's filter/MRT/camera/disposal behavior is unchanged.
 *   d. Shape drift fails closed.
 *   e. Output parses as valid ESM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';

import { rewriteThreeSource } from '../../src/three-rewrite.js';
import { THREE_SRC } from '../_three-src.js';
const CUBE_RT_PATH = resolve( THREE_SRC, 'renderers/common/CubeRenderTarget.js' );

function rewrite( source = readFileSync( CUBE_RT_PATH, 'utf8' ) ) {

	return rewriteThreeSource( source, CUBE_RT_PATH, { threeVersion: '0.185.1', pluginVersion: '0.0.0' } );

}

test( 'rewrite/CubeRenderTarget: removes the graph and delegates exact artifact selection', () => {

	const source = readFileSync( CUBE_RT_PATH, 'utf8' );
	const result = rewrite( source );
	assert.ok( result, 'rewriteThreeSource should return a non-null result' );
	assert.equal( result.warning, null, `expected no warning, got: ${ result.warning }` );

	const out = result.code;

	assert.match( out, /const replayMaterial\s*=\s*createReplayCubeRenderTargetMaterial\(texture,\s*this\)/ );
	assert.match( out, /const material\s*=\s*replayMaterial/ );
	assert.match( out, /import\s*\{\s*createReplayCubeRenderTargetMaterial\s*\}\s*from\s*["']virtual:tsl-precompile\/__slim-rewrite-runtime\/cube-render-target["']/ );
	assert.doesNotMatch( out, /new NodeMaterial\s*\(/ );
	assert.doesNotMatch( out, /const uvNode\s*=/ );
	assert.doesNotMatch( out, /material\.colorNode\s*=/ );
	assert.doesNotMatch( out, /\bequirectUV\b/ );
	assert.doesNotMatch( out, /\bpositionWorldDirection\b/ );
	assert.doesNotMatch( out, /\bTSL_Texture\b/ );
	assert.doesNotMatch( out, /\bNodeMaterial\b/ );
	assert.doesNotMatch( out, /\/nodes\/(?:utils\/EquirectUV|accessors\/(?:TextureNode|Position))\.js/ );
	assert.doesNotMatch( out, /\/materials\/nodes\/NodeMaterial\.js/ );

	assert.match( out, /material\.side\s*=\s*BackSide/ );
	assert.match( out, /material\.blending\s*=\s*NoBlending/ );
	assert.match( out, /texture\.minFilter\s*=\s*LinearFilter/ );
	assert.match( out, /const currentMRT\s*=\s*renderer\.getMRT\(\)/ );
	assert.match( out, /renderer\.setMRT\(null\)/ );
	assert.match( out, /camera\.update\(renderer, scene\)/ );
	assert.match( out, /renderer\.setMRT\(currentMRT\)/ );
	assert.match( out, /texture\.minFilter\s*=\s*currentMinFilter/ );
	assert.match( out, /texture\.generateMipmaps\s*=\s*currentGenerateMipmaps/ );
	assert.match( out, /mesh\.geometry\.dispose\(\)/ );
	assert.match( out, /mesh\.material\.dispose\(\)/ );

	assert.doesNotMatch( out, /__slim-rewrite-runtime\/(?:precompiled-material|aux-loader|graph-hash)/ );
	assert.doesNotMatch( out, /@tsl-precompile\/runtime['"]/ );
	assert.doesNotMatch( out, /virtual:tsl-precompile\/__aux/ );
	assert.doesNotMatch( out, /__tslpHashOpts/ );

	const lookupAt = out.indexOf( 'createReplayCubeRenderTargetMaterial(texture, this)' );
	const sourceSnapshotAt = out.indexOf( 'const currentMinFilter' );
	const sourceMutationAt = out.indexOf( 'texture.generateMipmaps = true' );
	const geometryAt = out.indexOf( 'new BoxGeometry' );
	assert.ok( lookupAt >= 0 );
	assert.ok( lookupAt < sourceSnapshotAt, 'artifact lookup preflights before reading mutable source state' );
	assert.ok( lookupAt < sourceMutationAt, 'a missing artifact cannot leak source texture mutations' );
	assert.ok( lookupAt < geometryAt, 'a missing artifact cannot leak an allocated geometry' );

} );

test( 'rewrite/CubeRenderTarget: output parses as valid ESM', () => {

	const source = readFileSync( CUBE_RT_PATH, 'utf8' );
	const result = rewrite( source );
	assert.ok( result && result.code );
	assert.doesNotThrow( () => parse( result.code, { sourceType: 'module', plugins: [ 'importAttributes' ] } ) );

} );

test( 'rewrite/CubeRenderTarget: shape-gate fails loudly when the graph assignment drifts', () => {

	// Remove the material.colorNode = ... line to simulate a three.js shape
	// that no longer matches expectations. The handler should throw and the
	// public API should return a warning, not a rewritten source.
	const source = readFileSync( CUBE_RT_PATH, 'utf8' )
		.replace( /material\.colorNode\s*=\s*TSL_Texture[^;]+;/, '' );

	const result = rewrite( source );
	assert.ok( result, 'handler should return a result even on shape drift' );
	assert.equal( result.code, null );
	assert.match( result.warning, /shape changed|shape drifted/ );

} );

for ( const [ label, mutate ] of [
	[ 'uv input', ( source ) => source.replace( 'equirectUV( positionWorldDirection )', 'equirectUV( positionViewDirection )' ) ],
	[ 'texture input', ( source ) => source.replace( 'TSL_Texture( texture, uvNode, 0 )', 'TSL_Texture( otherTexture, uvNode, 0 )' ) ],
	[ 'texture level', ( source ) => source.replace( 'TSL_Texture( texture, uvNode, 0 )', 'TSL_Texture( texture, uvNode, 1 )' ) ],
	[ 'material constructor', ( source ) => source.replace( 'new NodeMaterial()', 'new NodeMaterial( options )' ) ],
	[ 'side state', ( source ) => source.replace( 'material.side = BackSide', 'material.side = FrontSide' ) ],
	[ 'blend state', ( source ) => source.replace( 'material.blending = NoBlending', 'material.blending = NormalBlending' ) ],
	[ 'source restoration', ( source ) => source.replace( 'texture.generateMipmaps = currentGenerateMipmaps;', '' ) ],
	[ 'cube camera', ( source ) => source.replace( 'new CubeCamera( 1, 10, this )', 'new CubeCamera( 0.1, 10, this )' ) ],
	[ 'MRT restoration', ( source ) => source.replace( 'renderer.setMRT( currentMRT );', '' ) ],
	[ 'material disposal', ( source ) => source.replace( 'mesh.material.dispose();', '' ) ],
] ) {

	test( `rewrite/CubeRenderTarget: fails closed on ${ label } drift`, () => {

		const source = mutate( readFileSync( CUBE_RT_PATH, 'utf8' ) );
		const result = rewrite( source );
		assert.ok( result );
		assert.equal( result.code, null );
		assert.match( result.warning, /shape changed|shape drifted/ );

	} );

}

test( 'rewrite/CubeRenderTarget: not-a-target file returns null (no transformation)', () => {

	const unrelated = 'export const foo = 1;';
	const result = rewriteThreeSource( unrelated, '/some/unrelated/file.js', { threeVersion: '0.185.1', pluginVersion: '0.0.0' } );
	assert.equal( result, null );

} );
