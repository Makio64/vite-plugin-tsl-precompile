import { MATERIAL_TEXTURE_PROPS } from './texture-props.js';
import { ARTIFACT_TOOLCHAIN_VERSION } from './versions.js';

export const MAX_GRAPH_DEPTH = 128;

/** @type {Map<Function, string>} */
const USER_MATERIAL_IDENTITIES = new Map();

// Values in these lists change generated shader or render-pipeline topology.
// Continuous material inputs (color, opacity, roughness, transforms, etc.) are
// deliberately absent: changing a live uniform must not make an artifact stale.
const MATERIAL_BOOLEAN_STATE = Object.freeze( [
	'alphaHash',
	'alphaToCoverage',
	'allowOverride',
	'clipIntersection',
	'clipShadows',
	'colorWrite',
	'depthTest',
	'depthWrite',
	'dithering',
	'dashed',
	'flatShading',
	'fog',
	'forceSinglePass',
	'lights',
	'morphColors',
	'morphNormals',
	'morphTargets',
	'polygonOffset',
	'premultipliedAlpha',
	'sizeAttenuation',
	'skinning',
	'stencilWrite',
	'toneMapped',
	'transparent',
	'vertexColors',
	'wireframe',
	'worldUnits',
] );

const MATERIAL_ENUM_STATE = Object.freeze( [
	'blendDst',
	'blendDstAlpha',
	'blendEquation',
	'blendEquationAlpha',
	'blendSrc',
	'blendSrcAlpha',
	'blending',
	'combine',
	'depthPacking',
	'depthFunc',
	'glslVersion',
	'normalMapType',
	'precision',
	'shadowSide',
	'side',
	'stencilFail',
	'stencilFunc',
	'stencilZFail',
	'stencilZPass',
	'wireframeLinecap',
	'wireframeLinejoin',
] );

// Numeric pipeline state is captured into the artifact and is not supplied by
// a live uniform updater, so exact values must invalidate the capture.
const MATERIAL_STATIC_NUMERIC_STATE = Object.freeze( [
	'polygonOffsetFactor',
	'polygonOffsetUnits',
	'stencilFuncMask',
	'stencilRef',
	'stencilWriteMask',
] );

// Three.js rebuilds physical node-material programs when these values cross
// zero. Hash only that topology bucket, not the live scalar itself.
const MATERIAL_POSITIVE_FEATURES = Object.freeze( [
	'alphaTest',
	'anisotropy',
	'clearcoat',
	'dispersion',
	'iridescence',
	'sheen',
	'transmission',
] );

const PRIVATE_STRUCTURAL_NODE_KEYS = new Set( [ '_attributeName', '_builtinName', '_toneMapping' ] );
const EPHEMERAL_NODE_KEYS = new Set( [
	'cacheKey',
	'id',
	'stackTrace',
	'uuid',
	'version',
] );
const VOLATILE_NODE_KEY = /^(?:clock|deltaTime|elapsedTime|frameId|lastTime|now|renderId|time|timestamp)$/i;

/**
 * Register a stable identity for a material constructor. This prevents class
 * minification from changing the material tag between capture and build.
 *
 * @param {Function} MaterialCtor
 * @param {{ type: string }} descriptor
 * @return {string}
 */
export function registerMaterial( MaterialCtor, descriptor ) {

	if ( typeof MaterialCtor !== 'function' ) {

		throw new TypeError( 'registerMaterial: first arg must be the material constructor (class).' );

	}
	if ( ! descriptor || typeof descriptor !== 'object' ) {

		throw new TypeError( 'registerMaterial: second arg must be a descriptor with a `type` field.' );

	}
	const type = descriptor.type;
	if ( typeof type !== 'string' || type.length === 0 ) {

		throw new TypeError( 'registerMaterial: descriptor.type must be a non-empty string.' );

	}
	const existing = USER_MATERIAL_IDENTITIES.get( MaterialCtor );
	if ( existing !== undefined ) {

		if ( existing === type ) return existing;
		throw new Error( `registerMaterial: class is already registered with identity ${ JSON.stringify( existing ) }; cannot change to ${ JSON.stringify( type ) }.` );

	}
	USER_MATERIAL_IDENTITIES.set( MaterialCtor, type );
	return type;

}

