/**
 * Precompiled artifact → NodeBuilderState hydration.
 *
 * The slim bundle deletes `WGSLNodeBuilder` and short-circuits
 * `Nodes.js:getForRender` to call `hydrateNodeBuilderState` instead of
 * `this.backend.createNodeBuilder()`. This function produces a plain
 * object shaped like three.js's internal `NodeBuilderState` from a
 * precompiled artifact — enough for the renderer's pipeline dispatch
 * (`Pipelines.js`), render-object wiring (`RenderObject.js`), and the
 * per-frame update loop to find the fields they read off of it.
 *
 * Non-goals of this POC hydrator:
 *   - Full runtime parity with the TSL builder. Live-binding / shadow /
 *     complex-uniform paths that depend on the full binding class tree
 *     are deferred. This version returns empty bindings, empty update
 *     arrays, and a minimal observer, which is enough for static-material rendering but NOT for
 *     materials that need per-frame updates through the node system.
 *   - The UBO write path goes through `PrecompiledMaterial`'s generated
 *     updater instead — that's already wired via `apply-precompiled.js`.
 *
 * @module Hydrator
 */

import BindGroup from 'three/src/renderers/common/BindGroup.js';
import UniformBuffer from 'three/src/renderers/common/UniformBuffer.js';
import StorageBuffer from 'three/src/renderers/common/StorageBuffer.js';
import StorageBufferAttribute from 'three/src/renderers/common/StorageBufferAttribute.js';
import Sampler from 'three/src/renderers/common/Sampler.js';
import { SampledTexture, SampledCubeTexture, Sampled3DTexture, SampledArrayTexture } from 'three/src/renderers/common/SampledTexture.js';
import StorageTexture from 'three/src/renderers/common/StorageTexture.js';
import Storage3DTexture from 'three/src/renderers/common/Storage3DTexture.js';
import StorageArrayTexture from 'three/src/renderers/common/StorageArrayTexture.js';
import { DataTexture, Data3DTexture, DataArrayTexture, DepthTexture, CubeDepthTexture, CubeTexture, FramebufferTexture, RGBAFormat, RGBFormat, RGFormat, RedFormat, DepthFormat, UnsignedByteType, UnsignedIntType, LessEqualCompare, GreaterEqualCompare, HalfFloatType, LinearFilter, NearestFilter, NearestMipmapNearestFilter, NearestMipmapLinearFilter, LinearMipmapNearestFilter, LinearMipmapLinearFilter, ClampToEdgeWrapping, WebGPUCoordinateSystem, Vector2, Vector3, Vector4, Matrix4, Matrix3, Plane, InstancedBufferAttribute } from 'three';
import { viewportMipTexture, viewportTexture } from 'three/src/nodes/display/ViewportTextureNode.js';
import { viewportDepthTexture } from 'three/src/nodes/display/ViewportDepthTextureNode.js';
import { getDFGLUT } from './dfg-lut.js';
import { collectLiveMaterialTextures, collectReflectorBaseNodes } from './apply-precompiled.js';

const fallbackTexture = new DataTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1, RGBAFormat );
fallbackTexture.needsUpdate = true;

// Cube fallback: a six-face neutral grey cube. Supplied to texture_cube
// bindings whose live cubemap could not be resolved (e.g. capture-side
// uuids no longer match anything on replay). Without this fallback a
// pipeline that declares texture_cube<f32> ends up bound to a 2D fallback
// texture, the WebGPU validator silently rejects the bind group, and the
// draw is skipped — producing an empty canvas with no error surfaced.
function makeCubeFallback() {

	const faces = [];
	for ( let i = 0; i < 6; i ++ ) {

		const data = new Uint8Array( [ 128, 128, 128, 255 ] );
		const tex = new DataTexture( data, 1, 1, RGBAFormat );
		tex.needsUpdate = true;
		faces.push( tex.image );

	}
	const cube = new CubeTexture( faces );
	cube.format = RGBAFormat;
	cube.type = UnsignedByteType;
	cube.needsUpdate = true;
	return cube;

}
const fallbackCubeTexture = makeCubeFallback();
const fallback3DTexture = new Data3DTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1, 1 );
fallback3DTexture.format = RGBAFormat;
fallback3DTexture.type = UnsignedByteType;
fallback3DTexture.needsUpdate = true;
const fallbackArrayTexture = new DataArrayTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1, 1 );
fallbackArrayTexture.format = RGBAFormat;
fallbackArrayTexture.type = UnsignedByteType;
fallbackArrayTexture.needsUpdate = true;
const fallbackDepthTexture = new DepthTexture( 1, 1 );
fallbackDepthTexture.format = DepthFormat;
fallbackDepthTexture.type = UnsignedIntType;
fallbackDepthTexture.renderTarget = { samples: 1 };
const fallbackDepthArrayTexture = new DepthTexture( 1, 1, UnsignedIntType, undefined, undefined, undefined, undefined, undefined, undefined, DepthFormat, 1 );
fallbackDepthArrayTexture.format = DepthFormat;
fallbackDepthArrayTexture.type = UnsignedIntType;
fallbackDepthArrayTexture.isArrayTexture = true;
fallbackDepthArrayTexture.image.depth = 1;
fallbackDepthArrayTexture.renderTarget = { samples: 1 };
const fallbackComparisonDepthTexture = new DepthTexture( 1, 1 );
fallbackComparisonDepthTexture.format = DepthFormat;
fallbackComparisonDepthTexture.type = UnsignedIntType;
fallbackComparisonDepthTexture.compareFunction = LessEqualCompare;
fallbackComparisonDepthTexture.renderTarget = { samples: 1 };
const fallbackMultisampledDepthTexture = new DepthTexture( 1, 1 );
fallbackMultisampledDepthTexture.format = DepthFormat;
fallbackMultisampledDepthTexture.type = UnsignedIntType;
fallbackMultisampledDepthTexture.renderTarget = { samples: 4 };
const fallbackDepthCubeTexture = new CubeDepthTexture( 1 );
fallbackDepthCubeTexture.format = DepthFormat;
fallbackDepthCubeTexture.type = UnsignedIntType;
fallbackDepthCubeTexture.compareFunction = LessEqualCompare;
fallbackDepthCubeTexture.renderTarget = { samples: 1 };

// Per-binding 1×1 fallback for `viewport.texture` bindings. The live
// viewport texture is swapped in by `createViewportTextureRebinder` on the
// first render-before; this fallback only exists so WebGPU bind-group
// validation passes before that runs. Allocate fresh instances (rather than
// a module singleton) so that aux-bg / postprocess paths whose own viewport
// fallbacks are seeded by `wireViewportTextureRefs` aren't accidentally
// pointed at the same texture.
function makeViewportFallback( artifact, bindingName, source = null ) {

	const isDepth = source && source.isDepth === true ||
		( artifact && bindingName && shaderDeclaresDepthTexture( artifact, bindingName ) );
	if ( isDepth ) {

		const tex = new DepthTexture( 1, 1 );
		tex.format = DepthFormat;
		tex.type = UnsignedIntType;
		tex.renderTarget = { samples: 1 };
		tex.needsUpdate = true;
		return tex;

	}

	const tex = new FramebufferTexture( 1, 1 );
	tex.minFilter = LinearMipmapLinearFilter;
	tex.needsUpdate = true;
	return tex;

}

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
// `${width}x${height}[x${depth}]:${format}:${type}` → Set<Texture>. Used as a
// fallback for `artifact.texture` bindings whose captured snapshot is trivial
// (all zeros): the example creates a CPU-side DataTexture that gets populated
// each frame (e.g. webgpu_compute_audio's analyserTexture), but the snapshot
// was serialised before any data was written. If a single live DataTexture
// matches the snapshot's shape, prefer it over the empty snapshot so the
// per-frame `needsUpdate` flow drives the replay.
const _liveAnonymousDataTexturesByShape = new Map();
const _registeredAnonDataTextures = new WeakSet();

