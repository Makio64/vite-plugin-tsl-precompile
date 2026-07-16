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

test( 'capture module retains the renderer that discovered each material context', () => {

	const markStart = source.indexOf( 'function __mark( material,' );
	const markEnd = source.indexOf( 'function __findParentScene(', markStart );
	assert.ok( markStart >= 0 && markEnd > markStart, 'expected the generated material marker' );
	const marker = source.slice( markStart, markEnd );
	assert.match( marker, /renderer = null/ );
	assert.match( marker, /__createMaterialContextKey[\s\S]*renderer,[\s\S]*renderTarget: null,[\s\S]*mrt: null/ );
	assert.match( marker, /__pending\.push\( \{[\s\S]*renderer,[\s\S]*renderTarget/ );

	const flushStart = source.indexOf( 'async function __flush(' );
	const flushEnd = source.indexOf( 'function __trackAuxCapture(', flushStart );
	assert.ok( flushStart >= 0 && flushEnd > flushStart, 'expected the generated capture flush' );
	const flush = source.slice( flushStart, flushEnd );
	assert.match( flush, /const itemRenderer = item\.renderer \|\| __renderer;/ );
	assert.match( flush, /precompile\( item\.name,[\s\S]*renderer: itemRenderer/ );

} );

test( 'capture module records renderer output once for every renderer topology', () => {

	assert.match( source, /import \{ precompileAuxiliary, precompileRendererOutput \}/ );
	assert.match( source, /function __rememberAuxScene\( scene, camera, renderer = null \)/ );
	assert.match( source, /entry\.renderers\.set\( renderer, camera \|\| entry\.camera \|\| null \)/ );
	const flushStart = source.indexOf( 'window.__tslpFlushCaptureArtifacts = async function' );
	const flushEnd = source.indexOf( 'export class Scene', flushStart );
	assert.ok( flushStart >= 0 && flushEnd > flushStart, 'expected the generated auxiliary flush' );
	const flush = source.slice( flushStart, flushEnd );
	assert.match( flush, /precompileAuxiliary\( primaryRenderer, scene, primaryCamera/ );
	assert.match( flush, /if \( renderer === primaryRenderer \|\| ! camera \) continue;/ );
	assert.match( flush, /precompileRendererOutput\( renderer, scene, camera/ );

} );

test( 'capture maintenance renders cannot enqueue new harness material contexts', () => {

	assert.match( source, /function __isCaptureMaintenanceRender\(\)/ );
	assert.match( source, /window\.__tslpSyntheticRenderActive \| 0/ );
	assert.match( source, /window\.__tslpPrecompilePending \| 0/ );
	const guards = source.match( /__pmremRunning > 0 \|\| __isCaptureMaintenanceRender\(\)/g ) || [];
	assert.equal( guards.length, 4, 'renderObject, compile, compileAsync, and render all bypass capture marking' );

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

	const start = source.indexOf( 'function __markSceneMaterials( scene, camera = null, renderer = null )' );
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

test( 'compute readback waits for the dispatch chain that preceded it', () => {

	const start = source.indexOf( 'async getArrayBufferAsync( attribute, ...rest ) {' );
	const end = source.indexOf( '\n}\n\nfunction __findPassNodeInGraph', start );
	assert.ok( start >= 0 && end > start, 'expected the replay readback adapter' );
	const readback = source.slice( start, end );
	assert.match( readback, /const pendingCompute = this\.__tslpComputeChain;/ );
	assert.match( readback, /if \( pendingCompute && typeof pendingCompute\.then === 'function' \) await pendingCompute;/ );
	assert.match( readback, /const readbackRenderer = __computeRendererBySlim\.get\( this \) \|\| null;/ );
	assert.match( readback, /readbackRenderer\.getArrayBufferAsync\.call\( readbackRenderer, attribute, \.\.\.rest \)/ );
	assert.ok(
		readback.indexOf( 'await pendingCompute' ) < readback.indexOf( 'readbackRenderer.getArrayBufferAsync.call' ),
		'readback ownership must be resolved after the already-requested compute dispatch',
	);
	assert.ok(
		readback.indexOf( 'readbackRenderer.getArrayBufferAsync.call' ) < readback.indexOf( 'super.getArrayBufferAsync' ),
		'the full renderer that owns delegated compute output must precede the slim fallback',
	);

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

test( 'replay applies captured texture topology before first material assignment', () => {

	const start = source.indexOf( 'function __wireMaterialPropertyTexturesFromArtifact(' );
	const end = source.indexOf( 'function __markMaterialTextureRewire(', start );
	assert.ok( start >= 0 && end > start, 'expected the material texture wiring helper' );
	const wiring = source.slice( start, end );
	const apply = wiring.indexOf( '__applyCapturedTextureState( texture, source );' );
	const assign = wiring.indexOf( 'material[ property ] = texture;' );
	assert.ok( apply >= 0 && apply < assign, 'captured sampler/color-space state must precede first-frame selector construction' );

} );

test( 'replay mirrors author material mutations after the first precompiled swap', () => {

	const start = source.indexOf( 'function __replaceMaterialForReplay(' );
	const end = source.indexOf( 'function __replaceSceneOverrideMaterial(', start );
	assert.ok( start >= 0 && end > start, 'expected the replay material replacement helper' );
	const replacement = source.slice( start, end );
	const precompiledBranch = replacement.slice(
		replacement.indexOf( 'if ( m.isPrecompiledMaterial )' ),
		replacement.indexOf( 'if ( ! force && m.visible === false )' ),
	);
	assert.match( precompiledBranch, /const sourceMaterial = m && m\.__tslpSourceMaterial/ );
	assert.match( precompiledBranch, /__copyMaterialProps\( sourceMaterial, m \)/ );
	assert.match( precompiledBranch, /__copyMaterialNodeProps\( sourceMaterial, m \)/ );
	assert.match( precompiledBranch, /__wireMaterialTextures\( sourceMaterial, m \)/ );
	assert.match( source, /const __SCALAR_PROPS = \[[^\n]*'visible'/, 'visible participates in live scalar synchronization' );

} );

test( 'pass depth replay preserves captured MSAA shape', () => {

	const prepareStart = source.indexOf( 'function __preparePassNodeForReplay(' );
	const prepareEnd = source.indexOf( 'const __wiredPCMaterials', prepareStart );
	assert.ok( prepareStart >= 0 && prepareEnd > prepareStart, 'expected pass replay preparation' );
	const prepare = source.slice( prepareStart, prepareEnd );
	assert.match( prepare, /passNode\.renderTarget\.samples = passNode\.options && passNode\.options\.samples !== undefined/ );
	assert.match( prepare, /: renderer\.samples;/ );

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

test( 'hybrid material compute delegates through scene support before first hydration', () => {

	assert.match( source, /createSlimSceneSupport as __sharedCreateSlimSceneSupport/ );
	assert.match( source, /inspectRuntimeMaterialComputeFamily as __sharedInspectRuntimeMaterialComputeFamily/ );
	const start = source.indexOf( 'function __sceneRequiresMaterialComputeDelegation(' );
	const end = source.indexOf( 'function __dispatchAutoComputeNodes(', start );
	assert.ok( start >= 0 && end > start, 'expected the hybrid material-compute scheduler' );
	const scheduler = source.slice( start, end );
	assert.match( scheduler, /inspection\.descriptor\.mode === 'hybrid-required'/ );
	assert.match( scheduler, /__sharedCreateSlimSceneSupport\( \{[\s\S]*renderer: slimRenderer,[\s\S]*fullRendererFallback: false/ );
	assert.match( scheduler, /\.dispatchMaterialComputes\( request\.scene, \{[\s\S]*fullRenderer/ );
	assert.match( scheduler, /window\.__tslpComputePending = \( window\.__tslpComputePending \| 0 \) \+ 1/ );
	assert.match( scheduler, /__presentDelegatedMaterialCompute\( slimRenderer, request \)/ );
	assert.match( scheduler, /__tslpMaterialComputePresentationRender = true;[\s\S]*slimRenderer\.render\( request\.scene, request\.camera \)/ );
	assert.match( scheduler, /setRenderTarget\( request\.renderTarget, request\.activeCubeFace, request\.activeMipmapLevel \)/ );
	assert.match( scheduler, /if \( state\.pending \)[\s\S]*__sameMaterialComputeRenderRequest/ );

	const defer = source.indexOf( '__deferHybridMaterialComputeRender( scene, camera, this )' );
	const legacy = source.indexOf( '__dispatchAutoComputeNodes( scene, this );', defer );
	const mainRender = source.indexOf( 'const r = super.render( scene, camera );', defer );
	assert.ok( defer >= 0 && defer < legacy && legacy < mainRender, 'hybrid delegation must defer before legacy dispatch and hydration' );
	assert.match( source, /if \( this\.__tslpMaterialComputePresentationRender !== true \) this\.__tslpTopLevelRenderSequence/ );

} );

test( 'material compute nodes never enter the frame-effect setup plane', () => {

	const start = source.indexOf( 'function __isFrameEffectNode( node ) {' );
	const end = source.indexOf( 'function __collectFrameEffectNodesInGraph(', start );
	assert.ok( start >= 0 && end > start, 'expected the frame-effect classifier' );
	const classifier = source.slice( start, end );
	const computeGuard = classifier.indexOf( 'if ( node.isComputeNode === true ) return false;' );
	const setupCapability = classifier.indexOf( "typeof node.setup !== 'function'" );
	assert.ok( computeGuard >= 0, 'compute nodes need an explicit execution-plane guard' );
	assert.ok( computeGuard < setupCapability, 'compute ownership must win over generic setup/updateBefore capability' );

} );

test( 'replay retains graph-discovered storage buffers for hidden sibling consumers', () => {

	const start = source.indexOf( 'function __wireComputeAttrsToArtifact(' );
	const end = source.indexOf( 'function __sourceTypeNeedle(', start );
	assert.ok( start >= 0 && end > start, 'expected the replay compute-attribute binder' );
	const binder = source.slice( start, end );
	const collect = binder.indexOf( "__collectStorageBufAttrs( sourceMaterial[ key ], sbCandidates )" );
	const retain = binder.indexOf( '__rememberComputeStorageAttr( attr, null, renderer )' );
	const fallback = binder.indexOf( '__wireStorageBuffersBySnapshot(' );
	assert.ok( collect >= 0 && retain > collect, 'live graph buffers must be retained after exact discovery' );
	assert.ok( fallback > retain, 'later hidden consumers must see retained buffers before fallback matching' );

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

test( 'video panorama freezes a deterministic decoded frame before settling', () => {

	const start = source.indexOf( "if ( exampleName === 'webgpu_video_panorama.html'" );
	const end = source.indexOf( '// Save the original Date.now', start );
	assert.ok( start >= 0 && end > start, 'expected the video-media determinism hook' );
	const hook = source.slice( start, end );
	assert.match( hook, /w\.__tslpLoaderPending = \( w\.__tslpLoaderPending \| 0 \) \+ 1/ );
	assert.match( hook, /const targetTime = 0\.25;/ );
	assert.match( hook, /media\.addEventListener\( 'seeked', finish, \{ once: true \} \)/ );
	assert.ok( hook.indexOf( 'media.pause();' ) < hook.indexOf( 'media.currentTime = targetTime;' ) );
	assert.match( hook, /w\.__tslpVideoMediaFrozen = true/ );

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
