/**
 * `@tsl-precompile/runtime` — runtime helpers for `vite-plugin-tsl-precompile`.
 *
 * The plugin's Babel transform rewrites every `material.precompile('name')` call
 * site at build time, so most exports here are only used in dev. The public API
 * surface a typical app needs is:
 *
 *   - `setupPrecompile({ three, renderer })` — one-call dev wiring (recommended).
 *   - `installPrecompileMarker(three, opts?)` + `setDevRenderer(renderer)` —
 *     manual wiring, for apps that need fine-grained control.
 *
 * Everything else is for power users (custom artifact loaders, aux passes,
 * material variants, slim-support helpers, etc.).
 */

export interface PrecompileCaptureContext {
	/** Scene used to build render-context-dependent shader state (lights, fog, shadows, clipping, MRT). */
	scene?: unknown;
	/** Camera used for capture. */
	camera?: unknown;
	/** Object that owns the material during capture. */
	object?: unknown;
}

/** Module augmentation: adds the dynamically-installed `.precompile(name, context?)` method to three.js `Material`. */
declare module 'three' {
	interface Material {
		/**
		 * Mark this material for AOT precompilation. In dev, calling this
		 * runs the TSL extractor on the live material and POSTs the
		 * captured artifact to the plugin's dev-server endpoint. In production
		 * builds, the call is rewritten away by `vite-plugin-tsl-precompile`.
		 */
		precompile( name: string, context?: PrecompileCaptureContext ): this;
	}
}

// ---------- setupPrecompile (recommended entry) ----------

export interface SetupPrecompileOptions {
	/** The `three/webgpu` namespace, e.g. `import * as THREE from 'three/webgpu'`. Required outside slim mode. */
	three: unknown;
	/** The `WebGPURenderer` instance. May be passed before or after `init()`. */
	renderer: unknown;
	/** Custom dev-capture endpoint. Default: `'/__tsl-precompile/capture'`. */
	devEndpoint?: string;
	/** `true` exposes `captureAux()`; an object is forwarded as extra opts to `precompileAuxiliary`. */
	aux?: boolean | Record<string, unknown>;
	/** Required only when `aux` is truthy. */
	scene?: unknown;
	/** Required only when `aux` is truthy. */
	camera?: unknown;
}

export interface SetupPrecompileResult {
	/** Resolves once the marker is installed and the dev renderer is registered. */
	ready: Promise<void>;
	/** Capture aux artifacts (background, PMREM, MRT pass nodes, etc.). No-op unless `aux` was truthy. */
	captureAux: ( extraOpts?: Record<string, unknown> ) => Promise<unknown[]>;
	/** Swap the dev renderer (useful when the renderer is recreated). */
	setRenderer: ( renderer: unknown ) => void;
}

/** One-call wiring for `.precompile()` dev capture. Idempotent and slim-mode-safe. */
export function setupPrecompile( opts: SetupPrecompileOptions ): SetupPrecompileResult;

// ---------- Marker (manual wiring) ----------

export interface InstallPrecompileMarkerOptions {
	/** Custom dev-capture endpoint. Default: `'/__tsl-precompile/capture'`. */
	devEndpoint?: string;
}

export function installPrecompileMarker( three: unknown, opts?: InstallPrecompileMarkerOptions ): void;
export function setDevRenderer( renderer: unknown, three?: unknown ): void;
export function clearDevRenderer(): void;

// ---------- Apply (used by the plugin's build-time rewrite) ----------

/** Injected by the plugin's Babel transform at build time. Not called by app code. */
export function __applyPrecompiled( material: unknown, artifactModule: unknown, expectedHash: string ): unknown;

// ---------- Artifact loader ----------

export interface UserArtifactEntry<TArtifactModule = unknown> {
	name: string;
	artifact: TArtifactModule;
}

export function registerArtifact<TArtifactModule = unknown>( name: string, artifactModule: TArtifactModule ): void;
export function getArtifact<TArtifactModule = unknown>( name: string ): TArtifactModule | null;
export function listUserArtifacts<TArtifactModule = unknown>(): UserArtifactEntry<TArtifactModule>[];

