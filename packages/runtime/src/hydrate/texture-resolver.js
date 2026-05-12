export function textureBindingNameForSampler( bindingName ) {

	return typeof bindingName === 'string' && bindingName.endsWith( '_sampler' )
		? bindingName.slice( 0, - '_sampler'.length )
		: bindingName;

}

export function findPlanTextureSource( artifact, groupName, bindingName ) {

	const plan = Array.isArray( artifact && artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const group = plan.find( ( item ) => item.name === groupName );
	if ( ! group ) return null;
	const texture = ( group.textures || [] ).find( ( item ) => item.name === bindingName );
	return texture ? texture.source || null : null;

}

function shaderSource( artifact ) {

	return `${ artifact && artifact.vertexShader || '' }\n${ artifact && artifact.fragmentShader || '' }\n${ artifact && artifact.computeShader || '' }`;

}

function escapedBindingName( bindingName ) {

	return textureBindingNameForSampler( bindingName ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );

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

	const escaped = escapedBindingName( bindingName );
	return new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_depth`, 'm' ).test( shaderSource( artifact ) );

}

export function shaderDeclaresComparisonSampler( artifact, bindingName ) {

	const escaped = String( bindingName || '' ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	return new RegExp( `var\\s+${ escaped }\\s*:\\s*sampler_comparison`, 'm' ).test( shaderSource( artifact ) );

}

export function shaderDeclaresCubeTexture( artifact, bindingName ) {

	const escaped = escapedBindingName( bindingName );
	return new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_(?:depth_)?cube`, 'm' ).test( shaderSource( artifact ) );

}

export function shaderDeclaresMultisampledTexture( artifact, bindingName ) {

	const escaped = escapedBindingName( bindingName );
	return new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_(?:depth_)?multisampled_2d`, 'm' ).test( shaderSource( artifact ) );

}

export function shaderDeclaresArrayTexture( artifact, bindingName ) {

	const escaped = escapedBindingName( bindingName );
	return new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_(?:depth_)?2d_array`, 'm' ).test( shaderSource( artifact ) );

}

export function inferTextureTypeFromShader( artifact, bindingName ) {

	const wgsl = shaderSource( artifact );
	const escaped = escapedBindingName( bindingName );
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_depth_cube`, 'm' ).test( wgsl ) ) return 'cube';
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_cube`, 'm' ).test( wgsl ) ) return 'cube';
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_3d`, 'm' ).test( wgsl ) ) return '3d';
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_(?:depth_)?2d_array`, 'm' ).test( wgsl ) ) return '2d-array';
	return null;

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
	if ( texture.isDepthTexture === true ) return wantsDepthTexture;
	if ( wantsDepthTexture ) return false;
	if ( shaderDeclaresCubeTexture( artifact, bindingName ) ) return texture.isCubeTexture === true;
	const textureType = inferTextureTypeFromShader( artifact, bindingName );
	if ( textureType === '3d' ) return texture.isData3DTexture === true || texture.isTexture3D === true;
	if ( textureType === '2d-array' ) return texture.isDataArrayTexture === true || texture.isArrayTexture === true || texture.isCompressedArrayTexture === true || ( texture.isDepthTexture === true && texture.image && texture.image.depth > 1 );
	return true;

}
