/**
 * Durable identity for a texture attachment owned by a renderer render target.
 *
 * Runtime UUIDs cannot identify a newly-created replay target. This contract
 * instead records the exact attachment address, target topology, texture
 * shape, and either an authored name or a captured extent. It deliberately
 * contains no renderer or Three.js dependency so extraction, code generation,
 * validation, and replay share one vocabulary.
 */

export const RENDERER_RENDER_TARGET_TEXTURE_SELECTOR_SCHEMA = 'renderer-render-target-texture@1';

const ATTACHMENT_ROLES = new Set( [ 'color', 'depth' ] );
const TARGET_TOPOLOGIES = new Set( [ 'single', 'mrt', 'depth-only' ] );
const TEXTURE_DIMENSIONS = new Set( [ '2d', 'cube', '2d-array', '3d' ] );

function isObject( value ) {

	return value !== null && ( typeof value === 'object' || typeof value === 'function' );

}

function safeRead( owner, key ) {

	if ( ! owner ) return undefined;
	try {

		return owner[ key ];

	} catch ( _ ) {

		return undefined;

	}

}

function finitePositiveInteger( value ) {

	return Number.isInteger( value ) && value > 0 ? value : null;

}

function scalarOrNull( value ) {

	return value === undefined ? null : value;

}

function textureDimension( texture ) {

	if ( safeRead( texture, 'isCubeTexture' ) === true ) return 'cube';
	if (
		safeRead( texture, 'isDataArrayTexture' ) === true ||
		safeRead( texture, 'isCompressedArrayTexture' ) === true ||
		safeRead( texture, 'isArrayTexture' ) === true
	) return '2d-array';
	if (
		safeRead( texture, 'isData3DTexture' ) === true ||
		safeRead( texture, 'is3DTexture' ) === true
	) return '3d';
	return '2d';

}

function colorAttachments( target ) {

	const textures = safeRead( target, 'textures' );
	// Preserve sparse positions. Collapsing a missing MRT attachment would
	// silently relabel attachment N as N - 1.
	if ( Array.isArray( textures ) ) return textures.slice();
	const texture = safeRead( target, 'texture' );
	return isObject( texture ) ? [ texture ] : [];

}

function depthAttachment( target ) {

	const texture = safeRead( target, 'depthTexture' );
	return isObject( texture ) ? texture : null;

}

function targetDimension( target, colors, depthTexture ) {

	if (
		safeRead( target, 'isWebGLCubeRenderTarget' ) === true ||
		safeRead( target, 'isCubeRenderTarget' ) === true
	) return 'cube';
	if (
		safeRead( target, 'isWebGLArrayRenderTarget' ) === true ||
		safeRead( target, 'isArrayRenderTarget' ) === true ||
		safeRead( target, 'isRenderTargetArray' ) === true ||
		safeRead( target, 'isXRRenderTarget' ) === true
	) return '2d-array';
	if (
		safeRead( target, 'isWebGL3DRenderTarget' ) === true ||
		safeRead( target, 'isRenderTarget3D' ) === true ||
		safeRead( target, 'is3DRenderTarget' ) === true
	) return '3d';

	const dimensions = new Set( [ ...colors, depthTexture ].filter( Boolean ).map( textureDimension ) );
	if ( dimensions.size === 1 ) return dimensions.values().next().value;
	// "mixed" is intentionally outside the valid selector vocabulary. A
	// malformed live target can therefore never produce durable evidence.
	if ( dimensions.size > 1 ) return 'mixed';
	return '2d';

}

function targetTopology( colorCount ) {

	if ( colorCount === 0 ) return 'depth-only';
	return colorCount > 1 ? 'mrt' : 'single';

}

function textureExtent( target, texture, dimension ) {

	const image = safeRead( texture, 'image' );
	const width = finitePositiveInteger( safeRead( target, 'width' ) )
		?? finitePositiveInteger( safeRead( image, 'width' ) );
	const height = finitePositiveInteger( safeRead( target, 'height' ) )
		?? finitePositiveInteger( safeRead( image, 'height' ) );
	let depth = finitePositiveInteger( safeRead( target, 'depth' ) )
		?? finitePositiveInteger( safeRead( image, 'depth' ) );
	if ( depth === null && dimension === 'cube' ) depth = 6;
	if ( depth === null && dimension === '2d' ) depth = 1;
	return { width, height, depth };

}

