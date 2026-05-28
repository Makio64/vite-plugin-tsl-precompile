import {
	DataArrayTexture,
	Data3DTexture,
	DataTexture,
	LinearFilter,
	LinearMipmapLinearFilter,
	LinearMipmapNearestFilter,
	NearestFilter,
	NearestMipmapLinearFilter,
	NearestMipmapNearestFilter,
	RedFormat,
	RGBAFormat,
	RGFormat,
	UnsignedByteType,
} from 'three';

const RGBFormat = 1022; // Deprecated and removed in modern Three.js


import { inferTextureTypeFromShader } from './texture-resolver.js';
import { resolveTypedArrayCtor } from './typed-arrays.js';

export function isTrivialSnapshot( snapshot ) {

	if ( ! snapshot || ! Array.isArray( snapshot.data ) ) return false;
	const data = snapshot.data;
	const len = data.length;
	if ( ! len || len > 65536 ) return false;
	const threshold = Math.max( 1, ( len * 0.01 ) | 0 );
	let nonZero = 0;
	for ( let i = 0; i < len; i ++ ) {

		if ( data[ i ] !== 0 ) {

			nonZero ++;
			if ( nonZero > threshold ) return false;

		}

	}
	return true;

}

export function textureFromSnapshot( artifact, uuid, snapshot, bindingName = null, textureTypeHint = null, options = {} ) {

	if ( ! snapshot || ! Array.isArray( snapshot.data ) || ! snapshot.width || ! snapshot.height ) {

		return resolveSnapshotFallback( artifact, bindingName, options );

	}
	const textureType = textureTypeHint && textureTypeHint !== 'unknown' ? textureTypeHint :
		bindingName ? inferTextureTypeFromShader( artifact, bindingName ) : null;
	const wants3DTexture = textureType === '3d';
	const wantsArrayTexture = textureType === '2d-array';
	const depth = ( wants3DTexture || wantsArrayTexture ) ?
		snapshot.depth || snapshot.layers || snapshot.depthOrArrayLayers || inferSnapshotArrayDepth( snapshot ) :
		1;
	const dimensionKey = wants3DTexture ? '3d' : wantsArrayTexture ? '2d-array' : '2d';
	const keyBase = uuid || `${ snapshot.width }x${ snapshot.height }:${ snapshot.data.length }`;
	const key = `${ keyBase }:${ dimensionKey }:${ depth }`;
	const cache = getTextureSnapshotCache( artifact );
	if ( cache && cache.has( key ) ) return cache.get( key );

	const TypeArray = resolveTypedArrayCtor( snapshot.arrayType || 'Uint8Array' );
	const data = new TypeArray( snapshot.data );
	const texture = wants3DTexture ? new Data3DTexture( data, snapshot.width, snapshot.height, depth ) :
		wantsArrayTexture ? new DataArrayTexture( data, snapshot.width, snapshot.height, depth ) :
			new DataTexture(
				data,
				snapshot.width,
				snapshot.height,
				snapshot.format || RGBAFormat,
				snapshot.type || UnsignedByteType
			);
	if ( wants3DTexture || wantsArrayTexture ) {

		texture.format = snapshot.format || RGBAFormat;
		texture.type = snapshot.type || UnsignedByteType;

	}
	if ( snapshot.colorSpace !== undefined ) texture.colorSpace = snapshot.colorSpace;
	for ( const prop of [ 'mapping', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'flipY' ] ) {

		if ( snapshot[ prop ] !== undefined && snapshot[ prop ] !== null ) texture[ prop ] = snapshot[ prop ];

	}
	if ( typeof snapshot.generateMipmaps === 'boolean' ) {

		texture.generateMipmaps = snapshot.generateMipmaps;

	} else if ( usesMipmapFilter( texture.minFilter ) ) {

		texture.minFilter = texture.magFilter === NearestFilter ? NearestFilter : LinearFilter;
		texture.generateMipmaps = false;

	}
	texture.needsUpdate = true;
	if ( cache ) cache.set( key, texture );
	return texture;

}

function resolveSnapshotFallback( artifact, bindingName, options ) {

	const fallbackTextureForBinding = options && options.fallbackTextureForBinding;
	if ( artifact && bindingName && fallbackTextureForBinding ) return fallbackTextureForBinding( artifact, bindingName );
	return options && Object.prototype.hasOwnProperty.call( options, 'fallbackTexture' ) ? options.fallbackTexture : null;

}

function getTextureSnapshotCache( artifact ) {

	if ( ! artifact ) return null;
	if ( ! artifact._textureSnapshotCache ) Object.defineProperty( artifact, '_textureSnapshotCache', { value: new Map(), enumerable: false } );
	return artifact._textureSnapshotCache;

}

function usesMipmapFilter( filter ) {

	return filter === NearestMipmapNearestFilter ||
		filter === NearestMipmapLinearFilter ||
		filter === LinearMipmapNearestFilter ||
		filter === LinearMipmapLinearFilter;

}

function inferSnapshotArrayDepth( snapshot ) {

	if ( ! snapshot || ! Array.isArray( snapshot.data ) || ! snapshot.width || ! snapshot.height ) return 1;
	const channels = channelsForTextureFormat( snapshot.format );
	const layerSize = snapshot.width * snapshot.height * channels;
	if ( layerSize <= 0 ) return 1;
	const depth = snapshot.data.length / layerSize;
	return Number.isFinite( depth ) && depth >= 1 ? Math.max( 1, Math.round( depth ) ) : 1;

}

function channelsForTextureFormat( format ) {

	switch ( format ) {

		case RedFormat:
			return 1;
		case RGFormat:
			return 2;
		case RGBFormat:
			return 3;
		case RGBAFormat:
		default:
			return 4;

	}

}