// ---------- Material classes ----------

export const PrecompiledMaterial: new ( ...args: unknown[] ) => unknown;
export const PrecompiledComputeNode: new ( ...args: unknown[] ) => unknown;

// ---------- Precompiled artifact registry (vendor) ----------

export interface PrecompiledArtifactRegistrationOptions {
	light?: unknown;
	pipelineKey?: string;
	outputKey?: string;
}

export interface PrecompiledRegistrySnapshot {
	defaultShadow: unknown | null;
	defaultPipeline: unknown | null;
	defaultOutput: unknown | null;
	pipelineKeys: string[];
	outputKeys: string[];
}

export function registerPrecompiledArtifact( artifact: unknown, opts?: PrecompiledArtifactRegistrationOptions ): void;
export function registerPrecompiledArtifacts( artifacts: unknown[] ): void;
export function unregisterPrecompiledArtifacts(): void;
export function getShadowArtifact( light?: unknown ): unknown | null;
export function getPipelineArtifact( key?: string | null ): unknown | null;
export function getOutputArtifact( key?: string | null ): unknown | null;
export function dumpPrecompiledRegistry(): PrecompiledRegistrySnapshot;

// ---------- UBO writers ----------

export function writeF32( view: DataView, byteOffset: number, value: number ): void;
export function writeI32( view: DataView, byteOffset: number, value: number ): void;
export function writeU32( view: DataView, byteOffset: number, value: number ): void;
export function writeVec2( view: DataView, byteOffset: number, value: { x: number; y: number } ): void;
export function writeVec3( view: DataView, byteOffset: number, value: { x: number; y: number; z: number } ): void;
export function writeVec4( view: DataView, byteOffset: number, value: { x: number; y: number; z: number; w: number } ): void;
export function writeColor( view: DataView, byteOffset: number, value: { r: number; g: number; b: number } ): void;
export function writeColorRGBA( view: DataView, byteOffset: number, color: { r: number; g: number; b: number }, alpha: number ): void;
export function writeMat3( view: DataView, byteOffset: number, mat: { elements: ArrayLike<number> } ): void;
export function writeMat4( view: DataView, byteOffset: number, mat: { elements: ArrayLike<number> } ): void;
export function writeMat4FromEuler( view: DataView, byteOffset: number, euler: unknown, background: unknown ): void;
export function writeBytes( view: DataView, byteOffset: number, source: ArrayBufferView, sourceByteOffset: number, byteLength: number ): void;

// ---------- Hashing helpers ----------

export interface HashVersionOptions {
	shape: string;
	threeVersion: string;
	pluginVersion: string;
}

export interface MaterialHashOptions {
	name: string;
	threeVersion: string;
	/** Backward-compatible spelling for the artifact toolchain version. */
	pluginVersion?: string;
	toolchainVersion?: string;
	renderContextSignature?: string | Record<string, unknown>;
}

export function hashNodeGraph( graph: unknown, opts: HashVersionOptions ): Promise<string>;
export function hashNodeGraphSync( graph: unknown, opts: HashVersionOptions ): string;
export function hashPlainConfigSync( config: unknown, opts: HashVersionOptions ): string;
export function normalizeMaterialGraph( graph: unknown ): unknown;
export function hashMaterialSync( material: unknown, opts: MaterialHashOptions ): string;
export function hashArtifactContentSync( artifact: unknown, opts: HashVersionOptions ): string;

// ---------- Aux (background, PMREM, postprocessing) ----------

export interface AuxCaptureOptions extends Record<string, unknown> {
	devEndpoint?: string;
	postProcessing?: unknown;
	three?: unknown;
	threeVersion?: string;
	pluginVersion?: string;
}

export interface AuxCaptureResult {
	shape: string;
	configHash: string | null;
	ok: boolean;
	error?: string;
}

export interface AuxArtifactRegistration<TArtifact = unknown> {
	shape: string;
	configHash: string;
	artifact: TArtifact;
	name?: string;
}

