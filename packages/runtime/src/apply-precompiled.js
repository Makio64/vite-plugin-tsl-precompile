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

// Texture properties three.js's MeshStandardMaterial / Mesh*Material families
// recognise. Mirrors `__TEXTURE_PROPS` in run-e2e.mjs and the hydrator's
// `TEXTURE_PROPS` scan. Used to find live textures on the source material so
// they can be catalogued onto the artifact's `_textureRefs` map.
const _TEXTURE_PROPS = [
	'map', 'alphaMap', 'aoMap', 'bumpMap', 'displacementMap', 'emissiveMap',
	'envMap', 'lightMap', 'normalMap', 'specularMap', 'roughnessMap',
	'metalnessMap', 'gradientMap', 'matcap', 'clearcoatMap',
	'clearcoatNormalMap', 'clearcoatRoughnessMap', 'iridescenceMap',
	'iridescenceThicknessMap', 'sheenColorMap', 'sheenRoughnessMap',
	'specularColorMap', 'specularIntensityMap', 'transmissionMap',
	'thicknessMap', 'anisotropyMap',
];

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

	// Build a uuid → live Texture lookup from the source material's known
	// texture properties. Cheap (≤ 26 props) and only done once per apply.
	const liveByUuid = new Map();
	for ( const prop of _TEXTURE_PROPS ) {

		const tex = sourceMaterial[ prop ];
		if ( tex && tex.isTexture && tex.uuid ) liveByUuid.set( tex.uuid, tex );

	}
	if ( liveByUuid.size === 0 ) return 0;

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

	return added;

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

	if ( ! artifactModule || typeof artifactModule !== 'object' ) {

		throw new Error( '[tsl-precompile] __applyPrecompiled: artifactModule is missing. Did the virtual module resolver run?' );

	}

	const shipped = artifactModule.__hash || ( artifactModule.artifact && artifactModule.artifact.__hash );
	if ( shipped !== expectedHash ) {

		throw new Error( `[tsl-precompile] stale artifact detected for "${ artifactModule.name || '<unnamed>' }": expected hash ${ expectedHash }, bundle shipped ${ shipped || '<missing>' }. Rebuild — the on-disk artifact is out of sync with source.` );

	}

	const artifact = artifactModule.artifact || artifactModule;
	const name = artifactModule.name || artifact.__name;
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

	// Wrap in PrecompiledMaterial. We copy a small set of user-visible
	// material properties over so downstream code that reads `mat.color`,
	// `mat.opacity`, etc. continues to work.
	const wrapped = new PrecompiledMaterial( artifact );
	copyCommonMaterialProperties( material, wrapped );

	// If the source material had its own `mrtNode` (e.g. user did
	// `mat.mrtNode = mrt({...})` for per-material MRT), and the artifact
	// did NOT already attach a stub, propagate it. The PrecompiledMaterial
	// constructor handles the artifact-driven case via `mrtOutputCount`;
	// this branch covers the rare per-material-MRT path so the wrapper
	// keeps the same shape as the source.
	if ( ! wrapped.mrtNode && material && material.mrtNode ) {

		wrapped.mrtNode = material.mrtNode;

	}

	return wrapped;

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
	// Material, MeshToonMaterial. Keep in sync with `__TEXTURE_PROPS` /
	// `__SCALAR_PROPS` in packages/examples/batch/run-e2e.mjs and the
	// `TEXTURE_PROPS` scan in runtime/src/hydrator.js.
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
		'alphaToCoverage',
		'depthTest',
		'depthWrite',
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
