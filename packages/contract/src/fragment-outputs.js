function countLocations( text ) {

	const matches = String( text || '' ).match( /@location\s*\(\s*\d+\s*\)/g );
	return matches ? matches.length : 0;

}

function escapeRegExp( value ) {

	return String( value ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );

}

function findStructBody( shader, structName ) {

	if ( ! structName ) return null;
	const re = new RegExp( `struct\\s+${ escapeRegExp( structName ) }\\s*\\{([\\s\\S]*?)\\}\\s*;` );
	const match = String( shader || '' ).match( re );
	return match ? match[ 1 ] : null;

}

function countFragmentReturnOutputs( shader ) {

	const fragmentMatch = String( shader || '' ).match( /@fragment[\s\S]*?fn\s+\w+\s*\([\s\S]*?\)\s*->\s*([^{]+)\{/ );
	if ( ! fragmentMatch ) return null;

	const returnType = fragmentMatch[ 1 ].trim();
	if ( returnType === 'void' ) return 0;

	const directLocations = countLocations( returnType );
	if ( directLocations > 0 ) return directLocations;

	const structName = returnType.match( /^([A-Za-z_$][\w$]*)\b/ );
	if ( structName ) {

		const body = findStructBody( shader, structName[ 1 ] );
		if ( body !== null ) return countLocations( body );

	}

	return null;

}

/**
 * Count fragment-stage outputs from WGSL source when the output shape can be
 * determined. Returns `null` when the shader does not expose a recognisable
 * fragment output declaration.
 *
 * @param {?string} fragmentShader
 * @returns {?number}
 */
export function countFragmentOutputsFromShader( fragmentShader ) {

	const shader = String( fragmentShader || '' );
	if ( shader.length === 0 ) return null;

	const outputVar = shader.match( /var<private>\s+output\s*:\s*([A-Za-z_$][\w$]*)\s*;/ );
	if ( outputVar ) {

		const body = findStructBody( shader, outputVar[ 1 ] );
		if ( body !== null ) return countLocations( body );

	}

	return countFragmentReturnOutputs( shader );

}

function countOwnArtifactFragmentOutputs( artifact, fallback ) {

	if ( ! artifact ) return fallback;

	if ( Array.isArray( artifact.fragmentOutputs ) ) return artifact.fragmentOutputs.length;

	const shaderCount = countFragmentOutputsFromShader( artifact.fragmentShader );
	if ( shaderCount !== null ) return shaderCount;

	if ( Array.isArray( artifact.mrtOutputNames ) && artifact.mrtOutputNames.length > 0 ) return artifact.mrtOutputNames.length;
	if ( typeof artifact.mrtOutputCount === 'number' && artifact.mrtOutputCount > 0 ) return artifact.mrtOutputCount;

	return fallback;

}

/**
 * Count render-target outputs for a precompiled artifact. Shader-declared
 * output structs win over metadata so malformed WGSL like `struct OutputType
 * {}` is treated as zero outputs even if the artifact came from an MRT pass.
 *
 * @param {?Object} artifact
 * @param {number} [fallback=1]
 * @returns {number}
 */
export function countArtifactFragmentOutputs( artifact, fallback = 1 ) {

	return countOwnArtifactFragmentOutputs( artifact, fallback );

}

/**
 * Count the maximum render-target output capacity across a variant-family
 * artifact. Use this for capability checks where a top-level single-output
 * artifact may also own an MRT variant under `variants`.
 *
 * @param {?Object} artifact
 * @param {number} [fallback=1]
 * @returns {number}
 */
export function countArtifactFragmentOutputCapacity( artifact, fallback = 1 ) {

	if ( ! artifact ) return fallback;

	let maxCount = countOwnArtifactFragmentOutputs( artifact, fallback );
	const variants = artifact.variants;
	if ( variants && typeof variants === 'object' ) {

		for ( const variant of Object.values( variants ) ) {

			maxCount = Math.max( maxCount, countOwnArtifactFragmentOutputs( variant, fallback ) );

		}

	}

	return maxCount;

}

export function hasUsableFragmentOutput( artifact ) {

	return countArtifactFragmentOutputCapacity( artifact, 1 ) > 0;

}
