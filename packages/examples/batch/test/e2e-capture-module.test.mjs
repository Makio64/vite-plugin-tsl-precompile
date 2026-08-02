import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCubeCapturePrearmRegistry, isVerifiedCubeRenderTarget } from '../cube-capture-prearm.mjs';
import { resolveE2EHarnessSourceFiles } from '../e2e-evidence.mjs';
import { createLayeredCapturePrearmRegistry, isVerifiedLayeredRenderTarget } from '../layered-capture-prearm.mjs';

const runnerSource = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );
const replaySource = readFileSync( new URL( '../e2e-slim-replay-module.mjs', import.meta.url ), 'utf8' );
const importMapSource = readFileSync( new URL( '../e2e-browser-import-map.mjs', import.meta.url ), 'utf8' );
const source = `${ runnerSource }\n${ replaySource }\n${ importMapSource }`;
const harnessSourceFiles = resolveE2EHarnessSourceFiles(
	fileURLToPath( new URL( '../../../../', import.meta.url ) ),
);

test( 'capture and replay route upstream addons through compatibility rewrites', () => {

	const start = source.indexOf( 'function rewriteImportmap( html, mode )' );
	const end = source.indexOf( 'function rewriteHarnessVirtualImports(', start );
	assert.ok( start >= 0 && end > start, 'expected the import-map rewrite' );
	const rewrite = source.slice( start, end );
	assert.match( rewrite, /mode === 'capture'\s*\?\s*'\/__tslp_addons\/'/ );
	assert.match( rewrite, /mode === 'replay'\s*\?\s*replayAddonsTarget/ );
	assert.match( rewrite, /out = out\.replace\( \/\("three\\\/addons\\\/"/ );

} );

test( 'capture renderer records its settled backend before publishing the dev renderer', () => {

	const captureStart = source.indexOf( 'function fullWebgpuAutoModule()' );
	const captureEnd = source.indexOf( 'function tslStubModule()', captureStart );
	assert.ok( captureStart >= 0 && captureEnd > captureStart, 'expected the generated artifact-capture module' );
	const capture = source.slice( captureStart, captureEnd );
	const rendererStart = capture.indexOf( 'export class WebGPURenderer extends Original.WebGPURenderer {' );
	const rendererEnd = capture.indexOf( '\n}\n\nwindow.__tslpFullAutoLoaded', rendererStart );
	assert.ok( rendererStart >= 0 && rendererEnd > rendererStart, 'expected the capture renderer class' );
	const renderer = capture.slice( rendererStart, rendererEnd );
	assert.equal( ( renderer.match( /async init\( \.\.\.args \) \{/g ) || [] ).length, 1 );
	assert.match(
		renderer,
		/const result = await super\.init\( \.\.\.args \);\s*this\.__tslpRecordCaptureBackend\(\);\s*__renderer = this;\s*setDevRenderer\( this \);\s*window\.__tslpRendererBound = true;/,
	);

} );

test( 'stock reference installs the same deterministic render guards as artifact capture', () => {

	const stockStart = source.indexOf( 'function stockWebgpuModule()' );
	const stockEnd = source.indexOf( 'function auxVirtualModule()', stockStart );
	assert.ok( stockStart >= 0 && stockEnd > stockStart, 'expected the generated stock module' );
	const stock = source.slice( stockStart, stockEnd );
	assert.match(
		stock,
		/import \{ installR185PMREMNodeGuard \} from '\/__tslp_runtime\/r185-pmrem-node-guard\.js';/,
	);
	assert.match( stock, /installR185PMREMNodeGuard\( Original \);/ );
	assert.match(
		stock,
		/import \{ installRangeAttributeCapture \} from '\/__tslp_runtime\/range-attribute-capture\.js';/,
	);
	assert.match( stock, /installRangeAttributeCapture\( Original \);/ );

	const captureStart = source.indexOf( 'function fullWebgpuAutoModule()' );
	const captureEnd = source.indexOf( 'function tslStubModule()', captureStart );
	assert.ok( captureStart >= 0 && captureEnd > captureStart, 'expected the generated artifact-capture module' );
	const capture = source.slice( captureStart, captureEnd );
	assert.match( capture, /import \{ installPrecompileMarker, setDevRenderer \}/ );
	assert.match( capture, /import \{ installRangeAttributeCapture \}/ );
	assert.match( capture, /installRangeAttributeCapture\( Original \);[\s\S]*installPrecompileMarker\( Original,/ );
	assert.match( capture, /installPrecompileMarker\( Original,/ );

} );

test( 'stock reference uses the runtime-owned compatible precompile marker', () => {

	const stockStart = source.indexOf( 'function stockWebgpuModule()' );
	const stockEnd = source.indexOf( 'function auxVirtualModule()', stockStart );
	assert.ok( stockStart >= 0 && stockEnd > stockStart, 'expected the generated stock module' );
	const stockFactory = source.slice( stockStart, stockEnd );
	const stock = Function(
		`"use strict";\n${ stockFactory }\nreturn stockWebgpuModule;`,
	)()();
	assert.equal( typeof stock, 'string', 'the stock module factory must execute without template-literal leakage' );
	assert.match(
		stock,
		/import \{ installPrecompileMarker as __installStockPrecompileMarker \} from '\/__tslp_runtime\/precompile-marker\.js';/,
	);
	assert.match( stock, /__installStockPrecompileMarker\( Original \);/ );
	assert.doesNotMatch( stock, /prototype\.precompile\s*=/ );
	assert.doesNotMatch( stock, /__installStockPrecompileMarker\( Original,\s*\{/ );

} );

test( 'stock and capture readiness ignore CubeCamera helpers but retain authored nested passes', () => {

	const stockStart = source.indexOf( 'function stockWebgpuModule()' );
	const stockEnd = source.indexOf( 'function auxVirtualModule()', stockStart );
	const stock = source.slice( stockStart, stockEnd );
	assert.match(
		stock,
		/function __isCubeCameraFaceReadinessRender\( camera \) \{[\s\S]*parent\.isCubeCamera === true \|\| parent\.type === 'CubeCamera'/,
	);
	assert.match( stock, /if \( ! __isCubeCameraFaceReadinessRender\( camera \) \) __recordRenderableObjectCount\( scene \);/ );
	assert.doesNotMatch( stock, /__tslpStockRenderDepth|topLevelAuthoredRender/ );

	const captureStart = source.indexOf( 'function fullWebgpuAutoModule()' );
	const captureEnd = source.indexOf( 'function tslStubModule()', captureStart );
	const capture = source.slice( captureStart, captureEnd );
	assert.match(
		capture,
		/function __isCubeCameraFaceReadinessRender\( camera \) \{[\s\S]*parent\.isCubeCamera === true \|\| parent\.type === 'CubeCamera'/,
	);
	assert.match( capture, /if \( ! __isCubeCameraFaceReadinessRender\( camera \) \) __recordRenderableObjectCount\( scene \);/ );
	assert.doesNotMatch( capture, /__tslpCaptureRenderDepth|topLevelAuthoredRender/ );

	const helperStart = stock.indexOf( 'function __isCubeCameraFaceReadinessRender(' );
	const helperEnd = stock.indexOf( '( function patchStockDefaultLoadingManager()', helperStart );
	assert.ok( helperStart >= 0 && helperEnd > helperStart, 'expected the generated CubeCamera readiness helper' );
	const isCubeCameraFaceReadinessRender = Function(
		`"use strict";\n${ stock.slice( helperStart, helperEnd ) }\nreturn __isCubeCameraFaceReadinessRender;`,
	)();
	assert.equal( isCubeCameraFaceReadinessRender( { parent: { isCubeCamera: true } } ), true );
	assert.equal( isCubeCameraFaceReadinessRender( { parent: { type: 'CubeCamera' } } ), true );
	assert.equal( isCubeCameraFaceReadinessRender( { parent: { isCubeCamera: false } } ), false );
	assert.equal( isCubeCameraFaceReadinessRender( { parent: null } ), false );

} );

test( 'framebuffer copy target repair rejects a stale target that cannot contain the copy rectangle', () => {

	const start = source.indexOf( 'function __syncFramebufferTextureForActiveTarget(' );
	const end = source.indexOf( 'function __recordRenderableObjectCount(', start );
	assert.ok( start >= 0 && end > start, 'expected the generated framebuffer target helper' );
	const helper = Function(
		`"use strict";\n${ source.slice( start, end ) }\nreturn __syncFramebufferTextureForActiveTarget;`,
	)();
	const texture = {
		isFramebufferTexture: true,
		image: { width: 16, height: 16 },
		type: 'old-type',
		needsUpdate: false,
	};
	const staleTarget = {
		width: 1,
		height: 1,
		texture: { type: 'rgba16float', image: { width: 1, height: 1 } },
	};
	const renderer = {
		_currentRenderContext: { renderTarget: staleTarget },
		_renderTarget: null,
		getRenderTarget: () => null,
	};
	const rectangle = { x: 312, y: 232, z: 16, w: 16 };

	assert.equal( helper( renderer, texture, rectangle ), null );
	assert.equal( renderer._renderTarget, null, 'the stale 1x1 context target must not replace the live canvas' );
	assert.equal( texture.type, 'old-type', 'a rejected target cannot relabel the framebuffer texture' );

	const liveTarget = {
		width: 640,
		height: 480,
		texture: { type: 'rgba16float', image: { width: 640, height: 480 } },
	};
	renderer._currentRenderContext.renderTarget = liveTarget;
	const restore = helper( renderer, texture, rectangle );
	assert.equal( typeof restore, 'function' );
	assert.equal( renderer._renderTarget, liveTarget );
	assert.equal( texture.type, 'rgba16float' );
	assert.equal( texture.needsUpdate, true );
	restore();
	assert.equal( renderer._renderTarget, null );

} );

test( 'renderable readiness retains the largest observed scene across nested post-process renders', () => {

	const start = source.indexOf( 'function __recordRenderableObjectCount(' );
	const end = source.indexOf( '( function patchStockDefaultLoadingManager()', start );
	assert.ok( start >= 0 && end > start, 'expected the stock renderable-object tracker' );
	const window = {
		__tslpRenderableObjectCount: 0,
		__tslpRenderableLastBusyAt: 0,
		__tslpRealNow: () => 123,
	};
	const record = Function(
		'window',
		`"use strict";\n${ source.slice( start, end ) }\nreturn __recordRenderableObjectCount;`,
	)( window );
	const sceneWithCount = ( count ) => ( {
		traverse( visit ) {

			for ( let index = 0; index < count; index ++ ) visit( {
				visible: true,
				geometry: {},
				material: {},
			} );

		},
	} );

	assert.equal( record( sceneWithCount( 4 ) ), 4 );
	assert.equal( window.__tslpRenderableObjectCount, 4 );
	assert.equal( window.__tslpRenderableLastBusyAt, 123 );
	assert.equal( record( sceneWithCount( 1 ) ), 1, 'the helper still reports the current nested scene size' );
	assert.equal(
		window.__tslpRenderableObjectCount,
		4,
		'a fullscreen helper render cannot erase evidence that the deferred main scene arrived',
	);

} );

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

test( 'capture module leaves registered postprocess subpass materials to auxiliary capture', () => {

	const captureStart = source.indexOf( 'function fullWebgpuAutoModule()' );
	const captureEnd = source.indexOf( 'function tslStubModule()', captureStart );
	assert.ok( captureStart >= 0 && captureEnd > captureStart, 'expected the generated artifact-capture module' );
	const capture = source.slice( captureStart, captureEnd );
	assert.match(
		capture,
		/import \{ collectEffectNodes as __collectRegisteredEffectNodes \} from '\/__tslp_runtime\/slim-support\/postprocess-effects\.js';/,
	);

	const helperStart = source.indexOf( 'function __collectRegisteredPostprocessSubpassMaterials(' );
	const helperEnd = source.indexOf( 'function __rememberAuxScene(', helperStart );
	assert.ok( helperStart >= 0 && helperEnd > helperStart, 'expected the registered postprocess ownership helper' );
	const makeHelpers = Function(
		'__postProcessingPipelines',
		'__collectRegisteredEffectNodes',
		'__postProcessingSubpassMaterials',
		'__nonPostProcessingSubpassMaterials',
		'__classNameForMaterial',
		'__mark',
		`"use strict";\n${ source.slice( helperStart, helperEnd ) }\nreturn { collect: __collectRegisteredPostprocessSubpassMaterials, mark: __markStandaloneRenderTargetMaterial };`,
	);

	const highPassMaterial = {};
	const blurMaterial = {};
	const compositeMaterial = {};
	const finalPipelineMaterial = {};
	const lookalikePipelineMaterial = {};
	const standaloneMaterial = {};
	const bloomNode = {};
	const observedEffectIndexes = [];
	const bloomHandler = {
		name: 'bloom',
		subPasses( node, index ) {
			assert.equal( node, bloomNode );
			observedEffectIndexes.push( index );
			return [
				{ material: highPassMaterial, shape: 'bloom-high-pass' },
				{ material: blurMaterial, shape: 'bloom-blur-3' },
				{ material: compositeMaterial, shape: 'bloom-composite' },
			];
		},
	};
	const finalPipelineQuad = { isQuadMesh: true, name: 'Render Pipeline', material: finalPipelineMaterial };
	const pipelines = new Set( [ { outputNode: {}, _quadMesh: finalPipelineQuad } ] );
	const collectEffectNodes = () => [ { handler: bloomHandler, node: bloomNode } ];
	const marks = [];
	const helpers = makeHelpers(
		pipelines,
		collectEffectNodes,
		new WeakSet(),
		new WeakSet(),
		() => 'NodeMaterial',
		( ...args ) => marks.push( args ),
	);

	const owned = helpers.collect( pipelines, collectEffectNodes, new Set() );
	assert.deepEqual(
		[ highPassMaterial, blurMaterial, compositeMaterial ].map( ( material ) => owned.has( material ) ),
		[ true, true, true ],
		'handler subPasses identities are the ownership evidence',
	);

	helpers.mark( { isQuadMesh: true, name: 'Bloom [ Blur Horizontal - 3 ]', material: blurMaterial }, {} );
	helpers.mark( finalPipelineQuad, {} );
	helpers.mark( { isQuadMesh: true, name: 'Render Pipeline', material: lookalikePipelineMaterial }, {} );
	helpers.mark( { isQuadMesh: true, name: 'Standalone RTT', material: standaloneMaterial }, {} );

	assert.deepEqual(
		marks.map( ( args ) => args[ 0 ] ),
		[ lookalikePipelineMaterial, standaloneMaterial ],
		'only exact registered pipeline-owned identities are excluded from user-material capture',
	);
	assert.ok( observedEffectIndexes.every( ( index ) => index === 0 ), 'effect indexes reset per registered pipeline' );

} );

test( 'capture and replay reuse only conservatively proven stock material topology', () => {

	assert.match( source, /createStockMaterialTopologyKey as __createStockMaterialTopologyKey/ );
	const markStart = source.indexOf( 'function __mark( material,' );
	const markEnd = source.indexOf( 'function __findParentScene(', markStart );
	const marker = source.slice( markStart, markEnd );
	assert.match( marker, /__createStockMaterialTopologyKey\( \{[\s\S]*nodeKeys: __MATERIAL_NODE_TEXTURE_KEYS,[\s\S]*textureProps: __MATERIAL_TEXTURE_PROPS/ );
	assert.match( marker, /__getSceneTopologyMap\( __captureTopologyRepresentativesByScene, captureScene, true \)/ );
	assert.match( marker, /if \( topologyRepresentative \)[\s\S]*seenContexts\.set\( contextKey, topologyRepresentative \)[\s\S]*return topologyRepresentative;/ );
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

test( 'replay caches a shared scene material independently for each renderer topology', () => {

	const keyStart = replaySource.indexOf( 'function __replayMaterialContextKey(' );
	const keyEnd = replaySource.indexOf( 'function __replaySceneForObject(', keyStart );
	const keyHelper = replaySource.slice( keyStart, keyEnd );
	assert.match( keyHelper, /renderer = null/ );
	assert.match( keyHelper, /material,[\s\S]*object,[\s\S]*renderer,/ );

	const replacementStart = replaySource.indexOf( 'function __replaceMaterialForReplay(' );
	const replacementEnd = replaySource.indexOf( 'function __replaceSceneOverrideMaterial(', replacementStart );
	const replacement = replaySource.slice( replacementStart, replacementEnd );
	assert.match( replacement, /__replayMaterialContextKey\( sourceMaterial, object, renderer \)/ );
	assert.match( replacement, /sourceContexts\.get\( sourceContextKey \) \|\| sourceMaterial/ );
	assert.match( replacement, /__replayMaterialContextKey\( m, object, renderer \)/ );

	const prepareStart = replaySource.indexOf( 'function __prepareSceneForReplay(' );
	const prepareEnd = replaySource.indexOf( 'const __autoComputeDispatcherByRenderer', prepareStart );
	const prepare = replaySource.slice( prepareStart, prepareEnd );
	assert.match( prepare, /__replaceSceneOverrideMaterial\( scene, renderer \)/ );
	assert.match( prepare, /__replaceSceneMaterials\( scene, renderer \)/ );

} );

test( 'capture module coalesces a pipeline-owned scene into one auxiliary job', () => {

	const helperStart = source.indexOf( 'function __pipelineCoversAuxScene(' );
	const helperEnd = source.indexOf( 'function __hasRegisteredPipelineAuxCapture(', helperStart );
	assert.ok( helperStart >= 0 && helperEnd > helperStart, 'expected the pipeline auxiliary ownership helper' );
	const pipelineCoversAuxScene = Function(
		`"use strict";\n${ source.slice( helperStart, helperEnd ) }\nreturn __pipelineCoversAuxScene;`,
	)();

	const renderer = {};
	const otherRenderer = {};
	const scene = {};
	const otherScene = {};
	const passNode = { scene };
	const pipeline = { renderer, outputNode: {} };
	const collectPassNodes = () => [ passNode ];

	assert.equal( pipelineCoversAuxScene( pipeline, scene, renderer, null, collectPassNodes ), true );
	assert.equal( pipelineCoversAuxScene( pipeline, otherScene, renderer, null, collectPassNodes ), false );
	assert.equal( pipelineCoversAuxScene( pipeline, scene, otherRenderer, null, collectPassNodes ), false );
	assert.equal(
		pipelineCoversAuxScene( { outputNode: {} }, scene, renderer, renderer, collectPassNodes ),
		true,
		'the active capture renderer is a fallback for legacy pipelines without renderer ownership',
	);
	const primaryMRTScene = {};
	const secondaryScene = {};
	const collectMultiplePassNodes = () => [
		{ scene: secondaryScene },
		{ scene: primaryMRTScene, _mrt: {} },
	];
	assert.equal(
		pipelineCoversAuxScene( pipeline, primaryMRTScene, renderer, null, collectMultiplePassNodes ),
		true,
		'the combined job owns the same MRT-preferred pass selected by the pipeline flush',
	);
	assert.equal(
		pipelineCoversAuxScene( pipeline, secondaryScene, renderer, null, collectMultiplePassNodes ),
		false,
		'secondary scenes in a multi-scene graph retain an independent auxiliary job',
	);

	const flushStart = source.indexOf( 'window.__tslpFlushCaptureArtifacts = async function' );
	const flushEnd = source.indexOf( 'export class Scene', flushStart );
	const flush = source.slice( flushStart, flushEnd );
	assert.match(
		flush,
		/if \( ! __hasRegisteredPipelineAuxCapture\( scene, primaryRenderer \) \) \{\s*__trackAuxCapture\( precompileAuxiliary\( primaryRenderer, scene, primaryCamera/,
	);
	assert.match(
		flush,
		/for \( const \[ renderer, camera \] of rendererEntries \) \{\s*if \( renderer === primaryRenderer \|\| ! camera \) continue;\s*__trackAuxCapture\( precompileRendererOutput/,
		'secondary renderer-output captures remain independent of primary scene coalescing',
	);

} );

test( 'capture flush suppresses live occlusion queries transactionally', () => {

	const helperStart = source.indexOf( 'function __suppressCaptureOcclusionQueries(' );
	const helperEnd = source.indexOf( 'window.__tslpFlushCaptureArtifacts = async function', helperStart );
	assert.ok( helperStart >= 0 && helperEnd > helperStart, 'expected the capture occlusion guard' );
	const suppress = Function(
		`"use strict";\n${ source.slice( helperStart, helperEnd ) }\nreturn __suppressCaptureOcclusionQueries;`,
	)();
	const object = { occlusionTest: true };
	const scene = { traverse( callback ) { callback( object ); } };
	const restore = suppress( [ scene ] );

	assert.equal( object.occlusionTest, false );
	restore();
	assert.equal( object.occlusionTest, true );

	const flushEnd = source.indexOf( 'export class Scene', helperEnd );
	const flush = source.slice( helperEnd, flushEnd );
	assert.match( flush, /const restoreOcclusionQueries = __suppressCaptureOcclusionQueries\( captureScenes \);/ );
	assert.match( flush, /finally \{\s*restoreOcclusionQueries\(\);\s*\}/ );

} );

test( 'raw shadow depth handoff invalidates cached slim bindings through shared support', () => {

	const start = source.indexOf( 'if ( disableReplayShadow ) src.shadow.__tslpDisableReplayShadow = true;' );
	const end = source.indexOf( '// VSM (variance shadow map):', start );
	assert.ok( start >= 0 && end > start, 'expected the raw shadow-depth handoff' );
	const handoff = source.slice( start, end );

	assert.match( handoff, /__shareShadowGpuTextureIntoSlim\( depthTex, fullRenderer, _slimRenderer \);/ );
	assert.doesNotMatch( handoff, /slimData\.texture\s*=\s*fullData\.texture/ );

} );

test( 'postprocess texture walkers follow closure-hidden live dependencies', () => {

	const graphStart = source.indexOf( 'function __collectGraphTexturesByName(' );
	const graphEnd = source.indexOf( 'function __collectFrameEffectTextureAliases(', graphStart );
	assert.ok( graphStart >= 0 && graphEnd > graphStart, 'expected the named graph-texture walker' );
	assert.match(
		source.slice( graphStart, graphEnd ),
		/for \( const dependency of __sharedGetLiveNodeDependencies\( node \) \)/,
	);

	const aliasStart = graphEnd;
	const aliasEnd = source.indexOf( 'function __effectTypeName(', aliasStart );
	assert.ok( aliasEnd > aliasStart, 'expected the frame-effect alias walker' );
	assert.match(
		source.slice( aliasStart, aliasEnd ),
		/for \( const dependency of __sharedGetLiveNodeDependencies\( node \) \)/,
	);

} );

test( 'capture module remembers exact live background targets before renderer state is restored', () => {

	assert.match( source, /rememberBackgroundCaptureRenderTarget as __rememberBackgroundCaptureRenderTarget/ );
	const helperStart = source.indexOf( 'function __rememberBackgroundTargetContext(' );
	const helperEnd = source.indexOf( 'async function __waitForPrecompilePendingAtMost(', helperStart );
	assert.ok( helperStart >= 0 && helperEnd > helperStart, 'expected the generated background target observer' );
	const helper = source.slice( helperStart, helperEnd );
	assert.match( helper, /if \( __isSyntheticCaptureRender\(\) \) return;/ );
	assert.match( helper, /scene\.userData\.__tslpUserScene !== true \|\| scene\.userData\.__tslpSyntheticCaptureScene/ );
	assert.match( helper, /if \( ! scene\.backgroundNode && ! scene\.background \) return;/ );
	assert.match( helper, /renderer\.getRenderTarget\(\)/ );
	assert.match( helper, /renderer\.getMRT\(\)/ );
	assert.match( helper, /__rememberBackgroundCaptureRenderTarget\( scene, renderer, renderTarget, mrtNode \)/ );

	const captureModuleStart = source.indexOf( 'function fullWebgpuAutoModule()' );
	const captureRendererStart = source.indexOf( 'export class WebGPURenderer extends Original.WebGPURenderer', captureModuleStart );
	const renderStart = source.indexOf( 'render( scene, camera ) {', captureRendererStart );
	const renderEnd = source.indexOf( '\n\t}\n}', renderStart );
	const render = source.slice( renderStart, renderEnd );
	const maintenanceReturn = render.indexOf( 'return result;' );
	const targetObservation = render.lastIndexOf( '__rememberBackgroundTargetContext( scene, this );' );
	const ordinaryRender = render.lastIndexOf( 'const result = super.render( scene, camera );' );
	assert.doesNotMatch( render.slice( 0, maintenanceReturn ), /__rememberBackgroundTargetContext/, 'capture-maintenance renders cannot add target variants' );
	assert.ok( targetObservation > maintenanceReturn, 'ordinary renders retain target provenance' );
	assert.ok( targetObservation < ordinaryRender, 'target provenance is sampled before Three restores a pass target' );

} );

test( 'opt-in replay operation diagnostics wrap first-frame renderer and blit boundaries', () => {

	assert.match( source, /process\.env\.TSLP_DEBUG_REPLAY_OPS === '1'/ );
	assert.match( source, /const __debugReplayOperations = \$\{/ );
	assert.match( source, /\[tslp-replay-op\]/ );
	assert.match(
		source,
		/for \( const methodName of \[ 'compute', 'computeAsync', 'render', 'renderObject', 'setRenderTarget' \] \)/,
	);
	assert.match( source, /function __patchReplayBackgroundOperationDiagnostics\( renderer \)/ );
	assert.match( source, /__beginReplayOperation\( 'background\.update', detail \)/ );
	assert.match( source, /function __patchReplayQuadOperationDiagnostics\(\)/ );
	assert.match( source, /__beginReplayOperation\( 'QuadMesh\.render', detail \)/ );
	assert.match( source, /function __patchReplayRenderObjectDirectDiagnostics\( renderer \)/ );
	assert.match( source, /renderer\._renderObjectDirect = function \( \.\.\.args \)/ );
	assert.match( source, /window\.__tslpReplayHydrationPhaseTrace = function \( phase, detail, callback \)/ );
	assert.match( source, /function __withReplayOperation\( kind, detail, callback \)/ );
	assert.match( source, /function __patchReplayRendererInnerDiagnostics\( renderer \)/ );
	assert.match( source, /function __patchReplaySceneRenderDiagnostics\( scene \)/ );
	for ( const phase of [
		'replay.render.prepareSceneForReplay',
		'replay.render.prewarmStaticPMREM',
		'prewarmStaticPMREM.generate',
		'replay.render.wireBackgroundTextures',
		'replay.render.wireEnvironmentPMREM',
		'replay.render.driveRendererLighting',
		'replay.render.deferHybridMaterialCompute',
		'replay.render.dispatchAutoComputeNodes',
		'replay.render.collectScenePassNodes',
		'replay.render.collectSceneRTTNodes',
		'replay.render.collectSceneFrameEffectNodes',
		'replay.render.resetPipelineCaches',
		'replay.render.super',
		'prepareScene.indexLiveTextures',
		'prepareScene.replaceSceneMaterials',
		'r185.renderContexts.get',
		'r185.renderLists.get',
		'r185._projectObject',
		'r185.backend.beginRender',
		'r185.backend.finishRender',
		'r185._renderOutput',
	] ) {

		assert.ok( source.includes( `'${ phase }'` ), `expected renderer phase trace ${ phase }` );

	}
	for ( const step of [
		'_objects.get',
		'_nodes.needsRefresh',
		'_nodes.updateBefore',
		'_geometries.updateForRender',
		'_nodes.updateForRender',
		'_bindings.updateForRender',
		'_pipelines.updateForRender',
		'_pipelines.isReady',
		'backend.createProgram',
		'backend.createRenderPipeline',
		'backend.draw',
	] ) {

		assert.ok( source.includes( `'renderObjectDirect.${ step }'` ), `expected inner trace step ${ step }` );

	}
	for ( const step of [
		'ReplayRenderObject.getMonitor',
		'ReplayNodeManager.getForRender',
		'ReplayNodeManager._createReplaySelection',
		'ReplayNodeManager._createReplayCacheKey',
		'ReplayNodeManager.nodeBuilderCache.get',
		'ReplayNodeManager.nodeBuilderCache.set',
		'ReplayNodeManager.hydrateNodeBuilderState',
	] ) {

		assert.ok( source.includes( `'${ step }'` ), `expected replay selection/hydration trace step ${ step }` );

	}
	assert.match( source, /__patchReplayRenderObjectDirectDiagnostics\( this \);/ );

	const summaries = source.indexOf( 'const auxSummaries = summarizeAuxArtifacts( bucket );' );
	const dump = source.indexOf( "const debugDir = join( OUT, 'debug-pre-replay' );", summaries );
	const replay = source.indexOf( "const replay = await visitExample( browser, name, 'replay'", summaries );
	assert.ok( summaries >= 0 && dump > summaries && replay > dump, 'diagnostic artifacts are persisted before replay can stall' );
	assert.match( source.slice( dump, replay ), /writeArtifactDebugDump/ );
	assert.match( source.slice( dump, replay ), /bytes: userDump\.bytes\.length/ );
	assert.match( source.slice( dump, replay ), /bytes: auxDump\.bytes\.length/ );

} );

test( 'capture operation discovery is sealed only at the deterministic diagnostic boundary', () => {

	const registryStart = source.indexOf( 'function __captureOperationRegistry() {' );
	const registryEnd = source.indexOf( 'function __trackAuxCapture(', registryStart );
	assert.ok( registryStart >= 0 && registryEnd > registryStart, 'expected capture operation registry lifecycle' );
	const registry = source.slice( registryStart, registryEnd );
	assert.match( registry, /complete: false/ );
	assert.match( registry, /if \( registry\.complete === true \) registry\.complete = false;/ );
	assert.match( registry, /function __sealCaptureOperationRegistry\(\)/ );
	assert.match( registry, /window\.__tslpSealCaptureOperationRegistry = __sealCaptureOperationRegistry;/ );
	assert.doesNotMatch( registry, /complete: true,\s*expected: \[\]/ );

} );

test( 'repeated auxiliary captures aggregate into one operation outcome', () => {

	const trackerStart = source.indexOf( 'function __trackAuxCapture(' );
	const trackerEnd = source.indexOf( 'function __auxOpts(', trackerStart );
	assert.ok( trackerStart >= 0 && trackerEnd > trackerStart, 'expected the auxiliary capture tracker' );
	const tracker = source.slice( trackerStart, trackerEnd );
	assert.match(
		tracker,
		/outcomes\.find\( \( entry \) => entry[\s\S]*entry\.phase === 'capture'[\s\S]*entry\.component === 'auxiliary-capture'[\s\S]*entry\.operation === label/,
	);
	assert.match( tracker, /if \( ! outcome \) \{[\s\S]*outcomes\.push\( outcome \);/ );
	assert.match( tracker, /outcome\.attempted \+= attempted;/ );
	assert.match( tracker, /outcome\.succeeded \+= succeeded;/ );
	assert.match( tracker, /outcome\.failed \+= failed;/ );

} );

test( 'synthetic capture renders stay isolated while pending user renders remain discoverable', () => {

	assert.match( source, /function __isCaptureMaintenanceRender\(\)/ );
	assert.match( source, /function __isSyntheticCaptureRender\(\)/ );
	assert.match( source, /return \( window\.__tslpSyntheticRenderActive \| 0 \) > 0/ );
	assert.match(
		source,
		/return __isSyntheticCaptureRender\(\)[\s\S]*window\.__tslpPrecompilePending \| 0/,
		'the broader maintenance policy still protects one-shot prearm boundaries',
	);
	const guards = source.match( /__pmremRunning > 0 \|\| __isSyntheticCaptureRender\(\)/g ) || [];
	assert.equal( guards.length, 4, 'renderObject, compile, compileAsync, and render suppress only PMREM/synthetic extraction' );
	const captureModuleStart = source.indexOf( 'function fullWebgpuAutoModule()' );
	const captureRendererStart = source.indexOf( 'export class WebGPURenderer extends Original.WebGPURenderer', captureModuleStart );
	const renderGuardStart = source.indexOf( 'render( scene, camera ) {', captureRendererStart );
	const renderGuardEnd = source.indexOf( '\n\t}\n}', renderGuardStart );
	const renderGuard = source.slice( renderGuardStart, renderGuardEnd );
	assert.match( renderGuard, /const rememberAuxScene = __pmremRunning === 0;[\s\S]*if \( rememberAuxScene \)[\s\S]*__rememberAuxScene\( scene, camera, this \)/ );
	const maintenanceReturn = renderGuard.indexOf( 'return result;' );
	assert.ok( maintenanceReturn > 0, 'expected the maintenance render return' );
	assert.doesNotMatch( renderGuard.slice( 0, maintenanceReturn ), /__markSceneMaterials|__markStandaloneRenderTargetMaterial/ );
	assert.match(
		renderGuard.slice( maintenanceReturn ),
		/__markSceneMaterials\( scene, camera, this \)[\s\S]*__markStandaloneRenderTargetMaterial\( scene, this \)/,
		'a genuine user-scene render can discover later helper materials while another capture is pending',
	);

} );

test( 'capture module publishes auxiliary camera ownership after nested renders complete', () => {

	const captureModuleStart = source.indexOf( 'function fullWebgpuAutoModule()' );
	const captureRendererStart = source.indexOf( 'export class WebGPURenderer extends Original.WebGPURenderer', captureModuleStart );
	const renderStart = source.indexOf( 'render( scene, camera ) {', captureRendererStart );
	const renderEnd = source.indexOf( '\n\t}\n}', renderStart );
	assert.ok( renderStart >= 0 && renderEnd > renderStart, 'expected the generated capture renderer' );
	const render = source.slice( renderStart, renderEnd );
	const positions = ( pattern ) => [ ...render.matchAll( pattern ) ].map( ( match ) => match.index );
	const calls = positions( /const result = super\.render\( scene, camera \);/g );
	const scenes = positions( /__lastScene = scene;/g );
	const cameras = positions( /__lastCamera = camera;/g );
	const remembers = positions( /__rememberAuxScene\( scene, camera, this \);/g );
	const returns = positions( /return result;/g );

	assert.equal( calls.length, 2, 'maintenance and ordinary renders both retain the super result' );
	assert.equal( scenes.length, 2 );
	assert.equal( cameras.length, 2 );
	assert.equal( remembers.length, 2 );
	assert.equal( returns.length, 2 );
	for ( let i = 0; i < calls.length; i ++ ) {

		assert.ok( calls[ i ] < scenes[ i ], 'the completed render publishes its scene' );
		assert.ok( scenes[ i ] < cameras[ i ], 'scene and camera ownership publish together' );
		assert.ok( cameras[ i ] < remembers[ i ], 'the aux registry receives the completed camera' );
		assert.ok( remembers[ i ] < returns[ i ], 'ownership publishes before returning to the caller' );

	}
	const materialMark = render.lastIndexOf( '__markSceneMaterials( scene, camera, this );' );
	const mrtStamp = render.lastIndexOf( '__stampSceneMRT( scene, this );' );
	assert.ok( materialMark >= 0 && materialMark < calls[ 1 ], 'ordinary material marking remains before rendering' );
	assert.ok( mrtStamp >= 0 && mrtStamp < calls[ 1 ], 'ordinary MRT stamping remains before rendering' );

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
	const lifecycleEnd = source.indexOf( 'function __prearmLayeredCapture(', lifecycleStart );
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

test( 'layered QuadMesh capture keeps one queue identity across synchronous array and 3D renders', () => {

	const arrayTarget = {
		isRenderTarget: true,
		depth: 109,
		texture: { isArrayTexture: true },
	};
	const target3D = {
		isRenderTarget: true,
		isRenderTarget3D: true,
		depth: 109,
		texture: { isData3DTexture: true },
	};
	assert.equal( isVerifiedLayeredRenderTarget( arrayTarget ), true );
	assert.equal( isVerifiedLayeredRenderTarget( target3D ), true );
	assert.equal( isVerifiedLayeredRenderTarget( {
		depth: 109,
		texture: { isArrayTexture: true },
	} ), false, 'texture flags without target ownership are rejected' );

	const registry = createLayeredCapturePrearmRegistry();
	const material = {};
	const renderer = {};
	assert.equal( registry.claim( { material, renderer, renderTarget: arrayTarget, captureMaintenance: true } ), false );
	assert.equal( registry.claim( { material, renderer, renderTarget: arrayTarget } ), true );
	assert.equal( registry.claim( { material, renderer, renderTarget: target3D } ), false, 'one synchronous family is armed once' );

	const lifecycleStart = source.indexOf( 'function __prearmLayeredCapture(' );
	const lifecycleEnd = source.indexOf( 'function __mark(', lifecycleStart );
	assert.ok( lifecycleStart >= 0 && lifecycleEnd > lifecycleStart, 'expected the layered pre-arm lifecycle' );
	const lifecycle = source.slice( lifecycleStart, lifecycleEnd );
	assert.match( lifecycle, /__layeredCapturePrearmRegistry\.claim\( \{[\s\S]*captureMaintenance: __isCaptureMaintenanceRender\(\)/ );
	assert.match( lifecycle, /material\.precompile\( pendingItem\.name, \{[\s\S]*__tslpObserveNextRender: true/ );
	assert.doesNotMatch( lifecycle, /pendingItem\.name \+/, 'array and 3D siblings retain the ordinary pending name' );
	const precompile = lifecycle.indexOf( 'material.precompile(' );
	const consume = lifecycle.indexOf( 'pendingItem.done = true;' );
	const failure = lifecycle.indexOf( '} catch ( err ) {' );
	assert.ok( precompile >= 0 && consume > precompile && failure > consume, 'only a successful precompile consumes the fallback item' );
	assert.doesNotMatch( lifecycle.slice( failure ), /pendingItem\.done = true/ );

	const markerStart = source.indexOf( 'function __mark( material,' );
	const markerEnd = source.indexOf( 'function __findParentScene(', markerStart );
	const marker = source.slice( markerStart, markerEnd );
	assert.match( marker, /return existingItem;/ );
	assert.match( marker, /return topologyRepresentative;/ );
	assert.match( marker, /return pendingItem;/ );

	const boundaryStart = source.indexOf( 'function patchLayeredQuadCaptureBoundary' );
	const boundaryEnd = source.indexOf( 'function __collectRegisteredPostprocessSubpassMaterials', boundaryStart );
	assert.ok( boundaryStart >= 0 && boundaryEnd > boundaryStart, 'expected the capture-only QuadMesh boundary' );
	const boundary = source.slice( boundaryStart, boundaryEnd );
	assert.match( boundary, /__isVerifiedLayeredRenderTarget\( renderTarget \)/ );
	assert.match( boundary, /const pendingItem = __mark\(/ );
	assert.match( boundary, /__prearmLayeredCapture\(/ );
	assert.match( boundary, /return originalRender\.call\( this, renderer, \.\.\.args \);/ );
	assert.ok(
		boundary.indexOf( '__prearmLayeredCapture(' ) < boundary.indexOf( 'originalRender.call(' ),
		'the harvest opens before the first layered draw',
	);
	assert.doesNotMatch( boundary, /queueMicrotask|Promise\.resolve/, 'the r185 sibling burst remains synchronous' );

	assert.ok(
		harnessSourceFiles.includes( fileURLToPath( new URL( '../layered-capture-prearm.mjs', import.meta.url ) ) ),
		'the recursive evidence fingerprint must bind the layered capture helper',
	);
	assert.match( source, /url\.pathname === '\/__tslp_batch\/layered-capture-prearm\.mjs'/ );

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

test( 'capture claims detached direct NodeMaterial draws with their authored scene', () => {

	const captureModuleStart = source.indexOf( 'function fullWebgpuAutoModule()' );
	const rendererStart = source.indexOf( 'export class WebGPURenderer extends Original.WebGPURenderer', captureModuleStart );
	const renderObjectStart = source.indexOf( 'renderObject( object, scene, camera, geometry, material', rendererStart );
	const renderObjectEnd = source.indexOf( '\n\tasync init(', renderObjectStart );
	assert.ok( renderObjectStart >= 0 && renderObjectEnd > renderObjectStart, 'expected the capture renderObject boundary' );
	const renderObject = source.slice( renderObjectStart, renderObjectEnd );
	assert.match( renderObject, /const objectSceneRelation = ! object/ );
	assert.match( renderObject, /objectScene === scene[\s\S]*?'same'/ );
	assert.match( renderObject, /objectScene === null[\s\S]*?'detached'[\s\S]*?'other'/ );
	assert.match( renderObject, /__classifyDirectNodeMaterialCapture\( \{/ );
	assert.match( renderObject, /syntheticScene: isSyntheticScene/ );
	assert.match( renderObject, /offscreenRenderPass: isOffscreenRenderPass/ );
	assert.match( renderObject, /directNodeMaterialPolicy\.claim \|\| isRetroPassMaterial/ );
	assert.match( renderObject, /directNodeMaterialPolicy\.sceneHint \? scene : null/ );
	assert.doesNotMatch( renderObject, /Lensflare-\(\?:1a\|1b\|2\)/, 'capture must not depend on addon labels hidden by NodeMaterial.type' );

} );

test( 'detached direct materials key capture context by the authored scene', () => {

	const start = source.indexOf( 'function __mark( material, className,' );
	const end = source.indexOf( 'function __findParentScene(', start );
	assert.ok( start >= 0 && end > start, 'expected the generated material marker' );
	const marker = source.slice( start, end );
	assert.match( marker, /directSceneContext = null/ );
	assert.match( marker, /const authoredScene = directSceneContext \|\| sourceScene/ );
	assert.match( marker, /const captureScene = directSceneContext \|\| sourceScene/ );
	assert.match( marker, /baseContextKey \+ ':direct-scene:' \+ __captureTopologyIdentity\( directSceneContext \)/ );

} );

test( 'capture marking ignores objects outside the active camera layers before recording target topology', () => {

	const start = source.indexOf( 'function __mark( material, className,' );
	const end = source.indexOf( 'function __findParentScene(', start );
	assert.ok( start >= 0 && end > start, 'expected the generated material marker' );
	const marker = source.slice( start, end );
	const layerGuard = marker.indexOf( '! __cameraSeesObject( camera, sourceObject )' );
	const targetCapture = marker.indexOf( 'let renderTarget = renderTargetOverride;' );
	assert.ok( layerGuard >= 0, 'expected the camera-layer visibility guard' );
	assert.ok( targetCapture > layerGuard, 'hidden objects must be rejected before the active render target is captured' );

} );

test( 'RetroPass detection cannot claim object materials during a scene override pass', () => {

	const start = source.indexOf( 'function __isRetroPassGeneratedMaterial( renderer, scene, material, className ) {' );
	const end = source.indexOf( 'function __markSceneMaterials( scene,', start );
	assert.ok( start >= 0 && end > start, 'expected the capture RetroPass material detector' );
	const detector = source.slice( start, end );
	assert.match( detector, /&& ! scene\.overrideMaterial/ );

} );

test( 'full offscreen fallback preserves live node override materials', () => {

	const start = source.indexOf( 'function __withSourceMaterialsForFullPass(' );
	const end = source.indexOf( 'function __sharePassRenderTargetFromFullRenderer(', start );
	assert.ok( start >= 0 && end > start, 'expected the full-pass source-material wrapper' );
	const wrapper = source.slice( start, end );

	assert.match( wrapper, /const sourceOverrideMaterial = scene\.overrideMaterial\.__tslpSourceMaterial;/ );
	assert.match( wrapper, /sourceOverrideMaterial\.isNodeMaterial === true[\s\S]*\? sourceOverrideMaterial[\s\S]*: materialForSource\( sourceOverrideMaterial \)/ );
	assert.match( wrapper, /return materialForSource\( mat\.__tslpSourceMaterial \);/, 'ordinary array object materials still use the full-pass mapper' );
	assert.match( wrapper, /object\.material = materialForSource\( material\.__tslpSourceMaterial \);/, 'ordinary scalar object materials still use the full-pass mapper' );

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
	const end = source.indexOf( '\n\t}\n}\n', start );
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
	assert.match(
		compute,
		/const result = __sharedInvokeAlignedFullCompute\( this, fullRenderer, \(\) => fullRenderer\.compute\( computeNode, \.\.\.rest \) \);/,
	);
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

	const replayStart = source.indexOf( 'export function slimWebgpuReplayModule(' );
	const replayEnd = source.length;
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

	const dispatch = source.indexOf( "'replay.render.dispatchAutoComputeNodes'" );
	const passRender = source.indexOf( "'replay.render.renderScenePassNodes'", dispatch );
	const mainRender = source.indexOf( "'replay.render.super'", dispatch );
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
	assert.match( scheduler, /__tslpMaterialComputePresentationRender = false;[\s\S]*if \( presented \) __markSuccessfulReplayPresentation\( slimRenderer \)/ );
	assert.match( scheduler, /setRenderTarget\( request\.renderTarget, request\.activeCubeFace, request\.activeMipmapLevel \)/ );
	assert.match( scheduler, /if \( state\.pending \)[\s\S]*__sameMaterialComputeRenderRequest/ );

	const defer = source.indexOf( "'replay.render.deferHybridMaterialCompute'" );
	const legacy = source.indexOf( "'replay.render.dispatchAutoComputeNodes'", defer );
	const mainRender = source.indexOf( "'replay.render.super'", defer );
	assert.ok( defer >= 0 && defer < legacy && legacy < mainRender, 'hybrid delegation must defer before legacy dispatch and hydration' );
	assert.match( source, /if \( this\.__tslpMaterialComputePresentationRender !== true \) this\.__tslpTopLevelRenderSequence/ );
	assert.match(
		source,
		/const __materialComputePresentation = this\.__tslpMaterialComputePresentationRender === true;[\s\S]*if \( ! __materialComputePresentation \) \{[\s\S]*replay\.render\.prepareSceneForReplay/,
		'the post-dispatch draw must preserve the exact material identity that owns the delegation lease',
	);

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
	const collect = binder.indexOf( "__collectStorageBufAttrs( sourceMaterial[ key ], sbCandidateList )" );
	const dedupe = binder.indexOf( 'const sbCandidates = [ ...new Set( sbCandidateList ) ];' );
	const retain = binder.indexOf( '__rememberComputeStorageAttr( attr, null, renderer )' );
	const fallback = binder.indexOf( '__wireStorageBuffersBySnapshot(' );
	assert.ok( collect >= 0 && dedupe > collect, 'graph discovery must dedupe shared live attributes by identity' );
	assert.ok( retain > dedupe, 'live graph buffers must be retained after exact discovery' );
	assert.ok( fallback > retain, 'later hidden consumers must see retained buffers before fallback matching' );

} );

test( 'replay defers signed anonymous storage entries to the shared identity ranker', () => {

	assert.match(
		source,
		/hasAnonymousStorageResourceIdentity as __sharedHasAnonymousStorageResourceIdentity/,
		'the generated replay module imports the runtime signature-presence guard',
	);

	const snapshotStart = source.indexOf( 'function __wireStorageBuffersBySnapshot(' );
	const binderStart = source.indexOf( 'function __wireComputeAttrsToArtifact(', snapshotStart );
	const binderEnd = source.indexOf( 'function __sourceTypeNeedle(', binderStart );
	assert.ok( snapshotStart >= 0 && binderStart > snapshotStart && binderEnd > binderStart, 'expected both replay storage prewires' );
	const snapshotWire = source.slice( snapshotStart, binderStart );
	const binder = source.slice( binderStart, binderEnd );
	assert.match(
		snapshotWire,
		/__sharedHasAnonymousStorageResourceIdentity\( entry \)[\s\S]*!\s*entry\._liveArray/,
		'snapshot matching must leave attempted signed families untouched',
	);

	const signedGuards = [ ...binder.matchAll( /if \( __sharedHasAnonymousStorageResourceIdentity\( sb \) \) continue;/g ) ]
		.map( ( match ) => match.index );
	const greedyMatches = [ ...binder.matchAll( /const match = sbCandidates\.find/g ) ]
		.map( ( match ) => match.index );
	assert.equal( signedGuards.length, 2, 'both flat and ordered-binding greedy paths need a signed-family guard' );
	assert.equal( greedyMatches.length, 2, 'expected both legacy shape prewires' );
	assert.ok( signedGuards[ 0 ] < greedyMatches[ 0 ], 'flat storageBuffers must validate before shape matching' );
	assert.ok( signedGuards[ 1 ] < greedyMatches[ 1 ], 'orderedBindings must validate before shape matching' );

	const sharedRanker = binder.indexOf( '__sharedWireArtifactStorageBuffersFromAttributes(' );
	assert.ok( sharedRanker > greedyMatches[ 1 ], 'the shared identity ranker remains authoritative after legacy prewires' );

} );

test( 'frame-texture diagnostics inspect only existing PassNode targets', () => {

	const start = source.indexOf( 'async function collectFrameTextureSnapshot( page )' );
	const end = source.indexOf( 'function safeExampleName( name', start );
	assert.ok( start >= 0 && end > start, 'expected the frame-texture diagnostic collector' );
	const collector = source.slice( start, end );
	assert.match( collector, /Object\.entries\( passTextures \)/ );
	assert.doesNotMatch( collector, /node\.getTexture\(/, 'diagnostics must not create undeclared MRT attachments' );

} );

test( 'replay PassNode preserves r185 depthless target semantics', () => {

	const start = source.indexOf( 'export class PassNode extends Slim.PassNode' );
	const end = source.indexOf( 'const __counts = Object.create( null );', start );
	assert.ok( start >= 0 && end > start, 'expected the replay PassNode wrapper' );
	const passNode = source.slice( start, end );
	assert.match(
		passNode,
		/if \( this\.scope === PassNode\.DEPTH \|\| this\.options\.depthBuffer !== false \) \{[\s\S]*depthTexture = __makePassDepthTexture\( renderTarget \);[\s\S]*renderTarget\.depthTexture = depthTexture;/,
		'depth texture creation must match the r185 scope/depthBuffer condition',
	);
	assert.match(
		passNode,
		/if \( depthTexture !== null \) this\._textures\.depth = depthTexture;/,
		'depthless passes must not advertise a depth texture',
	);
	assert.match(
		passNode,
		/if \( name === 'depth' \) throw new Error\( 'THREE\.PassNode: Depth texture is not available for this pass\.' \);/,
		'requesting depth from a depthless pass must fail like r185',
	);

} );

test( 'replay PassNode preserves r185 lazy MRT attachment ordering', () => {

	const start = source.indexOf( 'export class PassNode extends Slim.PassNode' );
	const end = source.indexOf( 'const __counts = Object.create( null );', start );
	assert.ok( start >= 0 && end > start, 'expected the replay PassNode wrapper' );
	const passNode = source.slice( start, end );
	assert.match( passNode, /setMRT\( mrt \) \{ this\._mrt = mrt; return this; \}/ );
	assert.doesNotMatch( passNode, /setMRT\( mrt \)[^{]*\{[^}]*__syncPassRenderTargetTextures/ );
	assert.match(
		passNode,
		/this\.renderTarget\.textures\.push\( texture \)/,
		'getTexture() must append each attachment at first access, as r185 does',
	);
	const syncStart = source.indexOf( 'function __syncPassRenderTargetTextures(' );
	const syncEnd = source.indexOf( 'function __sceneCanRenderMRT(', syncStart );
	const sync = source.slice( syncStart, syncEnd );
	assert.match( sync, /passNode\._textures\[ name \]/ );
	assert.match( sync, /passNode\.getTexture\( name \)/ );
	assert.doesNotMatch( sync, /target\.textures = textures/, 'preparation must not reorder existing lazy attachments' );

} );

test( 'replay PassNode preserves requested MRT while selecting its render path', () => {

	const selectStart = replaySource.indexOf( 'function __selectPassMRTRenderPath(' );
	const selectEnd = replaySource.indexOf( 'function __prepareSceneMaterialsForMRTReplay(', selectStart );
	assert.ok( selectStart >= 0 && selectEnd > selectStart, 'expected the replay PassNode MRT route selector' );
	const makeSelector = Function(
		'__sceneCanRenderMRT',
		`"use strict";\n${ replaySource.slice( selectStart, selectEnd ) }\nreturn __selectPassMRTRenderPath;`,
	);
	const requestedMRT = { outputNodes: { output: {}, normal: {}, metalrough: {} } };
	const scene = {};
	const passNode = {};

	const fullSelector = makeSelector( ( selectedScene, selectedMRT, selectedPassNode ) => {
		assert.equal( selectedScene, scene );
		assert.equal( selectedMRT, requestedMRT );
		assert.equal( selectedPassNode, passNode );
		return false;
	} );
	assert.deepEqual( fullSelector( scene, requestedMRT, passNode ), {
		replayMRT: requestedMRT,
		canRenderPrecompiledMRT: false,
		needsFullMRTPass: true,
	} );

	const slimSelector = makeSelector( () => true );
	assert.deepEqual( slimSelector( scene, requestedMRT, passNode ), {
		replayMRT: requestedMRT,
		canRenderPrecompiledMRT: true,
		needsFullMRTPass: false,
	} );

	let colorSceneChecked = false;
	const colorSelector = makeSelector( () => {
		colorSceneChecked = true;
		return true;
	} );
	assert.deepEqual( colorSelector( scene, null, passNode ), {
		replayMRT: null,
		canRenderPrecompiledMRT: false,
		needsFullMRTPass: false,
	} );
	assert.equal( colorSceneChecked, false, 'color-only replay does not perform an MRT coverage check' );

	const passStart = replaySource.indexOf( 'export class PassNode extends Slim.PassNode' );
	const passEnd = replaySource.indexOf( 'const __counts = Object.create( null );', passStart );
	const updateStart = replaySource.indexOf( 'updateBefore( frame = {} ) {', passStart );
	const updateEnd = replaySource.indexOf( '\n\t\tdispose()', updateStart );
	assert.ok( passStart >= 0 && passEnd > passStart && updateStart >= 0 && updateEnd > updateStart );
	const update = replaySource.slice( updateStart, updateEnd );
	assert.match( update, /const requestedMRT = this\._mrt \|\| null;/ );
	assert.match( update, /__selectPassMRTRenderPath\( scene, requestedMRT, this \)/ );
	assert.doesNotMatch( update, /replayMRT\s*=\s*null/, 'missing slim coverage must not erase the requested MRT topology' );
	assert.match(
		update,
		/\( needsFullMRTPass \|\| needsFullStandalonePass \) && __renderPassNodeWithFullRenderer\(/,
		'incomplete MRT coverage must select the full-renderer pass',
	);

} );

test( 'replay PassNode binds its render target before MRT like r185', () => {

	const start = source.indexOf( 'export class PassNode extends Slim.PassNode' );
	const end = source.indexOf( 'const __counts = Object.create( null );', start );
	assert.ok( start >= 0 && end > start, 'expected the replay PassNode wrapper' );
	const passNode = source.slice( start, end );
	const updateStart = passNode.indexOf( 'updateBefore( frame = {} ) {' );
	const updateEnd = passNode.indexOf( '\n\t\tdispose()', updateStart );
	assert.ok( updateStart >= 0 && updateEnd > updateStart, 'expected the replay PassNode updateBefore implementation' );
	const update = passNode.slice( updateStart, updateEnd );
	const replayBindings = update.match(
		/renderer\.setRenderTarget\( this\.renderTarget \);\n\s*if \( typeof renderer\.setMRT === 'function' \) renderer\.setMRT\( replayMRT \);/g,
	) || [];
	const colorOnlyBindings = update.match(
		/renderer\.setRenderTarget\( this\.renderTarget \);\n\s*if \( typeof renderer\.setMRT === 'function' \) renderer\.setMRT\( null \);/g,
	) || [];
	assert.equal( replayBindings.length, 3, 'every replay MRT bind must follow its render-target bind' );
	assert.equal( colorOnlyBindings.length, 1, 'the color-only background bind must follow its render-target bind' );
	assert.doesNotMatch(
		update,
		/renderer\.setMRT\([^;]*\);\n\s*renderer\.setRenderTarget\( this\.renderTarget \);/,
		'setRenderTarget() clears target-local MRT state in r185',
	);
	assert.match(
		update,
		/renderer\.setRenderTarget\( currentRenderTarget \);\n\s*if \( typeof renderer\.setMRT === 'function' \) renderer\.setMRT\( currentMRT \);/,
		'restore order must also match r185',
	);

} );

test( 'frame-effect replay dispatches dependencies through an isolated NodeFrame', () => {

	const createStart = source.indexOf( 'function __createFrameEffectNodeFrame(' );
	const renderStart = source.indexOf( 'function __renderFrameEffectNodeWithFullRenderer(', createStart );
	assert.ok( createStart >= 0 && renderStart > createStart, 'expected aligned frame-effect helpers' );
	const helpers = source.slice( createStart, renderStart );
	assert.match( helpers, /__sharedCreateIsolatedFrameEffectNodeFrame/ );
	assert.match( helpers, /scheduledNodeFrame \? scheduledNodeFrame\.frameId : fallbackFrameId/ );
	assert.match( helpers, /dependency\.__tslpFrameEffectOriginalUpdateBefore \|\| dependency\.updateBefore/ );
	assert.match( helpers, /return frame\.updateBeforeNode\( node \)/ );
	assert.doesNotMatch( helpers, /slimRenderer\._nodes|replayNodeFrame/ );

	const renderEnd = source.indexOf( 'function __renderFrameEffectNodesForPipeline(', renderStart );
	const render = source.slice( renderStart, renderEnd );
	assert.match( render, /__createFrameEffectNodeFrame\( effectRenderer, context, scheduledNodeFrame \)/ );
	assert.match( render, /__invokeFrameEffectUpdateBefore\( node, effectFrame \)/ );

} );

test( 'replay operation diagnostics expose pipeline temporal ownership without changing it', () => {

	const start = source.indexOf( 'export class RenderPipeline extends Slim.RenderPipeline {' );
	const end = source.indexOf( 'export class PostProcessing extends RenderPipeline {}', start );
	assert.ok( start >= 0 && end > start, 'expected the replay RenderPipeline wrapper' );
	const pipeline = source.slice( start, end );
	assert.match( pipeline, /diag\.pipelineFrameIdentities/ );
	assert.match( pipeline, /observedFrameId: __frameEffectFrameId\(\)/ );
	assert.match( pipeline, /inheritedFrameId: inherited && inherited\.frameId/ );
	assert.match( pipeline, /callbackCount: window\.__tslpFrameCallbackCount \| 0/ );
	assert.match( pipeline, /renderableObjectCount: window\.__tslpRenderableObjectCount \| 0/ );
	assert.doesNotMatch( pipeline, /inherited\.frameId\s*=/ );

} );

test( 'pipeline scheduling hooks are reclaimed after full-effect setup mutates context', () => {

	const start = source.indexOf( 'export class RenderPipeline extends Slim.RenderPipeline {' );
	const end = source.indexOf( 'export class PostProcessing extends RenderPipeline {}', start );
	assert.ok( start >= 0 && end > start, 'expected the replay RenderPipeline wrapper' );
	const pipeline = source.slice( start, end );
	assert.match( pipeline, /let replayBeforeRenderPipeline = null;/ );
	assert.match( pipeline, /replayBeforeRenderPipeline = \(\) => \{/ );
	assert.match( pipeline, /__shouldDeferReplayPostprocessForLoader/ );
	assert.match( pipeline, /diag\.loaderDeferredPipelineFrames/ );
	assert.match( pipeline, /this\.renderer\.__tslpPostprocessPresentationDeferred = true;/ );
	assert.match( pipeline, /__sharedMarkPresentationDeferred\( __presentationReadiness \);/ );
	assert.match( pipeline, /this\.renderer\.__tslpPostprocessPresentationDeferred = false;\s*replayPipelineFrameActive = true;/ );
	assert.match(
		pipeline,
		/context\.onBeforeRenderPipeline = replayBeforeRenderPipeline;\s*context\.onAfterRenderPipeline = replayAfterRenderPipeline;/,
	);
	assert.match( pipeline, /context\.onAfterRenderPipeline = replayAfterRenderPipeline;/ );

	const rendererStart = source.indexOf( 'export class WebGPURenderer extends Slim.WebGPURenderer {' );
	const rendererEnd = source.indexOf( 'export class RenderPipeline extends Slim.RenderPipeline {', rendererStart );
	assert.ok( rendererStart >= 0 && rendererEnd > rendererStart, 'expected the replay renderer wrapper' );
	const renderer = source.slice( rendererStart, rendererEnd );
	assert.match(
		renderer,
		/const presentationDeferred = this\.__tslpPostprocessPresentationDeferred === true;[\s\S]*this\.__tslpPostprocessPresentationDeferred = false;[\s\S]*if \( ! presentationDeferred \) __markSuccessfulReplayPresentation\( this \);/,
		'a loader-deferred pipeline quad must not count as a successful presentation',
	);

} );

test( 'pass-target variant views retain generated selector adapters', () => {

	const start = source.indexOf( 'function __artifactVariantView( artifact, variant ) {' );
	const end = source.indexOf( 'function __selectArtifactForPassTarget(', start );
	assert.ok( start >= 0 && end > start, 'expected the pass-target artifact view helper' );
	const helper = source.slice( start, end );
	assert.match( helper, /return __materializeArtifactVariantSelectorAdapters\( merged \);/ );
	assert.doesNotMatch( helper, /delete merged\.variants|merged\.variants = undefined/, 'both transparent draw-side variants must remain selectable' );

} );

test( 'one-output pass retargeting distinguishes signed MRT and color topologies', () => {

	const start = source.indexOf( 'function __precompiledOutputCount( materialOrArtifact ) {' );
	const end = source.indexOf( 'function __findBestArtifactForPassTarget(', start );
	assert.ok( start >= 0 && end > start, 'expected pass-target selection helpers' );
	const helpers = Function(
		`"use strict";
		const __fragmentOutputCount = () => 1;
		const __countArtifactFragmentOutputsSafe = artifact => artifact.testOutputCount || 1;
		const __materializeArtifactVariantSelectorAdapters = value => value;
		${ source.slice( start, end ) }
		return {
			select: __selectArtifactForPassTarget,
			supports: __artifactSupportsPassTarget,
			topology: __artifactPassMRTTopology,
		};`,
	)();
	const selector = mrt => JSON.stringify( { version: 'render-object-selector@1', mrt } );
	const colorVariant = {
		label: 'color-variant',
		testOutputCount: 1,
		renderContextSelectors: [ selector( null ) ],
	};
	const mrtVariant = {
		label: 'mrt-variant',
		testOutputCount: 1,
		renderContextSelectors: [ selector( { count: 1, names: [ 'output' ] } ) ],
	};
	const family = {
		label: 'color-root',
		testOutputCount: 1,
		renderContextSelectors: [ selector( null ) ],
		variants: { color: colorVariant, mrt: mrtVariant },
	};
	const mrtPass = { _mrt: { isMRTNode: true } };
	const colorPass = { _mrt: null };

	const selectedMRT = helpers.select( family, 1, mrtPass );
	assert.equal( selectedMRT.label, 'mrt-variant', 'one output is insufficient when the signed pass requires MRT' );
	assert.equal( helpers.topology( selectedMRT ), 'mrt' );
	assert.equal( helpers.supports( family, 1, mrtPass ), true );

	const selectedColor = helpers.select( selectedMRT, 1, colorPass );
	assert.equal( selectedColor.label, 'color-variant', 'the following one-output color pass must leave the MRT artifact' );
	assert.equal( helpers.topology( selectedColor ), 'color' );

	const colorOnly = {
		testOutputCount: 1,
		renderContextSelectors: [ selector( null ) ],
	};
	assert.equal( helpers.supports( colorOnly, 1, mrtPass ), false, 'a signed color artifact cannot satisfy a one-output MRT pass' );
	assert.equal(
		helpers.supports( { testOutputCount: 1, renderContextSelectors: [ '{bad-json' ] }, 1, colorPass ),
		false,
		'a malformed signed selector must fail closed',
	);
	assert.equal( helpers.select( family, 1, null ), family, 'unknown legacy pass context retains output-count compatibility' );

} );

test( 'pass topology is threaded through discrete material retargeting', () => {

	const start = source.indexOf( 'function __findBestArtifactForPassTarget(' );
	const end = source.indexOf( 'function __artifactLooksLikeRetroPassMaterial(', start );
	assert.ok( start >= 0 && end > start, 'expected pass material retarget helpers' );
	const helpers = source.slice( start, end );
	assert.match( helpers, /__artifactSupportsPassTarget\( artifact, targetCount, passNode \)/ );
	assert.match( helpers, /__selectArtifactForPassTarget\( mod\.artifact, targetCount, passNode \)/ );
	assert.match( helpers, /__selectArtifactForPassTarget\( currentArtifact, targetCount, passNode \)/ );
	assert.match( helpers, /__findBestArtifactForPassTarget\( className, sourceMaterial, object, targetCount, passNode \)/ );
	assert.match( helpers, /__retargetPrecompiledMaterialForPassTarget\( mat, object, targetCount, passNode \)/ );

} );

test( 'Bloom composite binds only effect-owned scalar uniforms', () => {

	const makeStart = source.indexOf( 'function __makeBloomPrecompiledMaterial( shape, sourceMaterial, name, bloomNode = null ) {' );
	const makeEnd = source.indexOf( 'function __wireBloomCompositeUniforms(', makeStart );
	assert.ok( makeStart >= 0 && makeEnd > makeStart, 'expected the Bloom material factory' );
	const factory = source.slice( makeStart, makeEnd );
	assert.match( factory, /if \( shape === 'bloom-composite' \) __wireBloomCompositeUniforms\( artifact, bloomNode \);/ );
	assert.match( factory, /else \{[\s\S]*__wireLiveNodeSidecarsToArtifact\( artifact, sourceMaterial \);/ );

	const helperEnd = source.indexOf( 'function __setLiveUniformSlot(', makeEnd );
	assert.ok( helperEnd > makeEnd, 'expected the owned Bloom uniform helper' );
	const helper = source.slice( makeEnd, helperEnd );
	assert.match( helper, /property === 'radius'[\s\S]*bloomNode\.radius/ );
	assert.match( helper, /property === 'strength'[\s\S]*bloomNode\.strength/ );
	assert.match( helper, /if \( liveNode \) __setLiveUniformSlot\( slot, liveNode \);/ );

} );

test( 'Bloom high-pass replay does not reschedule producer passes inside its render pass', () => {

	const makeStart = source.indexOf( 'function __makeBloomPrecompiledMaterial( shape, sourceMaterial, name, bloomNode = null ) {' );
	const makeEnd = source.indexOf( 'function __wireBloomCompositeUniforms(', makeStart );
	assert.ok( makeStart >= 0 && makeEnd > makeStart, 'expected the Bloom material factory' );
	const factory = source.slice( makeStart, makeEnd );
	assert.match( factory, /shape === 'bloom-high-pass'[\s\S]*artifact\._liveUpdateBeforeNodes\.filter/ );
	assert.match(
		factory,
		/__shouldRetainBloomHighPassUpdateBeforeNode\( node, __isBloomHighPassPipelineOwnedNode \)/,
		'Bloom must retain ordinary live hooks while removing all RenderPipeline-owned producers and effects',
	);
	for ( const classifier of [
		'__isBloomEffectNode',
		'__isOutlineEffectNode',
		'__isSSREffectNode',
		'__isDOFEffectNode',
		'__isTRAAEffectNode',
		'__isFrameEffectNode',
	] ) {

		assert.match( source, new RegExp( `function __isBloomHighPassPipelineOwnedNode[\\s\\S]*?${ classifier }\\( node \\)` ) );

	}

} );

test( 'full-renderer Bloom success closes its required semantic operation', () => {

	const start = source.indexOf( 'function __patchBloomNodeUpdateBefore( bloomNode ) {' );
	const end = source.indexOf( 'function __renderBloomNodesForPipeline(', start );
	assert.ok( start >= 0 && end > start, 'expected the Bloom update wrapper' );
	const bloom = source.slice( start, end );
	assert.match(
		bloom,
		/__renderBloomNodeWithFullRenderer\([\s\S]*?\) \{\s*__recordSemanticOperation\( 'bloom', 'render-bloom-chain', 'succeeded' \);\s*return;/,
		'a successful full-renderer Bloom branch must balance its attempted outcome before returning',
	);

} );

test( 'Bloom selector misses retain active and captured topology diagnostics', () => {

	const start = source.indexOf( 'function __patchBloomNodeUpdateBefore( bloomNode ) {' );
	const end = source.indexOf( 'function __renderBloomNodesForPipeline(', start );
	assert.ok( start >= 0 && end > start, 'expected the slim Bloom replay loop' );
	const replay = source.slice( start, end );
	assert.match(
		replay,
		/window\.__tslpRecordRenderSelectorMismatch\( err, 'caught-bloom-render' \)/,
		'Bloom must preserve selector details before reducing the error to a console warning',
	);

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
	assert.match( nested, /replay\.render\.nested\.prewarmStaticPMREM/ );
	assert.match( nested, /replay\.render\.nested\.wireBackgroundTextures/ );
	assert.match( nested, /replay\.render\.nested\.wireEnvironmentPMREM/ );
	assert.ok(
		nested.indexOf( "'replay.render.nested.prewarmStaticPMREM'" ) < nested.indexOf( "'replay.render.nested.wireBackgroundTextures'" ),
		'nested background wiring must observe the synchronously generated PMREM',
	);
	assert.ok(
		nested.indexOf( "'replay.render.nested.wireBackgroundTextures'" ) < nested.indexOf( "'replay.render.nested.wireEnvironmentPMREM'" ),
		'nested background and environment wiring retain deterministic order',
	);
	assert.ok(
		nested.indexOf( "'replay.render.nested.wireEnvironmentPMREM'" ) < nested.indexOf( "'replay.render.nested.super'" ),
		'nested scene resources must be wired before the renderer shortcut',
	);

} );

test( 'top-level offscreen replay rewires background after synchronous PMREM prewarm', () => {

	const prewarm = source.indexOf( "'replay.render.prewarmStaticPMREM'" );
	const background = source.indexOf( "'replay.render.wireBackgroundTextures'", prewarm );
	const environment = source.indexOf( "'replay.render.wireEnvironmentPMREM'", prewarm );
	const mainRender = source.indexOf( "'replay.render.super'", prewarm );
	assert.ok( prewarm >= 0, 'expected top-level offscreen PMREM prewarm' );
	assert.ok(
		prewarm < background && background < environment && environment < mainRender,
		'offscreen background aux refs must be refreshed from PMREM before hydration starts',
	);

} );

test( 'replay defers top-level draws until captured loader readiness is reproducible', () => {

	const replayRenderer = source.indexOf( 'export class WebGPURenderer extends Slim.WebGPURenderer {' );
	const renderStart = source.indexOf( 'render( scene, camera ) {', replayRenderer );
	const renderEnd = source.indexOf( 'renderObject( object, scene, camera,', renderStart );
	assert.ok( renderStart >= 0 && renderEnd > renderStart, 'expected the replay WebGPURenderer render override' );
	const render = source.slice( renderStart, renderEnd );
	const loaderGuard = render.indexOf( '( window.__tslpLoaderPending | 0 ) > 0' );
	const policyGuard = render.indexOf( '__shouldDeferReplayRenderForLoader( {' );
	const prepareScene = render.indexOf( "replay.render.prepareSceneForReplay" );
	const renderDepth = render.indexOf( '__renderDepth ++' );
	assert.equal( loaderGuard, - 1, 'loader readiness is centralized in the tested render-target policy' );
	assert.ok( policyGuard >= 0, 'expected pending-loader replay deferral policy' );
	assert.ok(
		policyGuard < prepareScene && policyGuard < renderDepth,
		'loader deferral must happen before material replacement or renderer-state mutation',
	);
	assert.match( render, /materialComputePresentation: this\.__tslpMaterialComputePresentationRender === true/ );
	assert.match( render, /renderTarget: __loaderReadinessRenderTarget/ );
	assert.match( render, /diag\.loaderDeferredRenders/ );

} );

test( 'late PMREM wiring preserves in-flight RenderObjects for texture rebinding', () => {

	const start = source.indexOf( 'function __wireEnvironmentPMREM( renderer, scene ) {' );
	const end = source.indexOf( 'function __kickPMREMGenAsync(', start );
	assert.ok( start >= 0 && end > start, 'expected the PMREM wiring helper' );
	const helper = source.slice( start, end );
	assert.match( helper, /artifactTextureRebinder observes the updated _textureRefs/ );
	assert.doesNotMatch( helper, /\bm\.dispose\(\)/, 'PMREM wiring must not destroy an in-flight material UBO' );

} );

test( 'opt-in PMREM GPU readback diagnoses full and safely shared slim resources', () => {

	assert.match( source, /process\.env\.TSLP_DEBUG_PMREM_READBACK === '1'/ );
	const start = source.indexOf( 'const __pmremReadbackQueued = new WeakSet();' );
	const end = source.indexOf( 'function __shareGPUTextureEntry(', start );
	assert.ok( start >= 0 && end > start, 'expected the generated PMREM readback helpers' );
	const helpers = source.slice( start, end );
	assert.match( helpers, /function __halfFloatToNumber\( bits \)/ );
	assert.match( helpers, /backend\.copyTextureToBuffer\( pmrem, point\.x, point\.y, 1, 1, 0 \)/ );
	assert.match( helpers, /atlasLodIndex: lodIndex/ );
	assert.match( helpers, /finiteCount/ );
	assert.match( helpers, /nonzeroCount/ );
	assert.match( helpers, /min:/ );
	assert.match( helpers, /max:/ );
	assert.match( helpers, /mean:/ );
	assert.match( helpers, /const sameDevice =/ );
	assert.match( helpers, /const sameGPUTexture =/ );
	assert.match( helpers, /const safeSlimRead = sameDevice && sameGPUTexture/ );
	assert.match( helpers, /probe\.sameDecodedSamples = __pmremReadbackSamplesMatch/ );
	assert.match( helpers, /window\.__tslpPmremPending = \( window\.__tslpPmremPending \| 0 \) \+ 1/ );
	assert.match( source, /if \( __isPMREMTexture\( pmrem \) \) __queuePMREMGPUReadbackDiagnostic\( slimRenderer, fullRenderer, pmrem \);/ );

} );

test( 'SSR output sharing preserves the full renderer target version', () => {

	const start = source.indexOf( 'function __renderSSRNodeWithFullRendererCore(' );
	const end = source.indexOf( 'function __renderSSRNodeWithFullRenderer(', start );
	assert.ok( start >= 0 && end > start, 'expected the SSR full-renderer helper' );
	const helper = source.slice( start, end );
	assert.match( helper, /_ssrRenderTarget\.texture, \{ bumpVersion: false \}/ );
	assert.match( helper, /_blurRenderTarget\.texture, \{ bumpVersion: false \}/ );

	const prepareStart = source.indexOf( 'function __prepareSSRNodeForReplay(' );
	const prepareEnd = source.indexOf( 'function __renderSSRNodesForPipeline(', prepareStart );
	assert.ok( prepareStart >= 0 && prepareEnd > prepareStart, 'expected the SSR replay preparation helper' );
	const prepare = source.slice( prepareStart, prepareEnd );
	const setSizeIndex = prepare.indexOf( 'ssrNode.setSize( replaySize.width, replaySize.height )' );
	const initSSRTargetIndex = prepare.indexOf( '__computeRenderer.initRenderTarget( ssrNode._ssrRenderTarget )' );
	const initBlurTargetIndex = prepare.indexOf( '__computeRenderer.initRenderTarget( ssrNode._blurRenderTarget )' );
	const setupIndex = prepare.indexOf( 'ssrNode.setup( __makeReplayNodeBuilder' );
	assert.ok(
		setSizeIndex >= 0 &&
			initSSRTargetIndex > setSizeIndex &&
			initBlurTargetIndex > setSizeIndex &&
			setupIndex > initSSRTargetIndex &&
			setupIndex > initBlurTargetIndex,
		'SSR targets must reach their final size before setup can initialize backend resources',
	);

} );

test( 'full frame effects share inputs without pre-sharing nested effect-owned targets', () => {

	const start = source.indexOf( 'function __renderFrameEffectNodeWithFullRenderer(' );
	const end = source.indexOf( 'function __renderFrameEffectNodesForPipeline(', start );
	assert.ok( start >= 0 && end > start, 'expected the full frame-effect replay helper' );
	const helper = source.slice( start, end );
	assert.match(
		helper,
		/__shareGraphTexturesBetweenRenderers\( fullRenderer, slimRenderer, node, \{\s*skipOwnedRenderTargets: true,\s*skipTextures: nestedFullOwnedTextures,/,
	);
	assert.match(
		helper,
		/__shareGPUTextureEntry\( slimRenderer, fullRenderer, texture, \{ bumpVersion: false \} \)/,
		'nested frame-effect outputs publish only after their full-renderer update',
	);
	assert.doesNotMatch( helper, /skipOwnedRenderTargets: 'direct'/ );

} );

test( 'effect ownership traversal stops at Pass and RTT input boundaries', () => {

	const start = source.indexOf( 'function __collectOwnedRenderTargetTextures(' );
	const end = source.indexOf( 'function __rememberRenderTargetTextureSet(', start );
	assert.ok( start >= 0 && end > start, 'expected the recursive effect-owned target collector' );
	const collectOwned = Function(
		'__isGraphTraversalCandidate',
		'__readGraphOwnValue',
		`"use strict";\n${ source.slice( start, end ) }\nreturn __collectOwnedRenderTargetTextures;`,
	)(
		( value ) => !! ( value && ( typeof value === 'object' || typeof value === 'function' ) ),
		( value, key ) => value[ key ],
	);
	const texture = ( name ) => ( { isTexture: true, name } );
	const target = ( textureValue ) => ( {
		isRenderTarget: true,
		texture: textureValue,
		textures: [ textureValue ],
		setSize() {},
	} );
	const passInput = texture( 'pass-input' );
	const rttInput = texture( 'rtt-input' );
	const rootOutput = texture( 'root-output' );
	const nestedEffectOutput = texture( 'nested-effect-output' );
	const passNode = { isNode: true, isPassNode: true, renderTarget: target( passInput ) };
	const rttNode = { isNode: true, isRTTNode: true, renderTarget: target( rttInput ) };
	const nestedEffect = {
		isNode: true,
		_resolveRenderTarget: target( nestedEffectOutput ),
	};
	const effect = {
		isNode: true,
		_horizontalRT: target( rootOutput ),
		textureNode: { isNode: true, value: passInput, passNode },
		// Live NodeMaterial dependency lists expose producer nodes through arrays.
		// The collector must stop when recursion reaches those array elements.
		_material: { updateBeforeNodes: [ passNode, rttNode ] },
		nestedEffect,
	};

	const owned = collectOwned( effect );
	assert.equal( owned.has( rootOutput ), true, 'the root effect target remains protected' );
	assert.equal( owned.has( nestedEffectOutput ), true, 'a nested effect target remains protected' );
	assert.equal( owned.has( passInput ), false, 'a Pass producer texture must be shared into the full renderer' );
	assert.equal( owned.has( rttInput ), false, 'an RTT producer texture must be shared into the full renderer' );

} );

test( 'full RTT replay defers specialized effect outputs to their producers', () => {

	const start = source.indexOf( 'function __renderRTTNodeWithFullRenderer(' );
	const end = source.indexOf( 'function __rttPrecompiledShape(', start );
	assert.ok( start >= 0 && end > start, 'expected the full RTT replay helper' );
	const helper = source.slice( start, end );
	assert.match( helper, /const ssrDependencies = __collectSSRNodesInGraph\( rttNode\.node \)/ );
	assert.match( helper, /const dofDependencies = __collectDOFNodesInGraph\( rttNode\.node \)/ );
	assert.match( helper, /const traaDependencies = __collectTRAANodesInGraph\( rttNode\.node \)/ );
	assert.match( helper, /skipTextures: deferredEffectTextures/ );

} );

test( 'terminal TRAA scheduling renders graph producers before downstream output effects', () => {

	const partitionStart = source.indexOf( 'function __postprocessNodeDependsOnAny(' );
	const partitionEnd = source.indexOf( 'function __rttNodeDependsOnBloom(', partitionStart );
	assert.ok( partitionStart >= 0 && partitionEnd > partitionStart, 'expected the postprocess dependency partition helpers' );
	const partitionNodes = Function(
		'__sharedPostprocessGraphContains',
		`"use strict";\n${ source.slice( partitionStart, partitionEnd ) }\nreturn __partitionPostprocessNodesByDependency;`,
	)( ( root, target ) => {
		const seen = new Set();
		const visit = ( node ) => {
			if ( node === target ) return true;
			if ( ! node || seen.has( node ) ) return false;
			seen.add( node );
			return Array.isArray( node.dependencies ) && node.dependencies.some( visit );
		};
		return visit( root );
	} );

	const traa = { name: 'traa' };
	const recurrent = { name: 'recurrent', dependencies: [] };
	const beautyRTT = { name: 'beauty-rtt', dependencies: [ recurrent ] };
	const traaRTT = { name: 'traa-rtt', dependencies: [ traa ] };
	const sharpen = { name: 'sharpen', dependencies: [ traaRTT ] };
	assert.deepEqual(
		partitionNodes( [ recurrent, sharpen ], [ traa ] ),
		{ independent: [ recurrent ], dependent: [ sharpen ] },
		'the stable partition must keep recurrent before TRAA and sharpen after it',
	);
	assert.deepEqual(
		partitionNodes( [ beautyRTT, traaRTT ], [ traa ] ),
		{ independent: [ beautyRTT ], dependent: [ traaRTT ] },
		'the RTT wrapping TRAA must not be claimed by the early producer wave',
	);

	const outputHelperStart = source.indexOf( 'function __renderOutputFrameEffectsAndBloomForPipeline(' );
	const outputHelperEnd = source.indexOf( '// RenderPipeline (and PostProcessing which extends it)', outputHelperStart );
	assert.ok( outputHelperStart >= 0 && outputHelperEnd > outputHelperStart, 'expected the output-effect scheduler helper' );
	const outputHelper = source.slice( outputHelperStart, outputHelperEnd );
	assert.ok(
		outputHelper.indexOf( 'renderReadyEffectRTTNodes();' ) < outputHelper.indexOf( 'for ( const effectNode of effectNodes || [] )' ),
		'ready RTT producers must flush before the first downstream effect',
	);
	let renderOrder = [];
	let failedRTTs = new Set();
	const renderRTTNodes = ( _renderer, rttNodes, schedule, role, dependenciesFor ) => {
		let succeeded = true;
		for ( const rttNode of rttNodes ) {
			const render = () => {
				renderOrder.push( rttNode.name );
				return ! failedRTTs.has( rttNode );
			};
			const dependencies = typeof dependenciesFor === 'function' ? dependenciesFor( rttNode ) : [];
			const rendered = schedule
				? schedule.run( rttNode, role, render, { dependsOn: dependencies } )
				: render();
			if ( rendered === false ) succeeded = false;
		}
		return succeeded;
	};
	const renderOutputEffects = Function(
		'__frameEffectDiagnostics',
		'__effectDependenciesForRTT',
		'__renderRTTNodesForPipeline',
		'__POSTPROCESS_FRAME_ROLES',
		'__frameEffectInputRTTProducers',
		'__renderFrameEffectInputRTTProducersForPipeline',
		'__graphContainsNode',
		'__renderBloomNodeOnceForPipeline',
		'__renderBloomDependentRTTNodesForPipeline',
		'__renderFrameEffectNodeWithFullRenderer',
		'__computeRenderer',
		`"use strict";\n${ outputHelper }\nreturn __renderOutputFrameEffectsAndBloomForPipeline;`,
	)(
		() => ( { collected: 0 } ),
		( rttNode, effectNodes ) => effectNodes.filter( ( effectNode ) => rttNode.dependencies.includes( effectNode ) ),
		renderRTTNodes,
		{ EFFECT: 'effect', CONSUMER: 'consumer', PRODUCER: 'producer' },
		( effectNode, producersForEffect ) => typeof producersForEffect === 'function' ? producersForEffect( effectNode ) : [],
		( renderer, effectNode, schedule, producersForEffect ) => {
			const producers = typeof producersForEffect === 'function' ? producersForEffect( effectNode ) : [];
			return {
				producers,
				succeeded: renderRTTNodes( renderer, producers, schedule, 'producer', null ) !== false,
			};
		},
		() => false,
		() => true,
		() => 0,
		( effectNode ) => {
			renderOrder.push( effectNode.name );
			return true;
		},
		null,
	);

	const taau = { name: 'taau' };
	const taauRTT = { name: 'taau-rtt', dependencies: [ taau ] };
	const taauSharpen = { name: 'taau-sharpen' };
	renderOutputEffects( null, [ taau, taauSharpen ], [], null, [ taauRTT ] );
	assert.deepEqual(
		renderOrder,
		[ 'taau', 'taau-rtt', 'taau-sharpen' ],
		'the generic TAAU chain must retain producer -> RTT -> Sharpen order',
	);

	renderOrder = [];
	const lensflare = { name: 'lensflare' };
	const authoredFlareTexture = { name: 'full-resolution-half-float-rtt' };
	const flareRTT = {
		name: 'lensflare-rtt',
		isRTTNode: true,
		value: authoredFlareTexture,
		dependencies: [ lensflare ],
	};
	const gaussianBlur = {
		name: 'gaussian-blur',
		textureNode: flareRTT,
	};
	renderOutputEffects( null, [ lensflare, gaussianBlur ], [], null, [ flareRTT ] );
	assert.deepEqual(
		renderOrder,
		[ 'lensflare', 'lensflare-rtt', 'gaussian-blur' ],
		'a nested Lensflare must render through its authored full-resolution RTT before Gaussian blur consumes it',
	);
	assert.equal(
		gaussianBlur.textureNode.value,
		authoredFlareTexture,
		'the dependency wave must preserve the authored RTT texture instead of substituting LensflareNode._renderTarget.texture',
	);

	renderOrder = [];
	const frozenDependencies = new Map( [
		[ beautyRTT, [ recurrent ] ],
		[ traaRTT, [ traa ] ],
	] );
	beautyRTT.dependencies.push( sharpen, traa );
	const makeSchedule = () => {
		const succeeded = new Set();
		const roles = new Map();
		const conflicts = [];
		return {
			hasSucceeded: ( node ) => succeeded.has( node ),
			getConflicts: () => conflicts.slice(),
			run: ( node, role, render, options = {} ) => {
				const claimedRole = roles.get( node );
				if ( claimedRole && claimedRole !== role ) {
					conflicts.push( { node, claimedRole, requestedRole: role } );
					return false;
				}
				if ( succeeded.has( node ) ) return true;
				roles.set( node, role );
				if ( ! ( options.dependsOn || [] ).every( ( dependency ) => succeeded.has( dependency ) ) ) return false;
			const result = render();
			if ( result !== false ) succeeded.add( node );
			return result;
			},
		};
	};
	const schedule = makeSchedule();
	const frozenDependenciesForRTT = ( rttNode ) => frozenDependencies.get( rttNode ) || [];
	const frozenInputProducersForEffect = ( effectNode ) => effectNode === recurrent ? [ beautyRTT ] : [];
	renderOutputEffects(
		null,
		[ recurrent ],
		[],
		null,
		[ beautyRTT ],
		schedule,
		[ recurrent, sharpen, traa ],
		frozenDependenciesForRTT,
		frozenInputProducersForEffect,
	);
	schedule.run( traa, 'terminal-effect', () => {
		renderOrder.push( traa.name );
		return true;
	}, { dependsOn: [ recurrent, beautyRTT ] } );
	renderOutputEffects(
		null,
		[ sharpen ],
		[],
		null,
		[ traaRTT ],
		schedule,
		[ recurrent, sharpen, traa ],
		frozenDependenciesForRTT,
		frozenInputProducersForEffect,
	);
	assert.deepEqual(
		renderOrder,
		[ 'beauty-rtt', 'recurrent', 'traa', 'traa-rtt', 'sharpen' ],
		'the exact Temporal beauty producer overrides the previous-frame feedback edge without disturbing the terminal wave',
	);
	assert.equal( renderOrder.filter( ( name ) => name === 'beauty-rtt' ).length, 1 );
	assert.deepEqual( schedule.getConflicts(), [], 'the forced beauty RTT must retain one producer role for the frame' );

	renderOrder = [];
	failedRTTs = new Set( [ beautyRTT ] );
	const failedSchedule = makeSchedule();
	assert.equal(
		renderOutputEffects(
			null,
			[ recurrent ],
			[],
			null,
			[ beautyRTT ],
			failedSchedule,
			[ recurrent ],
			frozenDependenciesForRTT,
			frozenInputProducersForEffect,
		),
		false,
	);
	assert.deepEqual( renderOrder, [ 'beauty-rtt' ], 'a failed beauty producer blocks the recurrent consumer callback' );
	assert.deepEqual( failedSchedule.getConflicts(), [] );
	failedRTTs = new Set();

	const snapshotStart = source.indexOf( 'const outputAndTerminalEffectNodes = Array.from( new Set( [ ...effectNodes, ...traaNodes ] ) );' );
	const prepareEffects = source.indexOf( 'for ( const node of effectNodes ) __prepareFrameEffectNodeForReplay(', snapshotStart );
	assert.ok( snapshotStart >= 0 && snapshotStart < prepareEffects, 'RTT dependency edges must be frozen before effect setup mutates the live graph' );
	const snapshot = source.slice( snapshotStart, prepareEffects );
	assert.match( snapshot, /const inputRTTProducersByEffect = new Map/ );
	assert.match( snapshot, /const stableInputRTTProducersForEffect =/ );
	assert.match( snapshot, /const schedulableRTTNodes = rttNodes\.filter/ );
	assert.match( snapshot, /const effectDependenciesByRTT = new Map/ );
	assert.match( snapshot, /const stableEffectDependenciesForRTT =/ );

	const pipelineWaveStart = source.indexOf( 'context.onBeforeRenderPipeline =', prepareEffects );
	const waveStart = source.indexOf( '__renderOutputFrameEffectsAndBloomForPipeline(', pipelineWaveStart );
	const waveEnd = source.indexOf( 'if ( outlineNodes.length > 0 )', waveStart );
	assert.ok( waveStart >= 0 && waveEnd > waveStart, 'expected the partitioned terminal-effect wave' );
	const wave = source.slice( waveStart, waveEnd );
	const preTRAA = wave.indexOf( 'preTRAAOutputEffectNodes' );
	const renderTRAA = wave.indexOf( '__renderTRAANodesForPipeline(' );
	const postTRAA = wave.indexOf( 'postTRAAOutputEffectNodes' );
	assert.ok(
		preTRAA >= 0 && preTRAA < renderTRAA && renderTRAA < postTRAA,
		'output effects must execute as pre-TRAA producers, TRAA, then downstream consumers',
	);
	assert.match( wave, /\.\.\.preTRAAEffectDependentRTTNodes/ );
	assert.doesNotMatch(
		wave.slice( wave.indexOf( 'const traaDependencies' ), renderTRAA ),
		/\.\.\.outputEffectNodes/,
		'TRAA cannot depend on downstream effects that consume its output',
	);

} );

test( 'late effect texture rewiring invalidates the hydrated pipeline material', () => {

	const refreshStart = source.indexOf( 'function __refreshPipelineMaterialArtifact(' );
	const refreshEnd = source.indexOf( 'function __configureRenderPipelineQuadMaterial(', refreshStart );
	assert.ok( refreshStart >= 0 && refreshEnd > refreshStart, 'expected the pipeline material refresh helper' );
	const refresh = Function(
		`"use strict";\n${ source.slice( refreshStart, refreshEnd ) }\nreturn __refreshPipelineMaterialArtifact;`,
	)();
	const artifact = {};
	let disposed = 0;
	let cacheClears = 0;
	const material = {
		precompiledArtifact: null,
		needsUpdate: false,
		dispose() { disposed ++; },
	};
	const renderer = {
		_nodes: {
			nodeBuilderCache: {
				clear() { cacheClears ++; },
			},
		},
	};

	assert.equal( refresh( renderer, material, artifact ), artifact );
	assert.equal( material.precompiledArtifact, artifact );
	assert.equal( material.needsUpdate, true );
	assert.equal( disposed, 1 );
	assert.equal( cacheClears, 1 );

	const traaRender = source.indexOf( '__renderTRAANodesForPipeline( this.renderer' );
	const trailingStart = source.indexOf( 'if ( outlineNodes.length > 0 )', traaRender );
	const trailingEnd = source.indexOf( '} finally {', trailingStart );
	assert.ok( traaRender >= 0 && trailingStart > traaRender && trailingEnd > trailingStart, 'expected the late effect texture refresh branches' );
	const trailing = source.slice( trailingStart, trailingEnd );
	const refreshCalls = trailing.match( /__refreshPipelineMaterialArtifact\( this\.renderer, mat, artifact \);/g ) || [];
	assert.equal( refreshCalls.length, 2, 'outline and SSR/DOF/TRAA rewires must both invalidate hydrated resources' );
	assert.doesNotMatch( trailing, /mat\.precompiledArtifact = artifact/, 'late refs cannot be assigned without cache invalidation' );

} );

test( 'opt-in IBL diagnostics capture DFG GPU data, samplers, bind groups, and storage ordinals', () => {

	assert.match( source, /process\.env\.TSLP_DEBUG_IBL_BINDINGS === '1'/ );
	assert.match( source, /globalThis\.__TSLP_DEBUG_IBL_BINDINGS = true/ );
	const readbackStart = source.indexOf( 'const __iblDfgReadbackQueued = new WeakSet();' );
	const readbackEnd = source.indexOf( 'function __shareGPUTextureEntry(', readbackStart );
	assert.ok( readbackStart >= 0 && readbackEnd > readbackStart, 'expected generated DFG readback diagnostics' );
	const readback = source.slice( readbackStart, readbackEnd );
	assert.match( readback, /__readPMREMBackendSamples\( renderer, texture, points \)/ );
	assert.match( readback, /__iblDfgCpuSamples/ );
	assert.match( readback, /probe\.sameDecodedSamples = __pmremReadbackSamplesMatch/ );
	assert.match( readback, /window\.__tslpPmremPending = \( window\.__tslpPmremPending \| 0 \) \+ 1/ );

	const samplerStart = source.indexOf( 'const __iblSamplerDescriptorsByDevice = new WeakMap();' );
	const samplerEnd = source.indexOf( 'function __bindGroupLayoutSignature(', samplerStart );
	assert.ok( samplerStart >= 0 && samplerEnd > samplerStart, 'expected generated IBL sampler and binding diagnostics' );
	const sampler = source.slice( samplerStart, samplerEnd );
	assert.match( sampler, /device\.createSampler = function \( descriptor \)/ );
	assert.match( sampler, /samplerDescriptor: descriptor/ );
	assert.match( sampler, /pairUsesSameTexture/ );
	assert.match( sampler, /backendSamplerKey/ );
	assert.match( sampler, /bindGroupLayoutKey/ );
	assert.match( sampler, /__queueIBLDFGReadbackDiagnostic\( renderer, texture \)/ );
	assert.match( source, /__patchIBLSamplerCreationDiagnostics\( this \);/ );
	assert.match( source, /__patchIBLBindingUpdateDiagnostics\( this \);/ );

	const storageStart = source.indexOf( 'const __iblStorageDiagnosticsRecorded = new WeakSet();' );
	const storageEnd = source.indexOf( 'function __wireStorageBuffersBySnapshot(', storageStart );
	assert.ok( storageStart >= 0 && storageEnd > storageStart, 'expected generated IBL storage diagnostics' );
	const storage = source.slice( storageStart, storageEnd );
	assert.match( storage, /sourceOrdinal:/ );
	assert.match( storage, /liveAttributeId:/ );
	assert.match( storage, /snapshotFirst8:/ );
	assert.match( storage, /liveFirst8:/ );
	assert.match( storage, /snapshotDistance:/ );
	assert.match( source, /__recordIBLStorageWiringDiagnostic\( artifact, sourceMaterial \);/ );

} );

test( 'opt-in object UBO diagnostics reach the replay page before hydration', () => {

	assert.match( source, /process\.env\.TSLP_DEBUG_OBJECT_UBO === '1'/ );
	assert.match( source, /globalThis\.__TSLP_DEBUG_OBJECT_UBO = true/ );

} );

test( 'video panorama freezes a deterministic decoded frame before settling', () => {

	const start = source.indexOf( 'if ( browserStabilizationPolicy?.freezeRepresentativeMediaFrame === true' );
	const end = source.indexOf( '// Save the original Date.now', start );
	assert.ok( start >= 0 && end > start, 'expected the video-media determinism hook' );
	const hook = source.slice( start, end );
	assert.match( hook, /w\.__tslpLoaderPending = \( w\.__tslpLoaderPending \| 0 \) \+ 1/ );
	assert.match( hook, /const targetTime = 0\.25;/ );
	assert.match( hook, /media\.addEventListener\( 'seeked', finish, \{ once: true \} \)/ );
	assert.ok( hook.indexOf( 'media.pause();' ) < hook.indexOf( 'media.currentTime = targetTime;' ) );
	assert.match( hook, /w\.__tslpVideoMediaFrozen = true/ );

} );

test( 'video-frame capture remains unsettled until its pinned decoder frame is renderable', () => {

	const start = source.indexOf( 'if ( browserStabilizationPolicy?.freezeRepresentativeVideoDecoderFrame === true' );
	const end = source.indexOf( 'w.__tslpWrapAnimationLoop = function', start );
	assert.ok( start >= 0 && end > start, 'expected the VideoDecoder first-frame hook' );
	const hook = source.slice( start, end );
	assert.match( hook, /w\.__tslpLoaderPending = \( w\.__tslpLoaderPending \| 0 \) \+ 1/ );
	assert.match( hook, /const settleFirstFrame = \(\) =>/ );
	assert.match( hook, /const targetTimestamp = 5_000_000/ );
	assert.match( hook, /timestamp >= targetTimestamp/ );
	assert.match( hook, /w\.__tslpVideoFrameDelivered = true/ );
	assert.ok(
		hook.indexOf( 'if ( output ) return output( frame );' ) < hook.indexOf( 'settleFirstFrame();' ),
		'the decoded frame must reach VideoFrameTexture before readiness is released',
	);
	assert.match( hook, /error\( reason \)/ );
	assert.match( hook, /flush\(\) \{\s*if \( w\.__tslpVideoFrameDelivered === true \) return new Promise/ );

} );

test( 'stock, capture, and replay share logical-frame temporal jitter progression', () => {

	const imports = source.match( /import \{[^}]*synchronizeTemporalJitterNode as __sharedSynchronizeTemporalJitterNode[^}]*\} from '\/__tslp_batch\/temporal-jitter\.mjs';/g ) || [];
	assert.equal( imports.length, 3, 'all three generated WebGPU modules must use the shared jitter clock' );
	const projectionImports = source.match( /import \{ installVelocityProjectionLifecycle as __installVelocityProjectionLifecycle \} from '\/__tslp_runtime\/slim-support\/velocity-projection-lifecycle\.js';/g ) || [];
	assert.equal( projectionImports.length, 3, 'all three generated WebGPU modules must use the product projection lifecycle' );
	assert.match( source, /function __syncStockTRAAJitterIndex/ );
	assert.match( source, /function __syncCaptureTRAAJitterIndex/ );
	assert.match( source, /function __syncTRAAJitterIndex/ );
	assert.match( source, /installVelocityProjectionLifecycle: __installVelocityProjectionLifecycle/ );
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
