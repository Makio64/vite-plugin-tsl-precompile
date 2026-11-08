export function textureBindingNameForSampler( bindingName ) {

	return typeof bindingName === 'string' && bindingName.endsWith( '_sampler' )
		? bindingName.slice( 0, - '_sampler'.length )
		: bindingName;

}

// One immutable description serves every probe for a binding. Keep shader
// identity alongside the cache so registry replacements cannot reuse old facts.
const shaderBindings = new WeakMap();

function describeShaderBinding( artifact, bindingName ) {

	const owner = artifact && typeof artifact === 'object' ? artifact : null;
	const vertex = owner && owner.vertexShader || '';
	const fragment = owner && owner.fragmentShader || '';
	const compute = owner && owner.computeShader || '';
	let cache = owner && shaderBindings.get( owner );
	if ( ! cache || cache.vertex !== vertex || cache.fragment !== fragment || cache.compute !== compute ) {

		cache = { vertex, fragment, compute, source: `${ vertex }\n${ fragment }\n${ compute }`, bindings: new Map() };
		if ( owner ) shaderBindings.set( owner, cache );

	}
	let description = cache.bindings.get( bindingName );
	if ( ! description ) {

		description = inspectShaderBinding( cache.source, bindingName );
		cache.bindings.set( bindingName, description );

	}
	return description;

}

function escapeBindingName( name ) {

	return String( name || '' ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );

}

function inspectShaderBinding( source, bindingName ) {

	const textureName = textureBindingNameForSampler( bindingName );
	const escaped = escapeBindingName( textureName );
	const types = Array.from( source.matchAll( new RegExp( `var\\s+${ escaped }\\s*:\\s*([A-Za-z_][A-Za-z_0-9]*)`, 'g' ) ), match => match[ 1 ] );
	const glsl = new RegExp( `\\buniform\\s+(?:(?:lowp|mediump|highp)\\s+)?([iu]?sampler[A-Za-z0-9_]*)\\s+${ escaped }\\b`, 'm' ).exec( source )?.[ 1 ].toLowerCase() || '';
	const has = prefix => types.some( type => type.startsWith( prefix ) );
	const cube = has( 'texture_cube' ) || has( 'texture_depth_cube' );
	const array = has( 'texture_2d_array' ) || has( 'texture_depth_2d_array' );
	return {
		depth: has( 'texture_depth' ) || glsl.includes( 'shadow' ),
		cube: cube || glsl.includes( 'cube' ),
		array: array || glsl.includes( '2darray' ),
		multisampled: has( 'texture_multisampled_2d' ) || has( 'texture_depth_multisampled_2d' ) || glsl.includes( '2dms' ),
		comparison: ( textureName === bindingName ? has( 'sampler_comparison' )
			: new RegExp( `var\\s+${ escapeBindingName( bindingName ) }\\s*:\\s*sampler_comparison`, 'm' ).test( source ) ) || glsl.includes( 'shadow' ),
		type: cube ? 'cube' : has( 'texture_3d' ) ? '3d' : array ? '2d-array'
			: glsl.includes( 'cube' ) ? 'cube' : glsl.includes( '3d' ) ? '3d' : glsl.includes( '2darray' ) ? '2d-array' : null,
	};

}

export function resolvePlanTextureTypeHint( artifact, group, textureEntry, source, bindingName, textureEntries = null ) {

	const textureBindingName = textureBindingNameForSampler( bindingName );
	const shaderType = inferTextureTypeFromShader( artifact, textureBindingName );
	const explicit = textureEntry && textureEntry.textureType && textureEntry.textureType !== 'unknown' ? textureEntry.textureType
		: source && source.textureType && source.textureType !== 'unknown' ? source.textureType
			: source && source.textureDimension && source.textureDimension !== 'unknown' ? source.textureDimension
				: null;
	if ( explicit ) return shaderType && shaderType !== explicit ? shaderType : explicit;

	if ( textureBindingName !== bindingName && group && Array.isArray( group.textures ) ) {

		const paired = textureEntries ? textureEntries.get( textureBindingName )
			: group.textures.find( ( item ) => item && item.name === textureBindingName );
		if ( paired && paired.textureType && paired.textureType !== 'unknown' ) return shaderType && shaderType !== paired.textureType ? shaderType : paired.textureType;
		const pairedSource = paired && paired.source || null;
		if ( pairedSource && pairedSource.textureType && pairedSource.textureType !== 'unknown' ) return shaderType && shaderType !== pairedSource.textureType ? shaderType : pairedSource.textureType;
		if ( pairedSource && pairedSource.textureDimension && pairedSource.textureDimension !== 'unknown' ) return shaderType && shaderType !== pairedSource.textureDimension ? shaderType : pairedSource.textureDimension;

	}

	return shaderType;

}

