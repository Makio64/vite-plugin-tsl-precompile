/**
 * VENDORED from three.js fork branch `tsl-precompile`
 * Source: src/nodes/precompile/compileTSL.js
 * See VENDORING.md for provenance and upgrade policy.
 *
 * TSL precompilation utilities.
 *
 * Given a renderer that has just run `compileAsync( scene, camera )`, these
 * helpers walk the renderer's internal `NodeBuilderState` cache and extract
 * the already-generated shader source + a serializable descriptor of each
 * build's attributes and bind groups.
 *
 * The output can be dumped as readable WGSL/GLSL for inspection, persisted as
 * JSON for offline tooling, or re-fed into a renderer via `injectPrecompiled`
 * to skip the build step on a second run.
 *
 * Starting with Phase C, every artifact also carries a `uniformPlan` that
 * maps each UBO slot to a serializable `source` descriptor. The precompiled
 * hydrator uses that plan to build per-frame updaters without keeping any
 * `src/nodes/**` classes alive at runtime.
 *
 * @module PrecompileTSL
 */

import { extractUniformPlan } from './extractUniformPlan.js';
import { compileDoublePassPairsSynchronously } from './compile-async-double-pass.js';
import { beginRenderObjectHarvest } from './render-object-observer.js';
export { beginRenderObjectHarvest };
import { DataUtils, FloatType, HalfFloatType, RGBAFormat, RenderTarget } from 'three';
import { countArtifactFragmentOutputs } from '@tsl-precompile/contract/fragment-outputs';
import { createRenderObjectContextSelector, RENDER_BINDING_OWNER_KINDS } from '@tsl-precompile/contract/render-selector';
import { mergeArtifactVariantFamily } from '@tsl-precompile/contract/artifact-variants';
import { normalizeArtifactLightIdentities } from '@tsl-precompile/contract/light-identities';
import { createRendererOutputConfig } from '@tsl-precompile/contract/output-config';
import {
	hasUnresolvedMaterialComputeTexture,
	MATERIAL_COMPUTE_ACCESS_MODES,
	MATERIAL_COMPUTE_LIFECYCLE_PHASES,
	MATERIAL_COMPUTE_UPDATE_TYPES,
	MATERIAL_COMPUTE_VERSION,
} from '@tsl-precompile/contract/material-compute';

/**
 * Describes a single binding inside a bind group in serializable form.
 *
 * @typedef {Object} PrecompiledBindingDescriptor
 * @property {string} name
 * @property {string} kind - One of: 'uniform-buffer', 'storage-buffer', 'sampled-texture', 'sampler', 'unknown'.
 * @property {number} visibility - Shader stage bitmask.
 * @property {?string} textureType - For sampled textures: '2d', '3d', 'cube', '2d-array'.
 * @property {?number} byteLength - For buffers: size in bytes when known.
 * @property {?string} access - Access qualifier (read/write) when applicable.
 */

/**
 * Describes a bind group in serializable form.
 *
 * @typedef {Object} PrecompiledBindGroupDescriptor
 * @property {string} name
 * @property {Array<PrecompiledBindingDescriptor>} bindings
 */

/**
 * A single precompiled shader artifact extracted from a built `NodeBuilderState`.
 *
 * @typedef {Object} PrecompiledArtifact
 * @property {number} cacheKey - Matches `NodeManager.getForRenderCacheKey`.
 * @property {string} vertexShader - Native vertex shader source (WGSL or GLSL).
 * @property {string} fragmentShader - Native fragment shader source.
 * @property {string} computeShader - Native compute shader source (may be empty).
 * @property {Array<{name: string, type: string}>} attributes
 * @property {Array<PrecompiledBindGroupDescriptor>} bindings
 * @property {Array<Object>} uniformPlan - Per-group list of UBO slots with
 *     `source` descriptors; consumed by the runtime hydrator.
 * @property {Object} meta - Non-serializable counts for reuse validation.
 */

function describeBinding( binding ) {

	const descriptor = {
		name: binding.name || '',
		kind: 'unknown',
		visibility: binding.visibility | 0,
		textureType: null,
		byteLength: null,
		access: binding.access || null
	};

	if ( binding.isUniformBuffer ) {

		descriptor.kind = 'uniform-buffer';
		descriptor.byteLength = binding.byteLength ?? ( binding.buffer ? binding.buffer.byteLength : null );

	} else if ( binding.isStorageBuffer ) {

		descriptor.kind = 'storage-buffer';
		descriptor.byteLength = binding.byteLength ?? null;

	} else if ( binding.isSampledTexture ) {

		descriptor.kind = 'sampled-texture';
		if ( binding.store === true ) descriptor.store = true;

		const texture = binding.texture;
		if ( texture ) {

			if ( texture.isCubeTexture ) descriptor.textureType = 'cube';
			else if ( texture.isDataArrayTexture || texture.isCompressedArrayTexture || texture.isArrayTexture ) descriptor.textureType = '2d-array';
			else if ( texture.isData3DTexture || texture.is3DTexture ) descriptor.textureType = '3d';
			else descriptor.textureType = '2d';

		}

	} else if ( binding.isSampler ) {

		descriptor.kind = 'sampler';

	}

	return descriptor;

}

function describeBindGroup( group ) {

	return {
		name: group.name || '',
		bindings: group.bindings.map( describeBinding )
	};

}

/**
 * Descriptive tag only. Phase A used this value to key the hydrator table;
 * Phase C drives the hydrator from `uniformPlan` instead, so this field is
 * now informational — useful for debugging and tooling, not gating.
 *
 * @param {Material} material
 * @return {string}
 */
export function classifyMaterialShape( material ) {

	if ( ! material ) return 'unknown';
	// Shadow-override: `isShadowPassMaterial` is set by ShadowFilterNode
	// → getShadowMaterial. Check first so we don't collapse shadow depth
	// artifacts into the generic 'node-material' bucket.
	if ( material.isShadowPassMaterial ) return 'shadow-depth';
	// Render-pipeline internal material (post-process + tone mapping) —
	// RenderPipeline sets `material.name = 'RenderPipeline'` on its
	// internal quad; Renderer._renderOutput sets `outputColorTransform`.
	// Both are detectable by the name + the fact that they're plain
	// NodeMaterials (not a typed Mesh*NodeMaterial).
	if ( material.name === 'RenderPipeline' ) return 'render-pipeline';
	if ( material.name === 'outputColorTransform' ) return 'output-transform';
	if ( material.isMeshBasicNodeMaterial ) return 'mesh-basic';
	if ( material.isMeshPhysicalNodeMaterial ) return 'mesh-physical';
	if ( material.isMeshStandardNodeMaterial ) return 'mesh-standard';
	if ( material.isMeshLambertNodeMaterial ) return 'mesh-lambert';
	if ( material.isMeshPhongNodeMaterial ) return 'mesh-phong';
	if ( material.isMeshToonNodeMaterial ) return 'mesh-toon';
	if ( material.isMeshMatcapNodeMaterial ) return 'mesh-matcap';
	if ( material.isMeshNormalNodeMaterial ) return 'mesh-normal';
	if ( material.isLineBasicNodeMaterial ) return 'line-basic';
	if ( material.isPointsNodeMaterial ) return 'points';
	if ( material.isSpriteNodeMaterial ) return 'node-material';
	// Classic materials that the WebGPU renderer auto-wraps into a
	// NodeMaterial on the fly — we still classify them by their classic
	// `is*Material` flag so the auto-port swap can match a plain
	// `new MeshBasicMaterial()` against the wrapped artifact.
	if ( material.isMeshBasicMaterial ) return 'mesh-basic';
	if ( material.isMeshPhysicalMaterial ) return 'mesh-physical';
	if ( material.isMeshStandardMaterial ) return 'mesh-standard';
	if ( material.isMeshPhongMaterial ) return 'mesh-phong';
	if ( material.isMeshLambertMaterial ) return 'mesh-lambert';
	if ( material.isMeshToonMaterial ) return 'mesh-toon';
	if ( material.isMeshMatcapMaterial ) return 'mesh-matcap';
	if ( material.isMeshNormalMaterial ) return 'mesh-normal';
	if ( material.isLineBasicMaterial ) return 'line-basic';
	if ( material.isPointsMaterial ) return 'points';
	if ( material.isSpriteMaterial ) return 'node-material';
	if ( material.isNodeMaterial ) return 'node-material';
	// Fall back to constructor name for node-material subclasses that
	// don't set an `is*` tag — avoids mis-tagging every internal
	// NodeMaterial as 'unknown'.
	const ctorName = material.constructor && material.constructor.name;
	if ( ctorName ) {

		if ( ctorName.startsWith( 'Mesh' ) && ctorName.endsWith( 'NodeMaterial' ) ) {

			return 'mesh-' + ctorName.slice( 4, - 'NodeMaterial'.length ).toLowerCase();

		}

	}
	return 'unknown';

}

function isAuxiliaryArtifactShape( materialShape ) {

	return materialShape === 'shadow-depth' || materialShape === 'render-pipeline' || materialShape === 'output-transform';

}

function selectPreferredArtifact( current, candidate, expectedShape ) {

	if ( ! current ) return candidate;

	const currentMatches = expectedShape && current.materialShape === expectedShape;
	const candidateMatches = expectedShape && candidate.materialShape === expectedShape;

	if ( candidateMatches && ! currentMatches ) return candidate;

	const currentUsable = countArtifactFragmentOutputs( current, 1 ) > 0;
	const candidateUsable = countArtifactFragmentOutputs( candidate, 1 ) > 0;
	if ( candidateUsable && ! currentUsable ) return candidate;

	const currentMRT = typeof current.mrtOutputCount === 'number' && current.mrtOutputCount > 0;
	const candidateMRT = typeof candidate.mrtOutputCount === 'number' && candidate.mrtOutputCount > 0;
	if ( candidateUsable && currentMRT && ! candidateMRT ) return candidate;

	return current;

}

function pushArtifactVariant( byMaterialVariants, materialUuid, artifact ) {

	if ( ! materialUuid ) return;

	let variants = byMaterialVariants.get( materialUuid );
	if ( variants === undefined ) {

		variants = [];
		byMaterialVariants.set( materialUuid, variants );

	}

	variants.push( artifact );

}

function mergeArtifactTextureRefs( target, source ) {

	const sourceRefs = source && source._textureRefs;
	if ( ! ( sourceRefs instanceof Map ) || sourceRefs.size === 0 ) return;
	const existingRefs = target._textureRefs instanceof Map ? target._textureRefs : null;
	const refs = existingRefs || new Map();
	let changed = false;
	for ( const [ uuid, texture ] of sourceRefs ) {

		if ( ! refs.has( uuid ) ) {

			refs.set( uuid, texture );
			changed = true;

		}

	}
	if ( ! changed ) return;
	if ( existingRefs ) return;
	Object.defineProperty( target, '_textureRefs', {
		value: refs,
		enumerable: false,
		configurable: true,
		writable: true,
	} );

}

function attachArtifactVariantFamily( artifact, variantList ) {

	if ( ! artifact || ! Array.isArray( variantList ) || variantList.length <= 1 ) return;
	for ( const variant of variantList ) {

		mergeArtifactTextureRefs( artifact, variant );

	}
	mergeArtifactVariantFamily( artifact, variantList );

}

/**
 * Detect and capture LTC BRDF approximation textures from a built artifact.
 *
 * RectAreaLightNode binds two 64×64 RGBA float DataTextures (ltc_1 / ltc_2)
 * that are created by `RectAreaLightTexturesLib.init()` and stored as a
 * static on `_ltcLib`. These are not accessible from outside the three.js
 * module, so we detect them by their characteristic fingerprint:
 *   - Sampled-texture binding with kind `artifact.texture`
 *   - Snapshot is a 64×64 RGBA Float32Array (16384 elements, format 1023,
 *     type 1015 = FloatType)
 *
 * When detected, we:
 *   1. Convert the float32 data to uint16 half-float for maximum WebGPU
 *      compatibility (float32 textures require the `float32-filterable`
 *      adapter feature for linear filtering; half-float does not).
 *   2. Store the converted arrays in `artifact.ltcTextures[0..n-1]`.
 *   3. Upgrade the plan entry's source kind from `artifact.texture` to
 *      `builtin.ltcTexture` with a numeric `ltcIndex` so the hydrator can
 *      reconstruct the texture from the saved data without falling through
 *      the generic snapshot path.
 *
 * @param {PrecompiledArtifact} artifact - Mutated in-place.
 */
function captureLtcTextures( artifact ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const ltcArrays = [];
	// Maps textureUuid → ltcIndex so paired sampler entries can reuse the same
	// array index as their corresponding sampled-texture entry.
	const uuidToLtcIndex = new Map();

	// First pass: walk sampled-texture entries only. Detect LTC fingerprint,
	// convert to half-float, and build the ltcTextures array.
	for ( const group of plan ) {

		for ( const texEntry of ( group.textures || [] ) ) {

			const source = texEntry.source;
			// Only promote sampled-texture bindings, not sampler bindings.
			// Sampler bindings are handled in the second pass below.
			if ( texEntry.bindingKind !== 'sampled-texture' ) continue;
			if ( ! source || source.kind !== 'artifact.texture' ) continue;

			const snap = source.snapshot;
			if ( ! snap ) continue;

			// LTC texture fingerprint: 64×64 RGBA Float32.
			// format 1023 = RGBAFormat, type 1015 = FloatType.
			if ( snap.width !== 64 || snap.height !== 64 ) continue;
			if ( snap.arrayType !== 'Float32Array' ) continue;
			if ( snap.format !== RGBAFormat ) continue;
			if ( snap.type !== FloatType ) continue;
			if ( ! Array.isArray( snap.data ) || snap.data.length !== 64 * 64 * 4 ) continue;

			// Convert float32 → half-float uint16 for replay compatibility.
			const halfData = new Array( snap.data.length );
			for ( let i = 0; i < snap.data.length; i ++ ) {

				halfData[ i ] = DataUtils.toHalfFloat( snap.data[ i ] );

			}

			const ltcIndex = ltcArrays.length;
			ltcArrays.push( halfData );

			if ( source.textureUuid ) uuidToLtcIndex.set( source.textureUuid, ltcIndex );

			// Promote the sampler settings for accurate filter/wrap replay.
			const ltcSource = {
				kind: 'builtin.ltcTexture',
				ltcIndex,
				magFilter: snap.magFilter,
				minFilter: snap.minFilter,
				wrapS: snap.wrapS,
				wrapT: snap.wrapT,
			};
			texEntry.source = ltcSource;

		}

	}

	if ( ltcArrays.length === 0 ) return;

	artifact.ltcTextures = ltcArrays;

	// Second pass: upgrade paired sampler bindings so they carry the same
	// `builtin.ltcTexture` source kind. Samplers don't need array data but
	// must share the kind/ltcIndex so the hydrator knows to skip the
	// `artifact.texture` fallback chain.
	for ( const group of plan ) {

		for ( const texEntry of ( group.textures || [] ) ) {

			if ( texEntry.bindingKind !== 'sampler' ) continue;
			const source = texEntry.source;
			if ( ! source || source.kind !== 'artifact.texture' ) continue;
			if ( ! source.textureUuid ) continue;

			const ltcIndex = uuidToLtcIndex.get( source.textureUuid );
			if ( ltcIndex === undefined ) continue;

			texEntry.source = {
				kind: 'builtin.ltcTexture',
				ltcIndex,
				magFilter: source.magFilter,
				minFilter: source.minFilter,
				wrapS: source.wrapS,
				wrapT: source.wrapT,
			};

		}

	}

}

