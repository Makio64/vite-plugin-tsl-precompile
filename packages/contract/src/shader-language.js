import { fragmentOutputInterface } from './fragment-output-interface.js';

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
 * Give Three's capture-local WGSL uniform buffers stable binding-address names.
 * WebGPU binds these resources by group/index, so process-local Node IDs must
 * not force a second shader module or pipeline after a live texture swap.
 * GLSL uniform block names participate in binding and are left untouched.
 *
 * @param {string} source
 * @return {string}
 */
export function stabilizeWgslBufferIdentifiers( source ) {

	if ( detectShaderLanguage( source ) !== SHADER_LANGUAGES.WGSL ) return source;
	const names = new Map();
	const declarations = /@binding\(\s*(\d+)\s*\)\s*@group\(\s*(\d+)\s*\)\s*var<uniform>\s*NodeBuffer_(\d+)\s*:\s*NodeBuffer_\3Struct\s*;/g;
	for ( const [ , binding, group, id ] of source.matchAll( declarations ) ) {

		const name = `NodeBuffer_tslp_${ group }_${ binding }`;
		// Do not collide with an authored identifier, even in unusual shaders.
		if ( new RegExp( `\\b${ name }(?:Struct)?\\b` ).test( source ) ) return source;
		names.set( id, name );

	}
	if ( names.size === 0 ) return source;
	return source.replace( /\bNodeBuffer_(\d+)(Struct)?\b/g, ( original, id, suffix = '' ) => {

		const name = names.get( id );
		return name ? name + suffix : original;

	} );

}

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
 * @param {?Object} [layout] - Captured MRT attachment layout, when present.
 * @return {string}
 */
export function createBackendAwareVariantKey( cacheKey, shaderLanguage, layout = null ) {

	if ( cacheKey === undefined || cacheKey === null ) {

		throw new TypeError( 'createBackendAwareVariantKey: cacheKey is required.' );

	}
	const backend = shaderLanguageBackend( shaderLanguage );
	if ( backend === null ) {

		throw new TypeError( 'createBackendAwareVariantKey: shaderLanguage must be "wgsl" or "glsl".' );

	}
	const key = `${ backend }:${ String( cacheKey ) }`;
	if ( ! ( layout?.mrtOutputCount > 0 ) ) return key;
	// Three's context IDs are process-local: independent pages can reuse one
	// private key for different MRT layouts. Keep the exact attachment contract
	// in durable identity; selector collisions still reject divergent programs.
	const names = layout.mrtOutputNames || [];
	const blends = Object.entries( layout.mrtBlendModes || {} ).sort( ( a, b ) => a[ 0 ] < b[ 0 ] ? - 1 : a[ 0 ] > b[ 0 ] ? 1 : 0 );
	const outputs = fragmentOutputInterface( layout.fragmentShader, shaderLanguage );
	return `${ key }:mrt:${ JSON.stringify( [ layout.mrtOutputCount, names, blends, ...( outputs ? [ outputs ] : [] ) ] ) }`;

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