/** @param {Function} MaterialCtor */
export function unregisterMaterial( MaterialCtor ) {

	return USER_MATERIAL_IDENTITIES.delete( MaterialCtor );

}

/** @param {?Object} material */
export function materialIdentity( material ) {

	if ( ! material ) return 'UnknownMaterial';
	const ctor = safeRead( material, 'constructor' );
	if ( ! ctor ) return 'UnknownMaterial';
	const registered = USER_MATERIAL_IDENTITIES.get( ctor );
	if ( registered !== undefined ) return registered;
	return stringTag( safeRead( ctor, 'type' ) ) || stringTag( safeRead( ctor, 'name' ) ) || 'UnknownMaterial';

}

/**
 * Deterministic representation of material source topology. It includes node
 * structure, map presence/type, defines, and branch-forming material flags,
 * while excluding UUIDs, clocks, cache ids, and live uniform values.
 *
 * @param {Object} material
 * @return {string}
 */
export function normalizeMaterialGraph( material ) {

	if ( ! material ) return '(null-material)';

	const parts = [ `material<${ materialIdentity( material ) }>` ];
	parts.push( `state=${ normalizeMaterialTopology( material ) }` );

	for ( const { key, node } of collectNodeSlots( material ) ) {

		parts.push( `${ key }=${ normalizeNode( node, new Set(), 0 ) }` );

	}

	return parts.join( '\n' );

}

/**
 * Canonical material hash payload shared by Node/plugin and browser/runtime
 * SHA-256 wrappers. Keeping the byte layout here makes parity structural, not
 * a convention duplicated across packages.
 *
 * `pluginVersion` is retained as a compatibility spelling for existing callers;
 * new code may use `toolchainVersion`.
 *
 * @param {Object} material
 * @param {{ name: string, threeVersion: string, pluginVersion?: string, toolchainVersion?: string }} opts
 * @return {string}
 */
export function createMaterialSourceHashPayload( material, opts = {} ) {

	const { name, threeVersion } = opts;
	if ( typeof name !== 'string' || name.length === 0 ) {

		throw new TypeError( `createMaterialSourceHashPayload: "name" must be a non-empty string; got ${ typeof name }` );

	}
	if ( typeof threeVersion !== 'string' || threeVersion.length === 0 ) {

		throw new Error( 'createMaterialSourceHashPayload: "threeVersion" is required' );

	}
	const toolchainVersion = resolveToolchainVersion( opts );

	return [
		`tslp-material-source@${ ARTIFACT_TOOLCHAIN_VERSION }`,
		`name=${ JSON.stringify( name ) }`,
		`three=${ JSON.stringify( threeVersion ) }`,
		`toolchain=${ JSON.stringify( toolchainVersion ) }`,
		normalizeMaterialGraph( material ),
	].join( '\n' );

}

/**
 * Canonicalize an optional render-context signature. A pre-hashed string is
 * left intact; JSON-safe objects are sorted recursively so key insertion order
 * cannot perturb the separate render-context fingerprint.
 *
 * @param {string|Object|null|undefined} signature
 * @return {string}
 */
export function normalizeRenderContextSignature( signature ) {

	if ( signature === undefined || signature === null || signature === '' ) return '';
	if ( typeof signature === 'string' ) return signature;
	return stableJsonValue( signature, new Set(), 'renderContextSignature' );

}