/**
 * Extract a serializable artifact from a single `NodeBuilderState`.
 *
 * @param {number} cacheKey
 * @param {NodeBuilderState} state
 * @param {?Material} [material=null] - Optional source material; used to tag
 *     the artifact with a shape the runtime hydrator can consume.
 * @param {?Object3D} [object=null] - Optional source object; used to map
 *     object-owned UniformNode properties such as WaterMesh.distortionScale.
 * @param {?Object} [extractionContext=null] - Optional process-local
 *     provenance such as exact material binding owners. Never serialized.
 * @return {PrecompiledArtifact}
 */
export function extractArtifact( cacheKey, state, material = null, object = null, extractionContext = null ) {

	const bindings = ( state.bindings || [] ).map( describeBindGroup );
	let materialShape = classifyMaterialShape( material );
	// Fallback shape detection when the caller didn't track the material
	// (the output-pass + render-pipeline quads are constructed inside
	// `Renderer._renderOutput` / `RenderPipeline`, so they never flow
	// through the getForRender hook). Inspect the fragment shader for
	// signatures these passes emit and tag accordingly; the registry
	// consumes `output-transform` + `render-pipeline` shapes by name.
	if ( materialShape === 'unknown' || ( material === null && materialShape === 'node-material' ) ) {

		const frag = state.fragmentShader || '';
		const vert = state.vertexShader || '';
		if ( /sRGBTransferOETF|LinearToSRGB|ReinhardToneMapping|CineonToneMapping|ACESFilmicToneMapping|AgXToneMapping|NeutralToneMapping/.test( frag ) ) {

			materialShape = 'output-transform';

		} else {

			// Infer shape from the lighting model baked into the WGSL.
			// Each Mesh*NodeMaterial emits a distinctive fragment-shader
			// signature the classifier can match on. This catches the
			// renderer's auto-wrapped classic materials whose wrapped
			// instance never flowed through the `getForRender` hook
			// (shadow passes, depth passes, etc.).
			if ( /physicalDirect|BRDF_GGX|BRDF_Lambert/.test( frag ) ) materialShape = 'mesh-physical';
			else if ( /standardDirect|BRDF_GGX/.test( frag ) ) materialShape = 'mesh-standard';
			else if ( /phongDirect|BlinnPhong/.test( frag ) ) materialShape = 'mesh-phong';
			else if ( /toonDirect|ToonMaterial/.test( frag ) ) materialShape = 'mesh-toon';
			else if ( /matcapSample/.test( frag ) ) materialShape = 'mesh-matcap';
			else if ( /normalView|isFrontFacing.*normal/.test( frag ) ) materialShape = 'mesh-normal';
			else if ( /( struct\s+attributeNode|@location\(\s*\d+\s*\)\s*color)/.test( vert ) && /@location\(\s*0\s*\)\s*color/.test( frag ) ) materialShape = 'line-basic';
			else if ( /gl_PointSize|pointsScale/.test( vert ) ) materialShape = 'points';
			// MeshBasic — minimal surface, no lighting. Fragment outputs
			// either a plain color uniform or a sampled texture, no
			// direct*Light* BRDFs.
			else if ( ! /Direct|lightingModel|BRDF/.test( frag ) && /DiffuseColor\s*=/.test( frag ) ) materialShape = 'mesh-basic';

		}

	}
	const uniformPlan = extractUniformPlan( state, extractionContext && typeof extractionContext === 'object'
		? { ...extractionContext, material, object }
		: { material, object } );
	patchMaterialSpecificUniformPlan( uniformPlan, materialShape );
	annotateLiveUniformIdentities( uniformPlan, material, extractionContext );
	// For each compute-storage buffer the user wired through a material
	// `*Node` slot (e.g. `material.colorNode = uv().mul( colors.element( i ) )`),
	// record `userPath` so the hydrator can rebind the live attribute in a
	// fresh process — same trick we use for vertex attributes. Without
	// this the `StorageBuffer_*` plan entry has no link back to the live
	// buffer that the compute kernel writes into, and the render path
	// allocates a fresh empty buffer.
	annotateStorageBufferUserPaths( uniformPlan, material, extractionContext );

	// Seed runtime defaults for the material properties the plan references.
	// PrecompiledMaterial reads these to populate its own color/opacity/etc.
	// so the hydrator can read from the material even before the user sets
	// anything.
	const defaults = collectMaterialDefaults( uniformPlan, material, extractionContext && extractionContext.bindingOwnerKind );
	// Capture material render-state flags (transparent, side, depthWrite,
	// blending, etc.). These drive pipeline state in three.js and aren't
	// covered by the uniformPlan walk above. Without them sprites lose
	// their alpha-blending, BackSide skybox materials disappear behind
	// front-facing geometry, etc.
	const renderState = collectMaterialRenderState( material );

	// Collect live Texture references keyed by uuid so the hydrator can bind
	// them at runtime. Non-serialisable — attached as a separate side-car
	// property so the artifact JSON stays clean. For offline pipelines, the
	// app would need to re-attach textures by uuid before hydration.
	const textureRefs = collectTextureRefs( state );

	const artifact = {
		version: 3,
		cacheKey,
		materialShape,
		vertexShader: state.vertexShader || '',
		fragmentShader: state.fragmentShader || '',
		computeShader: state.computeShader || '',
		attributes: ( state.nodeAttributes || [] ).map( ( a ) => {

			const liveAttribute = a.node && a.node.attribute;
			const entry = {
				name: a.name,
				type: a.type,
				source: liveAttribute ? 'node' : 'geometry'
			};

			if ( liveAttribute ) {

				entry.count = liveAttribute.count || 1;
				entry.itemSize = liveAttribute.itemSize || itemSizeFromAttributeType( a.type );
				entry.arrayType = liveAttribute.array && liveAttribute.array.constructor && liveAttribute.array.constructor.name || 'Float32Array';
				entry.instanced = isInstancedAttribute( liveAttribute );
				entry.storage = liveAttribute.isStorageBufferAttribute === true || liveAttribute.isStorageInstancedBufferAttribute === true;
				if ( liveAttribute.normalized === true ) entry.normalized = true;
				if ( typeof liveAttribute.meshPerAttribute === 'number' && liveAttribute.meshPerAttribute !== 1 ) entry.meshPerAttribute = liveAttribute.meshPerAttribute;
				if ( typeof liveAttribute.usage === 'number' ) entry.usage = liveAttribute.usage;

				// Record the source-material property whose node sub-tree
				// references this attribute (e.g. "positionNode" for
				// `material.positionNode = instancedBufferAttribute(buf)`).
				// `_liveAttribute` survives only in the in-process capture →
				// render flow; offline replay reloads from JSON and the
				// reference is lost. The path lets the apply-side rewalk
				// the user's freshly-constructed node tree and rebind the
				// live BufferAttribute the user code created.
				const userPath = findOwnerQualifiedAttributePath( material, liveAttribute, extractionContext );
				if ( userPath ) {

					entry.userPath = userPath;

				} else {

					const snapshot = snapshotAttributeArray( liveAttribute );
					if ( snapshot ) entry.arraySnapshot = snapshot;

				}

				Object.defineProperty( entry, '_liveAttribute', {
					value: liveAttribute,
					enumerable: false,
					writable: true
				} );

			}

			return entry;

		} ),
		bindings,
		uniformPlan,
		defaults,
		renderState,
		meta: {
			updateNodes: state.updateNodes ? state.updateNodes.length : 0,
			updateBeforeNodes: state.updateBeforeNodes ? state.updateBeforeNodes.length : 0,
			updateAfterNodes: state.updateAfterNodes ? state.updateAfterNodes.length : 0
		}
	};

	if ( textureRefs.size > 0 ) {

		// Non-enumerable so JSON.stringify skips it — callers that want to
		// ship the artifact across a wire strip to scene.* / material.*
		// sources, or re-attach the texture map themselves.
		Object.defineProperty( artifact, '_textureRefs', {
			value: textureRefs,
			enumerable: false,
			configurable: true,
			writable: true
		} );

	}

	attachLiveUpdateSidecars( artifact, state );

	// Detect and promote LTC BRDF textures (RectAreaLight) from the generic
	// `artifact.texture` snapshot path to the dedicated `builtin.ltcTexture`
	// kind. This ensures the hydrator reconstructs them as half-float
	// DataTextures regardless of whether the replay device supports
	// float32-filterable linear sampling.
	captureLtcTextures( artifact );

	return normalizeArtifactLightIdentities( artifact );

}

function patchMaterialSpecificUniformPlan( uniformPlan, materialShape ) {

	if ( materialShape !== 'points' || ! Array.isArray( uniformPlan ) ) return;

	for ( const group of uniformPlan ) {

		const slots = Array.isArray( group.slots ) ? group.slots : [];
		const hasViewport = slots.some( ( slot ) => slot.source && slot.source.kind === 'renderer.viewport' );
		const hasDpr = slots.some( ( slot ) => slot.source && slot.source.kind === 'renderer.dpr' );
		if ( ! hasViewport || ! hasDpr ) continue;

		for ( const slot of slots ) {

			const source = slot.source || {};
			if ( source.kind !== 'uniform.live' || source.name !== null || slot.dtype !== 'number' ) continue;

			// PointsNodeMaterial's private `scale` UniformNode is not exported from
			// three.js, but its role is stable: half the renderer's logical height.
			// Serialise that explicit source so production artifacts don't freeze the
			// capture-time 128px snapshot.
			slot.source = {
				kind: 'renderer.halfHeight',
				valueSnapshot: source.valueSnapshot,
			};

		}

	}

}

function itemSizeFromAttributeType( type ) {

	switch ( type ) {

		case 'float':
		case 'number':
		case 'int':
		case 'uint':
			return 1;
		case 'vec2':
		case 'ivec2':
		case 'uvec2':
			return 2;
		case 'vec4':
		case 'ivec4':
		case 'uvec4':
			return 4;
		case 'vec3':
		case 'ivec3':
		case 'uvec3':
		default:
			return 3;

	}

}

function isInstancedAttribute( attribute ) {

	return attribute && (
		attribute.isInstancedBufferAttribute === true
		|| attribute.isStorageInstancedBufferAttribute === true
		|| attribute.data && attribute.data.isInstancedInterleavedBuffer === true
	);

}

function snapshotAttributeArray( attribute ) {

	if ( ! attribute || ! attribute.array || ! ArrayBuffer.isView( attribute.array ) ) return null;

	if ( attribute.isInterleavedBufferAttribute === true && attribute.data ) {

		const source = attribute.data.array;
		const stride = attribute.data.stride || attribute.itemSize || 1;
		const offset = attribute.offset || 0;
		const itemSize = attribute.itemSize || 1;
		const count = attribute.count || 0;
		if ( ! source || ! Number.isFinite( stride ) || stride <= 0 || ! Number.isFinite( count ) || count <= 0 ) return null;

		const out = [];
		for ( let i = 0; i < count; i ++ ) {

			const base = i * stride + offset;
			for ( let c = 0; c < itemSize; c ++ ) out.push( source[ base + c ] );

		}
		return out;

	}

	return Array.from( attribute.array );

}

/**
 * Walk the source material's node-shaped properties looking for a TSL node
 * whose attribute leaf === `target`. Returns the property name(s) as a path
 * (currently always a single-element array — the root property). The
 * apply-side rewalks the user's freshly-constructed node tree at this path
 * to find the live BufferAttribute the user code created in the new
 * process.
 *
 * Skips closures / non-node props by checking `isNode`. Tolerates missing
 * `traverse` (slim-stub leaf nodes) by also testing the root directly.
 *
 * @param {?Object} material - Source NodeMaterial (the user's original).
 * @param {Object} target - Live BufferAttribute we want to relocate.
 * @return {?Array<string>} Property path or null when no match.
 */
function findAttributePathOnMaterial( material, target ) {

	if ( ! material || ! target || typeof material !== 'object' ) return null;

	for ( const key of Object.keys( material ).sort() ) {

		// Convention: NodeMaterial node-shaped slots end in `Node` (positionNode,
		// colorNode, vertexNode, mrtNode, …). Avoids walking arbitrary user
		// properties (textures, scalars) that can't possibly contain a Node.
		if ( ! key.endsWith( 'Node' ) ) continue;
		const root = material[ key ];
		if ( ! root || root.isNode !== true ) continue;
		const suffix = findObjectPath( root, target );
		if ( suffix ) return [ key, ...suffix ];

	}

	return null;

}

function findOwnerQualifiedAttributePath( material, target, extractionContext ) {

	const bindingOwner = extractionContext && extractionContext.bindingOwnerKind || RENDER_BINDING_OWNER_KINDS.MATERIAL;
	return bindingOwner === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER
		? findSharedCasterAttributePath( extractionContext, target )
		: findAttributePathOnMaterial( material, target );

}

function findSharedCasterAttributePath( extractionContext, target ) {

	const owners = extractionContext && extractionContext.materialBindingOwners;
	if ( ! ( owners instanceof Set ) || owners.size === 0 ) return null;
	let sharedPath = null;
	for ( const owner of owners ) {

		const candidate = findAttributePathOnMaterial( owner, target );
		if ( ! candidate ) continue;
		if ( sharedPath && ! sameNodePath( sharedPath, candidate ) ) return null;
		sharedPath = candidate;

	}
	if ( ! sharedPath ) return null;
	for ( const owner of owners ) {

		const candidate = resolveLiveNodePathOnMaterial( owner, sharedPath );
		if ( ! compatibleAttribute( candidate, target ) ) return null;

	}
	return sharedPath;

}

