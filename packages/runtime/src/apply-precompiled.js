/**
 * `__applyPrecompiled(material, artifactModule, expectedHash)` — injected by
 * the Babel transform in place of every `.precompile(name)` call.
 *
 * Responsibilities:
 *   1. Hash gate: assert `artifactModule.__hash === expectedHash`. Mismatch
 *      means the build somehow shipped a stale artifact — throw with a
 *      clear migration message.
 *   2. Wrap the material in a PrecompiledMaterial shim so three.js's renderer
 *      picks up the baked shader + bindings instead of running the builder.
 *   3. Register the artifact in the module-scoped registry so the renderer's
 *      cache-key resolver can find it.
 *   4. Catalogue the source material's live texture instances onto
 *      `artifact._textureRefs` keyed by `source.textureUuid` (extractor-stamped),
 *      so the hydrator's `_textureRefs.get(uuid)` lookup hits before falling
 *      back to a 1×1 white. This survives multi-process flows: the artifact
 *      JSON carries the identity hints and the Texture instances on the live
 *      `material[prop]` are matched by UUID.
 *
 * @module ApplyPrecompiled
 */

import { default as PrecompiledMaterial } from './_vendor-PrecompiledMaterial.js';
import { registerPrecompiledArtifacts } from './_vendor-PrecompiledArtifactRegistry.js';
import { registerArtifact } from './artifact-loader.js';
import { attachArtifactTextureRefsByShapeOrder } from './slim-support/artifact-texture-wiring.js';
import { wireLiveNodeSidecarsToArtifact } from './slim-support/live-node-sidecars.js';
import {
	MATERIAL_TEXTURE_PROPS as _TEXTURE_PROPS,
	NODE_GRAPH_TEXTURE_KEYS as _NODE_GRAPH_KEYS,
} from '@tsl-precompile/contract/texture-props';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { hashMaterialSync } from './graph-hash.js';

const _NODE_TEXTURE_FIELDS = [ 'value', 'texture', '_value', '_texture', '_pmrem', 'renderTarget' ];

const SOURCE_HASH_FIELDS = Object.freeze( [
	'sourceGraphHash',
	'sourceHashVersion',
	'sourceThreeVersion',
	'renderContextSignature',
] );

/**
 * Recompute the captured material-source fingerprint before mutating or
 * adopting the source material. Artifacts captured before source-hash metadata
 * existed remain compatible and continue to use the outer module-hash gate.
 * Once any metadata field is present, however, the record must be complete —
 * silently accepting a partial record would recreate the stale-source hole.
 */
function assertCapturedSourceIsFresh( material, artifactModule, artifact, name ) {

	const metadataSource = SOURCE_HASH_FIELDS.some( ( key ) => artifact && artifact[ key ] !== undefined )
		? artifact
		: SOURCE_HASH_FIELDS.some( ( key ) => artifactModule && artifactModule[ key ] !== undefined )
			? artifactModule
			: null;
	if ( metadataSource === null ) return; // Explicit legacy policy.

	const sourceGraphHash = metadataSource.sourceGraphHash;
	const sourceHashVersion = metadataSource.sourceHashVersion;
	const sourceThreeVersion = metadataSource.sourceThreeVersion;
	const renderContextSignature = metadataSource.renderContextSignature;

	if ( typeof sourceGraphHash !== 'string' || ! /^[a-f0-9]{64}$/i.test( sourceGraphHash ) ) {

		throw new Error( `[tsl-precompile] artifact "${ name || '<unnamed>' }" has incomplete source-hash metadata: sourceGraphHash must be a 64-character SHA-256 hex string. Recapture it with the current toolchain.` );

	}
	if ( sourceHashVersion !== ARTIFACT_TOOLCHAIN_VERSION ) {

		throw new Error( `[tsl-precompile] artifact "${ name || '<unnamed>' }" was captured with source-hash/toolchain version ${ sourceHashVersion || '<missing>' }, but this runtime requires ${ ARTIFACT_TOOLCHAIN_VERSION }. Recapture the artifact.` );

	}
	if ( typeof sourceThreeVersion !== 'string' || sourceThreeVersion.length === 0 ) {

		throw new Error( `[tsl-precompile] artifact "${ name || '<unnamed>' }" has incomplete source-hash metadata: sourceThreeVersion is missing. Recapture it with the current toolchain.` );

	}
	if ( typeof name !== 'string' || name.length === 0 ) {

		throw new Error( '[tsl-precompile] source-hash validation requires the captured artifact name. Recapture the unnamed artifact.' );

	}

	const detectedThreeVersion = typeof globalThis !== 'undefined' && typeof globalThis.__TSLP_THREE_PACKAGE_VERSION__ === 'string'
		? globalThis.__TSLP_THREE_PACKAGE_VERSION__
		: '';
	if ( detectedThreeVersion && detectedThreeVersion !== sourceThreeVersion ) {

		throw new Error( `[tsl-precompile] artifact "${ name }" was captured with three ${ sourceThreeVersion }, but this bundle uses three ${ detectedThreeVersion }. Recapture it with the installed three version.` );

	}
	if ( metadataSource.sourceValidationMode === 'callsite' ) {

		// autoMark is rewritten at `new *NodeMaterial()`, before subsequent
		// assignments configure the graph. The plugin validates its captured
		// module/call-site revision at build time; recomputing here would compare
		// a bare constructor against the fully configured dev material.
		return;

	}

	const currentSourceGraphHash = hashMaterialSync( material, {
		name,
		threeVersion: detectedThreeVersion || sourceThreeVersion,
		toolchainVersion: ARTIFACT_TOOLCHAIN_VERSION,
		renderContextSignature,
	} );
	if ( currentSourceGraphHash !== sourceGraphHash ) {

		throw new Error( `[tsl-precompile] stale source graph detected for "${ name }": capture recorded ${ sourceGraphHash }, current material source is ${ currentSourceGraphHash }. Recapture the artifact before building.` );

	}

}

