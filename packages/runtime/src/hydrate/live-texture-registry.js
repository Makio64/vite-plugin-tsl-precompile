import { DataTexture } from 'three/src/textures/DataTexture.js';
import { Data3DTexture } from 'three/src/textures/Data3DTexture.js';
import { DataArrayTexture } from 'three/src/textures/DataArrayTexture.js';
import StorageTexture from 'three/src/renderers/common/StorageTexture.js';
import Storage3DTexture from 'three/src/renderers/common/Storage3DTexture.js';
import StorageArrayTexture from 'three/src/renderers/common/StorageArrayTexture.js';

// Live-texture identity index. Hosts (harness / app) call
// `registerLiveTexture(tex)` on every freshly-loaded Texture they want the
// hydrator to be able to relink to. The hydrator looks up by `imageSrc`
// (loader URL) first, then `textureName`. Production code that keeps the
// same Texture instance hits the UUID path and never touches this index.
const _liveTexturesBySrc = new Map();
const _liveTexturesByName = new Map();

// All registered storage textures, bucketed by texture dimensionality type
// ('2d', '3d', '2d-array'). Used as a last-resort lookup when a binding's
// captured UUID is dead and there is no textureName to match on (e.g. an
// anonymous StorageTexture used via `material.colorNode = texture(sTex)`).
const _liveStorageTexturesByType = { '2d': [], '3d': [], '2d-array': [] };

// Anonymous Data{,3D,Array}Texture index keyed by shape
// `${width}x${height}[x${depth}]:${format}:${type}` -> Set<Texture>. Used as a
// fallback for `artifact.texture` bindings whose captured snapshot is trivial
// (all zeros): the example creates a CPU-side DataTexture that gets populated
// each frame (e.g. webgpu_compute_audio's analyserTexture), but the snapshot
// was serialised before any data was written. If a single live DataTexture
// matches the snapshot's shape, prefer it over the empty snapshot so the
// per-frame `needsUpdate` flow drives the replay.
const _liveAnonymousDataTexturesByShape = new Map();
const _registeredAnonDataTextures = new WeakSet();
const _storageNames = new WeakMap();

let _patchesInstalled = false;

function imageSrcForTexture( texture ) {

	const image = texture && texture.image || null;
	const imageSrc = image && ( image.src || image.currentSrc || ( Array.isArray( image ) && image[ 0 ] && ( image[ 0 ].src || image[ 0 ].currentSrc ) ) || null );
	if ( imageSrc ) return imageSrc;
	const loaderSrc = texture && texture.userData && texture.userData.__tslpLoaderUrl;
	return typeof loaderSrc === 'string' && loaderSrc.length > 0 ? loaderSrc : null;

}

function basenameFromUrl( value ) {

	if ( typeof value !== 'string' || value.length === 0 ) return '';
	const slash = value.lastIndexOf( '/' );
	const tail = slash >= 0 ? value.slice( slash + 1 ) : value;
	return tail.split( '?' )[ 0 ].split( '#' )[ 0 ];

}

function registerLiveTextureName( name, texture, src ) {

	if ( typeof name !== 'string' || name.length === 0 ) return;
	const existing = _liveTexturesByName.get( name );
	const existingSrc = imageSrcForTexture( existing );
	if ( ! existing || ( typeof src === 'string' && src.length > 0 && ! existingSrc ) ) _liveTexturesByName.set( name, texture );

}

export function registerLiveTexture( texture ) {

	if ( ! texture || texture.isTexture !== true ) return;
	const src = imageSrcForTexture( texture );
	if ( typeof src === 'string' && src.length > 0 ) _liveTexturesBySrc.set( src, texture );
	registerLiveTextureName( texture.name, texture, src );
	registerLiveTextureName( basenameFromUrl( src ), texture, src );

	// Also track storage textures by dimensionality for anonymous-storage fallback.
	if ( texture.isStorageTexture ) {

		const bucket = texture.is3DTexture ? '3d' : ( texture.isArrayTexture ? '2d-array' : '2d' );
		const list = _liveStorageTexturesByType[ bucket ];
		if ( list && ! list.includes( texture ) ) list.push( texture );

	}

}

function normalizeLoaderUrl( url ) {

	if ( typeof url === 'string' ) return url;
	if ( Array.isArray( url ) ) return url.filter( ( item ) => typeof item === 'string' && item.length > 0 ).join( '|' );
	return url !== undefined && url !== null ? String( url ) : '';

}

