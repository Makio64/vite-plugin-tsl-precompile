export function textureBindingNameForSampler( bindingName ) {

	return typeof bindingName === 'string' && bindingName.endsWith( '_sampler' )
		? bindingName.slice( 0, - '_sampler'.length )
		: bindingName;

}

// The shaderDeclares* probes run once per binding during hydration; without a
// cache each call re-concatenates the full WGSL and compiles a fresh RegExp.
// Artifact shader strings are never reassigned after load, so both the
// concatenated source and the per-binding query results are cacheable for the
// lifetime of the artifact object.
const _shaderSourceCache = new WeakMap();
const _shaderQueryCache = new WeakMap();

function shaderSource( artifact ) {

	if ( ! artifact || typeof artifact !== 'object' ) return '\n\n';
	let src = _shaderSourceCache.get( artifact );
	if ( src === undefined ) {

		src = `${ artifact.vertexShader || '' }\n${ artifact.fragmentShader || '' }\n${ artifact.computeShader || '' }`;
		_shaderSourceCache.set( artifact, src );

	}

	return src;

}

function cachedShaderQuery( artifact, key, compute ) {

	if ( ! artifact || typeof artifact !== 'object' ) return compute( artifact );
	let map = _shaderQueryCache.get( artifact );
	if ( ! map ) {

		map = new Map();
		_shaderQueryCache.set( artifact, map );

	}

	if ( map.has( key ) ) return map.get( key );
	const value = compute( artifact );
	map.set( key, value );
	return value;

}

function escapedBindingName( bindingName ) {

	return textureBindingNameForSampler( bindingName ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );

}

function glslSamplerTypeForBinding( artifact, bindingName ) {

	return cachedShaderQuery( artifact, `glsl-sampler:${ bindingName }`, ( a ) => {

		const escaped = escapedBindingName( bindingName );
		const match = new RegExp(
			`\\buniform\\s+(?:(?:lowp|mediump|highp)\\s+)?([iu]?sampler[A-Za-z0-9_]*)\\s+${ escaped }\\b`,
			'm',
		).exec( shaderSource( a ) );
		return match ? match[ 1 ] : null;

	} );

}

function glslSamplerHasShape( samplerType, shape ) {

	return typeof samplerType === 'string' && samplerType.toLowerCase().includes( shape );

}

export function resolvePlanTextureTypeHint( artifact, group, textureEntry, source, bindingName ) {

	const textureBindingName = textureBindingNameForSampler( bindingName );
	const shaderType = inferTextureTypeFromShader( artifact, textureBindingName );
	const explicit = textureEntry && textureEntry.textureType && textureEntry.textureType !== 'unknown' ? textureEntry.textureType
		: source && source.textureType && source.textureType !== 'unknown' ? source.textureType
			: source && source.textureDimension && source.textureDimension !== 'unknown' ? source.textureDimension
				: null;
	if ( explicit ) return shaderType && shaderType !== explicit ? shaderType : explicit;

	if ( textureBindingName !== bindingName && group && Array.isArray( group.textures ) ) {

		const paired = group.textures.find( ( item ) => item && item.name === textureBindingName );
		if ( paired && paired.textureType && paired.textureType !== 'unknown' ) return shaderType && shaderType !== paired.textureType ? shaderType : paired.textureType;
		const pairedSource = paired && paired.source || null;
		if ( pairedSource && pairedSource.textureType && pairedSource.textureType !== 'unknown' ) return shaderType && shaderType !== pairedSource.textureType ? shaderType : pairedSource.textureType;
		if ( pairedSource && pairedSource.textureDimension && pairedSource.textureDimension !== 'unknown' ) return shaderType && shaderType !== pairedSource.textureDimension ? shaderType : pairedSource.textureDimension;

	}

	return shaderType;

}

export function shaderDeclaresDepthTexture( artifact, bindingName ) {

	return cachedShaderQuery( artifact, `depth:${ bindingName }`, ( a ) => {

		const escaped = escapedBindingName( bindingName );
		return new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_depth`, 'm' ).test( shaderSource( a ) ) ||
			glslSamplerHasShape( glslSamplerTypeForBinding( a, bindingName ), 'shadow' );

	} );

}

export function shaderDeclaresComparisonSampler( artifact, bindingName ) {

	return cachedShaderQuery( artifact, `comparison:${ bindingName }`, ( a ) => {

		const escaped = String( bindingName || '' ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
		return new RegExp( `var\\s+${ escaped }\\s*:\\s*sampler_comparison`, 'm' ).test( shaderSource( a ) ) ||
			glslSamplerHasShape( glslSamplerTypeForBinding( a, bindingName ), 'shadow' );

	} );

}

export function shaderDeclaresCubeTexture( artifact, bindingName ) {

	return cachedShaderQuery( artifact, `cube:${ bindingName }`, ( a ) => {

		const escaped = escapedBindingName( bindingName );
		return new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_(?:depth_)?cube`, 'm' ).test( shaderSource( a ) ) ||
			glslSamplerHasShape( glslSamplerTypeForBinding( a, bindingName ), 'cube' );

	} );

}