export interface AuxArtifactSummary {
	shape: string;
	configHash: string;
	name: string | null;
}

export interface AuxArtifactEntry<TArtifact = unknown> extends AuxArtifactSummary {
	artifact: TArtifact;
}

export function precompileAuxiliary(
	renderer: unknown,
	scene: unknown,
	camera: unknown,
	opts?: AuxCaptureOptions,
): Promise<AuxCaptureResult[]>;
export function registerAuxArtifact<TArtifact = unknown>( shape: string, configHash: string, artifact: TArtifact, opts?: { name?: string } ): void;
export function registerAuxArtifacts<TArtifact = unknown>( entries: Iterable<AuxArtifactRegistration<TArtifact>> ): void;
export function loadAux<TArtifact = unknown>( shape: string, configHash: string ): TArtifact;
export function hasAux( shape: string, configHash: string ): boolean;
export function listAux(): AuxArtifactSummary[];
export function findAux<TArtifact = unknown>( shape: string, nameOrConfigHash: string ): AuxArtifactEntry<TArtifact> | null;
export function bindAuxConfig<TNode = unknown>( node: TNode, shapeOrEntry: string | Pick<AuxArtifactSummary, 'shape' | 'configHash'>, configHash?: string ): TNode;
export function bindAuxByName<TNode = unknown>( node: TNode, shape: string, nameOrConfigHash: string ): TNode;
export function attachArtifactTextureRefs<TArtifact = unknown>( artifact: TArtifact, texture: unknown ): TArtifact;
export function attachPostprocessTextureRefs<TArtifact = unknown>( artifact: TArtifact, outputNode: unknown ): TArtifact;
export function attachPostprocessUpdateBeforeNodes<TArtifact = unknown>( artifact: TArtifact, outputNode: unknown ): TArtifact;
export function attachPostprocessObject3DTargets<TMaterial = unknown>( material: TMaterial, outputNode: unknown ): TMaterial;
export function __resetAuxRegistryForTests(): void;

// ---------- Hydrator ----------

export interface HydrateVariantSelection {
	/** Legacy Three cache key; used only for unsigned artifacts. */
	cacheKey?: number | string | null;
	/** Active Three RenderObject used to derive a stable render-topology selector. */
	renderObject?: unknown;
	/** Precomputed canonical selector for non-Three integrations and tests. */
	renderContextSelector?: string | null;
	/** Optional material override for MRT attachment-count compatibility. */
	material?: unknown;
}

export function hydrateNodeBuilderState(
	artifact: unknown,
	material?: unknown,
	object?: unknown,
	variantSelection?: number | string | HydrateVariantSelection | null,
): unknown;
export function registerLiveTexture( texture: unknown ): void;
export function installTextureLoaderTracking( loaders: unknown, opts?: { onTextureLoad?: ( texture: unknown, info: unknown ) => void } ): number;
export function clearLiveTextureIndex(): void;
export type TextureResolutionDebugHook = ( event: unknown ) => void;
export function getTextureResolutionDebugHook(): TextureResolutionDebugHook | null;
export function setTextureResolutionDebugHook( hook: TextureResolutionDebugHook | null | undefined ): TextureResolutionDebugHook | null;
export function getDFGLUT(): unknown;

// ---------- Slim-support helpers ----------

export function createLiveSceneIndex( opts?: Record<string, unknown> ): unknown;
export function collectMaterialNodeTextures( material: unknown ): unknown[];
export function textureImageReady( texture: unknown ): boolean;
export function textureImageSrc( texture: unknown ): string | null;
export function healTextureImage( texture: unknown ): void;