function resolveToolchainVersion( opts ) {

	const pluginVersion = opts.pluginVersion;
	const toolchainVersion = opts.toolchainVersion;
	if ( pluginVersion !== undefined && toolchainVersion !== undefined && pluginVersion !== toolchainVersion ) {

		throw new Error( `createMaterialSourceHashPayload: pluginVersion ${ JSON.stringify( pluginVersion ) } and toolchainVersion ${ JSON.stringify( toolchainVersion ) } disagree` );

	}
	const version = toolchainVersion ?? pluginVersion ?? ARTIFACT_TOOLCHAIN_VERSION;
	if ( typeof version !== 'string' || version.length === 0 ) {

		throw new Error( 'createMaterialSourceHashPayload: "toolchainVersion" is required' );

	}
	return version;

}

function collectNodeSlots( material ) {

	const slots = [];
	for ( const key of Object.getOwnPropertyNames( material ).sort() ) {

		const value = safeRead( material, key );
		if ( key.endsWith( 'Node' ) || isNodeLike( value ) ) slots.push( { key, node: value } );

	}
	return slots;

}

function normalizeMaterialTopology( material ) {

	const state = [];
	for ( const key of MATERIAL_BOOLEAN_STATE ) {

		const value = safeRead( material, key );
		if ( typeof value === 'boolean' ) state.push( `${ key }=${ value ? '1' : '0' }` );

	}
	for ( const key of MATERIAL_ENUM_STATE ) {

		const value = safeRead( material, key );
		if ( value === null || typeof value === 'number' || typeof value === 'string' ) state.push( `${ key }=${ primitiveToken( value ) }` );

	}
	for ( const key of MATERIAL_POSITIVE_FEATURES ) {

		const value = safeRead( material, key );
		if ( typeof value === 'number' ) state.push( `${ key }=${ value > 0 ? 'enabled' : 'disabled' }` );

	}
	for ( const key of MATERIAL_STATIC_NUMERIC_STATE ) {

		const value = safeRead( material, key );
		if ( typeof value === 'number' && Number.isFinite( value ) ) state.push( `${ key }=${ numberToken( value ) }` );

	}

	const defines = safeRead( material, 'defines' );
	if ( defines && typeof defines === 'object' ) state.push( `defines=${ stableConfigValue( defines, new Set(), 0 ) }` );
	const extensions = safeRead( material, 'extensions' );
	if ( extensions && typeof extensions === 'object' ) state.push( `extensions=${ stableConfigValue( extensions, new Set(), 0 ) }` );

	for ( const prop of MATERIAL_TEXTURE_PROPS ) {

		const texture = safeRead( material, prop );
		state.push( `${ prop }=${ texture ? normalizeTextureTopology( texture ) : 'none' }` );

	}

	return `{${ state.join( ',' ) }}`;

}

/**
 * Walk a node tree and emit a stable canonical string.
 *
 * @param {*} node
 * @param {Set<Object>} seen
 * @param {number} depth
 * @return {string}
 */
export function normalizeNode( node, seen = new Set(), depth = 0 ) {

	if ( node === null || node === undefined ) return 'null';
	if ( typeof node === 'function' ) return functionShape( node );
	if ( typeof node !== 'object' ) return primitiveToken( node );
	if ( depth > MAX_GRAPH_DEPTH ) return '<depth-cut>';
	if ( seen.has( node ) ) return '<cycle>';
	seen.add( node );

	const tag = nodeTag( node );
	if ( safeRead( node, 'isConstNode' ) === true && hasProperty( node, 'value' ) ) {

		return `${ tag }(const:${ normalizeConstValue( safeRead( node, 'value' ), new Set(), 0 ) };type=${ valueType( safeRead( node, 'value' ), safeRead( node, 'nodeType' ) ) })`;

	}

	const fields = [];
	if ( safeRead( node, 'isTextureNode' ) === true ) {

		fields.push( `texture=${ normalizeTextureTopology( safeRead( node, 'value' ) ) }` );

	} else if ( safeRead( node, 'isUniformNode' ) === true && hasProperty( node, 'value' ) ) {

		// A uniform's current value is runtime data. Only its shader type and
		// binding-group structure belong in the source fingerprint.
		fields.push( `uniformType=${ valueType( safeRead( node, 'value' ), safeRead( node, 'nodeType' ) ) }` );

	}

	for ( const key of Object.getOwnPropertyNames( node ).sort() ) {

		if ( shouldSkipNodeKey( key, node ) ) continue;
		const value = safeRead( node, key );
		if ( value === undefined ) continue;
		const normalized = normalizeStructuralField( value, seen, depth + 1, key );
		if ( normalized !== null ) fields.push( `${ key }=${ normalized }` );

	}

	return `${ tag }{${ fields.join( ',' ) }}`;

}