const NODE_PATH_SKIP_KEYS = new Set( [
	'parent', 'children', 'scene', 'camera', 'renderer', 'geometry', '_cache',
	'domElement', 'sourceMaterial', 'constructor', '__proto__', 'prototype',
] );
const MAX_NODE_PATH_DEPTH = 24;

/**
 * Find an exact, serializable property path from a material's public `*Node`
 * roots to a live TSL node. Unlike snapshot/name matching, the path remains
 * unambiguous when several anonymous UniformNodes have the same type/value or
 * when animation has already changed their values before replay hydration.
 *
 * @param {?Object} material
 * @param {Object} target
 * @return {?Array<string>}
 */
function findLiveNodePathOnMaterial( material, target ) {

	if ( ! material || ! target || typeof material !== 'object' ) return null;
	const rootKeys = Object.keys( material ).filter( ( key ) => key.endsWith( 'Node' ) ).sort();
	for ( const rootKey of rootKeys ) {

		let root = null;
		try { root = material[ rootKey ]; } catch ( _ ) { continue; }
		if ( ! root || ( typeof root !== 'object' && typeof root !== 'function' ) ) continue;
		const suffix = findObjectPath( root, target );
		if ( suffix ) return [ rootKey, ...suffix ];

	}
	return null;

}

function findObjectPath( root, target ) {

	if ( root === target ) return [];
	const seen = new Set();

	function visit( value, depth ) {

		if ( value === target ) return [];
		if ( ! value || ( typeof value !== 'object' && typeof value !== 'function' ) ) return null;
		if ( seen.has( value ) || depth >= MAX_NODE_PATH_DEPTH ) return null;
		seen.add( value );

		let keys = [];
		try { keys = Object.getOwnPropertyNames( value ).sort(); } catch ( _ ) { return null; }
		for ( const key of keys ) {

			if ( NODE_PATH_SKIP_KEYS.has( key ) || key === 'length' ) continue;
			let child = null;
			try { child = value[ key ]; } catch ( _ ) { continue; }
			if ( child === target ) return [ key ];
			if ( ! child || ( typeof child !== 'object' && typeof child !== 'function' ) ) continue;
			const suffix = visit( child, depth + 1 );
			if ( suffix ) return [ key, ...suffix ];

		}
		return null;

	}

	return visit( root, 0 );

}

/**
 * Stamp artifact-local object identity onto serializable `uniform.live`
 * sources, plus an exact material-graph path when one exists. The in-process
 * `_liveNode` remains authoritative; this metadata is for the JSON/build
 * boundary where object identity would otherwise be lost.
 *
 * @param {Array} uniformPlan
 * @param {?Object} material
 * @param {?Object} extractionContext
 */
function annotateLiveUniformIdentities( uniformPlan, material, extractionContext = null ) {

	if ( ! Array.isArray( uniformPlan ) ) return;
	const pathByOwnerAndNode = new Map();
	const idByNode = new Map();
	for ( const group of uniformPlan ) {

		for ( const slot of group && Array.isArray( group.slots ) ? group.slots : [] ) {

			const source = slot && slot.source;
			const liveNode = slot && slot._liveNode;
			if ( ! source || source.kind !== 'uniform.live' || ! liveNode ) continue;
			let liveNodeId = idByNode.get( liveNode );
			if ( liveNodeId === undefined ) {

				liveNodeId = idByNode.size;
				idByNode.set( liveNode, liveNodeId );

			}
			const bindingOwner = source.bindingOwner
				|| extractionContext && extractionContext.bindingOwnerKind
				|| RENDER_BINDING_OWNER_KINDS.MATERIAL;
			let pathByNode = pathByOwnerAndNode.get( bindingOwner );
			if ( ! pathByNode ) pathByOwnerAndNode.set( bindingOwner, pathByNode = new Map() );
			let nodePath = pathByNode.get( liveNode );
			if ( nodePath === undefined ) {

				nodePath = bindingOwner === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER
					? findSharedCasterLiveNodePath( extractionContext, liveNode )
					: findLiveNodePathOnMaterial( material, liveNode );
				pathByNode.set( liveNode, nodePath );

			}
			const { nodePath: _staleNodePath, ...sourceWithoutPath } = source;
			slot.source = nodePath ? { ...sourceWithoutPath, liveNodeId, nodePath } : { ...sourceWithoutPath, liveNodeId };

		}

	}

}

function findSharedCasterLiveNodePath( extractionContext, liveNode ) {

	const owners = extractionContext && extractionContext.materialBindingOwners;
	if ( ! ( owners instanceof Set ) || owners.size === 0 ) return null;
	let sharedPath = null;
	for ( const owner of owners ) {

		const candidate = findLiveNodePathOnMaterial( owner, liveNode );
		if ( ! candidate ) continue;
		if ( sharedPath && ! sameNodePath( sharedPath, candidate ) ) return null;
		sharedPath = candidate;

	}
	if ( ! sharedPath ) return null;
	for ( const owner of owners ) {

		const candidate = resolveLiveNodePathOnMaterial( owner, sharedPath );
		if ( ! compatibleUniformNode( candidate, liveNode ) ) return null;

	}
	return sharedPath;

}

function resolveLiveNodePathOnMaterial( material, nodePath ) {

	if ( ! material || ! Array.isArray( nodePath ) || nodePath.length === 0 ) return null;
	let current = material;
	for ( const segment of nodePath ) {

		if ( typeof segment !== 'string' || segment.length === 0 || NODE_PATH_SKIP_KEYS.has( segment ) ) return null;
		if ( ! current || ( typeof current !== 'object' && typeof current !== 'function' ) ) return null;
		if ( ! Object.prototype.hasOwnProperty.call( current, segment ) ) return null;
		try { current = current[ segment ]; } catch ( _ ) { return null; }

	}
	return current;

}

function compatibleUniformNode( candidate, captured ) {

	if ( candidate === captured ) return true;
	if ( ! candidate || candidate.isUniformNode !== true || ! captured || captured.isUniformNode !== true ) return false;
	const candidateType = candidate.nodeType || candidate.constructor && candidate.constructor.type || null;
	const capturedType = captured.nodeType || captured.constructor && captured.constructor.type || null;
	return candidateType === null || capturedType === null || candidateType === capturedType;

}

function sameNodePath( first, second ) {

	if ( first.length !== second.length ) return false;
	for ( let index = 0; index < first.length; index ++ ) if ( first[ index ] !== second[ index ] ) return false;
	return true;

}

/**
 * Walk every `storageBuffers[]` entry in the uniform plan; for each entry
 * whose `_liveAttribute` is set, find the source-material `*Node` property
 * whose node tree references it and stamp `entry.userPath = [propName]`.
 *
 * Compute-storage buffers are typically wired through a material's
 * `colorNode`, `vertexNode`, etc. — `material.colorNode = uv().mul(
 * colors.element( instanceIndex ) )` puts a `StorageBufferNode` (whose
 * `.value` is the live `StorageBufferAttribute`) inside the colorNode
 * tree. The hydrator rewalks the same tree at first render to relocate
 * the live buffer so render and compute share one GPU buffer.
 *
 * @param {Array} uniformPlan
 * @param {?Object} material
 */
function annotateStorageBufferUserPaths( uniformPlan, material, extractionContext = null ) {

	if ( ! Array.isArray( uniformPlan ) ) return;

	for ( const group of uniformPlan ) {

		const entries = group && Array.isArray( group.storageBuffers ) ? group.storageBuffers : null;
		if ( ! entries || entries.length === 0 ) continue;
		for ( const sb of entries ) {

			if ( ! sb || ! sb._liveAttribute ) continue;
			const path = findOwnerQualifiedAttributePath( material, sb._liveAttribute, extractionContext );
			if ( path ) sb.userPath = path;

		}

	}

}

function compatibleAttribute( candidate, captured ) {

	if ( candidate === captured ) return true;
	if ( ! candidate || ! captured || ! candidate.array || ! captured.array ) return false;
	if ( candidate.itemSize !== captured.itemSize ) return false;
	if ( candidate.array.constructor !== captured.array.constructor ) return false;
	const candidateStorage = candidate.isStorageBufferAttribute === true || candidate.isStorageInstancedBufferAttribute === true;
	const capturedStorage = captured.isStorageBufferAttribute === true || captured.isStorageInstancedBufferAttribute === true;
	return candidateStorage === capturedStorage;

}

function attachLiveUpdateSidecars( artifact, state ) {

	// Keep the original update node phases alive so the hydrator can keep
	// dynamic uniform values and per-frame history nodes fresh at runtime.
	// Without this, the precompiled path falls back to compile-time
	// snapshots and misses updateAfter-driven state like motion vectors.
	if ( Array.isArray( state.updateNodes ) && state.updateNodes.length > 0 ) {

		Object.defineProperty( artifact, '_liveUpdateNodes', {
			value: state.updateNodes,
			enumerable: false,
			writable: true
		} );

	}

	if ( Array.isArray( state.updateBeforeNodes ) && state.updateBeforeNodes.length > 0 ) {

		Object.defineProperty( artifact, '_liveUpdateBeforeNodes', {
			value: state.updateBeforeNodes,
			enumerable: false,
			writable: true
		} );

	}

	if ( Array.isArray( state.updateAfterNodes ) && state.updateAfterNodes.length > 0 ) {

		Object.defineProperty( artifact, '_liveUpdateAfterNodes', {
			value: state.updateAfterNodes,
			enumerable: false,
			writable: true
		} );

	}

}

const MATERIAL_COMPUTE_UPDATE_TYPE_SET = new Set( MATERIAL_COMPUTE_UPDATE_TYPES );
const MATERIAL_COMPUTE_ACCESS_MODE_SET = new Set( MATERIAL_COMPUTE_ACCESS_MODES );

function isRawMaterialComputeNode( node ) {

	return !! node && node.isComputeNode === true && node.isPrecompiledCompute !== true;

}

function computeResourceEvidence( binding ) {

	if ( ! binding || typeof binding !== 'object' ) return null;
	if ( binding.isStorageBuffer === true ) {

		const identity = binding.attribute || null;
		if ( ! identity || ( typeof identity !== 'object' && typeof identity !== 'function' ) ) return {
			kind: 'storage-buffer',
			identity: null,
			metadata: {},
		};
		const array = identity.array;
		return {
			kind: 'storage-buffer',
			identity,
			metadata: {
				arrayType: array && array.constructor && array.constructor.name || 'Float32Array',
				count: Number.isFinite( identity.count ) ? identity.count : 0,
				itemSize: Number.isFinite( identity.itemSize ) ? identity.itemSize : 1,
				byteLength: array && Number.isFinite( array.byteLength ) ? array.byteLength : binding.byteLength ?? null,
			},
		};

	}
	const texture = binding.texture || binding.textureNode && binding.textureNode.value || null;
	if ( texture && texture.isStorageTexture === true ) return {
		kind: 'storage-texture',
		identity: texture,
		metadata: {
			textureType: texture.isDataArrayTexture || texture.isArrayTexture ? '2d-array'
				: texture.isData3DTexture || texture.is3DTexture ? '3d'
					: '2d',
		},
	};
	return null;

}

function computeNodeUpdateType( node ) {

	let updateType = node && node.updateBeforeType;
	if ( node && typeof node.getUpdateBeforeType === 'function' ) {

		try { updateType = node.getUpdateBeforeType(); } catch ( _ ) { /* fall through to the public field */ }

	}
	return MATERIAL_COMPUTE_UPDATE_TYPE_SET.has( updateType ) ? updateType : null;

}

function cloneMaterialComputeUniformPlan( uniformPlan, material ) {

	if ( ! Array.isArray( uniformPlan ) ) return uniformPlan;
	const plan = uniformPlan.map( ( group ) => {

		if ( ! group || typeof group !== 'object' ) return group;
		const slots = Array.isArray( group.slots ) ? group.slots.map( ( slot ) => {

			if ( ! slot || typeof slot !== 'object' ) return slot;
			const clone = {
				...slot,
				...( slot.source && typeof slot.source === 'object' ? { source: { ...slot.source } } : {} ),
			};
			if ( slot._liveNode ) Object.defineProperty( clone, '_liveNode', {
				value: slot._liveNode,
				enumerable: false,
				configurable: true,
				writable: true,
			} );
			return clone;

		} ) : group.slots;
		return { ...group, ...( Array.isArray( group.slots ) ? { slots } : {} ) };

	} );
	annotateLiveUniformIdentities( plan, material );
	return plan;

}

function nestedComputeArtifact( artifact, kernelIndex, material ) {

	if ( ! artifact ) return null;
	// Compute cache keys are process-local flat-array routing metadata. A nested
	// material descriptor is owner-local, so normalize the key to its canonical
	// kernel order and clone the live-uniform slots before stamping owner-local
	// paths. A shared standalone compute artifact must not retain the first
	// material owner's graph identity.
	return {
		...artifact,
		cacheKey: kernelIndex + 1,
		uniformPlan: cloneMaterialComputeUniformPlan( artifact.uniformPlan, material ),
	};

}

const MATERIAL_COMPUTE_LIFECYCLE_CONFIG_BY_PHASE = Object.freeze( {
	update: Object.freeze( { list: 'updateNodes', typeMethod: 'getUpdateType', typeField: 'updateType', updateMethod: 'update' } ),
	'update-before': Object.freeze( { list: 'updateBeforeNodes', typeMethod: 'getUpdateBeforeType', typeField: 'updateBeforeType', updateMethod: 'updateBefore' } ),
	'update-after': Object.freeze( { list: 'updateAfterNodes', typeMethod: 'getUpdateAfterType', typeField: 'updateAfterType', updateMethod: 'updateAfter' } ),
} );
const MATERIAL_COMPUTE_LIFECYCLE_CONFIG = Object.freeze( MATERIAL_COMPUTE_LIFECYCLE_PHASES.map( ( phase ) => Object.freeze( {
	phase,
	...MATERIAL_COMPUTE_LIFECYCLE_CONFIG_BY_PHASE[ phase ],
} ) ) );