export const PMREM_CUBE_UV_MAPPING: number;
export function isCubeTextureSource( texture: unknown ): boolean;
export function isEnvironmentTextureSource( texture: unknown ): boolean;
export function isPMREMTexture( texture: unknown ): boolean;
export function isPMREMArtifactTextureSource( source: unknown ): boolean;
export function artifactNeedsPMREM( artifact: unknown ): boolean;
export function artifactPMREMSourceUuids( artifact: unknown ): string[];
export function attachPMREMRefsByOrder( artifact: unknown, refs: unknown ): void;
export function collectPMREMSourceTexturesInNode( node: unknown, opts?: Record<string, unknown>, out?: unknown[], depth?: number, seen?: Set<unknown> ): unknown[];
export function collectPMREMSourceTexturesFromMaterial( material: unknown, opts?: Record<string, unknown> ): unknown[];
export function selectPMREMTexturesForArtifact( artifact: unknown, opts?: Record<string, unknown> ): unknown[];
export function createPMREMSupport( opts?: Record<string, unknown> ): unknown;
export function clearTextureViewCache( textureData: unknown ): void;
export function markTextureInitialized( renderer: unknown, texture: unknown ): void;
export function shareGPUTextureEntry( targetRenderer: unknown, sourceRenderer: unknown, texture: unknown, opts?: Record<string, unknown> ): boolean;
export function sharePMREMGPUTexture( slimRenderer: unknown, fullRenderer: unknown, pmrem: unknown, opts?: Record<string, unknown> ): boolean;
export function shareShadowGPUTextureIntoSlim( texture: unknown, fullRenderer: unknown, slimRenderer: unknown ): boolean;
export function textureMatchesSource( texture: unknown, source: Record<string, unknown> | null | undefined ): boolean;
export function textureMatchesArtifactSource( texture: unknown, source: Record<string, unknown> | null | undefined ): boolean;
export function artifactHasTextureSource( artifact: unknown, predicate?: ( source: Record<string, unknown>, entry: Record<string, unknown>, group: Record<string, unknown> ) => boolean ): boolean;
export function countArtifactTextureSources( artifact: unknown, predicate?: ( source: Record<string, unknown>, entry: Record<string, unknown>, group: Record<string, unknown> ) => boolean ): number;
export function singleArtifactTextureUuid( artifact: unknown, predicate?: ( source: Record<string, unknown>, entry: Record<string, unknown>, group: Record<string, unknown> ) => boolean ): string | null;
export function attachArtifactTextureRefsByShapeOrder( artifact: unknown, textures: unknown[], predicate?: ( source: Record<string, unknown>, entry: Record<string, unknown>, group: Record<string, unknown> ) => boolean, options?: { overwriteExisting?: boolean } ): number;
export function attachTextureRefsWhere( artifact: unknown, texture: unknown, predicate: ( source: Record<string, unknown>, entry: Record<string, unknown>, group: Record<string, unknown> ) => boolean ): boolean;
export function attachArtifactTextureRefsWhere( artifact: unknown, texture: unknown, predicate: ( source: Record<string, unknown>, entry: Record<string, unknown>, group: Record<string, unknown> ) => boolean ): boolean;
export type ComputeSyncStats = {
	texturesShared: number;
	buffersAdopted: number;
	buffersCopied: number;
};
export type ComputeSyncPerPassStats = ComputeSyncStats & {
	pass: number | null;
};
export type ComputeInputShareStats = {
	texturesShared: number;
	skippedStorageTextures: number;
	missingTextures: number;
};
export type SharePassRenderTargetTexturesStats = {
	texturesShared: number;
	depthShared: boolean;
};
export type RenderPassWithFallbackStats = SharePassRenderTargetTexturesStats & {
	rendered: boolean;
};
export type ShareRenderTargetTexturesStats = SharePassRenderTargetTexturesStats;
export type RenderOffscreenOverrideWithFullRendererStats = SharePassRenderTargetTexturesStats & {
	rendered: boolean;
};
export type WireTRAAResolveArtifactStats = {
	outputAttached: number;
	velocityAttached: number;
	historyAttached: number;
	depthAttached: number;
};
export type WireTRAAResolveArtifactOptions = {
	passNodes?: unknown[];
};
export type RendererLightingStats = {
	updated: boolean;
	cpuTiled: boolean;
	storageAttrs: number;
	artifactsWired: number;
	textureRefsWired: number;
};
export type RenderPassWithFallbackOptions = {
	fullRenderer?: unknown;
	camera?: unknown;
	beforeRender?: () => void;
	shareTextures?: boolean;
	shareDepth?: boolean;
	onError?: ( err: unknown, texture?: unknown ) => void;
};
export type RenderOffscreenOverrideWithFallbackOptions = {
	fullRenderer?: unknown;
	renderTarget?: unknown;
	beforeRender?: () => void;
	withSourceMaterials?: ( scene: unknown, render: () => void ) => void;
	materialMapper?: ( material: unknown ) => unknown;
	shareTextures?: boolean;
	shareDepth?: boolean;
	onError?: ( err: unknown, texture?: unknown ) => void;
};
export interface SlimRenderFallbackHandler {
	( renderObject: unknown ): unknown | null;
	release?( renderObject: unknown ): void;
}
export type PostprocessWireMiss = {
	shape: string;
	reason: string;
};
export type WiredEffectSubPass = {
	shape: string;
	name?: string;
	configHash: string;
};
export type WireRegisteredEffectNodeResult = {
	wired: WiredEffectSubPass[];
	missed: PostprocessWireMiss[];
};
export type WirePrecompiledPostprocessResult = {
	effects: number;
	wired: WiredEffectSubPass[];
	missed: PostprocessWireMiss[];
};
export function getComputeBindGroups( computeNode: unknown, fullRenderer: unknown ): unknown[];
export function computeNodeUsesStorageTexture( computeNode: unknown, fullRenderer: unknown ): boolean;
export function shareComputeSampledInputs( computeNode: unknown, fullRenderer: unknown, slimRenderer: unknown, opts?: Record<string, unknown> ): ComputeInputShareStats;
export function syncComputeStorageOutputs( computeNode: unknown, fullRenderer: unknown, slimRenderer: unknown, opts?: Record<string, unknown> ): ComputeSyncStats;
export function syncComputeStorageOutputsPerPass( computeNode: unknown, fullRenderer: unknown, slimRenderer: unknown, passIndex: number | undefined, opts?: Record<string, unknown> ): ComputeSyncPerPassStats;
export function wireArtifactStorageBuffersFromAttributes( artifact: unknown, attributes: unknown | unknown[], opts?: Record<string, unknown> ): number;
export function pingPongInvalidate( textureA: unknown, textureB: unknown, renderers: unknown | unknown[] ): boolean;
export function shareInstancedAttributeBufferIntoSlim( attribute: unknown, fullRenderer: unknown, slimRenderer: unknown ): boolean;
export function collectSceneLights( scene: unknown ): unknown[];
export function wireStorageAttributesToSceneArtifacts( scene: unknown, attributes: unknown | unknown[], opts?: Record<string, unknown> ): number;
export function wireTiledLightingTextureToScene( scene: unknown, texture: unknown, opts?: Record<string, unknown> ): number;
export function updateRendererLightingForSlim( renderer: unknown, scene: unknown, camera: unknown, opts?: Record<string, unknown> ): RendererLightingStats;
export function createFullRendererFallback( opts: Record<string, unknown> ): {
	getRenderer: () => Promise<unknown | null>;
	getModule: () => unknown | null;
	isInitialised: () => boolean;
	dispose: () => void;
};
export function setSlimRenderFallback( handler: SlimRenderFallbackHandler | null | undefined ): void;
export function getSlimRenderFallback(): SlimRenderFallbackHandler | null;
export function renderPassWithFullRenderer( args: {
	passNode: unknown;
	slimRenderer: unknown;
	fullRenderer: unknown;
	camera?: unknown;
	beforeRender?: () => void;
	onError?: ( err: unknown ) => void;
} ): boolean;
export function renderOffscreenOverrideWithFullRenderer( args: {
	scene: unknown;
	camera: unknown;
	slimRenderer: unknown;
	fullRenderer: unknown;
	renderTarget?: unknown;
	beforeRender?: () => void;
	withSourceMaterials?: ( scene: unknown, render: () => void ) => void;
	materialMapper?: ( material: unknown ) => unknown;
	shareTextures?: boolean;
	shareDepth?: boolean;
	diagnostics?: Record<string, unknown>;
	onError?: ( err: unknown, texture?: unknown ) => void;
} ): RenderOffscreenOverrideWithFullRendererStats;
export function shareRenderTargetTextures( args: {
	renderTarget: unknown;
	slimRenderer: unknown;
	fullRenderer: unknown;
	shareDepth?: boolean;
	diagnostics?: Record<string, unknown>;
	onError?: ( err: unknown, texture?: unknown ) => void;
} ): ShareRenderTargetTexturesStats;
export function sharePassRenderTargetTextures( args: {
	passNode: unknown;
	slimRenderer: unknown;
	fullRenderer: unknown;
	shareDepth?: boolean;
	diagnostics?: Record<string, unknown>;
	onError?: ( err: unknown, texture?: unknown ) => void;
} ): SharePassRenderTargetTexturesStats;
export function wirePrecompiledPostprocess( args?: {
	postProcessing?: { outputNode?: unknown };
	outputNode?: unknown;
} ): WirePrecompiledPostprocessResult;
export function collectLiveBloomNodes( root: unknown ): unknown[];
export function wireBloomNode( bloomNode: unknown, opts?: { bloomIndex?: number } ): WireRegisteredEffectNodeResult;
export function findPostprocessAux( shape: string, nameOrConfigHash: string ): unknown;
export function createSlimSceneSupport( opts: Record<string, unknown> ): {
	liveSceneIndex: unknown;
	pmrem: unknown;
	fallback: unknown;
	diagnostics: Record<string, unknown>;
	indexScene: ( scene: unknown ) => void;
	rememberLiveTexture: ( texture: unknown ) => void;
	getFullRenderer: () => Promise<unknown | null>;
	ensureFallback: () => Promise<void>;
	installComputeFallback: () => boolean;
	generatePMREMAsync: ( sourceTexture: unknown, generator?: ( renderer: unknown, sourceTexture: unknown ) => Promise<unknown> | unknown ) => Promise<unknown | null>;
	setPMREMGenerator: ( generator: ( renderer: unknown, sourceTexture: unknown ) => Promise<unknown> | unknown ) => void;
	syncComputeOutputs: ( computeNode: unknown, fullRenderer: unknown, syncOpts?: Record<string, unknown> ) => ComputeSyncStats;
	shareComputeInputs: ( computeNode: unknown, fullRenderer: unknown, shareOpts?: Record<string, unknown> ) => ComputeInputShareStats;
	syncComputeOutputsPerPass: ( computeNode: unknown, fullRenderer: unknown, passIndex: number | undefined, syncOpts?: Record<string, unknown> ) => ComputeSyncPerPassStats;
	pingPongInvalidate: ( textureA: unknown, textureB: unknown, extraRenderer?: unknown ) => boolean;
	shareInstancedAttributeBuffer: ( attribute: unknown, sourceRenderer: unknown ) => boolean;
	computeNodeUsesStorageTexture: ( computeNode: unknown, sourceRenderer: unknown ) => boolean;
	shareTexture: ( sourceRenderer: unknown, texture: unknown ) => boolean;
	shareShadowTexture: ( texture: unknown, sourceRenderer: unknown ) => boolean;
	updateRendererLighting: ( scene: unknown, camera: unknown, lightingOpts?: Record<string, unknown> ) => RendererLightingStats;
	preparePostprocess: ( prepArgs?: Record<string, unknown> ) => { effects: number; prepared: unknown[]; missed: unknown[] };
	wirePostprocess: ( wireArgs?: Record<string, unknown> ) => { effects: number; wired: unknown[]; missed: unknown[] };
	renderPassWithFallback: ( passNode: unknown, passOpts?: RenderPassWithFallbackOptions ) => Promise<RenderPassWithFallbackStats>;
	renderOffscreenOverrideWithFallback: ( scene: unknown, camera: unknown, offscreenOpts?: RenderOffscreenOverrideWithFallbackOptions ) => Promise<RenderPassWithFallbackStats>;
	pinClock: ( t: number | null | undefined ) => void;
	unpinClock: () => void;
	withTemporalFrame: <T>( options: { frameId?: number | string; time?: number; advance?: boolean }, callback: ( state: TemporalFrameState ) => T, extraRenderers?: unknown | unknown[] ) => T;
	dispose: () => void;
};
export function pinClock( t: number | null | undefined ): void;
export function unpinClock(): void;
export type TemporalFrameState = {
	frameId?: number | string;
	time: number | null;
	advance: boolean;
};
export function getTemporalFrameState( value: unknown ): TemporalFrameState | null;
export function logicalFrameKey( frame: unknown, fallback?: number | string ): number | string;
export function shouldAdvanceTemporalState( frame: unknown ): boolean;
export function withTemporalFrame<T>( renderers: unknown | unknown[], options: { frameId?: number | string; time?: number; advance?: boolean }, callback: ( state: TemporalFrameState ) => T ): T;
export type LiveNodeDependency = { node: unknown; metadata: unknown };
export function attachLiveNodeDependency<T>( owner: T, dependency: unknown, metadata?: unknown ): T;
export function getLiveNodeDependencies( owner: unknown ): LiveNodeDependency[];
export type PostprocessExecutionPlan = { mode: 'single-context-wave'; supported: boolean; producerPasses: unknown[]; contextEffects: Array<{ handler: unknown; node: unknown; producerPasses: unknown[]; consumerPasses: unknown[] }>; consumerPasses: unknown[]; terminalEffects: Array<{ handler: unknown; node: unknown }>; unplacedPasses: unknown[]; issues: string[] };
export function postprocessGraphContains( root: unknown, target: unknown, options?: { depthCap?: number } ): boolean;
export function createPostprocessExecutionPlan( options?: { passNodes?: unknown[]; outputNode?: unknown; collectEffects?: ( root: unknown ) => Array<{ handler: unknown; node: unknown }> } ): PostprocessExecutionPlan;

