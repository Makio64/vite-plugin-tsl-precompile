// VENDORED from three.js fork branch `tsl-precompile`
// Source: src/nodes/precompile/PrecompiledArtifactRegistry.js
// See packages/plugin/src/vendor/VENDORING.md for upgrade policy.
//
// Registry for precompiled auxiliary-pass artifacts.
//
// Most of the render path — scene materials, fog uniforms, compute
// kernels — hydrates itself as soon as the user hands a PrecompiledMaterial
// / PrecompiledComputeNode to the renderer. But a few call sites inside
// three.js construct `new NodeMaterial()` internally during rendering,
// independently of anything the user gives them:
//
//   * `getShadowMaterial( light )` in ShadowFilterNode — one per light.
//   * `new NodeMaterial()` inside RenderPipeline for its full-screen quad.
//   * `new NodeMaterial()` inside Renderer._renderOutput for the tone
//     mapping / color-space quad.
//
// In the slim precompiled bundle those constructors return stub
// NodeMaterials that can't build shaders. This registry lets the app
// hand compileTSL artifacts back to three.js, keyed by the role the
// artifact plays. The internal construction sites consult the registry
// before falling back to `new NodeMaterial()`.
//
// Usage:
//
//   import { registerPrecompiledArtifacts } from 'three/webgpu/precompiled';
//   const artifacts = await compileTSL( renderer, scene, camera, { … } );
//   registerPrecompiledArtifacts( artifacts );
//
// The registry is module-scoped on purpose — three.js itself has no
// renderer-instance-keyed global state for this. Callers with multiple
// renderers should partition their artifacts by calling
// `unregisterPrecompiledArtifacts()` between scenes.

/**
 * Shared-per-light shadow-depth artifact. Most apps have one
 * `getShadowMaterial()` shape — a fixed depth-only shader — and the same
 * artifact works for every directional/point/spot light. We track the
 * first one we see as the default; callers can opt into per-light
 * precompile variants via `registerShadowArtifact( light, artifact )`.
 */
let _defaultShadowArtifact = null;
let _shadowByLight = new WeakMap();

const VARIANT_FIELDS = [
	'cacheKey',
	'materialShape',
	'sourceMaterial',
	'vertexShader',
	'fragmentShader',
	'computeShader',
	'transforms',
	'attributes',
	'nodeAttributes',
	'bindings',
	'uniformPlan',
	'mrtOutputCount',
	'mrtOutputNames',
	'mrtBlendModes',
];

function variantPayload( artifact ) {

	const payload = {};
	for ( const field of VARIANT_FIELDS ) {

		if ( artifact && artifact[ field ] !== undefined ) payload[ field ] = artifact[ field ];

	}
	return payload;

}

function mergeTextureRefs( target, source ) {

	const sourceRefs = source && source._textureRefs;
	if ( ! ( sourceRefs instanceof Map ) || sourceRefs.size === 0 ) return;
	let refs = target._textureRefs instanceof Map ? new Map( target._textureRefs ) : new Map();
	let changed = false;
	for ( const [ uuid, texture ] of sourceRefs ) {

		if ( ! refs.has( uuid ) ) {

			refs.set( uuid, texture );
			changed = true;

		}

	}
	if ( ! changed ) return;
	Object.defineProperty( target, '_textureRefs', {
		value: refs,
		enumerable: false,
		configurable: true,
		writable: true,
	} );

}

function addVariant( target, artifact ) {

	if ( ! target || ! artifact || artifact.cacheKey === undefined || artifact.cacheKey === null ) return;
	const variants = target.variants && typeof target.variants === 'object' ? { ...target.variants } : {};
	variants[ String( artifact.cacheKey ) ] = variantPayload( artifact );
	Object.defineProperty( target, 'variants', {
		value: variants,
		enumerable: true,
		configurable: true,
		writable: true,
	} );
	mergeTextureRefs( target, artifact );

}

function mergeArtifactFamily( target, artifact ) {

	if ( ! target || ! artifact || target === artifact ) return target;
	addVariant( target, target );
	addVariant( target, artifact );
	if ( artifact.variants && typeof artifact.variants === 'object' ) {

		for ( const variant of Object.values( artifact.variants ) ) addVariant( target, variant );

	}
	mergeTextureRefs( target, artifact );
	return target;

}

function registerShadowArtifact( artifact, opts = {} ) {

	if ( opts.light ) {

		const existing = _shadowByLight.get( opts.light );
		if ( existing ) mergeArtifactFamily( existing, artifact );
		else _shadowByLight.set( opts.light, artifact );
		return;

	}

	if ( _defaultShadowArtifact === null ) _defaultShadowArtifact = artifact;
	else mergeArtifactFamily( _defaultShadowArtifact, artifact );

}