function materialComputeLifecycleType( node, config ) {

	let updateType = node && node[ config.typeField ];
	if ( node && typeof node[ config.typeMethod ] === 'function' ) {

		try { updateType = node[ config.typeMethod ](); } catch ( _ ) { return null; }

	}
	if ( typeof node?.updateReference !== 'function' || typeof node?.[ config.updateMethod ] !== 'function' ) return null;
	return MATERIAL_COMPUTE_UPDATE_TYPE_SET.has( updateType ) ? updateType : null;

}

function extractMaterialComputeKernelUpdates( state, material, kernelId, reasons ) {

	const updates = [];
	for ( const config of MATERIAL_COMPUTE_LIFECYCLE_CONFIG ) {

		const nodes = Array.isArray( state && state[ config.list ] ) ? state[ config.list ] : [];
		let serializedOrder = 0;
		for ( let order = 0; order < nodes.length; order ++ ) {

			const node = nodes[ order ];
			if ( isRawMaterialComputeNode( node ) ) {

				addCanonicalReason( reasons, `${ kernelId }:${ config.phase }-update:${ order }:nested-compute` );
				continue;

			}
			const nodePath = findLiveNodePathOnMaterial( material, node );
			const updateType = materialComputeLifecycleType( node, config );
			if ( ! nodePath || ! updateType ) {

				addCanonicalReason( reasons, `${ kernelId }:${ config.phase }-update:${ order }:unresolved` );
				continue;

			}
			updates.push( { phase: config.phase, order: serializedOrder ++, nodePath, updateType } );

		}

	}
	return updates;

}

function orderedBindingKind( entry ) {

	if ( ! entry ) return null;
	if ( entry.type === 'ubo' || entry.type === 'buffer-uniform' ) return 'uniform-buffer';
	if ( entry.type === 'sampled-texture' || entry.type === 'sampler' || entry.type === 'storage-buffer' ) return entry.type;
	return entry.type === 'unknown' ? 'unknown' : null;

}

function hasExactSerializedBindingLayout( state, artifact ) {

	const rawGroups = Array.isArray( state && state.bindings ) ? state.bindings : [];
	const descriptorGroups = Array.isArray( artifact && artifact.bindings ) ? artifact.bindings : [];
	const planGroups = Array.isArray( artifact && artifact.uniformPlan ) ? artifact.uniformPlan : [];
	if ( rawGroups.length !== descriptorGroups.length || rawGroups.length !== planGroups.length ) return false;
	for ( let group = 0; group < rawGroups.length; group ++ ) {

		const rawBindings = Array.isArray( rawGroups[ group ] && rawGroups[ group ].bindings ) ? rawGroups[ group ].bindings : [];
		const descriptors = Array.isArray( descriptorGroups[ group ] && descriptorGroups[ group ].bindings ) ? descriptorGroups[ group ].bindings : [];
		const ordered = Array.isArray( planGroups[ group ] && planGroups[ group ].orderedBindings ) ? planGroups[ group ].orderedBindings : [];
		if ( rawBindings.length !== descriptors.length || rawBindings.length !== ordered.length ) return false;
		for ( let binding = 0; binding < descriptors.length; binding ++ ) {

			if ( orderedBindingKind( ordered[ binding ] ) !== descriptors[ binding ].kind ) return false;

		}

	}
	return true;

}

function addCanonicalReason( reasons, reason ) {

	if ( ! reasons.includes( reason ) ) reasons.push( reason );

}

function validMaterialComputeUserPath( value ) {

	return Array.isArray( value ) && value.length > 0 && value.every( ( segment ) => typeof segment === 'string' && segment.length > 0 );

}

function validMaterialComputeStoragePath( value ) {

	return validMaterialComputeUserPath( value ) && value.length > 1;

}

function exactMaterialComputeArraySnapshot( value, resource ) {

	return Array.isArray( value ) && value.length === resource.count * resource.itemSize;

}

function materialComputeRenderBindingProvidesInitialState( renderArtifact, entry, resource ) {

	if ( ! renderArtifact || ! entry || ! resource || resource.kind !== 'storage-buffer' ) return false;
	let serialized = null;
	if ( entry.kind === 'attribute' ) {

		serialized = Array.isArray( renderArtifact.attributes ) ? renderArtifact.attributes[ entry.attribute ] : null;

	} else if ( entry.kind === 'storage-buffer' ) {

		const group = Array.isArray( renderArtifact.uniformPlan ) ? renderArtifact.uniformPlan[ entry.group ] : null;
		const ordered = group && Array.isArray( group.orderedBindings ) ? group.orderedBindings[ entry.binding ] : null;
		serialized = ordered && ordered.ref || null;

	}
	return !! serialized && (
		validMaterialComputeStoragePath( serialized.userPath ) ||
		exactMaterialComputeArraySnapshot( serialized.arraySnapshot, resource )
	);

}

function hasUnresolvedMaterialComputeLiveUniform( artifact ) {

	for ( const group of artifact && Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [] ) {

		for ( const slot of group && Array.isArray( group.slots ) ? group.slots : [] ) {

			const source = slot && slot.source;
			if ( source && source.kind === 'uniform.live' && ! validMaterialComputeUserPath( source.nodePath ) ) return true;

		}

	}
	return false;

}

/**
 * Build the optional variant-local material-compute descriptor from exact
 * NodeBuilderState object identity. No UUID, shape, name, or array-length
 * fallback is permitted at this boundary.
 *
 * @param {Object} renderArtifact
 * @param {Object} renderState
 * @param {Map<Object,Object>} computeArtifactsByNode
 * @param {Map<Object,Object>} computeStatesByNode
 * @return {?Object}
 */
export function extractMaterialComputeDescriptor( renderArtifact, renderState, computeArtifactsByNode, computeStatesByNode, sharedComputeNodes = null, material = null ) {

	const updateBeforeNodes = Array.isArray( renderState && renderState.updateBeforeNodes ) ? renderState.updateBeforeNodes : [];
	const scheduleNodes = updateBeforeNodes
		.map( ( node, order ) => ( { node, order } ) )
		.filter( ( entry ) => isRawMaterialComputeNode( entry.node ) );
	if ( scheduleNodes.length === 0 ) return null;

	const reasons = [];
	if ( scheduleNodes.length !== updateBeforeNodes.length ) addCanonicalReason( reasons, 'schedule:non-compute-update-before' );
	const kernels = [];
	const kernelNodes = [];
	const kernelIdByNode = new Map();
	const schedule = [];
	for ( const { node, order } of scheduleNodes ) {

		let kernelId = kernelIdByNode.get( node );
		if ( ! kernelId ) {

			const kernelIndex = kernels.length;
			kernelId = `kernel:${ kernelIndex }`;
			kernelIdByNode.set( node, kernelId );
			const artifact = computeArtifactsByNode && computeArtifactsByNode.get( node ) || null;
			const state = computeStatesByNode && computeStatesByNode.get( node ) || null;
			const nodePath = findLiveNodePathOnMaterial( material, node );
			const nestedArtifact = nestedComputeArtifact( artifact, kernelIndex, material );
			const updates = extractMaterialComputeKernelUpdates( state, material, kernelId, reasons );
			kernels.push( { id: kernelId, nodePath, updates, artifact: nestedArtifact } );
			kernelNodes.push( node );
			if ( ! nodePath ) addCanonicalReason( reasons, `${ kernelId }:node-path-unavailable` );
			if ( ! artifact ) addCanonicalReason( reasons, `${ kernelId }:artifact-unavailable` );
			if ( nestedArtifact && hasUnresolvedMaterialComputeLiveUniform( nestedArtifact ) ) addCanonicalReason( reasons, `${ kernelId }:live-uniform-unresolved` );
			if ( nestedArtifact && hasUnresolvedMaterialComputeTexture( nestedArtifact ) ) addCanonicalReason( reasons, `${ kernelId }:texture-source-unresolved` );
			if ( typeof node.onInitFunction === 'function' ) addCanonicalReason( reasons, `${ kernelId }:on-init-function` );

		}
		const updateType = computeNodeUpdateType( node );
		if ( ! updateType ) addCanonicalReason( reasons, `${ kernelId }:update-type-unavailable` );
		if ( sharedComputeNodes && sharedComputeNodes.has( node ) && ( updateType === 'frame' || updateType === 'render' ) ) {

			addCanonicalReason( reasons, `${ kernelId }:shared-${ updateType }-schedule` );

		}
		schedule.push( {
			kernel: kernelId,
			phase: 'update-before',
			order,
			updateType: updateType || 'object',
		} );

	}

	const resources = [];
	const resourceByIdentity = new Map();
	const bindings = [];
	const resourceFor = ( evidence ) => {

		if ( ! evidence || ! evidence.identity ) return null;
		let resource = resourceByIdentity.get( evidence.identity );
		if ( resource ) return resource;
		resource = {
			id: `resource:${ resources.length }`,
			kind: evidence.kind,
			...evidence.metadata,
		};
		resources.push( resource );
		resourceByIdentity.set( evidence.identity, resource );
		return resource;

	};

	for ( let kernelIndex = 0; kernelIndex < kernels.length; kernelIndex ++ ) {

		const kernel = kernels[ kernelIndex ];
		const node = kernelNodes[ kernelIndex ];
		const state = computeStatesByNode && computeStatesByNode.get( node ) || null;
		if ( ! state ) {

			addCanonicalReason( reasons, `${ kernel.id }:state-unavailable` );
			continue;

		}
		const hasExactBindingLayout = ! kernel.artifact || hasExactSerializedBindingLayout( state, kernel.artifact );
		if ( ! hasExactBindingLayout ) {

			addCanonicalReason( reasons, `${ kernel.id }:binding-layout-unavailable` );
			continue;

		}
		for ( let group = 0; group < ( state.bindings || [] ).length; group ++ ) {

			const rawGroup = state.bindings[ group ];
			for ( let binding = 0; binding < ( rawGroup && rawGroup.bindings || [] ).length; binding ++ ) {

				const rawBinding = rawGroup.bindings[ binding ];
				const evidence = computeResourceEvidence( rawBinding );
				if ( ! evidence ) continue;
				const location = `${ kernel.id }:binding:${ group }:${ binding }`;
				const resource = resourceFor( evidence );
				if ( ! resource ) {

					addCanonicalReason( reasons, `${ location }:resource-identity-unavailable` );
					continue;

				}
				const access = MATERIAL_COMPUTE_ACCESS_MODE_SET.has( rawBinding.access ) ? rawBinding.access : 'readWrite';
				if ( ! MATERIAL_COMPUTE_ACCESS_MODE_SET.has( rawBinding.access ) ) {

					addCanonicalReason( reasons, `${ location }:access-unavailable` );

				}
				bindings.push( {
					kernel: kernel.id,
					resource: resource.id,
					group,
					binding,
					access,
				} );
				if ( resource.kind === 'storage-texture' ) addCanonicalReason( reasons, `${ resource.id }:storage-texture` );

			}

		}

	}

	const renderBindings = [];
	const seenRenderBindings = new Set();
	const addRenderBinding = ( entry ) => {

		const key = JSON.stringify( entry );
		if ( seenRenderBindings.has( key ) ) return;
		seenRenderBindings.add( key );
		renderBindings.push( entry );

	};
	for ( let attribute = 0; attribute < ( renderState.nodeAttributes || [] ).length; attribute ++ ) {

		const rawAttribute = renderState.nodeAttributes[ attribute ];
		const identity = rawAttribute && rawAttribute.node && rawAttribute.node.attribute || rawAttribute && rawAttribute.attribute || null;
		const resource = identity && resourceByIdentity.get( identity );
		if ( resource ) addRenderBinding( { resource: resource.id, kind: 'attribute', attribute } );

	}
	for ( let group = 0; group < ( renderState.bindings || [] ).length; group ++ ) {

		const rawGroup = renderState.bindings[ group ];
		for ( let binding = 0; binding < ( rawGroup && rawGroup.bindings || [] ).length; binding ++ ) {

			const evidence = computeResourceEvidence( rawGroup.bindings[ binding ] );
			const resource = evidence && evidence.identity && resourceByIdentity.get( evidence.identity );
			if ( resource ) addRenderBinding( { resource: resource.id, kind: resource.kind, group, binding } );

		}

	}

	renderBindings.sort( ( left, right ) => {

		const leftResource = Number( left.resource.slice( 'resource:'.length ) );
		const rightResource = Number( right.resource.slice( 'resource:'.length ) );
		if ( leftResource !== rightResource ) return leftResource - rightResource;
		const leftKind = left.kind === 'attribute' ? 0 : left.kind === 'storage-buffer' ? 1 : 2;
		const rightKind = right.kind === 'attribute' ? 0 : right.kind === 'storage-buffer' ? 1 : 2;
		return leftKind - rightKind || ( left.group ?? - 1 ) - ( right.group ?? - 1 ) || ( left.binding ?? - 1 ) - ( right.binding ?? - 1 ) || ( left.attribute ?? - 1 ) - ( right.attribute ?? - 1 );

	} );
	for ( const resource of resources ) {

		if ( ! renderBindings.some( ( entry ) => entry.resource === resource.id ) ) addCanonicalReason( reasons, `${ resource.id }:render-binding-unavailable` );
		if ( resource.kind === 'storage-buffer' && ! renderBindings.some( ( entry ) =>
			entry.resource === resource.id && materialComputeRenderBindingProvidesInitialState( renderArtifact, entry, resource )
		) ) addCanonicalReason( reasons, `${ resource.id }:initial-state-unavailable` );

	}

	reasons.sort();
	return {
		version: MATERIAL_COMPUTE_VERSION,
		mode: reasons.length === 0 ? 'precompiled' : 'hybrid-required',
		reasons,
		resources,
		kernels,
		bindings,
		renderBindings,
		schedule,
	};

}

/**
 * Build a `uuid → Texture` map from every texture binding in the state so
 * the runtime hydrator can resolve `artifact.texture` source kinds without
 * the builder tree.
 *
 * @param {Object} state - A built NodeBuilderState.
 * @return {Map<string, Texture>}
 */
function collectTextureRefs( state ) {

	const refs = new Map();
	if ( ! Array.isArray( state.bindings ) ) return refs;

	for ( const bindGroup of state.bindings ) {

		for ( const binding of bindGroup.bindings ) {

			if ( binding.isSampledTexture ) {

				const textureNode = binding.textureNode;
				const tex = textureNode ? textureNode.value : null;
				if ( tex && tex.isTexture && tex.uuid ) refs.set( tex.uuid, tex );

			}

		}

	}

	return refs;

}