function textureName( texture ) {

	const name = safeRead( texture, 'name' );
	return typeof name === 'string' && name.length > 0 ? name : null;

}

function targetDescriptor( target, colors, depthTexture ) {

	return {
		topology: targetTopology( colors.length ),
		dimension: targetDimension( target, colors, depthTexture ),
		mrtCount: colors.length,
	};

}

/**
 * Enumerate current render-target attachments without caching their texture
 * objects. Replay uses this on every resolution so resize/replacement remains
 * visible.
 */
export function rendererRenderTargetTextureAttachments( target ) {

	if ( ! isObject( target ) ) return [];
	const colors = colorAttachments( target );
	const depthTexture = depthAttachment( target );
	const attachments = [];
	for ( let index = 0; index < colors.length; index ++ ) {

		const texture = colors[ index ];
		if ( ! isObject( texture ) ) continue;
		attachments.push( {
			target,
			texture,
			role: 'color',
			index,
			colors,
			depthTexture,
		} );

	}
	if ( depthTexture ) attachments.push( {
		target,
		texture: depthTexture,
		role: 'depth',
		index: null,
		colors,
		depthTexture,
	} );
	return attachments;

}

function attachmentForOptions( target, options ) {

	const attachments = rendererRenderTargetTextureAttachments( target );
	const requestedTexture = isObject( options.texture ) ? options.texture : null;
	let role = options.role;
	let index = options.index;

	if ( requestedTexture ) {

		const attachment = attachments.find( ( candidate ) => candidate.texture === requestedTexture );
		if ( ! attachment ) throw new TypeError( 'Requested texture is not a current attachment of the render target.' );
		if ( role !== undefined && role !== attachment.role ) throw new TypeError( 'Render-target texture selector role does not match the requested texture.' );
		if ( index !== undefined && index !== attachment.index ) throw new TypeError( 'Render-target texture selector index does not match the requested texture.' );
		return attachment;

	}

	if ( role === undefined ) role = 'color';
	if ( ! ATTACHMENT_ROLES.has( role ) ) throw new TypeError( 'Render-target texture selector role must be "color" or "depth".' );
	if ( role === 'depth' ) {

		const attachment = attachments.find( ( candidate ) => candidate.role === 'depth' );
		if ( ! attachment ) throw new TypeError( 'Render target has no depth texture attachment.' );
		return attachment;

	}

	if ( index === undefined ) index = 0;
	if ( ! Number.isInteger( index ) || index < 0 ) throw new TypeError( 'Render-target color attachment index must be a non-negative integer.' );
	const attachment = attachments.find( ( candidate ) => candidate.role === 'color' && candidate.index === index );
	if ( ! attachment ) throw new TypeError( `Render target has no color texture attachment at index ${ index }.` );
	return attachment;

}

function createSelectorFromAttachment( attachment ) {

	const { target, texture, colors, depthTexture } = attachment;
	const dimension = textureDimension( texture );
	return {
		schema: RENDERER_RENDER_TARGET_TEXTURE_SELECTOR_SCHEMA,
		attachment: {
			role: attachment.role,
			index: attachment.index,
		},
		target: targetDescriptor( target, colors, depthTexture ),
		texture: {
			dimension,
			format: scalarOrNull( safeRead( texture, 'format' ) ),
			type: scalarOrNull( safeRead( texture, 'type' ) ),
			colorSpace: scalarOrNull( safeRead( texture, 'colorSpace' ) ),
		},
		hints: {
			name: textureName( texture ),
			extent: textureExtent( target, texture, dimension ),
		},
	};

}

/**
 * Create the JSON-safe selector persisted beside an `artifact.texture` or
 * non-light `depth.texture` source. Passing `options.texture` proves the exact
 * role/index by live attachment identity.
 */
export function createRendererRenderTargetTextureSelector( renderTarget, options = {} ) {

	if ( ! isObject( renderTarget ) ) throw new TypeError( 'A render target object is required to create a render-target texture selector.' );
	if ( ! options || typeof options !== 'object' ) throw new TypeError( 'Render-target texture selector options must be an object.' );
	const selector = createSelectorFromAttachment( attachmentForOptions( renderTarget, options ) );
	const invalidReason = rendererRenderTargetTextureSelectorValidationError( selector );
	if ( invalidReason ) throw new TypeError( `Cannot create render-target texture selector: ${ invalidReason }.` );
	return selector;

}