function shouldSkipNodeKey( key, node ) {

	if ( key === 'constructor' || EPHEMERAL_NODE_KEYS.has( key ) || VOLATILE_NODE_KEY.test( key ) ) return true;
	if ( key.startsWith( '_' ) && ! PRIVATE_STRUCTURAL_NODE_KEYS.has( key ) ) return true;
	if ( key === 'value' && ( safeRead( node, 'isUniformNode' ) === true || safeRead( node, 'isTextureNode' ) === true ) ) return true;
	return false;

}

function normalizeStructuralField( value, seen, depth, key ) {

	if ( value === null ) return 'null';
	if ( typeof value === 'function' ) return functionShape( value );
	if ( typeof value !== 'object' ) return primitiveToken( value );
	if ( depth > MAX_GRAPH_DEPTH ) return '<depth-cut>';
	if ( isNodeLike( value ) ) return normalizeNode( value, seen, depth );
	if ( isTextureLike( value ) ) return normalizeTextureTopology( value );
	if ( ArrayBuffer.isView( value ) ) return `typed<${ constructorTag( value ) }:${ value.length ?? value.byteLength }>`;
	if ( value instanceof ArrayBuffer ) return `buffer<${ value.byteLength }>`;
	if ( Array.isArray( value ) ) {

		return `[${ value.map( ( item, index ) => normalizeStructuralField( item, seen, depth + 1, `${ key }[${ index }]` ) ?? '<ignored>' ).join( ',' ) }]`;

	}
	if ( isPlainObject( value ) ) return stableStructuralObject( value, seen, depth );
	return `<${ constructorTag( value ) }>`;

}

function stableStructuralObject( object, seen, depth ) {

	if ( seen.has( object ) ) return '<cycle>';
	seen.add( object );
	const fields = [];
	for ( const key of Object.keys( object ).sort() ) {

		if ( EPHEMERAL_NODE_KEYS.has( key ) || VOLATILE_NODE_KEY.test( key ) || key.startsWith( '_' ) ) continue;
		const normalized = normalizeStructuralField( safeRead( object, key ), seen, depth + 1, key );
		if ( normalized !== null ) fields.push( `${ JSON.stringify( key ) }:${ normalized }` );

	}
	return `{${ fields.join( ',' ) }}`;

}

function normalizeTextureTopology( texture ) {

	if ( ! texture || typeof texture !== 'object' ) return 'none';
	const fields = [ `kind=${ textureKind( texture ) }` ];
	for ( const key of [ 'channel', 'colorSpace', 'compareFunction', 'format', 'internalFormat', 'mapping', 'type' ] ) {

		const value = safeRead( texture, key );
		if ( value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' ) {

			fields.push( `${ key }=${ primitiveToken( value ) }` );

		}

	}
	return `texture<${ fields.join( ',' ) }>`;

}

