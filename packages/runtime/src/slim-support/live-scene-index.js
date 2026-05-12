import { MATERIAL_TEXTURE_PROPS } from '@tsl-precompile/contract/texture-props';
import { collectMaterialNodeTextures } from '../hydrate/material-node-textures.js';

export { collectMaterialNodeTextures } from '../hydrate/material-node-textures.js';

export function textureImageSrc( texture ) {

	const image = texture && texture.image || null;
	if ( Array.isArray( image ) && image.length > 0 ) {

		const first = image[ 0 ];
		const src = first && ( first.src || first.currentSrc || null );
		return typeof src === 'string' && src.length > 0 ? src : '';

	}
	if ( image && typeof image.src === 'string' ) return image.src;
	if ( image && typeof image.currentSrc === 'string' ) return image.currentSrc;
	if ( image && image.image && typeof image.image.src === 'string' ) return image.image.src;
	if ( texture && texture.source && texture.source.data && typeof texture.source.data.src === 'string' ) return texture.source.data.src;
	return '';

}

export function textureImageReady( texture ) {

	if ( ! texture || texture.isTexture !== true ) return false;
	const hasSize = ( image ) => {

		if ( ! image ) return false;
		const width = image.width || image.naturalWidth || image.videoWidth || image.image && image.image.width;
		const height = image.height || image.naturalHeight || image.videoHeight || image.image && image.image.height;
		return width > 0 && height > 0;

	};
	const img = texture.image;
	if ( img === null || img === undefined ) return false;
	if ( Array.isArray( img ) ) {

		if ( img.length === 0 ) return false;
		for ( const face of img ) if ( ! hasSize( face ) ) return false;
		return true;

	}
	return hasSize( img );

}

export function newFallbackTextureImage() {

	return { data: new Uint8Array( [ 255, 255, 255, 255 ] ), width: 1, height: 1 };

}

export function healTextureImage( texture, diagnostics = null ) {

	if ( ! texture || texture.isTexture !== true ) return false;
	const img = texture.image;
	if ( img === null || img === undefined ) {

		try {

			texture.image = newFallbackTextureImage();
			if ( diagnostics ) diagnostics.healedNullTextureImages = ( diagnostics.healedNullTextureImages | 0 ) + 1;
			return true;

		} catch ( _ ) {

			return false;

		}

	}
	if ( Array.isArray( img ) ) {

		let changed = false;
		const healed = img.map( ( face ) => {

			if ( face ) return face;
			changed = true;
			return newFallbackTextureImage();

		} );
		if ( changed ) {

			try {

				texture.image = healed;
				if ( diagnostics ) diagnostics.healedNullTextureImages = ( diagnostics.healedNullTextureImages | 0 ) + 1;
				return true;

			} catch ( _ ) {

				return false;

			}

		}

	}
	return false;

}

export function basenameFromUrl( value ) {

	const raw = String( value || '' );
	if ( ! raw ) return '';
	try {

		const url = new URL( raw, 'http://example.invalid/' );
		const last = url.pathname.split( '/' ).filter( Boolean ).pop() || '';
		return decodeURIComponent( last );

	} catch ( _ ) {

		return raw.split( /[?#]/ )[ 0 ].split( '/' ).filter( Boolean ).pop() || '';

	}

}

export function createLiveSceneIndex( opts = {} ) {

	const registerLiveTexture = typeof opts.registerLiveTexture === 'function' ? opts.registerLiveTexture : () => {};
	const getDiagnostics = typeof opts.getDiagnostics === 'function' ? opts.getDiagnostics : () => opts.diagnostics || null;
	const materialTextureProps = opts.materialTextureProps || MATERIAL_TEXTURE_PROPS;
	const materialNodeTextureCollector = opts.collectMaterialNodeTextures || collectMaterialNodeTextures;
	const isEnvironmentTextureSource = typeof opts.isEnvironmentTextureSource === 'function' ? opts.isEnvironmentTextureSource : () => false;
	const isPMREMTexture = typeof opts.isPMREMTexture === 'function' ? opts.isPMREMTexture : () => false;

	const texturesByUuid = new Map();
	const texturesByName = new Map();
	const materialTextures = [];

	function rememberLiveTexture( texture ) {

		if ( ! texture || texture.isTexture !== true ) return;
		registerLiveTexture( texture );
		if ( texture.uuid ) texturesByUuid.set( texture.uuid, texture );

		const names = [];
		if ( texture.name ) names.push( texture.name );
		const imageSrc = textureImageSrc( texture );
		if ( imageSrc ) names.push( imageSrc );
		for ( const name of names ) {

			if ( typeof name !== 'string' || name.length === 0 ) continue;
			texturesByName.set( name, texture );
			const base = basenameFromUrl( name );
			if ( base ) texturesByName.set( base, texture );

		}

		const identity = texture.name || imageSrc || '';
		if ( ! /\.(hdr|exr)$/i.test( basenameFromUrl( identity ) ) && ! isEnvironmentTextureSource( texture ) && ! isPMREMTexture( texture ) && ! materialTextures.includes( texture ) ) {

			materialTextures.push( texture );

		}

	}

	function indexTexture( texture, options = {} ) {

		if ( ! texture || texture.isTexture !== true ) return;
		if ( options.heal !== false ) healTextureImage( texture, getDiagnostics() );
		rememberLiveTexture( texture );

	}

	function indexScene( scene, options = {} ) {

		const extraTextures = Array.isArray( options.extraTextures ) ? options.extraTextures : [];
		for ( const tex of extraTextures ) indexTexture( tex, options );
		if ( ! scene ) return;
		if ( scene.background && scene.background.isTexture === true ) indexTexture( scene.background );
		if ( scene.environment && scene.environment.isTexture === true ) indexTexture( scene.environment );
		if ( typeof scene.traverse !== 'function' ) return;

		scene.traverse( ( object ) => {

			if ( object && object.isLight === true && object.map && object.map.isTexture === true ) indexTexture( object.map, { heal: false } );
			const ms = object && object.material;
			const list = Array.isArray( ms ) ? ms : ms ? [ ms ] : [];
			for ( const material of list ) {

				if ( ! material ) continue;
				for ( const key of materialTextureProps ) indexTexture( material[ key ], { heal: false } );
				for ( const tex of materialNodeTextureCollector( material ) ) indexTexture( tex, { heal: false } );

			}

		} );

	}

	return {
		texturesByUuid,
		texturesByName,
		materialTextures,
		rememberLiveTexture,
		indexTexture,
		indexScene,
		healTextureImage: ( texture ) => healTextureImage( texture, getDiagnostics() ),
		textureImageReady,
		textureImageSrc,
	};

}
