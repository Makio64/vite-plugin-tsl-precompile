import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve( fileURLToPath( new URL( '../../../..', import.meta.url ) ) );

function source( path ) {

	return readFileSync( resolve( REPO, path ), 'utf8' );

}

function assertNoFullRendererEntry( text, label ) {

	for ( const forbidden of [
		'virtual:tsl-precompile/full-three',
		'/build/three.webgpu.js',
		'createFullRendererFallback',
		'loadThreeFullModule',
		'threeFullModule',
	] ) {

		assert.doesNotMatch( text, new RegExp( forbidden.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) ), `${ label } must not retain ${ forbidden }` );

	}

}

test( 'PMREM debug is a source-slim fixture that invokes the captured generator directly', () => {

	const config = source( 'packages/examples/pmrem-debug/vite.config.js' );
	const shared = source( 'packages/examples/pmrem-debug/src/shared.js' );
	assert.match( config, /slim:\s*'source'/ );
	assert.match( shared, /new PMREMGenerator\( renderer \)/ );
	assert.match( shared, /pmrem\.fromCubemap\( sourceTexture \)/ );
	assert.match( shared, /pmrem\.fromEquirectangular\( sourceTexture \)/ );
	assert.match( shared, /pmrem\.fromScene\( envScene,/ );
	assert.match( shared, /new MeshBasicNodeMaterial/ );
	for ( let face = 0; face < 4; face ++ ) {
		assert.equal( shared.includes( `material.precompile( 'pmrem-debug-env-face-${ face }' )` ), true );
	}
	assert.match( shared, /pmremSceneSizes:\s*mode === 'from-scene' \? \[ 64 \] : \[\]/ );
	assert.match( shared, /if \( import\.meta\.env\?\.PROD !== true && ! IS_E2E_REPLAY \) \{[\s\S]*import\( '@tsl-precompile\/runtime' \)/ );
	assert.doesNotMatch( shared, /import \{[^}]*\b(?:installPrecompileMarker|precompileAuxiliary|setDevRenderer)\b[^}]*\} from '@tsl-precompile\/runtime'/ );
	const geometry = shared.indexOf( 'const objects = addSceneGeometry(' );
	const markerRender = shared.indexOf( 'if ( captureRuntime && ! IS_E2E_REPLAY ) renderer.render( scene, camera );', geometry );
	const auxiliaryCapture = shared.indexOf( 'captureRuntime.precompileAuxiliary( renderer, scene, camera', geometry );
	assert.ok(
		geometry >= 0 && markerRender > geometry && auxiliaryCapture > markerRender,
		'the author render must claim every context-free material marker before auxiliary PMREM capture starts',
	);
	assertNoFullRendererEntry( `${ config }\n${ shared }`, 'PMREM debug' );

} );

test( 'VSM debug schedules captured passes before presentation through the no-fallback entry', () => {

	const config = source( 'packages/examples/shadow-debug/vite.config.js' );
	const shared = source( 'packages/examples/shadow-debug/src/shared.js' );
	assert.match( config, /slim:\s*'source'/ );
	assert.match( shared, /createPrecompiledShadowSupport\( \{ renderer \} \)/ );
	const tickStart = shared.indexOf( 'function tick() {' );
	const tickEnd = shared.indexOf( '// Material markers deliberately wait', tickStart );
	assert.ok( tickStart >= 0 && tickEnd > tickStart, 'expected the shadow-debug frame scheduler' );
	const tick = shared.slice( tickStart, tickEnd );
	const populate = tick.indexOf( 'precompiledShadowSupport.populateShadowMaps( scene, camera )' );
	const present = tick.indexOf( 'renderer.render( scene, camera )' );
	assert.ok( populate >= 0 && present > populate, 'captured VSM passes must run before presentation' );
	assert.match( shared, /shadowKind === 'vsm' && lightKind !== 'point'[\s\S]*createPrecompiledShadowSupport/ );
	assert.match(
		shared,
		/window\.addEventListener\( 'pagehide',[\s\S]*renderer\.setAnimationLoop\( null \);[\s\S]*precompiledShadowSupport\?\.dispose\(\);[\s\S]*renderer\.dispose\(\);[\s\S]*\{ once: true \}/,
		'page teardown must stop the animation loop before disposing VSM support and its renderer',
	);
	assertNoFullRendererEntry( `${ config }\n${ shared }`, 'VSM debug' );

} );

test( 'PMREM debug stops presentation before releasing its live environment target', () => {

	const shared = source( 'packages/examples/pmrem-debug/src/shared.js' );
	assert.match(
		shared,
		/window\.addEventListener\( 'pagehide',[\s\S]*renderer\.setAnimationLoop\( null \);[\s\S]*environmentTarget\.dispose\(\);[\s\S]*renderer\.dispose\(\);[\s\S]*\{ once: true \}/,
	);

} );
