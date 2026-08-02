import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { resolveE2EHarnessSourceFiles } from '../e2e-evidence.mjs';
import {
	capturedDebugShaderResult,
	refreshRTTMaterialFragmentIdentity,
	selectAfterImageReplayTextures,
	selectReplayEffectSize,
	selectFrameEffectInputRTTProducers,
	selectFrameEffectOwnedPassDependency,
	selectReplayPostprocessAuxEntry,
	shouldInitializeSharedDeviceFallback,
	shouldRetainBloomHighPassUpdateBeforeNode,
	shouldDeferReplayPostprocessForLoader,
	shouldDeferReplayRenderForLoader,
	shouldPreferSlimBloomReplay,
	slimWebgpuReplayModule,
} from '../e2e-slim-replay-module.mjs';
import {
	selectLateRenderTargetTexturePair,
	trackLateTextureNodeAssignments,
} from '../late-render-target-textures.mjs';
import {
	isBorrowedShadowRenderTargetTexture,
	shareGPUTextureEntry,
} from '../../../runtime/src/slim-support/gpu-texture-share.js';

const runnerSource = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );
const factorySource = readFileSync( new URL( '../e2e-slim-replay-module.mjs', import.meta.url ), 'utf8' );
const harnessSourceFiles = resolveE2EHarnessSourceFiles(
	fileURLToPath( new URL( '../../../../', import.meta.url ) ),
);
const fixture = Object.freeze( {
	nodeMaterialExports: [ 'NodeMaterial', 'MeshBasicNodeMaterial' ],
	slimBundleBrowserModule: '/__fixture__/slim.js?v=exact',
	slimReplayForwardExportBlock: 'export { Alpha, Beta } from "/__fixture__/slim.js?v=exact";',
	slimReplayFullFallbackExportBlock: 'export { Gamma } from "/build/three.webgpu.js";',
	replayOperationDiagnostics: true,
	slimHashOptions: {
		threeVersion: '0.185.1-fixture',
		pluginVersion: '0.1.0-fixture',
	},
} );