export function shaderDeclaresMultisampledTexture( artifact, bindingName ) {

	return cachedShaderQuery( artifact, `multisampled:${ bindingName }`, ( a ) => {

		const escaped = escapedBindingName( bindingName );
		return new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_(?:depth_)?multisampled_2d`, 'm' ).test( shaderSource( a ) ) ||
			glslSamplerHasShape( glslSamplerTypeForBinding( a, bindingName ), '2dms' );

	} );

}

export function shaderDeclaresArrayTexture( artifact, bindingName ) {

	return cachedShaderQuery( artifact, `array:${ bindingName }`, ( a ) => {

		const escaped = escapedBindingName( bindingName );
		return new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_(?:depth_)?2d_array`, 'm' ).test( shaderSource( a ) ) ||
			glslSamplerHasShape( glslSamplerTypeForBinding( a, bindingName ), '2darray' );

	} );

}

export function inferTextureTypeFromShader( artifact, bindingName ) {

	return cachedShaderQuery( artifact, `infer:${ bindingName }`, ( a ) => {

		const wgsl = shaderSource( a );
		const escaped = escapedBindingName( bindingName );
		if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_depth_cube`, 'm' ).test( wgsl ) ) return 'cube';
		if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_cube`, 'm' ).test( wgsl ) ) return 'cube';
		if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_3d`, 'm' ).test( wgsl ) ) return '3d';
		if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_(?:depth_)?2d_array`, 'm' ).test( wgsl ) ) return '2d-array';
		const glslSamplerType = glslSamplerTypeForBinding( a, bindingName );
		if ( glslSamplerHasShape( glslSamplerType, 'cube' ) ) return 'cube';
		if ( glslSamplerHasShape( glslSamplerType, '3d' ) ) return '3d';
		if ( glslSamplerHasShape( glslSamplerType, '2darray' ) ) return '2d-array';
		return null;

	} );

}

export function isLikelyMultisampledTexture( texture ) {

	return !! ( texture && texture.renderTarget && texture.renderTarget.samples > 1 );

}

export function textureMatchesShaderMultisample( artifact, bindingName, texture ) {

	if ( ! texture ) return true;
	const wantsMultisampledTexture = shaderDeclaresMultisampledTexture( artifact, bindingName );
	if ( texture.isRenderTargetTexture === true && texture.isDepthTexture !== true ) return wantsMultisampledTexture === false;
	const isMultisampledTexture = isLikelyMultisampledTexture( texture );
	return wantsMultisampledTexture ? isMultisampledTexture : ! isMultisampledTexture;

}

export function textureMatchesShaderBinding( artifact, bindingName, texture ) {

	if ( ! textureMatchesShaderMultisample( artifact, bindingName, texture ) ) return false;
	if ( ! texture ) return true;
	const wantsDepthTexture = shaderDeclaresDepthTexture( artifact, bindingName );
	const textureType = inferTextureTypeFromShader( artifact, bindingName );
	if ( wantsDepthTexture ) {

		if ( texture.isDepthTexture !== true ) return false;
		if ( textureType === 'cube' ) return texture.isCubeTexture === true;
		if ( textureType === '2d-array' ) return texture.isArrayTexture === true || texture.isDataArrayTexture === true || texture.isCompressedArrayTexture === true || ( texture.image && texture.image.depth > 1 );
		return true;

	}
	if ( texture.isDepthTexture === true ) return false;
	if ( shaderDeclaresCubeTexture( artifact, bindingName ) ) return texture.isCubeTexture === true;
	if ( textureType === '3d' ) return texture.isData3DTexture === true || texture.is3DTexture === true || texture.isTexture3D === true;
	if ( textureType === '2d-array' ) return texture.isDataArrayTexture === true || texture.isArrayTexture === true || texture.isCompressedArrayTexture === true || ( texture.isDepthTexture === true && texture.image && texture.image.depth > 1 );
	return true;

}

export function selectFallbackTextureForBinding( artifact, bindingName, fallbacks ) {

	const texture = fallbacks && fallbacks.texture || null;
	const comparisonDepth = fallbacks && fallbacks.comparisonDepth || texture;
	const depth = fallbacks && fallbacks.depth || texture;
	const depthCube = fallbacks && fallbacks.depthCube || depth;
	const depthArray = fallbacks && fallbacks.depthArray || depth;
	const multisampledDepth = fallbacks && fallbacks.multisampledDepth || depth;
	const cube = fallbacks && fallbacks.cube || texture;
	const texture3D = fallbacks && fallbacks.texture3D || texture;
	const array = fallbacks && fallbacks.array || texture;
	const wantsDepth = shaderDeclaresDepthTexture( artifact, bindingName );
	const wantsCube = shaderDeclaresCubeTexture( artifact, bindingName );
	const wantsArray = shaderDeclaresArrayTexture( artifact, bindingName );
	const wantsMultisampled = shaderDeclaresMultisampledTexture( artifact, bindingName );

	if ( wantsDepth && wantsCube ) return depthCube;
	if ( wantsDepth && wantsArray ) return depthArray;
	if ( wantsDepth && wantsMultisampled ) return multisampledDepth;
	if ( shaderDeclaresComparisonSampler( artifact, bindingName ) ) return comparisonDepth;
	if ( wantsDepth ) return depth;
	if ( wantsCube ) return cube;
	if ( inferTextureTypeFromShader( artifact, bindingName ) === '3d' ) return texture3D;
	if ( wantsArray ) return array;
	if ( /sampler/i.test( bindingName ) ) {

		const textureName = bindingName.replace( /_sampler$/, '' );
		if ( textureName !== bindingName && shaderDeclaresDepthTexture( artifact, textureName ) ) return shaderDeclaresComparisonSampler( artifact, bindingName ) ? comparisonDepth : depth;

	}
	return texture;

}