function markLoaderTexture( texture, url ) {

	if ( ! texture || texture.isTexture !== true ) return false;
	const loaderUrl = normalizeLoaderUrl( url );
	if ( loaderUrl ) {

		if ( ! texture.userData || typeof texture.userData !== 'object' ) texture.userData = {};
		if ( typeof texture.userData.__tslpLoaderUrl !== 'string' || texture.userData.__tslpLoaderUrl.length === 0 ) texture.userData.__tslpLoaderUrl = loaderUrl;
		if ( ! texture.name ) {

			const firstUrl = Array.isArray( url ) ? url.find( ( item ) => typeof item === 'string' && item.length > 0 ) : loaderUrl;
			const base = basenameFromUrl( firstUrl );
			if ( base ) texture.name = base;

		}

	}
	registerLiveTexture( texture );
	return true;

}

function loaderCtorsFrom( loaders ) {

	if ( ! loaders ) return [];
	if ( typeof loaders === 'function' ) return [ loaders ];
	if ( Array.isArray( loaders ) ) return loaders.filter( Boolean );
	if ( typeof loaders === 'object' ) {

		return [
			loaders.TextureLoader,
			loaders.CubeTextureLoader,
			loaders.DataTextureLoader,
			loaders.CompressedTextureLoader,
			loaders.ImageBitmapLoader,
		].filter( Boolean );

	}
	return [];

}

/**
 * Patch three.js texture loader classes so every returned/loaded Texture is
 * registered in the live texture registry by URL/name. This is product
 * runtime plumbing for JSON-loaded artifacts whose captured texture UUIDs are
 * dead in the user's browser session, especially aux/shadow artifacts that do
 * not have a user material instance to catalogue at `__applyPrecompiled()`
 * time.
 *
 * Accepts a three namespace (`{ TextureLoader, CubeTextureLoader, ... }`), a
 * single loader constructor, or an array of constructors. Idempotent per
 * constructor.
 *
 * @param {Object|Function|Array<Function>} loaders
 * @param {{ onTextureLoad?: Function }} [opts]
 * @return {number} number of constructors newly patched
 */
export function installTextureLoaderTracking( loaders, opts = {} ) {

	const ctors = loaderCtorsFrom( loaders );
	let patched = 0;
	for ( const Ctor of ctors ) {

		if ( ! Ctor || ! Ctor.prototype || typeof Ctor.prototype.load !== 'function' ) continue;
		if ( Ctor.prototype.__tslpTextureLoaderTrackingPatched === true ) continue;
		const originalLoad = Ctor.prototype.load;
		Object.defineProperty( Ctor.prototype, '__tslpTextureLoaderTrackingPatched', {
			value: true,
			enumerable: false,
			configurable: true,
		} );
		Ctor.prototype.load = function ( url, onLoad, onProgress, onError ) {

			let returnedTexture = null;
			const notify = ( texture ) => {

				if ( ! markLoaderTexture( texture, url ) ) return;
				if ( typeof opts.onTextureLoad === 'function' ) {

					try { opts.onTextureLoad( texture, { loader: Ctor, url } ); } catch ( _ ) {}

				}

			};
			const wrappedOnLoad = ( value, ...rest ) => {

				try {

					notify( value && value.isTexture === true ? value : returnedTexture );
					if ( typeof onLoad === 'function' ) return onLoad.call( this, value, ...rest );
					return undefined;

				} finally {

					notify( returnedTexture );

				}

			};
			returnedTexture = originalLoad.call( this, url, wrappedOnLoad, onProgress, onError );
			notify( returnedTexture );
			return returnedTexture;

		};
		patched ++;

	}
	return patched;

}

export function clearLiveTextureIndex() {

	_liveTexturesBySrc.clear();
	_liveTexturesByName.clear();
	_liveStorageTexturesByType[ '2d' ].length = 0;
	_liveStorageTexturesByType[ '3d' ].length = 0;
	_liveStorageTexturesByType[ '2d-array' ].length = 0;
	_liveAnonymousDataTexturesByShape.clear();
	// _registeredAnonDataTextures is a WeakSet - entries are GC'd with the
	// texture; explicit clearing isn't possible nor needed.

}

function patchRegistryConstructors( namespace ) {

	if ( ! namespace || typeof namespace !== 'object' ) return;
	_patchStorageTextureName( namespace.StorageTexture );
	_patchStorageTextureName( namespace.Storage3DTexture );
	_patchStorageTextureName( namespace.StorageArrayTexture );
	_patchDataTextureRegister( namespace.DataTexture );
	_patchDataTextureRegister( namespace.Data3DTexture );
	_patchDataTextureRegister( namespace.DataArrayTexture );

}