function textureKind( texture ) {

	for ( const [ flag, kind ] of [
		[ 'isCubeTexture', 'cube' ],
		[ 'isDataArrayTexture', '2d-array' ],
		[ 'isData3DTexture', '3d' ],
		[ 'isDepthTexture', 'depth' ],
		[ 'isVideoTexture', 'video' ],
		[ 'isCompressedArrayTexture', 'compressed-array' ],
		[ 'isCompressedCubeTexture', 'compressed-cube' ],
		[ 'isCompressedTexture', 'compressed-2d' ],
		[ 'isFramebufferTexture', 'framebuffer' ],
		[ 'isStorageTexture', 'storage' ],
		[ 'isRenderTargetTexture', 'render-target' ],
	] ) {

		if ( safeRead( texture, flag ) === true ) return kind;

	}
	return safeRead( texture, 'isTexture' ) === true ? '2d' : constructorTag( texture );

}

function valueType( value, explicitType ) {

	if ( typeof explicitType === 'string' && explicitType.length > 0 ) return explicitType;
	if ( value === null || value === undefined ) return 'null';
	if ( typeof value === 'number' ) return 'number';
	if ( typeof value === 'boolean' ) return 'bool';
	if ( typeof value === 'string' ) return 'string';
	for ( const [ flag, type ] of [
		[ 'isColor', 'color' ],
		[ 'isVector2', 'vec2' ],
		[ 'isVector3', 'vec3' ],
		[ 'isVector4', 'vec4' ],
		[ 'isMatrix2', 'mat2' ],
		[ 'isMatrix3', 'mat3' ],
		[ 'isMatrix4', 'mat4' ],
		[ 'isQuaternion', 'quat' ],
		[ 'isTexture', 'texture' ],
	] ) {

		if ( safeRead( value, flag ) === true ) return type;

	}
	if ( ArrayBuffer.isView( value ) ) return `typed:${ constructorTag( value ) }`;
	if ( Array.isArray( value ) ) return `array:${ value.length }`;
	return constructorTag( value );

}

function normalizeConstValue( value, seen, depth ) {

	if ( value === null || value === undefined || typeof value !== 'object' ) return primitiveToken( value );
	if ( depth > MAX_GRAPH_DEPTH ) return '<depth-cut>';
	if ( seen.has( value ) ) return '<cycle>';
	seen.add( value );

	if ( safeRead( value, 'isColor' ) === true ) return `color(${ numberToken( value.r ) },${ numberToken( value.g ) },${ numberToken( value.b ) })`;
	for ( const [ flag, keys, prefix ] of [
		[ 'isVector2', [ 'x', 'y' ], 'v2' ],
		[ 'isVector3', [ 'x', 'y', 'z' ], 'v3' ],
		[ 'isVector4', [ 'x', 'y', 'z', 'w' ], 'v4' ],
		[ 'isQuaternion', [ 'x', 'y', 'z', 'w' ], 'quat' ],
	] ) {

		if ( safeRead( value, flag ) === true ) return `${ prefix }(${ keys.map( ( key ) => numberToken( safeRead( value, key ) ) ).join( ',' ) })`;

	}
	if ( safeRead( value, 'isMatrix2' ) === true || safeRead( value, 'isMatrix3' ) === true || safeRead( value, 'isMatrix4' ) === true ) {

		return `matrix(${ Array.from( safeRead( value, 'elements' ) || [], numberToken ).join( ',' ) })`;

	}
	if ( ArrayBuffer.isView( value ) ) return `${ constructorTag( value ) }[${ Array.from( value, ( item ) => normalizeConstValue( item, seen, depth + 1 ) ).join( ',' ) }]`;
	if ( Array.isArray( value ) ) return `[${ value.map( ( item ) => normalizeConstValue( item, seen, depth + 1 ) ).join( ',' ) }]`;
	if ( isPlainObject( value ) ) {

		return `{${ Object.keys( value ).sort().map( ( key ) => `${ JSON.stringify( key ) }:${ normalizeConstValue( value[ key ], seen, depth + 1 ) }` ).join( ',' ) }}`;

	}
	return `<${ constructorTag( value ) }>`;

}

