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
 *
 * @module ApplyPrecompiled
 */

import { default as PrecompiledMaterial } from './_vendor-PrecompiledMaterial.js';
import { registerPrecompiledArtifacts } from './_vendor-PrecompiledArtifactRegistry.js';
import { registerArtifact } from './artifact-loader.js';

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

	// Wrap in PrecompiledMaterial. We copy a small set of user-visible
	// material properties over so downstream code that reads `mat.color`,
	// `mat.opacity`, etc. continues to work.
	const wrapped = new PrecompiledMaterial( artifact );
	copyCommonMaterialProperties( material, wrapped );

	return wrapped;

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

	const props = [
		'name',
		'color',
		'emissive',
		'emissiveIntensity',
		'roughness',
		'metalness',
		'specular',
		'specularColor',
		'specularIntensity',
		'shininess',
		'ior',
		'transmission',
		'thickness',
		'sheen',
		'sheenColor',
		'sheenRoughness',
		'clearcoat',
		'clearcoatRoughness',
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
		'wireframe',
		'flatShading',
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
		'clearcoatNormalScale',
		'transmissionMap',
		'thicknessMap',
		'iridescenceMap',
		'iridescenceThicknessMap',
		'sheenColorMap',
		'sheenRoughnessMap',
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
