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

/** Module augmentation: adds the dynamically-installed `.precompile(name)` method to three.js `Material`. */
declare module 'three' {
	interface Material {
		/**
		 * Mark this material for AOT precompilation. In dev, calling this
		 * runs the TSL extractor on the live material and POSTs the
		 * captured artifact to the plugin's dev-server endpoint. In production
		 * builds, the call is rewritten away by `vite-plugin-tsl-precompile`.
		 */
		precompile( name: string ): this;
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
	/** Capture aux artifacts (background, PMREM, etc.). No-op unless `aux` was truthy. */
	captureAux: () => Promise<unknown[]>;
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
export function setDevRenderer( renderer: unknown ): void;
export function clearDevRenderer(): void;

// ---------- Apply (used by the plugin's build-time rewrite) ----------

/** Injected by the plugin's Babel transform at build time. Not called by app code. */
export function __applyPrecompiled( material: unknown, artifactModule: unknown, expectedHash: string ): unknown;

// ---------- Artifact loader ----------

export function registerArtifact( name: string, artifact: unknown ): void;
export function getArtifact( name: string ): unknown;
export function listUserArtifacts(): string[];

// ---------- Material classes ----------

export const PrecompiledMaterial: new ( ...args: unknown[] ) => unknown;
export const PrecompiledComputeNode: new ( ...args: unknown[] ) => unknown;

// ---------- Precompiled artifact registry (vendor) ----------

export function registerPrecompiledArtifact( key: string, artifact: unknown ): void;
export function registerPrecompiledArtifacts( entries: Iterable<[ string, unknown ]> ): void;
export function unregisterPrecompiledArtifacts(): void;
export function getShadowArtifact( key: string ): unknown;
export function getPipelineArtifact( key: string ): unknown;
export function getOutputArtifact( key: string ): unknown;
export function dumpPrecompiledRegistry(): Record<string, unknown>;

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

export function hashNodeGraph( graph: unknown ): Promise<string>;
export function hashNodeGraphSync( graph: unknown ): string;
export function hashPlainConfigSync( config: unknown ): string;
export function normalizeMaterialGraph( graph: unknown ): unknown;
export function hashMaterialSync( material: unknown ): string;
export function hashArtifactContentSync( artifact: unknown ): string;

// ---------- Aux (background, PMREM, postprocessing) ----------

export function precompileAuxiliary(
	renderer: unknown,
	scene: unknown,
	camera: unknown,
	opts?: Record<string, unknown>,
): Promise<unknown[]>;
export function registerAuxArtifact( entry: unknown ): void;
export function registerAuxArtifacts( entries: Iterable<unknown> ): void;
export function loadAux( shape: string, configHash: string ): unknown;
export function hasAux( shape: string, configHash: string ): boolean;
export function listAux(): unknown[];
export function findAux( predicate: ( entry: unknown ) => boolean ): unknown;
export function bindAuxConfig( config: unknown ): unknown;
export function bindAuxByName( name: string ): unknown;
export function attachArtifactTextureRefs( artifact: unknown, refs: unknown ): void;
export function __resetAuxRegistryForTests(): void;

// ---------- Hydrator ----------

export function hydrateNodeBuilderState( state: unknown, artifact: unknown ): unknown;
export function registerLiveTexture( key: string, texture: unknown ): void;
export function clearLiveTextureIndex(): void;
export function getTextureResolutionDebugHook(): ( ...args: unknown[] ) => void;
export function setTextureResolutionDebugHook( hook: ( ...args: unknown[] ) => void ): void;
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
export function attachTextureRefsWhere( artifact: unknown, texture: unknown, predicate: ( source: Record<string, unknown>, entry: Record<string, unknown>, group: Record<string, unknown> ) => boolean ): boolean;
export function attachArtifactTextureRefsWhere( artifact: unknown, texture: unknown, predicate: ( source: Record<string, unknown>, entry: Record<string, unknown>, group: Record<string, unknown> ) => boolean ): boolean;
export type ComputeSyncStats = {
	texturesShared: number;
	buffersAdopted: number;
	buffersCopied: number;
};
export function getComputeBindGroups( computeNode: unknown, fullRenderer: unknown ): unknown[];
export function computeNodeUsesStorageTexture( computeNode: unknown, fullRenderer: unknown ): boolean;
export function syncComputeStorageOutputs( computeNode: unknown, fullRenderer: unknown, slimRenderer: unknown, opts?: Record<string, unknown> ): ComputeSyncStats;
export function createFullRendererFallback( opts: Record<string, unknown> ): {
	getRenderer: () => Promise<unknown | null>;
	getModule: () => unknown | null;
	isInitialised: () => boolean;
	dispose: () => void;
};
export function createSlimSceneSupport( opts: Record<string, unknown> ): {
	liveSceneIndex: unknown;
	pmrem: unknown;
	fallback: unknown;
	diagnostics: Record<string, unknown>;
	indexScene: ( scene: unknown ) => void;
	rememberLiveTexture: ( texture: unknown ) => void;
	getFullRenderer: () => Promise<unknown | null>;
	ensureFallback: () => Promise<void>;
	generatePMREMAsync: ( sourceTexture: unknown, generator?: ( renderer: unknown, sourceTexture: unknown ) => Promise<unknown> | unknown ) => Promise<unknown | null>;
	setPMREMGenerator: ( generator: ( renderer: unknown, sourceTexture: unknown ) => Promise<unknown> | unknown ) => void;
	syncComputeOutputs: ( computeNode: unknown, fullRenderer: unknown, syncOpts?: Record<string, unknown> ) => ComputeSyncStats;
	computeNodeUsesStorageTexture: ( computeNode: unknown, sourceRenderer: unknown ) => boolean;
	shareTexture: ( sourceRenderer: unknown, texture: unknown ) => boolean;
	shareShadowTexture: ( texture: unknown, sourceRenderer: unknown ) => boolean;
	preparePostprocess: ( prepArgs?: Record<string, unknown> ) => { effects: number; prepared: unknown[]; missed: unknown[] };
	wirePostprocess: ( wireArgs?: Record<string, unknown> ) => { effects: number; wired: unknown[]; missed: unknown[] };
	dispose: () => void;
};

export type EffectSubPass = {
	material?: unknown;
	shape: string;
	config?: Record<string, unknown>;
};
export type EffectHandler = {
	name: string;
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
export function collectEffectNodes( root: unknown, opts?: { depthCap?: number } ): EffectNodeMatch[];
export function preparePrecompiledPostprocess( args: PreparePrecompiledPostprocessArgs ): PreparePrecompiledPostprocessResult;
export function prepareEffectNodeForReplay( handler: EffectHandler, node: unknown, opts: PrepareEffectNodeForReplayOptions ): PrepareEffectNodeForReplayResult;
export function makePrecompiledAuxMaterial( shape: string, sourceMaterial: unknown, opts: PrepareEffectNodeForReplayOptions ): unknown | null;
export function cloneAuxArtifact<T = unknown>( artifact: T ): T;
export function wireLiveNodeSidecarsToArtifact( artifact: unknown, sourceMaterial: unknown, replacement?: unknown ): LiveSidecarWireStats;

// ---------- Material variants ----------

export const MaterialVariantSet: new ( ...args: unknown[] ) => unknown;
export function createMaterialVariants( base: unknown, variants: unknown ): unknown;
export function applyMaterialVariant( material: unknown, variant: unknown ): unknown;