function collectMaterialDefaults( uniformPlan, material, bindingOwnerKind = RENDER_BINDING_OWNER_KINDS.MATERIAL ) {

	if ( ! material ) return {};

	const defaults = {};
	for ( const group of uniformPlan ) {

		for ( const slot of group.slots ) {

			const kind = slot.source && slot.source.kind;
			if ( typeof kind !== 'string' || ! kind.startsWith( 'material.' ) ) continue;
			const sourceBindingOwner = slot.source.bindingOwner || bindingOwnerKind;
			if ( sourceBindingOwner === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER ) continue;

			const property = slot.source.property;
			if ( ! property || property in defaults ) continue;

			const value = material[ property ];
			if ( value === undefined || value === null ) continue;

			if ( typeof value === 'number' ) {

				defaults[ property ] = value;

			} else if ( value.isColor ) {

				defaults[ property ] = { type: 'color', data: [ value.r, value.g, value.b ] };

			} else if ( value.isVector2 ) {

				defaults[ property ] = { type: 'vec2', data: [ value.x, value.y ] };

			} else if ( value.isVector3 ) {

				defaults[ property ] = { type: 'vec3', data: [ value.x, value.y, value.z ] };

			} else if ( value.isVector4 ) {

				defaults[ property ] = { type: 'vec4', data: [ value.x, value.y, value.z, value.w ] };

			}

		}

	}

	return defaults;

}

/**
 * Capture material render-state flags that drive pipeline construction.
 * These need to land on the PrecompiledMaterial at runtime so three.js's
 * pipeline cache key + bind-group setup match what the source material
 * intended (transparent sprites, BackSide skybox, additive particles, etc.).
 *
 * Boolean / numeric flags only. Object properties (blendEquation, etc.)
 * are referenced by integer constants on three.js's side and survive a
 * JSON round-trip cleanly.
 *
 * @param {?Material} material
 * @return {Object}
 */
function collectMaterialRenderState( material ) {

	if ( ! material ) return {};
	const out = {};
	const props = [
		'transparent', 'opacity', 'alphaTest', 'alphaHash', 'alphaToCoverage',
		'side', 'depthTest', 'depthWrite', 'depthFunc',
		'blending', 'blendSrc', 'blendDst', 'blendEquation',
		'blendSrcAlpha', 'blendDstAlpha', 'blendEquationAlpha',
		'colorWrite', 'premultipliedAlpha', 'dithering', 'toneMapped',
		'vertexColors', 'wireframe', 'wireframeLinewidth',
		'flatShading', 'fog', 'lights', 'allowOverride',
		'forceSinglePass', 'sizeAttenuation', 'dashed', 'shadowSide',
		'polygonOffset', 'polygonOffsetFactor',
		'polygonOffsetUnits', 'stencilWrite', 'stencilWriteMask',
		'stencilFunc', 'stencilRef', 'stencilFuncMask',
		'stencilFail', 'stencilZFail', 'stencilZPass',
	];
	for ( const key of props ) {

		const value = material[ key ];
		if ( value === undefined || value === null ) continue;
		const t = typeof value;
		if ( t === 'boolean' || t === 'number' ) out[ key ] = value;

	}
	return out;

}

/**
 * Collect the MRT node to use for the warm-up render.
 *
 * Priority:
 *   1. `options.mrtNode` — caller explicitly provided the MRT descriptor.
 *   2. `options.noGlobalMRT === true` — caller forces single-output path
 *      (used by aux captures whose throwaway scenes are single-output by
 *      design and must not inherit a global MRT).
 *   3. `scene.userData.__tslp_mrtNode` — the dominant three.js MRT pattern
 *      is `pass(scene, camera).setMRT(mrt({...}))` on a PassNode owned by
 *      `postProcessing`. The PassNode never reaches the scene graph, and
 *      `setMRT` only writes `material.mrtNode` once the pass actually
 *      renders — too late for our synthetic warm-up. The aux-marker
 *      stamps the discovered `passNode._mrt` here so this 5th-source-
 *      walker can short-circuit before sources 4–5 give up.
 *   4. Auto-detect: walk scene materials looking for any material that has
 *      an `mrtNode` property set (three.js NodeMaterial stores it there
 *      when `PassNode.setMRT()` wires it). The first non-null one wins.
 *   5. Renderer-level MRT fallback (`renderer.getMRT()`). Hosts that drive
 *      multi-render-targets with `renderer.setMRT(mrt({...}))` globally
 *      (the `webgpu_multiple_rendertargets` pattern) end up with no
 *      per-material `mrtNode` on the synthetic capture scene's mesh, so
 *      without this fallback `compileTSL` would emit a single-output
 *      fragment that mismatches the live multi-attachment render target.
 *      Skipped when the scene contains only fullscreen quads
 *      (post-process / render-output throwaway scenes), which always
 *      target a single attachment.
 *
 * Returns `null` when no MRT is found so the caller can skip `setMRT`.
 *
 * @param {?Renderer} renderer
 * @param {?Scene} scene
 * @param {Object} options
 * @return {Object|null} MRT node or null.
 */
function collectSceneMRTNode( renderer, scene, options ) {

	if ( options && options.mrtNode ) return options.mrtNode;
	if ( options && options.noGlobalMRT ) return null;

	if ( scene && scene.userData && scene.userData.__tslp_mrtNode ) {

		return scene.userData.__tslp_mrtNode;

	}

	if ( scene && typeof scene.traverse === 'function' ) {

		let found = null;
		scene.traverse( ( object ) => {

			if ( found ) return;
			const material = object && object.material;
			if ( ! material ) return;

			const materials = Array.isArray( material ) ? material : [ material ];
			for ( const mat of materials ) {

				if ( mat && mat.mrtNode ) {

					found = mat.mrtNode;
					return;

				}

			}

		} );

		if ( found ) return found;

	}

	if ( renderer && typeof renderer.getMRT === 'function' ) {

		if ( scene && typeof scene.traverse === 'function' ) {

			let onlyFullscreenQuads = true;
			let sawAnyMesh = false;
			scene.traverse( ( object ) => {

				if ( ! object || ! object.material ) return;
				sawAnyMesh = true;
				const isQuad = object.isQuadMesh || ( object.constructor && object.constructor.name === 'QuadMesh' );
				if ( ! isQuad ) onlyFullscreenQuads = false;

			} );
			if ( sawAnyMesh && onlyFullscreenQuads ) return null;

		}

		return renderer.getMRT() || null;

	}

	return null;

}

function sceneMaterialOwnsMRTNode( scene, mrtNode ) {

	if ( ! scene || ! mrtNode || typeof scene.traverse !== 'function' ) return false;
	let found = false;
	scene.traverse( ( object ) => {

		if ( found ) return;
		const material = object && object.material;
		const materials = Array.isArray( material ) ? material : material ? [ material ] : [];
		found = materials.some( mat => mat && mat.mrtNode === mrtNode );

	} );
	return found;

}

/**
 * Precompile every node material reachable via `renderer.compileAsync` and
 * return an array of serializable artifacts (one per unique cache key).
 *
 * Compute shaders are handled when the caller passes `options.computeNodes`
 * — each one is built with `renderer.computeAsync` (which triggers the
 * NodeManager's compute-side builder) and emitted as a separate artifact
 * with `kind: 'compute'`. Call-site pairs each compute artifact with the
 * same compute node identity via the `byComputeNode` map on the return.
 *
 * Post-processing: pass a `renderPipeline` so the warm-up render goes
 * through `renderPipeline.renderAsync()` instead of the plain renderer.
 * This forces each pass (and the final output quad) to compile into
 * `nodeBuilderCache`, so chains of bloom / FXAA / output-transform land
 * as regular artifacts.
 *
 * MRT: when any scene material carries an `mrtNode`, or when the caller
 * passes `options.mrtNode`, that MRT descriptor is activated on the renderer
 * before the warm-up render so three.js emits a multi-output fragment shader
 * (`@location(0)`, `@location(1)`, …) rather than a single-output one.
 * The MRT state is always restored to `null` after the warm-up.
 *
 * @param {Renderer} renderer
 * @param {Scene} scene
 * @param {Camera} camera
 * @param {Object} [options]
 * @param {Array<Node>} [options.computeNodes] - Compute nodes to precompile.
 * @param {RenderPipeline} [options.renderPipeline] - Post-process pipeline to warm up.
 * @param {Object} [options.mrtNode] - Explicit MRT node to activate during warm-up.
 * @param {Object} [options.renderTargetOverride] - Pre-allocated three RenderTarget
 *   to bind during the warm-up render. Used by aux captures whose material emits
 *   a non-default fragment-output shape (e.g. DOF's `_CoCMaterial` uses
 *   `outputStruct(near, far)` against a 2-attachment RedFormat/HalfFloat RT).
 *   When provided, takes precedence over the auto-allocated MRT warm-up RT.
 * @param {boolean} [options.captureRendererOutput=false] - Drive the real
 *   renderer output pass, correlate its active private quad to the exact
 *   observed NodeManager cache entry, and expose the artifact/config pair on
 *   the returned array's non-enumerable `renderOutputCapture` sidecar.
 * @param {Object} [options.rendererOutputConfig] - Renderer-output topology
 *   observed by the caller. Tone mapping and output color space are restored
 *   transactionally inside the renderer compile lock so a short-lived output
 *   mode queued behind another capture is still extracted exactly.
 * @param {Object|Promise<Object>} [options.renderObjectHarvest] - Completed
 *   beginRenderObjectHarvest() result (or its session/Promise) from the
 *   application's real render. Complete material families are preferred
 *   atomically over synthetic extraction.
 * @param {boolean} [options.skipWarmupRender=false] - Skip the extra synthetic render after compileAsync.
 * @return {Promise<Array<PrecompiledArtifact>>}
 */
export async function compileTSL( renderer, scene, camera, options = {} ) {

	const manager = renderer._nodes;
	if ( ! manager ) return [];

	// Serialise concurrent calls per renderer. Multiple `precompile()` and
	// aux-capture microtasks queued during a single user `render()` would
	// otherwise interleave on each `await` and clobber each other's saved
	// MRT / renderTarget state. Without a lock, an aux capture's MRT-clear
	// can leak into a concurrent precompile-marker call so the user
	// material extracts as single-output instead of multi-output. The lock
	// keeps each compileTSL's MRT/RT save → mutate → restore cycle atomic.
	const lockKey = '__tslpCompileLock';
	const prevLock = renderer[ lockKey ] || Promise.resolve();
	let releaseLock;
	const myLock = new Promise( ( resolve ) => { releaseLock = resolve; } );
	renderer[ lockKey ] = prevLock.then( () => myLock );
	let result;
	try {

		await prevLock;
		result = await compileTSLInner( renderer, scene, camera, options, manager );

	} finally {

		releaseLock();

	}
	return result;

}

async function resolveRenderObjectHarvest( value, renderer ) {

	if ( ! value ) return null;
	let resolved = value;
	if ( typeof resolved.finish === 'function' ) resolved = resolved.finish();
	resolved = await resolved;
	if ( ! resolved || ! ( resolved.familiesByMaterial instanceof Map ) ) return null;
	return ! resolved.renderer || resolved.renderer === renderer ? resolved : null;

}

function addMaterialComputeNodesFromState( state, computeNodes, computeNodeSet ) {

	for ( const node of Array.isArray( state && state.updateBeforeNodes ) ? state.updateBeforeNodes : [] ) {

		if ( ! isRawMaterialComputeNode( node ) || computeNodeSet.has( node ) ) continue;
		computeNodeSet.add( node );
		computeNodes.push( node );

	}

}

function cachedComputeState( manager, computeNode, requireExisting = false ) {

	if ( ! manager || typeof manager.get !== 'function' ) return null;
	if ( requireExisting ) {

		let exists = false;
		try {

			if ( typeof manager.has === 'function' ) exists = manager.has( computeNode );
			else if ( manager.data && typeof manager.data.has === 'function' ) exists = manager.data.has( computeNode );

		} catch ( _ ) { /* treat an opaque cache as unavailable */ }
		if ( ! exists ) return null;

	}
	try {

		const data = manager.get( computeNode );
		return data && data.nodeBuilderState || null;

	} catch ( _ ) {

		return null;

	}

}

