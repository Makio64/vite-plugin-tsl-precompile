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
import { DataUtils, FloatType, HalfFloatType, RGBAFormat, RenderTarget } from 'three';
import { countArtifactFragmentOutputs } from '@tsl-precompile/contract/fragment-outputs';

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

function artifactVariantPayload( artifact ) {

	return {
		cacheKey: artifact.cacheKey,
		materialShape: artifact.materialShape,
		sourceMaterial: artifact.sourceMaterial,
		vertexShader: artifact.vertexShader,
		fragmentShader: artifact.fragmentShader,
		computeShader: artifact.computeShader,
		transforms: artifact.transforms,
		attributes: artifact.attributes,
		nodeAttributes: artifact.nodeAttributes,
		bindings: artifact.bindings,
		uniformPlan: artifact.uniformPlan,
		mrtOutputCount: artifact.mrtOutputCount,
		mrtOutputNames: artifact.mrtOutputNames,
		mrtBlendModes: artifact.mrtBlendModes,
	};

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
	const variants = {};
	for ( const variant of variantList ) {

		if ( ! variant || variant.cacheKey === undefined || variant.cacheKey === null ) continue;
		variants[ String( variant.cacheKey ) ] = artifactVariantPayload( variant );
		mergeArtifactTextureRefs( artifact, variant );

	}
	if ( Object.keys( variants ).length > 1 ) artifact.variants = variants;

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
 * @return {PrecompiledArtifact}
 */
export function extractArtifact( cacheKey, state, material = null, object = null ) {

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
	const uniformPlan = extractUniformPlan( state, { material, object } );
	patchMaterialSpecificUniformPlan( uniformPlan, materialShape );
	// For each compute-storage buffer the user wired through a material
	// `*Node` slot (e.g. `material.colorNode = uv().mul( colors.element( i ) )`),
	// record `userPath` so the hydrator can rebind the live attribute in a
	// fresh process — same trick we use for vertex attributes. Without
	// this the `StorageBuffer_*` plan entry has no link back to the live
	// buffer that the compute kernel writes into, and the render path
	// allocates a fresh empty buffer.
	annotateStorageBufferUserPaths( uniformPlan, material );

	// Seed runtime defaults for the material properties the plan references.
	// PrecompiledMaterial reads these to populate its own color/opacity/etc.
	// so the hydrator can read from the material even before the user sets
	// anything.
	const defaults = collectMaterialDefaults( uniformPlan, material );
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
				const userPath = findAttributePathOnMaterial( material, liveAttribute );
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

	return artifact;

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

	for ( const key of Object.keys( material ) ) {

		// Convention: NodeMaterial node-shaped slots end in `Node` (positionNode,
		// colorNode, vertexNode, mrtNode, …). Avoids walking arbitrary user
		// properties (textures, scalars) that can't possibly contain a Node.
		if ( ! key.endsWith( 'Node' ) ) continue;
		const root = material[ key ];
		if ( ! root || root.isNode !== true ) continue;
		if ( nodeTreeContainsAttribute( root, target ) ) return [ key ];

	}

	return null;

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
function annotateStorageBufferUserPaths( uniformPlan, material ) {

	if ( ! Array.isArray( uniformPlan ) || ! material ) return;

	for ( const group of uniformPlan ) {

		const entries = group && Array.isArray( group.storageBuffers ) ? group.storageBuffers : null;
		if ( ! entries || entries.length === 0 ) continue;
		for ( const sb of entries ) {

			if ( ! sb || ! sb._liveAttribute ) continue;
			const path = findAttributePathOnMaterial( material, sb._liveAttribute );
			if ( path ) sb.userPath = path;

		}

	}

}

function nodeTreeContainsAttribute( node, target ) {

	if ( ! node ) return false;
	if ( node.attribute === target || node.value === target ) return true;
	if ( typeof node.traverse !== 'function' ) return false;

	let found = false;
	node.traverse( ( child ) => {

		if ( found || ! child ) return;
		if ( child.attribute === target || child.value === target ) found = true;

	} );
	return found;

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

function collectMaterialDefaults( uniformPlan, material ) {

	if ( ! material ) return {};

	const defaults = {};
	for ( const group of uniformPlan ) {

		for ( const slot of group.slots ) {

			const kind = slot.source && slot.source.kind;
			if ( typeof kind !== 'string' || ! kind.startsWith( 'material.' ) ) continue;

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
		'forceSinglePass', 'polygonOffset', 'polygonOffsetFactor',
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

async function compileTSLInner( renderer, scene, camera, options, manager ) {

	const computeNodes = Array.isArray( options.computeNodes ) ? options.computeNodes : [];
	const renderPipeline = options.renderPipeline || null;

	// Detect the MRT node to activate during warm-up. Resolved POST-lock so
	// we observe the renderer's MRT in a quiescent moment (no concurrent aux
	// capture has it cleared). Must be resolved before the getForRender
	// hook is installed so the hook can record it for artifact stamping in
	// the extraction pass below.
	const sceneMRTNode = collectSceneMRTNode( renderer, scene, options );

	// Temporarily wrap NodeManager.getForRender so we can see every
	// renderObject that flows through the build path during compileAsync.
	// For each one, record (cacheKey → material, mesh) so the artifacts we
	// emit can be attributed to real materials — not guessed via a
	// single-material fallback.
	const materialByCacheKey = new Map();
	const meshesByCacheKey = new Map();
	const origGetForRender = manager.getForRender.bind( manager );
	manager.getForRender = function ( renderObject, useAsync ) {

		const cacheKey = this.getForRenderCacheKey( renderObject );

		// Record BOTH the node material (which the extractor introspects
		// for shape + defaults) AND the user-facing material on the object
		// (which hydrateScene looks up via obj.material.uuid). For
		// MeshPhysicalMaterial and friends wrapped in node variants at
		// render time, these two are different instances.
		if ( renderObject.material && ! materialByCacheKey.has( cacheKey ) ) {

			materialByCacheKey.set( cacheKey, renderObject.material );

		}

		// Also record the object's visible material for byMaterialUuid
		// lookups. hydrateScene walks the scene and reads obj.material.uuid —
		// that may be the pre-wrap material (e.g. MeshPhysicalMaterial)
		// when three.js internally wraps it in MeshPhysicalNodeMaterial.
		if ( renderObject.object && renderObject.object.material &&
			renderObject.object.material !== renderObject.material ) {

			if ( ! materialByCacheKey.has( cacheKey + ':user' ) ) {

				materialByCacheKey.set( cacheKey + ':user', renderObject.object.material );

			}

		}

		let list = meshesByCacheKey.get( cacheKey );
		if ( ! list ) meshesByCacheKey.set( cacheKey, list = [] );
		if ( renderObject.object && ! list.includes( renderObject.object ) ) list.push( renderObject.object );

		return origGetForRender( renderObject, useAsync );

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
	if ( renderTargetOverride && typeof renderer.setRenderTarget === 'function' ) {

		mrtWarmupRT = renderTargetOverride;
		// Mark so we don't dispose() a caller-owned RT in the finally block.
		mrtWarmupRT.__tslpAuxBorrowed = true;

	} else if ( sceneMRTNode && typeof renderer.setRenderTarget === 'function' ) {

		const outputMap = sceneMRTNode.nodes || sceneMRTNode.outputNodes || null;
		const outputNames = outputMap ? Object.keys( outputMap ) : [];
		const outputCount = outputNames.length;
		if ( outputCount > 1 ) {

			try {

				mrtWarmupRT = new RenderTarget( 1, 1, { count: outputCount } );
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
	if ( ! mrtWarmupRT && ! prevRenderTarget && renderer && renderer.needsFrameBufferTarget === true &&
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

	try {

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

		await renderer.compileAsync( scene, camera );

		// Compute precompile — each computeAsync call forces NodeManager
		// .getForCompute to build the pipeline and stash the state on the
		// per-compute-node DataMap entry. We also get the side-effect of a
		// real GPU dispatch; that's normally fine (compute kernels are
		// idempotent seeds in our demo) but callers can set `state._seeded`
		// to skip the init kernel on re-compile.
		for ( const computeNode of computeNodes ) {

			await renderer.computeAsync( computeNode );

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
			// be initialised (compileAsync already guaranteed that).
			renderPipeline.render();

		} else if ( ! options.skipWarmupRender ) {

			// renderer.render() is the non-deprecated entry; compileAsync
			// above already ran `init` so the sync form is safe.
			renderer.render( scene, camera );

		}

	} finally {

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

			try { renderer.setRenderTarget( prevRenderTarget ); } catch ( _ ) { /* ignore */ }

		}

		if ( mrtWarmupRT && ! mrtWarmupRT.__tslpAuxBorrowed ) {

			try { mrtWarmupRT.dispose(); } catch ( _ ) { /* ignore */ }

		} else if ( mrtWarmupRT && mrtWarmupRT.__tslpAuxBorrowed ) {

			// Caller owns this RT; clear the borrow flag and leave disposal to them.
			try { delete mrtWarmupRT.__tslpAuxBorrowed; } catch ( _ ) { /* ignore */ }

		}

		manager.getForRender = origGetForRender;

	}

	const cache = manager.nodeBuilderCache;
	if ( ! cache ) return [];

	const artifacts = [];
	const byMesh = new Map();
	const byMaterialUuid = new Map();
	const byMaterialVariants = new Map();
	const byAuxiliaryMaterialVariants = new Map();
	const byComputeNode = new Map();
	// Wedge 4: snapshot the renderer's nodeFrame.time at capture so the runtime
	// can pin it during PSNR-snapshot replay. Without this, time-driven graphs
	// (`mix(a, b, sin(time*k))`, scrolling UVs, particle position +=
	// velocity*time) drift by 1–2 animation ticks because capture and replay
	// freeze nodeFrame at slightly different t values.
	const captureClock = ( renderer && renderer._nodes && renderer._nodes.nodeFrame && Number.isFinite( renderer._nodes.nodeFrame.time ) ) ? renderer._nodes.nodeFrame.time : null;
	for ( const [ cacheKey, state ] of cache ) {

		const material = materialByCacheKey.get( cacheKey ) || null;
		const userMaterial = materialByCacheKey.get( cacheKey + ':user' ) || null;
		const meshes = meshesByCacheKey.get( cacheKey ) || [];
		const artifact = extractArtifact( cacheKey, state, material, meshes[ 0 ] || null );
		if ( material && material.uuid ) artifact.materialUuid = material.uuid;
		if ( userMaterial && userMaterial.uuid ) artifact.userMaterialUuid = userMaterial.uuid;
		if ( captureClock !== null ) artifact.captureClock = captureClock;

		// Stamp mrtOutputCount when the warm-up ran with an MRT node active.
		// Three.js keys the pipeline by the number of color attachments — the
		// replay side needs this count to size the render target correctly and
		// validate the pipeline descriptor. Accept both `.nodes` (MRTNode) and
		// `.outputNodes` (PassNode-style) property names for robustness.
		if ( sceneMRTNode ) {

			const outputMap = sceneMRTNode.nodes || sceneMRTNode.outputNodes || null;
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
				if ( typeof sceneMRTNode.getBlendMode === 'function' ) {

					const blendModes = {};
					for ( const name of outputNames ) {

						try {

							const mode = sceneMRTNode.getBlendMode( name );
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
		if ( ! isAuxiliary && userMaterial && userMaterial.uuid !== ( material && material.uuid ) ) {

			pushArtifactVariant( byMaterialVariants, userMaterial.uuid, artifact );
			const expectedShape = classifyMaterialShape( userMaterial );
			byMaterialUuid.set( userMaterial.uuid, selectPreferredArtifact( byMaterialUuid.get( userMaterial.uuid ), artifact, expectedShape ) );

		}

		if ( ! isAuxiliary ) {

			for ( const mesh of meshes ) {

				const expectedShape = classifyMaterialShape( mesh.material );
				byMesh.set( mesh, selectPreferredArtifact( byMesh.get( mesh ), artifact, expectedShape ) );

			}

		}

	}

	for ( const variantList of byAuxiliaryMaterialVariants.values() ) {

		for ( const artifact of variantList ) attachArtifactVariantFamily( artifact, variantList );

	}

	// Compute artifacts are keyed by compute-node identity — there's no
	// hash cache like nodeBuilderCache for render, so we walk the explicit
	// list the caller gave us and read state off `_nodes.get(node)`.
	let nextComputeCacheKey = 1;
	for ( const computeNode of computeNodes ) {

		const computeData = manager.get( computeNode );
		const state = computeData && computeData.nodeBuilderState;
		if ( ! state ) continue;

		const artifact = extractComputeArtifact( nextComputeCacheKey ++, state, computeNode );
		if ( captureClock !== null ) artifact.captureClock = captureClock;
		artifacts.push( artifact );
		byComputeNode.set( computeNode, artifact );

	}

	// Return the flat array for backwards compatibility, but attach
	// per-mesh / per-material / per-compute lookups so callers can pair
	// each mesh or compute node with the right hydrated artifact.
	artifacts.byMesh = byMesh;
	artifacts.byMaterialUuid = byMaterialUuid;
	artifacts.byMaterialVariants = byMaterialVariants;
	artifacts.byComputeNode = byComputeNode;

	return artifacts;

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

	return artifact;

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