/**
 * Post-process pipeline artifact. RenderPipeline builds a single
 * NodeMaterial for its full-screen quad whose `fragmentNode` is the
 * chained pass graph; we store one artifact keyed by the pipeline's
 * final output-cache-key. Multiple pipelines (main pass + post-pass
 * variants) register themselves under different keys.
 */
const _pipelineArtifactsByKey = new Map();
let _defaultPipelineArtifact = null;

/**
 * Output-pass artifact used by `Renderer._renderOutput()` for tone
 * mapping / color-space conversion. Usually one per
 * (toneMapping, outputColorSpace) combination — look up by key, fall
 * back to the default.
 */
let _defaultOutputArtifact = null;
const _outputByKey = new Map();

/**
 * Inspect a single artifact and register it under the right role. Tags
 * are set at compile time by `classifyMaterialShape()` +
 * `extractComputeArtifact()` — inspect those if you need finer control
 * than the auto-dispatch here.
 *
 * @param {PrecompiledArtifact} artifact
 * @param {Object} [opts]
 * @param {Light} [opts.light]         Bind shadow artifact to a specific light.
 * @param {string} [opts.pipelineKey]  Bind post-process artifact to a pipeline key.
 * @param {string} [opts.outputKey]    Bind output-transform artifact to a
 *                                     toneMapping/colorSpace cache key.
 */
export function registerPrecompiledArtifact( artifact, opts = {} ) {

	if ( ! artifact ) return;

	const shape = artifact.materialShape || '';

	if ( shape === 'shadow-depth' ) {

		registerShadowArtifact( artifact, opts );

	} else if ( shape === 'render-pipeline' || shape === 'post-pass' ) {

		const key = opts.pipelineKey || artifact.pipelineKey || null;
		if ( key !== null ) _pipelineArtifactsByKey.set( key, artifact );
		if ( _defaultPipelineArtifact === null ) _defaultPipelineArtifact = artifact;

	} else if ( shape === 'output-transform' ) {

		const key = opts.outputKey || artifact.outputCacheKey || null;
		if ( key !== null ) _outputByKey.set( key, artifact );
		if ( _defaultOutputArtifact === null ) _defaultOutputArtifact = artifact;

	}

}

/**
 * Register every artifact in an array. Call this once after `compileTSL`.
 * Non-auxiliary artifacts (regular scene materials, compute kernels) are
 * ignored — the user wires those up explicitly via `PrecompiledMaterial` /
 * `PrecompiledComputeNode`.
 *
 * @param {Array<PrecompiledArtifact>} artifacts
 */
export function registerPrecompiledArtifacts( artifacts ) {

	if ( ! Array.isArray( artifacts ) ) return;
	for ( const a of artifacts ) registerPrecompiledArtifact( a );

}

/**
 * Clear every registered auxiliary artifact. Call between scenes that use
 * different precompile bundles.
 */
export function unregisterPrecompiledArtifacts() {

	_defaultShadowArtifact = null;
	_shadowByLight = new WeakMap();
	_defaultPipelineArtifact = null;
	_defaultOutputArtifact = null;
	_pipelineArtifactsByKey.clear();
	_outputByKey.clear();

}

/**
 * @param {Light} light
 * @return {?PrecompiledArtifact}
 */
export function getShadowArtifact( light ) {

	if ( light && _shadowByLight.has( light ) ) return _shadowByLight.get( light );
	return _defaultShadowArtifact;

}

/**
 * @param {?string} key
 * @return {?PrecompiledArtifact}
 */
export function getPipelineArtifact( key ) {

	if ( key != null && _pipelineArtifactsByKey.has( key ) ) return _pipelineArtifactsByKey.get( key );
	return _defaultPipelineArtifact;

}

/**
 * @param {?string} key
 * @return {?PrecompiledArtifact}
 */
export function getOutputArtifact( key ) {

	if ( key != null && _outputByKey.has( key ) ) return _outputByKey.get( key );
	return _defaultOutputArtifact;

}

/**
 * Snapshot the current registry — useful for debugging / tests.
 *
 * @return {Object}
 */
export function dumpPrecompiledRegistry() {

	return {
		defaultShadow: _defaultShadowArtifact,
		defaultPipeline: _defaultPipelineArtifact,
		defaultOutput: _defaultOutputArtifact,
		pipelineKeys: Array.from( _pipelineArtifactsByKey.keys() ),
		outputKeys: Array.from( _outputByKey.keys() )
	};

}
