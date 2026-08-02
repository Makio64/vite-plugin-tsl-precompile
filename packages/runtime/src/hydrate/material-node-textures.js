import { collectMaterialNodeTextures } from './material-node-texture-collector.js';
import { lookupLiveTextureByIdentity } from './live-texture-registry.js';
import { textureMatchesShaderBinding } from './texture-resolver.js';

export { collectMaterialNodeTextures };

export function lookupMaterialNodeTexture( material, source, artifact, bindingName, avoidTexture = null, textureCache = null ) {

	let collected = textureCache && material ? textureCache.get( material ) : null;
	if ( ! collected ) {

		collected = collectMaterialNodeTextures( material );
		if ( textureCache && material ) textureCache.set( material, collected );

	}
	const textures = collected.filter( ( texture ) => textureMatchesShaderBinding( artifact, bindingName, texture ) );
	if ( textures.length === 0 ) return null;
	const usableTextures = avoidTexture ? textures.filter( ( texture ) => texture !== avoidTexture ) : textures;

	if ( source && source.textureUuid ) {

		const match = usableTextures.find( ( texture ) => texture.uuid === source.textureUuid );
		if ( match ) return match;

	}
	const named = lookupLiveTextureByIdentity( source );
	if ( named && usableTextures.includes( named ) ) return named;

	// A named/URL-backed source carries a stable identity. If the public
	// material graph does not expose that texture, do not let its sole visible
	// input steal the binding by elimination. Private effect outputs (for
	// example GaussianBlurNode._textureNode) intentionally sit outside Three's
	// public node traversal and are resolved by the later _textureRefs/live
	// identity strategies instead.
	const hasStableIdentity = !! (
		source &&
		(
			typeof source.textureName === 'string' && source.textureName.length > 0 ||
			typeof source.imageSrc === 'string' && source.imageSrc.length > 0
		)
	);
	if ( usableTextures.length === 1 && ! hasStableIdentity ) return usableTextures[ 0 ];
	return null;

}