export function shaderDeclaresDepthTexture( artifact, bindingName ) {

	return describeShaderBinding( artifact, bindingName ).depth;

}

export function shaderDeclaresComparisonSampler( artifact, bindingName ) {

	return describeShaderBinding( artifact, bindingName ).comparison;

}

export function shaderDeclaresCubeTexture( artifact, bindingName ) {

	return describeShaderBinding( artifact, bindingName ).cube;

}

export function shaderDeclaresMultisampledTexture( artifact, bindingName ) {

	return describeShaderBinding( artifact, bindingName ).multisampled;

}

export function shaderDeclaresArrayTexture( artifact, bindingName ) {

	return describeShaderBinding( artifact, bindingName ).array;

}

export function inferTextureTypeFromShader( artifact, bindingName ) {

	return describeShaderBinding( artifact, bindingName ).type;

}

export function isLikelyMultisampledTexture( texture ) {

	return !! ( texture && texture.renderTarget && texture.renderTarget.samples > 1 );

}

export function textureMatchesShaderMultisample( artifact, bindingName, texture ) {

	if ( ! texture ) return true;
	const multisampled = shaderDeclaresMultisampledTexture( artifact, bindingName );
	if ( texture.isRenderTargetTexture === true && texture.isDepthTexture !== true ) return multisampled === false;
	const isMultisampledTexture = isLikelyMultisampledTexture( texture );
	return multisampled ? isMultisampledTexture : ! isMultisampledTexture;

}

export function textureMatchesShaderBinding( artifact, bindingName, texture ) {

	if ( ! texture ) return true;
	const { multisampled, depth, cube, type } = describeShaderBinding( artifact, bindingName );
	const isMultisampled = texture.isRenderTargetTexture === true && texture.isDepthTexture !== true ? false : isLikelyMultisampledTexture( texture );
	if ( multisampled !== isMultisampled ) return false;
	if ( depth ) {

		if ( texture.isDepthTexture !== true ) return false;
		if ( type === 'cube' ) return texture.isCubeTexture === true;
		if ( type === '2d-array' ) return texture.isArrayTexture === true || texture.isDataArrayTexture === true || texture.isCompressedArrayTexture === true || ( texture.image && texture.image.depth > 1 );
		return true;

	}
	if ( texture.isDepthTexture === true ) return false;
	if ( cube ) return texture.isCubeTexture === true;
	if ( type === '3d' ) return texture.isData3DTexture === true || texture.is3DTexture === true || texture.isTexture3D === true;
	if ( type === '2d-array' ) return texture.isDataArrayTexture === true || texture.isArrayTexture === true || texture.isCompressedArrayTexture === true || ( texture.isDepthTexture === true && texture.image && texture.image.depth > 1 );
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
	const {
		depth: wantsDepth, cube: wantsCube,
		array: wantsArray, multisampled: wantsMultisampled,
		comparison, type,
	} = describeShaderBinding( artifact, bindingName );

	if ( wantsDepth && wantsCube ) return depthCube;
	if ( wantsDepth && wantsArray ) return depthArray;
	if ( wantsDepth && wantsMultisampled ) return multisampledDepth;
	if ( comparison ) return comparisonDepth;
	if ( wantsDepth ) return depth;
	if ( wantsCube ) return cube;
	if ( type === '3d' ) return texture3D;
	if ( wantsArray ) return array;
	return texture;

}