/**
 * Install registry hooks on the runtime-owned source constructors and, when
 * provided, on an application Three namespace as well.
 *
 * The namespace must be injected by the caller. Importing bare `three` from
 * here would make the single-file slim build retain the complete Three.Core
 * namespace through Rollup's `inlineDynamicImports`, even though slim already
 * owns the exact Data/Storage texture constructors it needs. The recommended
 * full-runtime setup and `createSlimSceneSupport({ threeModule })` both pass
 * their namespace explicitly.
 *
 * @param {?Object} namespace - Optional `three` / `three/webgpu` namespace.
 */
export function installLiveTextureRegistryPatches( namespace = null ) {

	if ( ! _patchesInstalled ) {

		_patchesInstalled = true;
		_patchStorageTextureName( StorageTexture );
		_patchStorageTextureName( Storage3DTexture );
		_patchStorageTextureName( StorageArrayTexture );
		_patchDataTextureRegister( DataTexture );
		_patchDataTextureRegister( Data3DTexture );
		_patchDataTextureRegister( DataArrayTexture );

	}
	patchRegistryConstructors( namespace );

}

// Auto-register storage textures by prototype-level `name` accessor patching.
//
// Compute-written storage textures (StorageTexture, Storage3DTexture,
// StorageArrayTexture) are created programmatically at runtime - they are
// never loaded via a TextureLoader, so they never flow through the loader
// patches that populate _liveTexturesByName. Yet the artifact captures their
// `texture.name` (e.g. "cloud" for a Storage3DTexture in the cloud volumetric
// example). Installing a `name` accessor on each storage texture class
// prototype ensures any named instance is registered when the name is set, so
// the name lookup in resolveTextureBinding finds the live compute-written
// texture instead of falling back to a 1x1x1 grey stub.
//
// How prototype accessor interception works here:
//   - `Texture` constructor does `this.name = ''`. Because we install the
//     accessor on `StorageXxxTexture.prototype` BEFORE any instance exists,
//     the property-set walks the prototype chain and finds our setter (no own
//     `name` data property has been created yet). Our setter writes to a
//     WeakMap rather than creating an own data property, so all subsequent
//     assignments also route through the prototype setter.
//   - Later, `storageTexture.name = 'cloud'` hits our setter and calls
//     registerLiveTexture so the hydrator's name lookup finds the live texture.
//
// The patch is guarded by `__tslpNamePatched` and is idempotent.
function _patchStorageTextureName( Ctor ) {

	if ( ! Ctor || ! Ctor.prototype || Ctor.prototype.__tslpNamePatched ) return;
	Ctor.prototype.__tslpNamePatched = true;

	Object.defineProperty( Ctor.prototype, 'name', {
		get() {

			const v = _storageNames.get( this );
			return v !== undefined ? v : '';

		},
		set( v ) {

			const self = this;
			_storageNames.set( self, v );
			// Defer to a microtask so that the full constructor chain completes
			// (including `this.isStorageTexture = true` in the Storage* subclass)
			// before we call registerLiveTexture. During `this.name = ''` in the
			// Texture base constructor, the subclass body hasn't run yet, so
			// `isStorageTexture` is still undefined. By deferring one microtask we
			// allow the entire `new StorageXxxTexture()` call to complete first.
			Promise.resolve().then( function () { registerLiveTexture( self ); } );

		},
		configurable: true,
		enumerable: true,
	} );

}

// Auto-register anonymous (unnamed, no imageSrc) Data{,3D,Array}Texture
// instances into a shape-keyed bucket on first `needsUpdate = true`. The hook
// runs on the rising edge of needsUpdate, mirroring how three.js's GPU upload
// path is triggered - at that point width/height/format/type are stable.
function _patchDataTextureRegister( Ctor ) {

	if ( ! Ctor || ! Ctor.prototype || Ctor.prototype.__tslpDataTextureRegPatched ) return;
	Ctor.prototype.__tslpDataTextureRegPatched = true;

	const proto = Ctor.prototype;
	let cursor = proto;
	let existing = null;
	while ( cursor && ! existing ) {

		existing = Object.getOwnPropertyDescriptor( cursor, 'needsUpdate' ) || null;
		cursor = Object.getPrototypeOf( cursor );

	}
	const _slot = new WeakMap();

	Object.defineProperty( proto, 'needsUpdate', {
		get() {

			if ( existing && existing.get ) return existing.get.call( this );
			return _slot.get( this ) || false;

		},
		set( v ) {

			if ( existing && existing.set ) existing.set.call( this, v );
			else _slot.set( this, v );
			if ( v === true ) {

				const self = this;
				// Defer one microtask so the constructor / image assignment
				// chain has fully settled (mirrors `_patchStorageTextureName`).
				Promise.resolve().then( function () { _registerAnonDataTexture( self ); } );

			}

		},
		configurable: true,
		enumerable: true,
	} );

}