function imageSrcForTexture( texture ) {

	const image = texture && texture.image || null;
	return image && ( image.src || image.currentSrc || ( Array.isArray( image ) && image[ 0 ] && ( image[ 0 ].src || image[ 0 ].currentSrc ) ) || null );

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

export function clearLiveTextureIndex() {

	_liveTexturesBySrc.clear();
	_liveTexturesByName.clear();
	_liveStorageTexturesByType[ '2d' ].length = 0;
	_liveStorageTexturesByType[ '3d' ].length = 0;
	_liveStorageTexturesByType[ '2d-array' ].length = 0;
	_liveAnonymousDataTexturesByShape.clear();
	// _registeredAnonDataTextures is a WeakSet — entries are GC'd with the
	// texture; explicit clearing isn't possible nor needed.

}

// Auto-register storage textures by prototype-level `name` accessor patching.
//
// Compute-written storage textures (StorageTexture, Storage3DTexture,
// StorageArrayTexture) are created programmatically at runtime — they are
// never loaded via a TextureLoader, so they never flow through the loader
// patches that populate _liveTexturesByName. Yet the artifact captures their
// `texture.name` (e.g. "cloud" for a Storage3DTexture in the cloud volumetric
// example). Installing a `name` accessor on each storage texture class
// prototype ensures any named instance is registered when the name is set, so
// the name lookup in resolveTextureBinding finds the live compute-written
// texture instead of falling back to a 1×1×1 grey stub.
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
const _storageNames = new WeakMap();

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

_patchStorageTextureName( StorageTexture );
_patchStorageTextureName( Storage3DTexture );
_patchStorageTextureName( StorageArrayTexture );

// Auto-register anonymous (unnamed, no imageSrc) Data{,3D,Array}Texture
// instances into a shape-keyed bucket on first `needsUpdate = true`. The hook
// runs on the rising edge of needsUpdate, mirroring how three.js's GPU upload
// path is triggered — at that point width/height/format/type are stable.
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
	// Skip textures that already have an identity handle — they'll resolve
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

_patchDataTextureRegister( DataTexture );
_patchDataTextureRegister( Data3DTexture );
_patchDataTextureRegister( DataArrayTexture );

function lookupAnonymousDataTexture( snapshot ) {

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

function isTrivialSnapshot( snapshot ) {

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

/**
 * Create a blank storage texture of the right class for a storage-texture
 * binding that has no live instance registered yet. Three.js allocates the
 * GPU texture when the compute shader runs; the render material binds this
 * placeholder until then. Setting `.name` triggers the patched setter which
 * calls registerLiveTexture so subsequent name-lookups find this instance.
 *
 * @param {string|null} textureName - Captured name from the artifact source.
 * @param {string} textureType - '3d', '2d-array', or '2d'.
 * @param {number} [w=1] - Width hint (1 if unavailable from artifact).
 * @param {number} [h=1] - Height hint.
 * @param {number} [d=1] - Depth hint (3D/array only).
 * @return {StorageTexture|Storage3DTexture|StorageArrayTexture}
 */
function _makeBlankStorageTexture( textureName, textureType, w = 1, h = 1, d = 1 ) {

	let tex;
	if ( textureType === '3d' ) {

		tex = new Storage3DTexture( w, h, d );

	} else if ( textureType === '2d-array' ) {

		tex = new StorageArrayTexture( w, h, d );

	} else {

		tex = new StorageTexture( w, h );

	}

	if ( textureName ) tex.name = textureName;
	return tex;

}

function lookupLiveTextureByIdentity( source ) {

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
		const slash = source.imageSrc.lastIndexOf( '/' );
		const tail = slash >= 0 ? source.imageSrc.slice( slash + 1 ) : source.imageSrc;
		const filename = tail.split( '?' )[ 0 ].split( '#' )[ 0 ];
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
 * scene — e.g. `webgpu_compute_texture` which has a single unnamed 2-D
 * StorageTexture written by compute.
 *
 * Returns null if no matching storage texture has been registered.
 *
 * @param {string} textureType - '2d', '3d', or '2d-array'.
 * @return {?StorageTexture|?Storage3DTexture|?StorageArrayTexture}
 */
function lookupAnonymousStorageTexture( textureType ) {

	const list = _liveStorageTexturesByType[ textureType ];
	if ( ! list || list.length === 0 ) return null;
	// Return the most recently registered (last in list), which corresponds
	// to the texture created latest in the example's init() flow — usually
	// the one the compute writes into.
	return list[ list.length - 1 ];

}

const MATERIAL_NODE_TEXTURE_KEYS = [
	'colorNode',
	'fragmentNode',
	'normalNode',
	'positionNode',
	'outputNode',
	'roughnessNode',
	'metalnessNode',
	'emissiveNode',
	'opacityNode',
	'alphaTestNode',
	'vertexNode',
	'envNode',
	'lightNode',
	'aoNode',
	'transmissionNode',
	'thicknessNode',
	'maskNode',
	'maskShadowNode',
	'receivedShadowPositionNode',
	'castShadowPositionNode',
	'castShadowNode',
];

function collectMaterialNodeTextures( material ) {

	const out = [];
	const seenNodes = new Set();
	const seenTextures = new Set();

	function visitTexture( texture ) {

		if ( ! texture || texture.isTexture !== true || seenTextures.has( texture ) ) return;
		seenTextures.add( texture );
		out.push( texture );

	}

	function walk( node, depth = 0 ) {

		if ( ! node || node.isNode !== true || depth > 32 || seenNodes.has( node ) ) return;
		seenNodes.add( node );
		visitTexture( node.value );
		visitTexture( node._value );

		if ( typeof node.traverse === 'function' ) {

			try {

				node.traverse( ( child ) => {

					if ( child && child !== node ) walk( child, depth + 1 );

				} );

			} catch ( _ ) {}

		}

		let keys = [];
		try {

			keys = Object.getOwnPropertyNames( node );

		} catch ( _ ) {

			return;

		}

		for ( const key of keys ) {

			if ( key === 'parent' || key === 'children' || key === 'builder' || key === 'material' || key === 'object' ) continue;
			let value = null;
			try {

				value = node[ key ];

			} catch ( _ ) {

				continue;

			}
			if ( ! value ) continue;
			visitTexture( value );
			if ( value.isNode === true ) walk( value, depth + 1 );
			else if ( Array.isArray( value ) ) {

				for ( const item of value ) {

					if ( item && item.isTexture === true ) visitTexture( item );
					else if ( item && item.isNode === true ) walk( item, depth + 1 );

				}

			} else if ( Object.getPrototypeOf( value ) === Object.prototype ) {

				for ( const item of Object.values( value ) ) {

					if ( item && item.isTexture === true ) visitTexture( item );
					else if ( item && item.isNode === true ) walk( item, depth + 1 );

				}

			}

		}

	}

	if ( material ) {

		for ( const key of MATERIAL_NODE_TEXTURE_KEYS ) walk( material[ key ] );

	}

	return out;

}

function lookupMaterialNodeTexture( material, source, artifact, bindingName, avoidTexture = null ) {

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

function collectMaterialContextDepthTextures( material ) {

	const out = [];
	const seen = new Set();
	const add = ( texture ) => {

		if ( ! texture || texture.isDepthTexture !== true || seen.has( texture ) ) return;
		seen.add( texture );
		out.push( texture );

	};
	const addFromCarrier = ( carrier ) => {

		if ( ! carrier ) return;
		add( carrier.depthTexture );
		const shadowMap = carrier.shadowMap || carrier.map || null;
		if ( shadowMap ) add( shadowMap.depthTexture );
		const renderTarget = carrier.renderTarget || carrier.target || null;
		if ( renderTarget ) add( renderTarget.depthTexture );
		const tileShadowNode = carrier.tileShadowNode || carrier.userData && carrier.userData.tileShadowNode || null;
		if ( tileShadowNode && tileShadowNode.shadowMap ) add( tileShadowNode.shadowMap.depthTexture );

	};

	let object = null;
	try {

		object = material && material.__tslpPrecompileObject || null;

	} catch ( _ ) {}

	let cursor = object;
	let depth = 0;
	while ( cursor && depth ++ < 32 ) {

		addFromCarrier( cursor );
		cursor = cursor.parent || null;

	}

	return out;

}

// Module-level scratch objects — reused per frame to avoid GC pressure.
const _rSize = new Vector2( 1, 1 );
const _rViewport = new Vector4( 0, 0, 1, 1 );
const _ovp = new Vector3();
const _odir = new Vector3();
const _mwi = new Matrix4();
const _m4rot = new Matrix4();
const _lvec = new Vector3();
const _clipPlane = new Plane();
const _clipNormalMatrix = new Matrix3();

// Find the Nth light in a scene by traversal order. Mirrors the cache
// strategy emit-updater.js bakes into AOT modules — both the AOT and
// snapshot-based hydration paths use this as a fallback when a captured
// light UUID is unavailable.
//
// The cache key is the Scene instance; lights added/removed mid-session
// won't invalidate the cache. That's acceptable for now: scene-graph
// lighting changes are rare and the alternative (per-frame retraversal)
// would tax every UBO update for materials with many light-driven slots.
function findLightInScene( scene, index ) {

	if ( ! scene ) return null;
	let cache = scene._tslpLightCache;
	if ( ! cache || cache.scene !== scene ) {

		cache = { scene, lights: [] };
		scene._tslpLightCache = cache;
		if ( typeof scene.traverse === 'function' ) {

			scene.traverse( ( o ) => {

				if ( o && o.isLight === true ) cache.lights.push( o );

			} );

		}

	}
	return cache.lights[ index ] || null;

}

function findLightBySource( scene, source ) {

	if ( ! scene || ! source ) return null;
	if ( source.lightUuid && typeof scene.traverse === 'function' ) {

		let found = null;
		scene.traverse( ( o ) => {

			if ( found ) return;
			if ( o && o.isLight === true && o.uuid === source.lightUuid ) found = o;

		} );
		if ( found ) return found;

	}
	const lightIndex = Number.isInteger( source.lightIndex ) ? source.lightIndex : 0;
	return findLightInScene( scene, lightIndex );

}

function recordLightLinkDiagnostic( event ) {

	try {

		const root = typeof globalThis !== 'undefined' ? globalThis : null;
		if ( ! root || root.__TSLP_DEBUG_LIGHT_LINKAGE !== true ) return;
		const diag = root.__tslpHarnessDiagnostics || ( root.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
		const list = diag.lightLinkage || ( diag.lightLinkage = [] );
		if ( list.length < 120 ) list.push( event );

	} catch ( _ ) {}

}

function recordShadowBindingDiagnostic( event ) {

	try {

		const root = typeof globalThis !== 'undefined' ? globalThis : null;
		if ( ! root || root.__TSLP_DEBUG_SHADOW_BINDINGS !== true ) return;
		const diag = root.__tslpHarnessDiagnostics || ( root.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
		const list = diag.shadowBindings || ( diag.shadowBindings = [] );
		if ( list.length < 500 ) list.push( event );

	} catch ( _ ) {}

}

function lightDiagnosticShape( light ) {

	if ( ! light ) return null;
	let position = null;
	try {

		if ( light.matrixWorld ) {

			_lvec.setFromMatrixPosition( light.matrixWorld );
			position = [ _lvec.x, _lvec.y, _lvec.z ];

		}

	} catch ( _ ) {}
	return {
		type: light.isSpotLight ? 'spot' : light.isDirectionalLight ? 'directional' : light.isAmbientLight ? 'ambient' : light.type || 'light',
		uuid: light.uuid || null,
		intensity: Number.isFinite( light.intensity ) ? light.intensity : null,
		position,
	};

}

/**
 * Produce a NodeBuilderState-compatible object for a precompiled material.
 *
 * @param {Object} artifact - The `precompiledArtifact` carried on the material.
 * @return {Object} A plain object with the fields `Pipelines.js` + `RenderObject.js` read.
 */
export function hydrateNodeBuilderState( artifact, material = null ) {

	if ( ! artifact ) {

		throw new Error( '[tsl-precompile/hydrator] artifact is required (material.isPrecompiledMaterial but material.precompiledArtifact is null)' );

	}

	// Bind live BufferAttributes from the user's `*Node` material props
	// (e.g. `material.positionNode = instancedBufferAttribute(buf)`) onto
	// the artifact's node-attribute entries before hydration walks them.
	// Idempotent and a no-op when capture didn't record `userPath` or the
	// material has no matching node tree yet.
	bindUserNodeAttributesToArtifact( artifact, material );
	// Same trick for compute-storage buffers wired through the user's
	// `material.colorNode = colors.element( instanceIndex )` etc. — the
	// kernel writes into `colors`, the render reads from the same buffer.
	bindUserStorageBuffersToArtifact( artifact, material );

	const { bindings, uniformBuffers, shadowDepthBindings, materialDepthBindings, artifactTextureBindings, materialTextureBindings, viewportTextureBindings, reflectorTextureBindings, clippingUniformBuffers } = hydrateRuntimeBindings( artifact, material );
	const updateNode = createUniformUpdateNode( artifact, uniformBuffers, material );
	const clippingUniformUpdateNode = clippingUniformBuffers.length > 0
		? createClippingUniformUpdateNode( clippingUniformBuffers, material )
		: null;
	const shadowDepthRebinder = shadowDepthBindings.length > 0
		? createShadowDepthRebinder( shadowDepthBindings )
		: null;
	const materialDepthRebinder = materialDepthBindings.length > 0
		? createShadowDepthRebinder( materialDepthBindings )
		: null;
	const artifactTextureRebinder = artifactTextureBindings.length > 0
		? createArtifactTextureRebinder( artifactTextureBindings )
		: null;
	const materialTextureRebinder = materialTextureBindings.length > 0
		? createMaterialTextureRebinder( materialTextureBindings )
		: null;
	const viewportTextureRebinder = viewportTextureBindings.length > 0
		? createViewportTextureRebinder( viewportTextureBindings )
		: null;
	const reflectorTextureRebinder = reflectorTextureBindings.length > 0
		? createReflectorTextureRebinder( reflectorTextureBindings )
		: null;

	// In-process flows (dev-server capture → immediate render) carry live
	// update node instances as non-enumerable sidecars on the artifact. Include
	// them BEFORE the snapshot-based updater so LightNode.update() / ShadowNode
	// / onRenderUpdate closures write fresh values into _liveNode.value before
	// the snapshot writer reads them. In JSON-loaded flows these are absent and
	// the snapshot-only path is used instead.
	const liveUpdateNodes = Array.isArray( artifact._liveUpdateNodes ) ? artifact._liveUpdateNodes : [];
	const liveUpdateBeforeNodes = Array.isArray( artifact._liveUpdateBeforeNodes ) ? artifact._liveUpdateBeforeNodes : [];
	const liveUpdateAfterNodes = Array.isArray( artifact._liveUpdateAfterNodes ) ? artifact._liveUpdateAfterNodes : [];
	const materialReflectorUpdateBeforeNodes = collectMaterialReflectorBaseNodes( material )
		.filter( ( node ) => ! liveUpdateBeforeNodes.includes( node ) );

	const base = {
		vertexShader: String( artifact.vertexShader || '' ),
		fragmentShader: String( artifact.fragmentShader || '' ),
		computeShader: String( artifact.computeShader || '' ),
		transforms: artifact.transforms || [],
		nodeAttributes: hydrateNodeAttributes( artifact.nodeAttributes || artifact.attributes || [] ),
		bindings,
		updateNodes: [ ...liveUpdateNodes, ...( updateNode ? [ updateNode ] : [] ), ...( clippingUniformUpdateNode ? [ clippingUniformUpdateNode ] : [] ) ],
		// `shadowDepthRebinder` runs FIRST among updateBefore so the SampledTexture
		// bindings point at the live `light.shadow.map.depthTexture` before the
		// renderer reads bind-group versions for the upcoming draw.
		// `artifactTextureRebinder` follows: artifact.texture bindings may resolve
		// after first hydration (PMREM/environment maps, compute-written storage
		// textures, late loader identity matches). Bumping `groupNode.version` here
		// forces the renderer to rebuild the bind group with the fresh texture.
		updateBeforeNodes: [
			...( shadowDepthRebinder ? [ shadowDepthRebinder ] : [] ),
			...( artifactTextureRebinder ? [ artifactTextureRebinder ] : [] ),
			...( materialTextureRebinder ? [ materialTextureRebinder ] : [] ),
			// `viewportTextureRebinder` runs alongside the other rebinders so
			// transmissive materials (KHR_materials_transmission glass) sample
			// a freshly-copied framebuffer instead of the 1×1 fallback.
			...( viewportTextureRebinder ? [ viewportTextureRebinder ] : [] ),
			...liveUpdateBeforeNodes,
			...materialReflectorUpdateBeforeNodes,
			// Material-graph depth textures include reflector depth nodes. Those
			// are assigned by ReflectorBaseNode.updateBefore, so they must rebind
			// after live/material reflector update-before nodes have run.
			...( materialDepthRebinder ? [ materialDepthRebinder ] : [] ),
			// `reflectorTextureRebinder` runs LAST: the live ReflectorBaseNode
			// sidecar (or the replay-side material reflector list) keys its
			// per-camera RenderTarget during its own `updateBefore`; only
			// afterwards can we swap the binding to the live
			// `renderTarget.texture`.
			...( reflectorTextureRebinder ? [ reflectorTextureRebinder ] : [] ),
		],
		updateAfterNodes: [ ...liveUpdateAfterNodes ],
		observer: createStaticObserver(),
		usedTimes: 0,
		// Three.js's renderer/pipeline calls these methods across versions.
		// Each returns a structurally-correct default; in slim mode the
		// rendering paths that need richer semantics aren't exercised.
		// `createBindings()` is called per-renderObject by RenderObject.js;
		// for materials shared across many objects (e.g. 200 sprites all
		// using the same SpriteNodeMaterial) we MUST return per-call
		// instances of any non-shared UBO so each object writes its own
		// per-frame uniforms. Shared UBOs (render group: camera matrices)
		// keep the same instance.
		createBindings() {

			return cloneBindingsForObject( this.bindings, artifact, material );

		},
		getAttributesArray() {

			return this.nodeAttributes;

		},
		getBindings() {

			return this.bindings;

		},
		build() { /* no-op: artifact is already baked */ },
		buildAsync: async () => { /* no-op */ },
	};

	// Wrap in a Proxy that returns a no-op function for any OTHER method
	// lookup the renderer might do. Keeps forward-compatibility with
	// three.js version bumps without shape-gating every method name.
	return new Proxy( base, {
		get( target, prop ) {

			if ( prop in target ) return target[ prop ];
			// Unknown property: return a no-op function. Common for
			// renderer helpers that probe for optional methods.
			return () => undefined;

		},
	} );

}

/**
 * Walk `artifact.attributes` (or legacy `nodeAttributes`) and seed
 * `entry._liveAttribute` from the user material's TSL node graph.
 *
 * At capture time `compileTSL` records `userPath` (e.g. `["positionNode"]`)
 * for each node-sourced attribute — naming the property on the source
 * material whose node tree contains the attribute leaf. The
 * BufferAttribute reference itself is non-serialisable, so out-of-process
 * replay loses it. The user's JS still does `material.positionNode =
 * instancedBufferAttribute(buf)` on the wrapped material in the new
 * process; here we rewalk that node tree and bind the leaf attribute the
 * user just constructed. Without this the fallback below allocates a
 * zero-filled StorageBufferAttribute and every instance reads (0,0,0).
 *
 * Idempotent — skips entries that already carry a live attribute. Tolerates
 * missing/mistyped paths and node-shaped slim stubs (which lack `traverse`).
 *
 * @param {Object} artifact - Artifact to mutate.
 * @param {?Object} sourceMaterial - The wrapped PrecompiledMaterial whose
 *   `*Node` properties the user assigns after construction.
 */
function bindUserNodeAttributesToArtifact( artifact, sourceMaterial ) {

	if ( ! sourceMaterial ) return;
	const entries = Array.isArray( artifact.attributes )
		? artifact.attributes
		: Array.isArray( artifact.nodeAttributes ) ? artifact.nodeAttributes : null;
	if ( ! entries || entries.length === 0 ) return;

	let nodeRoots = null;
	const collectNodeRoots = () => {

		if ( nodeRoots ) return nodeRoots;
		nodeRoots = [];
		for ( const key in sourceMaterial ) {

			const v = sourceMaterial[ key ];
			if ( v && v.isNode === true ) nodeRoots.push( v );

		}
		return nodeRoots;

	};

	const sourceObject = sourceMaterial.__tslpPrecompileObject || null;

	for ( const entry of entries ) {

		if ( ! entry || entry.source !== 'node' ) continue;
		if ( entry._liveAttribute && entry._liveAttribute.isBufferAttribute === true ) continue;

		let live = null;
		const path = entry.userPath;
		if ( Array.isArray( path ) && path.length > 0 ) {

			const root = sourceMaterial[ path[ 0 ] ];
			if ( root && root.isNode === true ) live = findFirstAttributeMatchingEntry( root, entry );

		}

		if ( ! live ) {

			for ( const root of collectNodeRoots() ) {

				live = findFirstAttributeMatchingEntry( root, entry );
				if ( live ) break;

			}

		}

		if ( ! live ) live = findInstancedObjectAttributeMatchingEntry( sourceObject, entry, entries );
		if ( ! live ) continue;

		Object.defineProperty( entry, '_liveAttribute', {
			value: live,
			enumerable: false,
			configurable: true,
			writable: true,
		} );

	}

}

function findInstancedObjectAttributeMatchingEntry( object, entry, entries ) {

	if ( ! object || object.isInstancedMesh !== true ) return null;
	const count = object.count || 0;
	if ( ! count || entry.count !== count ) return null;
	const itemSize = entry.itemSize || itemSizeFromAttributeType( entry.type );

	if ( object.instanceColor && object.instanceColor.isBufferAttribute === true ) {

		const color = object.instanceColor;
		if ( itemSize === color.itemSize ) return color;

	}

	if ( itemSize !== 4 || ! object.instanceMatrix || ! object.instanceMatrix.array ) return null;

	const matrixEntries = entries.filter( ( candidate ) => {

		if ( ! candidate || candidate.source !== 'node' ) return false;
		if ( candidate.count !== count ) return false;
		const size = candidate.itemSize || itemSizeFromAttributeType( candidate.type );
		return size === 4;

	} );
	const column = matrixEntries.indexOf( entry );
	if ( column < 0 || column > 3 ) return null;

	return getInstancedMatrixColumnAttribute( object, column );

}

function getInstancedMatrixColumnAttribute( object, column ) {

	const source = object && object.instanceMatrix;
	const sourceArray = source && source.array;
	const count = object && object.count || 0;
	if ( ! sourceArray || ! count ) return null;

	const cacheKey = '__tslpMatrixColumnAttributes';
	let cache = object[ cacheKey ];
	if ( ! cache || cache.sourceArray !== sourceArray || cache.count !== count ) {

		cache = {
			sourceArray,
			count,
			attributes: [
				new InstancedBufferAttribute( new Float32Array( count * 4 ), 4 ),
				new InstancedBufferAttribute( new Float32Array( count * 4 ), 4 ),
				new InstancedBufferAttribute( new Float32Array( count * 4 ), 4 ),
				new InstancedBufferAttribute( new Float32Array( count * 4 ), 4 ),
			],
		};
		for ( const attribute of cache.attributes ) attribute.needsUpdate = true;
		try { Object.defineProperty( object, cacheKey, { value: cache, configurable: true } ); } catch ( _ ) { object[ cacheKey ] = cache; }

	}

	const attribute = cache.attributes[ column ];
	const dst = attribute && attribute.array;
	if ( ! dst ) return null;
	for ( let i = 0; i < count; i ++ ) {

		const srcOffset = i * 16 + column * 4;
		const dstOffset = i * 4;
		dst[ dstOffset + 0 ] = sourceArray[ srcOffset + 0 ];
		dst[ dstOffset + 1 ] = sourceArray[ srcOffset + 1 ];
		dst[ dstOffset + 2 ] = sourceArray[ srcOffset + 2 ];
		dst[ dstOffset + 3 ] = sourceArray[ srcOffset + 3 ];

	}
	attribute.needsUpdate = true;
	return attribute;

}

function findFirstAttributeMatchingEntry( node, entry ) {

	const wantSize = entry.itemSize || 0;
	const wantCount = entry.count || 0;
	const wantArray = entry.arrayType || '';

	let found = null;
	const probe = ( n ) => {

		if ( found || ! n ) return;
		const cands = [ n.attribute, n.value ];
		for ( const cand of cands ) {

			if ( ! cand || cand.isBufferAttribute !== true ) continue;
			// vec3 storage attributes get padded to itemSize=4 when WebGPU
			// touches them. Accept (3 → 4) so a freshly-built live attribute
			// matches an artifact entry recorded after the pad fired.
			if ( wantSize && cand.itemSize !== wantSize
				&& ! ( cand.itemSize === 3 && wantSize === 4 ) ) continue;
			if ( wantCount && cand.count !== wantCount ) continue;
			if ( wantArray
				&& cand.array
				&& cand.array.constructor
				&& cand.array.constructor.name !== wantArray ) continue;
			found = cand;
			return;

		}

	};

	probe( node );
	if ( ! found && typeof node.traverse === 'function' ) node.traverse( probe );
	return found;

}

/**
 * Walk every `storageBuffers[]` entry in `artifact.uniformPlan` and seed
 * `entry._liveAttribute` from the user material's TSL node graph.
 *
 * Compute kernels write into `instancedArray(...)` storage buffers; the
 * render side reads them via `material.colorNode = colors.element( i )`
 * (etc.) — same node-tree walk pattern as `bindUserNodeAttributesToArtifact`,
 * but matching against `StorageBufferNode.value` instead of
 * `BufferAttributeNode.attribute/value`. Without this the hydrator's
 * storage-buffer wiring at `createBindingFromDescriptor` allocates a fresh
 * empty `StorageBufferAttribute` and the compute output is invisible to
 * the render path.
 *
 * @param {Object} artifact
 * @param {?Object} sourceMaterial
 */
function bindUserStorageBuffersToArtifact( artifact, sourceMaterial ) {

	if ( ! sourceMaterial ) return;
	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : null;
	if ( ! plan || plan.length === 0 ) return;

	// Compute kernel storage buffers can be referenced from inside an Fn() body
	// assigned to any *Node slot. Capture writes `entry.userPath` based on the
	// node tree it walks, but Fn bodies that assign sibling material slots as a
	// side effect (e.g. cloth's `positionNode = Fn(() => { material.normalNode = ...; vertexPositionBuffer.element(...) })()`)
	// leave `userPath` pointing at the wrong slot, and some materials lose
	// `userPath` to `undefined` entirely. When the path-rooted lookup misses,
	// fall back to scanning every *Node property on the material.
	let nodeRoots = null;
	const collectNodeRoots = () => {

		if ( nodeRoots ) return nodeRoots;
		nodeRoots = [];
		for ( const key in sourceMaterial ) {

			const v = sourceMaterial[ key ];
			if ( v && v.isNode === true ) nodeRoots.push( v );

		}
		return nodeRoots;

	};

	for ( const group of plan ) {

		const entries = group && Array.isArray( group.storageBuffers ) ? group.storageBuffers : null;
		if ( ! entries || entries.length === 0 ) continue;
		for ( const entry of entries ) {

			if ( ! entry ) continue;
			if ( entry._liveAttribute
				&& entry._liveAttribute.array
				&& ArrayBuffer.isView( entry._liveAttribute.array ) ) continue;

			let live = null;
			const path = entry.userPath;
			if ( Array.isArray( path ) && path.length > 0 ) {

				const root = sourceMaterial[ path[ 0 ] ];
				if ( root && root.isNode === true ) {

					live = findFirstAttributeMatchingEntry( root, entry );

				}

			}

			if ( ! live ) {

				for ( const root of collectNodeRoots() ) {

					live = findFirstAttributeMatchingEntry( root, entry );
					if ( live ) break;

				}

			}

			if ( ! live ) continue;

			Object.defineProperty( entry, '_liveAttribute', {
				value: live,
				enumerable: false,
				configurable: true,
				writable: true,
			} );

		}

	}

}

function hydrateNodeAttributes( attributes ) {

	if ( ! Array.isArray( attributes ) ) return [];

	return attributes.map( ( attribute, i ) => {

		if ( ! attribute || attribute.source !== 'node' ) {
			return attribute;
		}

		const liveAttribute = attribute._liveAttribute || ( attribute.node && attribute.node.attribute );
		if ( liveAttribute ) return { ...attribute, node: { attribute: liveAttribute } };

		const itemSize = attribute.itemSize || itemSizeFromAttributeType( attribute.type );
		const count = Math.max( 1, attribute.count || 1 );
		const TypeArray = resolveTypedArrayCtor( attribute.arrayType );

		return {
			...attribute,
			node: {
				attribute: new StorageBufferAttribute( count, itemSize, TypeArray ),
			},
		};

	} );

}

function itemSizeFromAttributeType( type ) {

	switch ( type ) {

		case 'float':
		case 'number':
		case 'int':
		case 'uint':
			return 1;
		case 'vec2':
		case 'ivec2':
		case 'uvec2':
			return 2;
		case 'vec4':
		case 'ivec4':
		case 'uvec4':
			return 4;
		case 'vec3':
		case 'ivec3':
		case 'uvec3':
		default:
			return 3;

	}

}

/**
 * Per-renderObject bindings. Materials shared across many meshes (e.g.
 * 200 sprites all using the same SpriteNodeMaterial) need their own
 * per-object UBO instance so each frame each object writes its own
 * model/position/rotation values into a distinct GPU buffer; without
 * this, every object overwrites the previous one and only the LAST
 * draw's uniforms reach the GPU.
 *
 * Shared groups (the 'render' group with camera/time uniforms) keep the
 * same instance so the renderer uploads them once per frame.
 *
 * @param {Array<BindGroup>} bindings - The base bindings created at hydration time.
 * @param {Object} artifact
 * @param {?Material} material
 * @return {Array<BindGroup>}
 */
function cloneBindingsForObject( bindings, artifact, material ) {

	if ( ! Array.isArray( bindings ) || bindings.length === 0 ) return bindings;
	const out = [];
	for ( const bg of bindings ) {

		if ( ! bg ) { out.push( bg ); continue; }
		if ( isBindGroupShared( bg ) ) { out.push( bg ); continue; }
		const clonedBindings = ( bg.bindings || [] ).map( ( b ) => cloneBinding( b ) );
		const newGroup = new BindGroup( bg.name || '', clonedBindings );
		out.push( newGroup );

	}
	return out;

}

function isBindGroupShared( bg ) {

	const list = bg.bindings || [];
	for ( const b of list ) {

		if ( b && b.groupNode && b.groupNode.shared === true ) return true;

	}
	return false;

}

function cloneBinding( binding ) {

	if ( ! binding ) return binding;
	// UniformBuffer: clone the underlying Float32Array so each
	// per-object UBO has its own backing storage. Three.js's
	// `_bindings.updateForRender` copies bytes from this JS buffer
	// into the GPU buffer per-object; without the clone, every object
	// shares one Float32Array and the LAST writer wins.
	if ( binding.isUniformBuffer ) {

		const view = binding.buffer;
		const newBuffer = view ? new view.constructor( view ) : new Float32Array( 0 );
		const cloned = new UniformBuffer( binding.name, newBuffer );
		cloned.visibility = binding.visibility | 0;
		cloned.groupNode = { shared: false, version: 0 };
		if ( binding.__tslpLiveArrayResolver ) attachLiveUniformBufferUpdater( cloned, binding.__tslpLiveArrayResolver );
		return cloned;

	}
	// SampledTexture / Sampler / StorageBuffer share their resources
	// across objects (textures are global; storage buffers are
	// compute-shared). Reuse instances to keep the renderer's
	// resource cache hot.
	return binding;

}

function hydrateRuntimeBindings( artifact, material ) {

	const uniformBuffers = new Map();
	const shadowDepthBindings = [];
	const materialDepthBindings = [];
	const artifactTextureBindings = [];
	const materialTextureBindings = [];
	const viewportTextureBindings = [];
	const reflectorTextureBindings = [];
	const clippingUniformBuffers = [];
	const bindings = artifact.bindings;
	if ( ! Array.isArray( bindings ) ) return { bindings: [], uniformBuffers, shadowDepthBindings, materialDepthBindings, artifactTextureBindings, materialTextureBindings, viewportTextureBindings, reflectorTextureBindings, clippingUniformBuffers };
	const hasClippingUniformBuffers = artifactUsesClippingUniformBuffers( artifact );

	// Full three.js artifacts contain JSON descriptors. Rehydrate the subset
	// needed by WGSL pipeline layout creation and UBO uploads. Texture/storage
	// descriptors still need dedicated runtime registries, so leave them out
	// until those resources can be resolved safely.
	const groups = [];

	for ( const group of bindings ) {

		const runtimeBindings = [];
		const groupNode = {
			shared: findUniformGroupShared( artifact, group.name ),
			version: 0,
		};

		for ( const descriptor of group.bindings || [] ) {

			const runtimeBinding = createRuntimeBinding( artifact, group, descriptor, material, groupNode );
			if ( ! runtimeBinding ) continue;

			runtimeBindings.push( runtimeBinding );
			if ( runtimeBinding.isUniformBuffer ) uniformBuffers.set( descriptor.name || group.name || '', runtimeBinding );
			if ( hasClippingUniformBuffers && runtimeBinding.isUniformBuffer && /^UniformBuffer_/.test( descriptor.name || '' ) ) {

				clippingUniformBuffers.push( {
					binding: runtimeBinding,
					byteLength: runtimeBinding.buffer ? runtimeBinding.buffer.byteLength : descriptor.byteLength || 0,
					visibility: descriptor.visibility | 0,
				} );

			}

			// Track depth-texture bindings so the per-frame rebinder can swap
			// them to the live shadow map. The plan source carries `lightIndex`
			// and `vsm` flags; we resolve the actual texture at update time
			// because the renderer's shadow pass hasn't allocated it yet.
			const planSource = descriptor.kind === 'sampled-texture' || descriptor.kind === 'sampler'
				? findPlanTextureSource( artifact, group.name, descriptor.name )
				: null;
			if ( planSource && planSource.kind === 'depth.texture' ) {

				const depthBinding = {
					binding: runtimeBinding,
					artifact,
					bindingName: descriptor.name || '',
					lightIndex: Number.isInteger( planSource.lightIndex ) ? planSource.lightIndex : 0,
					lightUuid: typeof planSource.lightUuid === 'string' ? planSource.lightUuid : null,
					vsm: planSource.vsm === true,
					// Non-light depth textures (e.g. RenderTarget.depthTexture
					// sampled via `material.colorNode = texture(depthTexture)`)
					// have no owning AnalyticLightNode. The plan source signals
					// this with `lightIndex: -1, fromMaterialGraph: true`. The
					// rebinder resolves the live DepthTexture by walking the
					// owning material's node graph instead of `light.shadow.map`.
					fromMaterialGraph: planSource.fromMaterialGraph === true,
					textureUuid: typeof planSource.textureUuid === 'string' ? planSource.textureUuid : null,
					material,
				};
				recordShadowBindingDiagnostic( {
					phase: 'hydrateDepth',
					bindingName: depthBinding.bindingName,
					lightIndex: depthBinding.lightIndex,
					lightUuid: depthBinding.lightUuid,
					fromMaterialGraph: depthBinding.fromMaterialGraph,
					vsm: depthBinding.vsm,
					textureUuid: depthBinding.textureUuid,
					artifactName: artifact && artifact.name || material && material.name || null,
					bindingKind: descriptor.kind || null,
					textureType: descriptor.textureType || null,
				} );
				if ( depthBinding.fromMaterialGraph ) materialDepthBindings.push( depthBinding );
				else shadowDepthBindings.push( depthBinding );

			}

			// Artifact textures: tracked for late relinking and stale GPUTexture fixes.
			//
			// (a) Late-arriving live texture: hydration ran before a live texture was
			//     registered or generated (PMREM/environment maps, loader identity
			//     matches, compute storage textures), so binding.texture is a 1×1
			//     fallback. The rebinder re-resolves on each render-before and swaps to
			//     the real instance once available.
			//
			// (b) Stale GPUTexture under the same JS texture: the harness shares
			//     full's GPUTexture into slim's data map AFTER the bind group was
			//     built (`slimRenderer.backend.get(tex).texture =
			//     fullTexData.texture`). The rebinder bumps version + generation
			//     to force three.js to rebuild the view from the now-shared
			//     GPUTexture.
			if ( ( descriptor.kind === 'sampled-texture' || descriptor.kind === 'sampler' )
				&& ( runtimeBinding.isSampledTexture || runtimeBinding.isSampler )
				&& planSource && planSource.kind === 'artifact.texture' ) {

				const _planGroup = ( artifact.uniformPlan || [] ).find( ( g ) => g.name === group.name ) || {};
				const _planTex = ( _planGroup.textures || [] ).find( ( t ) => t.name === descriptor.name ) || {};
				artifactTextureBindings.push( {
					binding: runtimeBinding,
					artifact,
					groupName: group.name || '',
					bindingName: descriptor.name || '',
					source: planSource,
					textureType: _planTex.textureType || '2d',
					material,
				} );

			}

			if ( ( descriptor.kind === 'sampled-texture' || descriptor.kind === 'sampler' )
				&& ( runtimeBinding.isSampledTexture || runtimeBinding.isSampler )
				&& planSource && planSource.kind && planSource.kind.startsWith( 'material.' ) ) {

				materialTextureBindings.push( {
					binding: runtimeBinding,
					artifact,
					groupName: group.name || '',
					bindingName: descriptor.name || '',
					source: planSource,
					material,
				} );

			}

			// TSL `reflector()` bindings: each frame `ReflectorBaseNode.updateBefore`
			// renders the scene from a mirrored camera into a per-camera RT and
			// reassigns `textureNode.value`. The captured uuid points at the
			// module-private `_defaultRT.texture` and is dead at replay; the
			// artifact's `_liveUpdateBeforeNodes` sidecar is non-enumerable and
			// lost across the e2e capture→replay JSON boundary, so resolve the
			// live ReflectorBaseNode by walking the replay-side material's own
			// node graph — `reflector()` ran on the replay page when the user
			// HTML was imported, attaching a fresh ReflectorBaseNode to the
			// material. Each material in the failing examples carries a single
			// reflector, so the first ReflectorNode in the graph is correct;
			// `reflectorIndex` is reserved for future multi-reflector support.
			if ( ( descriptor.kind === 'sampled-texture' || descriptor.kind === 'sampler' )
				&& ( runtimeBinding.isSampledTexture || runtimeBinding.isSampler )
				&& planSource && planSource.kind === 'reflector.texture' ) {

				const baseNode = findReflectorBaseNodeInMaterial( material, planSource.reflectorIndex );
				if ( baseNode ) {

					reflectorTextureBindings.push( {
						binding: runtimeBinding,
						baseNode,
					} );

				}

			}

			// Viewport-texture bindings (transmission FBO etc.): captured WGSL
			// samples a `viewportMipTexture()` / `viewportTexture()` whose
			// FramebufferTexture is refreshed each frame. Track here so the
			// per-frame rebinder can drive the framebuffer copy and swap in
			// the live texture.
			if ( descriptor.kind === 'sampled-texture'
				&& runtimeBinding.isSampledTexture
				&& planSource && planSource.kind === 'viewport.texture' ) {

				viewportTextureBindings.push( {
					binding: runtimeBinding,
					generateMipmaps: planSource.generateMipmaps !== false,
					isDepth: planSource.isDepth === true || shaderDeclaresDepthTexture( artifact, descriptor.name || '' ),
				} );

			}

		}

		if ( runtimeBindings.length > 0 ) groups.push( new BindGroup( group.name || '', runtimeBindings ) );

	}

	return { bindings: groups, uniformBuffers, shadowDepthBindings, materialDepthBindings, artifactTextureBindings, materialTextureBindings, viewportTextureBindings, reflectorTextureBindings, clippingUniformBuffers };

}

/**
 * Look up a texture binding's source descriptor in the artifact's uniform plan.
 * Used by `hydrateRuntimeBindings` to discover `depth.texture` bindings that
 * need per-frame texture rebinding.
 *
 * @param {Object} artifact
 * @param {string} groupName
 * @param {string} bindingName
 * @return {?Object} Plan source descriptor, or null.
 */
function findPlanTextureSource( artifact, groupName, bindingName ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const group = plan.find( ( g ) => g.name === groupName );
	if ( ! group ) return null;
	const tex = ( group.textures || [] ).find( ( t ) => t.name === bindingName );
	return tex ? ( tex.source || null ) : null;

}

/**
 * Per-frame "node" that swaps each shadow-receiving binding's texture to the
 * live `light.shadow.map.depthTexture` (or the VSM intermediate render target's
 * `texture`) of the matching light in `frame.scene`. Without this, every
 * texture_depth_2d binding stays pointed at the 1×1 fallback that
 * `resolveTextureBinding` returned at hydration time, and shadow lookups in
 * the WGSL always sample "no shadow".
 *
 * Returns an object shaped like a three.js update-before node so
 * `NodeFrame.updateBeforeNode()` will dispatch to it. `getUpdateBeforeType()`
 * returns `'render'` so the swap runs once per render pass — three.js's
 * NodeFrame de-duplicates by render id, matching what stock three.js does
 * for ShadowNode itself.
 *
 * @param {Array<{binding: Object, lightIndex: number, lightUuid: ?string, vsm: boolean}>} entries
 * @param {Object} artifact
 * @return {Object}
 */
/**
 * Resolve the live `DepthTexture` reachable from a material's node graph.
 * Used by `createShadowDepthRebinder` for depth-texture bindings that are NOT
 * owned by an `AnalyticLightNode` (e.g. `RenderTarget.depthTexture` sampled via
 * `material.colorNode = texture(depthTexture)`). When the material's graph
 * holds multiple `DepthTexture` instances, prefers the one whose uuid matches
 * the captured hint.
 *
 * @param {?Object} material
 * @param {?string} textureUuid - Captured uuid hint; may be stale across reload.
 * @return {?Object}
 */
function resolveDepthTextureFromMaterial( material, textureUuid, camera = null ) {

	if ( ! material ) return null;
	let firstReflectorDepth = null;
	for ( const baseNode of collectMaterialReflectorBaseNodes( material ) ) {

		const rt = resolveReflectorRenderTarget( baseNode, camera );
		let tex = rt && rt.depthTexture || null;
		if ( ! tex && baseNode.textureNode && typeof baseNode.textureNode.getDepthNode === 'function' ) {

			try {

				const depthNode = baseNode.textureNode.getDepthNode();
				tex = depthNode && depthNode.value || null;

			} catch ( _ ) {

				tex = null;

			}

		}
		if ( ! tex || tex.isDepthTexture !== true ) continue;
		if ( ! firstReflectorDepth ) firstReflectorDepth = tex;
		if ( textureUuid && tex.uuid === textureUuid ) return tex;

	}
	if ( firstReflectorDepth ) return firstReflectorDepth;

	const graphTextures = collectMaterialNodeTextures( material );
	let graphMatch = null;
	let firstGraphDepth = null;
	for ( const tex of graphTextures ) {

		if ( ! tex || tex.isDepthTexture !== true ) continue;
		if ( ! firstGraphDepth ) firstGraphDepth = tex;
		if ( textureUuid && tex.uuid === textureUuid ) { graphMatch = tex; break; }

	}
	if ( graphMatch || firstGraphDepth ) return graphMatch || firstGraphDepth;

	const contextTextures = collectMaterialContextDepthTextures( material );
	let contextMatch = null;
	let firstContextDepth = null;
	for ( const tex of contextTextures ) {

		if ( ! firstContextDepth ) firstContextDepth = tex;
		if ( textureUuid && tex.uuid === textureUuid ) { contextMatch = tex; break; }

	}
	if ( contextMatch || firstContextDepth ) return contextMatch || firstContextDepth;

	const textures = collectLiveMaterialTextures( material );
	if ( ! textures || textures.size === 0 ) return null;

	let match = null;
	let firstDepth = null;
	for ( const tex of textures.values() ) {

		if ( ! tex || tex.isDepthTexture !== true ) continue;
		if ( ! firstDepth ) firstDepth = tex;
		if ( textureUuid && tex.uuid === textureUuid ) { match = tex; break; }

	}
	return match || firstDepth;

}

function createShadowDepthRebinder( entries /* , artifact */ ) {

	const lastSeen = new WeakMap();

	return {
		getUpdateBeforeType() {

			return 'render';

		},
		updateReference() {

			return this;

		},
		updateBefore( frame ) {

			const scene = frame && frame.scene ? frame.scene : null;

			for ( const entry of entries ) {

				let liveTexture = null;
				let light = null;

				if ( entry.fromMaterialGraph ) {

					// Non-light depth textures (e.g. `RenderTarget.depthTexture`
					// sampled via `material.colorNode = texture(depthTexture)`)
					// are reachable through the binding's owning material's
					// node graph. Reflector depth nodes are special in replay:
					// PrecompiledMaterial no longer carries the source colorNode,
					// so resolve through the stashed ReflectorBaseNode render
					// target first and fall back to a graph walk for plain
					// user-created RenderTarget.depthTexture nodes.
					liveTexture = resolveDepthTextureFromMaterial( entry.material, entry.textureUuid, frame && frame.camera || null );
					if ( ! liveTexture ) {

						const graphTextures = collectMaterialNodeTextures( entry.material );
						recordShadowBindingDiagnostic( {
							phase: 'materialDepthMiss',
							bindingName: entry.bindingName,
							textureUuid: entry.textureUuid,
							artifactName: entry.artifact && entry.artifact.name || entry.material && entry.material.name || null,
							nodeTextureCount: graphTextures.length,
							nodeTextures: graphTextures.slice( 0, 8 ).map( ( texture ) => ( {
								uuid: texture.uuid || null,
								name: texture.name || '',
								isDepthTexture: texture.isDepthTexture === true,
								image: texture.image ? [ texture.image.width || 0, texture.image.height || 0, texture.image.depth || 0 ] : null,
							} ) ),
						} );

					}

				} else {

					if ( ! scene ) continue;
					light = findShadowLight( scene, entry );
					if ( ! light || ! light.shadow || ! light.shadow.map ) continue;

					const map = light.shadow.map;
					// VSM materials sample the blurred VSM moments texture
					// (`ShadowNode.vsmShadowMapHorizontal.texture` — an RG colour render
					// target, not a DepthTexture). The slim renderer never runs shadow
					// setup so it has no shadow node; the e2e/full-renderer harness stashes
					// the live VSM blur output on `light.shadow.__tslpVsmShadowTexture` after
					// rendering the parallel shadow scene. Standard PCF/Hard shadows sample
					// the raw depth texture (`shadow.map.depthTexture`).
					liveTexture = entry.vsm
						? ( light.shadow.__tslpVsmShadowTexture || map.texture || null )
						: ( map.depthTexture || ( map.texture && map.texture.isDepthTexture === true ? map.texture : null ) );

				}

				if ( ! liveTexture ) continue;
				if ( ! textureMatchesShaderBinding( entry.artifact, entry.bindingName, liveTexture ) ) {

					recordShadowBindingDiagnostic( {
						phase: 'materialDepthTypeMismatch',
						bindingName: entry.bindingName,
						textureUuid: liveTexture.uuid || null,
						artifactName: entry.artifact && entry.artifact.name || entry.material && entry.material.name || null,
						isDepthTexture: liveTexture.isDepthTexture === true,
						image: liveTexture.image ? [ liveTexture.image.width || 0, liveTexture.image.height || 0, liveTexture.image.depth || 0 ] : null,
					} );
					continue;

				}
					const shadowCompareFunction = Number.isFinite( liveTexture.__tslpShadowCompareFunction ) ? liveTexture.__tslpShadowCompareFunction : null;
					const rendererCompareFunction = frame && frame.renderer && frame.renderer.reversedDepthBuffer ? GreaterEqualCompare : LessEqualCompare;
					const compareFunction = entry.fromMaterialGraph !== true && entry.vsm !== true && liveTexture.isDepthTexture === true
						? shadowCompareFunction ?? ( liveTexture.compareFunction !== null && liveTexture.compareFunction !== undefined ? liveTexture.compareFunction : rendererCompareFunction )
						: liveTexture.compareFunction !== null && liveTexture.compareFunction !== undefined ? liveTexture.compareFunction : rendererCompareFunction;
					if ( entry.fromMaterialGraph !== true && entry.vsm !== true && liveTexture.isDepthTexture === true && liveTexture.compareFunction !== compareFunction ) {

					liveTexture.compareFunction = compareFunction;
					liveTexture.needsUpdate = true;

				}

				const renderer = frame && frame.renderer ? frame.renderer : null;
				const data = renderer && renderer.backend ? renderer.backend.get( liveTexture ) : null;
				const gpuTexture = data ? data.texture : null;
				let changed = rebindTextureBindingTargets( entry.binding, liveTexture );
				let targetCount = 0;

				for ( const target of textureBindingTargets( entry.binding ) ) {

					targetCount ++;
					if ( ! gpuTexture ) continue;

					const prev = lastSeen.get( target );
					lastSeen.set( target, gpuTexture );
					if ( prev !== gpuTexture ) changed = true;

				}

				recordShadowBindingDiagnostic( {
					bindingName: entry.bindingName,
					lightIndex: entry.lightIndex,
					lightUuid: entry.lightUuid,
					light: lightDiagnosticShape( light ),
					textureUuid: liveTexture.uuid || null,
					isDepthTexture: liveTexture.isDepthTexture === true,
					compareFunction: liveTexture.compareFunction ?? null,
					hasGpuTexture: !! gpuTexture,
					gpuTexSize: gpuTexture ? [ gpuTexture.width || 0, gpuTexture.height || 0 ] : null,
					gpuTexFormat: gpuTexture ? ( gpuTexture.format || null ) : null,
					dataInitialized: !! ( data && data.initialized ),
					sharedFromFull: !! ( data && data.__tslpSharedShadowGPUTexture && data.__tslpSharedShadowGPUTexture === gpuTexture ),
					changed,
					sameBindingTexture: entry.binding.texture === liveTexture,
					targetCount,
				} );

				if ( changed ) {

					for ( const target of textureBindingTargets( entry.binding ) ) invalidateTextureBindingTarget( target );

				}

			}

		},
	};

}

/**
 * Return the live `ReflectorBaseNode` handles attached to a precompiled
 * material. The wrapped `PrecompiledMaterial` strips every `*Node` property,
 * so `__applyPrecompiled` extracts these handles from the source material's
 * graph at wrap time and stashes them on `__tslpReflectorBaseNodes`.
 *
 * @param {?Object} material
 * @return {Array<Object>}
 */
function collectMaterialReflectorBaseNodes( material ) {

	if ( ! material ) return [];
	const list = material.__tslpReflectorBaseNodes;
	const out = [];
	const append = ( node ) => {

		if ( ! node || typeof node.updateBefore !== 'function' ) return;
		if ( ! node.constructor || node.constructor.type !== 'ReflectorBaseNode' ) return;
		if ( ! ( node.renderTargets instanceof Map ) ) return;
		if ( ! out.includes( node ) ) out.push( node );

	};
	if ( Array.isArray( list ) ) {

		for ( const node of list ) append( node );

	}
	for ( const node of collectReflectorBaseNodes( material ) ) append( node );
	return out;

}

/**
 * Find the live `ReflectorBaseNode` for a captured reflector binding.
 *
 * @param {?Object} material
 * @param {number} reflectorIndex
 * @return {?Object} A live ReflectorBaseNode or null.
 */
function findReflectorBaseNodeInMaterial( material, reflectorIndex = -1 ) {

	const list = collectMaterialReflectorBaseNodes( material );
	if ( list.length === 0 ) return null;
	if ( Number.isInteger( reflectorIndex ) && reflectorIndex >= 0 && reflectorIndex < list.length ) return list[ reflectorIndex ];
	return list[ 0 ];

}

function installRebindableTextureBindingClone( binding ) {

	if ( ! binding || binding.__tslpRebindableClonePatched === true || typeof binding.clone !== 'function' ) return binding;
	if ( binding.isSampledTexture !== true && binding.isSampler !== true ) return binding;

	const originalClone = binding.clone;
	const clones = new Set();
	Object.defineProperty( binding, '__tslpRebindClones', {
		value: clones,
		configurable: true,
	} );
	Object.defineProperty( binding, '__tslpRebindableClonePatched', {
		value: true,
		configurable: true,
	} );
	binding.clone = function cloneRebindableTextureBinding() {

		const cloned = originalClone.call( this );
		clones.add( cloned );
		Object.defineProperty( cloned, '__tslpRebindSource', {
			value: binding,
			configurable: true,
		} );
		return cloned;

	};
	return binding;

}

function textureBindingTargets( binding ) {

	if ( ! binding ) return [];
	const source = binding.__tslpRebindSource || binding;
	const out = [ source ];
	const clones = source.__tslpRebindClones;
	if ( clones && typeof clones.forEach === 'function' ) {

		clones.forEach( ( clone ) => {

			if ( clone && ! out.includes( clone ) ) out.push( clone );

		} );

	}
	return out;

}

function invalidateTextureBindingTarget( binding ) {

	if ( ! binding ) return;
	if ( binding.groupNode ) binding.groupNode.version ++;
	binding.version = - 1;
	binding.generation = null;

}

function rebindTextureBindingTargets( binding, texture ) {

	let changed = false;
	for ( const target of textureBindingTargets( binding ) ) {

		if ( target.texture !== texture ) {

			target.texture = texture;
			changed = true;

		}

		if ( changed ) invalidateTextureBindingTarget( target );

	}
	return changed;

}

function textureBindingResourceSignature( target, renderer ) {

	const texture = target && target.texture || null;
	const backend = renderer && renderer.backend && typeof renderer.backend.get === 'function' ? renderer.backend : null;
	const data = texture && backend ? backend.get( texture ) : null;
	return {
		texture,
		gpuTexture: data ? data.texture || null : null,
		version: texture && Number.isFinite( texture.version ) ? texture.version : null,
	};

}

function invalidateOnTextureResourceChange( target, renderer, lastSeen ) {

	if ( ! target || ! lastSeen ) return;
	const current = textureBindingResourceSignature( target, renderer );
	const previous = lastSeen.get( target );
	lastSeen.set( target, current );
	if ( ! previous ) return;
	if ( previous.texture !== current.texture ||
		previous.gpuTexture !== current.gpuTexture ||
		previous.version !== current.version ) {

		invalidateTextureBindingTarget( target );

	}

}

function resolveReflectorRenderTarget( baseNode, camera ) {

	if ( ! baseNode || ! baseNode.renderTargets ) return null;
	let rt = null;
	if ( camera ) {

		let renderTargetCamera = camera;
		if ( typeof baseNode.getVirtualCamera === 'function' ) {

			try {

				renderTargetCamera = baseNode.getVirtualCamera( camera );

			} catch ( _ ) {

				renderTargetCamera = camera;

			}

		}
		rt = baseNode.renderTargets.get( renderTargetCamera ) || baseNode.renderTargets.get( camera );

	}
	if ( ! rt && baseNode.renderTargets.size > 0 ) {

		// Fallback: replay-time slim camera identity may not match the camera
		// passed to ReflectorBaseNode.updateBefore on the first run. Take any
		// keyed RT — usually exactly one outside bouncing multi-reflector scenes.
		rt = baseNode.renderTargets.values().next().value;

	}
	return rt || null;

}

/**
 * Per-frame rebinder for TSL `reflector()` bindings.
 *
 * `ReflectorBaseNode.updateBefore` lazy-allocates a `RenderTarget` per camera
 * (keyed by camera identity in `node.renderTargets`) and assigns
 * `node.textureNode.value = renderTarget.texture` each frame. The artifact's
 * captured binding still holds the module-private `_defaultRT.texture` (or a
 * 1×1 fallback after hydration), so without this rebinder the mirror surface
 * samples a flat colour. Run AFTER the live ReflectorBaseNode's own
 * `updateBefore` so the per-camera RT is keyed before we read it.
 *
 * This also runs during nested reflector render passes. `reflector()` defaults
 * to `bounces: true`, so a mirror render target may legitimately need to
 * sample another reflector's freshly-rendered target before the outer frame
 * reaches the main camera draw.
 *
 * @param {Array<{binding: Object, baseNode: Object}>} entries
 * @return {Object}
 */
function createReflectorTextureRebinder( entries ) {

	return {
		getUpdateBeforeType() {

			return 'render';

		},
		updateReference() {

			return this;

		},
		updateBefore( frame ) {

			const camera = frame ? frame.camera : null;

			for ( const entry of entries ) {

				const baseNode = entry.baseNode;
				if ( ! baseNode || ! baseNode.renderTargets ) continue;

				const rt = resolveReflectorRenderTarget( baseNode, camera );

				const liveTexture = rt && rt.texture || baseNode.textureNode && baseNode.textureNode.value;
				if ( ! liveTexture ) continue;

				rebindTextureBindingTargets( entry.binding, liveTexture );

			}

		},
	};

}

/**
 * Per-frame rebinder for viewport-texture bindings (transmission FBO).
 *
 * KHR_materials_transmission glass samples `viewportMipTexture()` /
 * `viewportOpaqueMipTexture()` — TSL nodes whose backing `FramebufferTexture`
 * is refreshed each frame via `renderer.copyFramebufferToTexture`. The
 * precompiled material has no node tree, so without this rebinder no copy
 * runs and the WGSL `textureSampleLevel` returns the 1×1 fallback (lamp
 * glass renders opaque/black instead of refractive).
 *
 * Strategy: lazily instantiate real three.js TSL ViewportTextureNode instances
 * (one per generateMipmaps variant), call their `updateBefore()` — which does
 * size sync + framebuffer copy + mipmap regen — then swap the binding's
 * `.texture` to the live FramebufferTexture for the current render target.
 * The copy is dedup'd by render id so multiple transmissive bindings in the
 * same frame trigger only one copyFramebufferToTexture per variant.
 *
 * @param {Array<{binding: Object, generateMipmaps: boolean, isDepth: boolean}>} entries
 * @return {Object}
 */
function createViewportTextureRebinder( entries ) {

	// Lazy singletons keyed by `generateMipmaps`. Sharing across all
	// precompiled transmissive materials matches three.js's own pattern
	// (see `_singletonOpaqueViewportTextureNode` in ViewportTextureNode.js)
	// so we only do one framebuffer copy per render even when many bindings
	// reference the same viewport-texture variant.
	let mipNode = null;
	let plainNode = null;
	let depthNode = null;
	const lastCopyRenderId = { mip: -1, plain: -1, depth: -1 };

	return {
		getUpdateBeforeType() {

			return 'render';

		},
		updateReference() {

			return this;

		},
		updateBefore( frame ) {

			if ( ! frame || ! frame.renderer ) return;

			for ( const entry of entries ) {

				const variant = entry.isDepth ? 'depth' : entry.generateMipmaps ? 'mip' : 'plain';
				let node = variant === 'depth' ? depthNode : variant === 'mip' ? mipNode : plainNode;
				if ( ! node ) {

					node = variant === 'depth' ? viewportDepthTexture() : variant === 'mip' ? viewportMipTexture() : viewportTexture();
					if ( variant === 'depth' ) depthNode = node;
					else if ( variant === 'mip' ) mipNode = node;
					else plainNode = node;

				}

				// `updateReference` selects the per-render-target FramebufferTexture
				// and assigns it to `node.value`. Must run every render-before
				// because `node.updateBefore` itself does NOT set `node.value`
				// (it only does the copy). Without this, `node.value` stays at
				// the constructor's 1×1 default fallback and we re-bind to that
				// instead of the freshly-copied framebuffer.
				if ( typeof node.updateReference === 'function' ) node.updateReference( frame );

				// Drive the framebuffer copy at most once per render id —
				// matches three.js' NodeFrame.RENDER de-dup so multiple
				// transmissive bindings in one render share one copy.
				const renderId = frame.renderId != null ? frame.renderId : 0;
				if ( lastCopyRenderId[ variant ] !== renderId ) {

					node.updateBefore( frame );
					lastCopyRenderId[ variant ] = renderId;

				}

				const liveTex = node.value;
				if ( ! liveTex ) continue;

				rebindTextureBindingTargets( entry.binding, liveTex );

			}

		},
	};

}

function createMaterialTextureRebinder( entries ) {

	const lastSeen = new WeakMap();

	return {
		getUpdateBeforeType() {

			return 'render';

		},
		updateReference() {

			return this;

		},
		updateBefore( frame ) {

			const renderer = frame && frame.renderer ? frame.renderer : null;

			for ( const entry of entries ) {

				const binding = entry && entry.binding;
				if ( ! binding ) continue;

				const candidate = resolveTextureBinding( entry.artifact, entry.groupName, entry.bindingName, entry.material );
				if ( candidate ) rebindTextureBindingTargets( binding, candidate );

				for ( const target of textureBindingTargets( binding ) ) {

					invalidateOnTextureResourceChange( target, renderer, lastSeen );

				}

			}

		},
	};

}

function createArtifactTextureRebinder( entries ) {

	// Track the last-seen GPUTexture per binding so we only invalidate when
	// it actually swaps (and don't bump every frame, which would defeat
	// three.js's bind-group cache).
	const lastSeen = new WeakMap();

	return {
		getUpdateBeforeType() {

			return 'render';

		},
		updateReference() {

			return this;

		},
		updateBefore( frame ) {

			const renderer = frame && frame.renderer ? frame.renderer : null;
			let avoidTexture = null;
			try {

				const renderTarget = renderer && typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
				avoidTexture = renderTarget && renderTarget.texture || null;

			} catch ( _ ) {}

			for ( const entry of entries ) {

				const binding = entry.binding;
				if ( ! binding ) continue;

				const candidate = resolveTextureBinding( entry.artifact, entry.groupName, entry.bindingName, entry.material, { avoidTexture } );
				if ( candidate ) {

					// Sampler's `texture` setter resets version=-1 and
					// generation=null automatically. SampledTexture does not, so
					// also bump below to make the bind-group cache rebuild.
					rebindTextureBindingTargets( binding, candidate );

				}

				// (b) Detect a swap of the underlying GPUTexture (slim's data
				// map's `.texture` was reassigned to share full's GPUTexture
				// after the bind group was built). Force three.js to rebuild
				// the bind group on the next draw.
				if ( ! renderer || ! renderer.backend ) continue;
				for ( const target of textureBindingTargets( binding ) ) {

					const tex = target.texture;
					if ( ! tex ) continue;
					const data = renderer.backend.get( tex );
					const gpuTexture = data ? data.texture : null;
					if ( ! gpuTexture ) continue;

					const prev = lastSeen.get( target );
					if ( prev === gpuTexture ) continue;

					lastSeen.set( target, gpuTexture );

					// First observation: just record. The bind group hasn't been
					// built yet against this binding, so there's no stale view to
					// invalidate.
					if ( prev === undefined ) continue;

					invalidateTextureBindingTarget( target );

				}

			}

		},
	};

}

/**
 * Find the live Light a shadow-depth binding belongs to. Prefers a UUID match
 * (production: same Light instance survives across frames), falls back to a
 * traversal-index lookup so harness/test paths that recreate the scene each
 * load can still relink.
 *
 * @param {Object} scene
 * @param {{lightIndex: number, lightUuid: ?string}} entry
 * @return {?Object}
 */
function findShadowLight( scene, entry ) {

	return findLightBySource( scene, entry );

}

function createLiveUniformArrayResolver( bindingName, byteLength, material ) {

	if ( ! /^UniformBuffer_/.test( bindingName || '' ) ) return null;
	if ( ! material ) return null;
	return function resolveLiveUniformArray() {

		const object = material.__tslpPrecompileObject;
		if ( ! object ) return null;

		const skeleton = object.skeleton;
		const boneMatrices = skeleton && skeleton.boneMatrices;
		if ( boneMatrices && boneMatrices.byteLength === byteLength ) {

			if ( typeof skeleton.update === 'function' ) skeleton.update();
			return boneMatrices;

		}

		const instanceArray = object.instanceMatrix && object.instanceMatrix.array;
		if ( instanceArray && instanceArray.byteLength === byteLength ) return instanceArray;

		return null;

	};

}

function attachLiveUniformBufferUpdater( uniformBuffer, liveArrayResolver ) {

	if ( ! uniformBuffer || typeof liveArrayResolver !== 'function' ) return;
	Object.defineProperty( uniformBuffer, '__tslpLiveArrayResolver', {
		value: liveArrayResolver,
		configurable: true,
	} );
	uniformBuffer.update = function updateLiveUniformBuffer() {

		const liveArray = this.__tslpLiveArrayResolver && this.__tslpLiveArrayResolver();
		if ( liveArray && this.buffer && typeof this.buffer.set === 'function' ) {

			this.buffer.set( liveArray.subarray ? liveArray.subarray( 0, this.buffer.length ) : liveArray.slice( 0, this.buffer.length ) );

		}
		return true;

	};

}

function createRuntimeBinding( artifact, group, descriptor, material, groupNode ) {

	const name = descriptor.name || group.name || '';

	if ( descriptor.kind === 'uniform-buffer' ) {

		const ubPlanEntry = resolvePlanBufferUniform( artifact, group.name, name );
		const planBufferByteLength = ubPlanEntry
			? Math.max(
				ubPlanEntry.byteLength || 0,
				ubPlanEntry.valueSnapshot && ubPlanEntry.valueSnapshot.length ? ubPlanEntry.valueSnapshot.length * 4 : 0
			)
			: 0;
		const standaloneUniformBuffer = /^UniformBuffer_/.test( name ) && name !== group.name;
		const flatUniformBuffer = standaloneUniformBuffer || !! ubPlanEntry;
		const byteLength = flatUniformBuffer
			? Math.max( descriptor.byteLength || 0, planBufferByteLength, 16 )
			: Math.max(
				descriptor.byteLength || 0,
				findUniformGroupByteLength( artifact, group.name, descriptor.name ),
				findUniformGroupRequiredByteLength( artifact, group.name, descriptor.name )
			);
		const buffer = new Float32Array( Math.max( 4, Math.ceil( byteLength / 4 ) ) );
		if ( ! flatUniformBuffer ) seedUniformBufferSnapshots( artifact, group.name, name, buffer );

		// Seed a NodeUniformBuffer (flat typed-array UBO used by FXAA, DoF,
		// and similar post-process shaders) from its compile-time snapshot.
		// These buffers have no slot decomposition in the plan, so the normal
		// per-slot write path skips them. A one-time snapshot seed at
		// least gives correct initial parameters for static post-process.
		if ( ubPlanEntry ) {

			const snap = ubPlanEntry._liveArray || ubPlanEntry.valueSnapshot;
			if ( snap ) {

				for ( let i = 0; i < Math.min( snap.length, buffer.length ); i ++ ) buffer[ i ] = snap[ i ];

			}

		}

		const uniformBuffer = new UniformBuffer( name, buffer );
		uniformBuffer.visibility = descriptor.visibility | 0;
		uniformBuffer.groupNode = groupNode;
		const liveArrayResolver = createLiveUniformArrayResolver( name, buffer.byteLength, material );
		if ( liveArrayResolver ) attachLiveUniformBufferUpdater( uniformBuffer, liveArrayResolver );
		return uniformBuffer;

	}

	if ( descriptor.kind === 'sampled-texture' ) {

		const texture = resolveTextureBinding( artifact, group.name, descriptor.name, material );
		const textureType = descriptor.textureType || inferTextureTypeFromShader( artifact, descriptor.name );
		let binding;
		if ( textureType === 'cube' ) binding = new SampledCubeTexture( name, texture );
		else if ( textureType === '3d' ) {

			binding = new Sampled3DTexture( name, texture );
			binding.isSampledTexture3D = true;

		}
		else if ( textureType === '2d-array' ) binding = new SampledArrayTexture( name, texture );
		else binding = new SampledTexture( name, texture );
		binding.visibility = descriptor.visibility | 0;
		binding.groupNode = groupNode;
		installRebindableTextureBindingClone( binding );
		return binding;

	}

	if ( descriptor.kind === 'sampler' ) {

		const texture = resolveTextureBinding( artifact, group.name, descriptor.name, material );
		const binding = new Sampler( name, texture );
		binding.visibility = descriptor.visibility | 0;
		binding.groupNode = groupNode;
		installRebindableTextureBindingClone( binding );
		return binding;

	}

	// Storage buffers — compute shaders bind typed arrays for read/write by
	// the compute kernel. Reconstruct from captured metadata. In-process flows
	// carry the live attribute as `_liveAttribute` on the plan entry; use it
	// directly to share the same typed array the compute kernel wrote into.
	if ( descriptor.kind === 'storage-buffer' ) {

		const sbEntry = resolvePlanStorageBuffer( artifact, group.name, name );
		let attr;
		// In-process flows attach a live StorageBufferAttribute; out-of-
		// process (JSON-loaded) flows lose the prototype + TypedArray view
		// to the round-trip. Trust `_liveAttribute` only when its
		// `.array` is still a real TypedArray — otherwise allocate fresh
		// from count/itemSize/arrayType so WebGPU's `createBuffer` sees a
		// finite byteLength.
		const liveAttr = sbEntry && sbEntry._liveAttribute;
		const liveAttrIsLive = liveAttr && liveAttr.array && ArrayBuffer.isView( liveAttr.array );
		if ( liveAttrIsLive ) {

			attr = liveAttr;

		} else {

			const count = sbEntry ? ( sbEntry.count || 1 ) : 1;
			const itemSize = sbEntry ? ( sbEntry.itemSize || 1 ) : 1;
			const TypedArray = resolveTypedArrayCtor( sbEntry ? sbEntry.arrayType : null );
			attr = new StorageBufferAttribute( count, itemSize, TypedArray );
			// Seed from `_liveArray` only if it survived as a TypedArray.
			// JSON round-trip drops the buffer view; the plain-object form
			// can still seed values via numeric-key iteration.
			const liveArr = sbEntry && sbEntry._liveArray;
			if ( liveArr ) {

				if ( ArrayBuffer.isView( liveArr ) ) {

					attr.array.set( liveArr.subarray( 0, attr.array.length ) );

				} else if ( typeof liveArr === 'object' ) {

					const keys = Object.keys( liveArr );
					for ( let i = 0; i < keys.length; i ++ ) {

						const k = keys[ i ];
						const idx = +k;
						if ( idx >= 0 && idx < attr.array.length ) attr.array[ idx ] = liveArr[ k ];

					}

				}

			}

		}
		const storageBuffer = new StorageBuffer( name, attr );
		storageBuffer.access = descriptor.access || 'read_write';
		storageBuffer.visibility = descriptor.visibility | 0;
		storageBuffer.groupNode = groupNode;
		return storageBuffer;

	}

	return null;

}

function seedUniformBufferSnapshots( artifact, groupName, bindingName, buffer ) {

	const group = findUniformGroup( artifact, groupName, bindingName );
	if ( ! group || ! Array.isArray( group.slots ) || group.slots.length === 0 ) return;

	const view = new DataView( buffer.buffer, buffer.byteOffset, buffer.byteLength );
	for ( const slot of group.slots ) {

		const source = slot.source || {};
		const snapshot = source.valueSnapshot || ( source.valueType ? { type: source.valueType, data: source.value } : null );
		if ( ! snapshot ) continue;
		writeSnapshot( view, slot.offset ?? slot.byteOffset ?? 0, snapshot );

	}

}

/**
 * Reconstruct an LTC BRDF approximation DataTexture from half-float data
 * stored in `artifact.ltcTextures[source.ltcIndex]` at capture time.
 *
 * Returns a cached instance if the artifact has already been hydrated for
 * this ltcIndex to avoid re-creating the DataTexture on every frame's
 * binding resolution. Returns null if the data is unavailable.
 *
 * @param {Object} artifact
 * @param {Object} source - The plan entry source with `ltcIndex`.
 * @return {?DataTexture}
 */
function buildLtcTexture( artifact, source ) {

	const ltcIndex = typeof source.ltcIndex === 'number' ? source.ltcIndex : 0;
	const ltcArrays = artifact.ltcTextures;
	if ( ! Array.isArray( ltcArrays ) || ltcIndex >= ltcArrays.length ) return null;

	// Cache reconstructed textures per artifact so we don't allocate new
	// DataTextures on every resolveTextureBinding call (called per-frame).
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
	if ( ! Array.isArray( rawData ) || rawData.length !== 64 * 64 * 4 ) return null;

	// Reconstruct as half-float (Uint16Array). HalfFloatType supports linear
	// filtering on all WebGPU devices; FloatType requires float32-filterable.
	const halfData = new Uint16Array( rawData );

	const tex = new DataTexture( halfData, 64, 64, RGBAFormat, HalfFloatType );

	// Apply sampler settings from the capture. Fall back to the same filter
	// configuration that RectAreaLightTexturesLib uses.
	tex.magFilter = typeof source.magFilter === 'number' ? source.magFilter : LinearFilter;
	tex.minFilter = typeof source.minFilter === 'number' ? source.minFilter : NearestFilter;
	tex.wrapS = typeof source.wrapS === 'number' ? source.wrapS : ClampToEdgeWrapping;
	tex.wrapT = typeof source.wrapT === 'number' ? source.wrapT : ClampToEdgeWrapping;
	tex.needsUpdate = true;

	artifact._ltcTextureCache.set( ltcIndex, tex );
	return tex;

}

function applyTextureSourceSettings( texture, source ) {

	if ( ! texture || ! source ) return texture;
	if ( texture.isRenderTargetTexture === true || texture.isFramebufferTexture === true ) return texture;
	let changed = false;
	for ( const prop of [ 'mapping', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'anisotropy' ] ) {

		if ( typeof source[ prop ] === 'number' && texture[ prop ] !== source[ prop ] ) {

			texture[ prop ] = source[ prop ];
			changed = true;

		}

	}
	if ( typeof source.generateMipmaps === 'boolean' && texture.generateMipmaps !== source.generateMipmaps ) {

		texture.generateMipmaps = source.generateMipmaps;
		changed = true;

	}
	if ( typeof source.colorSpace === 'string' && texture.colorSpace !== source.colorSpace ) {

		texture.colorSpace = source.colorSpace;
		changed = true;

	}
	if ( typeof source.flipY === 'boolean' && texture.flipY !== source.flipY ) {

		texture.flipY = source.flipY;
		changed = true;

	}
	if ( changed ) texture.needsUpdate = true;
	return texture;

}

function resolveTextureBinding( artifact, groupName, bindingName, material, options = null ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const group = plan.find( ( item ) => item.name === groupName );
	const texture = group && ( group.textures || [] ).find( ( item ) => item.name === bindingName );
	const source = texture && texture.source || {};
	const textureTypeHint = resolvePlanTextureTypeHint( artifact, group, texture, source, bindingName );

	// Shadow depth textures: extractor tags these with `kind: 'depth.texture'`
	// and a `lightIndex` for the owning AnalyticLightNode. We can't resolve
	// the live `light.shadow.map.depthTexture` here because the renderer
	// hasn't allocated the shadow map yet at hydration time — the per-frame
	// rebinder (registerShadowDepthRebinder, below) swaps it in at draw time.
	// Return the matching fallback so the bind group is still validatable.
	if ( source.kind === 'depth.texture' ) {
		return fallbackTextureForBinding( artifact, bindingName );

	}

	// Built-in DFG LUT for IBL: static precomputed 16×16 RG16F texture.
	// Identical to three.js's own DFGLUT.js — no renderer required.
	if ( source.kind === 'builtin.dfgLUT' ) {

		return getDFGLUT() || fallbackTextureForBinding( artifact, bindingName );

	}

	// LTC BRDF approximation textures for RectAreaLight (ltc_1 / ltc_2).
	// Captured at compile time from RectAreaLightTexturesLib and stored as
	// uint16 half-float arrays in `artifact.ltcTextures[ltcIndex]`. We
	// reconstruct as HalfFloatType DataTextures so linear filtering works
	// on all WebGPU devices without requiring the `float32-filterable` feature.
	if ( source.kind === 'builtin.ltcTexture' ) {

		return buildLtcTexture( artifact, source ) || fallbackTextureForBinding( artifact, bindingName );

	}

	if ( source.kind && source.kind.startsWith( 'material.' ) ) {

		const property = source.property || source.kind.split( '.' )[ 1 ];
		return material && material[ property ] || fallbackTextureForBinding( artifact, bindingName );

	}

	// Viewport-texture bindings (transmission FBO etc.): the live
	// FramebufferTexture is swapped in by `createViewportTextureRebinder`
	// per render. Return a 1×1 FramebufferTexture so the WebGPU bind-group
	// layout validates on the first frame (before updateBefore runs).
	if ( source.kind === 'viewport.texture' ) {

		return makeViewportFallback( artifact, bindingName, source );

	}

	// artifact.texture: resolve by UUID first (production path — same Texture
	// instance is used). Fall back to imageSrc/textureName matching against a
	// runtime-registered texture index so harness/test paths that re-create
	// Texture instances on each load can still relink. Snapshot data is the
	// last resort.
	if ( source.kind === 'artifact.texture' && source.textureUuid ) {

		const wantsDepthTexture = shaderDeclaresDepthTexture( artifact, bindingName );
		const wantsMultisampledTexture = shaderDeclaresMultisampledTexture( artifact, bindingName );
		if ( wantsDepthTexture && ! wantsMultisampledTexture ) {
			return fallbackDepthTexture;
		}

		const nodeTexture = lookupMaterialNodeTexture( material, source, artifact, bindingName, options && options.avoidTexture || null );
		if ( nodeTexture ) return applyTextureSourceSettings( nodeTexture, source );

		// Prefer a currently-loaded texture with matching image/name identity over
		// sidecar refs. The replay harness may seed _textureRefs with conservative
		// 1x1 fallbacks before async loaders finish; identity lookup lets later
		// TextureLoader / light.map registrations replace those stubs.
		const byIdent = lookupLiveTextureByIdentity( source );
		if ( byIdent && textureMatchesShaderBinding( artifact, bindingName, byIdent ) ) {

			return applyTextureSourceSettings( byIdent, source );

		}

		if ( artifact._textureRefs ) {

			const tex = artifact._textureRefs.get( source.textureUuid );
			if ( tex && textureMatchesShaderBinding( artifact, bindingName, tex ) ) {
				return applyTextureSourceSettings( tex, source );
			}

		}

		if ( material ) {

			const TEXTURE_PROPS = [
				'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
				'emissiveMap', 'envMap', 'lightMap', 'displacementMap',
				'alphaMap', 'bumpMap', 'clearcoatMap', 'clearcoatNormalMap',
				'clearcoatRoughnessMap', 'transmissionMap', 'thicknessMap',
				'iridescenceMap', 'iridescenceThicknessMap', 'sheenColorMap',
				'sheenRoughnessMap', 'specularMap', 'specularColorMap',
				'specularIntensityMap', 'gradientMap', 'matcap',
			];
			for ( const prop of TEXTURE_PROPS ) {

				const tex = material[ prop ];
				if ( tex && tex.isTexture === true && tex.uuid === source.textureUuid && textureMatchesShaderBinding( artifact, bindingName, tex ) ) {
					return applyTextureSourceSettings( tex, source );
				}

			}

		}

		// Identity-based relink (imageSrc / textureName). The runtime keeps
		// a global index updated by the host (harness or app) via
		// `registerLiveTexture`. This is what allows TSL `texture(uvTex)`
		// closures to resolve when the example reloads with fresh Texture
		// instances whose uuids no longer match the captured artifact.
		if ( source.snapshot ) {

			// Anonymous live DataTexture fallback. When the captured snapshot
			// is trivial (all zeros — e.g. webgpu_compute_audio's analyserBuffer
			// captured before audio playback started), prefer a unique live
			// DataTexture of matching shape over rebuilding from the empty
			// snapshot. This lets the example's per-frame `needsUpdate` flow
			// drive replay rendering instead of binding a dead zero buffer.
			if ( ! wantsDepthTexture && ! wantsMultisampledTexture && isTrivialSnapshot( source.snapshot ) ) {

				const anonData = lookupAnonymousDataTexture( source.snapshot );
				if ( anonData && textureMatchesShaderBinding( artifact, bindingName, anonData ) ) {

					return applyTextureSourceSettings( anonData, source );

				}

			}

			return textureFromSnapshot( artifact, source.textureUuid, source.snapshot, bindingName, textureTypeHint );

		}

		if ( wantsDepthTexture && wantsMultisampledTexture ) {
			return fallbackMultisampledDepthTexture;
		}

		// Last-resort: anonymous storage texture lookup.
		// When a compute-written StorageTexture has no name and no snapshot,
		// and its captured UUID is dead, try to find the live storage texture
		// by dimensionality. This covers simple single-storage-texture scenes
		// (e.g. webgpu_compute_texture) where the right texture exists in the
		// runtime but was never registered by name or src.
		if ( texture ) {

			const lookupType = texture.textureType === '3d' ? '3d'
				: texture.textureType === '2d-array' ? '2d-array'
				: '2d';
			const anon = lookupAnonymousStorageTexture( lookupType );
			if ( anon ) return anon;

		}

	}

	return fallbackTextureForBinding( artifact, bindingName );

}

function textureBindingNameForSampler( bindingName ) {

	return typeof bindingName === 'string' && bindingName.endsWith( '_sampler' )
		? bindingName.slice( 0, - '_sampler'.length )
		: bindingName;

}

function resolvePlanTextureTypeHint( artifact, group, textureEntry, source, bindingName ) {

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

function shaderDeclaresDepthTexture( artifact, bindingName ) {

	const wgsl = `${ artifact.vertexShader || '' }\n${ artifact.fragmentShader || '' }\n${ artifact.computeShader || '' }`;
	const escaped = textureBindingNameForSampler( bindingName ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	return new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_depth`, 'm' ).test( wgsl );

}

function shaderDeclaresComparisonSampler( artifact, bindingName ) {

	const wgsl = `${ artifact.vertexShader || '' }\n${ artifact.fragmentShader || '' }\n${ artifact.computeShader || '' }`;
	const escaped = String( bindingName || '' ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	return new RegExp( `var\\s+${ escaped }\\s*:\\s*sampler_comparison`, 'm' ).test( wgsl );

}

function shaderDeclaresCubeTexture( artifact, bindingName ) {

	const wgsl = `${ artifact.vertexShader || '' }\n${ artifact.fragmentShader || '' }\n${ artifact.computeShader || '' }`;
	const escaped = textureBindingNameForSampler( bindingName ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	return new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_(?:depth_)?cube`, 'm' ).test( wgsl );

}

function textureMatchesShaderBinding( artifact, bindingName, texture ) {

	if ( ! textureMatchesShaderMultisample( artifact, bindingName, texture ) ) return false;
	if ( ! texture ) return true;
	if ( shaderDeclaresCubeTexture( artifact, bindingName ) ) return texture.isCubeTexture === true;
	const textureType = inferTextureTypeFromShader( artifact, bindingName );
	if ( textureType === '3d' ) return texture.isData3DTexture === true || texture.isTexture3D === true;
	if ( textureType === '2d-array' ) return texture.isDataArrayTexture === true || texture.isArrayTexture === true || texture.isCompressedArrayTexture === true || ( texture.isDepthTexture === true && texture.image && texture.image.depth > 1 );
	return true;

}

function textureMatchesShaderMultisample( artifact, bindingName, texture ) {

	if ( ! texture ) return true;
	const wantsMultisampledTexture = shaderDeclaresMultisampledTexture( artifact, bindingName );
	if ( texture.isRenderTargetTexture === true && texture.isDepthTexture !== true ) return wantsMultisampledTexture === false;
	const isMultisampledTexture = isLikelyMultisampledTexture( texture );
	return wantsMultisampledTexture ? isMultisampledTexture : ! isMultisampledTexture;

}

function isLikelyMultisampledTexture( texture ) {

	return !! ( texture && texture.renderTarget && texture.renderTarget.samples > 1 );

}

function shaderDeclaresMultisampledTexture( artifact, bindingName ) {

	const wgsl = `${ artifact.vertexShader || '' }\n${ artifact.fragmentShader || '' }\n${ artifact.computeShader || '' }`;
	const escaped = textureBindingNameForSampler( bindingName ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	return new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_(?:depth_)?multisampled_2d`, 'm' ).test( wgsl );

}
function shaderDeclaresArrayTexture( artifact, bindingName ) {

	const wgsl = `${ artifact.vertexShader || '' }\n${ artifact.fragmentShader || '' }\n${ artifact.computeShader || '' }`;
	const escaped = textureBindingNameForSampler( bindingName ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	return new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_(?:depth_)?2d_array`, 'm' ).test( wgsl );

}

function artifactUsesClippingUniformBuffers( artifact ) {

	const wgsl = `${ artifact && artifact.vertexShader || '' }\n${ artifact && artifact.fragmentShader || '' }`;
	return /\bclip_distances\b|\bhw_clip_distances\b|\bclipped\b|\bclipOpacity\b|\bdistanceToPlane\b/.test( wgsl );

}

function textureFromSnapshot( artifact, uuid, snapshot, bindingName = null, textureTypeHint = null ) {

	if ( ! snapshot || ! Array.isArray( snapshot.data ) || ! snapshot.width || ! snapshot.height ) {

		return artifact && bindingName ? fallbackTextureForBinding( artifact, bindingName ) : fallbackTexture;

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
	if ( ! artifact._textureSnapshotCache ) Object.defineProperty( artifact, '_textureSnapshotCache', { value: new Map(), enumerable: false } );
	if ( artifact._textureSnapshotCache.has( key ) ) return artifact._textureSnapshotCache.get( key );

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
	artifact._textureSnapshotCache.set( key, texture );
	return texture;

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

function fallbackTextureForBinding( artifact, bindingName ) {

	const wgsl = `${ artifact.vertexShader || '' }\n${ artifact.fragmentShader || '' }\n${ artifact.computeShader || '' }`;
	if ( shaderDeclaresComparisonSampler( artifact, bindingName ) ) return fallbackComparisonDepthTexture;
	const escaped = textureBindingNameForSampler( bindingName ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_depth_cube`, 'm' ).test( wgsl ) ) return fallbackDepthCubeTexture;
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_depth_2d_array`, 'm' ).test( wgsl ) ) return fallbackDepthArrayTexture;
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_depth`, 'm' ).test( wgsl ) ) {

		return shaderDeclaresMultisampledTexture( artifact, bindingName ) ? fallbackMultisampledDepthTexture : fallbackDepthTexture;

	}
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_cube`, 'm' ).test( wgsl ) ) return fallbackCubeTexture;
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_3d`, 'm' ).test( wgsl ) ) return fallback3DTexture;
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_2d_array`, 'm' ).test( wgsl ) ) return fallbackArrayTexture;
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*sampler_comparison`, 'm' ).test( wgsl ) ) return fallbackComparisonDepthTexture;
	if ( /sampler/i.test( bindingName ) ) {

		const textureName = bindingName.replace( /_sampler$/, '' );
		if ( textureName !== bindingName && shaderDeclaresDepthTexture( artifact, textureName ) ) return shaderDeclaresComparisonSampler( artifact, bindingName ) ? fallbackComparisonDepthTexture : fallbackDepthTexture;

	}
	return fallbackTexture;

}

function inferTextureTypeFromShader( artifact, bindingName ) {

	const wgsl = `${ artifact.vertexShader || '' }\n${ artifact.fragmentShader || '' }\n${ artifact.computeShader || '' }`;
	const escaped = textureBindingNameForSampler( bindingName ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_depth_cube`, 'm' ).test( wgsl ) ) return 'cube';
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_cube`, 'm' ).test( wgsl ) ) return 'cube';
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_3d`, 'm' ).test( wgsl ) ) return '3d';
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_(?:depth_)?2d_array`, 'm' ).test( wgsl ) ) return '2d-array';
	return null;

}

function findUniformGroup( artifact, groupName, bindingName ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	return plan.find( ( group ) => group.name === groupName || group.name === bindingName ) || null;

}

function findUniformGroupByteLength( artifact, groupName, bindingName ) {

	const group = findUniformGroup( artifact, groupName, bindingName );
	return group && group.byteLength || 16;

}

function findUniformGroupRequiredByteLength( artifact, groupName, bindingName ) {

	const group = findUniformGroup( artifact, groupName, bindingName );
	if ( ! group || ! Array.isArray( group.slots ) ) return 16;
	let byteLength = group.byteLength || 16;
	for ( const slot of group.slots ) {

		const offset = slot.offset ?? slot.byteOffset ?? 0;
		const source = slot.source || {};
		const snapshot = source.valueSnapshot || ( source.valueType ? { type: source.valueType, data: source.value } : null );
		const snapshotSize = snapshot && Array.isArray( snapshot.data ) ? snapshot.data.length * 4 : 0;
		const slotSize = slot.byteLength || snapshotSize || uniformSlotByteLength( slot.type || slot.valueType || source.valueType );
		byteLength = Math.max( byteLength, offset + slotSize );

	}
	return Math.ceil( byteLength / 16 ) * 16;

}

function uniformSlotByteLength( type ) {

	switch ( type ) {

		case 'float':
		case 'int':
		case 'uint':
		case 'bool':
			return 4;
		case 'vec2':
			return 8;
		case 'vec3':
		case 'vec4':
			return 16;
		case 'mat3':
			return 48;
		case 'mat4':
			return 64;
		default:
			return 64;

	}

}

/**
 * Locate a storage-buffer plan entry by group and binding name.
 *
 * @param {Object} artifact
 * @param {string} groupName
 * @param {string} bindingName
 * @return {?Object}
 */
function resolvePlanStorageBuffer( artifact, groupName, bindingName ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const group = plan.find( ( g ) => g.name === groupName );
	if ( ! group ) return null;

	// storageBuffers list on the group entry
	const sbList = group.storageBuffers || [];
	const sb = sbList.find( ( s ) => s.name === bindingName );
	if ( sb ) return sb;

	// Also search orderedBindings in case only that list was serialised
	for ( const ob of group.orderedBindings || [] ) {

		if ( ob.type === 'storage-buffer' && ob.ref && ob.ref.name === bindingName ) return ob.ref;

	}

	return null;

}

/**
 * Locate a NodeUniformBuffer (buffer-uniform) plan entry by group and name.
 * These are flat UBOs used by post-process shaders (FXAA, DoF, etc.) —
 * they carry a valueSnapshot of the full typed array at capture time.
 *
 * @param {Object} artifact
 * @param {string} groupName
 * @param {string} bindingName
 * @return {?Object}
 */
function resolvePlanBufferUniform( artifact, groupName, bindingName ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const group = plan.find( ( g ) => g.name === groupName || g.name === bindingName );
	if ( ! group ) return null;

	for ( const ob of group.orderedBindings || [] ) {

		if ( ob.type === 'buffer-uniform' && ob.ref && ( ob.ref.name === bindingName || ob.ref.name === groupName ) ) return ob.ref;

	}

	return null;

}

/**
 * Resolve a typed-array constructor name to the actual constructor.
 * Defaults to Float32Array for unknown / missing names.
 *
 * @param {?string} name
 * @return {typeof Float32Array}
 */
function resolveTypedArrayCtor( name ) {

	switch ( name ) {

		case 'Int8Array': return Int8Array;
		case 'Uint8Array': return Uint8Array;
		case 'Uint8ClampedArray': return Uint8ClampedArray;
		case 'Int16Array': return Int16Array;
		case 'Uint16Array': return Uint16Array;
		case 'Int32Array': return Int32Array;
		case 'Uint32Array': return Uint32Array;
		case 'Float32Array': return Float32Array;
		case 'Float64Array': return Float64Array;
		default: return Float32Array;

	}

}

function findUniformGroupShared( artifact, groupName, bindingName ) {

	const group = findUniformGroup( artifact, groupName, bindingName );
	return !! ( group && group.shared );

}

function collectClippingGroupsForObject( object, shadowPass = false ) {

	const groups = [];
	let cursor = object && object.parent || null;
	while ( cursor ) {

		if ( cursor.isClippingGroup === true && cursor.enabled !== false && ( ! shadowPass || cursor.clipShadows === true ) ) groups.unshift( cursor );
		cursor = cursor.parent || null;

	}
	return groups;

}

function projectClippingPlanes( planes, camera ) {

	const count = Array.isArray( planes ) ? planes.length : 0;
	const out = new Float32Array( count * 4 );
	if ( count === 0 || ! camera || ! camera.matrixWorldInverse ) return out;
	_clipNormalMatrix.getNormalMatrix( camera.matrixWorldInverse );
	for ( let i = 0; i < count; i ++ ) {

		const plane = planes[ i ];
		if ( ! plane || ! plane.normal ) continue;
		_clipPlane.copy( plane ).applyMatrix4( camera.matrixWorldInverse, _clipNormalMatrix );
		const normal = _clipPlane.normal;
		const offset = i * 4;
		out[ offset + 0 ] = - normal.x;
		out[ offset + 1 ] = - normal.y;
		out[ offset + 2 ] = - normal.z;
		out[ offset + 3 ] = _clipPlane.constant;

	}
	return out;

}

function clippingPlaneSetsForFrame( frame, material ) {

	const object = frame && frame.object || material && material.__tslpPrecompileObject || null;
	const camera = frame && frame.camera || null;
	if ( ! object || ! camera ) return null;
	const groups = collectClippingGroupsForObject( object, frame && frame.scene && frame.scene.overrideMaterial && frame.scene.overrideMaterial.isShadowPassMaterial === true );
	if ( groups.length === 0 ) return null;
	const unionPlanes = [];
	const intersectionPlanes = [];
	for ( const group of groups ) {

		const planes = Array.isArray( group.clippingPlanes ) ? group.clippingPlanes : [];
		if ( planes.length === 0 ) continue;
		if ( group.clipIntersection === true ) intersectionPlanes.push( ...planes );
		else unionPlanes.push( ...planes );

	}
	return {
		union: projectClippingPlanes( unionPlanes, camera ),
		intersection: projectClippingPlanes( intersectionPlanes, camera ),
	};

}

function selectClippingPlaneArray( entry, sets ) {

	if ( ! entry || ! sets ) return null;
	const count = Math.max( 0, ( entry.byteLength / 16 ) | 0 );
	if ( count === 0 ) return null;
	const unionCount = sets.union.length / 4;
	const intersectionCount = sets.intersection.length / 4;
	const vertexOnly = ( entry.visibility & 1 ) !== 0 && ( entry.visibility & 2 ) === 0;
	const fragmentOnly = ( entry.visibility & 2 ) !== 0 && ( entry.visibility & 1 ) === 0;
	if ( vertexOnly && unionCount === count ) return sets.union;
	if ( fragmentOnly && intersectionCount === count ) return sets.intersection;
	if ( unionCount === count && intersectionCount !== count ) return sets.union;
	if ( intersectionCount === count && unionCount !== count ) return sets.intersection;
	if ( fragmentOnly && unionCount === count ) return sets.union;
	if ( vertexOnly && intersectionCount === count ) return sets.intersection;
	return null;

}

function createClippingUniformUpdateNode( entries, material ) {

	return {
		getUpdateType() {

			return 'object';

		},
		updateReference() {

			return this;

		},
		update( frame ) {

			const sets = clippingPlaneSetsForFrame( frame, frame && frame.material || material );
			for ( const entry of entries ) {

				const binding = entry && entry.binding;
				if ( ! binding || ! binding.buffer || typeof binding.buffer.fill !== 'function' ) continue;
				const values = selectClippingPlaneArray( entry, sets );
				binding.buffer.fill( 0 );
				if ( values ) binding.buffer.set( values.subarray ? values.subarray( 0, binding.buffer.length ) : values.slice( 0, binding.buffer.length ) );
				if ( binding.groupNode ) binding.groupNode.version ++;

			}

		},
	};

}

function createUniformUpdateNode( artifact, uniformBuffers, material ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	if ( plan.length === 0 || uniformBuffers.size === 0 ) return null;
	const generatedUpdateGroup = typeof artifact._generatedUpdateGroup === 'function' ? artifact._generatedUpdateGroup : null;

	return {
		getUpdateType() {

			return 'object';

		},
		updateReference() {

			return this;

		},
		update( frame ) {

			const frameMaterial = frame.material || material || null;
			for ( const group of plan ) {

				const binding = uniformBuffers.get( group.name );
				if ( ! binding ) continue;

				const view = new DataView( binding.buffer.buffer, binding.buffer.byteOffset, binding.buffer.byteLength );
				if ( generatedUpdateGroup ) generatedUpdateGroup( frame, frameMaterial, view, 0, group.name || '' );
				else writeUniformGroup( group, frame, view, frameMaterial );
				binding.groupNode.version ++;

			}

		},
	};

}

function writeUniformGroup( group, frame, view, material ) {

	for ( const slot of group.slots || [] ) {

		const source = slot.source || {};
		const offset = slot.offset ?? slot.byteOffset ?? 0;
		const kind = source.kind || 'unknown';

		if ( kind === 'camera.projectionMatrix' ) writeMat4( view, offset, frame.camera && frame.camera.projectionMatrix, source.valueSnapshot );
		else if ( kind === 'camera.projectionMatrixInverse' ) writeMat4( view, offset, frame.camera && frame.camera.projectionMatrixInverse, source.valueSnapshot );
		else if ( kind === 'camera.viewMatrix' ) writeMat4( view, offset, frame.camera && frame.camera.matrixWorldInverse, source.valueSnapshot );
		else if ( kind === 'camera.worldMatrix' ) writeMat4( view, offset, frame.camera && frame.camera.matrixWorld, source.valueSnapshot );
		else if ( kind === 'camera.position' ) writeVec3( view, offset, frame.camera && frame.camera.position, source.valueSnapshot );
		else if ( kind === 'camera.near' ) writeNumber( view, offset, frame.camera && frame.camera.near, source.valueSnapshot );
		else if ( kind === 'camera.far' ) writeNumber( view, offset, frame.camera && frame.camera.far, source.valueSnapshot );
			else if ( kind === 'frame.time' ) writeNumber( view, offset, frame.time, source.valueSnapshot );
		else if ( kind === 'frame.deltaTime' ) writeNumber( view, offset, frame.deltaTime, source.valueSnapshot );
		else if ( kind === 'frame.frameId' ) writeUint( view, offset, frame.frameId, source.valueSnapshot );
		else if ( kind === 'object.worldMatrix' || kind === 'object3d.worldMatrix' ) writeMat4( view, offset, frame.object && frame.object.matrixWorld, source.valueSnapshot );
		else if ( kind === 'object.worldMatrixInverse' ) {

			if ( frame.object ) { _mwi.copy( frame.object.matrixWorld ).invert(); writeMat4( view, offset, _mwi ); }
			else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'object.normalMatrix' || kind === 'object3d.normalMatrix' ) {

			if ( frame.object && frame.object.normalMatrix && frame.object.matrixWorld ) {
				frame.object.normalMatrix.getNormalMatrix( frame.object.matrixWorld );
				writeMat3( view, offset, frame.object.normalMatrix );
			} else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'object.modelViewMatrix' || kind === 'object3d.modelViewMatrix' ) {

			if ( frame.object && frame.object.modelViewMatrix && frame.object.matrixWorld && frame.camera && frame.camera.matrixWorldInverse ) {
				frame.object.modelViewMatrix.multiplyMatrices( frame.camera.matrixWorldInverse, frame.object.matrixWorld );
				writeMat4( view, offset, frame.object.modelViewMatrix );
			} else writeSnapshot( view, offset, source.valueSnapshot );

		}
		else if ( kind === 'object.position' || kind === 'object3d.position' ) writeVec3( view, offset, frame.object && frame.object.position, source.valueSnapshot );
		else if ( kind === 'object.scale' || kind === 'object3d.scale' ) writeVec3( view, offset, frame.object && frame.object.scale, source.valueSnapshot );
		else if ( kind === 'object3d.viewPosition' ) {

			if ( frame.object && frame.camera ) {

				_ovp.setFromMatrixPosition( frame.object.matrixWorld ).applyMatrix4( frame.camera.matrixWorldInverse );
				writeVec3( view, offset, _ovp );

			} else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'object3d.direction' ) {

			if ( frame.object ) { frame.object.getWorldDirection( _odir ); writeVec3( view, offset, _odir ); }
			else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'object3d.userData' ) {

			// Per-draw read: `frame.object.userData[property]`.
			// Supports float/int/uint today (scalars are the vast majority
			// of userData-driven uniforms — e.g. sprite rotation, opacity).
			const udProp = source.property;
			const udType = source.uniformType || 'float';
			const udRaw = ( frame.object && udProp != null && frame.object.userData != null )
				? frame.object.userData[ udProp ]
				: undefined;
			if ( udType === 'int' || udType === 'i32' ) writeInt( view, offset, Number.isFinite( udRaw ) ? udRaw : null, source.valueSnapshot );
			else if ( udType === 'uint' || udType === 'u32' ) writeUint( view, offset, Number.isFinite( udRaw ) ? udRaw : null, source.valueSnapshot );
			else writeNumber( view, offset, Number.isFinite( udRaw ) ? udRaw : null, source.valueSnapshot );

		} else if ( kind === 'object3d.radius' ) {

			const geom = frame.object && frame.object.geometry;
			const radius = geom && geom.boundingSphere ? geom.boundingSphere.radius : null;
			writeNumber( view, offset, radius, source.valueSnapshot );

		} else if ( kind === 'renderer.dpr' ) {

			writeNumber( view, offset, frame.renderer ? frame.renderer.getPixelRatio() : null, source.valueSnapshot );

		} else if ( kind === 'renderer.size' ) {

			if ( frame.renderer ) { frame.renderer.getDrawingBufferSize( _rSize ); writeVec2( view, offset, _rSize ); }
			else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'renderer.halfHeight' ) {

			if ( frame.renderer ) { frame.renderer.getSize( _rSize ); writeNumber( view, offset, 0.5 * _rSize.y, source.valueSnapshot ); }
			else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'renderer.viewport' ) {

			if ( frame.renderer ) { frame.renderer.getViewport( _rViewport ); writeVec4( view, offset, _rViewport ); }
			else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'renderer.toneMappingExposure' ) {

			view.setFloat32( offset, frame.renderer ? frame.renderer.toneMappingExposure : ( source.valueSnapshot ? Number( source.valueSnapshot.data ) : 1 ), true );

		}
		else if ( kind.startsWith( 'material.' ) ) writeMaterialValue( view, offset, frame.material || material, source, kind, slot.dtype );
		else if ( kind === 'scene.fog.color' ) writeColor( view, offset, frame.scene && frame.scene.fog && frame.scene.fog.color, source.valueSnapshot );
		else if ( kind === 'scene.fog.near' || kind === 'scene.fog.far' || kind === 'scene.fog.density' ) {

			const property = source.property || kind.split( '.' )[ 2 ];
			writeNumber( view, offset, frame.scene && frame.scene.fog && frame.scene.fog[ property ], source.valueSnapshot );

		} else if ( kind === 'scene.environmentIntensity' || kind === 'scene.backgroundIntensity' || kind === 'scene.backgroundBlurriness' ) {

			const property = source.property || kind.split( '.' )[ 1 ];
			writeNumber( view, offset, frame.scene && frame.scene[ property ], source.valueSnapshot );

		} else if ( kind === 'scene.backgroundRotation' ) {

			// Three.js's `backgroundRotation` TSL is a Matrix4 derived from
			// scene.backgroundRotation (Euler) — only emitted when the
			// background is a textured cube/equirect map. Mirror three.js's
			// SceneProperties: rotate-from-euler then transpose. Skip for
			// non-rotated scenes (Euler is zero) by writing identity.
			if ( frame.scene && frame.scene.backgroundRotation && frame.scene.background && frame.scene.background.isTexture === true ) {

				_mwi.makeRotationFromEuler( frame.scene.backgroundRotation ).transpose();
				writeMat4( view, offset, _mwi );

			} else writeMat4( view, offset, null, source.valueSnapshot );

		} else if ( kind && kind.startsWith( 'light.' ) ) {

			writeLightValue( view, offset, kind, source, frame );

		} else if ( kind === 'constant' || kind === 'uniform.constant' ) {

			writeSnapshot( view, offset, source.valueSnapshot || { type: source.valueType, data: source.value } );

		} else if ( kind === 'uniform.live' ) {

			// Prefer the live node's current value (updated by _liveUpdateNodes
			// that ran earlier this frame). Fall back to the compile-time snapshot
			// when no live node is available (JSON-loaded artifacts).
			const shadowMatrixLight = slot.dtype === 'mat4' ? findShadowMatrixLightForSlot( group, slot, frame ) : null;
			if ( shadowMatrixLight && shadowMatrixLight.shadow && shadowMatrixLight.shadow.matrix ) {

				updateLightShadowMatrixForFrame( shadowMatrixLight, frame );
				writeMat4( view, offset, shadowMatrixLight.shadow.matrix );

			} else if ( slot._liveNode && slot._liveNode.value !== null && slot._liveNode.value !== undefined ) {

				writeLiveValue( view, offset, slot._liveNode.value, slot.dtype );

			} else {

				writeSnapshot( view, offset, source.valueSnapshot || { type: source.valueType, data: source.value } );

			}

		}

	}

}

function findShadowMatrixLightForSlot( group, slot, frame ) {

	if ( ! group || ! frame || ! frame.scene ) return null;
	const source = slot && slot.source || {};
	if ( source.kind !== 'uniform.live' || source.name ) return null;

	const slots = Array.isArray( group.slots ) ? group.slots : [];
	const shadowGroups = [];
	const seenLightIndices = new Set();
	for ( const sibling of slots ) {

		const siblingSource = sibling && sibling.source || {};
		if ( siblingSource.kind && siblingSource.kind.startsWith( 'light.shadow' ) && Number.isInteger( siblingSource.lightIndex ) && ! seenLightIndices.has( siblingSource.lightIndex ) ) {

			seenLightIndices.add( siblingSource.lightIndex );
			shadowGroups.push( {
				lightIndex: siblingSource.lightIndex,
				lightUuid: siblingSource.lightUuid || null,
				offset: sibling.offset ?? sibling.byteOffset ?? Number.POSITIVE_INFINITY,
			} );

		}

	}
	if ( shadowGroups.length === 0 ) return null;

	shadowGroups.sort( ( a, b ) => a.offset - b.offset );

	const liveShadowMatrices = slots
		.filter( ( sibling ) => {

			const siblingSource = sibling && sibling.source || {};
			return sibling && sibling.dtype === 'mat4' && siblingSource.kind === 'uniform.live' && ! siblingSource.name;

		} )
		.sort( ( a, b ) => ( a.offset ?? a.byteOffset ?? 0 ) - ( b.offset ?? b.byteOffset ?? 0 ) );
	const matrixIndex = liveShadowMatrices.indexOf( slot );
	if ( matrixIndex >= 0 && shadowGroups.length >= liveShadowMatrices.length ) {

		const light = findLightBySource( frame.scene, shadowGroups[ matrixIndex ] );
		recordLightLinkDiagnostic( {
			kind: 'light.shadowMatrix',
			slotOffset: slot.offset ?? slot.byteOffset ?? 0,
			source: shadowGroups[ matrixIndex ],
			light: lightDiagnosticShape( light ),
			matrix: light && light.shadow && light.shadow.matrix && light.shadow.matrix.elements ? light.shadow.matrix.elements.slice() : null,
		} );
		return light;

	}

	const slotOffset = slot.offset ?? slot.byteOffset ?? 0;
	const nextShadowGroup = shadowGroups.find( ( entry ) => entry.offset > slotOffset );
	if ( nextShadowGroup ) {

		const light = findLightBySource( frame.scene, nextShadowGroup );
		recordLightLinkDiagnostic( {
			kind: 'light.shadowMatrix',
			slotOffset,
			source: nextShadowGroup,
			light: lightDiagnosticShape( light ),
			matrix: light && light.shadow && light.shadow.matrix && light.shadow.matrix.elements ? light.shadow.matrix.elements.slice() : null,
		} );
		return light;

	}
	return null;

}

function updateLightShadowMatrixForFrame( light, frame ) {

	if ( ! light || ! light.shadow || typeof light.shadow.updateMatrices !== 'function' ) return;
	if ( light.shadow.map && light.shadow.matrix ) return;
	try {

		const shadowCamera = light.shadow.camera;
		const renderer = frame && frame.renderer;
		const frameCamera = frame && frame.camera;
		const coordinateSystem = renderer && renderer.coordinateSystem !== undefined ? renderer.coordinateSystem :
			frameCamera && frameCamera.coordinateSystem !== undefined ? frameCamera.coordinateSystem :
			WebGPUCoordinateSystem;
		if ( shadowCamera && coordinateSystem !== undefined && shadowCamera.coordinateSystem !== coordinateSystem ) {

			shadowCamera.coordinateSystem = coordinateSystem;
			if ( typeof shadowCamera.updateProjectionMatrix === 'function' ) shadowCamera.updateProjectionMatrix();

		}
		light.shadow.updateMatrices( light );

	} catch ( _ ) {}

}

function writeMaterialValue( view, offset, material, source, kind, dtype ) {

	const property = source.property || kind.split( '.' )[ 1 ];
	const materialValue = material && material[ property ];
	let value;
	if ( kind.endsWith( '.matrix' ) && materialValue ) {

		// Mirror three.js's TextureNode.update(): refresh texture.matrix from
		// the live repeat/offset/rotation/center each frame. Without this the
		// matrix stays at the constructor-set identity and any
		// `texture.repeat.set(...)` the user wired up has no GPU-visible effect.
		if ( materialValue.matrixAutoUpdate === true && typeof materialValue.updateMatrix === 'function' ) materialValue.updateMatrix();
		value = materialValue.matrix;

	} else {

		value = materialValue;

	}
	const snapshot = source.valueSnapshot;

	if ( dtype === 'color' || ( value && value.isColor ) ) writeColor( view, offset, value, snapshot );
	else if ( dtype === 'vec2' ) writeVec2( view, offset, value, snapshot );
	else if ( dtype === 'vec3' ) writeVec3( view, offset, value, snapshot );
	else if ( dtype === 'vec4' ) writeVec4( view, offset, value, snapshot );
	else if ( dtype === 'mat3' ) writeMat3( view, offset, value, snapshot );
	else if ( dtype === 'mat4' ) writeMat4( view, offset, value, snapshot );
	else writeNumber( view, offset, value, snapshot );

}

/**
 * Per-frame writer for direct-light uniforms. Looks up the live `Light`
 * object on `frame.scene` by the `lightIndex` baked into the source at
 * extract time, then writes the live value (intensity-scaled color, decay
 * exponent, view-space position, ...) into the UBO. Without this, captures
 * freeze at extraction-time light state and animated `light.intensity` /
 * `light.position` etc. never reach the GPU.
 *
 * Falls back to the captured snapshot (if any) when the indexed light
 * can't be resolved — e.g. JSON-loaded artifact replayed against a scene
 * that no longer has that light. Three.js itself would render with the
 * frozen value too in that case.
 */
function writeLightValue( view, offset, kind, source, frame ) {

	const light = frame && frame.scene ? findLightBySource( frame.scene, source ) : null;
	recordLightLinkDiagnostic( {
		kind,
		source: source ? {
			lightIndex: Number.isInteger( source.lightIndex ) ? source.lightIndex : null,
			lightUuid: source.lightUuid || null,
		} : null,
		light: lightDiagnosticShape( light ),
	} );

	if ( ! light ) {

		// Captured fallback — keeps PSNR within reach when the runtime
		// scene differs from capture (no light at the captured index).
		writeSnapshot( view, offset, source.valueSnapshot );
		return;

	}

	switch ( kind ) {

		case 'light.colorScaled': {

			// Mirror AnalyticLightNode.update(): copy color + scale by
			// intensity. Re-use a scratch field on `frame.scene` to avoid
			// allocating per call; small enough to inline directly via
			// component math instead of a Color helper.
			const c = light.color || null;
			const intensity = Number.isFinite( light.intensity ) ? light.intensity : 1;
			const r = c ? c.r * intensity : 0;
			const g = c ? c.g * intensity : 0;
			const b = c ? c.b * intensity : 0;
			view.setFloat32( offset, r, true );
			view.setFloat32( offset + 4, g, true );
			view.setFloat32( offset + 8, b, true );
			return;

		}
		case 'light.distance':
			writeNumber( view, offset, Number.isFinite( light.distance ) ? light.distance : 0 );
			return;
		case 'light.decay':
			writeNumber( view, offset, Number.isFinite( light.decay ) ? light.decay : 2 );
			return;
		case 'light.coneCos':
			writeNumber( view, offset, Math.cos( light.angle || 0 ) );
			return;
		case 'light.penumbraCos':
			writeNumber( view, offset, Math.cos( ( light.angle || 0 ) * ( 1 - ( light.penumbra || 0 ) ) ) );
			return;
		case 'light.position':
			if ( light.matrixWorld ) {

				_lvec.setFromMatrixPosition( light.matrixWorld );
				writeVec3( view, offset, _lvec );

			} else writeSnapshot( view, offset, source.valueSnapshot );
			return;
		case 'light.viewPosition':
			if ( light.matrixWorld && frame.camera && frame.camera.matrixWorldInverse ) {

				_lvec.setFromMatrixPosition( light.matrixWorld );
				_lvec.applyMatrix4( frame.camera.matrixWorldInverse );
				writeVec3( view, offset, _lvec );

			} else writeSnapshot( view, offset, source.valueSnapshot );
			return;
		case 'light.targetPosition':
			if ( light.target && light.target.matrixWorld ) {

				_lvec.setFromMatrixPosition( light.target.matrixWorld );
				writeVec3( view, offset, _lvec );

			} else writeSnapshot( view, offset, source.valueSnapshot );
			return;
		case 'light.shadowMatrix':
			if ( light.shadow && light.shadow.matrix ) {

				updateLightShadowMatrixForFrame( light, frame );
				writeMat4( view, offset, light.shadow.matrix );

			} else writeSnapshot( view, offset, source.valueSnapshot );
			return;
		case 'light.shadowBias':
			writeNumber( view, offset, light.shadow ? light.shadow.bias : null, source.valueSnapshot );
			return;
		case 'light.shadowNormalBias':
			writeNumber( view, offset, light.shadow ? light.shadow.normalBias : null, source.valueSnapshot );
			return;
		case 'light.shadowRadius':
			writeNumber( view, offset, light.shadow ? light.shadow.radius : null, source.valueSnapshot );
			return;
		case 'light.shadowCameraNear':
			writeNumber( view, offset, light.shadow && light.shadow.camera ? light.shadow.camera.near : null, source.valueSnapshot );
			return;
		case 'light.shadowCameraFar':
			writeNumber( view, offset, light.shadow && light.shadow.camera ? light.shadow.camera.far : null, source.valueSnapshot );
			return;
		case 'light.shadowMapSize':
			writeVec2( view, offset, light.shadow ? light.shadow.mapSize : null, source.valueSnapshot );
			return;
		case 'light.shadowIntensity':
			writeNumber( view, offset, light.shadow && light.shadow.__tslpDisableReplayShadow === true ? 0 : light.shadow && Number.isFinite( light.shadow.intensity ) ? light.shadow.intensity : null, source.valueSnapshot );
			return;
		case 'light.halfWidth':
			if ( light.matrixWorld && frame.camera && frame.camera.matrixWorldInverse ) {

				_mwi.copy( light.matrixWorld ).premultiply( frame.camera.matrixWorldInverse );
				_m4rot.extractRotation( _mwi );
				_lvec.set( light.width * 0.5, 0, 0 ).applyMatrix4( _m4rot );
				writeVec3( view, offset, _lvec );

			} else writeSnapshot( view, offset, source.valueSnapshot );
			return;
		case 'light.halfHeight':
			if ( light.matrixWorld && frame.camera && frame.camera.matrixWorldInverse ) {

				_mwi.copy( light.matrixWorld ).premultiply( frame.camera.matrixWorldInverse );
				_m4rot.extractRotation( _mwi );
				_lvec.set( 0, light.height * 0.5, 0 ).applyMatrix4( _m4rot );
				writeVec3( view, offset, _lvec );

			} else writeSnapshot( view, offset, source.valueSnapshot );
			return;
		default:
			// Unknown light.* kind — fall back to snapshot.
			writeSnapshot( view, offset, source.valueSnapshot );
			return;

	}

}

function writeSnapshot( view, offset, snapshot ) {

	if ( ! snapshot ) return;
	const { type, data } = snapshot;
	if ( type === 'number' || type === 'float' || type === 'f32' ) writeNumber( view, offset, data );
	else if ( type === 'int' || type === 'i32' ) writeInt( view, offset, data );
	else if ( type === 'uint' || type === 'u32' ) writeUint( view, offset, data );
	else if ( type === 'color' ) writeColor( view, offset, { r: data[ 0 ], g: data[ 1 ], b: data[ 2 ] } );
	else if ( type === 'vec2' ) writeVec2( view, offset, { x: data[ 0 ], y: data[ 1 ] } );
	else if ( type === 'vec3' ) writeVec3( view, offset, { x: data[ 0 ], y: data[ 1 ], z: data[ 2 ] } );
	else if ( type === 'vec4' ) writeVec4( view, offset, { x: data[ 0 ], y: data[ 1 ], z: data[ 2 ], w: data[ 3 ] } );
	else if ( type === 'mat3' ) writeMat3( view, offset, { elements: data } );
	else if ( type === 'mat4' ) writeMat4( view, offset, { elements: data } );

}

function writeNumber( view, offset, value, snapshot ) {

	const n = Number.isFinite( value ) ? value : snapshot && Number( snapshot.data ) || 0;
	view.setFloat32( offset, n, true );

}

function writeInt( view, offset, value, snapshot ) {

	const n = Number.isFinite( value ) ? value : snapshot && Number( snapshot.data ) || 0;
	view.setInt32( offset, n | 0, true );

}

function writeUint( view, offset, value, snapshot ) {

	const n = Number.isFinite( value ) ? value : snapshot && Number( snapshot.data ) || 0;
	view.setUint32( offset, n >>> 0, true );

}

function writeColor( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	view.setFloat32( offset, value && value.r || 0, true );
	view.setFloat32( offset + 4, value && value.g || 0, true );
	view.setFloat32( offset + 8, value && value.b || 0, true );

}

function writeVec2( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	view.setFloat32( offset, value && value.x || 0, true );
	view.setFloat32( offset + 4, value && value.y || 0, true );

}

function writeVec3( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	view.setFloat32( offset, value && value.x || 0, true );
	view.setFloat32( offset + 4, value && value.y || 0, true );
	view.setFloat32( offset + 8, value && value.z || 0, true );

}

function writeVec4( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	view.setFloat32( offset, value && value.x || 0, true );
	view.setFloat32( offset + 4, value && value.y || 0, true );
	view.setFloat32( offset + 8, value && value.z || 0, true );
	view.setFloat32( offset + 12, value && value.w || 0, true );

}

function writeMat3( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	const e = value && value.elements || [];
	view.setFloat32( offset + 0, e[ 0 ] || 0, true );
	view.setFloat32( offset + 4, e[ 1 ] || 0, true );
	view.setFloat32( offset + 8, e[ 2 ] || 0, true );
	view.setFloat32( offset + 16, e[ 3 ] || 0, true );
	view.setFloat32( offset + 20, e[ 4 ] || 0, true );
	view.setFloat32( offset + 24, e[ 5 ] || 0, true );
	view.setFloat32( offset + 32, e[ 6 ] || 0, true );
	view.setFloat32( offset + 36, e[ 7 ] || 0, true );
	view.setFloat32( offset + 40, e[ 8 ] || 0, true );

}

function writeMat4( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	const e = value && value.elements || [];
	for ( let i = 0; i < 16; i ++ ) view.setFloat32( offset + i * 4, e[ i ] || 0, true );

}

/**
 * Write a live UniformNode value to a DataView. Dispatches by the value's
 * runtime type. Called for `uniform.live` slots when `_liveNode` is present
 * (in-process flows where the original TSL node instances are alive).
 *
 * @param {DataView} view
 * @param {number} offset
 * @param {any} value - The `UniformNode.value` field.
 * @param {string} [dtype] - Hint from the plan slot ('number','vec2',…,'mat4').
 */
function writeLiveValue( view, offset, value, dtype ) {

	if ( typeof value === 'number' ) { view.setFloat32( offset, value, true ); return; }
	if ( value && value.isColor ) { writeColor( view, offset, value ); return; }
	if ( value && value.isMatrix4 ) { writeMat4( view, offset, value ); return; }
	if ( value && value.isMatrix3 ) { writeMat3( view, offset, value ); return; }
	if ( value && value.isVector4 ) { writeVec4( view, offset, value ); return; }
	if ( value && value.isVector3 ) { writeVec3( view, offset, value ); return; }
	if ( value && value.isVector2 ) { writeVec2( view, offset, value ); return; }
	// Fallback: try dtype hint
	if ( dtype === 'mat4' ) { writeMat4( view, offset, value ); return; }
	if ( dtype === 'mat3' ) { writeMat3( view, offset, value ); return; }
	if ( dtype === 'vec4' ) { writeVec4( view, offset, value ); return; }
	if ( dtype === 'vec3' ) { writeVec3( view, offset, value ); return; }
	if ( dtype === 'vec2' ) { writeVec2( view, offset, value ); return; }
	if ( dtype === 'color' ) { writeColor( view, offset, value ); return; }
	// Scalar fallback
	view.setFloat32( offset, Number( value ) || 0, true );

}


function createStaticObserver() {

	// Always-refresh observer. Returning anything other than `true` here
	// causes three.js's renderer to skip `updateForRender(renderObject)`
	// for that draw — and since multiple renderObjects can share the same
	// node-builder state (cached by cacheKey), the second+ object in a
	// frame would re-use the FIRST object's UBO contents. That's why a
	// scene with 200 sprites of the same material would render every
	// sprite at the first sprite's position.
	//
	// Stock NodeMaterialObserver gates this with a per-render-object
	// equality check; we don't have the bandwidth for that yet, so just
	// always refresh. The cost is one DataView write + one writeBuffer
	// per object per frame, which is what stock three.js does for
	// non-bundled scenes anyway.
	return { needsRefresh() { return true; } };

}
