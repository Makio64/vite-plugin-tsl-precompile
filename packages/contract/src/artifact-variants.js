/**
 * Runtime fields that may differ between members of one captured material
 * family. Capture, manifest emission, registry merging, and hydration all use
 * this list so a newly-added variant field cannot drift between packages.
 */
export const ARTIFACT_VARIANT_FIELDS = Object.freeze( [
	'version',
	'cacheKey',
	'renderContextSelectors',
	'materialShape',
	'bindingOwner',
	'sourceMaterial',
	'vertexShader',
	'fragmentShader',
	'computeShader',
	'transforms',
	'attributes',
	'nodeAttributes',
	'bindings',
	'uniformPlan',
	'lightIdentities',
	'dynamicBindings',
	'defaults',
	'renderState',
	'ltcTextures',
	'meta',
	'mrtOutputCount',
	'mrtOutputNames',
	'mrtBlendModes',
] );

/**
 * Return the serializable, variant-local payload shared by artifact families.
 * Undefined fields are omitted to keep generated modules compact.
 *
 * @param {?Object} artifact
 * @return {Object}
 */
export function createArtifactVariantPayload( artifact ) {

	const payload = {};
	for ( const field of ARTIFACT_VARIANT_FIELDS ) {

		if ( artifact && artifact[ field ] !== undefined ) payload[ field ] = artifact[ field ];

	}
	return payload;

}