function _readObjectProp( object, prop ) {

	try {

		return object && object[ prop ];

	} catch ( _ ) {

		return undefined;

	}

}

function _addTextureCandidate( value, out ) {

	if ( ! value ) return;
	if ( value.isTexture === true ) {

		if ( value.uuid && ! out.has( value.uuid ) ) out.set( value.uuid, value );
		return;

	}

	if ( value.isTextureNode === true ) _addTextureCandidate( _readObjectProp( value, 'value' ), out );

	const texture = _readObjectProp( value, 'texture' );
	if ( texture && texture.isTexture === true ) _addTextureCandidate( texture, out );

	const nodeValue = _readObjectProp( value, 'value' );
	if ( nodeValue && nodeValue.isTexture === true ) _addTextureCandidate( nodeValue, out );

}

function _collectKnownNodeTextureFields( node, out ) {

	for ( const field of _NODE_TEXTURE_FIELDS ) _addTextureCandidate( _readObjectProp( node, field ), out );

}

function _walkTextureNodeShape( value, out, seen ) {

	if ( ! value || typeof value !== 'object' || seen.has( value ) ) return;
	_addTextureCandidate( value, out );
	if ( value.isTexture === true ) return;
	seen.add( value );

	const shouldInspect = value.isNode === true || value.isTextureNode === true || typeof value.traverse === 'function' || Object.getPrototypeOf( value ) === Object.prototype;
	if ( ! shouldInspect ) return;

	_collectKnownNodeTextureFields( value, out );
	for ( const key of Object.getOwnPropertyNames( value ) ) {

		const child = _readObjectProp( value, key );
		_addTextureCandidate( child, out );
		if ( Array.isArray( child ) ) {

			for ( const item of child ) _walkTextureNodeShape( item, out, seen );

		} else if ( child && typeof child === 'object' && child.isTexture !== true ) {

			if ( child.isNode === true || child.isTextureNode === true || Object.getPrototypeOf( child ) === Object.prototype ) {

				_walkTextureNodeShape( child, out, seen );

			}

		}

	}

}

/**
 * Walk a TSL node tree and push any embedded `Texture` instances (the `value`
 * of a TextureNode) into the provided Map keyed by uuid. The TextureNode shape
 * matches three.js: `node.isTextureNode === true && node.value.isTexture`.
 * Handles the case where the top-level node *is* a TextureNode (no traverse
 * needed) and the case where TextureNodes are buried in `node.traverse()`.
 *
 * @param {Object} rootNode - TSL node (may be undefined / null).
 * @param {Map<string, Object>} out - Mutated; uuid → Texture.
 */
function _collectTexturesFromNode( rootNode, out ) {

	if ( ! rootNode ) return;
	_addTextureCandidate( rootNode, out );
	_collectKnownNodeTextureFields( rootNode, out );
	if ( typeof rootNode.traverse === 'function' ) {

		rootNode.traverse( ( n ) => {

			_addTextureCandidate( n, out );
			_collectKnownNodeTextureFields( n, out );

		} );

	}

	_walkTextureNodeShape( rootNode, out, new Set() );

}

