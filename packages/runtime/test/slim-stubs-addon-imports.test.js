import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as stubs from '../src/slim-stubs.js';

const require = createRequire( import.meta.url );
const supportedAddons = [ 'Bloom', 'GTAO', 'FXAA', 'SSS', 'Outline', 'SSR', 'DepthOfField', 'TRAA' ];

test( 'supported native display addons resolve their actual named TSL imports in slim mode', () => {

	for ( const addon of supportedAddons ) {

		const source = readFileSync( require.resolve( `three/addons/tsl/display/${ addon }Node.js` ), 'utf8' );
		const imports = [ ...source.matchAll( /import\s*\{([^}]+)\}\s*from\s*['"]three\/tsl['"]/g ) ];
		assert.ok( imports.length > 0, `${ addon }: actual native TSL import declaration found` );
		for ( const declaration of imports ) {

			for ( const binding of declaration[ 1 ].split( ',' ) ) {

				const name = binding.trim().split( /\s+as\s+/ )[ 0 ];
				assert.ok( Object.hasOwn( stubs, name ), `${ addon }: missing native TSL import ${ name }` );

			}

		}

	}

} );

test( 'r186 addon compatibility exports carry composition without executing a shader or callback', () => {

	let calls = 0;
	const callback = () => calls ++;
	for ( const node of [
		stubs.array( [ stubs.uniform( 1 ) ] ),
		stubs.getScreenPositionFromClip( stubs.vec4( 1 ) ),
		stubs.isBackgroundDepth( stubs.uniform( 1 ) ),
		stubs.lightPosition( { isLight: true } ),
		stubs.lightTargetPosition( { isLight: true } ),
		stubs.OnBeforeRenderPipeline( callback ),
		stubs.OnAfterRenderPipeline( callback ),
		stubs.velocity,
	] ) {

		assert.equal( node.isNode, true );
		assert.equal( node.mul( 0.5 ).isNode, true );

	}
	assert.equal( calls, 0 );

} );
