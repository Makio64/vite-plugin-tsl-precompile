import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );

test( 'capture module removes and restores only the matching scene MRT', () => {

	const start = source.indexOf( '// Capture every explicit color sibling first.' );
	const end = source.indexOf( '// With every shared scene MRT restored', start );
	assert.ok( start >= 0 && end > start, 'expected the generated capture flush block' );
	const flush = source.slice( start, end );

	assert.match( flush, /const sceneUserData = item\.scene && item\.scene\.userData;/ );
	assert.match( flush, /sceneUserData && sceneUserData\.__tslp_mrtNode === sceneMRT/ );
	assert.match( flush, /removedSceneMRT = true;/ );
	assert.match( flush, /removedSceneMRT && sceneUserData\.__tslp_mrtNode === undefined/ );

} );

test( 'forced pipeline maintenance renders receive distinct non-advancing identities', () => {

	assert.match( source, /function __maintenanceTemporalFrame\( kind \)/ );
	assert.match( source, /renderId: 'maintenance:' \+ kind \+ ':' \+ frameId \+ ':' \+ \( \+\+ __maintenanceRenderSequence \)/ );
	assert.match( source, /__maintenanceTemporalFrame\( 'loader' \)/ );
	assert.match( source, /__maintenanceTemporalFrame\( 'shadow' \)/ );
	assert.match( source, /__maintenanceTemporalFrame\( 'compute' \)/ );
	assert.match( source, /advance: false,/ );

} );

test( 'capture module never queues Three renderer-owned shadow overrides as user materials', () => {

	const start = source.indexOf( 'function __markSceneMaterials( scene, camera = null )' );
	const end = source.indexOf( '// QuadMesh.render(renderer)', start );
	assert.ok( start >= 0 && end > start, 'expected the scene material marker' );
	const marker = source.slice( start, end );
	const shadowGuard = marker.indexOf( 'scene.overrideMaterial.isShadowPassMaterial === true' );
	const overrideCapture = marker.indexOf( 'if ( scene.overrideMaterial ) {' );
	assert.ok( shadowGuard >= 0, 'expected the renderer-owned shadow override guard' );
	assert.ok( overrideCapture > shadowGuard, 'shadow overrides must be rejected before generic override capture' );

} );