/**
 * Collect every `Texture` reachable from a source material — both the
 * hardcoded property slots (`material.map`, `material.envMap`, …) and any
 * `TextureNode` buried inside its `*Node` graphs (e.g.
 * `material.colorNode = texture(myTex)`). Returns a `Map<uuid, Texture>`.
 *
 * Exported because `attachArtifactTextureRefs()` in `aux-loader.js` needs the
 * same node-graph walk for background/aux artifacts.
 *
 * @param {Object} sourceMaterial
 * @return {Map<string, Object>}
 */
export function collectLiveMaterialTextures( sourceMaterial ) {

	const out = new Map();
	if ( ! sourceMaterial ) return out;

	for ( const prop of _TEXTURE_PROPS ) {

		const tex = sourceMaterial[ prop ];
		if ( tex && tex.isTexture === true && tex.uuid && ! out.has( tex.uuid ) ) out.set( tex.uuid, tex );

	}

	for ( const key of _NODE_GRAPH_KEYS ) {

		_collectTexturesFromNode( sourceMaterial[ key ], out );

	}

	return out;

}

/**
 * Walk `artifact.uniformPlan.textures` and seed `artifact._textureRefs` from
 * the source material's live texture properties. Matches by `source.textureUuid`
 * (extractor-stamped) → `sourceMaterial[ property ].uuid`. Idempotent: skips
 * entries already present in `_textureRefs`. Returns the number of textures
 * catalogued.
 *
 * Called from `__applyPrecompiled` so the hydrator's `_textureRefs.get(uuid)`
 * lookup path resolves to the live Texture instance even when the artifact
 * is loaded from JSON (where the in-process Map populated by `collectTextureRefs`
 * is gone). Out-of-process flows (per-frame compile-elsewhere → hydrate-here)
 * pick up the textures via the source material's existing `material.<prop>`
 * assignments — i.e. exactly the path users already wire up at construction.
 *
 * @param {Object} artifact - Artifact to mutate.
 * @param {Object} sourceMaterial - The user's original NodeMaterial with live textures.
 * @return {number} Count of newly-catalogued textures.
 */
export function catalogueArtifactTextureRefs( artifact, sourceMaterial ) {

	if ( ! artifact || ! sourceMaterial ) return 0;
	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	let added = 0;
	let refs = artifact._textureRefs instanceof Map ? artifact._textureRefs : null;

	// Build a uuid → live Texture lookup from the source material — both the
	// shared material texture-property slots AND any TextureNode buried in its
	// `*Node` graphs (`material.colorNode = texture(myTex)` and friends).
	// Without the node-graph pass, materials whose textures live only inside
	// the TSL graph fall through to a 1×1 white fallback at hydrator time.
	const liveByUuid = collectLiveMaterialTextures( sourceMaterial );
	if ( liveByUuid.size === 0 ) return 0;
	const liveTextures = Array.from( liveByUuid.values() );

	for ( const group of plan ) {

		const textures = Array.isArray( group.textures ) ? group.textures : [];
		for ( const entry of textures ) {

			if ( ! entry || entry.bindingKind === 'sampler' ) continue;
			const source = entry.source || {};
			if ( ! source.textureUuid ) continue;
			if ( refs && refs.has( source.textureUuid ) ) continue;
			const tex = liveByUuid.get( source.textureUuid );
			if ( ! tex ) continue;
			if ( ! refs ) refs = new Map();
			refs.set( source.textureUuid, tex );
			added ++;

		}

	}

	if ( added > 0 ) {

		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );

	}

	const shapeOrderAdded = attachArtifactTextureRefsByShapeOrder( artifact, liveTextures );

	return added + shapeOrderAdded;

}

/**
 * Injected into transformed code in place of `.precompile('name')` calls.
 *
 * @param {Object} material - The original NodeMaterial the user constructed.
 * @param {Object} artifactModule - The virtual artifact module (default + named exports).
 * @param {string} expectedHash - Hash baked into the source at transform time.
 * @returns {Object} A PrecompiledMaterial wrapping the artifact. The author's
 *   downstream `mesh.material = mat` continues to work unchanged.
 */
export function __applyPrecompiled( material, artifactModule, expectedHash ) {

	return applyPrecompiled( material, artifactModule, expectedHash, null );

}