async function compileTSLInner( renderer, scene, camera, options, manager ) {

	const explicitComputeNodes = Array.isArray( options.computeNodes ) ? options.computeNodes.slice() : [];
	const computeNodes = explicitComputeNodes.slice();
	const computeNodeSet = new Set( computeNodes );
	const explicitComputeNodeSet = new Set( computeNodes );
	const computeStatesByNode = new Map();
	const renderPipeline = options.renderPipeline || null;
	const captureRendererOutput = options.captureRendererOutput === true;
	const rendererOutputConfig = captureRendererOutput && options.rendererOutputConfig || null;
	// A marker may bracket the application's completed real render with
	// beginRenderObjectHarvest() and hand the immutable result in here. Prefer
	// those exact RenderObjects later; this synthetic compile remains available
	// as an all-or-nothing fallback for an incomplete real family.
	const suppliedRenderObjectHarvest = await resolveRenderObjectHarvest( options.renderObjectHarvest, renderer );
	const renderOutputObservations = [];
	let renderOutputIdentity = null;

	// Detect the MRT node to activate during warm-up. Resolved POST-lock so
	// we observe the renderer's MRT in a quiescent moment (no concurrent aux
	// capture has it cleared). Must be resolved before the getForRender
	// hook is installed so the hook can record it for artifact stamping in
	// the extraction pass below.
	const sceneMRTNode = collectSceneMRTNode( renderer, scene, options );

	// Materials carrying their OWN mrt() node cannot build against the
	// single-output canvas/framebuffer warm-up target used when no
	// pass/global MRT is active: MRTNode.setup() resolves each output name
	// against the bound render target's texture names, gets index -1, and
	// emits an empty output struct — the node build then dies with "Cannot
	// read properties of undefined (reading 'type')" and three silently
	// swaps in a blank NodeMaterial (webgpu_postprocessing_bloom_selective).
	// These no-MRT compiles (aux background/lights captures over the live
	// scene, non-MRT sibling variants) don't want those materials' MRT
	// variants anyway — strip the node for the duration and restore on exit.
	// `needsUpdate` is deliberately NOT touched: if the render cache already
	// holds the MRT variant it's simply reused (no rebuild, no crash) and
	// the app's live pipelines stay valid.
	const strippedMRTMaterials = [];
	if ( ! sceneMRTNode && scene && typeof scene.traverse === 'function' ) {

		scene.traverse( ( object ) => {

			const material = object && object.material;
			const list = Array.isArray( material ) ? material : material ? [ material ] : [];
			for ( const mat of list ) {

				if ( mat && mat.mrtNode ) {

					strippedMRTMaterials.push( [ mat, mat.mrtNode ] );
					mat.mrtNode = null;

				}

			}

		} );

	}

	// Temporarily wrap NodeManager.getForRender so we can see every
	// renderObject that flows through the build path during compileAsync.
	// For each one, record (cacheKey → material, mesh) so the artifacts we
	// emit can be attributed to real materials — not guessed via a
	// single-material fallback.
	const materialByCacheKey = new Map();
	const meshesByCacheKey = new Map();
	const renderContextSelectorsByMaterial = new Map();
	const renderContextSelectorsWithoutMaterial = new Map();
	const selectorsFor = ( material, cacheKey, create = false ) => {

		if ( ! material ) {

			let selectors = renderContextSelectorsWithoutMaterial.get( cacheKey );
			if ( ! selectors && create ) renderContextSelectorsWithoutMaterial.set( cacheKey, selectors = new Set() );
			return selectors || null;

		}
		let byCacheKey = renderContextSelectorsByMaterial.get( material );
		if ( ! byCacheKey && create ) renderContextSelectorsByMaterial.set( material, byCacheKey = new Map() );
		if ( ! byCacheKey ) return null;
		let selectors = byCacheKey.get( cacheKey );
		if ( ! selectors && create ) byCacheKey.set( cacheKey, selectors = new Set() );
		return selectors || null;

	};
	const recordRenderObject = ( { renderObject, cacheKey, requestSnapshot = null } ) => {

		if ( cacheKey === null || cacheKey === undefined ) return;
		const observedMaterial = requestSnapshot && requestSnapshot.material || renderObject && renderObject.material || null;
		const observedObject = requestSnapshot && requestSnapshot.object || renderObject && renderObject.object || null;
		// Record every observed material and correlate only after the render,
		// when Renderer._quadCache tells us which private quad was active. Do
		// not pre-filter by Three's private material name: downstream wrappers
		// and version changes may rename it while preserving UUID ownership.
		if ( captureRendererOutput && observedMaterial ) {

			const materialUuid = observedMaterial.uuid || null;
			if ( materialUuid && ! renderOutputObservations.some( ( entry ) => entry.cacheKey === cacheKey && entry.materialUuid === materialUuid ) ) {

				renderOutputObservations.push( { cacheKey, materialUuid } );

			}

		}
		let selector = requestSnapshot && requestSnapshot.renderContextSelector || '';
		if ( ! selector && ! selectorsFor( observedMaterial, cacheKey ) ) {

			try {

				selector = createRenderObjectContextSelector( renderObject, renderer );

			} catch ( _ ) {

				// A custom/proxied RenderObject may refuse reflection. Keep material
				// attribution intact; this cache entry remains an unsigned legacy
				// variant and is rejected by the family validator if siblings are signed.

			}

		}
		if ( selector ) {

			selectorsFor( observedMaterial, cacheKey, true ).add( selector );

		}

		// Record BOTH the node material (which the extractor introspects
		// for shape + defaults) AND the user-facing material on the object
		// (which hydrateScene looks up via obj.material.uuid). For
		// MeshPhysicalMaterial and friends wrapped in node variants at
		// render time, these two are different instances.
		if ( observedMaterial && ! materialByCacheKey.has( cacheKey ) ) {

			materialByCacheKey.set( cacheKey, observedMaterial );

		}

		// Also record the object's visible material for byMaterialUuid
		// lookups. hydrateScene walks the scene and reads obj.material.uuid —
		// that may be the pre-wrap material (e.g. MeshPhysicalMaterial)
		// when three.js internally wraps it in MeshPhysicalNodeMaterial.
		if ( observedObject && observedObject.material &&
			observedObject.material !== observedMaterial ) {

			if ( ! materialByCacheKey.has( cacheKey + ':user' ) ) {

				materialByCacheKey.set( cacheKey + ':user', observedObject.material );

			}

		}

		let list = meshesByCacheKey.get( cacheKey );
		if ( ! list ) meshesByCacheKey.set( cacheKey, list = [] );
		if ( observedObject && ! list.includes( observedObject ) ) list.push( observedObject );

	};

	// Always save the live render target so we can isolate the synthetic
	// warm-up from any RT the host already had bound. When the host app is in
	// the middle of `setRenderTarget(userRT); renderer.render(...)` and our
	// dev-capture microtask runs in between, our `compileAsync` would
	// otherwise compile against `userRT` — so a single-output post-process
	// material ends up with a pipeline that targets the user's count=N MRT,
	// which fails WebGPU validation ("Color target has no corresponding
	// fragment stage output but writeMask is not zero"). Save it
	// unconditionally and restore in the `finally` block.
	const prevRenderTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
	const prevActiveCubeFace = typeof renderer.getActiveCubeFace === 'function' ? renderer.getActiveCubeFace() : 0;
	const prevActiveMipmapLevel = typeof renderer.getActiveMipmapLevel === 'function' ? renderer.getActiveMipmapLevel() : 0;
	const rendererStateSnapshot = {
		hasAutoClear: !! renderer && 'autoClear' in renderer,
		autoClear: renderer && renderer.autoClear,
		xr: renderer && renderer.xr || null,
		hasXREnabled: !! ( renderer && renderer.xr ) && 'enabled' in renderer.xr,
		xrEnabled: renderer && renderer.xr && renderer.xr.enabled,
		hasToneMapping: !! renderer && 'toneMapping' in renderer,
		toneMapping: renderer && renderer.toneMapping,
		hasOutputColorSpace: !! renderer && 'outputColorSpace' in renderer,
		outputColorSpace: renderer && renderer.outputColorSpace,
	};
	let frameBufferWarmupRT = null;

	// MRT warm-up render target. NodeMaterial.setup() in three.js gates the
	// MRT-output path on `renderTarget !== null` — without a bound RT, even
	// `renderer.setMRT(...)` is silently ignored and the fragment shader is
	// compiled with a single `@location(0)` output. To force the MRT shader
	// path, we allocate a throwaway N-texture RenderTarget sized 1×1 and
	// bind it for the warm-up render. The RT's `textures` array is named so
	// `MRTNode.setup()`'s per-output-name lookup finds each member.
	// Restored to null in the finally block.
	//
	// Only allocated when outputCount > 1. count=1 mrtNode (e.g.
	// webgpu_mrt_mask's per-material `mrt({ mask: ... })`) needs the
	// surrounding pass-level MRT for proper @location emission; allocating a
	// count=1 named RT here would emit a single-`mask` output struct that
	// the live count=2 RT then rejects. End-to-end MRT-merge handling is
	// owned by Round 4-H.
	// Caller-supplied RenderTarget override. Used by aux captures whose
	// material emits a non-default fragment-output shape — e.g. DOF's
	// `_CoCMaterial.outputNode = outputStruct(near, far)` produces 2
	// single-component RedFormat/HalfFloat outputs. Without binding a
	// matching RT, the WGSL validator complains:
	//   "fragment stage has fewer output components (1) than the color
	//    format (RGBA16Float) component count (4)"
	// because three.js defaults the synthetic compile to a 4-component
	// RGBA color attachment. The override takes precedence over the
	// auto-allocated MRT warm-up RT below.
	const renderTargetOverride = options && options.renderTargetOverride || null;
	let mrtWarmupRT = null;
	let ownsMRTWarmupRT = false;
	if ( renderTargetOverride && typeof renderer.setRenderTarget === 'function' ) {

		mrtWarmupRT = renderTargetOverride;

	} else if ( sceneMRTNode && typeof renderer.setRenderTarget === 'function' ) {

		const outputMap = sceneMRTNode.nodes || sceneMRTNode.outputNodes || null;
		const outputNames = outputMap ? Object.keys( outputMap ) : [];
		const outputCount = outputNames.length;
		const materialOwnedSingleOutput = outputCount === 1 && sceneMaterialOwnsMRTNode( scene, sceneMRTNode );
		if ( outputCount > 1 || ( outputCount === 1 && ! materialOwnedSingleOutput ) ) {

			try {

				mrtWarmupRT = new RenderTarget( 1, 1, { count: outputCount } );
				ownsMRTWarmupRT = true;
				// Match three.js MRTNode.setup()'s `getTextureIndex(textures,
				// name)` lookup: tag each attachment with the matching output
				// name from the captured MRT graph. Without this, the
				// MRTNode.setup() write loop drops every output (no name
				// match) and emits an empty `OutputType {}` struct that
				// fails WGSL parsing.
				if ( Array.isArray( mrtWarmupRT.textures ) ) {

					for ( let i = 0; i < outputNames.length; i ++ ) {

						const tex = mrtWarmupRT.textures[ i ];
						if ( tex ) tex.name = outputNames[ i ];

					}

				}

			} catch ( _ ) {

				// Older three.js may not accept `count` here; let the warm-up
				// proceed without a bound RT — the artifact won't get the MRT
				// shader path but at least nothing throws.
				mrtWarmupRT = null;

			}

		}

	}

	// Canvas renders that need tone/color-space post-processing are built by
	// Renderer.render() against three.js's internal framebuffer target. Plain
	// compileAsync() only points _currentRenderContext at that target; it does
	// not bind it as renderer._renderTarget, so material setup code that reads
	// renderer.currentSamples (Line2NodeMaterial's alpha-to-coverage branch)
	// sees 0 samples and captures the non-MSAA shader variant. Borrow the same
	// private framebuffer target during warm-up so extraction matches live render.
	if ( ! captureRendererOutput && ! mrtWarmupRT && ! prevRenderTarget && renderer && renderer.needsFrameBufferTarget === true &&
		typeof renderer._getFrameBufferTarget === 'function' &&
		typeof renderer.setRenderTarget === 'function' ) {

		try { frameBufferWarmupRT = renderer._getFrameBufferTarget(); } catch ( _ ) { frameBufferWarmupRT = null; }

	}

	// Always save the renderer's prior MRT and restore at exit so concurrent
	// aux captures and precompile-marker calls don't observe each other's
	// transient MRT-clear. When sceneMRTNode is null we set MRT to null for
	// the duration of our synthetic compile to avoid emitting a multi-output
	// frag shader for an aux scene that targets the canvas.
	const prevMRT = typeof renderer.getMRT === 'function' ? renderer.getMRT() : null;

	// The synthetic warm-up owns renderer-level MRT/RT state across the await
	// points below. If the app's animation loop renders inside that window,
	// its pipelines build against mismatched MRT-vs-RT state — e.g. a
	// per-material `mrt()` resolves its output names against the wrong bound
	// render target, emits an empty output struct, and the node build fails
	// with "Cannot read properties of undefined (reading 'type')" — and the
	// broken NodeBuilderState lands in the shared cache. Drop app-initiated
	// renders for the duration (no replay: a render call can rely on
	// synchronous renderer state its caller set around it, e.g. PassNode's
	// RT/MRT binding, so replaying later re-renders against the wrong state).
	const origRender = typeof renderer.render === 'function' ? renderer.render : null;
	let internalRenderDepth = 0;
	if ( origRender ) {

		renderer.render = function ( ...args ) {

			if ( internalRenderDepth > 0 ) return origRender.apply( this, args );
			return undefined;

		};

	}

	let renderObjectHarvest = null;
	const renderObjectHarvestSession = beginRenderObjectHarvest( renderer, {
		onRequest: recordRenderObject,
		onState: recordRenderObject,
	} );
	try {

		// Automatic output capture may have queued behind another compile after
		// observing a short-lived tone/color-space topology. Apply that immutable
		// descriptor only after acquiring the per-renderer lock, then let the
		// existing finally block restore the host renderer transactionally.
		if ( rendererOutputConfig ) {

			if ( rendererStateSnapshot.hasToneMapping && rendererOutputConfig.toneMapping !== null ) {

				try { renderer.toneMapping = rendererOutputConfig.toneMapping; } catch ( _ ) { /* ignore */ }

			}
			if ( rendererStateSnapshot.hasOutputColorSpace && rendererOutputConfig.currentColorSpace !== null ) {

				try { renderer.outputColorSpace = rendererOutputConfig.currentColorSpace; } catch ( _ ) { /* ignore */ }

			}

		}

		// Activate (or clear) MRT on the renderer before the warm-up so
		// three.js emits the right output struct. Without this, the pipeline
		// is compiled with a mismatched attachment count vs the live render
		// target (single-target frag against an MRT, or vice versa).
		if ( typeof renderer.setMRT === 'function' ) {

			renderer.setMRT( sceneMRTNode || null );

		}

		// Bind the MRT warm-up RT so NodeMaterial.setup()'s
		// `renderTarget !== null` gate fires. When there's no MRT but the
		// host had a render target bound, unbind it for the duration of the
		// synthetic compile so the warm-up doesn't accidentally produce a
		// pipeline whose fragment shader doesn't match the live RT layout.
		if ( mrtWarmupRT ) {

			renderer.setRenderTarget( mrtWarmupRT );

		} else if ( frameBufferWarmupRT ) {

			renderer.setRenderTarget( frameBufferWarmupRT );

		} else if ( prevRenderTarget && typeof renderer.setRenderTarget === 'function' ) {

			renderer.setRenderTarget( null );

		}

		const restoreObjectPipeline = compileDoublePassPairsSynchronously( renderer );
		try {

			await renderer.compileAsync( scene, camera );

		} finally {

			restoreObjectPipeline();

		}

		// Compute precompile — each computeAsync call forces NodeManager
		// .getForCompute to build the pipeline and stash the state on the
		// per-compute-node DataMap entry. We also get the side-effect of a
		// real GPU dispatch; that's normally fine (compute kernels are
		// idempotent seeds in our demo) but callers can set `state._seeded`
		// to skip the init kernel on re-compile.
		for ( const computeNode of explicitComputeNodes ) {

			await renderer.computeAsync( computeNode );
			const state = cachedComputeState( manager, computeNode );
			if ( state ) computeStatesByNode.set( computeNode, state );

		}

		// Shadow + output-pass materials don't compile during `compileAsync`
		// — they're lazy-built on the first real render. Fire one render to
		// force their NodeBuilderStates into the cache. Idempotent for the
		// scene (the render output is discarded).
		//
		// If the caller passed a RenderPipeline, drive the warm-up through
		// it so post-process passes (bloom, FXAA, output transform) also
		// compile and land in nodeBuilderCache as regular artifacts.
		if ( renderPipeline ) {

			// RenderPipeline.render() is sync but requires the renderer to
			// be initialised (compileAsync already guaranteed that). It
			// drives renderer.render internally — lift the deferral gate for
			// the duration. The global flag lets outer capture-scoped render
			// guards (precompile-marker) recognise synthetic renders too.
			internalRenderDepth ++;
			globalThis.__tslpSyntheticRenderActive = ( globalThis.__tslpSyntheticRenderActive | 0 ) + 1;
			try { renderPipeline.render(); } finally {

				internalRenderDepth --;
				globalThis.__tslpSyntheticRenderActive = ( globalThis.__tslpSyntheticRenderActive | 0 ) - 1;

			}

		} else if ( ! options.skipWarmupRender ) {

			// renderer.render() is the non-deprecated entry; compileAsync
			// above already ran `init` so the sync form is safe.
			internalRenderDepth ++;
			globalThis.__tslpSyntheticRenderActive = ( globalThis.__tslpSyntheticRenderActive | 0 ) + 1;
			try { renderer.render( scene, camera ); } finally {

				internalRenderDepth --;
				globalThis.__tslpSyntheticRenderActive = ( globalThis.__tslpSyntheticRenderActive | 0 ) - 1;

			}

		}

		if ( captureRendererOutput ) {

			renderOutputIdentity = captureActiveRendererOutputIdentity( renderer, renderOutputObservations );

		}

	} finally {

		// Stop request/state observation before renderer restoration mutates the
		// shared RenderContext again. `finish()` also waits for any async
		// NodeBuilderState Promise without changing the Promise Three returned.
		const renderObjectHarvestPromise = renderObjectHarvestSession.finish();

		// Restore the renderer's MRT to whatever the host app had set before
		// our warm-up. Without this restoration, the user's next real render
		// would see `renderer.getMRT() === null` and re-build the pipeline
		// for a single-target fragment — mismatching their actual
		// multi-target RenderTarget. Always fires now since we always save
		// MRT at entry.
		if ( typeof renderer.setMRT === 'function' ) {

			try { renderer.setMRT( prevMRT ); } catch ( _ ) { /* ignore */ }

		}

		// Restore the host's render target. We always saved `prevRenderTarget`
		// at entry; restore it whether or not we allocated an mrtWarmupRT so
		// the host's `setRenderTarget(userRT)` survives our synthetic
		// compileAsync round-trip.
		if ( typeof renderer.setRenderTarget === 'function' ) {

			try { renderer.setRenderTarget( prevRenderTarget, prevActiveCubeFace, prevActiveMipmapLevel ); } catch ( _ ) { /* ignore */ }

		}

		// RenderPipeline and the renderer-owned output pass temporarily mutate
		// these properties. Treat capture as a transaction even when a nested
		// render throws, so dev extraction cannot leak state into the app.
		if ( rendererStateSnapshot.hasAutoClear ) {

			try { renderer.autoClear = rendererStateSnapshot.autoClear; } catch ( _ ) { /* ignore */ }

		}
		if ( rendererStateSnapshot.xr && rendererStateSnapshot.hasXREnabled ) {

			try { rendererStateSnapshot.xr.enabled = rendererStateSnapshot.xrEnabled; } catch ( _ ) { /* ignore */ }

		}
		if ( rendererStateSnapshot.hasToneMapping ) {

			try { renderer.toneMapping = rendererStateSnapshot.toneMapping; } catch ( _ ) { /* ignore */ }

		}
		if ( rendererStateSnapshot.hasOutputColorSpace ) {

			try { renderer.outputColorSpace = rendererStateSnapshot.outputColorSpace; } catch ( _ ) { /* ignore */ }

		}

		// Reinstate the app's render entry point. Dropped frames are not
		// replayed — the app's next animation frame repaints.
		if ( origRender ) renderer.render = origRender;

		if ( mrtWarmupRT && ownsMRTWarmupRT ) {

			try { mrtWarmupRT.dispose(); } catch ( _ ) { /* ignore */ }

		}

		for ( const [ mat, node ] of strippedMRTMaterials ) mat.mrtNode = node;
		renderObjectHarvest = await renderObjectHarvestPromise;

	}

	const cache = manager.nodeBuilderCache;
	if ( ! cache ) return [];

	const artifacts = [];
	const byMesh = new Map();
	const byMaterialUuid = new Map();
	const byMaterialVariants = new Map();
	const byAuxiliaryMaterialVariants = new Map();
	const byComputeNode = new Map();
	const materialComputeRecords = [];
	// Wedge 4: snapshot the renderer's nodeFrame.time at capture so the runtime
	// can pin it during PSNR-snapshot replay. Without this, time-driven graphs
	// (`mix(a, b, sin(time*k))`, scrolling UVs, particle position +=
	// velocity*time) drift by 1–2 animation ticks because capture and replay
	// freeze nodeFrame at slightly different t values.
	const captureClock = ( renderer && renderer._nodes && renderer._nodes.nodeFrame && Number.isFinite( renderer._nodes.nodeFrame.time ) ) ? renderer._nodes.nodeFrame.time : null;
	const extractionEntries = [];
	const suppliedCompleteOwners = new Set();
	const suppliedCompleteOwnerUuids = new Set();
	const selectedCompleteOwners = new Set();
	const selectedCompleteOwnerUuids = new Set();
	const handledPairsByMaterial = new Map();
	const selectedCacheKeys = new Set();

	const familyOwners = ( family ) => {

		const owners = new Set( family && family.material ? [ family.material ] : [] );
		for ( const variant of family && family.variants || [] ) for ( const sourceMaterial of variant.sourceMaterials || variant.userMaterials || [] ) owners.add( sourceMaterial );
		return owners;

	};
	const ownerUuid = ( owner ) => owner && owner.uuid || null;
	const familyOverlaps = ( family, owners, ownerUuids ) => {

		for ( const owner of familyOwners( family ) ) {

			if ( owners.has( owner ) ) return true;
			const uuid = ownerUuid( owner );
			if ( uuid && ownerUuids.has( uuid ) ) return true;

		}
		return false;

	};
	const markFamilyOwners = ( family, owners, ownerUuids ) => {

		for ( const owner of familyOwners( family ) ) {

			owners.add( owner );
			const uuid = ownerUuid( owner );
			if ( uuid ) ownerUuids.add( uuid );

		}

	};
	const markHandledPair = ( material, cacheKey ) => {

		let keys = handledPairsByMaterial.get( material );
		if ( ! keys ) handledPairsByMaterial.set( material, keys = new Set() );
		keys.add( cacheKey );

	};
	const addFamilyEntries = ( family, useHarvestedState ) => {

		for ( const variant of family.variants ) {

			const state = useHarvestedState ? variant.nodeBuilderState : cache.get( variant.cacheKey );
			if ( ! state ) continue;
			const firstRequest = variant.requests && variant.requests[ 0 ] || null;
			extractionEntries.push( {
				cacheKey: variant.cacheKey,
				state,
				material: family.material || null,
				sourceMaterials: variant.sourceMaterials || variant.userMaterials || [],
				sourceOwnerRequests: variant.sourceOwnerRequests || [],
				userMaterials: variant.userMaterials || [],
				meshes: variant.objects || [],
				renderContextSelectors: variant.renderContextSelectors || [],
				captureClock: variant.captureClocks && variant.captureClocks.length > 0 ? variant.captureClocks[ 0 ] : null,
				mrtNode: firstRequest && firstRequest.renderContext ? firstRequest.renderContext.mrt : null,
				hasObservedMRT: !! ( firstRequest && firstRequest.renderContext ),
				materialComputeDiscovery: true,
			} );
			selectedCacheKeys.add( variant.cacheKey );
			markHandledPair( family.material || null, variant.cacheKey );

		}

	};
	const completeFamilies = ( harvest ) => harvest && harvest.familiesByMaterial instanceof Map
		? [ ...new Set( harvest.familiesByMaterial.values() ) ].filter( ( family ) => family && family.complete && family.material )
		: [];

	// Caller-supplied real-render families have first priority. Select every
	// complete family from that one epoch before considering synthetic data so
	// cube faces and pass siblings remain an atomic set.
	for ( const family of completeFamilies( suppliedRenderObjectHarvest ) ) {

		addFamilyEntries( family, true );
		markFamilyOwners( family, suppliedCompleteOwners, suppliedCompleteOwnerUuids );
		markFamilyOwners( family, selectedCompleteOwners, selectedCompleteOwnerUuids );

	}
	// The compile-local real RenderObjects are the next preference. Do not mix
	// them into a supplied family belonging to the same active/user material.
	for ( const family of completeFamilies( renderObjectHarvest ) ) {

		if ( familyOverlaps( family, suppliedCompleteOwners, suppliedCompleteOwnerUuids ) ) continue;
		addFamilyEntries( family, true );
		markFamilyOwners( family, selectedCompleteOwners, selectedCompleteOwnerUuids );

	}
	// A local family with one missing sibling must not contribute its other
	// harvested siblings. Re-enter through the pre-existing synthetic cache for
	// that whole material, retaining exact material attribution from requests.
	if ( renderObjectHarvest && renderObjectHarvest.familiesByMaterial instanceof Map ) {

		for ( const family of new Set( renderObjectHarvest.familiesByMaterial.values() ) ) {

			if ( ! family || family.complete || ! family.material ) continue;
			if ( familyOverlaps( family, selectedCompleteOwners, selectedCompleteOwnerUuids ) ) continue;
			addFamilyEntries( family, false );

		}

	}
	// Keep accumulated-cache extraction for old/custom renderers that do not
	// expose RenderObjects.get, plus stale auxiliary entries intentionally used
	// by existing capture workflows. Observed pairs above never rely on this
	// cacheKey -> first material attribution path.
	for ( const [ cacheKey, state ] of cache ) {

		const material = materialByCacheKey.get( cacheKey ) || null;
		const userMaterial = materialByCacheKey.get( cacheKey + ':user' ) || null;
		const materialUuid = ownerUuid( material );
		const userMaterialUuid = ownerUuid( userMaterial );
		if ( selectedCompleteOwners.has( material ) || selectedCompleteOwners.has( userMaterial ) ||
			materialUuid && selectedCompleteOwnerUuids.has( materialUuid ) ||
			userMaterialUuid && selectedCompleteOwnerUuids.has( userMaterialUuid ) ) continue;
		const handledKeys = handledPairsByMaterial.get( material );
		if ( handledKeys && handledKeys.has( cacheKey ) ) continue;
		if ( ! material && selectedCacheKeys.has( cacheKey ) ) continue;
		const scopedSelectors = selectorsFor( material, cacheKey );
		const unscopedSelectors = renderContextSelectorsWithoutMaterial.get( cacheKey );
		extractionEntries.push( {
			cacheKey,
			state,
			material,
			sourceMaterials: userMaterial ? [ userMaterial ] : [],
			sourceOwnerRequests: [],
			userMaterials: userMaterial ? [ userMaterial ] : [],
			meshes: meshesByCacheKey.get( cacheKey ) || [],
			renderContextSelectors: [ ...new Set( [ ...( scopedSelectors || [] ), ...( unscopedSelectors || [] ) ] ) ].sort(),
			captureClock,
			mrtNode: sceneMRTNode,
			hasObservedMRT: false,
		} );

	}
	// Preserve the historical accumulated-cache order for callers that inspect
	// the flat array, while still allowing one cache key to be attributed to
	// multiple observed materials in the richer side maps.
	const cacheOrder = new Map( [ ...cache.keys() ].map( ( cacheKey, index ) => [ cacheKey, index ] ) );
	extractionEntries.sort( ( a, b ) => ( cacheOrder.get( a.cacheKey ) ?? Number.MAX_SAFE_INTEGER ) - ( cacheOrder.get( b.cacheKey ) ?? Number.MAX_SAFE_INTEGER ) );

	// Discover material-owned kernels from the exact entries selected above,
	// after supplied-vs-local family overlap and incomplete-family fallback have
	// resolved. The accumulated-cache compatibility entries are intentionally
	// excluded: they may belong to an earlier capture even when their state still
	// contains a live ComputeNode. Selected synthetic fallback states remain
	// eligible because addFamilyEntries() marks both harvested and cache-backed
	// family entries at the same bounded ownership boundary.
	for ( const entry of extractionEntries ) {

		if ( entry.materialComputeDiscovery === true ) addMaterialComputeNodesFromState( entry.state, computeNodes, computeNodeSet );

	}

	// Auto-discovered kernels are built for extraction without dispatching. An
	// uncached onInit kernel is different: its callback may initialize storage
	// that the builder reads, so calling getForCompute() would build from an
	// uninitialized and potentially externally mutable state. Preserve an
	// already cached state, but otherwise leave the nested artifact unavailable
	// and let the material-compute contract fail closed to hybrid mode. The
	// requireExisting read also avoids DataMap.get() creating an empty cache row.
	for ( const computeNode of computeNodes ) {

		if ( explicitComputeNodeSet.has( computeNode ) ) continue;
		let state = cachedComputeState( manager, computeNode, true );
		if ( ! state && typeof computeNode.onInitFunction !== 'function' && typeof manager.getForCompute === 'function' ) {

			try { state = manager.getForCompute( computeNode ); } catch ( _ ) { state = null; }

		}
		if ( state ) computeStatesByNode.set( computeNode, state );

	}

	for ( const entry of extractionEntries ) {

		const { cacheKey, state, material, meshes } = entry;
		const sourceMaterials = [ ...new Set( entry.sourceMaterials || entry.userMaterials || [] ) ];
		const userMaterialCandidates = entry.userMaterials && entry.userMaterials.length > 0 ? entry.userMaterials : sourceMaterials;
		const userMaterials = [ ...new Set( userMaterialCandidates ) ];
		const userMaterial = userMaterials[ 0 ] || null;
		const exactShadowCasterRequests = classifyMaterialShape( material ) === 'shadow-depth'
			? ( entry.sourceOwnerRequests || [] ).filter( ( request ) =>
				request && request.bindingOwnerExact === true &&
				request.bindingOwnerKind === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER &&
				request.sourceMaterial && request.material === material && request.cacheKey === cacheKey
			)
			: [];
		const materialBindingOwners = new Set( exactShadowCasterRequests.map( ( request ) => request.sourceMaterial ) );
		const artifact = extractArtifact( cacheKey, state, material, meshes[ 0 ] || null, exactShadowCasterRequests.length > 0 ? {
			bindingOwnerKind: RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER,
			materialBindingOwners,
		} : null );
		if ( entry.materialComputeDiscovery === true && Array.isArray( state.updateBeforeNodes ) && state.updateBeforeNodes.some( isRawMaterialComputeNode ) ) materialComputeRecords.push( {
			artifact,
			state,
			material,
			graphMaterial: userMaterial || material,
		} );
		if ( exactShadowCasterRequests.length > 0 && artifact.materialShape === 'shadow-depth' ) {

			artifact.bindingOwner = RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER;
			Object.defineProperty( artifact, '_shadowCasterRequests', {
				value: Object.freeze( exactShadowCasterRequests.slice() ),
				enumerable: false,
				configurable: true,
			} );

		}
		if ( entry.renderContextSelectors && entry.renderContextSelectors.length > 0 ) artifact.renderContextSelectors = [ ...entry.renderContextSelectors ].sort();
		if ( material && material.uuid ) artifact.materialUuid = material.uuid;
		if ( userMaterial && userMaterial.uuid && ! isAuxiliaryArtifactShape( artifact.materialShape ) ) artifact.userMaterialUuid = userMaterial.uuid;
		const artifactCaptureClock = Number.isFinite( entry.captureClock ) ? entry.captureClock : captureClock;
		if ( artifactCaptureClock !== null ) artifact.captureClock = artifactCaptureClock;

		// Stamp mrtOutputCount when the warm-up ran with an MRT node active.
		// Three.js keys the pipeline by the number of color attachments — the
		// replay side needs this count to size the render target correctly and
		// validate the pipeline descriptor. Accept both `.nodes` (MRTNode) and
		// `.outputNodes` (PassNode-style) property names for robustness.
		const artifactMRTNode = entry.hasObservedMRT ? entry.mrtNode : sceneMRTNode;
		if ( artifactMRTNode ) {

			const outputMap = artifactMRTNode.nodes || artifactMRTNode.outputNodes || null;
			const outputNames = outputMap ? Object.keys( outputMap ) : [];
			const outputCount = outputNames.length;
			if ( outputCount > 0 ) {

				artifact.mrtOutputCount = outputCount;
				// Stamp the per-output names + blend modes so the runtime's
				// `createInertMRTStub` can replay the right blend mode per
				// attachment. The previous hardcoded `NoBlending` clobbered
				// any additive/normal blending the example expected (e.g. an
				// emissive MRT slot). Skip silently if the source MRTNode
				// doesn't expose `getBlendMode`.
				artifact.mrtOutputNames = outputNames.slice();
				if ( typeof artifactMRTNode.getBlendMode === 'function' ) {

					const blendModes = {};
					for ( const name of outputNames ) {

						try {

							const mode = artifactMRTNode.getBlendMode( name );
							if ( mode && mode.blending != null ) blendModes[ name ] = mode.blending;

						} catch ( _ ) { /* tolerate missing per-name blend mode */ }

					}
					if ( Object.keys( blendModes ).length > 0 ) artifact.mrtBlendModes = blendModes;

				}

			}

		}

		artifacts.push( artifact );
		const isAuxiliary = isAuxiliaryArtifactShape( artifact.materialShape );
		if ( material && isAuxiliary ) {

			pushArtifactVariant( byAuxiliaryMaterialVariants, material.uuid, artifact );

		}

		if ( material && ! isAuxiliary ) {

			pushArtifactVariant( byMaterialVariants, material.uuid, artifact );
			const expectedShape = classifyMaterialShape( material );
			byMaterialUuid.set( material.uuid, selectPreferredArtifact( byMaterialUuid.get( material.uuid ), artifact, expectedShape ) );

		}
		// Also key by the user-facing material when three.js wrapped it
		// internally (e.g. MeshPhysicalMaterial → MeshPhysicalNodeMaterial).
		// Without this, hydrateScene can't find the artifact for
		// SkinnedMesh + MeshPhysicalMaterial pairs that skip the node-
		// material class.
		for ( const observedUserMaterial of userMaterials ) if ( ! isAuxiliary && observedUserMaterial && observedUserMaterial.uuid !== ( material && material.uuid ) ) {

			pushArtifactVariant( byMaterialVariants, observedUserMaterial.uuid, artifact );
			const expectedShape = classifyMaterialShape( observedUserMaterial );
			byMaterialUuid.set( observedUserMaterial.uuid, selectPreferredArtifact( byMaterialUuid.get( observedUserMaterial.uuid ), artifact, expectedShape ) );

		}

		if ( ! isAuxiliary ) {

			for ( const mesh of meshes ) {

				const expectedShape = classifyMaterialShape( mesh.material );
				byMesh.set( mesh, selectPreferredArtifact( byMesh.get( mesh ), artifact, expectedShape ) );

			}

		}

	}

	// Compute artifacts are keyed by compute-node identity — there's no
	// hash cache like nodeBuilderCache for render, so we walk the explicit
	// list the caller gave us and read state off `_nodes.get(node)`.
	let nextComputeCacheKey = 1;
	for ( const computeNode of computeNodes ) {

		const state = computeStatesByNode.get( computeNode ) || ( explicitComputeNodeSet.has( computeNode ) ? cachedComputeState( manager, computeNode ) : null );
		if ( ! state ) continue;
		computeStatesByNode.set( computeNode, state );

		const artifact = extractComputeArtifact( nextComputeCacheKey ++, state, computeNode );
		if ( captureClock !== null ) artifact.captureClock = captureClock;
		artifacts.push( artifact );
		byComputeNode.set( computeNode, artifact );

	}

	const materialComputeOwnersByNode = new Map();
	for ( const record of materialComputeRecords ) {

		const owner = record.material || record.artifact;
		for ( const node of Array.isArray( record.state && record.state.updateBeforeNodes ) ? record.state.updateBeforeNodes : [] ) {

			if ( ! isRawMaterialComputeNode( node ) ) continue;
			let owners = materialComputeOwnersByNode.get( node );
			if ( ! owners ) materialComputeOwnersByNode.set( node, owners = new Set() );
			owners.add( owner );

		}

	}
	const sharedMaterialComputeNodes = new Set( [ ...materialComputeOwnersByNode ]
		.filter( ( [ , owners ] ) => owners.size > 1 )
		.map( ( [ node ] ) => node ) );
	for ( const record of materialComputeRecords ) {

		const descriptor = extractMaterialComputeDescriptor(
			record.artifact,
			record.state,
			byComputeNode,
			computeStatesByNode,
			sharedMaterialComputeNodes,
			record.graphMaterial,
		);
		if ( descriptor ) record.artifact.materialCompute = descriptor;

	}

	for ( const variantList of byAuxiliaryMaterialVariants.values() ) {

		for ( const artifact of variantList ) attachArtifactVariantFamily( artifact, variantList );

	}

	// Return the flat array for backwards compatibility, but attach
	// per-mesh / per-material / per-compute lookups so callers can pair
	// each mesh or compute node with the right hydrated artifact.
	artifacts.byMesh = byMesh;
	artifacts.byMaterialUuid = byMaterialUuid;
	artifacts.byMaterialVariants = byMaterialVariants;
	artifacts.byComputeNode = byComputeNode;
	if ( captureRendererOutput ) {

		const artifact = renderOutputIdentity && artifacts.find( ( candidate ) =>
			candidate.cacheKey === renderOutputIdentity.cacheKey &&
			candidate.materialUuid === renderOutputIdentity.materialUuid
		);
		if ( ! artifact ) {

			throw new Error(
				'compileTSL: the active renderer output pass could not be correlated to its extracted artifact. ' +
				'Do not select an output-transform artifact from the accumulated NodeManager cache.',
			);

		}
		Object.defineProperty( artifacts, 'renderOutputCapture', {
			value: { artifact, replayConfig: renderOutputIdentity.replayConfig },
			enumerable: false,
			configurable: true,
		});

	}

	return artifacts;

}