function validateScalar( value ) {

	return value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite( value );

}

export function rendererRenderTargetTextureSelectorValidationError( selector ) {

	if ( ! selector || typeof selector !== 'object' || Array.isArray( selector ) ) return 'selector-not-object';
	if ( selector.schema !== RENDERER_RENDER_TARGET_TEXTURE_SELECTOR_SCHEMA ) return 'unsupported-selector-schema';

	const attachment = selector.attachment;
	if ( ! attachment || ! ATTACHMENT_ROLES.has( attachment.role ) ) return 'invalid-attachment-role';
	if ( attachment.role === 'color' && ( ! Number.isInteger( attachment.index ) || attachment.index < 0 ) ) return 'invalid-color-attachment-index';
	if ( attachment.role === 'depth' && attachment.index !== null ) return 'invalid-depth-attachment-index';

	const target = selector.target;
	if ( ! target || ! TARGET_TOPOLOGIES.has( target.topology ) ) return 'invalid-target-topology';
	if ( ! TEXTURE_DIMENSIONS.has( target.dimension ) ) return 'invalid-target-dimension';
	if ( ! Number.isInteger( target.mrtCount ) || target.mrtCount < 0 ) return 'invalid-target-mrt-count';
	if ( target.topology === 'single' && target.mrtCount !== 1 ) return 'inconsistent-target-topology';
	if ( target.topology === 'mrt' && target.mrtCount < 2 ) return 'inconsistent-target-topology';
	if ( target.topology === 'depth-only' && target.mrtCount !== 0 ) return 'inconsistent-target-topology';
	if ( attachment.role === 'color' && attachment.index >= target.mrtCount ) return 'color-attachment-index-out-of-range';

	const texture = selector.texture;
	if ( ! texture || ! TEXTURE_DIMENSIONS.has( texture.dimension ) ) return 'invalid-texture-dimension';
	if ( ! validateScalar( texture.format ) || ! validateScalar( texture.type ) || ! validateScalar( texture.colorSpace ) ) return 'invalid-texture-shape';

	const hints = selector.hints;
	if ( ! hints || ( hints.name !== null && ( typeof hints.name !== 'string' || hints.name.length === 0 ) ) ) return 'invalid-name-hint';
	const extent = hints.extent;
	if ( ! extent || ! [ extent.width, extent.height, extent.depth ].every( ( value ) => value === null || finitePositiveInteger( value ) === value ) ) return 'invalid-extent-hint';
	if ( hints.name === null && ( extent.width === null || extent.height === null ) ) return 'anonymous-selector-missing-extent';
	return null;

}

export function isRendererRenderTargetTextureSelector( selector ) {

	return rendererRenderTargetTextureSelectorValidationError( selector ) === null;

}

export function rendererRenderTargetTextureSelectorsMatch( selector, candidateSelector, options = {} ) {

	if (
		rendererRenderTargetTextureSelectorValidationError( selector ) !== null ||
		rendererRenderTargetTextureSelectorValidationError( candidateSelector ) !== null
	) return false;
	if (
		selector.attachment.role !== candidateSelector.attachment.role ||
		selector.attachment.index !== candidateSelector.attachment.index
	) return false;
	if (
		selector.target.topology !== candidateSelector.target.topology ||
		selector.target.dimension !== candidateSelector.target.dimension ||
		selector.target.mrtCount !== candidateSelector.target.mrtCount
	) return false;
	if (
		selector.texture.dimension !== candidateSelector.texture.dimension ||
		selector.texture.format !== candidateSelector.texture.format ||
		selector.texture.type !== candidateSelector.texture.type ||
		selector.texture.colorSpace !== candidateSelector.texture.colorSpace
	) return false;
	if ( options && options.matchHints === false ) return true;

	const expectedName = selector.hints.name;
	if ( expectedName !== null ) return candidateSelector.hints.name === expectedName;
	const expectedExtent = selector.hints.extent;
	const candidateExtent = candidateSelector.hints.extent;
	return (
		expectedExtent.width === candidateExtent.width &&
		expectedExtent.height === candidateExtent.height &&
		expectedExtent.depth === candidateExtent.depth
	);

}
