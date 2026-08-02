export const SHADER_LANGUAGES = Object.freeze( {
	WGSL: 'wgsl',
	GLSL: 'glsl',
} );

export const SHADER_LANGUAGE_BACKENDS = Object.freeze( {
	[ SHADER_LANGUAGES.WGSL ]: 'webgpu',
	[ SHADER_LANGUAGES.GLSL ]: 'webgl',
} );

const SHADER_LANGUAGE_VALUES = new Set( Object.values( SHADER_LANGUAGES ) );

/**
 * Detect the native shader language from source emitted by a Three node
 * builder. The stage/preprocessor markers are deliberately stronger than
 * generic tokens such as `uniform`, which can appear in comments or helper
 * snippets in either language.
 *
 * @param {*} source
 * @return {'wgsl'|'glsl'|null}
 */
export function detectShaderLanguage( source ) {

	if ( typeof source !== 'string' || source.trim().length === 0 ) return null;
	if ( /^\s*#\s*version\s+\d+(?:\s+es)?\b/m.test( source ) ) return SHADER_LANGUAGES.GLSL;
	if ( /(?:^|[^\w])@(vertex|fragment|compute)\b/m.test( source ) ) return SHADER_LANGUAGES.WGSL;

	// These fallbacks cover isolated stages whose generated wrapper has been
	// removed while remaining conservative over arbitrary shader-like text.
	if ( /\bvoid\s+main\s*\(\s*\)/.test( source ) && /(?:^|\s)(?:layout\s*\(|precision\s+|in\s+|out\s+)/m.test( source ) ) {

		return SHADER_LANGUAGES.GLSL;

	}
	if ( /\bfn\s+\w+\s*\(/.test( source ) && /(?:\bvar\s*<|\b(?:vec|mat)\d[x\d]*\s*<\s*[fiu]\d+\s*>)/.test( source ) ) {

		return SHADER_LANGUAGES.WGSL;

	}
	return null;

}

/**
 * Detect one consistent language across an artifact's render or compute
 * stages. Unknown and mixed-language payloads return null; validation reports
 * mixed or declared-language mismatches separately.
 *
 * @param {?Object} artifact
 * @return {'wgsl'|'glsl'|null}
 */
export function detectArtifactShaderLanguage( artifact ) {

	if ( ! artifact || typeof artifact !== 'object' ) return null;
	const languages = new Set();
	for ( const field of [ 'vertexShader', 'fragmentShader', 'computeShader' ] ) {

		const language = detectShaderLanguage( artifact[ field ] );
		if ( language ) languages.add( language );

	}
	return languages.size === 1 ? languages.values().next().value : null;

}

/**
 * Return the renderer backend associated with a native shader language.
 *
 * @param {*} shaderLanguage
 * @return {'webgpu'|'webgl'|null}
 */
export function shaderLanguageBackend( shaderLanguage ) {

	return SHADER_LANGUAGE_VALUES.has( shaderLanguage )
		? SHADER_LANGUAGE_BACKENDS[ shaderLanguage ]
		: null;

}

/**
 * Namespace Three's backend-private cache key by the backend that can consume
 * its native shader source. `cacheKey` remains present on the artifact for
 * legacy/private routing; this key is only the durable artifact-family map
 * identity.
 *
 * @param {string|number} cacheKey
 * @param {'wgsl'|'glsl'} shaderLanguage
 * @return {string}
 */
export function createBackendAwareVariantKey( cacheKey, shaderLanguage ) {

	if ( cacheKey === undefined || cacheKey === null ) {

		throw new TypeError( 'createBackendAwareVariantKey: cacheKey is required.' );

	}
	const backend = shaderLanguageBackend( shaderLanguage );
	if ( backend === null ) {

		throw new TypeError( 'createBackendAwareVariantKey: shaderLanguage must be "wgsl" or "glsl".' );

	}
	return `${ backend }:${ String( cacheKey ) }`;

}

/**
 * Resolve the durable identity used by an artifact family map. Artifacts from
 * older toolchains carry no `variantKey`, so their raw cache key remains the
 * exact fallback identity.
 *
 * @param {?Object} artifact
 * @return {string|null}
 */
export function resolveArtifactVariantKey( artifact ) {

	if ( ! artifact || typeof artifact !== 'object' ) return null;
	if ( artifact.variantKey !== undefined && artifact.variantKey !== null ) {

		return typeof artifact.variantKey === 'string' && artifact.variantKey.length > 0
			? artifact.variantKey
			: null;

	}
	return artifact.cacheKey === undefined || artifact.cacheKey === null
		? null
		: String( artifact.cacheKey );

}
