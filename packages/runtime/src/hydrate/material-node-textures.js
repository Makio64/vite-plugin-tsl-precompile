import { collectMaterialNodeTextures } from './material-node-texture-collector.js';
import { lookupLiveTextureByIdentity } from './live-texture-registry.js';
import { textureMatchesShaderBinding } from './texture-resolver.js';

export { collectMaterialNodeTextures };

export function lookupMaterialNodeTexture( material, source, artifact, bindingName, avoidTexture = null ) {

	const textures = collectMaterialNodeTextures( material ).filter( ( texture ) => textureMatchesShaderBinding( artifact, bindingName, texture ) );
	if ( textures.length === 0 ) return null;
	const usableTextures = avoidTexture ? textures.filter( ( texture ) => texture !== avoidTexture ) : textures;

	if ( source && source.textureUuid ) {

		const match = usableTextures.find( ( texture ) => texture.uuid === source.textureUuid );
		if ( match ) return match;

	}
	const named = lookupLiveTextureByIdentity( source );
	if ( named && usableTextures.includes( named ) ) return named;

	if ( usableTextures.length === 1 ) return usableTextures[ 0 ];
	return null;

}