function stableConfigValue( value, seen, depth ) {

	if ( value === null || value === undefined || typeof value !== 'object' ) return primitiveToken( value );
	if ( depth > MAX_GRAPH_DEPTH ) return '<depth-cut>';
	if ( seen.has( value ) ) return '<cycle>';
	seen.add( value );
	if ( Array.isArray( value ) ) return `[${ value.map( ( item ) => stableConfigValue( item, seen, depth + 1 ) ).join( ',' ) }]`;
	if ( isPlainObject( value ) ) return `{${ Object.keys( value ).sort().map( ( key ) => `${ JSON.stringify( key ) }:${ stableConfigValue( value[ key ], seen, depth + 1 ) }` ).join( ',' ) }}`;
	return `<${ constructorTag( value ) }>`;

}

function stableJsonValue( value, seen, label ) {

	if ( value === null ) return 'null';
	if ( typeof value === 'string' || typeof value === 'boolean' ) return JSON.stringify( value );
	if ( typeof value === 'number' ) {

		if ( ! Number.isFinite( value ) ) throw new TypeError( `${ label } must contain only finite JSON numbers` );
		return numberToken( value );

	}
	if ( typeof value !== 'object' ) throw new TypeError( `${ label } must be a string or JSON-safe object` );
	if ( seen.has( value ) ) throw new TypeError( `${ label } must not contain cycles` );
	seen.add( value );
	let result;
	if ( Array.isArray( value ) ) {

		result = `[${ value.map( ( item ) => stableJsonValue( item, seen, label ) ).join( ',' ) }]`;

	} else if ( isPlainObject( value ) ) {

		result = `{${ Object.keys( value ).sort().map( ( key ) => `${ JSON.stringify( key ) }:${ stableJsonValue( value[ key ], seen, label ) }` ).join( ',' ) }}`;

	} else {

		throw new TypeError( `${ label } must contain only JSON-safe arrays and plain objects` );

	}
	seen.delete( value );
	return result;

}

function primitiveToken( value ) {

	if ( typeof value === 'number' ) return numberToken( value );
	if ( typeof value === 'bigint' ) return `${ value }n`;
	if ( typeof value === 'symbol' ) return `symbol:${ String( value.description || '' ) }`;
	if ( value === undefined ) return 'undefined';
	return JSON.stringify( value );

}

function numberToken( value ) {

	if ( Number.isNaN( value ) ) return 'NaN';
	if ( value === Infinity ) return 'Infinity';
	if ( value === - Infinity ) return '-Infinity';
	if ( Object.is( value, - 0 ) ) return '-0';
	return String( value );

}

function functionShape( fn ) {

	return `function$arity=${ Number.isInteger( fn.length ) ? fn.length : '?' }`;

}

function nodeTag( node ) {

	const ctor = safeRead( node, 'constructor' );
	return stringTag( safeRead( ctor, 'type' ) ) || stringTag( safeRead( node, 'type' ) ) || stringTag( safeRead( ctor, 'name' ) ) || 'Node';

}

function constructorTag( value ) {

	const ctor = safeRead( value, 'constructor' );
	return stringTag( safeRead( ctor, 'type' ) ) || stringTag( safeRead( ctor, 'name' ) ) || typeof value;

}

function stringTag( value ) {

	return typeof value === 'string' && value.length > 0 ? value : '';

}

function isNodeLike( value ) {

	return !! value && ( typeof value === 'object' || typeof value === 'function' ) && safeRead( value, 'isNode' ) === true;

}

function isTextureLike( value ) {

	return !! value && typeof value === 'object' && safeRead( value, 'isTexture' ) === true;

}

function isPlainObject( value ) {

	if ( ! value || typeof value !== 'object' ) return false;
	const proto = Object.getPrototypeOf( value );
	return proto === Object.prototype || proto === null;

}

function safeRead( object, key ) {

	try {

		return object && object[ key ];

	} catch ( _ ) {

		return undefined;

	}

}

function hasProperty( object, key ) {

	try {

		return key in object;

	} catch ( _ ) {

		return false;

	}

}