/**
 * Internal bridge used only by the conditional development entry. Keeping
 * this separate preserves the public three-argument apply contract and lets
 * production tree-shake the schema-validation hook entirely.
 *
 * @internal
 */
export function __applyPrecompiledWithValidation( material, artifactModule, expectedHash, validateArtifactHook ) {

	if ( typeof validateArtifactHook !== 'function' ) throw new TypeError( '__applyPrecompiledWithValidation: validation hook must be a function.' );
	return applyPrecompiled( material, artifactModule, expectedHash, validateArtifactHook );

}

function applyPrecompiled( material, artifactModule, expectedHash, validateArtifactHook ) {

	if ( ! artifactModule || typeof artifactModule !== 'object' ) {

		throw new Error( '[tsl-precompile] __applyPrecompiled: artifactModule is missing. Did the virtual module resolver run?' );

	}

	const shipped = artifactModule.__hash || ( artifactModule.artifact && artifactModule.artifact.__hash );
	if ( shipped !== expectedHash ) {

		throw new Error( `[tsl-precompile] stale artifact detected for "${ artifactModule.name || '<unnamed>' }": expected hash ${ expectedHash }, bundle shipped ${ shipped || '<missing>' }. Rebuild — the on-disk artifact is out of sync with source.` );

	}

	const artifact = artifactModule.artifact || artifactModule;
	const name = artifactModule.name || artifact.__name;
	assertCapturedSourceIsFresh( material, artifactModule, artifact, name );
	if ( validateArtifactHook ) validateArtifactHook( artifact, name );
	if ( artifactModule.__hash && ! artifact.__hash ) {

		Object.defineProperty( artifact, '__hash', { value: artifactModule.__hash, enumerable: false, configurable: true } );

	}
	attachGeneratedUpdaters( artifact, artifactModule );

	// Cache by name in the module-scoped registry so subsequent lookups
	// (e.g. when scene is cloned, or the same name is referenced from
	// multiple call sites) skip the wrap.
	registerArtifact( name, artifactModule );

	// Hand auxiliary-pass artifacts (shadow-depth, render-pipeline,
	// output-transform) to the renderer-internal registry so internal
	// `new NodeMaterial()` constructors auto-hydrate from them. Skip user-
	// material artifacts — those go through the wrapped material path below.
	const auxiliary = isAuxiliaryShape( artifact.materialShape );
	if ( auxiliary ) {

		registerPrecompiledArtifacts( [ artifact ] );
		// Material is unchanged in the auxiliary case — the renderer reaches
		// into the registry by shape, not by reference.
		return material;

	}

	// Catalogue the source material's live texture instances onto
	// `artifact._textureRefs` keyed by the extractor-stamped `source.textureUuid`.
	// In-process flows already have `_textureRefs` populated by `collectTextureRefs`
	// (compileTSL.js); JSON-loaded flows do not, and the hydrator's UUID lookup
	// would otherwise miss for `material.<prop>` textures whose wrapper-side
	// `material[prop]` is undefined. Cataloguing here means the hydrator's
	// `_textureRefs.get(uuid)` path resolves to the live Texture instance.
	catalogueArtifactTextureRefs( artifact, material );
	wireLiveNodeSidecarsToArtifact( artifact, material, { overlay: true } );

	// Note: node-sourced attribute leaves (e.g. `material.positionNode =
	// instancedBufferAttribute(buf)`) cannot be catalogued here — the user
	// assigns `*Node` properties on the wrapped material AFTER this
	// function returns. The hydrator handles that case at first-render,
	// when the node assignments have already happened.

	// Wrap in PrecompiledMaterial. We copy a small set of user-visible
	// material properties over so downstream code that reads `mat.color`,
	// `mat.opacity`, etc. continues to work.
	const wrapped = new PrecompiledMaterial( artifact );
	copyCommonMaterialProperties( material, wrapped );
	// The source material can legitimately report transparent=false for
	// KHR_materials_transmission. PrecompiledMaterial enables blending because
	// replay composites transmission in the fragment; property copying above
	// must not undo that artifact-required pipeline state.
	if ( artifact.defaults && typeof artifact.defaults.transmission === 'number' && artifact.defaults.transmission > 0 ) wrapped.transparent = true;

	// Live ReflectorBaseNode handles for the runtime hydrator's reflector
	// rebinder. PrecompiledMaterial drops every `*Node` property; the
	// reflector's per-camera RenderTarget lives inside the user's
	// `colorNode = mix(..., reflector())` graph, so we extract just the
	// ReflectorBaseNode references here while the source material's graph
	// is still intact. The hydrator reads each base node's per-camera
	// `renderTarget.texture` per frame and rebinds the captured fallback
	// texture to it — without this, the mirror surface samples a 1×1 white.
	const reflectorBaseNodes = collectReflectorBaseNodes( material );
	if ( reflectorBaseNodes.length > 0 ) {

		Object.defineProperty( wrapped, '__tslpReflectorBaseNodes', {
			value: reflectorBaseNodes,
			enumerable: false,
			writable: true,
			configurable: true,
		} );

	}

	// If the source material had its own `mrtNode` (e.g. user did
	// `mat.mrtNode = mrt({...})` for per-material MRT), and the artifact
	// did NOT already attach a stub, propagate it. The PrecompiledMaterial
	// constructor handles the artifact-driven case via `mrtOutputCount`;
	// this branch covers the rare per-material-MRT path so the wrapper
	// keeps the same shape as the source.
	if ( ! wrapped.mrtNode && material && material.mrtNode ) {

		wrapped.mrtNode = material.mrtNode;

	}
	copyBackdropMarkers( material, wrapped );

	return adoptPrecompiledMaterial( material, wrapped );

}