export type EffectSubPass = {
	material?: unknown;
	shape: string;
	config?: Record<string, unknown>;
	renderTargetHint?: Record<string, unknown> | null;
	liveUniformOverlay?: boolean;
	node?: unknown;
	[ key: string ]: unknown;
};
export type EffectHandler = {
	name: string;
	execution?: { phase: 'pass-context' | 'terminal'; getProducerPasses?: ( node: unknown ) => unknown[] };
	detect: ( node: unknown ) => boolean;
	subPasses: ( node: unknown, index: number ) => EffectSubPass[];
	forceSetup?: ( node: unknown, context?: Record<string, unknown> ) => void;
	wireSubPassUniforms?: ( subPass: EffectSubPass, sourceMaterial: unknown, opts?: Record<string, unknown> ) => void;
	wireSubPassTextures?: ( subPass: EffectSubPass, node: unknown, opts?: Record<string, unknown> ) => void;
	patchUpdateBefore?: ( node: unknown, result: { prepared: unknown[]; missed: unknown[] }, opts?: Record<string, unknown> ) => void;
};
export type EffectNodeMatch = {
	handler: EffectHandler;
	node: unknown;
};
export type PostprocessMiss = {
	shape: string;
	reason: string;
};
export type PreparedEffectSubPass = {
	handler: string;
	shape: string;
	config: Record<string, unknown> | null;
	sourceMaterial: unknown;
	replacement: unknown;
};
export type PreparePrecompiledPostprocessArgs = {
	postProcessing?: { outputNode?: unknown };
	outputNode?: unknown;
	loadAux: ( shape: string, configHash: string ) => unknown;
	PrecompiledMaterial: new ( artifact: unknown ) => unknown;
	auxConfigHash?: string;
	sharedContext?: unknown;
	renderer?: unknown;
	passNodes?: unknown[];
	diagnostics?: { byHandler?: Record<string, { prepared: number; missed: number }> } & Record<string, unknown>;
};
export type PreparePrecompiledPostprocessResult = {
	effects: number;
	prepared: PreparedEffectSubPass[];
	missed: PostprocessMiss[];
};
export type PrepareEffectNodeForReplayOptions = {
	loadAux: ( shape: string, configHash: string ) => unknown;
	PrecompiledMaterial: new ( artifact: unknown ) => unknown;
	auxConfigHash?: string;
	sharedContext?: unknown;
	renderer?: unknown;
	passNodes?: unknown[];
	effectIndex?: number;
};
export type PrepareEffectNodeForReplayResult = {
	prepared: PreparedEffectSubPass[];
	missed: PostprocessMiss[];
	alreadyPrepared: boolean;
};
export type LiveSidecarWireStats = {
	uniformsMatched: number;
	updateNodes: number;
	updateBeforeNodes: number;
	updateAfterNodes: number;
};
export function registerEffectHandler( handler: EffectHandler ): void;
export function unregisterEffectHandler( name: string ): boolean;
export function getEffectHandlers(): EffectHandler[];
export function findEffectHandler( node: unknown ): EffectHandler | null;
export function collectEffectNodes( root: unknown, opts?: { depthCap?: number; extraRoots?: unknown[] } ): EffectNodeMatch[];
export function preparePrecompiledPostprocess( args: PreparePrecompiledPostprocessArgs ): PreparePrecompiledPostprocessResult;
export function prepareEffectNodeForReplay( handler: EffectHandler, node: unknown, opts: PrepareEffectNodeForReplayOptions ): PrepareEffectNodeForReplayResult;
export function makePrecompiledAuxMaterial( shape: string, sourceMaterial: unknown, opts: PrepareEffectNodeForReplayOptions ): unknown | null;
export function cloneAuxArtifact<T = unknown>( artifact: T ): T;
export function wireLiveNodeSidecarsToArtifact( artifact: unknown, sourceMaterial: unknown, opts?: { overlay?: boolean } ): LiveSidecarWireStats;
export function artifactLooksLikeRetroPassMaterial( artifact: unknown ): boolean;
export const TRAA_RESOLVE_TEXTURE_NAME: 'TRAANode.resolve';
export const TRAA_HISTORY_TEXTURE_NAME: 'TRAANode.history';
export const TRAA_HISTORY_DEPTH_TEXTURE_NAME: 'TRAANode.history.depth';
export function nameTRAATextures( traaNode: unknown ): void;
export function collectTRAASelfTextures( traaNode: unknown ): Set<unknown>;
export function getTRAABeautyTexture( traaNode: unknown ): unknown | null;
export function getTRAAVelocityTexture( traaNode: unknown ): unknown | null;
export function getTRAACurrentDepthTexture( traaNode: unknown, passNodes?: unknown[] ): unknown | null;
export function wireTRAAResolveArtifact( artifact: unknown, traaNode: unknown, opts?: WireTRAAResolveArtifactOptions ): WireTRAAResolveArtifactStats;

