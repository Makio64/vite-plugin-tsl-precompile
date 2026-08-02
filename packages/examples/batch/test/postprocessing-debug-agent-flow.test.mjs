import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readExampleSource = ( name ) => readFileSync(
	new URL( `../../postprocessing-debug/src/${ name }`, import.meta.url ),
	'utf8',
);

test( 'postprocessing debug uses the one-call setup and settles real marker renders before aux capture', () => {

	const captureRuntime = readExampleSource( 'capture-runtime.js' );
	const shared = readExampleSource( 'shared.js' );

	assert.match( captureRuntime, /runtime\.setupPrecompile\(\s*\{/ );
	assert.match( captureRuntime, /captureRendererOutput:\s*false/ );
	assert.match( captureRuntime, /await setup\.ready;/ );
	assert.match( shared, /matching\.length !== 1/ );
	assert.match( shared, /named capture/ );
	const preflight = shared.indexOf( '\t\trenderFrame();' );
	const markerSettlement = shared.indexOf( '\t\tawait capture.setup.waitForCaptureSettled( {' );
	const auxiliaryCapture = shared.indexOf( '\tconst auxResults = [];' );
	assert.ok( preflight > 0 );
	assert.ok( markerSettlement > preflight );
	assert.ok( auxiliaryCapture > markerSettlement );

} );

test( 'postprocessing variant capture renders every dormant material state before aux capture', () => {

	const variants = readExampleSource( 'variants.js' );
	const stateMatrix = variants.indexOf( '\t\tawait renderCaptureStatesOncePerFrame(' );
	const markerSettlement = variants.indexOf( '\t\tawait capture.setup.waitForCaptureSettled( {' );
	const auxiliaryCapture = variants.indexOf( '\tconst plainAux = await ensurePipelineAux(' );
	const bloomPreflight = variants.indexOf( '\t\t\t\tpost.bloom.render();' );

	assert.ok( stateMatrix > 0 );
	assert.ok( bloomPreflight > 0 );
	assert.ok( markerSettlement > stateMatrix );
	assert.ok( auxiliaryCapture > markerSettlement );
	assert.match( variants, /const variantName = VARIANT_ORDER\[ variantIndex \];\s+variants\.select\( variantName, cube \);\s+post\.plain\.render\(\);\s+variantIndex \+\+;/ );
	assert.match( variants, /variants\.select\( 'ember', cube \);\s+post\.bloom\.render\(\);\s+finish\(\);/ );
	assert.match( variants, /await renderCaptureStatesOncePerFrame\( renderer, post, variants, cube \);\s+await capture\.setup\.waitForCaptureSettled/ );
	assert.match( variants, /bloomPipeline\.outputColorTransform = false;\s+bloomPipeline\.outputNode = renderOutput\( scenePassColor\.add\( bloom\( scenePassColor \) \) \);/ );

} );

test( 'postprocessing routes keep async preflight and named capture inside the evidence readiness gate', () => {

	const siteStatus = readExampleSource( 'site-status.js' );
	assert.match( siteStatus, /export function runLiveRouteSetup\( start \)/ );
	assert.match( siteStatus, /__tslpLoaderPending/ );
	assert.match( siteStatus, /Promise\.resolve\( setup \)\.finally/ );

	for ( const name of [ 'passthrough.js', 'bloom.js', 'fxaa.js', 'gtao.js' ] ) {

		assert.match( readExampleSource( name ), /runLiveRouteSetup\( \(\) => runPostProcessingDebugExample/ );

	}
	assert.match( readExampleSource( 'variants.js' ), /runLiveRouteSetup\( main \);/ );

} );
