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
	if ( material.isMeshStandardNodeMaterial ) return 'mesh-standard';
	if ( material.isMeshPhysicalNodeMaterial ) return 'mesh-physical';
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
	if ( material.isMeshStandardMaterial ) return 'mesh-standard';
	if ( material.isMeshPhysicalMaterial ) return 'mesh-physical';
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

/**
 * Extract a serializable artifact from a single `NodeBuilderState`.
 *
 * @param {number} cacheKey
 * @param {NodeBuilderState} state
 * @param {?Material} [material=null] - Optional source material; used to tag
 *     the artifact with a shape the runtime hydrator can consume.
 * @return {PrecompiledArtifact}
 */
export function extractArtifact( cacheKey, state, material = null ) {

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
	const uniformPlan = extractUniformPlan( state );
	patchMaterialSpecificUniformPlan( uniformPlan, materialShape );

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
			writable: true
		} );

	}

	attachLiveUpdateSidecars( artifact, state );

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
		'transparent', 'opacity', 'alphaTest', 'alphaToCoverage',
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
 * @param {Renderer} renderer
 * @param {Scene} scene
 * @param {Camera} camera
 * @param {Object} [options]
 * @param {Array<Node>} [options.computeNodes] - Compute nodes to precompile.
 * @param {RenderPipeline} [options.renderPipeline] - Post-process pipeline to warm up.
 * @return {Promise<Array<PrecompiledArtifact>>}
 */
export async function compileTSL( renderer, scene, camera, options = {} ) {

	const manager = renderer._nodes;
	if ( ! manager ) return [];

	const computeNodes = Array.isArray( options.computeNodes ) ? options.computeNodes : [];
	const renderPipeline = options.renderPipeline || null;

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

	try {

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

		} else {

			// renderer.render() is the non-deprecated entry; compileAsync
			// above already ran `init` so the sync form is safe.
			renderer.render( scene, camera );

		}

	} finally {

		manager.getForRender = origGetForRender;

	}

	const cache = manager.nodeBuilderCache;
	if ( ! cache ) return [];

	const artifacts = [];
	const byMesh = new Map();
	const byMaterialUuid = new Map();
	const byMaterialVariants = new Map();
	const byComputeNode = new Map();
	for ( const [ cacheKey, state ] of cache ) {

		const material = materialByCacheKey.get( cacheKey ) || null;
		const userMaterial = materialByCacheKey.get( cacheKey + ':user' ) || null;
		const artifact = extractArtifact( cacheKey, state, material );
		if ( material && material.uuid ) artifact.materialUuid = material.uuid;
		if ( userMaterial && userMaterial.uuid ) artifact.userMaterialUuid = userMaterial.uuid;
		artifacts.push( artifact );
		const isAuxiliary = isAuxiliaryArtifactShape( artifact.materialShape );

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

			const meshes = meshesByCacheKey.get( cacheKey ) || [];
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

		const computeData = manager.get( computeNode );
		const state = computeData && computeData.nodeBuilderState;
		if ( ! state ) continue;

		const artifact = extractComputeArtifact( nextComputeCacheKey ++, state, computeNode );
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

	// Dispatch size — ComputeNode tracks this via `.count` (for 1D) or
	// `.workgroupSize` × `.dispatchCount` for 3D. Mirror whatever the node
	// carries so the slim-side dispatcher can reconstruct it.
	const dispatchSize = computeNode && computeNode.count !== undefined ?
		computeNode.count :
		( computeNode && computeNode.dispatchCount !== undefined ? computeNode.dispatchCount : null );

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
		meta: {
			updateNodes: state.updateNodes ? state.updateNodes.length : 0,
			updateBeforeNodes: state.updateBeforeNodes ? state.updateBeforeNodes.length : 0,
			updateAfterNodes: state.updateAfterNodes ? state.updateAfterNodes.length : 0
		}
	};

	attachLiveUpdateSidecars( artifact, state );

	return artifact;

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