function copyBackdropMarkers( src, dst ) {

	for ( const key of [ 'backdropNode', 'backdropAlphaNode' ] ) {

		const node = src && src[ key ];
		if ( node && node.isNode === true ) dst[ key ] = node;

	}

}

function adoptPrecompiledMaterial( target, wrapped ) {

	if ( ! target || typeof target !== 'object' ) return wrapped;

	try {

		for ( const key of Reflect.ownKeys( wrapped ) ) {

			const descriptor = Object.getOwnPropertyDescriptor( wrapped, key );
			if ( descriptor ) Object.defineProperty( target, key, descriptor );

		}
		Object.setPrototypeOf( target, Object.getPrototypeOf( wrapped ) );
		return target;

	} catch ( _ ) {

		return wrapped;

	}

}

/**
 * Collect every live `ReflectorBaseNode` reachable from a source material's
 * node graph. The wrapped PrecompiledMaterial drops node-shaped properties,
 * so the hydrator's reflector rebinder cannot reach the live base nodes via
 * the wrapped material — extract them here while the source graph is intact.
 *
 * @param {?Object} material
 * @return {Array<Object>} ReflectorBaseNode instances; empty if none.
 */
export function collectReflectorBaseNodes( material ) {

	if ( ! material ) return [];
	const seen = new Set();
	const seenBaseNodes = new Set();
	const result = [];
	const addBaseNode = ( node ) => {

		if ( ! node || ! node.constructor ) return;
		const baseNode = node.constructor.type === 'ReflectorBaseNode'
			? node
			: node._reflectorBaseNode;
		if ( ! baseNode || baseNode.constructor && baseNode.constructor.type !== 'ReflectorBaseNode' ) return;
		if ( ! ( baseNode.renderTargets instanceof Map ) ) return;
		if ( typeof baseNode.updateBefore !== 'function' ) return;
		if ( seenBaseNodes.has( baseNode ) ) return;
		seenBaseNodes.add( baseNode );
		result.push( baseNode );

	};
	const walk = ( value, depth = 0 ) => {

		if ( ! value || depth > 24 ) return;
		const type = typeof value;
		if ( type !== 'object' && type !== 'function' ) return;
		if ( seen.has( value ) ) return;
		seen.add( value );

		addBaseNode( value );

		if ( typeof value.traverse === 'function' ) {

			try {

				value.traverse( ( child ) => {

					addBaseNode( child );
					walk( child, depth + 1 );

				} );

			} catch ( _ ) {

				// Keep the reflective walker best-effort; user node graphs can
				// contain getters that throw outside a builder.

			}

		}

		const shouldInspect = value.isNode === true ||
			value.isTextureNode === true ||
			typeof value.traverse === 'function' ||
			Object.getPrototypeOf( value ) === Object.prototype;
		if ( ! shouldInspect ) return;

		const skip = new Set( [ 'parent', 'children', 'builder', 'material', 'object', 'geometry', 'scene', 'camera', 'renderer', 'domElement' ] );
		for ( const key of Object.getOwnPropertyNames( value ) ) {

			if ( skip.has( key ) ) continue;
			let child;
			try {

				child = value[ key ];

			} catch ( _ ) {

				continue;

			}
			if ( Array.isArray( child ) ) {

				for ( const item of child ) walk( item, depth + 1 );

			} else {

				walk( child, depth + 1 );

			}

		}

	};
	for ( const key of _NODE_GRAPH_KEYS ) {

		const root = material[ key ];
		walk( root );

	}
	return result;

}