test( 'slim replay factory keeps its mechanically extracted generated-source contract', () => {

	const generated = slimWebgpuReplayModule( fixture );
	assert.equal(
		createHash( 'sha256' ).update( generated ).digest( 'hex' ),
		'847939609e40265be4ee208c4606346eab17896c599acdfb12fa302013b9fe9f',
	);
	assert.equal( Buffer.byteLength( generated ), 698606 );
	assert.match( generated, /^\nimport \* as Slim from "\/__fixture__\/slim\.js\?v=exact";/ );
	assert.match( generated, /const __debugReplayOperations = true;/ );
	assert.match( generated, /window\.__tslpPresentationReadiness = __presentationReadiness;/ );
	assert.match( generated, /__sharedMarkPresentationDeferred\( __presentationReadiness \);/ );
	assert.match( generated, /__markSuccessfulReplayPresentation\( this \);/ );
	assert.match( generated, /operationOutcomes/ );
	assert.match( generated, /schema: 'tslp-e2e-operation-registry@1'/ );
	assert.match( generated, /complete: false/ );
	assert.match( generated, /__ensureSemanticOperationRegistry\(\);/ );
	assert.match( generated, /window\.__tslpSealReplayOperationRegistry = __sealReplayOperationRegistry;/ );
	assert.match( generated, /if \( registry\.complete === true \) registry\.complete = false;/ );
	assert.match( generated, /__expectSemanticOperation\( 'material-compute', 'dispatch-and-present' \)/ );
	assert.match( generated, /__expectSemanticOperation\( 'render-pipeline-pass', 'render-pass-node' \)/ );
	assert.match( generated, /__expectSemanticOperation\( 'bloom', 'render-bloom-chain' \)/ );
	assert.match( generated, /__artifactVariantRecoveryIdentity\( err, 'FSR1Node' \)/ );
	assert.match( generated, /__artifactVariantRecoveryIdentity\( err, 'BloomNode' \)/ );
	assert.match( generated, /recoveryRecords\.push\( \{/ );
	assert.match( generated, /failureNumber: outcome\.failed/ );
	assert.match( generated, /presentationBaseline/ );
	assert.match( generated, /renderBaseline/ );
	assert.match(
		generated,
		/__prepareBloomNodeForReplay\( node, context \);[\s\S]*?__neutralizeBloomNodeAutoUpdate\( node \);/,
		'pipeline scheduling must suppress Bloom auto-update until pass textures are ready',
	);
	assert.match( generated, /structured material compute delegation failure/ );
	assert.match( generated, /const __shouldPreferSlimBloomReplay = function shouldPreferSlimBloomReplay/ );
	assert.match( generated, /const __shouldRetainBloomHighPassUpdateBeforeNode = function shouldRetainBloomHighPassUpdateBeforeNode/ );
	assert.match( generated, /const __selectAfterImageReplayTextures = function selectAfterImageReplayTextures/ );
	assert.match(
		generated,
		/attachExactMaterialGraphDepthTextureRefs as __sharedAttachExactMaterialGraphDepthTextureRefs/,
	);
	assert.match(
		generated,
		/__sharedAttachExactMaterialGraphDepthTextureRefs\(\s*artifact,\s*exactDepthTextureCandidates,\s*\);/,
		'lazy material-graph depth textures must bind only through their captured render-target selector',
	);
	assert.match(
		generated,
		/const exactDepthTextureCandidates = \[\s*\.\.\.nodeTextures,\s*\.\.\.globalTslTextures,\s*\.\.\.__exactMaterialGraphDepthTextureCandidates,\s*\];/,
	);
	assert.match(
		generated,
		/__shareShadowGpuTextureIntoSlim\( depthTexture, fullRenderer, slimRenderer \);\s*__rememberExactMaterialGraphDepthTextureCandidate\( depthTexture \);/,
		'custom shadow depth becomes an exact binding candidate only after its GPU resource is shared',
	);
	assert.match( generated, /byName\.set\( 'AfterImageNode\.old', \[ oldTexture \] \)/ );
	assert.match( generated, /byName\.set\( 'AfterImageNode\.comp', \[ compTexture \] \)/ );
	assert.match(
		generated,
		/__sharedPrepareAfterImageReplayResources\( node, fullRenderer \);[\s\S]*?node\.setup\( __makeReplayNodeBuilder/,
		'AfterImage resource descriptors must be prepared before setup can hydrate its composed material',
	);
	assert.doesNotMatch(
		generated,
		/inputNode\.passNode/,
		'a standard PassTextureNode back-reference is not a slim-Bloom capability signal',
	);
	assert.match( runnerSource, /url\.pathname === '\/__tslp_batch\/presentation-readiness\.mjs'/ );
	assert.match(
		generated,
		/hashNodeGraphSync\( input, \{ shape: 'background', threeVersion: "0\.185\.1-fixture", pluginVersion: "0\.1\.0-fixture" \} \)/,
	);
	assert.equal( slimWebgpuReplayModule( fixture ), generated, 'factory output must be deterministic' );

} );

test( 'WebGL replay skips the WebGPU shared-device fallback without bypassing precompiled compute', () => {

	assert.equal( shouldInitializeSharedDeviceFallback( null ), false );
	assert.equal( shouldInitializeSharedDeviceFallback( { __tslpForceWebGLReplay: true } ), false );
	assert.equal( shouldInitializeSharedDeviceFallback( { backend: { isWebGLBackend: true } } ), false );
	assert.equal( shouldInitializeSharedDeviceFallback( { backend: { isWebGPUBackend: true } } ), true );

	const generated = slimWebgpuReplayModule( fixture );
	const rendererClassStart = generated.indexOf( 'export class WebGPURenderer extends Slim.WebGPURenderer {' );
	const rendererClassEnd = generated.indexOf( 'function __patchReplayBackgroundOperationDiagnostics', rendererClassStart );
	const rendererClassSource = generated.slice( rendererClassStart, rendererClassEnd );
	assert.equal( ( rendererClassSource.match( /async init\( \.\.\.args \) \{/g ) || [] ).length, 1 );
	assert.match(
		rendererClassSource,
		/const r = await super\.init\( \.\.\.args \);\s*this\.__tslpRecordReplayBackend\(\);[\s\S]*?if \( __shouldInitializeSharedDeviceFallback\( this \) \)/,
		'the settled backend must be recorded before choosing a shared-device fallback',
	);
	const getComputeRendererStart = generated.indexOf( 'async function __getComputeRenderer( slimRenderer ) {' );
	const fallbackCreation = generated.indexOf( '__sharedCreateFullRendererFallback( {', getComputeRendererStart );
	assert.ok( getComputeRendererStart >= 0 && fallbackCreation > getComputeRendererStart );
	assert.match(
		generated.slice( getComputeRendererStart, fallbackCreation ),
		/if \( ! __shouldInitializeSharedDeviceFallback\( slimRenderer \) \) return null;/,
		'the backend guard must run before fallback lookup or construction',
	);
	assert.match(
		generated,
		/if \( computeNode && computeNode\.isPrecompiledCompute === true \) \{\s*return super\.compute\( computeNode, \.\.\.rest \);/,
		'precompiled WebGL compute must continue through the slim renderer',
	);
	assert.match(
		generated,
		/if \( computeNode && computeNode\.isPrecompiledCompute === true \) \{\s*return super\.computeAsync\( computeNode, \.\.\.rest \);/,
		'async precompiled WebGL compute must continue through the slim renderer',
	);
	assert.doesNotMatch(
		generated,
		/__tslpStorageBufferPboReplayMaterial|tslp-storage-buffer-pbo-replay|replaceStorageBufferPboMaterials/,
		'WebGL replay must use the captured GLSL material instead of injecting a non-precompiled MeshBasicMaterial stand-in',
	);

} );

test( 'Gaussian blur preserves the authored RTT boundary around nested Lensflare output', () => {

	const generated = slimWebgpuReplayModule( fixture );
	assert.doesNotMatch(
		generated,
		/__findOwnedEffectTexture|__retargetGaussianBlurInputTexture/,
		'Gaussian blur must retain the authored convertToTexture RTT instead of substituting LensflareNode._renderTarget.texture',
	);
	assert.match(
		generated,
		/__retargetLensflareInputTexture/,
		'the independent Bloom-to-Lensflare input synchronization remains installed',
	);

} );

test( 'Bloom replay uses explicit capabilities instead of the universal pass-texture proxy', () => {

	assert.equal(
		shouldPreferSlimBloomReplay( { isPassNode: true }, 'webgpu_generator_city.html' ),
		true,
		'a literal PassNode preserves the existing direct-input capability',
	);
	assert.equal(
		shouldPreferSlimBloomReplay(
			{ isPassTextureNode: true, passNode: { isPassNode: true } },
			'webgpu_generator_city.html',
		),
		false,
		'every standard getTextureNode() result has a passNode back-reference, so it cannot select slim replay',
	);
	for ( const example of [
		'webgpu_volume_cloud.html',
		'webgpu_postprocessing_lensflare.html',
		'webgpu_water.html',
	] ) {

		assert.equal( shouldPreferSlimBloomReplay( null, example ), true, `${ example } keeps its proven slim path` );

	}
	assert.equal( shouldPreferSlimBloomReplay( null, 'webgpu_postprocessing_bloom.html' ), false );

} );

test( 'Bloom high-pass retains only owner-local live update hooks', () => {

	const isPipelineOwnedEffect = ( node ) => node.pipelineOwnedEffect === true;
	assert.equal( shouldRetainBloomHighPassUpdateBeforeNode( null, isPipelineOwnedEffect ), false );
	assert.equal( shouldRetainBloomHighPassUpdateBeforeNode( { type: 'UniformNode' }, isPipelineOwnedEffect ), true );
	assert.equal( shouldRetainBloomHighPassUpdateBeforeNode( { isPassNode: true }, isPipelineOwnedEffect ), false );
	assert.equal( shouldRetainBloomHighPassUpdateBeforeNode( { isRTTNode: true }, isPipelineOwnedEffect ), false );
	for ( const type of [ 'GaussianBlurNode', 'BloomNode', 'OutlineNode', 'SSRNode', 'DepthOfFieldNode', 'TRAANode' ] ) {

		assert.equal(
			shouldRetainBloomHighPassUpdateBeforeNode( { type, pipelineOwnedEffect: true }, isPipelineOwnedEffect ),
			false,
			`${ type } is scheduled by RenderPipeline and must not run inside Bloom's high-pass render`,
		);

	}
	assert.equal(
		shouldRetainBloomHighPassUpdateBeforeNode( { isComputeNode: true }, isPipelineOwnedEffect ),
		true,
		'an unrelated authored compute/update sidecar remains owner-local unless the pipeline classifier proves otherwise',
	);

} );

test( 'AfterImage replay keeps history and composited texture aliases distinct', () => {

	const oldTexture = { isTexture: true, name: 'AfterImageNode.old' };
	const compTexture = { isTexture: true, name: 'AfterImageNode.comp' };
	const node = {
		_textureNodeOld: { value: oldTexture },
		_oldRT: { texture: { isTexture: true, name: 'stale-old-target' } },
		_compRT: { texture: { isTexture: true, name: 'stale-comp-target' } },
		getTextureNode() {

			return { value: compTexture };

		},
	};
	assert.deepEqual( selectAfterImageReplayTextures( node ), { oldTexture, compTexture } );
	assert.notEqual( oldTexture, compTexture );

	const fallbackOld = { isTexture: true };
	const fallbackComp = { isTexture: true };
	assert.deepEqual( selectAfterImageReplayTextures( {
		_oldRT: { texture: fallbackOld },
		_compRT: { texture: fallbackComp },
	} ), {
		oldTexture: fallbackOld,
		compTexture: fallbackComp,
	} );
	assert.deepEqual(
		selectAfterImageReplayTextures( null ),
		{ oldTexture: null, compTexture: null },
	);

} );

test( 'post-process replay selects one exact renderer-depth metadata capture', () => {

	const entry = ( name, replayConfig, configHash = name ) => ( {
		name,
		configHash,
		shape: 'post-process',
		artifact: { replayConfig: { schema: 'render-pipeline@1', ...replayConfig } },
	} );
	const base = {
		outputColorTransform: true,
		toneMapping: 0,
		outputColorSpace: 'srgb',
	};
	const normal = entry( 'normal', base );
	const reversed = entry( 'reversed', { ...base, reversedDepthBuffer: true } );
	const logarithmic = entry( 'logarithmic', { ...base, logarithmicDepthBuffer: true } );
	const entries = [ normal, reversed, logarithmic ];

	assert.equal( selectReplayPostprocessAuxEntry( entries, base ), normal );
	assert.equal( selectReplayPostprocessAuxEntry( entries, { ...base, reversedDepthBuffer: true } ), reversed );
	assert.equal( selectReplayPostprocessAuxEntry( entries, { ...base, logarithmicDepthBuffer: true } ), logarithmic );
	assert.equal(
		selectReplayPostprocessAuxEntry( [ normal, entry( 'normal-duplicate', base ) ], base ),
		null,
		'ambiguous graph captures must not be guessed from renderer metadata alone',
	);
	assert.equal(
		selectReplayPostprocessAuxEntry(
			[ normal, entry( 'normal-duplicate', base ) ],
			{ ...base, configHash: 'normal' },
		),
		normal,
		'an authored aux binding disambiguates equivalent automatic captures by exact generated hash',
	);
	assert.equal(
		selectReplayPostprocessAuxEntry( entries, { ...base, configHash: 'reversed' } ),
		null,
		'a bound capture must still match the active renderer pipeline metadata',
	);
	assert.equal( selectReplayPostprocessAuxEntry( entries, { ...base, toneMapping: 4 } ), null );

} );

test( 'run-e2e delegates replay generation through an explicit fingerprinted module boundary', () => {

	assert.match(
		runnerSource,
		/import \{ slimWebgpuReplayModule \} from '\.\/e2e-slim-replay-module\.mjs';/,
	);
	assert.ok(
		harnessSourceFiles.includes( fileURLToPath( new URL( '../e2e-slim-replay-module.mjs', import.meta.url ) ) ),
		'the recursive evidence fingerprint must bind the replay module boundary',
	);
	assert.match( runnerSource, /slimWebgpuReplayModule\( \{\s*nodeMaterialExports: NODE_MATERIAL_EXPORTS,/ );
	assert.doesNotMatch( runnerSource, /function slimWebgpuReplayModule/ );
	assert.doesNotMatch( runnerSource, /function __prepareSceneForReplay/ );
	assert.match(
		factorySource,
		/export function slimWebgpuReplayModule\( \{\s*nodeMaterialExports: NODE_MATERIAL_EXPORTS,[\s\S]*slimHashOptions: SLIM_HASH_OPTS,/,
	);
	assert.doesNotMatch( factorySource, /\bprocess\./ );

} );

test( 'pass-target retargeting considers custom marker artifacts with captured material classes', () => {

	const start = factorySource.indexOf( 'function __artifactSourceClassNameForPassTarget(' );
	const end = factorySource.indexOf( 'function __makePassTargetMaterial(', start );
	assert.ok( start >= 0 && end > start, 'expected the pass-target artifact selector' );

	const scored = [];
	const data = {
		user: {
			'postprocessing-debug-gtao-floor': {
				artifact: {
					sourceMaterial: { type: 'MeshStandardNodeMaterial' },
					targetCount: 2,
					topology: 'mrt',
					score: 140,
				},
			},
			'fixture:MeshStandardNodeMaterial:1:mrt': {
				artifact: {
					targetCount: 2,
					topology: 'mrt',
					score: 80,
				},
			},
			'fixture:MeshStandardNodeMaterial:2:color': {
				artifact: {
					targetCount: 1,
					topology: 'color',
					score: 900,
				},
			},
			'custom-wrong-topology': {
				artifact: {
					sourceMaterial: { type: 'MeshStandardNodeMaterial' },
					targetCount: 2,
					topology: 'color',
					score: 900,
				},
			},
			'fixture:MeshStandardNodeMaterial:3:mrt': {
				artifact: {
					sourceMaterial: { type: 'LineBasicNodeMaterial' },
					targetCount: 2,
					topology: 'mrt',
					score: 900,
				},
			},
		},
	};
	const findBest = Function(
		'__data',
		'__classNameFromArtifactName',
		'__classNameForMaterial',
		'__materialFamilyFromClassName',
		'__artifactSupportsPassTarget',
		'__scoreArtifactForSource',
		`"use strict";
		${ factorySource.slice( start, end ) }
		return __findBestArtifactForPassTarget;`,
	)(
		data,
		( name ) => {
			const parts = String( name ).split( ':' );
			return parts.length >= 3 ? parts[ 1 ] : '';
		},
		( material ) => material.type === 'MeshStandardMaterial' ? 'MeshStandardNodeMaterial' : material.type,
		( className ) => className.startsWith( 'Mesh' ) ? 'mesh' : className.startsWith( 'Line' ) ? 'line' : null,
		( artifact, targetCount, passNode ) => artifact.targetCount === targetCount &&
			artifact.topology === ( passNode && passNode._mrt ? 'mrt' : 'color' ),
		( key, mod ) => {
			scored.push( key );
			return mod.artifact.score;
		},
	);

	assert.equal(
		findBest(
			'MeshStandardNodeMaterial',
			{ type: 'MeshStandardNodeMaterial' },
			{ isMesh: true },
			2,
			{ _mrt: { isMRTNode: true } },
		),
		'postprocessing-debug-gtao-floor',
		'the custom marker can beat an ordinary class-keyed MRT artifact',
	);
	assert.deepEqual(
		scored,
		[ 'postprocessing-debug-gtao-floor', 'fixture:MeshStandardNodeMaterial:1:mrt' ],
		'wrong output topology/count and cross-family metadata are rejected before scoring',
	);

} );

test( 'loader readiness defers presentation without dropping explicit offscreen producers', () => {

	assert.equal( shouldDeferReplayRenderForLoader( {
		renderDepth: 0,
		loaderPending: 1,
		renderTarget: null,
	} ), true, 'a pending top-level presentation frame waits for reproducible capture state' );
	assert.equal( shouldDeferReplayRenderForLoader( {
		renderDepth: 0,
		loaderPending: 1,
		renderTarget: { isCubeRenderTarget: true },
	} ), false, 'cube-camera faces render while unrelated loaders remain pending' );
	assert.equal( shouldDeferReplayRenderForLoader( {
		renderDepth: 0,
		loaderPending: 1,
		renderTarget: { isRenderTarget3D: true },
	} ), false, 'layered and other explicit targets remain productive' );
	assert.equal( shouldDeferReplayRenderForLoader( {
		renderDepth: 0,
		materialComputePresentation: true,
		loaderPending: 1,
		renderTarget: null,
	} ), false, 'the material-compute presentation escape hatch is preserved' );
	assert.equal( shouldDeferReplayRenderForLoader( {
		renderDepth: 1,
		loaderPending: 1,
		renderTarget: null,
	} ), false, 'nested draws retain their existing transaction boundary' );
	assert.equal( shouldDeferReplayRenderForLoader( {
		renderDepth: 0,
		loaderPending: 0,
		renderTarget: null,
	} ), false );

} );

test( 'loader readiness keeps temporal postprocess history out of startup frames', () => {

	assert.equal( shouldDeferReplayPostprocessForLoader( { loaderPending: 2 } ), true );
	assert.equal( shouldDeferReplayPostprocessForLoader( { loaderPending: 1 } ), true );
	assert.equal( shouldDeferReplayPostprocessForLoader( { loaderPending: 0 } ), false );

} );

test( 'late TextureNode.value assignments preserve node semantics and register the live texture once', () => {

	class TextureNode {
		constructor( value ) {

			this._value = value;

		}
		get value() {

			return this._value;

		}
		set value( value ) {

			this._value = value;

		}
	}
	const initial = { isTexture: true, uuid: 'initial' };
	const late = { isTexture: true, uuid: 'late' };
	const node = new TextureNode( initial );
	const seen = [];

	assert.equal( trackLateTextureNodeAssignments( node, ( texture ) => seen.push( texture ) ), node );
	trackLateTextureNodeAssignments( node, ( texture ) => seen.push( texture ) );
	node.value = late;

	assert.equal( node.value, late );
	assert.deepEqual( seen, [ late ], 'idempotent tracking observes only the late assignment' );

} );

test( 'late render-target texture wiring requires one renderer-owned target identity pair', () => {

	const makeTarget = ( suffix ) => {

		const target = {};
		const colorTexture = {
			isTexture: true,
			isRenderTargetTexture: true,
			uuid: `color-${ suffix }`,
			image: { width: 100, height: 100, depth: 1 },
			renderTarget: target,
		};
		const depthTexture = {
			isTexture: true,
			isDepthTexture: true,
			uuid: `depth-${ suffix }`,
			image: { width: 100, height: 100, depth: 1 },
			renderTarget: target,
		};
		target.texture = colorTexture;
		target.depthTexture = depthTexture;
		return { target, colorTexture, depthTexture };

	};
	const artifact = {
		uniformPlan: [ {
			name: 'object',
			textures: [
				{
					bindingKind: 'sampled-texture',
					source: {
						kind: 'artifact.texture',
						textureUuid: 'captured-color',
						imageWidth: 100,
						imageHeight: 100,
						imageDepth: 1,
					},
				},
				{
					bindingKind: 'sampled-texture',
					source: {
						kind: 'depth.texture',
						textureUuid: 'captured-depth',
						lightIndex: -1,
						fromMaterialGraph: true,
					},
				},
			],
		} ],
	};
	const first = makeTarget( 'first-renderer' );
	const second = makeTarget( 'second-renderer' );

	assert.equal(
		selectLateRenderTargetTexturePair( artifact, [
			first.colorTexture,
			first.depthTexture,
			second.colorTexture,
			second.depthTexture,
		] ),
		null,
		'identical live targets from two renderers fail closed before renderer ownership filtering',
	);
	assert.deepEqual(
		selectLateRenderTargetTexturePair( artifact, [ first.colorTexture, first.depthTexture ] ),
		{
			target: first.target,
			colorTexture: first.colorTexture,
			depthTexture: first.depthTexture,
			colorTextureUuid: 'captured-color',
			depthTextureUuid: 'captured-depth',
		},
	);

	const generated = slimWebgpuReplayModule( fixture );
	assert.match( runnerSource, /trackLateTextureNodeAssignments\.toString\(\)/ );
	assert.match( generated, /renderer\.backend\.has\( texture \)/ );
	assert.match( generated, /lateRenderTargetTexturePairs/ );

} );

test( 'effect replay keeps the presentation size across nested fallback renders', () => {

	assert.deepEqual(
		selectReplayEffectSize(
			{ width: 640, height: 480 },
			{ width: 1, height: 1 },
		),
		{ width: 640, height: 480 },
	);
	assert.deepEqual(
		selectReplayEffectSize(
			null,
			{ x: 1, y: 1 },
			{ x: 800, y: 600 },
		),
		{ width: 800, height: 600 },
	);
	assert.equal(
		selectReplayEffectSize( null, { width: 1, height: 480 }, { width: 0, height: 0 } ),
		null,
	);

	const generated = slimWebgpuReplayModule( fixture );
	assert.match( generated, /const presentationRenderer = slimRenderer !== fullRenderer \? slimRenderer : null;/ );
	assert.match( generated, /ssrNode\.__tslpSSRReplaySize/ );
	assert.match( generated, /const replaySize = __rememberSSRReplaySize\( ssrNode, context \);/ );
	assert.match( generated, /__computeRenderer\.initRenderTarget\( ssrNode\._ssrRenderTarget \);/ );
	assert.match( generated, /__computeRenderer\.initRenderTarget\( ssrNode\._blurRenderTarget \);/ );
	assert.match( generated, /directRTTNode\.isContextNode === true \|\| directRTTNode\.isVarNode === true/ );
	assert.match( generated, /directRTTNode = directRTTNode\.node;/ );
	assert.match( generated, /const directSSRNode = __isSSREffectNode\( directRTTNode \)/ );
	assert.match( generated, /directRTTNode\.isPassTextureNode === true && __isSSREffectNode\( directRTTNode\.passNode \)/ );
	assert.match( generated, /: __isSSREffectNode\( rttNode\.node \)/ );
	assert.match( generated, /copyTextureToTexture\( directSSRNode\._ssrRenderTarget\.texture, rttNode\.renderTarget\.texture \);/ );
	assert.match( generated, /__patchBindGroupLayoutRefresh\( r \);/ );
	assert.match( generated, /schedule\.run\(\s*ssrNode,\s*__POSTPROCESS_FRAME_ROLES\.PRODUCER,/ );
	assert.match( generated, /__computeRenderer\.__tslpCurrentRenderPipeline = this;/ );
	assert.doesNotMatch( generated, /__restartTemporalConsumerForReadyRTTInputs/ );
	assert.doesNotMatch( generated, /__temporalUpdateWithReadySeedCopy/ );
	assert.doesNotMatch( generated, /__refreshTemporalInputResourceBindings/ );

} );

test( 'nested TemporalReproject dependencies expose their authored beauty RTT producer', () => {

	const rttNode = {
		isRTTNode: true,
		renderTarget: { texture: { isTexture: true } },
		node: { isSSRNode: true },
	};
	const temporal = {
		isTemporalReprojectNode: true,
		beautyNode: rttNode,
	};
	const recurrent = {
		textureNode: {
			isPassTextureNode: true,
			passNode: temporal,
		},
	};
	assert.deepEqual( selectFrameEffectInputRTTProducers( recurrent ), [ rttNode ] );
	assert.deepEqual(
		selectFrameEffectInputRTTProducers( {
			textureNode: {
				isPassTextureNode: true,
				passNode: {
					constructor: { type: 'TemporalReprojectNode' },
					beautyNode: rttNode,
				},
			},
		} ),
		[ rttNode ],
		'the stable Three node type remains a valid discriminator when a proxy hides the marker',
	);
	assert.deepEqual(
		selectFrameEffectInputRTTProducers( temporal ),
		[],
		'only the authored Recurrent PassTexture edge can override the feedback traversal',
	);
	assert.deepEqual(
		selectFrameEffectInputRTTProducers( {
			textureNode: {
				isPassTextureNode: true,
				passNode: {
					isTemporalReprojectNode: true,
					beautyNode: { value: { isTexture: true } },
				},
			},
		} ),
		[],
		'ordinary texture inputs remain owned by their existing producer',
	);

	const generated = slimWebgpuReplayModule( fixture );
	const renderProducer = generated.indexOf( 'function __renderFrameEffectInputRTTProducersForPipeline(' );
	const renderProducerEnd = generated.indexOf( 'function __rttNodeDependsOnEffect(', renderProducer );
	assert.ok(
		renderProducer >= 0 && renderProducerEnd > renderProducer,
		'the nested RTT producer must have an owner-scheduled rendering seam',
	);
	assert.match(
		generated.slice( renderProducer, renderProducerEnd ),
		/__renderRTTNodesForPipeline\([\s\S]*__POSTPROCESS_FRAME_ROLES\.PRODUCER/,
	);
	const resolveStart = generated.indexOf( 'resolveUpdateBefore: ( dependency ) =>' );
	const resolveEnd = generated.indexOf( 'function __invokeFrameEffectUpdateBefore(', resolveStart );
	assert.ok( resolveStart >= 0 && resolveEnd > resolveStart );
	assert.doesNotMatch(
		generated.slice( resolveStart, resolveEnd ),
		/__renderRTTNodeWithFullRenderer|__renderRTTNodesForPipeline/,
		'the nested callback must not bypass frame-owner deduplication or re-enter SSR rendering',
	);

} );

test( 'dynamic frame-effect dependencies keep their own render targets on the executing renderer', () => {

	const temporal = {
		isTemporalReprojectNode: true,
		_historyRenderTarget: { texture: { isTexture: true, name: 'history' } },
		_resolveRenderTarget: { texture: { isTexture: true, name: 'resolve' } },
	};
	const recurrent = {
		textureNode: {
			isPassTextureNode: true,
			passNode: temporal,
		},
	};
	const isFrameEffectNode = ( node ) => node && node.isTemporalReprojectNode === true;

	assert.equal(
		selectFrameEffectOwnedPassDependency( recurrent, isFrameEffectNode ),
		temporal,
		'the authored PassTexture dependency is the only nested full-renderer owner',
	);
	assert.equal(
		selectFrameEffectOwnedPassDependency( {
			textureNode: { isPassTextureNode: true, passNode: { isPassNode: true } },
		}, isFrameEffectNode ),
		null,
		'an ordinary pass producer remains a presentation-renderer input',
	);
	assert.equal(
		selectFrameEffectOwnedPassDependency( temporal, isFrameEffectNode ),
		null,
		'frame effects without an authored PassTexture dependency keep their existing ownership',
	);

	const generated = slimWebgpuReplayModule( fixture );
	const renderStart = generated.indexOf( 'function __renderFrameEffectNodeWithFullRenderer(' );
	const renderEnd = generated.indexOf( 'function __renderFrameEffectNodesForPipeline(', renderStart );
	assert.ok( renderStart >= 0 && renderEnd > renderStart );
	const renderSource = generated.slice( renderStart, renderEnd );
	assert.match(
		renderSource,
		/__shareGraphTexturesBetweenRenderers\( fullRenderer, slimRenderer, node, \{\s*skipOwnedRenderTargets: true,\s*skipTextures: nestedFullOwnedTextures,/,
		'nested outputs are excluded from the slim-to-full input share',
	);
	assert.match(
		renderSource,
		/else runUpdate\(\);\s*if \( ! useSlimEffectReplay \) \{\s*for \( const texture of nestedFullOwnedTextures \) \{\s*__shareGPUTextureEntry\( slimRenderer, fullRenderer, texture, \{ bumpVersion: false \} \);/,
		'completed updates publish nested outputs full-to-slim without mutating their logical version',
	);
	assert.doesNotMatch(
		renderSource.slice( 0, renderSource.indexOf( 'else runUpdate();' ) ),
		/__shareGPUTextureEntry\( slimRenderer, fullRenderer, texture, \{ bumpVersion: false \} \)/,
		'a failed update cannot publish a nested output',
	);

} );

test( 'reverse graph sharing preserves a borrowed shadow render target as one resource', () => {

	const generated = slimWebgpuReplayModule( fixture );
	const shareStart = generated.indexOf( 'function __shareGraphTexturesBetweenRenderers(' );
	const shareEnd = generated.indexOf( 'function __probeFrameEffectTextureAsync(', shareStart );
	assert.ok( shareStart >= 0 && shareEnd > shareStart, 'expected the generic graph-sharing helper' );

	const makeDataMap = () => {

		const entries = new WeakMap();
		return {
			get( key ) {

				let entry = entries.get( key );
				if ( ! entry ) {

					entry = {};
					entries.set( key, entry );

				}
				return entry;

			},
			has( key ) {

				return entries.has( key );

			},
		};

	};
	const makeRenderer = () => ( {
		backend: makeDataMap(),
		_textures: makeDataMap(),
	} );
	const color = { isTexture: true, isRenderTargetTexture: true, name: 'ShadowMap', version: 0 };
	const depth = { isTexture: true, isDepthTexture: true, name: 'ShadowDepthTexture', version: 5 };
	const renderTarget = { textures: [ color ], texture: color, depthTexture: depth };
	color.renderTarget = renderTarget;
	depth.renderTarget = renderTarget;

	const slimRenderer = makeRenderer();
	const fullRenderer = makeRenderer();
	const authoritativeDepthGPU = { id: 'populated-full-shadow-depth' };
	const slimDepthData = slimRenderer.backend.get( depth );
	slimDepthData.texture = authoritativeDepthGPU;
	slimDepthData.__tslpSharedShadowGPUTexture = authoritativeDepthGPU;
	const slimDepthTextureData = slimRenderer._textures.get( depth );
	slimDepthTextureData.initialized = true;
	slimDepthTextureData.version = depth.version;
	slimDepthTextureData.generation = depth.version;
	slimDepthTextureData.bindGroups = new Set();

	let initRenderTargetCalls = 0;
	slimRenderer.initRenderTarget = () => {

		initRenderTargetCalls ++;
		slimDepthData.texture = { id: 'blank-slim-shadow-depth' };
		slimRenderer.backend.get( color ).texture = { id: 'blank-slim-shadow-color' };

	};
	let genericShareCalls = 0;
	const genericShare = ( ...args ) => {

		genericShareCalls ++;
		return shareGPUTextureEntry( ...args );

	};
	const shareGraphTextures = Function(
		'__collectGraphTexturesByName',
		'__collectDirectOwnedRenderTargetTextures',
		'__collectOwnedRenderTargetTextures',
		'__sharedIsBorrowedShadowRenderTargetTexture',
		'__shareGPUTextureEntry',
		`"use strict";\n${ generated.slice( shareStart, shareEnd ) }\nreturn __shareGraphTexturesBetweenRenderers;`,
	)(
		() => new Map( [ [ 'ShadowMap', [ color ] ] ] ),
		() => new Set(),
		() => new Set(),
		isBorrowedShadowRenderTargetTexture,
		genericShare,
	);

	shareGraphTextures( fullRenderer, slimRenderer, {}, {} );

	assert.equal( initRenderTargetCalls, 0, 'reverse sharing must not initialize the borrowed target' );
	assert.equal( genericShareCalls, 0, 'the borrowed attachment must not reach generic texture sharing' );
	assert.equal( slimRenderer.backend.get( depth ).texture, authoritativeDepthGPU );
	assert.equal( slimRenderer.backend.get( depth ).__tslpSharedShadowGPUTexture, authoritativeDepthGPU );

} );

test( 'nested SSR producers reuse the pipeline frame schedule', () => {

	const generated = slimWebgpuReplayModule( fixture );
	const ssrStart = generated.indexOf( 'function __renderSSRNodeWithFullRenderer(' );
	const ssrEnd = generated.indexOf( 'function __patchSSRNodeUpdateBefore(', ssrStart );
	assert.ok( ssrStart >= 0 && ssrEnd > ssrStart );
	assert.match(
		generated.slice( ssrStart, ssrEnd ),
		/const activeSchedule = slimRenderer && slimRenderer\.__tslpCurrentPostprocessFrameSchedule[\s\S]*activeSchedule\.run\(\s*ssrNode,\s*__POSTPROCESS_FRAME_ROLES\.PRODUCER,/,
		'every nested RTT/material path must reuse the one active SSR producer claim',
	);

	const waveStart = generated.indexOf( 'const frameSchedule = this.__tslpPostprocessFrameScheduler.begin(' );
	const waveEnd = generated.indexOf( 'context.onBeforeRenderPipeline = replayBeforeRenderPipeline;', waveStart );
	assert.ok( waveStart >= 0 && waveEnd > waveStart );
	const wave = generated.slice( waveStart, waveEnd );
	assert.match( wave, /this\.renderer\.__tslpCurrentPostprocessFrameSchedule = frameSchedule;/ );
	assert.match( wave, /__computeRenderer\.__tslpCurrentPostprocessFrameSchedule = frameSchedule;/ );
	assert.match( wave, /this\.renderer\.__tslpCurrentPostprocessFrameSchedule = previousPresentationSchedule;/ );
	assert.match( wave, /__computeRenderer\.__tslpCurrentPostprocessFrameSchedule = previousFallbackSchedule;/ );

} );

test( 'RTT fragment identity transitions rebuild once without effect-specific knowledge', () => {

	const authored = { name: 'authored-generic-node' };
	const authoredContext = { node: authored, context: 'render-output' };
	const prepared = { name: 'prepared-generic-node' };
	const preparedContext = { node: prepared, context: 'shared' };
	const material = { fragmentNode: null, needsUpdate: false };

	assert.equal( refreshRTTMaterialFragmentIdentity( material, authored, authoredContext ), true );
	assert.equal( material.fragmentNode, authoredContext );
	material.needsUpdate = false;
	assert.equal(
		refreshRTTMaterialFragmentIdentity( material, authored, { node: authored, context: 'new-wrapper' } ),
		false,
		'an unchanged identity must not rebuild merely because a context wrapper can be recreated',
	);
	assert.equal( material.fragmentNode, authoredContext );
	assert.equal( material.needsUpdate, false );

	assert.equal( refreshRTTMaterialFragmentIdentity( material, prepared, preparedContext ), true );
	assert.equal( material.fragmentNode, preparedContext );
	assert.equal( material.needsUpdate, true );
	material.needsUpdate = false;
	assert.equal( refreshRTTMaterialFragmentIdentity( material, prepared, preparedContext ), false );
	assert.equal( material.needsUpdate, false );

} );

test( 'hidden Temporal dependencies prepare before hook capture and retain lazy fallback', () => {

	const generated = slimWebgpuReplayModule( fixture );
	const helperStart = generated.indexOf( 'function __prepareHiddenFrameEffectDependenciesForReplay(' );
	const helperEnd = generated.indexOf( 'function __isTAAUFrameEffectNode(', helperStart );
	assert.ok( helperStart >= 0 && helperEnd > helperStart, 'expected eager hidden-effect preparation helper' );
	const prepareHidden = Function(
		'__selectFrameEffectOwnedPassDependency',
		'__isFrameEffectNode',
		'__frameEffectInputRTTProducers',
		'__prepareRTTNodeForReplay',
		'__prepareFrameEffectNodeForReplay',
		`"use strict";\n${ generated.slice( helperStart, helperEnd ) }\nreturn __prepareHiddenFrameEffectDependenciesForReplay;`,
	)(
		selectFrameEffectOwnedPassDependency,
		( node ) => node && node.isFrameEffectNode === true,
		selectFrameEffectInputRTTProducers,
		( rttNode ) => {
			if ( rttNode.ready === true ) return true;
			rttNode.ready = true;
			rttNode.setupCount ++;
			return true;
		},
		( effectNode, _renderer, context ) => {
			if ( effectNode.ready === true ) return true;
			effectNode.ready = true;
			effectNode.setupCount ++;
			effectNode.setup( { context } );
			return true;
		},
	);
	const beautyRTT = {
		isRTTNode: true,
		renderTarget: {},
		node: {},
		ready: false,
		setupCount: 0,
	};
	const hiddenTemporal = {
		isFrameEffectNode: true,
		isTemporalReprojectNode: true,
		beautyNode: beautyRTT,
		ready: false,
		setupCount: 0,
		setup( builder ) {
			builder.context.onBeforeRenderPipeline = () => 'hidden-temporal-view-offset';
		},
	};
	const recurrent = {
		isFrameEffectNode: true,
		textureNode: {
			isPassTextureNode: true,
			passNode: hiddenTemporal,
		},
	};
	const context = { onBeforeRenderPipeline: null };

	prepareHidden( [ recurrent ], {}, context );
	const capturedHook = context.onBeforeRenderPipeline;
	context.onBeforeRenderPipeline = () => 'replay-scheduler';
	prepareHidden( [ recurrent ], {}, context );

	assert.equal( capturedHook(), 'hidden-temporal-view-offset', 'no-TRAA hook exists before replay owns the context slot' );
	assert.equal( hiddenTemporal.setupCount, 1, 'the hidden Temporal dependency sets up once' );
	assert.equal( beautyRTT.setupCount, 1, 'its authored beauty RTT producer sets up once' );

	const pipelineStart = generated.indexOf( 'export class RenderPipeline extends Slim.RenderPipeline {' );
	const pipelineEnd = generated.indexOf( 'export class PostProcessing extends RenderPipeline {}', pipelineStart );
	const pipeline = generated.slice( pipelineStart, pipelineEnd );
	const topLevelPrep = pipeline.indexOf( 'for ( const node of effectNodes ) __prepareFrameEffectNodeForReplay(' );
	const hiddenPrep = pipeline.indexOf( '__prepareHiddenFrameEffectDependenciesForReplay(', topLevelPrep );
	const bloomPrep = pipeline.indexOf( '__prepareBloomNodeForReplay( node, context );', hiddenPrep );
	const hookCapture = pipeline.indexOf( 'const effectBeforeRenderPipeline = context.onBeforeRenderPipeline;', hiddenPrep );
	assert.ok(
		topLevelPrep >= 0 && topLevelPrep < hiddenPrep && hiddenPrep < bloomPrep && bloomPrep < hookCapture,
		'hidden dependencies prepare after top-level effects and before Bloom/TRAA setup and hook capture',
	);

	const resolverStart = generated.indexOf( 'resolveUpdateBefore: ( dependency ) => {' );
	const resolverEnd = generated.indexOf( 'const update = dependency &&', resolverStart );
	assert.match(
		generated.slice( resolverStart, resolverEnd ),
		/__prepareFrameEffectNodeForReplay\( dependency, effectRenderer, context \|\| \{\} \)/,
		'the dynamic lazy resolver remains as a fallback for unobserved dependencies',
	);

} );

test( 'compiler-free debug inspection returns the captured WGSL pair', () => {

	assert.deepEqual( capturedDebugShaderResult( {
		vertexShader: 'captured vertex',
		fragmentShader: 'captured fragment',
	} ), {
		vertexShader: 'captured vertex',
		fragmentShader: 'captured fragment',
	} );
	assert.equal( capturedDebugShaderResult( null ), null );
	assert.equal( capturedDebugShaderResult( { vertexShader: 'only vertex' } ), null );

	const generated = slimWebgpuReplayModule( fixture );
	assert.match( generated, /diagnostics\.capturedDebugShaderHits/ );
	assert.match( generated, /return Promise\.resolve\( captured \);/ );

} );

test( 'equivalent duplicate background captures select one exact fallback hash', () => {

	const start = factorySource.indexOf( 'function __backgroundReplayProgramSignature(' );
	const end = factorySource.indexOf( 'const __backgroundEquivalentFallbackHash', start );
	assert.ok( start >= 0 && end > start, 'expected the background equivalence helpers' );
	const helpers = Function(
		`"use strict";\n${ factorySource.slice( start, end ) }\nreturn { signature: __backgroundReplayProgramSignature, fallback: __equivalentBackgroundAuxFallbackHash };`,
	)();
	const program = {
		version: 1,
		materialShape: 'node-material',
		vertexShader: '@vertex fn main() {}',
		fragmentShader: '@fragment fn main() {}',
		renderContextSelectors: [ '{"target":"output-intermediate"}' ],
		uniformPlan: [ { name: 'object', textures: [ { source: { kind: 'artifact.texture', textureUuid: 'pmrem' } } ] } ],
	};
	const first = {
		shape: 'background',
		configHash: 'named-background',
		artifact: { ...program, cacheKey: 1, captureClock: 10, materialUuid: 'capture-a', userMaterialUuid: 'author-a' },
	};
	const duplicate = {
		shape: 'background',
		configHash: 'automatic-background',
		artifact: { ...program, cacheKey: 2, captureClock: 20, materialUuid: 'capture-b', userMaterialUuid: 'author-b' },
	};

	assert.equal( helpers.signature( first.artifact ), helpers.signature( duplicate.artifact ) );
	assert.equal(
		helpers.fallback( [ first, duplicate ] ),
		'named-background',
		'capture-instance identity cannot make the same background program ambiguous',
	);
	assert.equal(
		helpers.fallback( [
			first,
			{ ...duplicate, artifact: { ...duplicate.artifact, fragmentShader: '@fragment fn changed() {}' } },
		] ),
		null,
		'a genuinely different executable background remains ambiguous',
	);

} );

test( 'full-renderer PMREM scene cloning recognizes NodeMaterial families', () => {

	const start = factorySource.indexOf( 'function __makeFullPMREMMaterial(' );
	const end = factorySource.indexOf( 'function __makeFullSceneForPMREM(', start );
	assert.ok( start >= 0 && end > start, 'expected the full-renderer PMREM material helper' );
	const makeMaterial = Function(
		`"use strict";\n${ factorySource.slice( start, end ) }\nreturn __makeFullPMREMMaterial;`,
	)();
	class Basic {
		constructor() {
			this.kind = 'basic';
			this.color = { copy() {} };
		}
	}
	class Standard extends Basic {
		constructor() {
			super();
			this.kind = 'standard';
			this.emissive = { copy() {} };
		}
	}
	class Physical extends Standard {
		constructor() {
			super();
			this.kind = 'physical';
		}
	}
	class Lambert extends Basic {
		constructor() {
			super();
			this.kind = 'lambert';
		}
	}
	const Three = {
		MeshBasicMaterial: Basic,
		MeshStandardMaterial: Standard,
		MeshPhysicalMaterial: Physical,
		MeshLambertMaterial: Lambert,
	};

	assert.equal(
		makeMaterial( Three, { isMeshBasicNodeMaterial: true, color: {} }, new Set() ).kind,
		'basic',
	);
	assert.equal(
		makeMaterial( Three, { isMeshLambertNodeMaterial: true, color: {} }, new Set() ).kind,
		'lambert',
	);
	assert.equal(
		makeMaterial( Three, {
			isMeshStandardMaterial: true,
			isMeshPhysicalNodeMaterial: true,
			color: {},
			emissive: {},
		}, new Set() ).kind,
		'physical',
		'physical NodeMaterials keep the more specific full-renderer family',
	);

} );