function captureActiveRendererOutputIdentity( renderer, observations ) {

	if ( ! renderer || typeof renderer._getFrameBufferTarget !== 'function' ) {

		throw new Error( 'compileTSL: captureRendererOutput requires Renderer._getFrameBufferTarget().' );

	}
	const frameBufferTarget = renderer._getFrameBufferTarget();
	const texture = frameBufferTarget && ( frameBufferTarget.texture || frameBufferTarget.textures && frameBufferTarget.textures[ 0 ] );
	const quadData = texture && renderer._quadCache && typeof renderer._quadCache.get === 'function'
		? renderer._quadCache.get( texture )
		: null;
	const material = quadData && quadData.quad && quadData.quad.material || null;
	const materialUuid = material && material.uuid || null;
	const matches = materialUuid
		? observations.filter( ( entry ) => entry.materialUuid === materialUuid )
		: [];
	if ( ! texture || ! materialUuid || matches.length !== 1 ) {

		throw new Error(
			`compileTSL: expected one observed active renderer output pass, found ${ matches.length }. ` +
			`Observed ${ observations.length } render material(s); framebuffer=${ texture ? 'yes' : 'no' }, ` +
			`quad=${ quadData ? 'yes' : 'no' }, material=${ materialUuid || '(none)' }. ` +
			'The output transform may be disabled or Three\'s private output-quad shape may have changed.',
		);

	}
	return {
		cacheKey: matches[ 0 ].cacheKey,
		materialUuid,
		replayConfig: createRendererOutputConfig( renderer, texture ),
	};

}

