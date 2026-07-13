import { DataTexture } from 'three/src/textures/DataTexture.js';
import {
	ClampToEdgeWrapping,
	HalfFloatType,
	LinearFilter,
	NearestFilter,
	RGBAFormat,
} from 'three/src/constants.js';

import { getDFGLUT } from '../dfg-lut.js';

export function buildLtcTexture( artifact, source ) {

	const ltcIndex = typeof source.ltcIndex === 'number' ? source.ltcIndex : 0;
	const ltcArrays = artifact.ltcTextures;
	if ( ! Array.isArray( ltcArrays ) || ltcIndex >= ltcArrays.length ) return null;

	if ( ! artifact._ltcTextureCache ) {

		Object.defineProperty( artifact, '_ltcTextureCache', {
			value: new Map(),
			enumerable: false,
			writable: true,
		} );

	}

	if ( artifact._ltcTextureCache.has( ltcIndex ) ) {

		return artifact._ltcTextureCache.get( ltcIndex );

	}

	const rawData = ltcArrays[ ltcIndex ];
	const isTyped = rawData instanceof Uint16Array;
	if ( ! isTyped && ! Array.isArray( rawData ) ) return null;
	if ( rawData.length !== 64 * 64 * 4 ) return null;

	const halfData = isTyped ? rawData : new Uint16Array( rawData );
	// Replace the boxed JSON array with the typed copy: same rebuild path for
	// other cache maps (variant views keep their own _ltcTextureCache), a
	// fraction of the retained memory.
	if ( ! isTyped ) ltcArrays[ ltcIndex ] = halfData;
	const tex = new DataTexture( halfData, 64, 64, RGBAFormat, HalfFloatType );

	tex.magFilter = typeof source.magFilter === 'number' ? source.magFilter : LinearFilter;
	tex.minFilter = typeof source.minFilter === 'number' ? source.minFilter : NearestFilter;
	tex.wrapS = typeof source.wrapS === 'number' ? source.wrapS : ClampToEdgeWrapping;
	tex.wrapT = typeof source.wrapT === 'number' ? source.wrapT : ClampToEdgeWrapping;
	tex.needsUpdate = true;

	artifact._ltcTextureCache.set( ltcIndex, tex );
	return tex;

}

export function resolveBuiltinTextureBinding( {
	artifact,
	source,
	bindingName,
	fallbackTextureForBinding,
	getDfgLut = getDFGLUT,
} ) {

	if ( ! source ) return undefined;
	const fallback = () => typeof fallbackTextureForBinding === 'function'
		? fallbackTextureForBinding( artifact, bindingName )
		: null;

	if ( source.kind === 'builtin.dfgLUT' ) {

		return getDfgLut() || fallback();

	}

	if ( source.kind === 'builtin.ltcTexture' ) {

		return buildLtcTexture( artifact, source ) || fallback();

	}

	return undefined;

}
