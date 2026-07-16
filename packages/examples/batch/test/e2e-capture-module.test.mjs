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

test( 'full-renderer shadow fallback does not double-apply captured position-node instancing', () => {

	const start = source.indexOf( 'function __buildShadowScene( userScene )' );
	const end = source.indexOf( 'function __refreshShadowScene( userScene, shadowScene )', start );
	assert.ok( start >= 0 && end > start, 'expected the shadow-scene builder' );
	const builder = source.slice( start, end );
	const sourceMaterial = builder.indexOf( 'const sourceMaterial =' );
	const exactPositionNode = builder.indexOf( 'const exactPositionNode =' );
	const heuristicProxy = builder.indexOf( ': __makeShaderInstancedShadowProxy(' );
	assert.ok( sourceMaterial >= 0 && exactPositionNode > sourceMaterial, 'source node material must be resolved before proxy selection' );
	assert.ok( heuristicProxy > exactPositionNode, 'the heuristic proxy must be confined to the no-exact-position-node branch' );
	assert.match( builder, /standin = standin \|\| \( exactPositionNode[\s\S]*\? new FullMesh\([\s\S]*: __makeShaderInstancedShadowProxy\(/ );
	assert.match( builder, /if \( o\.count !== undefined \) standin\.count = o\.count;/ );

	const refreshStart = end;
	const refreshEnd = source.indexOf( 'function __getOrBuildShadowScene( userScene )', refreshStart );
	const refresh = source.slice( refreshStart, refreshEnd );
	const countRefresh = refresh.indexOf( 'if ( src.count !== undefined ) clone.count = src.count;' );
	const trueInstancedBranch = refresh.indexOf( 'if ( src.isInstancedMesh === true && clone.isInstancedMesh === true )' );
	assert.ok( countRefresh >= 0 && countRefresh < trueInstancedBranch, 'plain Mesh node-instancing count must refresh outside the InstancedMesh-only branch' );

} );

test( 'delegated compute outputs receive a non-advancing presentation render', () => {

	assert.match( source, /computeSyncNeedsPresentation as __sharedComputeSyncNeedsPresentation/ );
	const start = source.indexOf( 'computeAsync( computeNode, ...rest ) {' );
	const end = source.indexOf( 'async getArrayBufferAsync( attribute, ...rest ) {', start );
	assert.ok( start >= 0 && end > start, 'expected the replay compute fallback' );
	const compute = source.slice( start, end );
	assert.match( compute, /const syncedOutputsNeedPresentation = __sharedComputeSyncNeedsPresentation\( syncStats \);/ );
	assert.match( compute, /if \( syncedOutputsNeedPresentation \) _forcePostComputeRender = true;/ );
	assert.match( source, /this\.__tslpTopLevelRenderSequence = \( this\.__tslpTopLevelRenderSequence \| 0 \) \+ 1;/ );
	assert.match( compute, /const _renderSequenceBeforeCompute = _slimRenderer\.__tslpTopLevelRenderSequence \| 0;/ );
	assert.match( compute, /const _bareSceneReplaySafe = _rendersAfterComputeRequest <= 1;/ );
	assert.match( compute, /else if \( sc && cam && _bareSceneReplaySafe \)/ );
	assert.match( compute, /diag\.skippedUnsafeSceneRenders/ );
	assert.match( compute, /__maintenanceTemporalFrame\( 'compute' \)[\s\S]*\(\) => _slimRenderer\.render\( sc, cam \)/ );

} );

test( 'initialized delegated compute preserves synchronous call-time uniforms', () => {

	const start = source.indexOf( 'compute( computeNode, ...rest ) {' );
	const end = source.indexOf( 'computeAsync( computeNode, ...rest ) {', start );
	assert.ok( start >= 0 && end > start, 'expected the replay compute entry point' );
	const compute = source.slice( start, end );
	assert.match( compute, /const fullRenderer = __computeRendererBySlim\.get\( this \) \|\| null;/ );
	assert.match( compute, /const result = fullRenderer\.compute\( computeNode, \.\.\.rest \);/ );
	assert.match( compute, /__syncStorageBuffers\( computeNode, fullRenderer, this \);/ );
	assert.match( compute, /return this\.computeAsync\( computeNode, \.\.\.rest \)/ );
	assert.ok(
		compute.indexOf( 'fullRenderer.compute( computeNode, ...rest )' ) < compute.indexOf( 'this.computeAsync( computeNode, ...rest )' ),
		'initialized dispatch must take the synchronous path before async startup fallback',
	);

} );

test( 'capture and replay instrument inline uniform calls with the product identity transform', () => {

	assert.match( source, /import \{ instrumentLiveUniformIdentities \} from '\.\.\/\.\.\/plugin\/src\/babel-transform\.js'/ );
	assert.match( source, /function instrumentInlineLiveUniforms\( html, example \)/ );
	assert.match( source, /instrumentLiveUniformIdentities\( moduleSource, \{ filename, root: sourceRoot \} \)/ );
	assert.match( source, /'@tsl-precompile\/runtime\/slim-support\/live-uniform-registry': '\/__tslp_runtime\/slim-support\/live-uniform-callsite\.js'/ );

} );

test( 'material-owned compute delegates matching and retries to slim-support', () => {

	assert.match( source, /AUTO_COMPUTE_MATERIAL_PROPERTIES as __AUTO_COMPUTE_SLOTS, createAutoComputeDispatcher as __sharedCreateAutoComputeDispatcher/ );
	assert.doesNotMatch( source, /function __wireAutoComputeAttrsToArtifact/ );
	const start = source.indexOf( '// Material-owned compute discovery and artifact wiring live in the runtime.' );
	const end = source.indexOf( '// Lazy full-three.js compute renderer', start );
	assert.ok( start >= 0 && end > start, 'expected the thin material-compute harness adapter' );
	const adapter = source.slice( start, end );
	assert.match( adapter, /fullRenderer: __computeRendererBySlim\.get\( slimRenderer \) \|\| null/ );
	assert.match( adapter, /shouldDispatch: \(\) => slimRenderer\.__tslpPostComputeRendering !== true/ );
	assert.match( adapter, /dispatchOnce: frozen \? __frozenDispatchedAutoComputeNodes : undefined/ );
	assert.match( adapter, /dispatchNode\( node \) \{ return slimRenderer\.compute\( node \); \}/ );
	assert.match( adapter, /\} \)\.catch\(/ );

	const dispatch = source.indexOf( '__dispatchAutoComputeNodes( scene, this );' );
	const passRender = source.indexOf( '__renderPassNodesForPipeline( this,', dispatch );
	const mainRender = source.indexOf( 'const r = super.render( scene, camera );', dispatch );
	assert.ok( dispatch >= 0 && dispatch < passRender && passRender < mainRender, 'material compute must start before pass and main presentation renders' );

} );

test( 'frame-texture diagnostics inspect only existing PassNode targets', () => {

	const start = source.indexOf( 'async function collectFrameTextureSnapshot( page )' );
	const end = source.indexOf( 'function safeExampleName( name', start );
	assert.ok( start >= 0 && end > start, 'expected the frame-texture diagnostic collector' );
	const collector = source.slice( start, end );
	assert.match( collector, /Object\.entries\( passTextures \)/ );
	assert.doesNotMatch( collector, /node\.getTexture\(/, 'diagnostics must not create undeclared MRT attachments' );

} );

test( 'nested offscreen scene renders prepare PMREM before bypassing top-level hooks', () => {

	const start = source.indexOf( 'if ( __renderDepth > 0 ) {' );
	const end = source.indexOf( 'let previousMRT = null;', start );
	assert.ok( start >= 0 && end > start, 'expected the nested replay render shortcut' );
	const nested = source.slice( start, end );
	assert.match( nested, /nestedRenderTarget && scene && scene\.isScene === true/ );
	assert.match( nested, /__prewarmStaticPMREMSourcesForScene\( this, scene \);/ );
	assert.match( nested, /__wireEnvironmentPMREM\( this, scene \);/ );
	assert.ok(
		nested.indexOf( '__wireEnvironmentPMREM( this, scene );' ) < nested.indexOf( 'return super.render( scene, camera );' ),
		'nested scene resources must be wired before the renderer shortcut',
	);

} );

test( 'stock, capture, and replay share logical-frame temporal jitter progression', () => {

	const imports = source.match( /import \{[^}]*synchronizeTemporalJitterNode as __sharedSynchronizeTemporalJitterNode[^}]*\} from '\/__tslp_batch\/temporal-jitter\.mjs';/g ) || [];
	assert.equal( imports.length, 3, 'all three generated WebGPU modules must use the shared jitter clock' );
	assert.match( source, /function __syncStockTRAAJitterIndex/ );
	assert.match( source, /function __syncCaptureTRAAJitterIndex/ );
	assert.match( source, /function __syncTRAAJitterIndex/ );
	assert.doesNotMatch( source, /function __pin(?:Stock|Capture)?TRAAJitterIndex/ );
	assert.match( source, /url\.pathname === '\/__tslp_batch\/temporal-jitter\.mjs'/ );
	assert.match( source, /function __frameEffectFrameId\(\) \{\s*return __sharedTemporalJitterFrameId\( window \);\s*\}/ );

} );