function attachGeneratedUpdaters( artifact, artifactModule ) {

	if ( ! artifact || typeof artifact !== 'object' || ! artifactModule ) return;

	if ( typeof artifactModule.update === 'function' ) {

		Object.defineProperty( artifact, '_generatedUpdate', { value: artifactModule.update, enumerable: false, configurable: true } );

	}

	if ( typeof artifactModule.updateGroup === 'function' ) {

		Object.defineProperty( artifact, '_generatedUpdateGroup', { value: artifactModule.updateGroup, enumerable: false, configurable: true } );

	}

}

function isAuxiliaryShape( shape ) {

	return shape === 'shadow-depth' || shape === 'render-pipeline' || shape === 'output-transform';

}

/**
 * Mirror common-case material properties from the user's source material onto
 * the wrapped PrecompiledMaterial so existing code that mutates `mat.color`,
 * `mat.opacity` keeps working.
 *
 * Intentionally excludes node-shaped properties (`*Node`) — those are baked
 * into the artifact and mutating them at runtime would not affect the shader.
 */
function copyCommonMaterialProperties( src, dst ) {

	// Audited against three.js r184: MeshStandardMaterial, MeshPhysicalMaterial,
	// MeshPhongMaterial, MeshBasicMaterial, MeshLambertMaterial, MeshMatcap-
	// Material, MeshToonMaterial. Texture slots come from
	// @tsl-precompile/contract; scalar slots are mirrored by the E2E harness.
	const props = [
		'name',
		// Color / scalar PBR properties
		'color',
		'emissive',
		'emissiveIntensity',
		'roughness',
		'metalness',
		'specular',
		'specularColor',
		'specularIntensity',
		'shininess',
		'reflectivity',
		'refractionRatio',
		'ior',
		'transmission',
		'thickness',
		'attenuationColor',
		'attenuationDistance',
		'sheen',
		'sheenColor',
		'sheenRoughness',
		'clearcoat',
		'clearcoatRoughness',
		'clearcoatNormalScale',
		'iridescence',
		'iridescenceIOR',
		'iridescenceThicknessRange',
		'anisotropy',
		'anisotropyRotation',
		'dispersion',
		'opacity',
		'transparent',
		'side',
		'visible',
		'toneMapped',
		'alphaTest',
		'alphaHash',
		'alphaToCoverage',
		'depthTest',
		'depthWrite',
		'clippingPlanes',
		'clipIntersection',
		'clipShadows',
		'blending',
		'blendSrc',
		'blendDst',
		'blendEquation',
		'premultipliedAlpha',
		'dithering',
			'vertexColors',
			'wireframe',
			'wireframeLinewidth',
			'flatShading',
			// Wide-line material properties
			'linewidth',
			'dashSize',
			'gapSize',
			'dashOffset',
			'scale',
			'worldUnits',
			'dashed',
			// PBR map properties (textures)
			'map',
		'alphaMap',
		'aoMap',
		'aoMapIntensity',
		'bumpMap',
		'bumpScale',
		'normalMap',
		'normalMapType',
		'normalScale',
		'roughnessMap',
		'metalnessMap',
		'emissiveMap',
		'envMap',
		'envMapIntensity',
		'envMapRotation',
		'lightMap',
		'lightMapIntensity',
		'displacementMap',
		'displacementScale',
		'displacementBias',
		'gradientMap',
		'matcap',
		'specularMap',
		'specularColorMap',
		'specularIntensityMap',
		'clearcoatMap',
		'clearcoatRoughnessMap',
		'clearcoatNormalMap',
		'transmissionMap',
		'thicknessMap',
		'iridescenceMap',
		'iridescenceThicknessMap',
		'sheenColorMap',
		'sheenRoughnessMap',
		'anisotropyMap',
	];

	for ( const k of props ) {

		if ( k in src ) {

			try {

				dst[ k ] = src[ k ];

			} catch ( _ ) {
				/* read-only on dst — ignore */
			}

		}

	}

}