/** Load the optional three.js Inspector addon in dev; resolves to null in production-like environments. */
export function loadInspectorOptional(): Promise<unknown | null>;

// ---------- Material variants ----------

export type MaterialVariantEntry<TMaterial = unknown> = readonly [ string, TMaterial ] | { name: string; material: TMaterial };
export type MaterialVariantInput<TMaterial = unknown> =
	| Readonly<Record<string, TMaterial>>
	| ReadonlyMap<string, TMaterial>
	| ReadonlyArray<MaterialVariantEntry<TMaterial>>;

export class MaterialVariantSet<TMaterial = unknown> {
	constructor( variants: MaterialVariantInput<TMaterial>, initialName?: string );
	currentName: string;
	current: TMaterial;
	names(): string[];
	has( name: string ): boolean;
	get( name?: string ): TMaterial | null;
	select( name: string, target?: unknown ): TMaterial;
	apply( target: unknown ): TMaterial;
	cycle( target?: unknown, step?: number ): TMaterial;
}

export function createMaterialVariants<TMaterial = unknown>( variants: MaterialVariantInput<TMaterial>, initialName?: string ): MaterialVariantSet<TMaterial>;
export function applyMaterialVariant<TMaterial = unknown>( target: unknown | unknown[], material: TMaterial ): TMaterial;
