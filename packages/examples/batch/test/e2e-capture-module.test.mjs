import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCubeCapturePrearmRegistry, isVerifiedCubeRenderTarget } from '../cube-capture-prearm.mjs';

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
	assert.match( marker, /const pendingItem = \{[\s\S]*renderer,[\s\S]*renderTarget/ );
	assert.match( marker, /__pending\.push\( pendingItem \)/ );

	const flushStart = source.indexOf( 'async function __flush(' );
	const flushEnd = source.indexOf( 'function __trackAuxCapture(', flushStart );
	assert.ok( flushStart >= 0 && flushEnd > flushStart, 'expected the generated capture flush' );
	const flush = source.slice( flushStart, flushEnd );
	assert.match( flush, /const itemRenderer = item\.renderer \|\| __renderer;/ );
	assert.match( flush, /precompile\( item\.name,[\s\S]*renderer: itemRenderer/ );

} );

test( 'capture and replay reuse only conservatively proven stock material topology', () => {

	assert.match( source, /createStockMaterialTopologyKey as __createStockMaterialTopologyKey/ );
	const markStart = source.indexOf( 'function __mark( material,' );
	const markEnd = source.indexOf( 'function __findParentScene(', markStart );
	const marker = source.slice( markStart, markEnd );
	assert.match( marker, /__createStockMaterialTopologyKey\( \{[\s\S]*nodeKeys: __MATERIAL_NODE_TEXTURE_KEYS,[\s\S]*textureProps: __MATERIAL_TEXTURE_PROPS/ );
	assert.match( marker, /__getSceneTopologyMap\( __captureTopologyRepresentativesByScene, captureScene, true \)/ );
	assert.match( marker, /if \( topologyRepresentative \)[\s\S]*seenContexts\.set\( contextKey, topologyRepresentative \)[\s\S]*return;/ );
	assert.match( marker, /topologyRepresentatives\.set\( topologyKey, pendingItem \)/ );

	const replayStart = source.indexOf( 'function __replaceMaterialForReplay(' );
	const replayEnd = source.indexOf( 'function __replaceSceneOverrideMaterial(', replayStart );
	const replay = source.slice( replayStart, replayEnd );
	assert.match( replay, /__getSceneTopologyMap\( __replayTopologyArtifactsByScene, sourceScene, true \)/ );
	assert.match( replay, /__takeMaterial\( className, m, object, preferredName \? \{ allowUsed: true, preferredName \} : \{\} \)/ );
	assert.match( replay, /topologyArtifacts\.set\( topologyKey, replacement\.name \)/ );

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
	const captureModuleStart = source.indexOf( 'function fullWebgpuAutoModule()' );
	const captureRendererStart = source.indexOf( 'export class WebGPURenderer extends Original.WebGPURenderer', captureModuleStart );
	const renderGuardStart = source.indexOf( 'render( scene, camera ) {', captureRendererStart );
	const renderGuardEnd = source.indexOf( '\n\t}\n}', renderGuardStart );
	const renderGuard = source.slice( renderGuardStart, renderGuardEnd );
	assert.match( renderGuard, /if \( __pmremRunning === 0 \)[\s\S]*__rememberAuxScene\( scene, camera, this \)/ );
	assert.doesNotMatch( renderGuard.slice( 0, renderGuard.indexOf( 'return super.render' ) ), /__markSceneMaterials|__markStandaloneRenderTargetMaterial/ );

} );

test( 'dynamic cube capture pre-arm is verified, one-shot, and maintenance-safe', () => {

	const ordinaryTexture = { isCubeTexture: true };
	const ordinaryTarget = { isRenderTarget: true, texture: ordinaryTexture };
	const cubeTarget = { isCubeRenderTarget: true, texture: ordinaryTexture };
	assert.equal( isVerifiedCubeRenderTarget( ordinaryTarget ), false, 'a cube texture flag is not target-owned evidence' );
	assert.equal( isVerifiedCubeRenderTarget( cubeTarget ), true );

	const registry = createCubeCapturePrearmRegistry();
	const material = {};
	const firstRenderer = {};
	const secondRenderer = {};
	assert.equal( registry.claim( { material, renderer: firstRenderer, renderTarget: ordinaryTarget } ), false, 'ordinary 2d targets are ignored' );
	assert.equal( registry.claim( { material, renderer: firstRenderer, renderTarget: cubeTarget, captureMaintenance: true } ), false, 'maintenance observations are ignored without consuming ownership' );
	assert.equal( registry.claim( { material, renderer: firstRenderer, renderTarget: cubeTarget } ), true );
	assert.equal( registry.claim( { material, renderer: firstRenderer, renderTarget: cubeTarget } ), false, 'one material/renderer pair pre-arms once' );
	assert.equal( registry.claim( { material, renderer: secondRenderer, renderTarget: cubeTarget } ), true, 'renderer ownership is independent' );

	const lifecycleStart = source.indexOf( 'function __queueCubeCapturePrearm(' );
	const lifecycleEnd = source.indexOf( 'function __findParentScene(', lifecycleStart );
	assert.ok( lifecycleStart >= 0 && lifecycleEnd > lifecycleStart, 'expected the generated cube pre-arm lifecycle' );
	const lifecycle = source.slice( lifecycleStart, lifecycleEnd );
	assert.match( lifecycle, /__cubeCapturePrearmRegistry\.claim\( \{[\s\S]*captureMaintenance: __isCaptureMaintenanceRender\(\)/ );
	assert.match( lifecycle, /material\.precompile\( pendingItem\.name \+ ':cube-prearm',[\s\S]*__tslpObserveNextRender: true/ );
	assert.doesNotMatch( lifecycle, /pendingItem\.done = true/, 'cube pre-arm must not consume the ordinary output capture' );
	assert.doesNotMatch( lifecycle, /queueMicrotask/, 'the verified CubeCamera boundary arms before face zero' );

	const boundaryStart = source.indexOf( 'function patchDynamicCubeCaptureBoundary' );
	const boundaryEnd = source.indexOf( '// QuadMesh.render(renderer)', boundaryStart );
	assert.ok( boundaryStart >= 0 && boundaryEnd > boundaryStart, 'expected the capture-only CubeCamera boundary' );
	const boundary = source.slice( boundaryStart, boundaryEnd );
	assert.match( boundary, /__pmremRunning === 0 && ! __isCaptureMaintenanceRender\(\) && __isVerifiedCubeRenderTarget\( renderTarget \)/ );
	assert.match( boundary, /__markHiddenCubeSceneMaterialsForMainOutput\( scene, camera, renderer \)/ );
	assert.match( boundary, /__markSceneMaterials\( scene, camera, renderer, renderTarget, prearmQueue \)/ );
	assert.match( boundary, /for \( const task of prearmQueue \) __prearmCubeCapture\( task \)/ );
	assert.match( boundary, /const result = originalUpdate\.call[\s\S]*task\.pendingItem\.renderTarget = outputTarget/ );
	assert.ok(
		boundary.indexOf( '__markSceneMaterials(' ) < boundary.indexOf( 'for ( const task of prearmQueue )' ),
		'all visible materials are claimed before the current synchronous burst is armed',
	);

} );

test( 'forced pipeline maintenance renders receive distinct non-advancing identities', () => {

	assert.match( source, /function __maintenanceTemporalFrame\( kind \)/ );
	assert.match( source, /renderId: 'maintenance:' \+ kind \+ ':' \+ frameId \+ ':' \+ \( \+\+ __maintenanceRenderSequence \)/ );
	assert.match( source, /__maintenanceTemporalFrame\( 'loader' \)/ );
	assert.match( source, /__maintenanceTemporalFrame\( 'shadow' \)/ );
	assert.match( source, /__maintenanceTemporalFrame\( 'compute' \)/ );
	assert.match( source, /advance: false,/ );

} );

test( 'scheduled Godrays rendering unlocks its dependent bilateral blur', () => {

	const dependencyStart = source.indexOf( 'function __frameEffectNeedsShadowMap( node ) {' );
	const dependencyEnd = source.indexOf( 'function __deferFrameEffectUntilShadowReady(', dependencyStart );
	assert.ok( dependencyStart >= 0 && dependencyEnd > dependencyStart, 'expected the frame-effect shadow dependency guard' );
	const dependencyGuard = source.slice( dependencyStart, dependencyEnd );
	assert.match( dependencyGuard, /return godraysInput\.__tslpFrameEffectRenderedOnce !== true;/ );

	const renderStart = source.indexOf( 'function __renderFrameEffectNodeWithFullRenderer(' );
	const renderEnd = source.indexOf( 'function __renderFrameEffectNodesForPipeline(', renderStart );
	assert.ok( renderStart >= 0 && renderEnd > renderStart, 'expected the frame-effect renderer' );
	const renderer = source.slice( renderStart, renderEnd );
	assert.match( renderer, /scheduledNodeFrame === null \|\| effectName === 'GodraysNode'/ );
	const successfulRender = renderer.indexOf( 'diag.rendered ++;' );
	const markerGuard = renderer.indexOf( "if ( scheduledNodeFrame === null || effectName === 'GodraysNode' )" );
	const markerWrite = renderer.indexOf( "Object.defineProperty( node, '__tslpFrameEffectRenderedOnce'", markerGuard );
	assert.ok(
		successfulRender >= 0 && markerGuard > successfulRender && markerWrite > markerGuard,
		'Godrays must publish successful scheduled rendering before the dependent blur checks readiness',
	);

} );

test( 'capture module never queues Three renderer-owned shadow overrides as user materials', () => {

	const start = source.indexOf( 'function __markSceneMaterials( scene,' );
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

test( 'dynamic replay artifacts restore generated sidecars before use', () => {

	const auxStart = source.indexOf( 'function auxVirtualModule()' );
	const auxEnd = source.indexOf( 'function fullWebgpuAutoModule()', auxStart );
	assert.ok( auxStart >= 0 && auxEnd > auxStart, 'expected the auxiliary virtual module' );
	const aux = source.slice( auxStart, auxEnd );
	assert.match( aux, /from '@tsl-precompile\/contract\/attribute-generators'/ );
	assert.match( aux, /from '@tsl-precompile\/contract\/variant-selector-adapter'/ );
	assert.ok(
		aux.indexOf( 'materializeArtifactAttributeDescriptors( __entries )' ) < aux.indexOf( 'materializeArtifactVariantSelectorAdapters( __entries )' ),
		'generated attributes must be materialized before selector traversal',
	);
	assert.ok(
		aux.indexOf( 'materializeArtifactVariantSelectorAdapters( __entries )' ) < aux.indexOf( 'registerAuxArtifacts( __entries )' ),
		'auxiliary sidecars must be materialized before registry cloning',
	);

	const replayStart = source.indexOf( 'function slimWebgpuReplayModule()' );
	const replayEnd = source.indexOf( 'function tslStubModule()', replayStart );
	assert.ok( replayStart >= 0 && replayEnd > replayStart, 'expected the slim replay module' );
	const replay = source.slice( replayStart, replayEnd );
	assert.match( replay, /from '\/__tslp_contract\/attribute-generators\.js'/ );
	assert.match( replay, /from '\/__tslp_contract\/variant-selector-adapter\.js'/ );
	const materializeAttributes = replay.indexOf( '__materializeArtifactAttributeDescriptors( __artifactEntries )' );
	const materializeSelectors = replay.indexOf( '__materializeArtifactVariantSelectorAdapters( __artifactEntries )' );
	const register = replay.indexOf( 'Slim.registerAuxArtifacts(' );
	assert.ok(
		materializeAttributes >= 0 && materializeSelectors > materializeAttributes && register > materializeSelectors,
		'user and auxiliary sidecars must be materialized before replay registration or selection',
	);
	const cloneStart = replay.indexOf( 'function __cloneAuxArtifact( artifact )' );
	const cloneEnd = replay.indexOf( 'function __cloneLiveUniformSidecar', cloneStart );
	assert.ok( cloneStart >= 0 && cloneEnd > cloneStart, 'expected the auxiliary artifact clone boundary' );
	assert.match(
		replay.slice( cloneStart, cloneEnd ),
		/__materializeArtifactAttributeDescriptors\( clone \);/,
		'structured clones must restore generated attribute sidecars',
	);
	assert.match(
		replay.slice( cloneStart, cloneEnd ),
		/return __materializeArtifactVariantSelectorAdapters\( clone \);/,
		'structured clones must restore their non-serializable selector adapter',
	);

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

test( 'pass-target variant views retain generated selector adapters', () => {

	const start = source.indexOf( 'function __artifactVariantView( artifact, variant ) {' );
	const end = source.indexOf( 'function __selectArtifactForPassTarget(', start );
	assert.ok( start >= 0 && end > start, 'expected the pass-target artifact view helper' );
	const helper = source.slice( start, end );
	assert.match( helper, /return __materializeArtifactVariantSelectorAdapters\( merged \);/ );
	assert.doesNotMatch( helper, /delete merged\.variants|merged\.variants = undefined/, 'both transparent draw-side variants must remain selectable' );

} );

test( 'Bloom composite binds only effect-owned scalar uniforms', () => {

	const makeStart = source.indexOf( 'function __makeBloomPrecompiledMaterial( shape, sourceMaterial, name, bloomNode = null ) {' );
	const makeEnd = source.indexOf( 'function __wireBloomCompositeUniforms(', makeStart );
	assert.ok( makeStart >= 0 && makeEnd > makeStart, 'expected the Bloom material factory' );
	const factory = source.slice( makeStart, makeEnd );
	assert.match( factory, /if \( shape === 'bloom-composite' \) __wireBloomCompositeUniforms\( artifact, bloomNode \);/ );
	assert.match( factory, /else __wireLiveNodeSidecarsToArtifact\( artifact, sourceMaterial \);/ );

	const helperEnd = source.indexOf( 'function __setLiveUniformSlot(', makeEnd );
	assert.ok( helperEnd > makeEnd, 'expected the owned Bloom uniform helper' );
	const helper = source.slice( makeEnd, helperEnd );
	assert.match( helper, /property === 'radius'[\s\S]*bloomNode\.radius/ );
	assert.match( helper, /property === 'strength'[\s\S]*bloomNode\.strength/ );
	assert.match( helper, /if \( liveNode \) __setLiveUniformSlot\( slot, liveNode \);/ );

} );

test( 'RetroPass scene replacements restore their captured material topology', () => {

	const start = source.indexOf( 'function __makeRetroPassSceneReplacement( material, object ) {' );
	const end = source.indexOf( 'function __withRetroPassSceneReplacements(', start );
	assert.ok( start >= 0 && end > start, 'expected the RetroPass scene replacement helper' );
	const helper = source.slice( start, end );
	assert.match( helper, /replacement\.flatShading = false;/ );
	assert.match( helper, /replacement\.lights = true;/ );
	assert.ok(
		helper.lastIndexOf( '__copyMaterialProps(' ) < helper.indexOf( 'replacement.flatShading = false;' ),
		'RetroPass topology must be restored after ordinary source properties are copied',
	);

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

test( 'positive target clocks advance only with completed author callbacks', () => {

	const wrapStart = source.indexOf( 'w.__tslpWrapAnimationLoop = function ( callback, owner = null ) {' );
	const wrapEnd = source.indexOf( '// Pending counters for async loaders', wrapStart );
	assert.ok( wrapStart >= 0 && wrapEnd > wrapStart, 'expected the animation-loop wrapper' );
	const wrapper = source.slice( wrapStart, wrapEnd );
	assert.match( wrapper, /const completedSteps = w\.__tslpFrameCallbackCount \| 0;/ );
	assert.match( wrapper, /const atTarget = completedSteps >= freezeAt;/ );
	assert.match( wrapper, /if \( ! atTarget \) w\.__tslpRafTick = Math\.min\( freezeAt, nextSteps \);/ );
	assert.match( wrapper, /w\.__tslpFrameCallbackCount = completedSteps;/, 'throwing callbacks roll progress back' );

	const rafStart = source.indexOf( 'w.requestAnimationFrame = function ( cb ) {' );
	const rafEnd = source.indexOf( '// Also patch Date.now()', rafStart );
	assert.ok( rafStart >= 0 && rafEnd > rafStart, 'expected the synthetic requestAnimationFrame wrapper' );
	const raf = source.slice( rafStart, rafEnd );
	assert.match( raf, /const targetProgress = hasAnimationLoop \? \( w\.__tslpFrameCallbackCount \| 0 \) : \( w\.__tslpRafTick \| 0 \);/ );
	assert.match( raf, /if \( ! hasAnimationLoop \) w\.__tslpRafTick = tick;/ );

} );

test( 'multiple renderer loops settle through independent owner claims', () => {

	assert.equal(
		( source.match( /wrap \? wrap\( callback, this \) : callback/g ) || [] ).length,
		3,
		'stock, capture, and replay renderers pass their owner to the shared wrapper',
	);
	const wrapStart = source.indexOf( 'w.__tslpWrapAnimationLoop = function ( callback, owner = null ) {' );
	const wrapEnd = source.indexOf( '// Pending counters for async loaders', wrapStart );
	const wrapper = source.slice( wrapStart, wrapEnd );
	assert.match( wrapper, /ownerReadiness\.register\( owner, callback \)/ );
	assert.match( wrapper, /ownerState\.animationLoopCalls = transition\.animationLoopCalls/ );
	assert.match( wrapper, /ownerState\.successfulCallbacks = \( ownerState\.successfulCallbacks \| 0 \) \+ 1/ );
	assert.ok(
		wrapper.indexOf( 'callback.apply( this, args )' ) < wrapper.indexOf( 'ownerState.successfulCallbacks = ( ownerState.successfulCallbacks | 0 ) + 1' ),
		'only successful author callbacks satisfy an owner readiness claim',
	);

	const rafStart = source.indexOf( 'w.requestAnimationFrame = function ( cb ) {' );
	const rafEnd = source.indexOf( '// Also patch Date.now()', rafStart );
	const raf = source.slice( rafStart, rafEnd );
	assert.match( raf, /ownerReadiness\.ready\( minimumAnimationLoopOwners, settleFrames \)/ );

} );