/**
 * Extract a compute-shader artifact from a built NodeBuilderState.
 *
 * @param {number} cacheKey - Arbitrary identity — compute artifacts are
 *     matched to their source node via the `byComputeNode` map, not this.
 * @param {NodeBuilderState} state
 * @param {Node} computeNode
 * @return {PrecompiledArtifact}
 */
export function extractComputeArtifact( cacheKey, state, computeNode ) {

	const bindings = ( state.bindings || [] ).map( describeBindGroup );
	const uniformPlan = extractUniformPlan( state );

	// Dispatch size — ComputeNode tracks this via `.count` for 1D work, or
	// `.dispatchSize` when the author passed an explicit [x, y, z] group
	// count. `count` is initialised to null by three.js, so null must not mask
	// a real `.dispatchSize`.
	const dispatchSize = readComputeDispatchSize( computeNode );
	const workgroupSize = readComputeWorkgroupSize( computeNode );

	const name = computeNode && computeNode.name ? computeNode.name : '';

	const artifact = {
		version: 3,
		kind: 'compute',
		cacheKey,
		name,
		computeShader: state.computeShader || '',
		vertexShader: '',
		fragmentShader: '',
		attributes: [],
		bindings,
		uniformPlan,
		defaults: {},
		dispatchSize,
		workgroupSize,
		meta: {
			updateNodes: state.updateNodes ? state.updateNodes.length : 0,
			updateBeforeNodes: state.updateBeforeNodes ? state.updateBeforeNodes.length : 0,
			updateAfterNodes: state.updateAfterNodes ? state.updateAfterNodes.length : 0
		}
	};

	attachLiveUpdateSidecars( artifact, state );

	return normalizeArtifactLightIdentities( artifact );

}

function readComputeDispatchSize( computeNode ) {

	if ( ! computeNode ) return null;
	if ( computeNode.count !== undefined && computeNode.count !== null ) return cloneDispatchValue( computeNode.count );
	if ( computeNode.dispatchSize !== undefined && computeNode.dispatchSize !== null ) return cloneDispatchValue( computeNode.dispatchSize );
	if ( computeNode.dispatchCount !== undefined && computeNode.dispatchCount !== null ) return cloneDispatchValue( computeNode.dispatchCount );
	return null;

}

function cloneDispatchValue( value ) {

	return Array.isArray( value ) ? value.slice() : value;

}

function readComputeWorkgroupSize( computeNode ) {

	const value = computeNode && Array.isArray( computeNode.workgroupSize ) ? computeNode.workgroupSize : null;
	if ( ! value || value.length === 0 ) return [ 64, 1, 1 ];
	const out = value.slice( 0, 3 ).map( ( item ) => Number.isFinite( item ) && item > 0 ? Math.floor( item ) : 1 );
	while ( out.length < 3 ) out.push( 1 );
	return out;

}

/**
 * Format an artifact as a human-readable shader dump string.
 *
 * @param {PrecompiledArtifact} artifact
 * @return {string}
 */
export function dumpArtifact( artifact ) {

	const header = [
		`// cacheKey: ${artifact.cacheKey}`,
		`// attributes: ${artifact.attributes.map( ( a ) => `${a.name}: ${a.type}` ).join( ', ' ) || '(none)'}`,
		'// bind groups:',
		...artifact.bindings.map( ( g ) => `//   [${g.name}] ${g.bindings.map( ( b ) => `${b.name}<${b.kind}>` ).join( ', ' )}` ),
		''
	].join( '\n' );

	const sections = [];
	if ( artifact.vertexShader ) sections.push( '// ---- vertex ----\n' + artifact.vertexShader );
	if ( artifact.fragmentShader ) sections.push( '// ---- fragment ----\n' + artifact.fragmentShader );
	if ( artifact.computeShader ) sections.push( '// ---- compute ----\n' + artifact.computeShader );

	return header + sections.join( '\n\n' );

}

/**
 * Inject a previously captured `NodeBuilderState` map into a renderer so that
 * subsequent renders skip the build step for matching cache keys.
 *
 * The states must have been captured from a renderer with matching backend
 * and identical scene/material/geometry shape — cache keys are deterministic
 * across runs only when the inputs are. This is primarily useful for warm-
 * restarting a renderer instance without re-running the node builder.
 *
 * @param {Renderer} renderer
 * @param {Map<number, NodeBuilderState>} states
 */
export function injectPrecompiled( renderer, states ) {

	const cache = renderer._nodes && renderer._nodes.nodeBuilderCache;
	if ( ! cache ) throw new Error( 'Renderer has no node builder cache (not initialized?).' );

	for ( const [ key, state ] of states ) {

		cache.set( key, state );

	}

}