function _shapeKey( width, height, depth, format, type ) {

	const w = width | 0;
	const h = height | 0;
	const d = depth | 0;
	return d > 1 ? `${ w }x${ h }x${ d }:${ format }:${ type }` : `${ w }x${ h }:${ format }:${ type }`;

}

function _registerAnonDataTexture( texture ) {

	if ( ! texture || _registeredAnonDataTextures.has( texture ) ) return;
	const image = texture.image || null;
	if ( ! image ) return;
	const w = image.width | 0;
	const h = image.height | 0;
	const d = image.depth | 0 || 0;
	if ( ! w || ! h ) return;
	// Skip textures that already have an identity handle - they'll resolve
	// through imageSrc / textureName lookup paths.
	const src = image.src || image.currentSrc || null;
	if ( typeof src === 'string' && src.length > 0 ) return;
	if ( typeof texture.name === 'string' && texture.name.length > 0 ) return;
	const format = texture.format != null ? texture.format : null;
	const type = texture.type != null ? texture.type : null;
	if ( format == null || type == null ) return;
	_registeredAnonDataTextures.add( texture );
	const key = _shapeKey( w, h, d, format, type );
	let bucket = _liveAnonymousDataTexturesByShape.get( key );
	if ( ! bucket ) {

		bucket = new Set();
		_liveAnonymousDataTexturesByShape.set( key, bucket );

	}
	bucket.add( texture );

}

export function lookupAnonymousDataTexture( snapshot ) {

	if ( ! snapshot ) return null;
	const w = snapshot.width | 0;
	const h = snapshot.height | 0;
	const d = ( snapshot.depth | 0 ) || 0;
	if ( ! w || ! h ) return null;
	const format = snapshot.format != null ? snapshot.format : null;
	const type = snapshot.type != null ? snapshot.type : null;
	if ( format == null || type == null ) return null;
	const key = _shapeKey( w, h, d, format, type );
	const bucket = _liveAnonymousDataTexturesByShape.get( key );
	if ( ! bucket || bucket.size !== 1 ) return null;
	return bucket.values().next().value;

}

export function lookupLiveTextureByIdentity( source ) {

	if ( ! source ) return null;
	if ( source.imageSrc && _liveTexturesBySrc.has( source.imageSrc ) ) return _liveTexturesBySrc.get( source.imageSrc );
	if ( source.textureName && _liveTexturesByName.has( source.textureName ) ) {

		return _liveTexturesByName.get( source.textureName );

	}
	// Final identity fallback: derive the filename from imageSrc and try the
	// name index. Covers older artifacts captured before textureName was
	// synthesised, and any flow where a host registers textures by filename
	// but the captured `texture.name` was empty.
	if ( source.imageSrc ) {

		const filename = basenameFromUrl( source.imageSrc );
		if ( filename && _liveTexturesByName.has( filename ) ) return _liveTexturesByName.get( filename );

	}
	return null;

}

/**
 * Last-resort lookup for anonymous compute-written storage textures.
 *
 * When a binding's textureUuid is dead, has no textureName, and has no
 * snapshot (typical for StorageTexture created directly as a compute target
 * without naming it), fall back to the first registered storage texture of
 * the matching dimensionality ('2d', '3d', '2d-array'). This covers the
 * simple case where only one storage texture of a given type exists in the
 * scene - e.g. `webgpu_compute_texture` which has a single unnamed 2-D
 * StorageTexture written by compute.
 *
 * Returns null if no matching storage texture has been registered.
 *
 * @param {string} textureType - '2d', '3d', or '2d-array'.
 * @return {?StorageTexture|?Storage3DTexture|?StorageArrayTexture}
 */
export function lookupAnonymousStorageTexture( textureType ) {

	const list = _liveStorageTexturesByType[ textureType ];
	if ( ! list || list.length === 0 ) return null;
	// Return the most recently registered (last in list), which corresponds
	// to the texture created latest in the example's init() flow - usually
	// the one the compute writes into.
	return list[ list.length - 1 ];

}
